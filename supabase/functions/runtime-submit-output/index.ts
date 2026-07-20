import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

function env(name: string) {
  return Deno.env.get(name) || "";
}

function cleanString(value: unknown) {
  return String(value ?? "").trim();
}

function asJsonObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function parseMaybeJson(value: unknown) {
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  if (!trimmed) return "";

  if (
    !((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]")))
  ) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function stripUnsafeText(value: unknown) {
  const source = cleanString(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  let output = "";

  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    const next = source.charCodeAt(index + 1);

    if (code >= 0xd800 && code <= 0xdbff) {
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += source[index] + source[index + 1];
        index += 1;
      }
      continue;
    }

    if (code >= 0xdc00 && code <= 0xdfff) {
      continue;
    }

    output += source[index];
  }

  return output;
}

function normalizeBodyObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const body = value as Record<string, unknown>;
  const nestedBody = body.body;
  const hasDirectRuntimeFields = Boolean(
    body.customer_automation_id ||
      body.customerAutomationId ||
      body.status ||
      body.output_type ||
      body.content_html ||
      body.content_text ||
      body.title ||
      body.system,
  );

  if (
    !hasDirectRuntimeFields &&
    nestedBody &&
    typeof nestedBody === "object" &&
    !Array.isArray(nestedBody)
  ) {
    return nestedBody as Record<string, unknown>;
  }

  return body;
}

async function readRequestBody(req: Request) {
  const rawBody = await req.text().catch(() => "");
  const trimmed = rawBody.trim();

  if (!trimmed) return { rawBody, parsedBody: null };

  try {
    return { rawBody, parsedBody: JSON.parse(trimmed) };
  } catch {
    const parsed = parseMaybeJson(trimmed);
    return { rawBody, parsedBody: parsed };
  }
}

function safeJsonObject(value: unknown) {
  const parsed = parseMaybeJson(value);

  if (!parsed || parsed === "") return {};

  try {
    const cloned = JSON.parse(JSON.stringify(parsed));

    if (cloned && typeof cloned === "object" && !Array.isArray(cloned)) {
      return cloned as Record<string, unknown>;
    }

    if (Array.isArray(cloned)) {
      return { items: cloned };
    }

    return { value: cloned };
  } catch {
    return {};
  }
}

function looksLikeJsonStorageError(message: string) {
  const lower = cleanString(message).toLowerCase();
  return (
    lower.includes("invalid json") ||
    lower.includes("empty or invalid json") ||
    lower.includes("json input") ||
    lower.includes("could not serialize") ||
    lower.includes("unexpected token")
  );
}

function stripHtmlForOutputSignal(value: unknown) {
  return stripUnsafeText(value)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jsonHasMeaningfulOutput(value: unknown, depth = 0): boolean {
  if (depth > 5 || value === null || value === undefined) return false;

  if (typeof value === "string") return value.trim().length >= 3;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    return value.some((item) => jsonHasMeaningfulOutput(item, depth + 1));
  }

  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !["system", "runtime_secret", "customer_automation_id"].includes(key))
      .some(([, item]) => jsonHasMeaningfulOutput(item, depth + 1));
  }

  return false;
}

function outputHasBuyerVisibleContent(body: Record<string, unknown>) {
  const html = stripUnsafeText(body.content_html || body.html);
  const htmlText = stripHtmlForOutputSignal(html);
  const hasVisualHtml = /<(img|table|canvas|iframe|svg|video|audio)\b/i.test(html);

  if (html && (htmlText.length >= 20 || hasVisualHtml)) return true;

  const textCandidates = [
    body.content_text,
    body.summary,
    body.file_url,
    body.storage_path,
  ];

  if (textCandidates.some((value) => stripUnsafeText(value).length >= 20)) return true;

  const jsonCandidate = safeJsonObject(body.content_json || body.contentJson || body.data || {});
  return jsonHasMeaningfulOutput(jsonCandidate);
}

function normalizeRuntimeResponseMode(value: unknown) {
  const mode = cleanString(value).toLowerCase();
  return ["dashboard_output", "instant_message", "alert_only", "webhook_ack"].includes(mode)
    ? mode
    : "dashboard_output";
}

function externalDeliverySummary(responseMode: string) {
  if (responseMode === "instant_message") {
    return "The automation completed and returned an instant response outside the standard report view.";
  }

  if (responseMode === "alert_only") {
    return "The automation completed. The result was delivered as an alert, email, or notification.";
  }

  if (responseMode === "webhook_ack") {
    return "The automation completed and acknowledged the incoming request.";
  }

  return "The automation completed successfully.";
}

function compactHtmlFallback(title: string, summary: string, contentText: string) {
  const escapeHtml = (value: string) =>
    stripUnsafeText(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="font-family:Arial,sans-serif;line-height:1.5;padding:24px;color:#111"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(summary)}</p><pre style="white-space:pre-wrap;background:#f6f8fb;border:1px solid #dbe5f4;border-radius:12px;padding:16px">${escapeHtml(contentText || summary || "The automation completed successfully.")}</pre></body></html>`;
}

function stringifySafe(value: unknown) {
  try {
    if (typeof value === "string") return value;
    return JSON.stringify(value || {});
  } catch {
    return String(value || "");
  }
}

function pickFirstString(...values: unknown[]) {
  for (const value of values) {
    const cleaned = cleanString(value);
    if (cleaned) return cleaned;
  }

  return "";
}

function isTechnicalTestCustomerAutomationId(value: string) {
  return /^TEST_ADMIN_RUN_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function getNestedValue(obj: any, path: string) {
  const parts = path.split(".");
  let current = obj;

  for (const part of parts) {
    if (current && Object.prototype.hasOwnProperty.call(current, part)) {
      current = current[part];
    } else {
      return undefined;
    }
  }

  return current;
}

function collectPossibleErrorText(body: any) {
  const candidates = [
    body.error_message,
    body.message,
    body.error,
    body.errorDescription,
    body.error_description,
    body.errorDetails?.message,
    body.error_details?.message,
    body.raw_error?.message,
    body.raw_error?.error?.message,
    body.raw_error?.body?.error?.message,
    body.raw_error?.response?.body?.error?.message,
    body.raw_error?.json?.error?.message,
    body.data?.error?.message,
    body.data?.message,
    body.n8n_error?.message,
    body.n8nDetails?.message,
  ];

  const direct = pickFirstString(...candidates);

  if (direct) return direct;

  const rawText = stringifySafe(body);

  if (rawText && rawText !== "{}") {
    return rawText.slice(0, 1200);
  }

  return "Automation runtime returned an error.";
}

function collectErrorNode(body: any) {
  return pickFirstString(
    body.error_node,
    body.node,
    body.node_name,
    body.failed_node,
    body.raw_error?.node,
    body.raw_error?.nodeName,
    body.raw_error?.node?.name,
    body.raw_error?.error?.node,
    body.n8nDetails?.nodeName,
    body.n8n_details?.nodeName,
    body.execution?.lastNodeExecuted,
  );
}

function collectRawError(body: any) {
  const raw = body.raw_error || body.error_details || body.errorDetails || body.n8n_error || body;

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      raw_value: raw,
    };
  }

  return raw;
}

function classifyRuntimeError(errorMessage: string, rawError: Record<string, unknown>) {
  const rawText = stringifySafe(rawError);
  const combined = `${errorMessage || ""} ${rawText || ""}`.toLowerCase();

  const customerCredentialSignals = [
    "invalid token",
    "access token",
    "oauth",
    "oauthsignature",
    "permission",
    "permissions",
    "unauthorized",
    "forbidden",
    "authorisation",
    "authorization",
    "authentication",
    "access denied",
    "access_denied",
    "invalid grant",
    "invalid_grant",
    "invalid client",
    "invalid_client",
    "invalid api key",
    "api key invalid",
    "expired token",
    "token expired",
    "token has expired",
    "oauth token",
    "invalid oauth",
    "missing required scope",
    "insufficient scope",
    "insufficient permissions",
    "does not have permission",
    "missing permissions",
    "cannot be loaded due to missing permissions",
    "session has expired",
    "api key is invalid",
    "invalid credentials",
    "credential",
  ];

  const customerInputSignals = [
    "invalid page id",
    "invalid object id",
    "object with id",
    "unsupported get request",
    "page id",
    "invalid url",
    "invalid channel id",
    "invalid username",
    "invalid handle",
    "invalid email",
    "location not found",
    "place not found",
    "business not found",
    "missing required field",
    "required field",
    "required parameter",
    "parameter is required",
  ];

  const devWorkflowSignals = [
    "syntaxerror",
    "referenceerror",
    "typeerror",
    "rangeerror",
    "is not defined",
    "cannot read properties",
    "cannot read property",
    "unexpected identifier",
    "unexpected token",
    "node is unexecuted",
    "no connection back to the node",
    "expressionerror",
    "invalid json",
    "cannot parse",
    "json parse",
    "workflow could not be started",
    "unknown node",
    "no execution data",
    "paired item",
    "item linking",
    "function failed",
    "code doesn't return",
  ];

  const platformSignals = [
    "timeout",
    "timed out",
    "etimedout",
    "econnreset",
    "enotfound",
    "rate limit",
    "too many requests",
    "service unavailable",
    "internal server error",
    "bad gateway",
    "gateway timeout",
    "temporarily unavailable",
    "is_transient",
    "transient",
  ];

  if (customerCredentialSignals.some((signal) => combined.includes(signal))) {
    return {
      error_type: "credential_error",
      error_code: "CUSTOMER_CREDENTIAL_INVALID",
      needs_customer_action: true,
      customer_message:
        "The credentials you submitted are invalid, expired, or missing required permissions. Please update your setup details to continue.",
    };
  }

  if (customerInputSignals.some((signal) => combined.includes(signal))) {
    return {
      error_type: "customer_setup_error",
      error_code: "CUSTOMER_SETUP_INVALID",
      needs_customer_action: true,
      customer_message:
        "Some setup details you submitted look incorrect or incomplete. Please review your setup form and submit it again.",
    };
  }

  if (devWorkflowSignals.some((signal) => combined.includes(signal))) {
    return {
      error_type: "workflow_error",
      error_code: "DEV_WORKFLOW_ERROR",
      needs_customer_action: false,
      customer_message:
        "This automation failed while running. Nexus has been notified and will review it.",
    };
  }

  if (platformSignals.some((signal) => combined.includes(signal))) {
    return {
      error_type: "platform_or_external_api_error",
      error_code: "TEMPORARY_RUNTIME_ERROR",
      needs_customer_action: false,
      customer_message:
        "This automation failed because an external service or runtime was temporarily unavailable. Nexus has been notified.",
    };
  }

  return {
    error_type: "runtime_error",
    error_code: "UNKNOWN_RUNTIME_ERROR",
    needs_customer_action: false,
    customer_message:
      "This automation failed while running. Nexus has been notified and will review it.",
  };
}

async function insertEvent(
  adminClient: any,
  payload: {
    customer_automation_id: string;
    buyer_id?: string | null;
    automation_id?: string | null;
    order_id?: string | null;
    event_type: string;
    title: string;
    message?: string;
    created_by?: string;
  },
) {
  await adminClient.from("automation_events").insert({
    customer_automation_id: payload.customer_automation_id,
    buyer_id: payload.buyer_id || null,
    automation_id: payload.automation_id || null,
    order_id: payload.order_id || null,
    event_type: payload.event_type,
    title: payload.title,
    message: payload.message || "",
    created_by: payload.created_by || "system",
    created_at: new Date().toISOString(),
  });
}

async function tryInsertRunError(adminClient: any, payload: Record<string, unknown>) {
  /*
    This table is added by the launch error-handling SQL.
    If it is not installed yet, do not break the runtime callback.
  */
  const { error } = await adminClient.from("automation_run_errors").insert(payload);

  if (error) {
    console.warn("automation_run_errors insert skipped/failed:", error.message);
  }
}

async function tryUpdateCustomerAutomation(
  adminClient: any,
  customerAutomationId: string,
  payload: Record<string, unknown>,
) {
  const { error } = await adminClient
    .from("customer_automations")
    .update(payload)
    .eq("id", customerAutomationId);

  if (!error) return null;

  /*
    Backward compatibility:
    If new columns are not installed yet, remove them and try again.
  */
  const fallbackPayload = { ...payload };

  delete fallbackPayload.last_error_code;
  delete fallbackPayload.last_error_node;
  delete fallbackPayload.last_error_details;
  delete fallbackPayload.last_failed_at;
  delete fallbackPayload.needs_customer_action;
  delete fallbackPayload.run_frequency;
  delete fallbackPayload.schedule_status;
  delete fallbackPayload.schedule_anchor_at;
  delete fallbackPayload.next_run_at;
  delete fallbackPayload.last_run_at;
  delete fallbackPayload.last_run_requested_at;

  const { error: fallbackError } = await adminClient
    .from("customer_automations")
    .update(fallbackPayload)
    .eq("id", customerAutomationId);

  return fallbackError || error;
}

function productLooksHealthPaused(product: Record<string, any>) {
  const status = cleanString(product?.status).toLowerCase();
  const healthStatus = cleanString(product?.health_status).toLowerCase();

  if (status !== "paused") return false;
  if (product?.health_auto_paused_at) return true;

  return [
    "paused_by_health_check",
    "needs_recheck",
    "failed",
    "error",
    "warning",
    "unknown",
    "",
  ].includes(healthStatus);
}

async function tryUpdateParentAutomationAfterSuccess(
  adminClient: any,
  customerAutomation: Record<string, any>,
  now: string,
) {
  const automationId = cleanString(customerAutomation?.automation_id);
  if (!automationId) return null;

  const { data: product, error: loadError } = await adminClient
    .from("automations")
    .select("id,status,health_status,health_auto_paused_at,health_previous_status")
    .eq("id", automationId)
    .maybeSingle();

  if (loadError || !product) {
    if (loadError) console.warn("Parent automation health sync skipped:", loadError.message);
    return null;
  }

  const nextCheckAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const payload: Record<string, unknown> = {
    health_status: "healthy",
    health_last_checked_at: now,
    health_last_passed_at: now,
    health_last_failed_at: null,
    health_failure_reason: null,
    health_failure_details: {},
    health_consecutive_failures: 0,
    health_auto_paused_at: null,
    health_previous_status: null,
    health_next_check_at: nextCheckAt,
    updated_at: now,
  };

  if (productLooksHealthPaused(product)) {
    const previousStatus = cleanString(product.health_previous_status).toLowerCase();
    payload.status = ["live", "active", "published"].includes(previousStatus)
      ? previousStatus
      : "live";
  }

  const { error } = await adminClient
    .from("automations")
    .update(payload)
    .eq("id", automationId);

  if (!error) return null;

  /*
    Some older databases may not have every health checker column. Keep the
    runtime callback non-blocking by retrying only the core fields.
  */
  const fallbackPayload: Record<string, unknown> = {
    health_status: "healthy",
    updated_at: now,
  };

  if (payload.status) fallbackPayload.status = payload.status;

  const { error: fallbackError } = await adminClient
    .from("automations")
    .update(fallbackPayload)
    .eq("id", automationId);

  if (fallbackError) {
    console.warn("Parent automation health sync failed:", fallbackError.message || error.message);
    return fallbackError || error;
  }

  return null;
}

const CALLBACK_RUN_MATCH_WINDOW_MS = 6 * 60 * 60 * 1000;

function callbackRunStatusIsActive(value: unknown) {
  const status = cleanString(value).toLowerCase();
  return ["running", "processing", "queued", "started", "pending", "in_progress"].some(item =>
    status.includes(item)
  );
}

async function findLatestActiveRunForCallback(adminClient: any, customerAutomationId: string) {
  if (!customerAutomationId) return "";

  const since = new Date(Date.now() - CALLBACK_RUN_MATCH_WINDOW_MS).toISOString();

  const { data, error } = await adminClient
    .from("automation_runs")
    .select("id, status, created_at, updated_at, started_at")
    .eq("customer_automation_id", customerAutomationId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    console.warn("automation_runs active callback lookup failed:", error.message);
    return "";
  }

  const activeRun = (data || []).find((run: any) => callbackRunStatusIsActive(run?.status));
  return cleanString(activeRun?.id);
}

function callbackRunReference(body: any) {
  return {
    runId: cleanString(
      body.run_id ||
        body.runId ||
        body.system?.run_id ||
        body.system?.runId,
    ),
    runKey: cleanString(
      body.run_key ||
        body.runKey ||
        body.system?.run_key ||
        body.system?.runKey,
    ),
  };
}

async function findCallbackRunContext(adminClient: any, body: any, customerAutomationId: string) {
  const { runId, runKey } = callbackRunReference(body);

  if (runId || runKey) {
    let query = adminClient
      .from("automation_runs")
      .select("id, run_key, customer_automation_id, buyer_id, automation_id, order_id, status, created_at, updated_at, started_at, finished_at")
      .limit(1);

    query = runId ? query.eq("id", runId) : query.eq("run_key", runKey);
    if (customerAutomationId) query = query.eq("customer_automation_id", customerAutomationId);

    const { data, error } = await query.maybeSingle();
    if (error) {
      console.warn("automation_runs callback context lookup failed:", error.message);
    } else if (data?.id) {
      return data;
    }
  }

  const since = new Date(Date.now() - CALLBACK_RUN_MATCH_WINDOW_MS).toISOString();
  const { data, error } = await adminClient
    .from("automation_runs")
    .select("id, run_key, customer_automation_id, buyer_id, automation_id, order_id, status, created_at, updated_at, started_at, finished_at")
    .eq("customer_automation_id", customerAutomationId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    console.warn("automation_runs callback context fallback failed:", error.message);
    return null;
  }

  return (data || []).find((run: any) => callbackRunStatusIsActive(run?.status)) || data?.[0] || null;
}

async function updateExistingRunFromCallback(
  adminClient: any,
  body: any,
  payload: Record<string, unknown>,
  customerAutomationId: string,
) {
  const runId = cleanString(
    body.run_id ||
      body.runId ||
      body.system?.run_id ||
      body.system?.runId,
  );

  const runKey = cleanString(
    body.run_key ||
      body.runKey ||
      body.system?.run_key ||
      body.system?.runKey,
  );

  const fallbackRunId = !runId && !runKey
    ? await findLatestActiveRunForCallback(adminClient, customerAutomationId)
    : "";

  if (!runId && !runKey && !fallbackRunId) return false;

  const updatePayload = {
    ...payload,
    updated_at: new Date().toISOString(),
  };

  let query = adminClient
    .from("automation_runs")
    .update(updatePayload)
    .select("id")
    .limit(1);

  query = runId || fallbackRunId
    ? query.eq("id", runId || fallbackRunId)
    : query.eq("run_key", runKey);
  if (customerAutomationId) query = query.eq("customer_automation_id", customerAutomationId);

  let { data, error } = await query.maybeSingle();

  if (!error) return Boolean(data?.id);

  const fallbackPayload = { ...updatePayload };
  delete fallbackPayload.response_payload;
  delete fallbackPayload.request_payload;
  delete fallbackPayload.trigger_source;
  delete fallbackPayload.scheduled_for;
  delete fallbackPayload.run_key;

  query = adminClient
    .from("automation_runs")
    .update(fallbackPayload)
    .select("id")
    .limit(1);

  query = runId || fallbackRunId
    ? query.eq("id", runId || fallbackRunId)
    : query.eq("run_key", runKey);
  if (customerAutomationId) query = query.eq("customer_automation_id", customerAutomationId);

  const fallback = await query.maybeSingle();

  if (fallback.error) {
    console.warn("automation_runs callback update failed:", fallback.error.message);
    return false;
  }

  return Boolean(fallback.data?.id);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: corsHeaders,
    });
  }

  if (req.method === "GET") {
    return jsonResponse({
      ok: true,
      message: "runtime-submit-output is alive with success/error callback support.",
      env: {
        has_supabase_url: Boolean(env("SUPABASE_URL")),
        has_service_role: Boolean(env("SUPABASE_SERVICE_ROLE_KEY")),
        has_runtime_secret: Boolean(env("NEXUS_RUNTIME_SECRET")),
      },
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    const supabaseUrl = env("SUPABASE_URL");
    const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
    const runtimeSecret = env("NEXUS_RUNTIME_SECRET");

    if (!supabaseUrl || !serviceRoleKey) {
      return errorResponse("Missing Supabase function secrets.", 500);
    }

    if (!runtimeSecret) {
      return errorResponse("Missing NEXUS_RUNTIME_SECRET.", 500);
    }

    const requestUrl = new URL(req.url);
    const headerSecret = req.headers.get("x-nexus-runtime-secret") || "";
    const fallbackCustomerAutomationId = pickFirstString(
      req.headers.get("x-nexus-customer-automation-id"),
      requestUrl.searchParams.get("customer_automation_id"),
      requestUrl.searchParams.get("customerAutomationId"),
    );
    const { rawBody, parsedBody } = await readRequestBody(req);
    if (parsedBody === null && !fallbackCustomerAutomationId) {
      return errorResponse(
        "runtime-submit-output received a null JSON body. Reprovision this customer workflow so the Nexus Submit Output node sends its output payload.",
        400,
      );
    }
    const body: any = normalizeBodyObject(parsedBody);

    const bodySecret =
      cleanString(body.runtime_secret) ||
      cleanString(body.system?.runtime_secret);

    const providedSecret = headerSecret || bodySecret;

    if (!providedSecret || providedSecret !== runtimeSecret) {
      return errorResponse("Invalid runtime secret.", 401);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const now = new Date().toISOString();

    const customerAutomationId = cleanString(
      body.customer_automation_id ||
        body.system?.customer_automation_id ||
        body.customerAutomationId ||
        fallbackCustomerAutomationId,
    );

    if (!customerAutomationId) {
      return errorResponse(
        `customer_automation_id is required. The Nexus Submit Output node did not send a valid JSON body. Received ${rawBody ? "a body without customer_automation_id" : "an empty body"}.`,
        400,
      );
    }

    const status = cleanString(body.status || "success").toLowerCase();

    if (isTechnicalTestCustomerAutomationId(customerAutomationId)) {
      return jsonResponse({
        ok: true,
        status: "technical_test_callback_received",
        message:
          "Nexus technical test callback received. No real customer automation or output was created.",
        test_mode: true,
        customer_automation_id: customerAutomationId,
        output_status: status,
      });
    }

    const { data: customerAutomation, error: automationError } = await adminClient
      .from("customer_automations")
      .select("*")
      .eq("id", customerAutomationId)
      .maybeSingle();

    if (automationError || !customerAutomation) {
      return errorResponse(
        automationError?.message || "Customer automation not found.",
        404,
      );
    }

    const callbackRunContext = await findCallbackRunContext(adminClient, body, customerAutomation.id);
    const callbackOrderId = cleanString(
      callbackRunContext?.order_id ||
        body.order_id ||
        body.orderId ||
        body.system?.order_id ||
        body.system?.orderId ||
        customerAutomation.order_id,
    );
    const callbackBuyerId = cleanString(
      callbackRunContext?.buyer_id ||
        body.buyer_id ||
        body.buyerId ||
        body.system?.buyer_id ||
        body.system?.buyerId ||
        customerAutomation.buyer_id,
    );
    const callbackAutomationId = cleanString(
      callbackRunContext?.automation_id ||
        body.automation_id ||
        body.automationId ||
        body.system?.automation_id ||
        body.system?.automationId ||
        customerAutomation.automation_id,
    );

    const isErrorStatus =
      status === "error" ||
      status === "failed" ||
      status === "failure";

    if (isErrorStatus) {
      const rawError = collectRawError(body);
      const rawErrorMessage = collectPossibleErrorText(body);
      const errorNode = collectErrorNode(body);
      const classification = classifyRuntimeError(rawErrorMessage, rawError);

      const failureCount = Number(customerAutomation.failure_count || 0) + 1;

      const updatePayload = {
        status: classification.needs_customer_action ? "setup_error" : "error",
        runtime_status: "error",
        health_status: classification.needs_customer_action ? "needs_customer_action" : "error",
        setup_status: classification.needs_customer_action
          ? "needs_update"
          : customerAutomation.setup_status || "submitted",

        needs_customer_action: classification.needs_customer_action,
        last_error_code: classification.error_code,
        last_error_node: errorNode || null,
        last_error_message: classification.customer_message,
        last_error_details: rawError,
        last_failed_at: now,

        failure_count: failureCount,
        updated_at: now,
      };

      const updateError = await tryUpdateCustomerAutomation(
        adminClient,
        customerAutomationId,
        updatePayload,
      );

      if (updateError) {
        return errorResponse(updateError.message, 500);
      }

      const updatedExistingRun = await updateExistingRunFromCallback(
        adminClient,
        body,
        {
          status: "error",
          finished_at: now,
          error_message: rawErrorMessage,
          error_details: rawError,
          response_payload: {
            status,
            error_message: rawErrorMessage,
            raw_error: rawError,
          },
        },
        customerAutomation.id,
      );

      if (!updatedExistingRun) {
        await adminClient
          .from("automation_runs")
          .insert({
            customer_automation_id: customerAutomation.id,
            buyer_id: callbackBuyerId || customerAutomation.buyer_id,
            automation_id: callbackAutomationId || customerAutomation.automation_id,
            order_id: callbackOrderId || null,
            runtime_type: customerAutomation.runtime_type || "n8n_managed",
            trigger_type: "runtime_callback",
            status: "error",
            started_at: now,
            finished_at: now,
            created_at: now,
            updated_at: now,
            error_message: rawErrorMessage,
            error_details: rawError,
          });
      }

      await tryInsertRunError(adminClient, {
        customer_automation_id: customerAutomation.id,
        buyer_id: callbackBuyerId || customerAutomation.buyer_id,
        automation_id: callbackAutomationId || customerAutomation.automation_id,
        order_id: callbackOrderId || null,

        source: cleanString(body.source) || "n8n",
        error_type: classification.error_type,
        error_code: classification.error_code,
        error_node: errorNode || null,
        error_message: rawErrorMessage,
        customer_message: classification.customer_message,
        raw_error: rawError,
        needs_customer_action: classification.needs_customer_action,
        resolved: false,
        created_at: now,
      });

      await insertEvent(adminClient, {
        customer_automation_id: customerAutomation.id,
        buyer_id: callbackBuyerId || customerAutomation.buyer_id,
        automation_id: callbackAutomationId || customerAutomation.automation_id,
        order_id: callbackOrderId || null,
        event_type: classification.needs_customer_action
          ? "customer_action_required"
          : "runtime_error",
        title: classification.needs_customer_action
          ? "Customer action required"
          : "Automation runtime error",
        message: JSON.stringify({
          customer_message: classification.customer_message,
          admin_error_message: rawErrorMessage,
          error_type: classification.error_type,
          error_code: classification.error_code,
          error_node: errorNode,
          needs_customer_action: classification.needs_customer_action,
        }),
        created_by: "runtime",
      });

      return jsonResponse({
        ok: true,
        status: "error_recorded",
        customer_automation_id: customerAutomationId,
        error_type: classification.error_type,
        error_code: classification.error_code,
        needs_customer_action: classification.needs_customer_action,
        customer_message: classification.customer_message,
        admin_error_message: rawErrorMessage,
      });
    }

    const { data: parentAutomation } = customerAutomation.automation_id
      ? await adminClient
        .from("automations")
        .select("*")
        .eq("id", customerAutomation.automation_id)
        .maybeSingle()
      : { data: null };

    const responseMode = normalizeRuntimeResponseMode(
      parentAutomation?.runtime_response_mode ||
        customerAutomation.runtime_response_mode ||
        "dashboard_output",
    );

    if (!outputHasBuyerVisibleContent(body)) {
      if (responseMode === "dashboard_output") {
        const emptyOutputMessage =
          "Nexus rejected this runtime callback because it did not include buyer-visible output. Send content_html, content_text, summary, file_url, storage_path, or content_json. If this product is designed to deliver by email/alert instead, set Customer response to Alert only, Instant answer, or Webhook acknowledgement.";

        await tryUpdateCustomerAutomation(adminClient, customerAutomationId, {
          runtime_status: "error",
          health_status: "error",
          last_error_code: "empty_runtime_output",
          last_error_node: cleanString(body.node || body.error_node) || "Nexus Submit Output",
          last_error_message: emptyOutputMessage,
          last_error_details: {
            received_keys: Object.keys(body),
            response_mode: responseMode,
          },
          last_failed_at: now,
          updated_at: now,
        });

        const updatedExistingRun = await updateExistingRunFromCallback(
          adminClient,
          body,
          {
            status: "error",
            finished_at: now,
            error_message: emptyOutputMessage,
            error_details: {
              response_mode: responseMode,
              received_keys: Object.keys(body),
            },
            response_payload: {
              status: "error",
              error_code: "empty_runtime_output",
              error_message: emptyOutputMessage,
            },
          },
          customerAutomation.id,
        );

        if (!updatedExistingRun) {
          await adminClient
            .from("automation_runs")
            .insert({
              customer_automation_id: customerAutomation.id,
              buyer_id: callbackBuyerId || customerAutomation.buyer_id,
              automation_id: callbackAutomationId || customerAutomation.automation_id,
              order_id: callbackOrderId || null,
              runtime_type: customerAutomation.runtime_type || "n8n_managed",
              trigger_type: "runtime_callback",
              status: "error",
              started_at: now,
              finished_at: now,
              created_at: now,
              updated_at: now,
              error_message: emptyOutputMessage,
              error_details: {
                response_mode: responseMode,
                received_keys: Object.keys(body),
              },
            });
        }

        await insertEvent(adminClient, {
          customer_automation_id: customerAutomation.id,
          buyer_id: callbackBuyerId || customerAutomation.buyer_id,
          automation_id: callbackAutomationId || customerAutomation.automation_id,
          order_id: callbackOrderId || null,
          event_type: "runtime_output_rejected",
          title: "Runtime output rejected",
          message: JSON.stringify({
            error_code: "empty_runtime_output",
            message: emptyOutputMessage,
            response_mode: responseMode,
          }),
          created_by: "runtime",
        });

        return errorResponse(emptyOutputMessage, 422);
      }

      const fallbackSummary = externalDeliverySummary(responseMode);
      body.output_type = cleanString(body.output_type) || responseMode;
      body.title = cleanString(body.title) || "Automation completed";
      body.summary = cleanString(body.summary) || fallbackSummary;
      body.content_text = cleanString(body.content_text) || fallbackSummary;
      body.content_json = {
        ...safeJsonObject(body.content_json || body.contentJson || body.data || {}),
        nexus_delivery: {
          response_mode: responseMode,
          dashboard_output_required: false,
          generated_at: now,
        },
      };
    }

    const outputTitle =
      cleanString(body.title) ||
      "Automation output";

    const outputType =
      cleanString(body.output_type) ||
      "report";

    const outputPayload = {
      customer_automation_id: customerAutomation.id,
      order_id: callbackOrderId || null,
      buyer_id: callbackBuyerId || customerAutomation.buyer_id,
      automation_id: callbackAutomationId || customerAutomation.automation_id || null,

      output_type: outputType,
      status: "published",

      title: stripUnsafeText(outputTitle),
      summary: stripUnsafeText(body.summary),
      content_text: stripUnsafeText(body.content_text),
      content_html: stripUnsafeText(body.content_html || body.html),
      content_json: {
        ...safeJsonObject(body.content_json || body.contentJson || body.data || {}),
        nexus_runtime: {
          order_id: callbackOrderId || null,
          run_id: cleanString(callbackRunContext?.id) || cleanString(body.run_id || body.runId || body.system?.run_id || body.system?.runId) || null,
          run_key: cleanString(callbackRunContext?.run_key) || cleanString(body.run_key || body.runKey || body.system?.run_key || body.system?.runKey) || null,
        },
      },
      file_url: stripUnsafeText(body.file_url),
      storage_path: stripUnsafeText(body.storage_path),

      created_by: "runtime",
      created_at: now,
      updated_at: now,
    };

    let { data: output, error: outputError } = await adminClient
      .from("automation_outputs")
      .insert(outputPayload)
      .select()
      .single();

    if (outputError && looksLikeJsonStorageError(outputError.message)) {
      const retryPayload = {
        ...outputPayload,
        title: stripUnsafeText(outputPayload.title),
        summary: stripUnsafeText(outputPayload.summary),
        content_text: stripUnsafeText(outputPayload.content_text),
        content_html: stripUnsafeText(outputPayload.content_html),
        content_json: {},
      };

      const retry = await adminClient
        .from("automation_outputs")
        .insert(retryPayload)
        .select()
        .single();

      output = retry.data;
      outputError = retry.error;
    }

    if (outputError && looksLikeJsonStorageError(outputError.message)) {
      const compactPayload = {
        ...outputPayload,
        title: stripUnsafeText(outputPayload.title),
        summary: stripUnsafeText(outputPayload.summary),
        content_text: stripUnsafeText(outputPayload.content_text || outputPayload.summary),
        content_html: compactHtmlFallback(
          stripUnsafeText(outputPayload.title),
          stripUnsafeText(outputPayload.summary),
          stripUnsafeText(outputPayload.content_text || outputPayload.summary),
        ),
        content_json: {},
        file_url: "",
        storage_path: "",
      };

      const compact = await adminClient
        .from("automation_outputs")
        .insert(compactPayload)
        .select()
        .single();

      output = compact.data;
      outputError = compact.error;
    }

    if (outputError || !output) {
      return errorResponse(
        `Could not save automation output: ${outputError?.message || "Unknown database error"}`,
        500,
      );
    }

    const updateError = await tryUpdateCustomerAutomation(
      adminClient,
      customerAutomationId,
      {
        runtime_status: "success",
        setup_status: customerAutomation.setup_status === "needs_update"
          ? "submitted"
          : customerAutomation.setup_status || "submitted",
        health_status: "healthy",
        status: "active",

        needs_customer_action: false,
        last_output_at: now,
        last_run_at: now,
        last_error_code: null,
        last_error_node: null,
        last_error_message: null,
        last_error_details: {},
        updated_at: now,
      },
    );

    if (updateError) {
      return errorResponse(updateError.message, 500);
    }

    await tryUpdateParentAutomationAfterSuccess(adminClient, customerAutomation, now);

    if (callbackOrderId) {
      await adminClient
        .from("orders")
        .update({
          order_status: "completed",
          updated_at: now,
        })
        .eq("id", callbackOrderId)
        .eq("payment_status", "paid")
        .not("order_status", "in", '("cancelled","checkout_expired","payment_failed","refunded")');
    }

    const updatedExistingRun = await updateExistingRunFromCallback(
      adminClient,
      body,
      {
        status: "success",
        finished_at: now,
        response_payload: {
          status: "success",
          output_id: output.id,
          output_type: outputType,
          title: outputTitle,
        },
      },
      customerAutomation.id,
    );

    if (!updatedExistingRun) {
      await adminClient
        .from("automation_runs")
        .insert({
          customer_automation_id: customerAutomation.id,
          buyer_id: callbackBuyerId || customerAutomation.buyer_id,
          automation_id: callbackAutomationId || customerAutomation.automation_id,
          order_id: callbackOrderId || null,
          runtime_type: customerAutomation.runtime_type || "n8n_managed",
          trigger_type: "runtime_callback",
          status: "success",
          started_at: now,
          finished_at: now,
          created_at: now,
          updated_at: now,
        });
    }

    await insertEvent(adminClient, {
      customer_automation_id: customerAutomation.id,
      buyer_id: callbackBuyerId || customerAutomation.buyer_id,
      automation_id: callbackAutomationId || customerAutomation.automation_id,
      order_id: callbackOrderId || null,
      event_type: "runtime_output_received",
      title: "Automation output received",
      message: JSON.stringify({
        output_id: output.id,
        output_type: outputType,
        title: outputTitle,
      }),
      created_by: "runtime",
    });

    return jsonResponse({
      ok: true,
      status: "output_saved",
      customer_automation_id: customerAutomationId,
      output_id: output.id,
      output,
    });
  } catch (error) {
    console.error(error);

    return errorResponse(
      error instanceof Error ? error.message : "Could not save runtime output.",
      500,
    );
  }
});
