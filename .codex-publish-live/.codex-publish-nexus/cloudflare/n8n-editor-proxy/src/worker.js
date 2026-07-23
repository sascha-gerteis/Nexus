const EDITOR_COOKIE = "nexus_n8n_editor_token";
const SESSION_CACHE_TTL_MS = 30_000;
const CREDENTIAL_REF_CACHE_TTL_MS = 15_000;
const sessionCache = new Map();
const workflowCredentialRefCache = new Map();
const sessionCredentialRefCache = new Map();

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
  const stateContext = decodeEditorState(url.searchParams.get("state"));
  const token = route.token ||
    cleanString(url.searchParams.get("editor_token")) ||
    readCookie(request.headers.get("Cookie") || "", EDITOR_COOKIE) ||
    stateContext.token;

  if (!token) {
    return jsonResponse({ ok: false, error: "Missing editor token." }, 403, request, env);
  }

  const session = await loadSession(token, env);
  const targetPath = normalizeTargetPath(route.targetPath || url.pathname, session.n8n_workflow_id);
  const targetSearch = cleanProxySearch(url.searchParams, stateContext);

  const stub = startupStubResponse(request, targetPath, env);
  if (stub) return withEditorCookie(stub, token, route.token, session, env, request);

  if (isCredentialDeletePath(targetPath, request.method)) {
    return jsonResponse({
      ok: false,
      error: "Credential deletion is blocked in the locked Nexus editor.",
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

  if (isOAuthCallbackPath(targetPath)) {
    if (upstream.status < 400) {
      workflowCredentialRefCache.clear();
      sessionCredentialRefCache.delete(session.id);
      await rememberRecentlyTouchedCredentialRefs(session.id, session.n8n_cookie, env);
    }

    const text = upstream.status >= 400 ? await upstream.text().catch(() => "") : "";
    const response = oauthCallbackCompleteResponse({
      ok: upstream.status < 400,
      status: upstream.status,
      error: text ? text.slice(0, 700) : "",
    }, request, env);
    return withEditorCookie(response, token, route.token, session, env, request);
  }

  if (upstream.status >= 300 && upstream.status < 400) {
    const location = upstream.headers.get("Location") || `/workflow/${encodeURIComponent(session.n8n_workflow_id)}`;
    const rewrittenLocation = rewriteOAuthRedirectLocation(location, request, env, token);
    const nextUrl = new URL(rewrittenLocation, requiredEnv(env, "N8N_BASE_URL"));
    const upstreamOrigin = safeOrigin(env.N8N_BASE_URL);
    const proxyOrigin = new URL(request.url).origin;
    if (nextUrl.origin !== upstreamOrigin && nextUrl.origin !== proxyOrigin) {
      return redirectResponse(nextUrl.toString(), token, request, env, session);
    }
    const nextPath = forbiddenPath(nextUrl.pathname)
      ? `/workflow/${encodeURIComponent(session.n8n_workflow_id)}`
      : `${nextUrl.pathname}${nextUrl.search}`;
    return redirectResponse(nextPath, token, request, env, session);
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
    return withEditorCookie(response, token, route.token, session, env, request);
  }

  if (
    upstream.ok &&
    contentType.includes("application/json") &&
    shouldFilterCredentialJson(targetPath) &&
    String(request.method || "GET").toUpperCase() === "GET"
  ) {
    const text = await upstream.text();
    const refs = await workflowCredentialRefs(session.n8n_workflow_id, session.n8n_cookie, env, session.id);
    const rewritten = filterCredentialJsonText(text, refs);
    const response = new Response(rewritten, {
      status: upstream.status,
      headers: responseHeaders(upstream, request, env, "application/json; charset=utf-8"),
    });
    return withEditorCookie(response, token, route.token, session, env, request);
  }

  if (
    upstream.ok &&
    contentType.includes("application/json") &&
    shouldRememberCredentialJson(targetPath) &&
    ["POST", "PATCH", "PUT"].includes(String(request.method || "").toUpperCase())
  ) {
    const text = await upstream.text();
    rememberSessionCredentialRefs(session.id, text);
    workflowCredentialRefCache.clear();
    const response = new Response(text, {
      status: upstream.status,
      headers: responseHeaders(upstream, request, env, "application/json; charset=utf-8"),
    });
    return withEditorCookie(response, token, route.token, session, env, request);
  }

  if (upstream.ok && contentType.includes("application/json") && shouldRewriteN8nJson(targetPath)) {
    const text = await upstream.text();
    const rewritten = rewriteN8nJsonText(text, request, env, token);
    const response = new Response(rewritten, {
      status: upstream.status,
      headers: responseHeaders(upstream, request, env, "application/json; charset=utf-8"),
    });
    return withEditorCookie(response, token, route.token, session, env, request);
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
    return withEditorCookie(response, token, true, session, env, request);
  }

  const response = new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders(upstream, request, env, contentType),
  });
  return withEditorCookie(response, token, route.token || tokenFromQuery(request), session, env, request);
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

function cleanProxySearch(searchParams, stateContext = null) {
  const next = new URLSearchParams(searchParams);
  next.delete("editor_token");
  next.delete("editor_v");
  next.delete("client_v");
  if (stateContext?.originalState) {
    next.set("state", stateContext.originalState);
  }
  const value = next.toString();
  return value ? `?${value}` : "";
}

function buildUpstreamRequest(request, cookie, bodyOverride) {
  const headers = new Headers();
  headers.set("Accept", request.headers.get("Accept") || "*/*");
  headers.set("Cookie", cookie);
  headers.set("User-Agent", request.headers.get("User-Agent") || "Nexus n8n editor proxy");
  headers.set("X-Requested-With", request.headers.get("X-Requested-With") || "XMLHttpRequest");
  try {
    const url = new URL(request.url);
    headers.set("X-Forwarded-Host", url.host);
    headers.set("X-Forwarded-Proto", url.protocol.replace(":", ""));
  } catch (_error) {
    // Best-effort forwarding hints for OAuth callbacks.
  }

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
  const editorScopes = lockedEditorScopes();
  const lockedProject = {
    id: "nexus-locked-project",
    name: "Nexus locked editor",
    type: "personal",
    role: "project:personalOwner",
    scopes: editorScopes,
  };

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
    if (path.endsWith("/my-projects")) {
      return jsonResponse({ data: [lockedProject], count: 1 }, 200, request, env);
    }
    if (path.endsWith("/personal")) {
      return jsonResponse({ data: lockedProject }, 200, request, env);
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
          isOwner: true,
          role: "global:owner",
          globalRole: { name: "owner", scope: "global" },
          scopes: editorScopes,
          globalScopes: editorScopes,
          projectRelations: [
            {
              projectId: lockedProject.id,
              project: lockedProject,
              role: lockedProject.role,
              scopes: editorScopes,
            },
          ],
          personalizationAnswers: {},
          settings: {},
        },
      }, 200, request, env);
    }
    return jsonResponse({ data: [], count: 0 }, 200, request, env);
  }
  if (path.startsWith("/rest/variables")) return jsonResponse({ data: [], count: 0 }, 200, request, env);
  if (path === "/api/banners" || path === "/api/whats-new") return jsonResponse([], 200, request, env);
  if (path.startsWith("/api/versions/")) return jsonResponse([], 200, request, env);

  return null;
}

function lockedEditorScopes() {
  return [
    "workflow:read",
    "workflow:update",
    "workflow:execute",
    "workflow:share",
    "credential:read",
    "credential:list",
    "credential:create",
    "credential:update",
    "credential:share",
    "credential:test",
    "credential:move",
    "credentials:read",
    "credentials:list",
    "credentials:create",
    "credentials:update",
    "credentials:share",
    "credentials:test",
    "credentials:move",
    "project:read",
    "project:list",
    "tag:read",
    "node:read",
    "execution:read",
    "execution:stop",
  ];
}

function forbiddenPath(path) {
  const safe = path.toLowerCase();
  return [
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

function isCredentialDeletePath(path, method) {
  const safe = String(path || "").toLowerCase();
  return safe.startsWith("/rest/credentials") && String(method || "").toUpperCase() === "DELETE";
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
  if (allowedCredentialUiPath(path, method)) return true;
  if (allowedWorkflowRestPath(path, workflowId)) return ["GET", "HEAD", "POST", "PATCH", "PUT"].includes(method);
  if (allowedExecutionPath(path, method, workflowId)) return true;
  if (allowedCredentialPath(path, method)) return true;
  if (allowedOAuthCredentialPath(path, method)) return true;
  if (allowedReadOnlyRestPath(path, method)) return true;
  if (forbiddenPath(path)) return false;
  return false;
}

function allowedCredentialUiPath(path, method) {
  const methodName = String(method || "GET").toUpperCase();
  if (!["GET", "HEAD"].includes(methodName)) return false;

  const safe = String(path || "").toLowerCase().replace(/\/+$/, "") || "/";
  return safe === "/credentials" ||
    safe.startsWith("/credentials/") ||
    safe === "/credential" ||
    safe.startsWith("/credential/");
}

function allowedCredentialPath(path, method) {
  const methodName = String(method || "GET").toUpperCase();
  if (!["GET", "HEAD", "POST", "PATCH", "PUT"].includes(methodName)) return false;

  const safe = String(path || "").toLowerCase().replace(/\/+$/, "") || "/";
  return safe === "/rest/credentials" ||
    safe.startsWith("/rest/credentials/") ||
    safe === "/rest/credential-types" ||
    safe.startsWith("/rest/credential-types/");
}

function allowedOAuthCredentialPath(path, method) {
  const methodName = String(method || "GET").toUpperCase();
  if (!["GET", "HEAD", "POST"].includes(methodName)) return false;

  const safe = String(path || "").toLowerCase().replace(/\/+$/, "") || "/";
  return safe.startsWith("/rest/oauth2-credential") ||
    safe.startsWith("/rest/oauth1-credential");
}

function isOAuthCallbackPath(path) {
  const safe = String(path || "").toLowerCase().replace(/\/+$/, "") || "/";
  return safe === "/rest/oauth2-credential/callback" ||
    safe === "/rest/oauth1-credential/callback";
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

function shouldFilterCredentialJson(path) {
  const safe = String(path || "").toLowerCase().replace(/\/+$/, "") || "/";
  return safe === "/rest/credentials" || safe.startsWith("/rest/credentials/");
}

function shouldRememberCredentialJson(path) {
  const safe = String(path || "").toLowerCase().replace(/\/+$/, "") || "/";
  return safe === "/rest/credentials" || safe.startsWith("/rest/credentials/");
}

async function workflowCredentialRefs(workflowId, cookie, env, sessionId = "") {
  const key = `${workflowId}:${String(cookie || "").slice(0, 32)}`;
  const cached = workflowCredentialRefCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    mergeSessionCredentialRefs(cached.refs, sessionId);
    return cached.refs;
  }

  const refs = {
    ids: new Set(),
    names: new Set(),
    namesByType: new Set(),
    types: new Set(),
  };

  try {
    const workflowUrl = `${cleanBaseUrl(requiredEnv(env, "N8N_BASE_URL"))}/rest/workflows/${encodeURIComponent(workflowId)}`;
    const response = await fetch(workflowUrl, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: cookie,
      },
    });
    if (!response.ok) throw new Error(`n8n workflow read failed ${response.status}`);

    const payload = await response.json();
    const workflow = payload?.data || payload?.workflow || payload;
    collectCredentialRefsFromWorkflow(workflow, refs);
  } catch (_error) {
    /*
      Fail closed: if the workflow cannot be inspected, expose no credential
      metadata to the embedded editor.
    */
  }

  workflowCredentialRefCache.set(key, {
    refs,
    expiresAt: Date.now() + CREDENTIAL_REF_CACHE_TTL_MS,
  });
  mergeSessionCredentialRefs(refs, sessionId);
  return refs;
}

function rememberSessionCredentialRefs(sessionId, text) {
  const safeSessionId = cleanString(sessionId);
  if (!safeSessionId || !text) return;

  const refs = sessionCredentialRefCache.get(safeSessionId)?.refs || {
    ids: new Set(),
    names: new Set(),
    namesByType: new Set(),
    types: new Set(),
  };

  try {
    collectCredentialRefsFromPayload(JSON.parse(text), refs);
    sessionCredentialRefCache.set(safeSessionId, {
      refs,
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
  } catch (_error) {
    // Ignore malformed credential responses; the normal workflow refs still apply.
  }
}

async function rememberRecentlyTouchedCredentialRefs(sessionId, cookie, env) {
  const safeSessionId = cleanString(sessionId);
  if (!safeSessionId || !cookie) return;

  const refs = sessionCredentialRefCache.get(safeSessionId)?.refs || {
    ids: new Set(),
    names: new Set(),
    namesByType: new Set(),
    types: new Set(),
  };

  try {
    const response = await fetch(`${cleanBaseUrl(requiredEnv(env, "N8N_BASE_URL"))}/rest/credentials`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Cookie: cookie,
      },
    });
    if (!response.ok) return;

    const payload = await response.json();
    const rows = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.credentials)
          ? payload.credentials
          : [];
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const row of rows) {
      const value = row?.data && typeof row.data === "object" ? row.data : row;
      const touchedAt = Date.parse(value?.updatedAt || value?.updated_at || value?.createdAt || value?.created_at || "");
      if (!Number.isFinite(touchedAt) || touchedAt < cutoff) continue;
      addCredentialRefFromValue(value, refs);
    }
    sessionCredentialRefCache.set(safeSessionId, {
      refs,
      expiresAt: Date.now() + 60 * 60 * 1000,
    });
  } catch (_error) {
    // Best effort only: if n8n does not return a credential list, workflow refs still apply.
  }
}

function mergeSessionCredentialRefs(refs, sessionId) {
  const safeSessionId = cleanString(sessionId);
  if (!safeSessionId) return refs;

  const cached = sessionCredentialRefCache.get(safeSessionId);
  if (!cached || cached.expiresAt <= Date.now()) {
    sessionCredentialRefCache.delete(safeSessionId);
    return refs;
  }

  for (const key of ["ids", "names", "namesByType", "types"]) {
    cached.refs[key]?.forEach((value) => refs[key].add(value));
  }
  return refs;
}

function collectCredentialRefsFromPayload(payload, refs) {
  if (!payload) return;
  if (Array.isArray(payload)) {
    payload.forEach((item) => collectCredentialRefsFromPayload(item, refs));
    return;
  }
  if (typeof payload !== "object") return;

  addCredentialRefFromValue(payload, refs);
  if (payload.data) collectCredentialRefsFromPayload(payload.data, refs);
  if (payload.credential) collectCredentialRefsFromPayload(payload.credential, refs);
  if (payload.credentials) collectCredentialRefsFromPayload(payload.credentials, refs);
}

function addCredentialRefFromValue(value, refs) {
  if (!value || typeof value !== "object") return;
  const item = value.data && typeof value.data === "object" ? value.data : value;
  const id = cleanString(item.id || item.credentialId || item.credential_id);
  const name = cleanString(item.name || item.credentialName || item.credential_name);
  const type = cleanString(item.type || item.credentialType || item.credential_type);
  if (id) refs.ids.add(id);
  if (name) refs.names.add(name);
  if (type) refs.types.add(type);
  if (name && type) refs.namesByType.add(`${type}:${name}`);
}

function collectCredentialRefsFromWorkflow(workflow, refs) {
  const nodes = Array.isArray(workflow?.nodes)
    ? workflow.nodes
    : Array.isArray(workflow?.data?.nodes)
      ? workflow.data.nodes
      : [];

  for (const node of nodes) {
    const credentials = asPlainObject(node?.credentials);
    for (const [credentialType, credential] of Object.entries(credentials)) {
      const item = asPlainObject(credential);
      const id = cleanString(item.id);
      const name = cleanString(item.name);
      const type = cleanString(item.type || credentialType);
      if (id) refs.ids.add(id);
      if (name) refs.names.add(name);
      if (type) refs.types.add(type);
      if (name && type) refs.namesByType.add(`${type}:${name}`);
    }
  }
}

function filterCredentialJsonText(text, refs) {
  try {
    const value = JSON.parse(text);
    return JSON.stringify(filterCredentialPayload(value, refs));
  } catch (_error) {
    return text;
  }
}

function filterCredentialPayload(value, refs) {
  if (Array.isArray(value)) return value.filter((item) => credentialMatchesRefs(item, refs));
  if (!value || typeof value !== "object") return value;

  if (Array.isArray(value.data)) {
    const data = value.data.filter((item) => credentialMatchesRefs(item, refs));
    return { ...value, data, count: typeof value.count === "number" ? data.length : value.count };
  }

  if (Array.isArray(value.credentials)) {
    const credentials = value.credentials.filter((item) => credentialMatchesRefs(item, refs));
    return { ...value, credentials, count: typeof value.count === "number" ? credentials.length : value.count };
  }

  if (value.data && typeof value.data === "object") {
    return credentialMatchesRefs(value.data, refs) ? value : { ...value, data: null };
  }

  return credentialMatchesRefs(value, refs) ? value : {};
}

function credentialMatchesRefs(item, refs) {
  const value = item?.data && typeof item.data === "object" ? item.data : item;
  if (!value || typeof value !== "object") return false;

  const id = cleanString(value.id || value.credentialId || value.credential_id);
  const name = cleanString(value.name || value.credentialName || value.credential_name);
  const type = cleanString(value.type || value.credentialType || value.credential_type);

  if (id && refs.ids.has(id)) return true;
  if (name && refs.names.has(name)) return true;
  if (name && type && refs.namesByType.has(`${type}:${name}`)) return true;
  return false;
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
        const blocked = /\\/(executions|execution|projects|project|settings|users|user|variables|admin|workflows)(\\/|$)/i;
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
        if (window.EventSource) {
          const NativeEventSource = window.EventSource;
          window.EventSource = function(url, config) {
            return new NativeEventSource(tokenizedUrl(url), config);
          };
          window.EventSource.prototype = NativeEventSource.prototype;
        }
        if (window.WebSocket) {
          const NativeWebSocket = window.WebSocket;
          window.WebSocket = function(url, protocols) {
            return protocols === undefined
              ? new NativeWebSocket(tokenizedUrl(url))
              : new NativeWebSocket(tokenizedUrl(url), protocols);
          };
          window.WebSocket.prototype = NativeWebSocket.prototype;
        }
        function wait(ms) {
          return new Promise((resolve) => setTimeout(resolve, ms));
        }
        function isVisible(element) {
          if (!element) return false;
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity || "1") > 0 &&
            rect.width > 0 &&
            rect.height > 0;
        }
        function textOf(element) {
          return String(element && (element.innerText || element.textContent || element.getAttribute("aria-label") || "") || "").trim();
        }
        function clickVisibleSaveButton() {
          const selectors = [
            'button[data-test-id*="save" i]',
            'button[aria-label*="save" i]',
            '[role="button"][aria-label*="save" i]',
            'button',
            '[role="button"]'
          ];
          const buttons = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
          const seen = new Set();
          for (const button of buttons) {
            if (seen.has(button)) continue;
            seen.add(button);
            if (!isVisible(button)) continue;
            const label = textOf(button);
            if (!/\\bsave\\b|save changes|savedraft|save draft/i.test(label)) continue;
            if (/publish|execute|run|delete|remove|cancel|close/i.test(label)) continue;
            try {
              button.click();
              return true;
            } catch (_error) {}
          }
          return false;
        }
        function dispatchKeyboardSave() {
          for (const target of [document.activeElement, document.body, window]) {
            try {
              target.dispatchEvent(new KeyboardEvent("keydown", {
                key: "s",
                code: "KeyS",
                ctrlKey: true,
                bubbles: true,
                cancelable: true
              }));
            } catch (_error) {}
            try {
              target.dispatchEvent(new KeyboardEvent("keydown", {
                key: "s",
                code: "KeyS",
                metaKey: true,
                bubbles: true,
                cancelable: true
              }));
            } catch (_error) {}
          }
        }
        window.addEventListener("message", (event) => {
          const data = event && event.data ? event.data : {};
          if (!data) return;
          if (data.type === "nexus:save-workflow-before-sync") {
            (async () => {
              dispatchKeyboardSave();
              await wait(200);
              const clicked = clickVisibleSaveButton();
              await wait(1500);
              try {
                if (window.parent && window.parent !== window) {
                  window.parent.postMessage({
                    source: "nexus-n8n-editor",
                    type: "nexus:n8n-save-attempted",
                    requestId: data.requestId || "",
                    clicked
                  }, "*");
                }
              } catch (_error) {}
            })();
            return;
          }
          if (data.type !== "nexus:n8n-oauth-complete") return;
          try {
            if (window.parent && window.parent !== window) {
              window.parent.postMessage(data, "*");
            }
          } catch (_error) {}
        });
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
    safe.startsWith("/rest/oauth2-credential") ||
    safe.startsWith("/rest/oauth1-credential") ||
    safe.startsWith("/rest/versions");
}

function rewriteOAuthRedirectLocation(location, request, env, token = "") {
  const upstreamBase = cleanBaseUrl(env.N8N_BASE_URL);
  if (!upstreamBase || !location) return location;

  const proxyBase = new URL(request.url).origin;
  let rewritten = replaceUrlVariants(String(location), upstreamBase, proxyBase);
  const upstreamOrigin = safeOrigin(upstreamBase);
  if (upstreamOrigin && upstreamOrigin !== upstreamBase) {
    rewritten = replaceUrlVariants(rewritten, upstreamOrigin, proxyBase);
  }
  rewritten = rewriteOAuthCallbackParamsToProxy(rewritten, proxyBase, upstreamBase, upstreamOrigin);
  return wrapEditorTokenInOAuthState(rewritten, token);
}

function rewriteN8nJsonText(text, request, env, token = "") {
  const upstreamBase = cleanBaseUrl(env.N8N_BASE_URL);
  if (!upstreamBase || !text) return text;

  const proxyBase = new URL(request.url).origin;
  let rewritten = replaceUrlVariants(text, upstreamBase, proxyBase);
  const upstreamOrigin = safeOrigin(upstreamBase);
  if (upstreamOrigin && upstreamOrigin !== upstreamBase) {
    rewritten = replaceUrlVariants(rewritten, upstreamOrigin, proxyBase);
  }
  rewritten = rewriteOAuthCallbackParamsToProxy(rewritten, proxyBase, upstreamBase, upstreamOrigin);
  return wrapEditorTokenInOAuthState(rewritten, token);
}

function rewriteOAuthCallbackParamsToProxy(value, proxyBase, upstreamBase, upstreamOrigin = "") {
  let source = String(value || "");
  const proxy = cleanBaseUrl(proxyBase);
  const upstream = cleanBaseUrl(upstreamBase);
  const upstreamRoot = cleanBaseUrl(upstreamOrigin || upstreamBase);
  if (!proxy || !upstream) return source;

  const pairs = [
    ["/rest/oauth2-credential/callback", "/rest/oauth2-credential/callback"],
    ["/rest/oauth1-credential/callback", "/rest/oauth1-credential/callback"],
  ];

  for (const [upstreamPath, proxyPath] of pairs) {
    source = restoreCallbackValue(source, `${upstream}${upstreamPath}`, `${proxy}${proxyPath}`);
    if (upstreamRoot && upstreamRoot !== upstream) {
      source = restoreCallbackValue(source, `${upstreamRoot}${upstreamPath}`, `${proxy}${proxyPath}`);
    }
  }

  return source;
}

function restoreUpstreamOAuthCallbackParams(value, proxyBase, upstreamBase, upstreamOrigin = "") {
  let source = String(value || "");
  const proxy = cleanBaseUrl(proxyBase);
  const upstream = cleanBaseUrl(upstreamBase);
  const upstreamRoot = cleanBaseUrl(upstreamOrigin || upstreamBase);
  if (!proxy || !upstream) return source;

  const pairs = [
    ["/rest/oauth2-credential/callback", "/rest/oauth2-credential/callback"],
    ["/rest/oauth1-credential/callback", "/rest/oauth1-credential/callback"],
  ];

  for (const [proxyPath, upstreamPath] of pairs) {
    source = restoreCallbackValue(source, `${proxy}${proxyPath}`, `${upstream}${upstreamPath}`);
    if (upstreamRoot && upstreamRoot !== upstream) {
      source = restoreCallbackValue(source, `${proxy}${proxyPath}`, `${upstreamRoot}${upstreamPath}`);
    }
  }

  return source;
}

function restoreCallbackValue(value, proxyCallback, upstreamCallback) {
  const rawProxy = cleanString(proxyCallback);
  const rawUpstream = cleanString(upstreamCallback);
  if (!rawProxy || !rawUpstream) return value;

  return String(value || "")
    .split(`redirect_uri=${encodeURIComponent(rawProxy)}`).join(`redirect_uri=${encodeURIComponent(rawUpstream)}`)
    .split(`redirect_uri=${encodeURIComponent(rawProxy).toLowerCase()}`).join(`redirect_uri=${encodeURIComponent(rawUpstream)}`)
    .split(`oauth_callback=${encodeURIComponent(rawProxy)}`).join(`oauth_callback=${encodeURIComponent(rawUpstream)}`)
    .split(`oauth_callback=${encodeURIComponent(rawProxy).toLowerCase()}`).join(`oauth_callback=${encodeURIComponent(rawUpstream)}`)
    .split(`redirect_uri=${rawProxy}`).join(`redirect_uri=${rawUpstream}`)
    .split(`oauth_callback=${rawProxy}`).join(`oauth_callback=${rawUpstream}`);
}

function isExternalOAuthAuthorizationUrl(value) {
  const source = String(value || "");
  return /https?:\/\/[^"'\\\s]*(accounts\.google\.com|oauth|authorize)[^"'\\\s]*[?&](redirect_uri|oauth_callback)=/i.test(source);
}

function wrapEditorTokenInOAuthState(value, token) {
  const rawToken = cleanString(token);
  const source = String(value || "");
  if (!rawToken || !source || !/state=/i.test(source) || !/(oauth|redirect_uri|oauth_callback)/i.test(source)) {
    return source;
  }

  return source.replace(/([?&]state=)([^&"'\\\s]+)/gi, (_match, prefix, encodedState) => {
    const currentState = decodeParam(encodedState);
    if (!currentState || decodeEditorState(currentState).token) {
      return `${prefix}${encodedState}`;
    }
    return `${prefix}${encodeURIComponent(encodeEditorState(rawToken, currentState))}`;
  });
}

function encodeEditorState(token, originalState) {
  const payload = JSON.stringify({
    t: token,
    s: originalState || "",
  });
  return `nexus_editor:${base64UrlEncode(payload)}`;
}

function decodeEditorState(value) {
  const raw = cleanString(value);
  if (!raw || !raw.startsWith("nexus_editor:")) {
    return { token: "", originalState: "" };
  }

  try {
    const json = base64UrlDecode(raw.slice("nexus_editor:".length));
    const parsed = JSON.parse(json);
    return {
      token: cleanString(parsed?.t),
      originalState: cleanString(parsed?.s),
    };
  } catch (_error) {
    return { token: "", originalState: "" };
  }
}

function decodeParam(value) {
  try {
    return decodeURIComponent(String(value || "").replace(/\+/g, "%20"));
  } catch (_error) {
    return String(value || "");
  }
}

function base64UrlEncode(value) {
  return btoa(unescape(encodeURIComponent(value)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return decodeURIComponent(escape(atob(padded)));
}

function replaceUrlVariants(value, from, to) {
  const source = String(value || "");
  const rawFrom = cleanString(from);
  const rawTo = cleanString(to);
  if (!rawFrom || !rawTo) return source;

  const encodedFrom = encodeURIComponent(rawFrom);
  const encodedTo = encodeURIComponent(rawTo);
  return source
    .split(rawFrom).join(rawTo)
    .split(encodedFrom).join(encodedTo)
    .split(encodedFrom.toLowerCase()).join(encodedTo);
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

function oauthCallbackCompleteResponse(result, request, env) {
  const ok = Boolean(result?.ok);
  const message = ok
    ? "Credential connected. You can close this window."
    : `Credential connection failed (${result?.status || "unknown"}).`;
  const error = ok ? "" : String(result?.error || "n8n rejected the credential callback.").slice(0, 700);
  const payload = safeScriptJson({
    source: "nexus-n8n-editor",
    type: "nexus:n8n-oauth-complete",
    ok,
    error,
  });
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${ok ? "Credential connected" : "Credential connection failed"}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: Inter, Arial, sans-serif; background: #eef7ff; color: #082041; }
    main { width: min(520px, calc(100vw - 32px)); padding: 28px; border: 1px solid #cfe4ff; border-radius: 20px; background: #fff; box-shadow: 0 18px 50px rgba(8, 32, 65, .12); }
    h1 { margin: 0 0 10px; font-size: 26px; line-height: 1.15; }
    p { margin: 0 0 18px; color: #61718b; line-height: 1.5; }
    pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 14px; border-radius: 12px; background: #fff1f1; color: #991b1b; }
    button { border: 0; border-radius: 999px; padding: 12px 18px; color: #fff; background: linear-gradient(135deg, #2563ff, #11b5ef); font-weight: 800; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <h1>${ok ? "Credential connected" : "Credential connection failed"}</h1>
    <p>${htmlEscape(message)} ${ok ? "The Nexus editor will refresh automatically." : "Return to Nexus and try again."}</p>
    ${error ? `<pre>${htmlEscape(error)}</pre>` : ""}
    <button type="button" onclick="window.close()">Close window</button>
  </main>
  <script>
    const payload = ${payload};
    function notifyEditor() {
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(payload, "*");
        }
      } catch (_error) {}
      try {
        if (window.opener && !window.opener.closed && window.opener.parent) {
          window.opener.parent.postMessage(payload, "*");
        }
      } catch (_error) {}
      if (payload.ok) {
        setTimeout(() => {
          try { window.close(); } catch (_error) {}
        }, 900);
      }
    }
    notifyEditor();
  </script>
</body>
</html>`;
  const headers = new Headers({
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  addCorsHeaders(headers, request, env);
  return new Response(html, { status: ok ? 200 : 502, headers });
}

function redirectResponse(location, token, request, env, session) {
  const safeLocation = tokenizedRedirectLocation(location, token, request);
  const headers = new Headers({
    Location: safeLocation,
    "Cache-Control": "no-store",
    "Content-Security-Policy": frameAncestorsPolicy(env),
  });
  addCorsHeaders(headers, request, env);
  const response = new Response(null, { status: 302, headers });
  return withEditorCookie(response, token, true, session, env, request);
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

function withEditorCookie(response, token, shouldSet, session, env, request) {
  if (!shouldSet) return response;
  const headers = new Headers(response.headers);
  headers.append(
    "Set-Cookie",
    `${EDITOR_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=3600`,
  );
  appendMirroredN8nCookies(headers, session?.n8n_cookie, request, env);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function appendMirroredN8nCookies(headers, cookieHeader, request, env) {
  const cookie = cleanString(cookieHeader);
  if (!cookie || !request || !env?.N8N_BASE_URL) return;

  let proxyHost = "";
  let n8nHost = "";
  try {
    proxyHost = new URL(request.url).hostname.toLowerCase();
    n8nHost = new URL(env.N8N_BASE_URL).hostname.toLowerCase();
  } catch (_error) {
    return;
  }

  const domain = sharedCookieDomain(proxyHost, n8nHost);
  if (!domain) return;

  cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => /^[^=\s]+=[\s\S]*$/.test(part))
    .forEach((pair) => {
      headers.append(
        "Set-Cookie",
        `${pair}; Domain=${domain}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=3600`,
      );
    });
}

function sharedCookieDomain(hostA, hostB) {
  const a = cleanString(hostA).toLowerCase().split(".").filter(Boolean);
  const b = cleanString(hostB).toLowerCase().split(".").filter(Boolean);
  if (a.length < 2 || b.length < 2) return "";

  const suffix = [];
  while (a.length && b.length && a[a.length - 1] === b[b.length - 1]) {
    suffix.unshift(a.pop());
    b.pop();
  }

  if (suffix.length < 2) return "";
  const domain = `.${suffix.join(".")}`;
  return hostA.endsWith(domain.slice(1)) && hostB.endsWith(domain.slice(1)) ? domain : "";
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

function safeScriptJson(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
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
