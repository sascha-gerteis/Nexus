const EDITOR_COOKIE = "nexus_n8n_editor_token";
const SESSION_CACHE_TTL_MS = 30_000;
const sessionCache = new Map();

export default {
  async fetch(request, env, ctx) {
    try {
      if (request.method === "OPTIONS") return optionsResponse(request, env);
      return await handleRequest(request, env, ctx);
    } catch (error) {
      return jsonResponse({
        ok: false,
        error: error instanceof Error ? error.message : "Editor proxy failed.",
      }, 500, request, env);
    }
  },
};

async function handleRequest(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname === "/healthz") return jsonResponse({ status: "ok" }, 200, request, env);

  const route = parseEditorRoute(url);
  const token = route.token ||
    cleanString(url.searchParams.get("editor_token")) ||
    readCookie(request.headers.get("Cookie") || "", EDITOR_COOKIE);

  if (!token) {
    return jsonResponse({ ok: false, error: "Missing editor token." }, 403, request, env);
  }

  const session = await loadSession(token, env);
  const targetPath = normalizeTargetPath(route.targetPath || url.pathname, session.n8n_workflow_id);
  const targetSearch = route.targetPath ? url.search : cleanProxySearch(url.searchParams);

  const stub = startupStubResponse(request, targetPath, env);
  if (stub) return withEditorCookie(stub, token, route.token);

  if (isCredentialWritePath(targetPath, request.method)) {
    return jsonResponse({
      ok: false,
      error: "Credentials are managed in Nexus. Add or update API keys in the product credential panel, apply them to this workflow, then run the Nexus check.",
      blocked_by_nexus: true,
      path: targetPath,
    }, 403, request, env);
  }

  if (!allowedProxyPath(targetPath, request.method, session.n8n_workflow_id)) {
    if (wantsHtml(request)) {
      return redirectResponse(`/workflow/${encodeURIComponent(session.n8n_workflow_id)}`, token, request, env);
    }

    return jsonResponse({
      ok: false,
      error: "This n8n route is blocked by Nexus workflow lock.",
      blocked_by_nexus: true,
      path: targetPath,
    }, 403, request, env);
  }

  ctx.waitUntil(touchSession(session.id, env));

  const upstreamPath = targetPath.replace(/\/+$/, "") === "/rest/node-types"
    ? "/types/nodes.json"
    : targetPath;
  const upstreamSearch = upstreamPath === "/types/nodes.json" ? "" : targetSearch;
  const upstreamUrl = `${cleanBaseUrl(requiredEnv(env, "N8N_BASE_URL"))}${upstreamPath}${upstreamSearch}`;

  const runValidation = await validateLockedWorkflowRun(request, targetPath, session.n8n_workflow_id);
  if (!runValidation.ok) {
    return jsonResponse({
      ok: false,
      error: runValidation.error || "This workflow run was blocked by Nexus workflow lock.",
      blocked_by_nexus: true,
      path: targetPath,
    }, 403, request, env);
  }

  if (isWebSocketRequest(request)) {
    return fetch(upstreamUrl, buildWebSocketUpstreamRequest(request, session.n8n_cookie, env));
  }

  const upstream = await fetch(upstreamUrl, buildUpstreamRequest(request, session.n8n_cookie, runValidation.bodyText));

  if (
    upstream.ok &&
    !isWorkflowRunPath(targetPath, request.method) &&
    allowedWorkflowRestPath(targetPath, session.n8n_workflow_id) &&
    ["POST", "PATCH", "PUT"].includes(String(request.method || "").toUpperCase())
  ) {
    ctx.waitUntil(markWorkflowEdited(session, targetPath, env));
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    const location = upstream.headers.get("Location") || `/workflow/${encodeURIComponent(session.n8n_workflow_id)}`;
    const nextUrl = new URL(location, requiredEnv(env, "N8N_BASE_URL"));
    const nextPath = forbiddenPath(nextUrl.pathname)
      ? `/workflow/${encodeURIComponent(session.n8n_workflow_id)}`
      : `${nextUrl.pathname}${nextUrl.search}`;
    return redirectResponse(nextPath, token, request, env);
  }

  if (upstream.status >= 400 && apiLikePath(targetPath)) {
    const text = await upstream.text().catch(() => "");
    return jsonResponse({
      ok: false,
      error: text ? text.slice(0, 500) : `n8n returned ${upstream.status}`,
      upstream_status: upstream.status,
      path: targetPath,
    }, upstream.status, request, env);
  }

  const contentType = contentTypeForPath(upstreamPath) || upstream.headers.get("Content-Type") || "application/octet-stream";

  if (
    upstream.ok &&
    contentType.includes("application/json") &&
    (isWorkflowRunPath(targetPath, request.method) || shouldFilterExecutionJson(targetPath))
  ) {
    const text = await upstream.text();
    ctx.waitUntil(markEditorExecutionResult(
      session,
      targetPath,
      request.method,
      text,
      env,
      Boolean(runValidation.partialRun),
    ));
    const rewritten = shouldFilterExecutionJson(targetPath)
      ? filterExecutionJsonText(text, session.n8n_workflow_id)
      : text;
    const response = new Response(rewritten, {
      status: upstream.status,
      headers: responseHeaders(upstream, request, env, "application/json; charset=utf-8"),
    });
    return withEditorCookie(response, token, route.token);
  }

  if (upstream.ok && contentType.includes("application/json") && shouldRewriteN8nJson(targetPath)) {
    const text = await upstream.text();
    const rewritten = rewriteN8nJsonText(text, request, env);
    const response = new Response(rewritten, {
      status: upstream.status,
      headers: responseHeaders(upstream, request, env, "application/json; charset=utf-8"),
    });
    return withEditorCookie(response, token, route.token);
  }

  if (isHtmlRequest(request, upstream, targetPath)) {
    const html = await upstream.text();
    const response = new Response(
      injectEditorLock(html, session.n8n_workflow_id, token, env),
      {
        status: upstream.status,
        headers: responseHeaders(upstream, request, env, "text/html; charset=utf-8"),
      },
    );
    return withEditorCookie(response, token, true);
  }

  const response = new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders(upstream, request, env, contentType),
  });
  return withEditorCookie(response, token, route.token || tokenFromQuery(request));
}

function parseEditorRoute(url) {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "editor" || !parts[1]) {
    return { token: "", targetPath: "" };
  }

  const token = decodeURIComponent(parts[1]);
  const target = `/${parts.slice(2).join("/")}`;
  return {
    token,
    targetPath: target === "/" ? "" : target,
  };
}

function normalizeTargetPath(path, workflowId) {
  const safe = `/${String(path || "").replace(/^\/+/, "")}`;
  if (safe === "/" || safe === "/editor") return `/workflow/${encodeURIComponent(workflowId)}`;
  return safe;
}

function cleanProxySearch(searchParams) {
  const next = new URLSearchParams(searchParams);
  next.delete("editor_token");
  next.delete("editor_v");
  next.delete("client_v");
  const value = next.toString();
  return value ? `?${value}` : "";
}

function buildUpstreamRequest(request, cookie, bodyOverride) {
  const headers = new Headers();
  headers.set("Accept", request.headers.get("Accept") || "*/*");
  headers.set("Cookie", cookie);
  headers.set("User-Agent", request.headers.get("User-Agent") || "Nexus n8n editor proxy");
  headers.set("X-Requested-With", request.headers.get("X-Requested-With") || "XMLHttpRequest");

  const contentType = request.headers.get("Content-Type");
  if (contentType || !["GET", "HEAD"].includes(request.method)) {
    headers.set("Content-Type", contentType || "application/json");
  }

  return {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method)
      ? undefined
      : bodyOverride !== undefined
        ? bodyOverride
        : request.body,
    redirect: "manual",
  };
}

function buildWebSocketUpstreamRequest(request, cookie, env) {
  const headers = new Headers(request.headers);
  headers.set("Cookie", cookie);
  const upstreamOrigin = safeOrigin(env.N8N_BASE_URL);
  if (upstreamOrigin) headers.set("Origin", upstreamOrigin);
  headers.delete("Host");
  return {
    method: request.method,
    headers,
    redirect: "manual",
  };
}

async function loadSession(token, env) {
  const cacheKey = await sha256Hex(token);
  const cached = sessionCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.session;

  const supabaseUrl = cleanBaseUrl(requiredEnv(env, "SUPABASE_URL"));
  const serviceRoleKey = requiredEnv(env, "SUPABASE_SERVICE_ROLE_KEY");
  const url = new URL(`${supabaseUrl}/rest/v1/n8n_editor_sessions`);
  url.searchParams.set("select", "id,automation_id,n8n_workflow_id,profile_id,developer_id,role,encrypted_n8n_cookie,expires_at,revoked_at,status");
  url.searchParams.set("token_hash", `eq.${cacheKey}`);
  url.searchParams.set("limit", "1");

  const response = await fetch(url.toString(), {
    headers: supabaseHeaders(serviceRoleKey),
  });

  if (!response.ok) {
    throw new Error(`Could not validate editor session (${response.status}).`);
  }

  const rows = await response.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row) throw new Error("Editor session not found.");

  if (row.revoked_at || row.status !== "active" || new Date(row.expires_at).getTime() <= Date.now()) {
    throw new Error("Editor session expired. Reopen the workflow editor from Nexus.");
  }

  const n8nCookie = await decryptText(row.encrypted_n8n_cookie, env);
  if (!n8nCookie) throw new Error("Editor session is missing n8n auth.");

  const session = {
    ...row,
    n8n_cookie: n8nCookie,
  };

  sessionCache.set(cacheKey, {
    expires: Date.now() + SESSION_CACHE_TTL_MS,
    session,
  });

  return session;
}

async function touchSession(sessionId, env) {
  const supabaseUrl = cleanBaseUrl(requiredEnv(env, "SUPABASE_URL"));
  const serviceRoleKey = requiredEnv(env, "SUPABASE_SERVICE_ROLE_KEY");
  await fetch(`${supabaseUrl}/rest/v1/n8n_editor_sessions?id=eq.${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    headers: supabaseHeaders(serviceRoleKey, true),
    body: JSON.stringify({
      last_seen_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  }).catch(() => {});
}

async function markWorkflowEdited(session, path, env) {
  const supabaseUrl = cleanBaseUrl(requiredEnv(env, "SUPABASE_URL"));
  const serviceRoleKey = requiredEnv(env, "SUPABASE_SERVICE_ROLE_KEY");
  await fetch(`${supabaseUrl}/rest/v1/automations?id=eq.${encodeURIComponent(session.automation_id)}`, {
    method: "PATCH",
    headers: supabaseHeaders(serviceRoleKey, true),
    body: JSON.stringify({
      n8n_last_test_status: "not_tested",
      n8n_last_test_error: null,
      n8n_last_test_result: null,
      n8n_last_tested_at: null,
      n8n_last_synced_at: new Date().toISOString(),
      n8n_last_import_result: {
        edited_in_embedded_editor: true,
        edited_at: new Date().toISOString(),
        workflow_id: session.n8n_workflow_id,
        proxy_save_path: path,
      },
    }),
  }).catch(() => {});
}

async function markEditorExecutionResult(session, path, method, responseText, env, partialRun = false) {
  const parsed = parseJsonSafe(responseText);
  const runPath = isWorkflowRunPath(path, method);
  const execution = pickExecutionPayload(parsed, session.n8n_workflow_id, runPath);
  if (!execution) return;

  const result = executionResultFromPayload(execution, runPath);
  if (!result) return;

  if (partialRun && result.status !== "running") {
    result.status = "not_tested";
    result.error_message = "Only a single node or partial n8n execution ran. Run the full workflow from the canvas, or use the Nexus Run check button, before submitting this product.";
  }

  const now = new Date().toISOString();
  const patch = {
    n8n_last_test_status: result.status,
    n8n_last_test_error: result.status === "failed" || result.status === "not_tested" ? result.error_message || "Embedded n8n run failed." : null,
    n8n_last_test_result: {
      source: "embedded_editor",
      partial_run: Boolean(partialRun),
      workflow_id: session.n8n_workflow_id,
      execution_id: result.execution_id || null,
      n8n_status: result.n8n_status || null,
      finished: Boolean(result.finished),
      mode: result.mode || null,
      error_node: result.error_node || null,
      error_message: result.error_message || null,
      proxy_path: path,
      synced_from_editor_at: now,
    },
    updated_at: now,
  };

  if (result.status !== "running" && result.status !== "not_tested") {
    patch.n8n_last_tested_at = now;
  }

  const supabaseUrl = cleanBaseUrl(requiredEnv(env, "SUPABASE_URL"));
  const serviceRoleKey = requiredEnv(env, "SUPABASE_SERVICE_ROLE_KEY");
  await fetch(`${supabaseUrl}/rest/v1/automations?id=eq.${encodeURIComponent(session.automation_id)}`, {
    method: "PATCH",
    headers: supabaseHeaders(serviceRoleKey, true),
    body: JSON.stringify(patch),
  }).catch(() => {});
}

function parseJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch (_error) {
    return null;
  }
}

function pickExecutionPayload(value, workflowId, allowFallback = false) {
  if (!value) return null;

  const candidates = [];
  if (Array.isArray(value)) candidates.push(...value);
  if (Array.isArray(value?.data)) candidates.push(...value.data);
  if (value?.data && typeof value.data === "object" && !Array.isArray(value.data)) candidates.push(value.data);
  if (value?.execution) candidates.push(value.execution);
  candidates.push(value);

  const withWorkflowId = candidates.filter((item) => cleanString(executionWorkflowId(item)));
  if (withWorkflowId.length) {
    return withWorkflowId.find((item) => executionWorkflowId(item) === String(workflowId)) || null;
  }

  return allowFallback ? candidates[0] || null : null;
}

function executionResultFromPayload(execution, runPath = false) {
  if (!execution || typeof execution !== "object") return null;

  const executionId = cleanString(
    execution.executionId ||
    execution.execution_id ||
    execution.id ||
    execution.data?.executionId ||
    execution.data?.id,
  );
  const n8nStatus = lower(
    execution.status ||
    execution.data?.status ||
    execution.finishedStatus ||
    execution.data?.finishedStatus,
  );
  const finished = Boolean(
    execution.finished === true ||
    execution.data?.finished === true ||
    execution.stoppedAt ||
    execution.data?.stoppedAt ||
    ["success", "succeeded", "error", "failed", "crashed", "canceled", "cancelled"].includes(n8nStatus),
  );
  const errorMessage = pickExecutionErrorMessage(execution);
  const errorNode = cleanString(
    execution.data?.resultData?.error?.node?.name ||
    execution.data?.resultData?.lastNodeExecuted ||
    execution.resultData?.error?.node?.name ||
    execution.resultData?.lastNodeExecuted,
  );

  if (runPath && !finished) {
    return {
      status: "running",
      execution_id: executionId,
      n8n_status: n8nStatus || "running",
      finished: false,
      mode: execution.mode || execution.data?.mode || null,
    };
  }

  if (!finished && !errorMessage) return null;

  return {
    status: errorMessage || ["error", "failed", "crashed", "canceled", "cancelled"].includes(n8nStatus)
      ? "failed"
      : "passed",
    execution_id: executionId,
    n8n_status: n8nStatus || (errorMessage ? "error" : "success"),
    finished: true,
    mode: execution.mode || execution.data?.mode || null,
    error_node: errorNode,
    error_message: errorMessage,
  };
}

function pickExecutionErrorMessage(execution) {
  const error = execution?.data?.resultData?.error || execution?.resultData?.error || execution?.error;
  return cleanString(
    error?.message ||
    error?.description ||
    error?.cause?.message ||
    execution?.errorMessage ||
    execution?.data?.errorMessage,
  );
}

function supabaseHeaders(serviceRoleKey, json = false) {
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    Accept: "application/json",
  };
  if (json) {
    headers["Content-Type"] = "application/json";
    headers.Prefer = "return=minimal";
  }
  return headers;
}

function startupStubResponse(request, targetPath, env) {
  const method = request.method.toUpperCase();
  const path = targetPath.toLowerCase().replace(/\/+$/, "") || "/";

  if (path === "/healthz") return jsonResponse({ status: "ok" }, 200, request, env);
  if (path === "/rest/events/session-started") return jsonResponse({ ok: true }, 200, request, env);
  if (path.startsWith("/rest/telemetry/")) return jsonResponse({ ok: true }, 200, request, env);
  if (path.startsWith("/telemetry/")) return jsonResponse({ ok: true }, 200, request, env);
  if (method !== "GET" && method !== "HEAD") return null;

  if (path.startsWith("/rest/source-control")) {
    return jsonResponse({
      data: {
        connected: false,
        branchName: "",
        repositoryUrl: "",
        branchReadOnly: false,
        status: "not_connected",
      },
    }, 200, request, env);
  }
  if (path.startsWith("/rest/cloud") || path.startsWith("/rest/license")) {
    return jsonResponse({ data: {}, usage: {}, plan: null }, 200, request, env);
  }
  if (
    path.startsWith("/rest/community-packages") ||
    path.startsWith("/rest/annotation-tags") ||
    path.startsWith("/rest/tags") ||
    path.startsWith("/rest/insights") ||
    path.startsWith("/rest/ldap") ||
    path.startsWith("/rest/saml") ||
    path.startsWith("/rest/mfa") ||
    path.startsWith("/rest/orchestration")
  ) {
    return jsonResponse({ data: [], count: 0 }, 200, request, env);
  }

  if (path === "/rest/node-creator") {
    return jsonResponse({ data: { categories: [], nodes: [], actions: [], triggers: [] } }, 200, request, env);
  }
  if (path === "/rest/workflows" || path === "/rest/workflows/filter") {
    return jsonResponse({ data: [], count: 0 }, 200, request, env);
  }
  if (path.startsWith("/rest/projects")) {
    if (path.endsWith("/count")) return jsonResponse({ data: { count: 0 }, count: 0 }, 200, request, env);
    if (path.endsWith("/personal")) {
      return jsonResponse({
        data: {
          id: "nexus-locked-project",
          name: "Nexus locked editor",
          type: "personal",
          role: "project:personalOwner",
          scopes: [],
        },
      }, 200, request, env);
    }
    return jsonResponse({ data: [], count: 0 }, 200, request, env);
  }
  if (path.startsWith("/rest/users")) {
    if (path.endsWith("/me") || path.endsWith("/current")) {
      return jsonResponse({
        data: {
          id: "nexus-locked-editor",
          firstName: "Nexus",
          lastName: "Editor",
          email: "locked-editor@nexus.local",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          isOwner: false,
          role: "global:member",
          globalRole: { name: "member", scope: "global" },
          projectRelations: [],
          personalizationAnswers: {},
          settings: {},
        },
      }, 200, request, env);
    }
    return jsonResponse({ data: [], count: 0 }, 200, request, env);
  }
  if (path.startsWith("/rest/credentials")) return jsonResponse({ data: [], count: 0 }, 200, request, env);
  if (path.startsWith("/rest/variables")) return jsonResponse({ data: [], count: 0 }, 200, request, env);
  if (path === "/api/banners" || path === "/api/whats-new") return jsonResponse([], 200, request, env);
  if (path.startsWith("/api/versions/")) return jsonResponse([], 200, request, env);

  return null;
}

function forbiddenPath(path) {
  const safe = path.toLowerCase();
  return [
    "/credentials",
    "/executions",
    "/execution",
    "/projects",
    "/project",
    "/settings",
    "/users",
    "/user",
    "/variables",
    "/admin",
    "/api/v1/",
    "/rest/credentials",
    "/rest/projects",
    "/rest/users",
    "/rest/variables",
    "/rest/oauth",
    "/rest/cloud",
    "/rest/audit",
    "/rest/source-control",
    "/rest/license/renew",
  ].some((blocked) => safe === blocked || safe.startsWith(`${blocked}/`) || safe.startsWith(blocked));
}

function isCredentialWritePath(path, method) {
  const safe = String(path || "").toLowerCase();
  return safe.startsWith("/rest/credentials") && !["GET", "HEAD"].includes(String(method || "").toUpperCase());
}

function staticAssetPath(path) {
  return (
    /^\/(assets|static|icons|fonts|js|css|browser|vendor)\//i.test(path) ||
    /^\/favicon/i.test(path) ||
    /\.(js|mjs|css|png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf|map)$/i.test(path)
  );
}

function apiLikePath(path) {
  return /^\/(rest|api|types|healthz)(\/|$)/i.test(path);
}

function allowedWorkflowRestPath(path, workflowId) {
  const encoded = encodeURIComponent(workflowId);
  const safe = path.replace(/\/+$/, "");
  const patterns = [
    `/rest/workflows/${workflowId}`,
    `/rest/workflows/${encoded}`,
    `/rest/workflows/${workflowId}/`,
    `/rest/workflows/${encoded}/`,
  ];
  return patterns.some((pattern) => safe === pattern.replace(/\/+$/, "") || path.startsWith(pattern));
}

function allowedExecutionPath(path, method, workflowId) {
  const safe = path.toLowerCase().replace(/\/+$/, "") || "/";
  const raw = path.replace(/\/+$/, "") || "/";
  const encoded = encodeURIComponent(workflowId);
  const methodName = String(method || "GET").toUpperCase();

  if (["GET", "HEAD"].includes(methodName)) {
    if (safe === "/rest/push" || safe.startsWith("/rest/push/")) return true;
    if (safe === "/rest/executions" || safe === "/rest/execution") return true;
    if (safe === "/rest/executions-current" || safe.startsWith("/rest/executions-current/")) return true;
    if (/^\/rest\/executions\/[^/]+$/i.test(raw)) return true;
    if (/^\/rest\/execution\/[^/]+$/i.test(raw)) return true;
    return false;
  }

  if (methodName === "POST") {
    if (safe === "/rest/workflows/run") return true;
    if (raw === `/rest/workflows/${workflowId}/run` || raw === `/rest/workflows/${encoded}/run`) return true;
    if (/^\/rest\/executions-current\/[^/]+\/stop$/i.test(raw)) return true;
    if (/^\/rest\/executions\/[^/]+\/stop$/i.test(raw)) return true;
  }

  return false;
}

function allowedReadOnlyRestPath(path, method) {
  if (!["GET", "HEAD"].includes(method)) return false;
  const safe = path.toLowerCase();
  return [
    "/rest/settings",
    "/rest/login",
    "/rest/node-types",
    "/rest/node-creator",
    "/rest/versions",
    "/rest/translation",
    "/rest/frontend-settings",
    "/rest/push",
    "/rest/binary-data",
    "/rest/data-tables-global/limits",
    "/rest/module-settings",
    "/rest/roles",
    "/rest/projects/my-projects",
    "/rest/projects/personal",
    "/rest/projects/count",
    "/types/",
    "/node-translation-headers",
    "/community-node-types",
  ].some((allowed) => safe === allowed || safe.startsWith(allowed));
}

function allowedProxyPath(path, method, workflowId) {
  if (path === "/" || path === "") return true;
  if (staticAssetPath(path)) return true;
  if (path === `/workflow/${workflowId}` || path === `/workflow/${encodeURIComponent(workflowId)}`) return true;
  if (path.startsWith(`/workflow/${workflowId}/`) || path.startsWith(`/workflow/${encodeURIComponent(workflowId)}/`)) return true;
  if (allowedWorkflowRestPath(path, workflowId)) return ["GET", "HEAD", "POST", "PATCH", "PUT"].includes(method);
  if (allowedExecutionPath(path, method, workflowId)) return true;
  if (allowedReadOnlyRestPath(path, method)) return true;
  if (forbiddenPath(path)) return false;
  return false;
}

function isWebSocketRequest(request) {
  return String(request.headers.get("Upgrade") || "").toLowerCase() === "websocket";
}

function isWorkflowRunPath(path, method) {
  const safe = String(path || "").toLowerCase().replace(/\/+$/, "");
  return String(method || "").toUpperCase() === "POST" && (
    safe === "/rest/workflows/run" ||
    /^\/rest\/workflows\/[^/]+\/run$/i.test(String(path || ""))
  );
}

async function validateLockedWorkflowRun(request, path, workflowId) {
  if (!isWorkflowRunPath(path, request.method)) return { ok: true, bodyText: undefined };

  const bodyText = await request.clone().text().catch(() => "");
  if (!bodyText) return { ok: true, bodyText };

  let payload = null;
  try {
    payload = JSON.parse(bodyText);
  } catch (_error) {
    return { ok: true, bodyText };
  }

  const referencedIds = collectWorkflowIds(payload);
  if (referencedIds.size && !referencedIds.has(String(workflowId))) {
    return {
      ok: false,
      bodyText,
      error: "This run request references a different n8n workflow.",
    };
  }

  return {
    ok: true,
    bodyText,
    partialRun: isPartialWorkflowRun(payload),
  };
}

function isPartialWorkflowRun(payload) {
  return Boolean(
    cleanString(payload?.destinationNode) ||
    cleanString(payload?.startNode) ||
    (Array.isArray(payload?.startNodes) && payload.startNodes.length) ||
    Object.keys(asPlainObject(payload?.runData)).length ||
    Object.keys(asPlainObject(payload?.pinData)).length
  );
}

function asPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

function collectWorkflowIds(payload) {
  const ids = new Set();
  const candidates = [
    payload?.id,
    payload?.workflowId,
    payload?.workflow_id,
    payload?.workflowData?.id,
    payload?.workflowData?.workflowId,
    payload?.workflow?.id,
  ];

  candidates
    .map((value) => cleanString(value))
    .filter(Boolean)
    .forEach((value) => ids.add(value));

  return ids;
}

function shouldFilterExecutionJson(path) {
  const safe = String(path || "").toLowerCase().replace(/\/+$/, "");
  return safe === "/rest/executions" ||
    safe === "/rest/execution" ||
    safe === "/rest/executions-current" ||
    safe.startsWith("/rest/executions-current/") ||
    /^\/rest\/executions\/[^/]+$/i.test(String(path || "")) ||
    /^\/rest\/execution\/[^/]+$/i.test(String(path || ""));
}

function filterExecutionJsonText(text, workflowId) {
  try {
    const value = JSON.parse(text);
    const filtered = filterExecutionPayload(value, workflowId);
    return JSON.stringify(filtered);
  } catch (_error) {
    return text;
  }
}

function filterExecutionPayload(value, workflowId) {
  if (Array.isArray(value)) {
    return value.filter((item) => executionMatchesWorkflow(item, workflowId));
  }

  if (!value || typeof value !== "object") return value;

  const next = { ...value };
  let filteredCollection = false;

  if (Array.isArray(next.results)) {
    next.results = next.results.filter((item) => executionMatchesWorkflow(item, workflowId));
    filteredCollection = true;
  }

  if (Array.isArray(next.executions)) {
    next.executions = next.executions.filter((item) => executionMatchesWorkflow(item, workflowId));
    filteredCollection = true;
  }

  if (Array.isArray(value.data)) {
    next.data = value.data.filter((item) => executionMatchesWorkflow(item, workflowId));
    filteredCollection = true;
    return next;
  }

  if (value.data && typeof value.data === "object") {
    const nested = { ...value.data };
    let filteredNestedCollection = false;

    if (Array.isArray(nested.results)) {
      nested.results = nested.results.filter((item) => executionMatchesWorkflow(item, workflowId));
      filteredNestedCollection = true;
    }

    if (Array.isArray(nested.executions)) {
      nested.executions = nested.executions.filter((item) => executionMatchesWorkflow(item, workflowId));
      filteredNestedCollection = true;
    }

    if (filteredNestedCollection) {
      next.data = nested;
      return next;
    }

    if (!executionMatchesWorkflow(value.data, workflowId)) {
      next.data = null;
      return next;
    }
  }

  if (!filteredCollection && !("data" in value) && !executionMatchesWorkflow(value, workflowId)) {
    return null;
  }

  return next;
}

function executionMatchesWorkflow(item, workflowId) {
  const id = executionWorkflowId(item);
  return id === String(workflowId);
}

function executionWorkflowId(item) {
  return cleanString(
    item?.workflowId ||
    item?.workflow_id ||
    item?.workflow?.id ||
    item?.workflowData?.id ||
    item?.data?.workflowId ||
    item?.data?.workflow_id ||
    item?.data?.workflow?.id ||
    item?.data?.workflowData?.id,
  );
}

function isHtmlRequest(request, response, targetPath) {
  const contentType = response.headers.get("Content-Type") || "";
  const accept = request.headers.get("Accept") || "";
  if (apiLikePath(targetPath) && !accept.includes("text/html")) return false;
  return contentType.includes("text/html") || accept.includes("text/html") || /^\/workflow\//.test(targetPath);
}

function injectEditorLock(html, workflowId, token, env) {
  const allowedWorkflowPath = `/workflow/${encodeURIComponent(workflowId)}`;
  const editorToken = encodeURIComponent(token);
  const editorPrefix = `/editor/${editorToken}`;
  const upstreamOrigin = safeOrigin(env.N8N_BASE_URL);
  const css = `
    <style id="nexus-locked-n8n-css">
      html,
      body,
      #app {
        width: 100% !important;
        height: 100% !important;
        min-width: 0 !important;
        margin: 0 !important;
        overflow: hidden !important;
      }

      body {
        background: #ffffff !important;
      }

      #app,
      #app > * {
        max-width: 100vw !important;
      }

      [data-test-id*="main-sidebar"],
      [data-test-id*="side-menu"],
      [data-test-id*="project"],
      [data-test-id*="credentials"],
      [data-test-id*="workflow-publish-button"],
      [data-test-id*="workflow-activate-switch"],
      [data-test-id*="github"],
      a[href*="github.com/n8n-io"],
      nav[aria-label*="main" i],
      aside[aria-label*="main" i] {
        display: none !important;
        pointer-events: none !important;
      }

      [class*="canvas"],
      [class*="Canvas"],
      [class*="workflow"],
      [class*="Workflow"] {
        max-width: 100% !important;
      }

      @media (max-width: 760px) {
        body {
          overflow: auto !important;
        }

        #app {
          min-width: 760px !important;
        }
      }
    </style>
  `;
  const guard = `
    <script id="nexus-locked-n8n-guard">
      (() => {
        const allowedWorkflowPath = ${JSON.stringify(allowedWorkflowPath)};
        const editorToken = ${JSON.stringify(token)};
        const editorPrefix = ${JSON.stringify(editorPrefix)};
        const upstreamOrigin = ${JSON.stringify(upstreamOrigin)};
        const blocked = /\\/(credentials|executions|execution|projects|project|settings|users|user|variables|admin|workflows)(\\/|$)/i;
        const proxyPath = /\\/(rest|api|types|assets|static|icons|fonts|js|css|browser|vendor|healthz|node-translation-headers|community-node-types)(\\/|$)/i;
        const nativePushState = history.pushState.bind(history);
        const nativeReplaceState = history.replaceState.bind(history);
        function tokenizedUrl(input) {
          try {
            let parsed = new URL(String(input), location.origin);
            if (parsed.origin !== location.origin) {
              if (upstreamOrigin && parsed.origin === upstreamOrigin) {
                parsed = new URL(parsed.pathname + parsed.search + parsed.hash, location.origin);
              } else {
                return input;
              }
            }
            if (!proxyPath.test(parsed.pathname) && !/\\.(js|mjs|css|png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf|map)$/i.test(parsed.pathname)) {
              return input;
            }
            if (!parsed.pathname.startsWith(editorPrefix + "/")) {
              parsed.searchParams.set("editor_token", editorToken);
            }
            return parsed.pathname + parsed.search + parsed.hash;
          } catch (_error) {
            return input;
          }
        }
        function lockedUrl(url) {
          if (!url) return allowedWorkflowPath;
          const parsed = new URL(String(url), location.origin);
          if (blocked.test(parsed.pathname)) return allowedWorkflowPath;
          if (parsed.pathname.startsWith("/workflow/") && parsed.pathname !== allowedWorkflowPath) return allowedWorkflowPath;
          return parsed.pathname + parsed.search + parsed.hash;
        }
        history.pushState = (state, title, url) => nativePushState(state, title, lockedUrl(url));
        history.replaceState = (state, title, url) => nativeReplaceState(state, title, lockedUrl(url));
        const nativeFetch = window.fetch && window.fetch.bind(window);
        if (nativeFetch) {
          window.fetch = (input, init) => {
            if (typeof input === "string" || input instanceof URL) {
              return nativeFetch(tokenizedUrl(input), init);
            }
            if (input && input.url) {
              return nativeFetch(new Request(tokenizedUrl(input.url), input), init);
            }
            return nativeFetch(input, init);
          };
        }
        const nativeOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          return nativeOpen.call(this, method, tokenizedUrl(url), ...rest);
        };
        document.addEventListener("click", (event) => {
          const link = event.target && event.target.closest && event.target.closest("a[href]");
          if (!link) return;
          const next = lockedUrl(link.getAttribute("href"));
          if (next !== link.getAttribute("href")) {
            event.preventDefault();
            event.stopPropagation();
            location.href = next;
          }
        }, true);
      })();
    </script>
  `;
  const rewritten = html.replace(
    /\b(src|href)=["']\/((?:assets|static|icons|fonts|js|css|browser|vendor)\/[^"']+|favicon[^"']*)["']/gi,
    (_match, attr, path) => `${attr}="${editorPrefix}/${path}"`,
  );
  const upstreamBase = cleanBaseUrl(env.N8N_BASE_URL);
  const proxied = upstreamBase
    ? rewritten.split(upstreamBase).join("")
    : rewritten;
  return proxied.replace(/(<head[^>]*>)/i, `$1${css}${guard}`);
}

function shouldRewriteN8nJson(path) {
  const safe = path.toLowerCase();
  return safe === "/rest/settings" ||
    safe === "/rest/frontend-settings" ||
    safe === "/rest/login" ||
    safe.startsWith("/rest/module-settings") ||
    safe.startsWith("/rest/versions");
}

function rewriteN8nJsonText(text, request, env) {
  const upstreamBase = cleanBaseUrl(env.N8N_BASE_URL);
  if (!upstreamBase || !text) return text;

  const proxyBase = new URL(request.url).origin;
  let rewritten = text.split(upstreamBase).join(proxyBase);
  const upstreamOrigin = safeOrigin(upstreamBase);
  if (upstreamOrigin && upstreamOrigin !== upstreamBase) {
    rewritten = rewritten.split(upstreamOrigin).join(proxyBase);
  }
  return rewritten;
}

function responseHeaders(upstream, request, env, contentType) {
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    const safe = key.toLowerCase();
    if ([
      "set-cookie",
      "x-frame-options",
      "content-security-policy",
      "content-length",
      "content-encoding",
      "content-disposition",
      "origin-agent-cluster",
      "cross-origin-opener-policy",
      "cross-origin-embedder-policy",
      "cross-origin-resource-policy",
    ].includes(safe)) return;
    headers.set(key, value);
  });
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", frameAncestorsPolicy(env));
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Content-Type-Options", "nosniff");
  addCorsHeaders(headers, request, env);
  return headers;
}

function jsonResponse(data, status = 200, request, env) {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": frameAncestorsPolicy(env),
    "X-Content-Type-Options": "nosniff",
  });
  if (request) addCorsHeaders(headers, request, env);
  return new Response(JSON.stringify(data), { status, headers });
}

function redirectResponse(location, token, request, env) {
  const safeLocation = tokenizedRedirectLocation(location, token, request);
  const headers = new Headers({
    Location: safeLocation,
    "Cache-Control": "no-store",
    "Content-Security-Policy": frameAncestorsPolicy(env),
  });
  addCorsHeaders(headers, request, env);
  const response = new Response(null, { status: 302, headers });
  return withEditorCookie(response, token, true);
}

function tokenizedRedirectLocation(location, token, request) {
  try {
    const current = new URL(request.url);
    const next = new URL(location, current.origin);
    if (next.origin !== current.origin) return location;
    if (token && !next.searchParams.has("editor_token")) {
      next.searchParams.set("editor_token", token);
    }
    return `${next.pathname}${next.search}${next.hash}`;
  } catch (_error) {
    return location;
  }
}

function optionsResponse(request, env) {
  const headers = new Headers();
  addCorsHeaders(headers, request, env);
  headers.set("Access-Control-Max-Age", "600");
  return new Response(null, { status: 204, headers });
}

function addCorsHeaders(headers, request, env) {
  const origin = request?.headers?.get("Origin") || "";
  if (origin && allowedOrigin(origin, env)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Vary", "Origin");
  }
  headers.set("Access-Control-Allow-Methods", "GET,HEAD,POST,PATCH,PUT,OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    request?.headers?.get("Access-Control-Request-Headers") ||
      "authorization,content-type,browser-id,n8n-browser-id,x-requested-with",
  );
}

function allowedOrigin(origin, env) {
  const allowed = new Set([
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "https://nexus-ai.software",
    cleanString(env?.NEXUS_APP_ORIGIN).replace(/\/+$/, ""),
  ].filter(Boolean));
  cleanString(env?.NEXUS_EDITOR_ALLOWED_ORIGINS)
    .split(",")
    .map((item) => item.trim().replace(/\/+$/, ""))
    .filter(Boolean)
    .forEach((item) => allowed.add(item));
  return allowed.has(origin.replace(/\/+$/, ""));
}

function frameAncestorsPolicy(env = {}) {
  const allowed = new Set([
    "'self'",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "https://nexus-ai.software",
    cleanString(env.NEXUS_APP_ORIGIN).replace(/\/+$/, ""),
  ].filter(Boolean));
  return `frame-ancestors ${Array.from(allowed).join(" ")}; base-uri 'none';`;
}

function withEditorCookie(response, token, shouldSet) {
  if (!shouldSet) return response;
  const headers = new Headers(response.headers);
  headers.append(
    "Set-Cookie",
    `${EDITOR_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=3600`,
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function tokenFromQuery(request) {
  try {
    return Boolean(new URL(request.url).searchParams.get("editor_token"));
  } catch (_error) {
    return false;
  }
}

function wantsHtml(request) {
  const accept = request.headers.get("Accept") || "";
  return accept.includes("text/html") && !accept.includes("application/json");
}

function contentTypeForPath(path) {
  const safe = path.toLowerCase().split("?")[0] || "";
  if (safe.endsWith(".js") || safe.endsWith(".mjs")) return "application/javascript; charset=utf-8";
  if (safe.endsWith(".css")) return "text/css; charset=utf-8";
  if (safe.endsWith(".json") || safe.endsWith(".map")) return "application/json; charset=utf-8";
  if (safe.endsWith(".svg")) return "image/svg+xml";
  if (safe.endsWith(".png")) return "image/png";
  if (safe.endsWith(".jpg") || safe.endsWith(".jpeg")) return "image/jpeg";
  if (safe.endsWith(".gif")) return "image/gif";
  if (safe.endsWith(".webp")) return "image/webp";
  if (safe.endsWith(".ico")) return "image/x-icon";
  if (safe.endsWith(".woff")) return "font/woff";
  if (safe.endsWith(".woff2")) return "font/woff2";
  if (safe.endsWith(".ttf")) return "font/ttf";
  return "";
}

async function decryptText(payload, env) {
  if (!payload || typeof payload !== "object") return "";
  const iv = cleanString(payload.iv);
  const data = cleanString(payload.data);
  if (!iv || !data) return "";

  const secrets = [
    cleanString(env.N8N_EDITOR_SESSION_SECRET),
    cleanString(env.NEXUS_CREDENTIAL_SECRET),
  ].filter((secret, index, values) => secret && secret.length >= 16 && values.indexOf(secret) === index);

  if (!secrets.length) throw new Error("Missing N8N_EDITOR_SESSION_SECRET.");

  let lastError = null;
  for (const secret of secrets) {
    try {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
      const key = await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["decrypt"]);
      const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: base64ToBytes(iv) },
        key,
        base64ToBytes(data),
      );
      return new TextDecoder().decode(decrypted);
    } catch (error) {
      lastError = error;
    }
  }

  console.warn("[Nexus] Editor session decrypt failed", {
    hasEditorSecret: Boolean(env.N8N_EDITOR_SESSION_SECRET),
    hasFallbackSecret: Boolean(env.NEXUS_CREDENTIAL_SECRET),
    message: lastError?.message || String(lastError),
  });
  throw new Error("Editor session could not be decrypted. Set the same N8N_EDITOR_SESSION_SECRET in Supabase and Cloudflare, then reopen the editor from Nexus.");
}

async function sha256Hex(value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function readCookie(cookieHeader, name) {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) || "";
}

function cleanString(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return cleanString(value).toLowerCase();
}

function cleanBaseUrl(value) {
  return cleanString(value).replace(/\/+$/, "");
}

function safeOrigin(value) {
  try {
    return new URL(cleanBaseUrl(value)).origin;
  } catch (_error) {
    return "";
  }
}

function requiredEnv(env, name) {
  const value = cleanString(env[name]);
  if (!value) throw new Error(`Missing Worker secret or variable: ${name}`);
  return value;
}
