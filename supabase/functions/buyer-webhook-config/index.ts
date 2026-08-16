import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import {
  buildWebhookRuntimeEnvelope,
  eventFieldDefinitions,
  flattenEventPaths,
  mappingObject,
  normalizeEventMappings,
  setupFieldDefinitions,
  webhookInputFieldDefinitions,
} from "../_shared/webhook-event-mapping.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const NEXUS_RUNTIME_SECRET = Deno.env.get("NEXUS_RUNTIME_SECRET") || "";

const CONFIG_TABLE = "customer_automation_webhook_configs";
const TEST_TABLE = "customer_automation_webhook_tests";
const OUTBOUND_TIMEOUT_MS = 8000;
const MAX_OUTBOUND_URL_LENGTH = 2048;
const INBOUND_TEST_TIMEOUT_MS = 2 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function cleanString(value: unknown) {
  return String(value || "").trim();
}

function wakeDueRuntimeDispatches() {
  if (!SUPABASE_URL || !NEXUS_RUNTIME_SECRET) return;
  const task = fetch(`${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/process-runtime-dispatch-backlog`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-nexus-runtime-secret": NEXUS_RUNTIME_SECRET,
    },
    body: JSON.stringify({ limit: 10, reconcile_limit: 1, run_due: false }),
  }).then(async (response) => {
    if (!response.ok) throw new Error(`Runtime dispatcher recovery returned HTTP ${response.status}.`);
  }).catch((error) => {
    console.error("Could not wake due webhook runtime dispatches:", error instanceof Error ? error.message : error);
  });
  EdgeRuntime.waitUntil(task);
}

function one(value: any) {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function getAuthHeader(req: Request) {
  const authHeader = req.headers.get("Authorization") || "";
  return /^Bearer\s+\S+/i.test(authHeader) ? authHeader : "";
}

async function requireBuyer(req: Request, adminClient: any) {
  const authHeader = getAuthHeader(req);
  if (!authHeader) return { user: null, error: "Authentication required." };

  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data?.user) return { user: null, error: "Invalid auth token." };

  const { data: profile } = await adminClient
    .from("profiles")
    .select("role")
    .eq("id", data.user.id)
    .maybeSingle();

  if (profile?.role && profile.role !== "buyer") {
    return { user: null, error: "Use a buyer account to configure customer webhooks." };
  }

  return { user: data.user, error: null };
}

function randomSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function endpointUrl(endpointId: string) {
  return `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/buyer-webhook-ingress/${encodeURIComponent(endpointId)}`;
}

function publicConfig(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    customer_automation_id: row.customer_automation_id,
    buyer_id: row.buyer_id,
    inbound_endpoint_id: row.inbound_endpoint_id,
    inbound_url: endpointUrl(row.inbound_endpoint_id),
    inbound_secret_hint: row.inbound_secret_hint || "",
    inbound_status: row.inbound_status || "awaiting_test",
    inbound_test_started_at: row.inbound_test_started_at || null,
    inbound_last_received_at: row.inbound_last_received_at || null,
    inbound_last_event_id: row.inbound_last_event_id || "",
    inbound_last_payload_preview: row.inbound_last_payload_preview || {},
    outbound_url: row.outbound_url || "",
    outbound_status: row.outbound_status || "not_configured",
    outbound_last_tested_at: row.outbound_last_tested_at || null,
    outbound_last_status_code: row.outbound_last_status_code || null,
    outbound_last_error: row.outbound_last_error || "",
    inbound_confirmed_at: row.inbound_confirmed_at || null,
    outbound_confirmed_at: row.outbound_confirmed_at || null,
    live_enabled: row.live_enabled === true,
    event_mapping: Array.isArray(row.event_mapping) ? row.event_mapping : [],
    event_mapping_status: row.event_mapping_status || "not_configured",
    event_mapping_last_event_id: row.event_mapping_last_event_id || "",
    event_mapping_last_validated_at: row.event_mapping_last_validated_at || null,
    event_mapping_last_error: row.event_mapping_last_error || "",
    event_mapping_preview: row.event_mapping_preview || {},
    event_mapping_confirmed_at: row.event_mapping_confirmed_at || null,
    runtime_contract_version: row.runtime_contract_version || "nexus_runtime_v1",
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function loadOwnedAutomation(adminClient: any, customerAutomationId: string, buyerId: string) {
  const { data, error } = await adminClient
    .from("customer_automations")
    .select(`
      *,
      automations(
        id,
        title,
        slug,
        icon,
        color,
        short_description,
        runtime_trigger_mode,
        runtime_response_mode,
        setup_schema,
        runtime_event_schema,
        pricing_type,
        currency,
        webhook_included_runs,
        webhook_topup_runs,
        webhook_topup_price
      ),
      orders(
        id,
        bundle_id,
        order_type,
        automation_title,
        payment_status,
        order_status,
        stripe_subscription_status,
        stripe_cancel_at_period_end,
        stripe_current_period_start,
        stripe_current_period_end,
        buyer_email,
        buyer_name
      )
    `)
    .eq("id", customerAutomationId)
    .eq("buyer_id", buyerId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("Customer automation not found for this buyer.");
  return data;
}

function isOptInWebhookProduct(customerAutomation: any) {
  const automation = one(customerAutomation?.automations) || {};
  return cleanString(automation.runtime_trigger_mode).toLowerCase() === "buyer_webhook";
}

function mutationBlocked(customerAutomation: any) {
  const order = one(customerAutomation?.orders) || {};
  const combined = [
    customerAutomation?.status,
    customerAutomation?.runtime_status,
    order?.order_status,
    order?.stripe_subscription_status,
  ].map((value) => cleanString(value).toLowerCase()).join(" ");
  return combined.includes("cancel") || combined.includes("expired");
}

async function loadConfig(adminClient: any, customerAutomationId: string, buyerId: string) {
  const { data, error } = await adminClient
    .from(CONFIG_TABLE)
    .select("*")
    .eq("customer_automation_id", customerAutomationId)
    .eq("buyer_id", buyerId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

async function ensureConfig(adminClient: any, customerAutomationId: string, buyerId: string) {
  const existing = await loadConfig(adminClient, customerAutomationId, buyerId);
  if (existing) return { config: existing, newSecret: "" };

  const secret = randomSecret();
  const payload = {
    customer_automation_id: customerAutomationId,
    buyer_id: buyerId,
    inbound_secret_hash: await sha256(secret),
    inbound_secret_hint: secret.slice(-6),
    inbound_status: "awaiting_test",
    live_enabled: false,
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  const { data, error } = await adminClient
    .from(CONFIG_TABLE)
    .insert(payload)
    .select("*")
    .single();

  if (!error && data) return { config: data, newSecret: secret };

  // A duplicate means two tabs created the same buyer-owned configuration.
  // Load the winning row without revealing either tab's discarded secret.
  if (/duplicate|unique/i.test(cleanString(error?.message))) {
    const raced = await loadConfig(adminClient, customerAutomationId, buyerId);
    if (raced) return { config: raced, newSecret: "" };
  }
  throw new Error(error?.message || "Could not create webhook configuration.");
}

async function loadRecentTests(adminClient: any, configId: string, buyerId: string) {
  const { data, error } = await adminClient
    .from(TEST_TABLE)
    .select("id, direction, status, event_id, response_status, error_message, payload_preview, created_at")
    .eq("webhook_config_id", configId)
    .eq("buyer_id", buyerId)
    .order("created_at", { ascending: false })
    .limit(12);
  if (error) throw new Error(error.message);
  return data || [];
}

async function expireTimedOutInboundTest(adminClient: any, config: any, buyerId: string) {
  const startedAt = Date.parse(cleanString(config?.inbound_test_started_at));
  const shouldExpire = config?.live_enabled !== true &&
    cleanString(config?.inbound_status) === "awaiting_test" &&
    Number.isFinite(startedAt) &&
    Date.now() - startedAt >= INBOUND_TEST_TIMEOUT_MS;
  if (!shouldExpire) return config;

  const timedOutAt = nowIso();
  const message = "No authenticated request arrived within two minutes.";
  const preview = { connection_test_error: message, timed_out_at: timedOutAt };
  const { data: expired, error: expireError } = await adminClient
    .from(CONFIG_TABLE)
    .update({
      inbound_status: "test_failed",
      inbound_last_received_at: null,
      inbound_last_payload_preview: preview,
      updated_at: timedOutAt,
    })
    .eq("id", config.id)
    .eq("buyer_id", buyerId)
    .eq("inbound_status", "awaiting_test")
    .select("*")
    .maybeSingle();
  if (expireError) throw new Error(expireError.message);
  if (!expired) return await loadConfig(adminClient, config.customer_automation_id, buyerId) || config;

  const { error: historyError } = await adminClient
    .from(TEST_TABLE)
    .update({ status: "failed", error_message: message, payload_preview: preview })
    .eq("webhook_config_id", config.id)
    .eq("buyer_id", buyerId)
    .eq("direction", "inbound")
    .eq("event_id", config.inbound_last_event_id)
    .eq("status", "pending");
  if (historyError) throw new Error(historyError.message);
  return expired;
}

async function reconcileReceivedInboundTest(adminClient: any, config: any, buyerId: string) {
  const status = cleanString(config?.inbound_status);
  const eventId = cleanString(config?.inbound_last_event_id);
  const receivedAt = Date.parse(cleanString(config?.inbound_last_received_at));
  const startedAt = Date.parse(cleanString(config?.inbound_test_started_at));
  const hasFreshReceipt = ["test_received", "confirmed"].includes(status) &&
    Boolean(eventId) &&
    Number.isFinite(receivedAt) &&
    Number.isFinite(startedAt) &&
    receivedAt >= startedAt;
  if (!hasFreshReceipt) return config;

  // The ingress writes the receipt before it finalizes request history. A fast
  // browser poll can otherwise show "Test passed" beside a stale pending row.
  const { error: historyError } = await adminClient
    .from(TEST_TABLE)
    .update({
      status: "succeeded",
      response_status: 202,
      error_message: null,
      payload_preview: config.inbound_last_payload_preview || {},
    })
    .eq("webhook_config_id", config.id)
    .eq("buyer_id", buyerId)
    .eq("direction", "inbound")
    .eq("event_id", eventId)
    .eq("status", "pending");
  if (historyError) throw new Error(historyError.message);

  if (status === "confirmed") return config;
  const { data: confirmed, error: confirmError } = await adminClient
    .from(CONFIG_TABLE)
    .update({
      inbound_status: "confirmed",
      inbound_confirmed_at: config.inbound_confirmed_at || nowIso(),
      live_enabled: false,
      updated_at: nowIso(),
    })
    .eq("id", config.id)
    .eq("buyer_id", buyerId)
    .eq("inbound_status", "test_received")
    .select("*")
    .maybeSingle();
  if (confirmError) throw new Error(confirmError.message);
  return confirmed || await loadConfig(adminClient, config.customer_automation_id, buyerId) || config;
}

async function loadSavedSetup(adminClient: any, customerAutomationId: string, buyerId: string, setupSchema: unknown) {
  const { data, error } = await adminClient
    .from("automation_setup_submissions")
    .select("answers, setup_answers, created_at")
    .eq("customer_automation_id", customerAutomationId)
    .eq("buyer_id", buyerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const preferred = mappingObject(data?.setup_answers);
  const answers = Object.keys(preferred).length ? preferred : mappingObject(data?.answers);
  const safe: Record<string, unknown> = {};
  for (const field of setupFieldDefinitions(setupSchema)) {
    if (field.type === "secret" || field.type === "password") continue;
    if (Object.prototype.hasOwnProperty.call(answers, field.name)) safe[field.name] = answers[field.name];
  }
  return safe;
}

function webhookSchemas(automation: any) {
  const eventFields = eventFieldDefinitions(automation?.runtime_event_schema, automation?.setup_schema);
  const inputFields = webhookInputFieldDefinitions(automation?.setup_schema, automation?.runtime_event_schema);
  const eventNames = new Set(eventFields.map((field) => field.name.toLowerCase()));
  const setupFields = setupFieldDefinitions(automation?.setup_schema)
    .filter((field) => !eventNames.has(field.name.toLowerCase()));
  return { setupFields, eventFields, inputFields };
}

function sanitizeWebhookSetupValues(value: unknown, fields: any[], existing: Record<string, unknown>) {
  const incoming = mappingObject(value);
  const safe = { ...mappingObject(existing) };
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(incoming, field.name)) continue;
    const candidate = incoming[field.name];
    const empty = candidate === null || candidate === undefined ||
      (typeof candidate === "string" && !candidate.trim()) ||
      (Array.isArray(candidate) && candidate.length === 0);
    if (empty) {
      delete safe[field.name];
      continue;
    }
    if (typeof candidate === "string") {
      safe[field.name] = candidate.trim().slice(0, 5000);
    } else if (["number", "boolean"].includes(typeof candidate)) {
      safe[field.name] = candidate;
    } else if (Array.isArray(candidate)) {
      safe[field.name] = candidate.slice(0, 100);
    } else {
      const encoded = JSON.stringify(candidate);
      if (encoded.length > 20000) throw new Error(field.label + " is too large.");
      safe[field.name] = candidate;
    }
  }
  return safe;
}

async function saveWebhookSetupValues(
  adminClient: any,
  customerAutomation: any,
  buyerId: string,
  fields: any[],
  values: Record<string, unknown>,
) {
  const now = nowIso();
  const { data: latestSubmission, error: latestSubmissionError } = await adminClient
    .from("automation_setup_submissions")
    .select("credential_keys_available")
    .eq("customer_automation_id", customerAutomation.id)
    .eq("buyer_id", buyerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestSubmissionError) throw new Error(latestSubmissionError.message);
  const credentialKeysAvailable = Array.isArray(latestSubmission?.credential_keys_available)
    ? latestSubmission.credential_keys_available.map(cleanString).filter(Boolean)
    : [];
  const payload = {
    customer_automation_id: customerAutomation.id,
    buyer_id: buyerId,
    automation_id: customerAutomation.automation_id || null,
    order_id: customerAutomation.order_id || null,
    answers: values,
    setup_answers: values,
    credential_keys_available: credentialKeysAvailable,
    status: "submitted",
    submitted_at: now,
    created_at: now,
    updated_at: now,
  };
  let result = await adminClient.from("automation_setup_submissions").insert(payload);
  if (!result.error) return;
  const fallback = {
    customer_automation_id: customerAutomation.id,
    buyer_id: buyerId,
    automation_id: customerAutomation.automation_id || null,
    order_id: customerAutomation.order_id || null,
    answers: values,
    status: "submitted",
    created_at: now,
  };
  result = await adminClient.from("automation_setup_submissions").insert(fallback);
  if (result.error) throw new Error(result.error.message);
}
async function loadUsageSummary(adminClient: any, customerAutomationId: string) {
  const { data, error } = await adminClient.rpc("ensure_customer_automation_usage_entitlement", {
    p_customer_automation_id: customerAutomationId,
  });
  if (error) throw new Error(error.message);
  return data || {
    ok: false,
    status: "not_available",
    error: "Usage entitlement could not be loaded.",
  };
}

function runtimeMappingPreview(config: any, customerAutomation: any, savedSetup: Record<string, unknown>) {
  if (!config?.inbound_last_received_at || !config?.inbound_last_event_id) return null;
  const automation = one(customerAutomation?.automations) || {};
  const order = one(customerAutomation?.orders) || {};
  const schemas = webhookSchemas(automation);
  const mappings = normalizeEventMappings(config.event_mapping, schemas.eventFields);
  return buildWebhookRuntimeEnvelope({
    customerAutomation,
    automation,
    order,
    payload: mappingObject(config.inbound_last_payload_preview),
    eventId: cleanString(config.inbound_last_event_id),
    receivedAt: cleanString(config.inbound_last_received_at),
    mappings,
    savedSetup,
    setupSchema: schemas.inputFields,
    eventSchema: schemas.eventFields,
  });
}

async function updateOwnedConfig(adminClient: any, config: any, buyerId: string, updates: Record<string, unknown>) {
  const { data, error } = await adminClient
    .from(CONFIG_TABLE)
    .update({ ...updates, live_enabled: false, updated_at: nowIso() })
    .eq("id", config.id)
    .eq("buyer_id", buyerId)
    .select("*")
    .single();
  if (error) throw new Error(error.message);
  return data;
}

function cleanHostname(hostname: string) {
  return cleanString(hostname).toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

function privateIpv4(address: string) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224;
}

function privateIpv6(address: string) {
  const value = cleanHostname(address);
  return value === "::" || value === "::1" || value.startsWith("fc") || value.startsWith("fd") ||
    /^fe[89ab]/.test(value) || value.startsWith("::ffff:127.") || value.startsWith("::ffff:10.") ||
    value.startsWith("::ffff:192.168.") || value.startsWith("::ffff:169.254.");
}

function hostIsBlocked(hostname: string) {
  const host = cleanHostname(hostname);
  return !host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
    host.endsWith(".internal") || host.endsWith(".home") || host === "metadata.google.internal" ||
    privateIpv4(host) || privateIpv6(host);
}

async function assertSafeOutboundUrl(value: unknown) {
  const raw = cleanString(value);
  if (!raw) throw new Error("Enter the HTTPS webhook destination first.");
  if (raw.length > MAX_OUTBOUND_URL_LENGTH) throw new Error("Webhook destination is too long.");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Enter a valid HTTPS webhook URL.");
  }

  if (url.protocol !== "https:") throw new Error("Webhook destinations must use HTTPS.");
  if (url.username || url.password) throw new Error("Webhook URLs cannot contain embedded credentials.");
  if (url.port && !["443", "8443"].includes(url.port)) {
    throw new Error("Webhook destinations must use HTTPS port 443 or 8443.");
  }
  if (hostIsBlocked(url.hostname)) throw new Error("Private, local, and metadata webhook destinations are not allowed.");

  const hostname = cleanHostname(url.hostname);
  const isLiteralIp = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
  if (!isLiteralIp) {
    const addresses: string[] = [];
    try {
      addresses.push(...await Deno.resolveDns(hostname, "A"));
    } catch {
      // A hostname may legitimately be IPv6-only.
    }
    try {
      addresses.push(...await Deno.resolveDns(hostname, "AAAA"));
    } catch {
      // An IPv4-only hostname does not require AAAA records.
    }
    if (!addresses.length) throw new Error("Webhook hostname could not be resolved.");
    if (addresses.some((address) => privateIpv4(address) || privateIpv6(address))) {
      throw new Error("Webhook hostname resolves to a private or restricted network.");
    }
  }

  url.hash = "";
  return url.toString();
}

async function recordOutboundTest(adminClient: any, params: {
  config: any;
  customerAutomationId: string;
  buyerId: string;
  status: "succeeded" | "failed";
  eventId: string;
  responseStatus?: number | null;
  errorMessage?: string;
}) {
  const { error } = await adminClient.from(TEST_TABLE).insert({
    webhook_config_id: params.config.id,
    customer_automation_id: params.customerAutomationId,
    buyer_id: params.buyerId,
    direction: "outbound",
    status: params.status,
    event_id: params.eventId,
    response_status: params.responseStatus || null,
    error_message: cleanString(params.errorMessage).slice(0, 1000) || null,
    payload_preview: { event: "nexus.webhook.test" },
    created_at: nowIso(),
  });
  if (error) throw new Error(error.message);
}

async function testOutbound(adminClient: any, params: {
  config: any;
  customerAutomation: any;
  buyerId: string;
  requestedUrl: unknown;
}) {
  const destination = await assertSafeOutboundUrl(params.requestedUrl || params.config.outbound_url);
  const eventId = crypto.randomUUID();
  const product = one(params.customerAutomation.automations) || {};
  const payload = {
    event: "nexus.webhook.test",
    test: true,
    event_id: eventId,
    created_at: nowIso(),
    customer_automation_id: params.customerAutomation.id,
    automation: {
      id: product.id || params.customerAutomation.automation_id || "",
      title: product.title || params.customerAutomation.name || "Automation",
    },
    message: "Nexus successfully reached your webhook test endpoint.",
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OUTBOUND_TIMEOUT_MS);
  let responseStatus: number | null = null;
  let failure = "";

  try {
    const response = await fetch(destination, {
      method: "POST",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Nexus-Webhook-Test": "true",
        "X-Nexus-Event-Id": eventId,
      },
      body: JSON.stringify(payload),
    });
    responseStatus = response.status;
    if (response.status < 200 || response.status >= 300) {
      failure = `Destination responded with HTTP ${response.status}.`;
    }
  } catch (error) {
    failure = error instanceof DOMException && error.name === "AbortError"
      ? "Webhook test timed out after 8 seconds."
      : error instanceof Error ? error.message : "Webhook test failed.";
  } finally {
    clearTimeout(timeout);
  }

  const succeeded = !failure;
  const now = nowIso();
  const { data: updated, error: updateError } = await adminClient
    .from(CONFIG_TABLE)
    .update({
      outbound_url: destination,
      outbound_status: succeeded ? "test_succeeded" : "test_failed",
      outbound_last_tested_at: now,
      outbound_last_status_code: responseStatus,
      outbound_last_error: failure || null,
      outbound_confirmed_at: null,
      live_enabled: false,
      updated_at: now,
    })
    .eq("id", params.config.id)
    .eq("buyer_id", params.buyerId)
    .select("*")
    .single();
  if (updateError) throw new Error(updateError.message);

  await recordOutboundTest(adminClient, {
    config: params.config,
    customerAutomationId: params.customerAutomation.id,
    buyerId: params.buyerId,
    status: succeeded ? "succeeded" : "failed",
    eventId,
    responseStatus,
    errorMessage: failure,
  });

  return { config: updated, succeeded, eventId, responseStatus, error: failure };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return errorResponse("Method not allowed.", 405);

  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
      return errorResponse("Webhook configuration service is not configured.", 500);
    }

    const body = await req.json().catch(() => ({}));
    const action = cleanString(body.action || "load").toLowerCase();
    const customerAutomationId = cleanString(body.customer_automation_id || body.customerAutomationId || body.id);
    if (!customerAutomationId) return errorResponse("customer_automation_id is required.", 400);

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const auth = await requireBuyer(req, adminClient);
    if (!auth.user) return errorResponse(auth.error || "Unauthorized.", 401);

    const customerAutomation = await loadOwnedAutomation(adminClient, customerAutomationId, auth.user.id);
    if (!isOptInWebhookProduct(customerAutomation)) {
      return errorResponse("Webhook runtime setup is available only for products explicitly configured as Buyer webhook request products.", 409);
    }
    const ensured = await ensureConfig(adminClient, customerAutomationId, auth.user.id);
    let config = await expireTimedOutInboundTest(adminClient, ensured.config, auth.user.id);
    config = await reconcileReceivedInboundTest(adminClient, config, auth.user.id);

    if (action !== "load" && mutationBlocked(customerAutomation)) {
      return errorResponse("This automation is cancelled or expired, so its webhook settings are read-only.", 409);
    }

    if (action === "begin_inbound_test") {
      if (config.live_enabled === true) {
        return errorResponse("Pause live webhook requests before starting a new connection test.", 409);
      }
      const requestedTestEventId = cleanString(body.event_id || body.eventId);
      if (requestedTestEventId.length < 8 || requestedTestEventId.length > 200) {
        return errorResponse("Start the connection test with a unique event ID between 8 and 200 characters.", 400);
      }
      const testStartedAt = nowIso();
      config = await updateOwnedConfig(adminClient, config, auth.user.id, {
        inbound_status: "awaiting_test",
        inbound_test_started_at: testStartedAt,
        inbound_last_received_at: null,
        inbound_last_event_id: requestedTestEventId,
        inbound_last_payload_preview: {},
        inbound_confirmed_at: null,
        event_mapping_status: "not_configured",
        event_mapping_last_event_id: null,
        event_mapping_last_validated_at: null,
        event_mapping_last_error: null,
        event_mapping_preview: {},
        event_mapping_confirmed_at: null,
        live_enabled: false,
      });
      const { error: supersedeError } = await adminClient
        .from(TEST_TABLE)
        .update({ status: "failed", error_message: "Replaced by a newer connection test." })
        .eq("webhook_config_id", config.id)
        .eq("direction", "inbound")
        .eq("status", "pending");
      if (supersedeError) throw new Error(supersedeError.message);
      const { error: pendingError } = await adminClient.from(TEST_TABLE).insert({
        webhook_config_id: config.id,
        customer_automation_id: customerAutomationId,
        buyer_id: auth.user.id,
        direction: "inbound",
        status: "pending",
        event_id: requestedTestEventId,
        response_status: null,
        error_message: "Waiting for an authenticated request.",
        payload_preview: { connection_test_pending: true, started_at: testStartedAt },
        created_at: testStartedAt,
      });
      if (pendingError) throw new Error(pendingError.message);
    } else if (action === "rotate_secret") {
      const secret = randomSecret();
      const { data, error } = await adminClient
        .from(CONFIG_TABLE)
        .update({
          inbound_secret_hash: await sha256(secret),
          inbound_secret_hint: secret.slice(-6),
          inbound_status: "awaiting_test",
          inbound_test_started_at: null,
          inbound_last_received_at: null,
          inbound_last_event_id: null,
          inbound_last_payload_preview: {},
          inbound_confirmed_at: null,
          event_mapping_status: "not_configured",
          event_mapping_last_event_id: null,
          event_mapping_last_validated_at: null,
          event_mapping_last_error: null,
          event_mapping_preview: {},
          event_mapping_confirmed_at: null,
          live_enabled: false,
          updated_at: nowIso(),
        })
        .eq("id", config.id)
        .eq("buyer_id", auth.user.id)
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      config = data;
      ensured.newSecret = secret;
    } else if (action === "save_mapping") {
      const automation = one(customerAutomation.automations) || {};
      const schemas = webhookSchemas(automation);
      if (body.setup_values !== undefined) {
        const existingSetup = await loadSavedSetup(adminClient, customerAutomation.id, auth.user.id, schemas.inputFields);
        const savedValues = sanitizeWebhookSetupValues(body.setup_values, schemas.inputFields, existingSetup);
        await saveWebhookSetupValues(adminClient, customerAutomation, auth.user.id, schemas.inputFields, savedValues);
      }
      const mappings = normalizeEventMappings(body.mappings || body.event_mapping, schemas.eventFields);
      config = await updateOwnedConfig(adminClient, config, auth.user.id, {
        event_mapping: mappings,
        event_mapping_status: config.inbound_last_received_at ? "awaiting_validation" : "not_configured",
        event_mapping_last_event_id: null,
        event_mapping_last_validated_at: null,
        event_mapping_last_error: null,
        event_mapping_preview: {},
        event_mapping_confirmed_at: null,
      });
    } else if (action === "validate_mapping") {
      if (!config.inbound_last_received_at || !config.inbound_last_event_id) {
        return errorResponse("Send an inbound webhook test before validating event mapping.", 409);
      }
      const automation = one(customerAutomation.automations) || {};
      const schemas = webhookSchemas(automation);
      const savedSetup = await loadSavedSetup(adminClient, customerAutomation.id, auth.user.id, schemas.inputFields);
      let preview: any;
      try {
        preview = runtimeMappingPreview(config, customerAutomation, savedSetup);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Event mapping is invalid.";
        config = await updateOwnedConfig(adminClient, config, auth.user.id, {
          event_mapping_status: "validation_failed",
          event_mapping_last_event_id: config.inbound_last_event_id,
          event_mapping_last_validated_at: nowIso(),
          event_mapping_last_error: message,
          event_mapping_preview: {},
          event_mapping_confirmed_at: null,
        });
        return errorResponse(message, 422, { config: publicConfig(config) });
      }
      if (!preview?.ok) {
        const message = preview?.errors?.join(" ") || "One or more mapped event fields could not be resolved.";
        config = await updateOwnedConfig(adminClient, config, auth.user.id, {
          event_mapping_status: "validation_failed",
          event_mapping_last_event_id: config.inbound_last_event_id,
          event_mapping_last_validated_at: nowIso(),
          event_mapping_last_error: message,
          event_mapping_preview: preview?.envelope || {},
          event_mapping_confirmed_at: null,
        });
        return errorResponse(message, 422, { config: publicConfig(config), runtime_preview: preview?.envelope || {} });
      }
      config = await updateOwnedConfig(adminClient, config, auth.user.id, {
        event_mapping_status: "validated",
        event_mapping_last_event_id: config.inbound_last_event_id,
        event_mapping_last_validated_at: nowIso(),
        event_mapping_last_error: null,
        event_mapping_preview: preview.envelope,
        event_mapping_confirmed_at: null,
      });
    } else if (action === "confirm_mapping") {
      if (config.event_mapping_status !== "validated") {
        return errorResponse("Validate the event mapping successfully before confirming it.", 409);
      }
      if (!config.inbound_last_event_id || config.event_mapping_last_event_id !== config.inbound_last_event_id) {
        return errorResponse("A newer webhook test was received. Validate its event mapping before confirming.", 409);
      }
      config = await updateOwnedConfig(adminClient, config, auth.user.id, {
        event_mapping_status: "confirmed",
        event_mapping_confirmed_at: config.event_mapping_confirmed_at || nowIso(),
      });
    } else if (action === "activate") {
      const automation = one(customerAutomation.automations) || {};
      const order = one(customerAutomation.orders) || {};
      if (config.inbound_status !== "confirmed" || !config.inbound_confirmed_at) {
        return errorResponse("Confirm the inbound webhook connection before activating live requests.", 409);
      }
      if (config.event_mapping_status !== "confirmed" || !config.event_mapping_confirmed_at) {
        return errorResponse("Validate and confirm the latest event mapping before activating live requests.", 409);
      }
      if (cleanString(automation.pricing_type).toLowerCase() !== "monthly") {
        return errorResponse("Buyer webhook products must use monthly subscription pricing.", 409);
      }
      if (Number(automation.webhook_included_runs || 0) < 1) {
        return errorResponse("This product does not have a monthly webhook run allowance.", 409);
      }
      if (cleanString(order.payment_status).toLowerCase() !== "paid") {
        return errorResponse("The subscription payment is not active.", 409);
      }
      const subscriptionStatus = cleanString(order.stripe_subscription_status).toLowerCase();
      if (subscriptionStatus && !["active", "trialing"].includes(subscriptionStatus)) {
        return errorResponse("The subscription is not active.", 409);
      }
      const usage = await loadUsageSummary(adminClient, customerAutomation.id);
      if (!usage?.ok) return errorResponse(usage?.error || "Usage entitlement is not active.", 409);
      const { data, error } = await adminClient
        .from(CONFIG_TABLE)
        .update({ live_enabled: true, updated_at: nowIso() })
        .eq("id", config.id)
        .eq("buyer_id", auth.user.id)
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      config = data;
      const { error: stateError } = await adminClient
        .from("customer_automations")
        .update({
          setup_status: "completed",
          status: "active",
          runtime_status: "ready",
          updated_at: nowIso(),
        })
        .eq("id", customerAutomation.id)
        .eq("buyer_id", auth.user.id);
      if (stateError) throw new Error(stateError.message);
      customerAutomation.setup_status = "completed";
      customerAutomation.status = "active";
      customerAutomation.runtime_status = "ready";
    } else if (action === "deactivate") {
      const { data, error } = await adminClient
        .from(CONFIG_TABLE)
        .update({ live_enabled: false, updated_at: nowIso() })
        .eq("id", config.id)
        .eq("buyer_id", auth.user.id)
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      config = data;
      const { error: stateError } = await adminClient
        .from("customer_automations")
        .update({ setup_status: "completed", runtime_status: "paused", updated_at: nowIso() })
        .eq("id", customerAutomation.id)
        .eq("buyer_id", auth.user.id);
      if (stateError) throw new Error(stateError.message);
      customerAutomation.setup_status = "completed";
      customerAutomation.runtime_status = "paused";
    } else if (action === "save_outbound") {
      const destination = await assertSafeOutboundUrl(body.outbound_url || body.url);
      const { data, error } = await adminClient
        .from(CONFIG_TABLE)
        .update({
          outbound_url: destination,
          outbound_status: "awaiting_test",
          outbound_last_tested_at: null,
          outbound_last_status_code: null,
          outbound_last_error: null,
          outbound_confirmed_at: null,
          live_enabled: false,
          updated_at: nowIso(),
        })
        .eq("id", config.id)
        .eq("buyer_id", auth.user.id)
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      config = data;
    } else if (action === "test_outbound") {
      const result = await testOutbound(adminClient, {
        config,
        customerAutomation,
        buyerId: auth.user.id,
        requestedUrl: body.outbound_url || body.url,
      });
      config = result.config;
      if (!result.succeeded) {
        return errorResponse(result.error || "Webhook destination test failed.", 422, {
          config: publicConfig(config),
          event_id: result.eventId,
          response_status: result.responseStatus,
        });
      }
    } else if (action === "confirm") {
      const direction = cleanString(body.direction).toLowerCase();
      const updates: Record<string, unknown> = { live_enabled: false, updated_at: nowIso() };
      if (direction === "inbound") {
        if (!['test_received', 'confirmed'].includes(cleanString(config.inbound_status))) {
          return errorResponse("Send a successful inbound webhook test before confirming this connection.", 409);
        }
        const testStartedAt = Date.parse(cleanString(config.inbound_test_started_at));
        const requestReceivedAt = Date.parse(cleanString(config.inbound_last_received_at));
        if (!Number.isFinite(testStartedAt) || !Number.isFinite(requestReceivedAt) || requestReceivedAt < testStartedAt) {
          return errorResponse("Start a new connection test, then send a fresh authenticated request from your app before confirming.", 409);
        }
        updates.inbound_status = "confirmed";
        updates.inbound_confirmed_at = config.inbound_confirmed_at || nowIso();
      } else if (direction === "outbound") {
        if (!['test_succeeded', 'confirmed'].includes(cleanString(config.outbound_status))) {
          return errorResponse("Run a successful outbound destination test before confirming this connection.", 409);
        }
        updates.outbound_status = "confirmed";
        updates.outbound_confirmed_at = config.outbound_confirmed_at || nowIso();
      } else {
        return errorResponse("direction must be inbound or outbound.", 400);
      }

      const { data, error } = await adminClient
        .from(CONFIG_TABLE)
        .update(updates)
        .eq("id", config.id)
        .eq("buyer_id", auth.user.id)
        .select("*")
        .single();
      if (error) throw new Error(error.message);
      config = data;
    } else if (action !== "load") {
      return errorResponse("Unknown webhook configuration action.", 400);
    }

    if (config.live_enabled === true && !["completed", "complete"].includes(cleanString(customerAutomation.setup_status).toLowerCase())) {
      const { error: setupStateError } = await adminClient
        .from("customer_automations")
        .update({ setup_status: "completed", updated_at: nowIso() })
        .eq("id", customerAutomation.id)
        .eq("buyer_id", auth.user.id);
      if (setupStateError) throw new Error(setupStateError.message);
      customerAutomation.setup_status = "completed";
    }
    const automation = one(customerAutomation.automations) || {};
    const schemas = webhookSchemas(automation);
    const savedSetup = await loadSavedSetup(adminClient, customerAutomation.id, auth.user.id, schemas.inputFields);
    const tests = await loadRecentTests(adminClient, config.id, auth.user.id);
    const runtimePreview = config.event_mapping_preview && Object.keys(mappingObject(config.event_mapping_preview)).length > 0
      ? config.event_mapping_preview
      : null;
    const usage = await loadUsageSummary(adminClient, customerAutomation.id);
    if (action === "load" && config.live_enabled === true) wakeDueRuntimeDispatches();
    return jsonResponse({
      ok: true,
      test_only: config.live_enabled !== true,
      live_runtime_enabled: config.live_enabled === true,
      customer_automation: {
        id: customerAutomation.id,
        name: customerAutomation.name || "Automation",
        status: customerAutomation.status || "",
        setup_status: customerAutomation.setup_status || "",
        runtime_trigger_mode: customerAutomation.runtime_trigger_mode || "",
        runtime_response_mode: customerAutomation.runtime_response_mode || "",
      },
      automation: one(customerAutomation.automations),
      order: one(customerAutomation.orders),
      config: publicConfig(config),
      tests,
      setup_fields: schemas.setupFields,
      event_fields: schemas.eventFields,
      saved_setup: savedSetup,
      saved_setup_keys: Object.keys(savedSetup),
      event_source_paths: flattenEventPaths(config.inbound_last_payload_preview || {}),
      runtime_preview: runtimePreview,
      usage,
      topup_checkout_available: usage?.topup_units > 0 && usage?.topup_price > 0,
      new_secret: ensured.newSecret || "",
      secret_notice: ensured.newSecret
        ? "Copy this secret now. Nexus stores only its hash and cannot show it again."
        : "The secret is hidden. Rotate it to issue a new one.",
    });
  } catch (error) {
    console.error("buyer-webhook-config failed:", error);
    return errorResponse(error instanceof Error ? error.message : "Could not manage webhook setup.", 500);
  }
});
