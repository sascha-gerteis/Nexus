import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import { decryptCredentialPayload } from "../_shared/nexus-credentials.ts";

function env(name: string) {
  return Deno.env.get(name) || "";
}

function cleanString(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

function lower(value: unknown) {
  return cleanString(value).toLowerCase();
}

function firstSecretValue(fields: Record<string, any>) {
  for (const key of [
    "api_key",
    "apiKey",
    "key",
    "token",
    "api_token",
    "access_token",
    "value",
    "password",
    "secret",
  ]) {
    const value = cleanString(fields?.[key]);
    if (value) return value;
  }

  return cleanString(Object.values(fields || {}).find((value) => cleanString(value)));
}

function validateUrl(rawUrl: string, allowedHost = "") {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Proxy URL is invalid.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("Proxy URL must use HTTPS.");
  }

  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)
  ) {
    throw new Error("Proxy URL cannot target localhost or private networks.");
  }

  if (allowedHost && host !== allowedHost.toLowerCase()) {
    throw new Error(`Proxy URL host "${host}" does not match the saved mapping host "${allowedHost}".`);
  }

  return parsed;
}

function authHeaderName(provider: string, fields: Record<string, any>) {
  if (cleanString(fields.headerName || fields.name)) {
    return cleanString(fields.headerName || fields.name);
  }

  if (provider === "google_gemini") return "x-goog-api-key";
  if (provider === "anthropic") return "x-api-key";
  if (provider === "serper") return "X-API-KEY";

  return "Authorization";
}

function buildCredentialHeaders(
  credentialType: string,
  provider: string,
  fields: Record<string, any>,
) {
  const type = lower(credentialType);
  const headers: Record<string, string> = {};
  const value = firstSecretValue(fields);

  if (!value) {
    throw new Error("The bound credential has no usable secret value.");
  }

  if (type === "httpbasicauth") {
    const user = cleanString(fields.username || fields.user || fields.login);
    const password = cleanString(fields.password || fields.pass || fields.api_key || fields.token || value);
    headers.Authorization = `Basic ${btoa(`${user}:${password}`)}`;
    return headers;
  }

  if (type === "httpheaderauth") {
    const name = authHeaderName(provider, fields);
    const headerValue = cleanString(
      fields.headerValue ||
      fields.value ||
      (name.toLowerCase() === "authorization" ? `Bearer ${value}` : value),
    );
    headers[name] = headerValue;
    return headers;
  }

  headers.Authorization = `Bearer ${value}`;
  return headers;
}

function findBinding(automation: any, body: any) {
  const nodeName = cleanString(body.node_name);
  const credentialKey = cleanString(body.credential_key);
  const provider = cleanString(body.provider);
  const bindings = Array.isArray(automation?.n8n_credential_bindings)
    ? automation.n8n_credential_bindings
    : [];

  return bindings.find((binding: any) => {
    if (nodeName && cleanString(binding.node_name) !== nodeName) return false;
    if (credentialKey && cleanString(binding.credential_key || binding.n8n_credential_type) !== credentialKey) return false;
    if (provider && cleanString(binding.provider) && cleanString(binding.provider) !== provider) return false;
    return cleanString(binding.developer_credential_id);
  }) || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  if (req.method === "GET") {
    return jsonResponse({
      ok: true,
      message: "runtime-http-proxy is alive.",
      env: {
        has_supabase_url: Boolean(env("SUPABASE_URL")),
        has_service_role: Boolean(env("SUPABASE_SERVICE_ROLE_KEY")),
        has_runtime_secret: Boolean(env("NEXUS_RUNTIME_SECRET")),
        has_credential_secret: Boolean(env("NEXUS_CREDENTIAL_SECRET")),
      },
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    const runtimeSecret = env("NEXUS_RUNTIME_SECRET");
    const credentialSecret = env("NEXUS_CREDENTIAL_SECRET");
    const supabaseUrl = env("SUPABASE_URL");
    const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");

    if (!runtimeSecret || !credentialSecret || !supabaseUrl || !serviceRoleKey) {
      return errorResponse("Missing runtime proxy Supabase secrets.", 500);
    }

    const headerSecret = cleanString(req.headers.get("x-nexus-runtime-secret"));
    if (headerSecret !== runtimeSecret) {
      return errorResponse("Unauthorized proxy request.", 401);
    }

    const body = await req.json().catch(() => ({}));
    const automationId = cleanString(body.automation_id);
    const method = cleanString(body.method || "GET").toUpperCase();
    const credentialKey = cleanString(body.credential_key || "httpBearerAuth");
    const provider = cleanString(body.provider || "custom");

    if (!automationId) return errorResponse("automation_id is required.", 400);
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      return errorResponse("Unsupported proxy method.", 400);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: automation, error: automationError } = await adminClient
      .from("automations")
      .select("id, developer_id, n8n_credential_bindings, developer_credential_requirements")
      .eq("id", automationId)
      .maybeSingle();

    if (automationError || !automation) {
      return errorResponse(automationError?.message || "Automation not found.", 404);
    }

    const binding = findBinding(automation, body);
    if (!binding?.developer_credential_id) {
      return errorResponse(
        `No bound Nexus credential found for ${cleanString(body.node_name) || "this proxy node"}. Press Apply credentials & run check first.`,
        400,
      );
    }

    const requirements = Array.isArray(automation.developer_credential_requirements)
      ? automation.developer_credential_requirements
      : [];
    const requirement = requirements.find((item: any) => (
      cleanString(item.node_name) === cleanString(body.node_name) &&
      cleanString(item.credential_key || item.n8n_credential_type) === credentialKey
    ));
    const allowedHost = cleanString(binding.allowed_host || requirement?.allowed_host || requirement?.metadata?.allowed_host);
    const url = validateUrl(cleanString(body.url), allowedHost);

    const { data: credential, error: credentialError } = await adminClient
      .from("developer_credentials")
      .select("*")
      .eq("id", binding.developer_credential_id)
      .eq("status", "active")
      .maybeSingle();

    if (credentialError || !credential) {
      return errorResponse(credentialError?.message || "Bound credential is missing or inactive.", 400);
    }

    if (
      automation.developer_id &&
      cleanString(credential.developer_id) &&
      cleanString(credential.developer_id) !== cleanString(automation.developer_id) &&
      cleanString(credential.owner_role) !== "admin"
    ) {
      return errorResponse("Bound credential does not belong to this product developer.", 403);
    }

    const secretFields = await decryptCredentialPayload(credential.encrypted_payload, credentialSecret);
    const inputHeaders = asObject(body.headers);
    const credentialHeaders = buildCredentialHeaders(credentialKey, provider, secretFields);
    const headers: Record<string, string> = {
      accept: "application/json",
      ...Object.fromEntries(
        Object.entries(inputHeaders).map(([key, value]) => [key, cleanString(value)]),
      ),
      ...credentialHeaders,
    };

    let requestBody: BodyInit | undefined;
    if (method !== "GET" && method !== "DELETE" && body.body !== undefined) {
      if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
        headers["content-type"] = "application/json";
      }

      requestBody = typeof body.body === "string"
        ? body.body
        : JSON.stringify(body.body || {});
    }

    const upstream = await fetch(url.toString(), {
      method,
      headers,
      body: requestBody,
    });

    const text = await upstream.text();
    let result: any = null;
    try {
      result = text ? JSON.parse(text) : {};
    } catch {
      result = { raw: text };
    }

    if (!upstream.ok) {
      const message = cleanString(result?.message || result?.error?.message || result?.error || result?.raw || text);
      return errorResponse(
        `Upstream ${upstream.status}: ${message || upstream.statusText}`,
        502,
        { upstream_status: upstream.status, result },
      );
    }

    return jsonResponse({
      ok: true,
      upstream_status: upstream.status,
      result,
    });
  } catch (error) {
    console.error("runtime-http-proxy failed:", error);
    return errorResponse(error instanceof Error ? error.message : "Runtime proxy failed.", 500);
  }
});
