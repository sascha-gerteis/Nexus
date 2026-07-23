import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

type SessionRow = {
  id: string;
  automation_id: string;
  n8n_workflow_id: string;
  profile_id: string | null;
  developer_id: string | null;
  role: "admin" | "developer";
  encrypted_n8n_cookie: Record<string, unknown> | null;
  expires_at: string;
  revoked_at: string | null;
  status: string;
};

function env(name: string) {
  return Deno.env.get(name) || "";
}

function cleanString(value: unknown) {
  return String(value ?? "").trim();
}

function cleanBaseUrl(url: string) {
  return cleanString(url).replace(/\/+$/, "");
}

function isUuid(value: unknown) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    cleanString(value),
  );
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function sha256Hex(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(hash));
}

async function aesKey() {
  const secret = env("N8N_EDITOR_SESSION_SECRET") || env("NEXUS_CREDENTIAL_SECRET");
  if (!secret || secret.length < 16) {
    throw new Error("Missing N8N_EDITOR_SESSION_SECRET. Add a long random secret before enabling the embedded editor.");
  }

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return await crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptText(value: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey();
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(value),
  );

  return {
    alg: "AES-GCM",
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(encrypted)),
  };
}

async function decryptText(payload: Record<string, unknown> | null | undefined) {
  if (!payload || typeof payload !== "object") return "";

  const iv = cleanString(payload.iv);
  const data = cleanString(payload.data);

  if (!iv || !data) return "";

  const key = await aesKey();
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(iv) },
    key,
    base64ToBytes(data),
  );

  return new TextDecoder().decode(decrypted);
}

function splitSetCookie(value: string) {
  return value
    .split(/,(?=\s*[^;,]+=)/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function cookieHeaderFromSetCookie(value: string) {
  return splitSetCookie(value)
    .map((cookie) => cookie.split(";")[0]?.trim())
    .filter(Boolean)
    .join("; ");
}

async function loginToN8n() {
  const explicitCookie = cleanString(env("N8N_EDITOR_COOKIE"));
  if (explicitCookie) return explicitCookie;

  const baseUrl = cleanBaseUrl(env("N8N_BASE_URL"));
  const email = cleanString(env("N8N_EDITOR_EMAIL"));
  const password = cleanString(env("N8N_EDITOR_PASSWORD"));

  if (!baseUrl || !email || !password) {
    throw new Error("Missing N8N_BASE_URL, N8N_EDITOR_EMAIL, or N8N_EDITOR_PASSWORD.");
  }

  let response = await fetch(`${baseUrl}/rest/login`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ emailOrLdapLoginId: email, password }),
  });

  let text = await response.text().catch(() => "");

  if (!response.ok && /email/i.test(text) && /emailOrLdapLoginId/i.test(text)) {
    response = await fetch(`${baseUrl}/rest/login`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    });
    text = await response.text().catch(() => "");
  }

  const setCookie = response.headers.get("set-cookie") || response.headers.get("Set-Cookie") || "";
  const cookie = cookieHeaderFromSetCookie(setCookie);

  if (!response.ok || !cookie) {
    throw new Error(
      `n8n editor login failed (${response.status}). ${
        text ? text.slice(0, 240) : "Check N8N_EDITOR_EMAIL and N8N_EDITOR_PASSWORD."
      }`,
    );
  }

  return cookie;
}

async function n8nApi(path: string, options: RequestInit = {}) {
  const baseUrl = cleanBaseUrl(env("N8N_BASE_URL"));
  const apiKey = cleanString(env("N8N_API_KEY"));

  if (!baseUrl || !apiKey) {
    throw new Error("Missing N8N_BASE_URL or N8N_API_KEY.");
  }

  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-N8N-API-KEY": apiKey,
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data: any = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(data?.message || data?.error || data?.raw || `n8n API failed (${response.status}).`);
  }

  return data;
}

function functionBaseUrl(req: Request) {
  const explicitUrl = cleanBaseUrl(
    env("N8N_EDITOR_GATEWAY_URL") ||
      `${cleanBaseUrl(env("SUPABASE_URL"))}/functions/v1/n8n-editor-gateway`,
  );

  if (explicitUrl && explicitUrl.includes("/functions/v1/n8n-editor-gateway")) {
    return explicitUrl;
  }

  const url = new URL(req.url);
  const marker = "/n8n-editor-gateway";
  const index = url.pathname.indexOf(marker);
  const path = index >= 0 ? url.pathname.slice(0, index + marker.length) : url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

function editorProxyBaseUrl(req: Request) {
  return cleanBaseUrl(env("N8N_EDITOR_PROXY_URL")) || functionBaseUrl(req);
}

function editorProxyUrl(base: string, token: string, targetPath = "/", cacheKey = "") {
  const safeBase = cleanBaseUrl(base);
  const normalizedPath = `/${cleanString(targetPath || "/").replace(/^\/+/, "")}`;

  if (!safeBase.includes("/functions/v1/n8n-editor-gateway")) {
    const url = new URL(`${safeBase}${normalizedPath}`);
    url.searchParams.set("editor_token", token);
    if (cacheKey) url.searchParams.set("editor_v", cacheKey);
    return url.toString();
  }

  const url = new URL(base);
  url.searchParams.set("editor_token", token);
  url.searchParams.set("n8n_path", normalizedPath);
  if (cacheKey) url.searchParams.set("editor_v", cacheKey);
  return url.toString();
}

function allowedEditorOrigin(origin: string) {
  const appOrigin = cleanString(env("NEXUS_APP_ORIGIN")).replace(/\/+$/, "");
  return [
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "https://nexus-ai.software",
    appOrigin,
  ].filter(Boolean).includes(origin.replace(/\/+$/, ""));
}

function editorCorsHeaders(req?: Request) {
  const origin = cleanString(req?.headers.get("origin"));
  const allowedOrigin = origin && allowedEditorOrigin(origin) ? origin : "https://nexus-ai.software";
  const requestedHeaders = cleanString(req?.headers.get("access-control-request-headers"));

  return {
    ...corsHeaders,
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Headers": requestedHeaders ||
      "authorization, x-client-info, apikey, content-type, stripe-signature, x-nexus-runtime-secret, browser-id, n8n-browser-id",
    "Access-Control-Max-Age": "0",
    "Vary": "Origin, Access-Control-Request-Headers",
  };
}

async function requireOperator(req: Request, supabaseUrl: string, anonKey: string, adminClient: any) {
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return { user: null, profile: null, developer: null, error: "Login required." };
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  });

  const { data: userData, error: userError } = await userClient.auth.getUser(authHeader.replace("Bearer ", ""));

  if (userError || !userData?.user) {
    return { user: null, profile: null, developer: null, error: "Invalid auth token." };
  }

  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("id, role")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (profileError || !profile || !["admin", "developer"].includes(profile.role)) {
    return { user: userData.user, profile: null, developer: null, error: "Admin or developer access required." };
  }

  let developer = null;
  if (profile.role === "developer") {
    const { data: developerRow, error: developerError } = await adminClient
      .from("developers")
      .select("id, profile_id, status")
      .eq("profile_id", userData.user.id)
      .maybeSingle();

    if (developerError || !developerRow) {
      return { user: userData.user, profile, developer: null, error: "Developer account not found." };
    }

    developer = developerRow;
  }

  return { user: userData.user, profile, developer, error: null };
}

function canAccessAutomation(profile: any, developer: any, product: any) {
  if (profile?.role === "admin") return true;
  return Boolean(developer?.id && product?.developer_id === developer.id);
}

async function loadAutomationForOperator(adminClient: any, automationId: string, profile: any, developer: any) {
  if (!isUuid(automationId)) {
    throw new Error("automation_id must be a valid product id.");
  }

  const { data: product, error } = await adminClient
    .from("automations")
    .select("id, title, status, developer_id, n8n_workflow_id, n8n_workflow_name, n8n_import_status")
    .eq("id", automationId)
    .maybeSingle();

  if (error || !product) {
    throw new Error(error?.message || "Automation product not found.");
  }

  if (!canAccessAutomation(profile, developer, product)) {
    throw new Error("You can only edit workflows attached to your own products.");
  }

  if (!cleanString(product.n8n_workflow_id)) {
    throw new Error("Import the workflow before opening the editor.");
  }

  return product;
}

function sessionExpired(session: SessionRow) {
  return new Date(session.expires_at).getTime() <= Date.now();
}

async function loadSession(adminClient: any, token: string) {
  const tokenHash = await sha256Hex(token);
  const { data, error } = await adminClient
    .from("n8n_editor_sessions")
    .select("*")
    .eq("token_hash", tokenHash)
    .maybeSingle();

  if (error || !data) {
    throw new Error("Editor session not found.");
  }

  const session = data as SessionRow;

  if (session.revoked_at || session.status !== "active" || sessionExpired(session)) {
    await adminClient
      .from("n8n_editor_sessions")
      .update({
        status: "expired",
        updated_at: new Date().toISOString(),
      })
      .eq("id", session.id);
    throw new Error("Editor session expired. Reopen the workflow editor from Nexus.");
  }

  return session;
}

async function createEditorSession(req: Request, body: any) {
  const supabaseUrl = cleanBaseUrl(env("SUPABASE_URL"));
  const anonKey = cleanString(env("SUPABASE_ANON_KEY"));
  const serviceRoleKey = cleanString(env("SUPABASE_SERVICE_ROLE_KEY"));

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return errorResponse("Missing Supabase function secrets.", 500);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  const { user, profile, developer, error } = await requireOperator(req, supabaseUrl, anonKey, adminClient);

  if (error) return errorResponse(error, 403);

  try {
    const product = await loadAutomationForOperator(adminClient, cleanString(body.automation_id), profile, developer);
    const cookie = await loginToN8n();
    const token = `${crypto.randomUUID()}-${crypto.randomUUID()}-${crypto.randomUUID()}`;
    const tokenHash = await sha256Hex(token);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const encryptedCookie = await encryptText(cookie);

    const { data: session, error: sessionError } = await adminClient
      .from("n8n_editor_sessions")
      .insert({
        token_hash: tokenHash,
        automation_id: product.id,
        n8n_workflow_id: product.n8n_workflow_id,
        profile_id: user.id,
        developer_id: developer?.id || null,
        role: profile.role,
        encrypted_n8n_cookie: encryptedCookie,
        expires_at: expiresAt,
        last_seen_at: new Date().toISOString(),
      })
      .select("id, expires_at")
      .single();

    if (sessionError) {
      return errorResponse(
        `${sessionError.message} Run supabase/n8n_editor_gateway_install_or_patch.sql in the Supabase SQL editor, then redeploy n8n-editor-gateway.`,
        500,
      );
    }

    const base = editorProxyBaseUrl(req);
    const workflowId = encodeURIComponent(product.n8n_workflow_id);
    const editorCacheKey = `${session.id}-${Date.now()}`;
    const editorUrl = editorProxyUrl(base, token, `/workflow/${workflowId}`, editorCacheKey);

    return jsonResponse({
      ok: true,
      session_id: session.id,
      editor_cache_key: editorCacheKey,
      automation_id: product.id,
      workflow_id: product.n8n_workflow_id,
      workflow_name: product.n8n_workflow_name || product.title || product.n8n_workflow_id,
      editor_url: editorUrl,
      expires_at: session.expires_at,
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Could not create editor session.", 403);
  }
}

async function markWorkflowEdited(adminClient: any, session: SessionRow, extra: Record<string, unknown> = {}) {
  await adminClient
    .from("automations")
    .update({
      n8n_last_test_status: "not_tested",
      n8n_last_test_error: null,
      n8n_last_test_result: null,
      n8n_last_tested_at: null,
      health_status: "needs_recheck",
      health_failure_reason: "Workflow was edited in the embedded n8n editor. Run a fresh technical check before publishing.",
      health_failure_details: {
        edited_in_embedded_editor: true,
        workflow_id: session.n8n_workflow_id,
        at: new Date().toISOString(),
      },
      health_next_check_at: null,
      n8n_last_synced_at: new Date().toISOString(),
      n8n_last_import_result: {
        edited_in_embedded_editor: true,
        edited_at: new Date().toISOString(),
        workflow_id: session.n8n_workflow_id,
        ...extra,
      },
    })
    .eq("id", session.automation_id);
}

async function syncWorkflow(req: Request, body: any) {
  const supabaseUrl = cleanBaseUrl(env("SUPABASE_URL"));
  const anonKey = cleanString(env("SUPABASE_ANON_KEY"));
  const serviceRoleKey = cleanString(env("SUPABASE_SERVICE_ROLE_KEY"));

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return errorResponse("Missing Supabase function secrets.", 500);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  const { profile, developer, error } = await requireOperator(req, supabaseUrl, anonKey, adminClient);

  if (error) return errorResponse(error, 403);

  try {
    const product = await loadAutomationForOperator(adminClient, cleanString(body.automation_id), profile, developer);
    const workflow = await n8nApi(`/api/v1/workflows/${encodeURIComponent(product.n8n_workflow_id)}`);

    const updatePayload = {
      n8n_workflow_json: workflow,
      n8n_normalized_workflow_json: workflow,
      n8n_workflow_name: cleanString(workflow?.name) || product.n8n_workflow_name || product.title,
      n8n_import_status: "imported",
      n8n_import_error: null,
      n8n_last_synced_at: new Date().toISOString(),
      n8n_last_test_status: "not_tested",
      n8n_last_test_error: null,
      n8n_last_test_result: null,
      n8n_last_tested_at: null,
      health_status: "needs_recheck",
      health_failure_reason: "Workflow was synced from the embedded n8n editor. Run a fresh technical check before publishing.",
      health_failure_details: {
        synced_from_embedded_editor: true,
        workflow_id: product.n8n_workflow_id,
        at: new Date().toISOString(),
      },
      health_next_check_at: null,
      n8n_last_import_result: {
        workflow_id: product.n8n_workflow_id,
        synced_from_embedded_editor: true,
        synced_at: new Date().toISOString(),
      },
    };

    const { data: updated, error: updateError } = await adminClient
      .from("automations")
      .update(updatePayload)
      .eq("id", product.id)
      .select("id, title, n8n_workflow_id, n8n_workflow_name, n8n_last_test_status, n8n_last_synced_at")
      .single();

    if (updateError) throw new Error(updateError.message);

    return jsonResponse({
      ok: true,
      product: updated,
      message: "Workflow synced from n8n. Run a fresh technical check before submitting or approving.",
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Could not sync workflow.", 500);
  }
}

async function revokeSession(req: Request, body: any) {
  const supabaseUrl = cleanBaseUrl(env("SUPABASE_URL"));
  const anonKey = cleanString(env("SUPABASE_ANON_KEY"));
  const serviceRoleKey = cleanString(env("SUPABASE_SERVICE_ROLE_KEY"));

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return errorResponse("Missing Supabase function secrets.", 500);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  const { user, error } = await requireOperator(req, supabaseUrl, anonKey, adminClient);

  if (error) return errorResponse(error, 403);

  const sessionId = cleanString(body.session_id);
  if (!isUuid(sessionId)) return jsonResponse({ ok: true });

  await adminClient
    .from("n8n_editor_sessions")
    .update({
      status: "revoked",
      revoked_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", sessionId)
    .eq("profile_id", user.id);

  return jsonResponse({ ok: true });
}

function isHtmlRequest(req: Request, response: Response, targetPath: string) {
  const contentType = response.headers.get("content-type") || "";
  const accept = req.headers.get("accept") || "";
  if (apiLikePath(targetPath) && !accept.includes("text/html")) return false;
  return (
    contentType.includes("text/html") ||
    accept.includes("text/html") ||
    /^\/workflow\//.test(targetPath) ||
    targetPath === "/"
  );
}

function apiLikePath(path: string) {
  return /^\/(rest|api|types|healthz)(\/|$)/i.test(path);
}

function forbiddenPath(path: string) {
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
    "/rest/executions",
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

function staticAssetPath(path: string) {
  return (
    /^\/(assets|static|icons|fonts|js|css|browser|vendor)\//i.test(path) ||
    /^\/favicon/i.test(path) ||
    /\.(js|mjs|css|png|jpg|jpeg|gif|svg|ico|webp|woff|woff2|ttf|map)$/i.test(path)
  );
}

function contentTypeForPath(path: string) {
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

function textAssetPath(path: string) {
  const safe = path.toLowerCase().split("?")[0] || "";
  return /\.(js|mjs|css|json|map|svg)$/i.test(safe);
}

function allowedWorkflowRestPath(path: string, workflowId: string) {
  const encoded = encodeURIComponent(workflowId);
  const safe = path.replace(/\/+$/, "");
  const workflowPatterns = [
    `/rest/workflows/${workflowId}`,
    `/rest/workflows/${encoded}`,
    `/rest/workflows/${workflowId}/`,
    `/rest/workflows/${encoded}/`,
  ];
  return workflowPatterns.some((pattern) => safe === pattern.replace(/\/+$/, "") || path.startsWith(pattern));
}

function allowedReadOnlyRestPath(path: string, method: string) {
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
  ].some((allowed) => safe === allowed || safe.startsWith(allowed));
}

function allowedProxyPath(path: string, method: string, workflowId: string) {
  if (path === "/" || path === "") return true;
  if (staticAssetPath(path)) return true;
  if (path === `/workflow/${workflowId}` || path === `/workflow/${encodeURIComponent(workflowId)}`) return true;
  if (path.startsWith(`/workflow/${workflowId}/`) || path.startsWith(`/workflow/${encodeURIComponent(workflowId)}/`)) return true;
  if (allowedWorkflowRestPath(path, workflowId)) return ["GET", "HEAD", "POST", "PATCH", "PUT"].includes(method);
  if (allowedReadOnlyRestPath(path, method)) return true;
  if (forbiddenPath(path)) return false;
  return false;
}

function sameWorkflowPath(path: string, workflowId: string) {
  return path === `/workflow/${workflowId}` || path === `/workflow/${encodeURIComponent(workflowId)}`;
}

function editorCss() {
  return `
    <style id="nexus-locked-n8n-css">
      [data-test-id="main-sidebar"],
      [data-test-id="sidebar"],
      [data-test-id="main-menu"],
      [data-test-id="workflow-switcher"],
      [data-test-id="project-switcher"],
      .main-sidebar,
      .sidebar-container,
      .n8n-sidebar,
      .n8n-main-sidebar,
      .workflow-switcher,
      .project-switcher,
      nav[aria-label*="main" i],
      nav[aria-label*="navigation" i],
      a[href="/workflows"],
      a[href^="/workflows"],
      a[href^="/credentials"],
      a[href^="/executions"],
      a[href^="/settings"],
      a[href^="/projects"],
      a[href^="/variables"],
      a[href^="/users"],
      [href="/workflows"],
      [href^="/credentials"],
      [href^="/executions"],
      [href^="/settings"],
      [href^="/projects"],
      [href^="/variables"],
      [href^="/users"] {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }

      body {
        overflow: hidden !important;
      }

      [class*="sidebar"] [href],
      [class*="Sidebar"] [href],
      [class*="mainMenu"] [href],
      [class*="MainMenu"] [href] {
        pointer-events: none !important;
      }
    </style>
  `;
}

function editorGuardScript(gatewayBase: string, token: string, workflowId: string) {
  const safeBase = JSON.stringify(gatewayBase);
  const safeToken = JSON.stringify(token);
  const safeWorkflow = JSON.stringify(workflowId);
  return `
    <script id="nexus-locked-n8n-guard">
      (() => {
        const gatewayBase = ${safeBase};
        const editorToken = ${safeToken};
        const workflowId = ${safeWorkflow};
        const allowedWorkflowPath = "/workflow/" + encodeURIComponent(workflowId);
        const forbidden = /\\/(workflows|credentials|executions|execution|settings|projects|project|variables|users|admin)(\\/|$)/i;

        function proxyPath(pathWithSearch) {
          const next = new URL(gatewayBase);
          next.searchParams.set("editor_token", editorToken);
          next.searchParams.set("n8n_path", pathWithSearch || allowedWorkflowPath);
          return next.toString();
        }

        function pathFromValue(value) {
          if (!value || typeof value !== "string") return "";
          if (value.startsWith(gatewayBase) && value.includes("editor_token=")) return value;
          if (value.startsWith(gatewayBase)) {
            try {
              const gatewayUrl = new URL(value);
              return gatewayUrl.searchParams.get("n8n_path") || "/";
            } catch {}
            return "/";
          }
          if (/^(assets|static|icons|fonts|js|css|browser|vendor)\\//i.test(value)) return "/" + value;
          if (/^(rest|api|types|webhook)\\//i.test(value)) return "/" + value;
          if (value.startsWith("/")) return value;

          try {
            const url = new URL(value, location.href);
            if (!["http:", "https:"].includes(url.protocol)) return value;
            if (url.searchParams.has("editor_token")) return value;
            return url.pathname + url.search + url.hash;
          } catch {}

          return value;
        }

        function proxied(value) {
          if (!value || typeof value !== "string") return value;
          if (value.startsWith(gatewayBase) && value.includes("editor_token=")) return value;
          const path = pathFromValue(value);
          if (!path) return value;
          return proxyPath(path);
        }

        function rewriteElementUrl(element) {
          if (!element || !element.tagName || !element.getAttribute) return element;
          ["src", "href", "action"].forEach((attr) => {
            const raw = element.getAttribute(attr);
            const value = raw || element[attr];
            if (!value || typeof value !== "string") return;
            const next = proxied(value);
            if (next && next !== value) {
              try { element.setAttribute(attr, next); } catch {}
            }
          });
          return element;
        }

        function lockNavigation(value) {
          const raw = String(value || "");
          if (!raw) return allowedWorkflowPath;
          try {
            const path = pathFromValue(raw);
            const url = new URL(path, "https://nexus.local");
            if (url.pathname === allowedWorkflowPath || url.pathname.startsWith(allowedWorkflowPath + "/")) {
              return url.pathname + url.search + url.hash;
            }
            if (forbidden.test(url.pathname) || /^\\/workflow\\//.test(url.pathname)) {
              return allowedWorkflowPath;
            }
          } catch {}
          return allowedWorkflowPath;
        }

        const nativeFetch = window.fetch.bind(window);
        window.fetch = (input, init) => {
          if (typeof input === "string") return nativeFetch(proxied(input), init);
          if (input && input.url) return nativeFetch(new Request(proxied(input.url), input), init);
          return nativeFetch(input, init);
        };

        const nativeSetAttribute = Element.prototype.setAttribute;
        Element.prototype.setAttribute = function(name, value) {
          if (/^(src|href|action)$/i.test(String(name || ""))) {
            return nativeSetAttribute.call(this, name, proxied(String(value || "")));
          }
          return nativeSetAttribute.call(this, name, value);
        };

        const nativeAppendChild = Node.prototype.appendChild;
        Node.prototype.appendChild = function(child) {
          return nativeAppendChild.call(this, rewriteElementUrl(child));
        };

        const nativeInsertBefore = Node.prototype.insertBefore;
        Node.prototype.insertBefore = function(child, reference) {
          return nativeInsertBefore.call(this, rewriteElementUrl(child), reference);
        };

        const nativeOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          return nativeOpen.call(this, method, proxied(String(url || "")), ...rest);
        };

        if (window.EventSource) {
          const NativeEventSource = window.EventSource;
          window.EventSource = function(url, options) {
            return new NativeEventSource(proxied(String(url || "")), options);
          };
        }

        const nativePushState = history.pushState.bind(history);
        const nativeReplaceState = history.replaceState.bind(history);
        history.pushState = (state, title, url) => nativePushState(state, title, lockNavigation(url || allowedWorkflowPath));
        history.replaceState = (state, title, url) => nativeReplaceState(state, title, lockNavigation(url || allowedWorkflowPath));

        try {
          if (location.protocol !== "about:" && location.pathname !== allowedWorkflowPath) {
            nativeReplaceState(history.state || null, document.title || "", allowedWorkflowPath);
          }
        } catch {}

        function cleanup() {
          document.querySelectorAll('a[href], button, [role="menuitem"], [data-test-id]').forEach((el) => {
            const href = el.getAttribute && el.getAttribute("href");
            const testId = (el.getAttribute && el.getAttribute("data-test-id")) || "";
            const label = [href, testId, el.textContent || ""].join(" ");
            if (forbidden.test(label) || /workflow list|credentials|executions|settings|projects|variables|users/i.test(label)) {
              el.style.display = "none";
              el.style.pointerEvents = "none";
              el.setAttribute("aria-hidden", "true");
              if (href) el.removeAttribute("href");
            }
          });

          const params = new URLSearchParams(location.search);
          const path = params.get("n8n_path") || allowedWorkflowPath;
          if ((forbidden.test(path) || /^\\/workflow\\//.test(path)) && path !== allowedWorkflowPath) {
            location.replace(proxyPath(allowedWorkflowPath));
          }
        }

        document.addEventListener("click", (event) => {
          const link = event.target && event.target.closest && event.target.closest("a[href]");
          if (!link) return;
          const href = link.getAttribute("href") || "";
          if (forbidden.test(href) || (/^\\/workflow\\//.test(href) && href !== allowedWorkflowPath)) {
            event.preventDefault();
            event.stopPropagation();
            location.href = proxyPath(allowedWorkflowPath);
          }
        }, true);

        cleanup();
        setInterval(cleanup, 700);
      })();
    </script>
  `;
}

function normalizeProxyAssetPath(currentPath: string, relativePath: string) {
  const safeCurrentPath = cleanString(currentPath) || "/";
  const baseDir = safeCurrentPath.replace(/\/[^/]*$/, "/") || "/";
  return new URL(relativePath, `https://nexus.local${baseDir}`).pathname;
}

function rewriteAssetUrls(text: string, gatewayBase: string, token: string, currentPath = "/") {
  const editorCacheKey = token.slice(0, 12);
  const assetsBase = editorProxyUrl(gatewayBase, token, "/assets/", editorCacheKey);
  const rootProxyBase = editorProxyUrl(gatewayBase, token, "/", editorCacheKey);
  return text
    .replace(/return(["'`])\/\1\s*\+/g, (_match, quote) => {
      return `return${quote}${rootProxyBase}${quote}+`;
    })
    .replace(/=>\s*(["'`])\/\1\s*\+/g, (_match, quote) => {
      return `=>${quote}${rootProxyBase}${quote}+`;
    })
    .replace(/(["'`])\/assets\/\1/gi, (_match, quote) => {
      return `${quote}${assetsBase}${quote}`;
    })
    .replace(/(["'`])assets\/\1/gi, (_match, quote) => {
      return `${quote}${assetsBase}${quote}`;
    })
    .replace(/(["'`])(\/(?:assets|static|icons|fonts|js|css|browser|vendor|favicon)[^"'`]*)\1/gi, (_match, quote, path) => {
      return `${quote}${editorProxyUrl(gatewayBase, token, path, editorCacheKey)}${quote}`;
    })
    .replace(/(["'`])([^"'`]*?\/assets\/)([^"'`]*?\.(?:js|mjs|css|json|png|jpg|jpeg|svg|webp|woff|woff2|ttf|map))\1/gi, (_match, quote, _basePath, filePath) => {
      return `${quote}${editorProxyUrl(gatewayBase, token, `/assets/${filePath}`, editorCacheKey)}${quote}`;
    })
    .replace(/(["'`])\.\/([^"'`]+\.(?:js|mjs|css|json|png|jpg|jpeg|svg|webp|woff|woff2|ttf|map))\1/gi, (_match, quote, path) => {
      return `${quote}${editorProxyUrl(gatewayBase, token, normalizeProxyAssetPath(currentPath, `./${path}`), editorCacheKey)}${quote}`;
    })
    .replace(/(["'`])\.\.\/([^"'`]+\.(?:js|mjs|css|json|png|jpg|jpeg|svg|webp|woff|woff2|ttf|map))\1/gi, (_match, quote, path) => {
      return `${quote}${editorProxyUrl(gatewayBase, token, normalizeProxyAssetPath(currentPath, `../${path}`), editorCacheKey)}${quote}`;
    })
    .replace(/\b(src|href|action)=["']\/(?!\/)([^"']*)["']/gi, (_match, attr, path) => {
      return `${attr}="${editorProxyUrl(gatewayBase, token, `/${path}`, editorCacheKey)}"`;
    })
    .replace(/\b(src|href)=["']((?:assets|static|icons|fonts|js|css|browser|vendor)\/[^"']*)["']/gi, (_match, attr, path) => {
      return `${attr}="${editorProxyUrl(gatewayBase, token, `/${path}`, editorCacheKey)}"`;
    })
    .replace(/url\(["']?\/(assets|static|icons|fonts|js|css|browser|vendor|favicon)([^)"']*)["']?\)/gi, (_match, first, rest) => {
      return `url("${editorProxyUrl(gatewayBase, token, `/${first}${rest}`, editorCacheKey)}")`;
    })
    .replace(/url\(["']?\.\/([^)"']+\.(?:png|jpg|jpeg|svg|webp|woff|woff2|ttf|css))["']?\)/gi, (_match, path) => {
      return `url("${editorProxyUrl(gatewayBase, token, normalizeProxyAssetPath(currentPath, `./${path}`), editorCacheKey)}")`;
    })
    .replace(/url\(["']?\.\.\/([^)"']+\.(?:png|jpg|jpeg|svg|webp|woff|woff2|ttf|css))["']?\)/gi, (_match, path) => {
      return `url("${editorProxyUrl(gatewayBase, token, normalizeProxyAssetPath(currentPath, `../${path}`), editorCacheKey)}")`;
    });
}

function rewriteHtml(html: string, gatewayBase: string, token: string, workflowId: string, currentPath = "/") {
  let rewritten = rewriteAssetUrls(html, gatewayBase, token, currentPath);
  const injection = `\n${editorCss()}\n${editorGuardScript(gatewayBase, token, workflowId)}\n`;

  rewritten = rewritten.replace(/(<head[^>]*>)/i, `$1${injection}`);

  if (!/<head[^>]*>/i.test(rewritten)) {
    rewritten = `${injection}${rewritten}`;
  }

  return rewritten;
}

function responseHeaders(upstream: Response, req?: Request, contentType = "") {
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    const safeKey = key.toLowerCase();
    if (
      [
        "set-cookie",
        "x-frame-options",
        "content-security-policy",
        "content-length",
        "content-type",
        "content-encoding",
        "content-disposition",
        "origin-agent-cluster",
        "cross-origin-opener-policy",
        "cross-origin-embedder-policy",
        "cross-origin-resource-policy",
      ].includes(safeKey)
    ) return;
    headers.set(key, value);
  });

  Object.entries(editorCorsHeaders(req)).forEach(([key, value]) => {
    headers.set(key, value);
  });

  if (contentType) headers.set("Content-Type", contentType);
  headers.set("Cache-Control", "no-store");
  headers.set("Content-Security-Policy", frameAncestorsPolicy());
  headers.set("Referrer-Policy", "no-referrer");
  return headers;
}

function lockedEditorHeaders(req?: Request, contentType = "text/html; charset=utf-8") {
  return {
    ...editorCorsHeaders(req),
    "content-type": contentType,
    "cache-control": "no-store",
    "content-security-policy": frameAncestorsPolicy(),
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}

function editorJsonResponse(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: lockedEditorHeaders(req, "application/json; charset=utf-8"),
  });
}

function editorRedirect(req: Request, location: string, status = 302) {
  return new Response(null, {
    status,
    headers: {
      ...lockedEditorHeaders(req, "text/plain; charset=utf-8"),
      Location: location,
    },
  });
}

function startupStubResponse(req: Request, targetPath: string) {
  const method = req.method.toUpperCase();
  const path = targetPath.toLowerCase().replace(/\/+$/, "") || "/";

  if (path === "/healthz") {
    return editorJsonResponse(req, { status: "ok" });
  }

  if (path === "/rest/events/session-started") {
    return editorJsonResponse(req, { ok: true });
  }

  if (method !== "GET" && method !== "HEAD") return null;

  if (path === "/rest/node-creator") {
    return editorJsonResponse(req, {
      data: {
        categories: [],
        nodes: [],
        actions: [],
        triggers: [],
      },
    });
  }

  if (path === "/rest/workflows" || path === "/rest/workflows/filter") {
    return editorJsonResponse(req, { data: [], count: 0 });
  }

  if (path.startsWith("/rest/projects")) {
    if (path.endsWith("/count")) return editorJsonResponse(req, { data: { count: 0 }, count: 0 });
    if (path.endsWith("/personal")) {
      return editorJsonResponse(req, {
        data: {
          id: "nexus-locked-project",
          name: "Nexus locked editor",
          type: "personal",
          role: "project:personalOwner",
          scopes: [],
        },
      });
    }
    return editorJsonResponse(req, { data: [], count: 0 });
  }

  if (path.startsWith("/rest/users")) {
    if (path.endsWith("/me") || path.endsWith("/current")) {
      return editorJsonResponse(req, {
        data: {
          id: "nexus-locked-editor",
          firstName: "Nexus",
          lastName: "Editor",
          email: "locked-editor@nexus.local",
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          isOwner: false,
          role: "global:member",
          globalRole: {
            name: "member",
            scope: "global",
          },
          projectRelations: [],
          personalizationAnswers: {},
          settings: {},
        },
      });
    }
    return editorJsonResponse(req, { data: [], count: 0 });
  }

  if (path.startsWith("/rest/credentials")) {
    return editorJsonResponse(req, { data: [], count: 0 });
  }

  if (path.startsWith("/rest/executions") || path.startsWith("/rest/execution")) {
    return editorJsonResponse(req, { data: [], count: 0 });
  }

  if (path.startsWith("/rest/variables")) {
    return editorJsonResponse(req, { data: [], count: 0 });
  }

  if (path === "/api/banners" || path === "/api/whats-new") {
    return editorJsonResponse(req, []);
  }

  if (path.startsWith("/api/versions/")) {
    return editorJsonResponse(req, []);
  }

  return null;
}

function safeBlockedApiResponse(req: Request, targetPath: string) {
  const method = req.method.toUpperCase();
  if (!["GET", "HEAD"].includes(method) || !apiLikePath(targetPath)) return null;
  return editorJsonResponse(req, {
    data: [],
    count: 0,
    blocked_by_nexus: true,
    path: targetPath,
  });
}

function frameAncestorsPolicy() {
  const appOrigin = cleanString(env("NEXUS_APP_ORIGIN"));
  const allowed = new Set([
    "'self'",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "https://nexus-ai.software",
  ]);

  if (appOrigin) allowed.add(appOrigin.replace(/\/+$/, ""));

  return [
    `frame-ancestors ${Array.from(allowed).join(" ")}`,
    "base-uri 'none'",
  ].join("; ") + ";";
}

async function proxyRequest(req: Request) {
  const supabaseUrl = cleanBaseUrl(env("SUPABASE_URL"));
  const serviceRoleKey = cleanString(env("SUPABASE_SERVICE_ROLE_KEY"));
  const n8nBaseUrl = cleanBaseUrl(env("N8N_BASE_URL"));

  if (!supabaseUrl || !serviceRoleKey || !n8nBaseUrl) {
    return errorResponse("Missing Supabase or n8n function secrets.", 500);
  }

  const url = new URL(req.url);
  const base = functionBaseUrl(req);
  const queryToken = cleanString(url.searchParams.get("editor_token"));
  const queryTarget = cleanString(url.searchParams.get("n8n_path"));
  const afterFunction = url.pathname.slice(new URL(base).pathname.length);
  const match = afterFunction.match(/^\/editor\/([^/]+)(\/.*)?$/);

  if (!queryToken && !match) {
    return errorResponse("Editor proxy route not found.", 404);
  }

  const token = queryToken || decodeURIComponent(match?.[1] || "");
  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  try {
    const session = await loadSession(adminClient, token);
    const rawTarget = queryToken
      ? queryTarget
      : (match?.[2] || `/workflow/${encodeURIComponent(session.n8n_workflow_id)}`);
    const parsedTarget = new URL(rawTarget || `/workflow/${encodeURIComponent(session.n8n_workflow_id)}`, n8nBaseUrl);
    let targetPath = parsedTarget.pathname;
    const targetSearch = parsedTarget.search;
    if (targetPath === "/" || targetPath === "") {
      targetPath = `/workflow/${encodeURIComponent(session.n8n_workflow_id)}`;
    }

    const stub = startupStubResponse(req, targetPath);
    if (stub) return stub;

    if (!allowedProxyPath(targetPath, req.method, session.n8n_workflow_id)) {
      const safeBlocked = safeBlockedApiResponse(req, targetPath);
      if (safeBlocked) return safeBlocked;

      const accept = req.headers.get("accept") || "";
      const wantsHtml = accept.includes("text/html") && !accept.includes("application/json");
      if (wantsHtml) {
        return editorRedirect(req, editorProxyUrl(base, token, `/workflow/${encodeURIComponent(session.n8n_workflow_id)}`), 302);
      }
      return editorJsonResponse(req, {
        ok: false,
        error: "This n8n route is blocked by Nexus workflow lock.",
        blocked_by_nexus: true,
        path: targetPath,
      }, 403);
    }

    const cookie = await decryptText(session.encrypted_n8n_cookie);
    if (!cookie) throw new Error("Editor session is missing n8n auth. Reopen the editor from Nexus.");

    const upstreamPath = targetPath.replace(/\/+$/, "") === "/rest/node-types"
      ? "/types/nodes.json"
      : targetPath;
    const upstreamSearch = upstreamPath === "/types/nodes.json" ? "" : targetSearch;
    const targetUrl = `${n8nBaseUrl}${upstreamPath}${upstreamSearch}`;
    const body = ["GET", "HEAD"].includes(req.method) ? undefined : await req.arrayBuffer();
    const upstreamHeaders: Record<string, string> = {
      Accept: req.headers.get("accept") || "*/*",
      Cookie: cookie,
      "X-Requested-With": req.headers.get("x-requested-with") || "XMLHttpRequest",
      "User-Agent": req.headers.get("user-agent") || "Nexus n8n editor gateway",
    };
    const incomingContentType = req.headers.get("content-type");
    if (incomingContentType || !["GET", "HEAD"].includes(req.method)) {
      upstreamHeaders["Content-Type"] = incomingContentType || "application/json";
    }

    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers: upstreamHeaders,
      body,
      redirect: "manual",
    });

    await adminClient
      .from("n8n_editor_sessions")
      .update({
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", session.id);

    if (
      upstream.ok &&
      allowedWorkflowRestPath(targetPath, session.n8n_workflow_id) &&
      ["POST", "PATCH", "PUT"].includes(req.method)
    ) {
      await markWorkflowEdited(adminClient, session, {
        proxy_save_path: targetPath,
      });
    }

    if (upstream.status >= 300 && upstream.status < 400) {
      const location = upstream.headers.get("location") || `/workflow/${encodeURIComponent(session.n8n_workflow_id)}`;
      const nextUrl = new URL(location, n8nBaseUrl);
      const nextPath = forbiddenPath(nextUrl.pathname)
        ? `/workflow/${encodeURIComponent(session.n8n_workflow_id)}`
        : `${nextUrl.pathname}${nextUrl.search}`;
      return editorRedirect(req, editorProxyUrl(base, token, nextPath), 302);
    }

    if (upstream.status >= 400 && apiLikePath(targetPath)) {
      const text = await upstream.text().catch(() => "");
      return editorJsonResponse(req, {
        ok: false,
        error: text ? text.slice(0, 500) : `n8n returned ${upstream.status}`,
        upstream_status: upstream.status,
        path: targetPath,
      }, upstream.status);
    }

    if (isHtmlRequest(req, upstream, targetPath)) {
      const html = await upstream.text();
      return new Response(rewriteHtml(html, base, token, session.n8n_workflow_id, targetPath), {
        status: upstream.status,
        headers: lockedEditorHeaders(req, "text/html; charset=utf-8"),
      });
    }

    const upstreamContentType = upstream.headers.get("content-type") || "";
    const forcedContentType = contentTypeForPath(upstreamPath);
    const contentType = forcedContentType || upstreamContentType;
    if (
      textAssetPath(upstreamPath) ||
      contentType.includes("javascript") ||
      contentType.includes("text/css") ||
      contentType.includes("application/json")
    ) {
      const text = await upstream.text();
      return new Response(rewriteAssetUrls(text, base, token, targetPath), {
        status: upstream.status,
        headers: lockedEditorHeaders(req, contentType),
      });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: responseHeaders(upstream, req, contentType || "application/octet-stream"),
    });
  } catch (error) {
    return editorJsonResponse(req, {
      ok: false,
      error: error instanceof Error ? error.message : "Editor gateway failed.",
    }, 403);
  }
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") {
    if (url.pathname.includes("/n8n-editor-gateway/editor/") || url.searchParams.has("editor_token")) {
      return new Response("ok", {
        status: 200,
        headers: editorCorsHeaders(req),
      });
    }
    return new Response("ok", {
      status: 200,
      headers: corsHeaders,
    });
  }

  if (url.pathname.includes("/n8n-editor-gateway/editor/") || url.searchParams.has("editor_token")) {
    return proxyRequest(req);
  }

  if (req.method === "GET") {
    return jsonResponse({
      ok: true,
      message: "n8n-editor-gateway function is alive.",
      public_base_url: functionBaseUrl(req),
      env: {
        has_n8n_base_url: Boolean(env("N8N_BASE_URL")),
        has_n8n_api_key: Boolean(env("N8N_API_KEY")),
        has_editor_email: Boolean(env("N8N_EDITOR_EMAIL")),
        has_editor_password: Boolean(env("N8N_EDITOR_PASSWORD")),
        has_session_secret: Boolean(env("N8N_EDITOR_SESSION_SECRET") || env("NEXUS_CREDENTIAL_SECRET")),
      },
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed.", 405);
  }

  const body = await req.json().catch(() => ({}));
  const action = cleanString(body.action || "create_session");

  if (action === "create_session") return createEditorSession(req, body);
  if (action === "sync_workflow") return syncWorkflow(req, body);
  if (action === "revoke_session") return revokeSession(req, body);

  return errorResponse("Unknown editor gateway action.", 400);
});
