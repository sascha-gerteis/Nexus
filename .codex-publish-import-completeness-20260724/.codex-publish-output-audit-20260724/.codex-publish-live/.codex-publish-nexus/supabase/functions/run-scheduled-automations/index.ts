import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const NEXUS_RUNTIME_SECRET = Deno.env.get("NEXUS_RUNTIME_SECRET") || "";
const N8N_BASE_URL = Deno.env.get("N8N_BASE_URL") || "";
const N8N_API_KEY = Deno.env.get("N8N_API_KEY") || "";

function nowIso() {
  return new Date().toISOString();
}

function cleanString(value: unknown) {
  return String(value ?? "").trim();
}

function cleanBaseUrl(value: unknown) {
  return cleanString(value).replace(/\/+$/, "");
}

function asObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function assignIfUseful(target: Record<string, unknown>, key: string, value: unknown) {
  if (target[key] !== undefined && cleanString(target[key])) return;
  if (value === undefined || value === null) return;
  if (Array.isArray(value) && !value.length) return;
  if (!Array.isArray(value) && !cleanString(value)) return;
  target[key] = value;
}

function pickSetupValue(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value) && value.length) return value;
    if (value !== undefined && value !== null && cleanString(value)) return value;
  }

  return undefined;
}

function joinSetupList(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => cleanString(item)).filter(Boolean).join("\n");
  return cleanString(value);
}

function expandBuyerSetupAliases(setup: Record<string, unknown>) {
  const output = { ...(setup || {}) };
  const companyUrl = pickSetupValue(output, [
    "company_url",
    "company_website",
    "main_website",
    "business_website",
    "buyer_website",
    "client_website",
    "customer_website",
  ]);
  const competitorUrls = pickSetupValue(output, [
    "competitor_urls",
    "competitor_websites",
    "competitor_sites",
    "competitors",
    "competitor_list",
  ]);
  const marketRegion = pickSetupValue(output, [
    "market_region",
    "market_or_region",
    "target_market",
    "local_market",
  ]);
  const targetCustomer = pickSetupValue(output, [
    "target_customer",
    "business_target_customer",
    "business_target_customer_profile",
    "business_target_audience",
    "target_audience",
    "ideal_customer",
    "buyer_persona",
    "customer_persona",
    "audience",
    "target_client",
  ]);

  if (companyUrl !== undefined) {
    for (const key of ["company_url", "company_website", "main_website"]) {
      assignIfUseful(output, key, companyUrl);
    }
  }

  if (competitorUrls !== undefined) {
    const joined = joinSetupList(competitorUrls);
    for (const key of ["competitor_urls", "competitor_websites", "competitor_sites"]) {
      assignIfUseful(output, key, competitorUrls);
    }
    for (const key of [
      "competitor_urls_join",
      "competitor_urls_joined",
      "competitor_urls_csv",
      "competitor_urls_lines",
      "competitor_websites_join",
    ]) {
      assignIfUseful(output, key, joined);
    }
  }

  if (marketRegion !== undefined) {
    for (const key of ["market_region", "market_or_region", "target_market"]) {
      assignIfUseful(output, key, marketRegion);
    }
  }

  if (targetCustomer !== undefined) {
    for (const key of [
      "target_customer",
      "business_target_customer",
      "business_target_customer_profile",
      "business_target_audience",
      "target_audience",
      "ideal_customer",
      "buyer_persona",
      "customer_persona",
      "audience",
      "target_client",
    ]) {
      assignIfUseful(output, key, targetCustomer);
    }
  }

  return output;
}

function sheetAccessConfigFromAutomation(automation: any) {
  const detected = asObject(automation?.detected_placeholders);
  const config = asObject(detected._nexus_sheet_access_config || automation?.sheet_access_config);
  const mode = cleanString(config.mode);

  return {
    mode: ["customer_owned", "developer_owned", "private_per_customer"].includes(mode)
      ? mode
      : "customer_owned",
    developer_sheet_id: cleanString(config.developer_sheet_id),
    template_sheet_id: cleanString(config.template_sheet_id),
    sheet_tab: cleanString(config.sheet_tab),
    sheet_range: cleanString(config.sheet_range),
  };
}

function applySheetAccessSetup(setup: Record<string, unknown>, automation: any, customerAutomation: any) {
  const config = sheetAccessConfigFromAutomation(automation);
  const output = { ...(setup || {}) };

  if (config.mode === "developer_owned" && config.developer_sheet_id) {
    assignIfUseful(output, "nexus_dev_sheet_id", config.developer_sheet_id);
    assignIfUseful(output, "google_sheet_id", config.developer_sheet_id);
    assignIfUseful(output, "google_sheet_url", config.developer_sheet_id);
  }

  if (config.mode === "private_per_customer" && config.template_sheet_id) {
    assignIfUseful(output, "nexus_private_sheet_template_id", config.template_sheet_id);
    assignIfUseful(output, "nexus_private_customer_sheet_id", cleanString(customerAutomation?.private_google_sheet_id) || config.template_sheet_id);
    assignIfUseful(output, "google_sheet_id", cleanString(customerAutomation?.private_google_sheet_id) || config.template_sheet_id);
    assignIfUseful(output, "nexus_private_sheet_customer_key", cleanString(customerAutomation?.id));
  }

  if (config.sheet_tab) {
    assignIfUseful(output, "nexus_sheet_tab", config.sheet_tab);
    assignIfUseful(output, "google_sheet_name", config.sheet_tab);
  }

  if (config.sheet_range) {
    assignIfUseful(output, "nexus_sheet_range", config.sheet_range);
    assignIfUseful(output, "google_sheet_range", config.sheet_range);
  }

  assignIfUseful(output, "google_sheet_access_mode", config.mode);
  return expandBuyerSetupAliases(output);
}

function pickFirstString(...values: unknown[]) {
  for (const value of values) {
    const cleaned = cleanString(value);
    if (cleaned) return cleaned;
  }

  return "";
}

function one(value: any) {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function addMonths(date: Date, months: number) {
  const next = new Date(date.getTime());
  const day = next.getUTCDate();

  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + months);

  const lastDay = new Date(
    Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
  ).getUTCDate();

  next.setUTCDate(Math.min(day, lastDay));
  return next;
}

function nextMonthlyDate(fromIso: string, reference = new Date()) {
  const start = fromIso ? new Date(fromIso) : reference;
  let candidate = addMonths(start, 1);

  while (candidate <= reference) {
    candidate = addMonths(candidate, 1);
  }

  return candidate.toISOString();
}

function nextScheduledDate(frequency: string, fromIso: string, reference = new Date()) {
  const start = fromIso ? new Date(fromIso) : reference;
  let candidate = new Date(start.getTime());

  const advance = () => {
    if (frequency === "every_30_minutes") {
      candidate.setUTCMinutes(candidate.getUTCMinutes() + 30);
      return;
    }
    if (frequency === "hourly") {
      candidate.setUTCHours(candidate.getUTCHours() + 1);
      return;
    }
    if (frequency === "daily") {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
      return;
    }
    if (frequency === "weekly") {
      candidate.setUTCDate(candidate.getUTCDate() + 7);
      return;
    }
    candidate = new Date(nextMonthlyDate(candidate.toISOString(), candidate));
  };

  advance();

  while (candidate <= reference) {
    advance();
  }

  return candidate.toISOString();
}

function scheduledDateKey(value: string, frequency = "monthly") {
  const date = value ? new Date(value) : new Date();
  const iso = date.toISOString();

  if (frequency === "every_30_minutes" || frequency === "hourly") {
    return iso.slice(0, 16);
  }

  return iso.slice(0, 10);
}

function runFrequency(customerAutomation: any) {
  const frequency = cleanString(customerAutomation?.run_frequency).toLowerCase();
  return ["every_30_minutes", "hourly", "daily", "weekly", "monthly"].includes(frequency)
    ? frequency
    : "monthly";
}

function normalizeWorkflowCloneMode(...values: unknown[]) {
  const raw = values
    .map((value) => cleanString(value))
    .find(Boolean)
    ?.toLowerCase()
    .replace(/[\s-]+/g, "_") || "";

  if (
    [
      "per_customer",
      "clone_per_customer",
      "customer_clone",
      "customer_cloned",
      "customer_workflow",
      "dedicated_customer_workflow",
      "isolated",
      "isolated_customer_workflow",
    ].includes(raw)
  ) {
    return "per_customer";
  }

  return "shared_product";
}

function shouldUseCustomerWorkflowClone(automation: any, order: any = null, customerAutomation: any = null) {
  return normalizeWorkflowCloneMode(
    customerAutomation?.runtime_workflow_mode,
    customerAutomation?.n8n_workflow_mode,
    automation?.runtime_workflow_mode,
    automation?.n8n_workflow_mode,
    automation?.workflow_isolation_mode,
    automation?.runtime_isolation_mode,
    automation?.customer_workflow_mode,
    automation?.runtime_customer_workflow_mode,
    order?.runtime_workflow_mode,
    order?.n8n_workflow_mode,
  ) === "per_customer";
}

function runtimeWorkflowId(customerAutomation: any, automation: any, order: any = null) {
  if (shouldUseCustomerWorkflowClone(automation, order, customerAutomation)) {
    return pickFirstString(
      customerAutomation?.n8n_workflow_id,
      automation?.n8n_workflow_id,
      order?.n8n_workflow_id,
    );
  }

  return pickFirstString(
    automation?.n8n_workflow_id,
    order?.n8n_workflow_id,
    customerAutomation?.n8n_workflow_id,
  );
}

function buildCallbackUrl() {
  return `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/runtime-submit-output`;
}

async function provisionCustomerWorkflowBeforeRun(customerAutomationId: string) {
  if (!SUPABASE_URL || !NEXUS_RUNTIME_SECRET || !customerAutomationId) {
    return null;
  }

  const response = await fetch(
    `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/provision-customer-workflow`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-nexus-runtime-secret": NEXUS_RUNTIME_SECRET,
      },
      body: JSON.stringify({
        customer_automation_id: customerAutomationId,
      }),
    },
  );

  const text = await response.text();
  let data: any = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok || data?.ok === false) {
    throw new Error(
      data?.error ||
        data?.message ||
        data?.raw ||
        `Could not provision customer workflow before run (${response.status}).`,
    );
  }

  return data;
}

function getRuntimeWebhookUrl(customerAutomation: any, automation: any, order: any) {
  if (shouldUseCustomerWorkflowClone(automation, order, customerAutomation)) {
    return pickFirstString(
      customerAutomation?.runtime_webhook_url,
      customerAutomation?.n8n_webhook_url,
      automation?.runtime_webhook_url,
      automation?.n8n_webhook_url,
      order?.runtime_webhook_url,
      order?.n8n_webhook_url,
    );
  }

  return pickFirstString(
    automation?.runtime_webhook_url,
    automation?.n8n_webhook_url,
    order?.runtime_webhook_url,
    order?.n8n_webhook_url,
    customerAutomation?.runtime_webhook_url,
    customerAutomation?.n8n_webhook_url,
  );
}

function getRuntimeWebhookPath(customerAutomation: any, automation: any, order: any) {
  if (shouldUseCustomerWorkflowClone(automation, order, customerAutomation)) {
    return pickFirstString(
      customerAutomation?.runtime_webhook_path,
      customerAutomation?.n8n_webhook_path,
      automation?.runtime_webhook_path,
      automation?.n8n_webhook_path,
      order?.runtime_webhook_path,
      order?.n8n_webhook_path,
    );
  }

  return pickFirstString(
    automation?.runtime_webhook_path,
    automation?.n8n_webhook_path,
    order?.runtime_webhook_path,
    order?.n8n_webhook_path,
    customerAutomation?.runtime_webhook_path,
    customerAutomation?.n8n_webhook_path,
  );
}

function hasCustomerRuntimeTarget(customerAutomation: any) {
  return Boolean(
    pickFirstString(
      customerAutomation?.runtime_webhook_url,
      customerAutomation?.n8n_webhook_url,
      customerAutomation?.runtime_webhook_path,
      customerAutomation?.n8n_webhook_path,
    ),
  );
}

function subscriptionIsActive(order: any) {
  if (!order) return false;

  const paymentStatus = cleanString(order.payment_status).toLowerCase();
  const orderStatus = cleanString(order.order_status).toLowerCase();
  const stripeStatus = cleanString(order.stripe_subscription_status).toLowerCase();

  if (paymentStatus !== "paid") return false;

  if (
    orderStatus.includes("cancel") ||
    orderStatus.includes("expired") ||
    orderStatus.includes("failed")
  ) {
    return false;
  }

  if (stripeStatus) {
    return stripeStatus === "active" || stripeStatus === "trialing";
  }

  return Boolean(order.stripe_subscription_id || order.stripe_mode === "subscription");
}

function setupIsReady(customerAutomation: any) {
  const setupStatus = cleanString(customerAutomation?.setup_status).toLowerCase();
  const status = cleanString(customerAutomation?.status).toLowerCase();

  return (
    setupStatus === "submitted" ||
    setupStatus === "completed" ||
    setupStatus.includes("submitted") ||
    setupStatus.includes("complete") ||
    status === "active"
  );
}

function scheduleIsRunnable(customerAutomation: any, order: any, webhookUrl: string) {
  const isSubscriptionOrder = Boolean(order?.stripe_subscription_id || order?.stripe_mode === "subscription");
  const paymentStatus = cleanString(order?.payment_status).toLowerCase();

  if (isSubscriptionOrder && !subscriptionIsActive(order)) {
    return { ok: false, reason: "subscription_not_active" };
  }

  if (!isSubscriptionOrder && paymentStatus && paymentStatus !== "paid") {
    return { ok: false, reason: "payment_not_paid" };
  }

  if (!setupIsReady(customerAutomation)) {
    return { ok: false, reason: "setup_not_ready" };
  }

  if (!webhookUrl) {
    return { ok: false, reason: "missing_runtime_webhook" };
  }

  const statusText = [
    customerAutomation?.status,
    customerAutomation?.setup_status,
    customerAutomation?.health_status,
  ].map((item) => cleanString(item).toLowerCase()).join(" ");

  if (
    statusText.includes("cancel") ||
    statusText.includes("payment_failed") ||
    statusText.includes("blocked")
  ) {
    return { ok: false, reason: "automation_not_runnable" };
  }

  return { ok: true, reason: "ready" };
}

async function requireOperator(req: Request, body: any, adminClient: any) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const headerSecret = req.headers.get("x-nexus-runtime-secret") || "";
  const bodySecret = cleanString(body.runtime_secret || body.system?.runtime_secret);

  if (SUPABASE_SERVICE_ROLE_KEY && token === SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: true, internal: true, user: null };
  }

  if (NEXUS_RUNTIME_SECRET && (headerSecret === NEXUS_RUNTIME_SECRET || bodySecret === NEXUS_RUNTIME_SECRET)) {
    return { ok: true, internal: true, user: null };
  }

  if (!token) {
    return { ok: false, error: "Authentication required." };
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data, error } = await userClient.auth.getUser(token);

  if (error || !data?.user) {
    return { ok: false, error: "Invalid auth token." };
  }

  const { data: profile } = await adminClient
    .from("profiles")
    .select("role")
    .eq("id", data.user.id)
    .maybeSingle();

  if (profile?.role === "admin" || profile?.role === "admin_staff") {
    return { ok: true, internal: false, user: data.user, role: profile.role, developer: null };
  }

  if (profile?.role === "developer") {
    const { data: developer, error: developerError } = await adminClient
      .from("developers")
      .select("id, profile_id, status")
      .eq("profile_id", data.user.id)
      .maybeSingle();

    if (developerError) {
      return { ok: false, error: developerError.message };
    }

    if (!developer) {
      return { ok: false, error: "Developer profile not found." };
    }

    return { ok: true, internal: false, user: data.user, role: "developer", developer };
  }

  if (profile?.role === "buyer" || !profile?.role) {
    return { ok: true, internal: false, user: data.user, role: "buyer", developer: null };
  }

  return { ok: false, error: "Admin, developer, or buyer access required." };
}

function developerOwnsCandidate(row: any, developerId: string) {
  const id = cleanString(developerId);
  if (!id) return false;

  const automation = one(row?.automations) || {};
  const order = one(row?.orders) || {};

  return cleanString(automation?.developer_id) === id ||
    cleanString(order?.developer_id) === id;
}

function buyerOwnsCandidate(row: any, buyerId: string) {
  const id = cleanString(buyerId);
  if (!id) return false;

  return cleanString(row?.buyer_id) === id;
}

async function loadLatestSetupValues(adminClient: any, customerAutomationId: string) {
  const { data, error } = await adminClient
    .from("automation_setup_submissions")
    .select("answers")
    .eq("customer_automation_id", customerAutomationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not load setup values: ${error.message}`);
  }

  return {
    answers: asObject(data?.answers),
    setupAnswers: asObject(data?.setup_answers || data?.answers),
  };
}

async function loadSecretValues(adminClient: any, customerAutomationId: string) {
  const { data, error } = await adminClient
    .from("customer_automation_credentials")
    .select("key, credential_key, value, credential_value, secret_value")
    .eq("customer_automation_id", customerAutomationId);

  if (error) {
    throw new Error(`Could not load customer credentials: ${error.message}`);
  }

  const secrets: Record<string, string> = {};

  for (const row of data || []) {
    const key = cleanString(row.key || row.credential_key);
    const value = cleanString(row.value || row.credential_value || row.secret_value);

    if (key && value) {
      secrets[key] = value;
    }
  }

  return secrets;
}

async function insertAutomationEvent(adminClient: any, payload: Record<string, unknown>) {
  const { error } = await adminClient.from("automation_events").insert({
    ...payload,
    created_at: nowIso(),
  });

  if (error) {
    console.warn("automation_events insert failed:", error.message);
  }
}

async function updateCustomerAutomation(adminClient: any, id: string, payload: Record<string, unknown>) {
  const { error } = await adminClient
    .from("customer_automations")
    .update(payload)
    .eq("id", id);

  if (!error) return;

  const fallback = { ...payload };
  for (const key of [
    "run_frequency",
    "schedule_status",
    "schedule_anchor_at",
    "next_run_at",
    "last_run_at",
    "last_run_requested_at",
    "last_error_code",
    "last_error_node",
    "last_error_details",
    "last_failed_at",
    "needs_customer_action",
  ]) {
    delete fallback[key];
  }

  await adminClient
    .from("customer_automations")
    .update(fallback)
    .eq("id", id);
}

async function createRunRecord(adminClient: any, payload: Record<string, unknown>) {
  const { data, error } = await adminClient
    .from("automation_runs")
    .insert(payload)
    .select()
    .single();

  if (!error) {
    return { data, duplicate: false };
  }

  const message = cleanString(error.message).toLowerCase();

  if (message.includes("duplicate") || message.includes("unique")) {
    const runKey = cleanString(payload.run_key);
    const { data: existing } = await adminClient
      .from("automation_runs")
      .select("*")
      .eq("run_key", runKey)
      .maybeSingle();

    return { data: existing, duplicate: true };
  }

  throw new Error(error.message);
}

async function updateRunRecord(adminClient: any, runId: string, payload: Record<string, unknown>) {
  const { error } = await adminClient
    .from("automation_runs")
    .update(payload)
    .eq("id", runId);

  if (!error) return;

  const fallback = { ...payload };
  delete fallback.response_payload;
  delete fallback.request_payload;
  delete fallback.trigger_source;
  delete fallback.scheduled_for;
  delete fallback.run_key;

  await adminClient
    .from("automation_runs")
    .update(fallback)
    .eq("id", runId);
}

function buildRuntimePayload(params: {
  customerAutomation: any;
  automation: any;
  order: any;
  setupAnswers: Record<string, unknown>;
  secrets: Record<string, string>;
  savedCredentialKeys: string[];
  eventPayload?: Record<string, unknown>;
  run: any;
  runKey: string;
  scheduledFor: string;
}) {
  const customerAutomation = params.customerAutomation;
  const order = params.order || {};
  const frequency = runFrequency(customerAutomation);

  return {
    customer_automation_id: customerAutomation.id,
    automation_id: customerAutomation.automation_id,
    order_id: customerAutomation.order_id,
    buyer_id: customerAutomation.buyer_id,
    run_id: params.run?.id || "",
    run_key: params.runKey,

    setup: applySheetAccessSetup(params.setupAnswers || {}, params.automation, customerAutomation),
    event: asObject(params.eventPayload),
    request: asObject(params.eventPayload),
    secrets: params.secrets || {},

    customer: {
      id: customerAutomation.buyer_id || order.buyer_id || "",
      email: order.buyer_email || "",
      name: order.buyer_name || "",
      company: order.buyer_company || "",
      order_id: customerAutomation.order_id || order.id || "",
    },

    schedule: {
      frequency,
      scheduled_for: params.scheduledFor,
      run_key: params.runKey,
    },

    system: {
      customer_automation_id: customerAutomation.id,
      automation_id: customerAutomation.automation_id,
      order_id: customerAutomation.order_id,
      buyer_id: customerAutomation.buyer_id,
      run_id: params.run?.id || "",
      run_key: params.runKey,
      callback_url: buildCallbackUrl(),
      runtime_secret: NEXUS_RUNTIME_SECRET,
      saved_credential_keys: params.savedCredentialKeys || [],
      runtime_type: customerAutomation.runtime_type || params.automation?.runtime_type || "n8n_managed",
      runtime_webhook_path: getRuntimeWebhookPath(customerAutomation, params.automation, order),
      n8n_workflow_id: runtimeWorkflowId(customerAutomation, params.automation, order),
    },
  };
}

function buildRedactedRequestPayload(payload: any) {
  return {
    customer_automation_id: payload.customer_automation_id,
    automation_id: payload.automation_id,
    order_id: payload.order_id,
    buyer_id: payload.buyer_id,
    run_id: payload.run_id,
    run_key: payload.run_key,
    setup_keys: Object.keys(asObject(payload.setup)),
    secret_keys_available: Object.keys(asObject(payload.secrets)),
    event_keys: Object.keys(asObject(payload.event)),
    schedule: payload.schedule || {},
    system: {
      callback_url: payload.system?.callback_url || "",
      runtime_type: payload.system?.runtime_type || "",
      runtime_webhook_path: payload.system?.runtime_webhook_path || "",
      n8n_workflow_id: payload.system?.n8n_workflow_id || "",
    },
  };
}

async function triggerWebhook(webhookUrl: string, payload: any) {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-nexus-runtime-secret": NEXUS_RUNTIME_SECRET,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let data: any = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw_response: text };
  }

  if (!response.ok) {
    throw new Error(
      data?.message ||
        data?.error ||
        text ||
        `Runtime webhook failed with status ${response.status}.`,
    );
  }

  return {
    status: response.status,
    data,
  };
}

function isWebhookNotRegistered(error: unknown) {
  const message = error instanceof Error ? error.message : cleanString(error);
  const lower = message.toLowerCase();

  return lower.includes("webhook") &&
    (lower.includes("not registered") || lower.includes("requested webhook"));
}

function activationFailureNeedsReprovision(error: unknown) {
  const message = error instanceof Error ? error.message : cleanString(error);
  const lower = message.toLowerCase();

  return (
    lower.includes("cannot be activated") ||
    lower.includes("no trigger node") ||
    lower.includes("at least one trigger") ||
    lower.includes("workflow does not exist") ||
    lower.includes("not found")
  );
}

function classifyRuntimeStartError(message: string) {
  const lower = cleanString(message).toLowerCase();
  const credentialSignals = [
    "invalid token",
    "access token",
    "oauth",
    "oauth token",
    "unauthorized",
    "authorisation",
    "authorization",
    "authentication",
    "forbidden",
    "access denied",
    "access_denied",
    "permission",
    "permissions",
    "scope",
    "invalid grant",
    "invalid_grant",
    "invalid client",
    "invalid_client",
    "invalid api key",
    "api key invalid",
    "expired token",
    "token expired",
    "token has expired",
    "invalid credentials",
    "credential",
  ];
  const customerInputSignals = [
    "invalid page id",
    "invalid object id",
    "unsupported get request",
    "invalid url",
    "invalid channel id",
    "invalid username",
    "invalid handle",
    "missing required field",
    "required field",
    "required parameter",
    "parameter is required",
  ];

  if (credentialSignals.some((signal) => lower.includes(signal))) {
    return {
      needsCustomerAction: true,
      lastErrorCode: "CUSTOMER_CREDENTIAL_INVALID",
      status: "setup_error",
      healthStatus: "needs_customer_action",
      setupStatus: "needs_update",
      customerMessage:
        "The credentials for this automation are invalid, expired, or missing required permissions. Please update your setup details to continue.",
    };
  }

  if (customerInputSignals.some((signal) => lower.includes(signal))) {
    return {
      needsCustomerAction: true,
      lastErrorCode: "CUSTOMER_SETUP_INVALID",
      status: "setup_error",
      healthStatus: "needs_customer_action",
      setupStatus: "needs_update",
      customerMessage:
        "Some setup details for this automation look incorrect or incomplete. Please review the setup form and submit it again.",
    };
  }

  return {
    needsCustomerAction: false,
    lastErrorCode: "RUNTIME_START_FAILED",
    status: "error",
    healthStatus: "error",
    setupStatus: "",
    customerMessage: "This automation could not be started. Nexus has been notified.",
  };
}

async function n8nApiRequest(path: string, options: RequestInit = {}) {
  const baseUrl = cleanBaseUrl(N8N_BASE_URL);
  const apiKey = cleanString(N8N_API_KEY);

  if (!baseUrl || !apiKey) {
    throw new Error("Missing N8N_BASE_URL or N8N_API_KEY Supabase secrets.");
  }

  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
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
    throw new Error(
      data?.message ||
        data?.error ||
        data?.raw ||
        `n8n API failed (${response.status}).`,
    );
  }

  return data;
}

function runtimeWorkflowWebhookPaths(workflow: any) {
  const workflowRecord = Array.isArray(workflow?.nodes)
    ? workflow
    : Array.isArray(workflow?.data?.nodes)
      ? workflow.data
      : Array.isArray(workflow?.workflow?.nodes)
        ? workflow.workflow
        : workflow;
  const nodes = Array.isArray(workflowRecord?.nodes) ? workflowRecord.nodes : [];

  return nodes
    .filter((node: any) =>
      cleanString(node?.type).toLowerCase().includes("n8n-nodes-base.webhook")
    )
    .map((node: any) => cleanString(node?.parameters?.path))
    .filter(Boolean);
}

async function loadRuntimeWorkflowWebhookPath(workflowId: string) {
  const id = cleanString(workflowId);
  if (!id) return "";

  try {
    const workflow = await n8nApiRequest(`/api/v1/workflows/${encodeURIComponent(id)}`, {
      method: "GET",
    });

    return runtimeWorkflowWebhookPaths(workflow)[0] || "";
  } catch (_error) {
    return "";
  }
}

async function activateRuntimeWorkflowById(workflowId: string) {
  const id = cleanString(workflowId);
  if (!id) {
    throw new Error("Cannot activate n8n workflow because no workflow ID is stored.");
  }

  try {
    const result = await n8nApiRequest(`/api/v1/workflows/${encodeURIComponent(id)}/activate`, {
      method: "POST",
      body: JSON.stringify({}),
    });

    return {
      ok: true,
      workflow_id: id,
      result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : cleanString(error);

    if (message.toLowerCase().includes("active")) {
      return {
        ok: true,
        already_active: true,
        workflow_id: id,
      };
    }

    throw error;
  }
}

function extractExecutionId(responseBody: any) {
  return pickFirstString(
    responseBody?.executionId,
    responseBody?.execution_id,
    responseBody?.data?.executionId,
    responseBody?.data?.execution_id,
    responseBody?.id,
  );
}

async function loadCandidates(adminClient: any, options: {
  action: string;
  id?: string;
  title?: string;
  limit: number;
}) {
  if (options.id) {
    const { data, error } = await adminClient
      .from("customer_automations")
      .select("*, automations(*), orders(*)")
      .eq("id", options.id)
      .maybeSingle();

    if (error) throw new Error(error.message);
    return data ? [data] : [];
  }

  if (options.title) {
    const { data, error } = await adminClient
      .from("customer_automations")
      .select("*, automations!inner(*), orders(*)")
      .ilike("automations.title", `%${options.title}%`)
      .order("last_run_requested_at", { ascending: false, nullsFirst: false })
      .order("updated_at", { ascending: false, nullsFirst: false })
      .limit(options.limit);

    if (error) throw new Error(error.message);
    return data || [];
  }

  if (options.action === "run_latest") {
    const { data, error } = await adminClient
      .from("customer_automations")
      .select("*, automations(*), orders(*)")
      .order("last_run_requested_at", { ascending: false, nullsFirst: false })
      .order("updated_at", { ascending: false, nullsFirst: false })
      .limit(1);

    if (error) throw new Error(error.message);
    return data || [];
  }

  const { data, error } = await adminClient
    .from("customer_automations")
    .select("*, automations(*), orders(*)")
    .eq("schedule_status", "active")
    .not("run_frequency", "in", "(manual,on_demand)")
    .lte("next_run_at", nowIso())
    .order("next_run_at", { ascending: true })
    .limit(options.limit);

  if (error) throw new Error(error.message);
  return data || [];
}

async function runCandidate(adminClient: any, row: any, options: {
  action: string;
  dryRun: boolean;
  advanceSchedule: boolean;
  allowInactiveSubscription?: boolean;
  eventPayload?: Record<string, unknown>;
}) {
  const customerAutomation = row;
  let automation = one(row.automations) || {};
  const order = one(row.orders) || {};
  const isManualRun = options.action === "run_one" ||
    options.action === "run_latest" ||
    options.action === "run_matching";
  const useCustomerWorkflowClone = shouldUseCustomerWorkflowClone(automation, order, customerAutomation);

  if (!options.dryRun && isManualRun) {
    const hasN8nTemplate = Boolean(
      automation?.n8n_workflow_id ||
        order?.n8n_workflow_id ||
        automation?.runtime_webhook_url ||
        automation?.n8n_webhook_url ||
        order?.runtime_webhook_url ||
        order?.n8n_webhook_url ||
        (useCustomerWorkflowClone && (
          customerAutomation.n8n_workflow_id ||
          customerAutomation.runtime_webhook_url ||
          customerAutomation.n8n_webhook_url
        )),
    );

    if (useCustomerWorkflowClone && hasN8nTemplate && !hasCustomerRuntimeTarget(customerAutomation)) {
      const provisionResult = await provisionCustomerWorkflowBeforeRun(customerAutomation.id);
      if (provisionResult?.customer_automation) {
        Object.assign(customerAutomation, provisionResult.customer_automation);
      }
      if (provisionResult?.workflow_id) {
        customerAutomation.n8n_workflow_id = provisionResult.workflow_id;
      }
      if (provisionResult?.webhook_path) {
        customerAutomation.runtime_webhook_path = provisionResult.webhook_path;
      }
      if (provisionResult?.webhook_url) {
        customerAutomation.runtime_webhook_url = provisionResult.webhook_url;
      }
      automation = one(customerAutomation.automations) || automation;
    }
  }

  let webhookUrl = getRuntimeWebhookUrl(customerAutomation, automation, order);
  const eligibility = scheduleIsRunnable(customerAutomation, order, webhookUrl);
  const frequency = runFrequency(customerAutomation);
  const scheduledFor = isManualRun
    ? nowIso()
    : cleanString(customerAutomation.next_run_at) || nowIso();

  const canBypassInactiveSubscription = isManualRun &&
    options.allowInactiveSubscription === true &&
    eligibility.reason === "subscription_not_active";

  if (!eligibility.ok && !canBypassInactiveSubscription) {
    return {
      customer_automation_id: customerAutomation.id,
      status: "skipped",
      reason: eligibility.reason,
    };
  }

  if (options.dryRun) {
    return {
      customer_automation_id: customerAutomation.id,
      status: "ready",
      scheduled_for: scheduledFor,
      webhook_path: getRuntimeWebhookPath(customerAutomation, automation, order),
    };
  }

  const runKey = isManualRun
    ? `manual:${customerAutomation.id}:${Date.now()}`
    : `${frequency}:${customerAutomation.id}:${scheduledDateKey(scheduledFor, frequency)}`;

  const setupValues = await loadLatestSetupValues(adminClient, customerAutomation.id);
  const secrets = await loadSecretValues(adminClient, customerAutomation.id);

  const provisionalPayload = {
    customer_automation_id: customerAutomation.id,
    automation_id: customerAutomation.automation_id,
    order_id: customerAutomation.order_id,
    buyer_id: customerAutomation.buyer_id,
    run_id: "",
    run_key: runKey,
    setup: expandBuyerSetupAliases(setupValues.setupAnswers),
    secrets,
    schedule: {
      frequency,
      scheduled_for: scheduledFor,
      run_key: runKey,
    },
    event: asObject(options.eventPayload),
    system: {
      callback_url: buildCallbackUrl(),
      runtime_type: customerAutomation.runtime_type || automation?.runtime_type || "n8n_managed",
      runtime_webhook_path: getRuntimeWebhookPath(customerAutomation, automation, order),
      n8n_workflow_id: runtimeWorkflowId(customerAutomation, automation, order),
    },
  };

  const { data: run, duplicate } = await createRunRecord(adminClient, {
    customer_automation_id: customerAutomation.id,
    buyer_id: customerAutomation.buyer_id,
    automation_id: customerAutomation.automation_id,
    order_id: customerAutomation.order_id,
    runtime_type: customerAutomation.runtime_type || automation?.runtime_type || "n8n_managed",
    trigger_type: isManualRun ? "manual_admin" : `scheduled_${frequency}`,
    trigger_source: "run-scheduled-automations",
    run_key: runKey,
    scheduled_for: scheduledFor,
    status: "running",
    request_payload: buildRedactedRequestPayload(provisionalPayload),
    started_at: nowIso(),
    created_at: nowIso(),
    updated_at: nowIso(),
  });

  if (duplicate) {
    return {
      customer_automation_id: customerAutomation.id,
      run_id: run?.id || null,
      run_key: runKey,
      status: "skipped",
      reason: "duplicate_run_key",
    };
  }

  const runtimePayload = buildRuntimePayload({
    customerAutomation,
    automation,
    order,
    setupAnswers: setupValues.setupAnswers,
    secrets,
    savedCredentialKeys: Object.keys(secrets),
    eventPayload: options.eventPayload || {},
    run,
    runKey,
    scheduledFor,
  });

  try {
    let response: any;

    try {
      response = await triggerWebhook(webhookUrl, runtimePayload);
    } catch (error) {
      if (!isWebhookNotRegistered(error)) throw error;

      const workflowId = runtimeWorkflowId(customerAutomation, automation, order);
      let activation: Record<string, unknown> = {};
      let shouldReprovision = false;

      try {
        activation = await activateRuntimeWorkflowById(workflowId);
      } catch (activationError) {
        if (!activationFailureNeedsReprovision(activationError)) throw activationError;

        shouldReprovision = true;
        activation = {
          ok: false,
          reprovision_required: true,
          error: activationError instanceof Error ? activationError.message : cleanString(activationError),
        };
      }

      if (!shouldReprovision) {
        const refreshedWebhookPath = await loadRuntimeWorkflowWebhookPath(workflowId);
        const n8nBaseUrl = cleanBaseUrl(N8N_BASE_URL);

        if (refreshedWebhookPath && n8nBaseUrl) {
          webhookUrl = `${n8nBaseUrl}/webhook/${refreshedWebhookPath}`;
          runtimePayload.system.runtime_webhook_path = refreshedWebhookPath;
          runtimePayload.system.n8n_workflow_id = runtimeWorkflowId(customerAutomation, automation, order);

          if (!useCustomerWorkflowClone && automation?.id) {
            await adminClient
              .from("automations")
              .update({
                runtime_webhook_path: refreshedWebhookPath,
                runtime_webhook_url: webhookUrl,
                n8n_webhook_url: webhookUrl,
                updated_at: nowIso(),
              })
              .eq("id", automation.id);
          }
        }

        try {
          response = await triggerWebhook(webhookUrl, runtimePayload);
          response.data = {
            ...(response.data || {}),
            nexus_activation_retry: activation,
          };
        } catch (retryError) {
          if (!isWebhookNotRegistered(retryError)) throw retryError;
          shouldReprovision = true;
        }
      }

      if (shouldReprovision && shouldUseCustomerWorkflowClone(automation, order, customerAutomation)) {
        const provisionResult = await provisionCustomerWorkflowBeforeRun(customerAutomation.id);
        if (provisionResult?.customer_automation) {
          Object.assign(customerAutomation, provisionResult.customer_automation);
        }
        if (provisionResult?.workflow_id) {
          customerAutomation.n8n_workflow_id = provisionResult.workflow_id;
        }
        if (provisionResult?.webhook_path) {
          customerAutomation.runtime_webhook_path = provisionResult.webhook_path;
        }
        if (provisionResult?.webhook_url) {
          customerAutomation.runtime_webhook_url = provisionResult.webhook_url;
        }

        webhookUrl = getRuntimeWebhookUrl(customerAutomation, automation, order);
        runtimePayload.system.runtime_webhook_path = getRuntimeWebhookPath(customerAutomation, automation, order);
        runtimePayload.system.n8n_workflow_id = runtimeWorkflowId(customerAutomation, automation, order);

        response = await triggerWebhook(webhookUrl, runtimePayload);
        response.data = {
          ...(response.data || {}),
          nexus_activation_retry: activation,
          nexus_reprovision_retry: {
            workflow_id: provisionResult?.workflow_id || "",
            webhook_path: provisionResult?.webhook_path || "",
          },
        };
      } else if (shouldReprovision) {
        throw new Error(
          "The product workflow webhook is not registered. Publish or activate the product workflow in n8n, then run again.",
        );
      }
    }

    const n8nExecutionId = extractExecutionId(response.data);
    const now = nowIso();

    await updateRunRecord(adminClient, run.id, {
      status: "running",
      n8n_execution_id: n8nExecutionId || null,
      response_payload: response,
      updated_at: now,
    });

    const updatePayload: Record<string, unknown> = {
      status: "running",
      runtime_status: "running",
      health_status: "running",
      last_run_requested_at: now,
      last_run_at: now,
      updated_at: now,
    };

    if (options.advanceSchedule) {
      updatePayload.schedule_status = "active";
      updatePayload.schedule_anchor_at = customerAutomation.schedule_anchor_at || scheduledFor;
      updatePayload.next_run_at = nextScheduledDate(frequency, scheduledFor, new Date());
    }

    await updateCustomerAutomation(adminClient, customerAutomation.id, updatePayload);

    await insertAutomationEvent(adminClient, {
      customer_automation_id: customerAutomation.id,
      buyer_id: customerAutomation.buyer_id,
      automation_id: customerAutomation.automation_id,
      order_id: customerAutomation.order_id,
      event_type: isManualRun
        ? "manual_runtime_triggered"
        : "scheduled_runtime_triggered",
      title: isManualRun
        ? "Manual automation run started"
        : `${frequency.replaceAll("_", " ")} automation run started`,
      message: JSON.stringify({
        run_id: run.id,
        run_key: runKey,
        scheduled_for: scheduledFor,
        next_run_at: updatePayload.next_run_at || customerAutomation.next_run_at || null,
        n8n_execution_id: n8nExecutionId || null,
      }),
      created_by: "runtime",
    });

    return {
      customer_automation_id: customerAutomation.id,
      run_id: run.id,
      run_key: runKey,
      status: "triggered",
      scheduled_for: scheduledFor,
      next_run_at: updatePayload.next_run_at || null,
      n8n_execution_id: n8nExecutionId || null,
    };
  } catch (error) {
    const now = nowIso();
    const message = error instanceof Error ? error.message : String(error);
    const classification = classifyRuntimeStartError(message);

    await updateRunRecord(adminClient, run.id, {
      status: "error",
      finished_at: now,
      updated_at: now,
      error_message: message,
      response_payload: {
        error: message,
      },
    });

    const updatePayload: Record<string, unknown> = {
      status: classification.status,
      runtime_status: "error",
      health_status: classification.healthStatus,
      last_error_code: classification.lastErrorCode,
      last_error_message: classification.customerMessage,
      last_error_details: {
        source: "run-scheduled-automations",
        error: message,
      },
      needs_customer_action: classification.needsCustomerAction,
      last_failed_at: now,
      updated_at: now,
    };

    if (classification.setupStatus) {
      updatePayload.setup_status = classification.setupStatus;
    }

    await updateCustomerAutomation(adminClient, customerAutomation.id, updatePayload);

    await insertAutomationEvent(adminClient, {
      customer_automation_id: customerAutomation.id,
      buyer_id: customerAutomation.buyer_id,
      automation_id: customerAutomation.automation_id,
      order_id: customerAutomation.order_id,
      event_type: classification.needsCustomerAction
        ? "customer_action_required"
        : "scheduled_runtime_error",
      title: classification.needsCustomerAction
        ? "Customer action required"
        : `${frequency.replaceAll("_", " ")} automation run failed to start`,
      message: JSON.stringify({
        run_id: run.id,
        run_key: runKey,
        scheduled_for: scheduledFor,
        error: message,
        customer_message: classification.customerMessage,
        needs_customer_action: classification.needsCustomerAction,
      }),
      created_by: "runtime",
    });

    return {
      customer_automation_id: customerAutomation.id,
      run_id: run.id,
      run_key: runKey,
      status: "error",
      error: message,
    };
  }
}

async function loadCandidateStatus(adminClient: any, row: any) {
  const customerAutomation = row || {};
  const automation = one(customerAutomation.automations) || {};

  const [{ data: runs, error: runsError }, { data: outputs, error: outputsError }] = await Promise.all([
    adminClient
      .from("automation_runs")
      .select("id, status, run_key, n8n_execution_id, error_message, created_at, updated_at, finished_at")
      .eq("customer_automation_id", customerAutomation.id)
      .order("created_at", { ascending: false })
      .limit(5),
    adminClient
      .from("automation_outputs")
      .select("id, title, status, output_type, created_at, updated_at")
      .eq("customer_automation_id", customerAutomation.id)
      .order("created_at", { ascending: false })
      .limit(5),
  ]);

  if (runsError) throw new Error(runsError.message);
  if (outputsError) throw new Error(outputsError.message);

  return {
    customer_automation_id: customerAutomation.id,
    automation_id: customerAutomation.automation_id,
    automation_title: automation.title || customerAutomation.title || "",
    status: customerAutomation.status || "",
    runtime_status: customerAutomation.runtime_status || "",
    health_status: customerAutomation.health_status || "",
    setup_status: customerAutomation.setup_status || "",
    last_run_requested_at: customerAutomation.last_run_requested_at || null,
    last_run_at: customerAutomation.last_run_at || null,
    last_error_message: customerAutomation.last_error_message || "",
    latest_runs: runs || [],
    latest_outputs: outputs || [],
  };
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
      message: "run-scheduled-automations is alive.",
      env: {
        has_supabase_url: Boolean(SUPABASE_URL),
        has_service_role: Boolean(SUPABASE_SERVICE_ROLE_KEY),
        has_runtime_secret: Boolean(NEXUS_RUNTIME_SECRET),
      },
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed.", 405);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const action = cleanString(body.action || "run_due");
    const limit = Math.max(1, Math.min(Number(body.limit || 25), 100));

    if (!["dry_run", "run_due", "run_one", "run_latest", "run_matching", "latest_status"].includes(action)) {
      return errorResponse("Unknown action.", 400);
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return errorResponse("Missing Supabase function secrets.", 500);
    }

    if (!NEXUS_RUNTIME_SECRET) {
      return errorResponse("Missing NEXUS_RUNTIME_SECRET.", 500);
    }

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const auth: any = await requireOperator(req, body, adminClient);

    if (!auth.ok) {
      return errorResponse(auth.error || "Unauthorized.", 401);
    }

    const customerAutomationId = cleanString(
      body.customer_automation_id ||
        body.customerAutomationId ||
        body.id,
    );
    const automationTitle = cleanString(
      body.automation_title ||
        body.automationTitle ||
        body.title,
    );

    if (action === "run_one" && !customerAutomationId) {
      return errorResponse("customer_automation_id is required for run_one.", 400);
    }

    if (action === "run_matching" && !automationTitle) {
      return errorResponse("automation_title is required for run_matching.", 400);
    }

    let rows = await loadCandidates(adminClient, {
      action: action === "latest_status" ? "run_latest" : action,
      id: customerAutomationId,
      title: automationTitle,
      limit,
    });

    if (auth.role === "developer") {
      if (action !== "run_one") {
        return errorResponse("Developers can only run one owned customer automation at a time.", 403);
      }

      const developerId = cleanString(auth.developer?.id);
      rows = rows.filter((row: any) => developerOwnsCandidate(row, developerId));

      if (!rows.length) {
        return errorResponse("Customer automation not found for this developer.", 404);
      }
    }

    if (auth.role === "buyer") {
      if (action !== "run_one") {
        return errorResponse("Buyers can only trigger one owned on-demand automation at a time.", 403);
      }

      rows = rows.filter((row: any) => buyerOwnsCandidate(row, auth.user?.id || ""));

      if (!rows.length) {
        return errorResponse("Customer automation not found for this buyer.", 404);
      }

      const nonOnDemand = rows.find((row: any) => runFrequency(row) !== "on_demand");
      if (nonOnDemand) {
        return errorResponse("This automation is not configured for buyer on-demand runs.", 403);
      }
    }

    const results = [];

    if (action === "latest_status") {
      for (const row of rows) {
        results.push(await loadCandidateStatus(adminClient, row));
      }

      return jsonResponse({
        ok: true,
        action,
        count: results.length,
        results,
      });
    }

    for (const row of rows) {
      const result = await runCandidate(adminClient, row, {
        action,
        dryRun: action === "dry_run" || Boolean(body.dry_run),
        advanceSchedule: action === "run_due" || body.advance_schedule === true,
        allowInactiveSubscription: body.allow_inactive_subscription === true ||
          body.allowInactiveSubscription === true ||
          body.force === true,
        eventPayload: asObject(body.event || body.request || body.input),
      });

      results.push(result);
    }

    return jsonResponse({
      ok: true,
      action,
      count: results.length,
      results,
    });
  } catch (error) {
    console.error("run-scheduled-automations failed:", error);

    return errorResponse(
      error instanceof Error ? error.message : "Could not run scheduled automations.",
      500,
    );
  }
});
