import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const NEXUS_RUNTIME_SECRET = Deno.env.get("NEXUS_RUNTIME_SECRET") || "";

function nowIso() {
  return new Date().toISOString();
}

function cleanString(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
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

function scheduledDateKey(value: string) {
  const date = value ? new Date(value) : new Date();
  return date.toISOString().slice(0, 10);
}

function buildCallbackUrl() {
  return `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/runtime-submit-output`;
}

function getRuntimeWebhookUrl(customerAutomation: any, automation: any, order: any) {
  return pickFirstString(
    customerAutomation?.runtime_webhook_url,
    customerAutomation?.n8n_webhook_url,
    automation?.runtime_webhook_url,
    automation?.n8n_webhook_url,
    order?.runtime_webhook_url,
    order?.n8n_webhook_url,
  );
}

function getRuntimeWebhookPath(customerAutomation: any, automation: any, order: any) {
  return pickFirstString(
    customerAutomation?.runtime_webhook_path,
    customerAutomation?.n8n_webhook_path,
    automation?.runtime_webhook_path,
    automation?.n8n_webhook_path,
    order?.runtime_webhook_path,
    order?.n8n_webhook_path,
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
  if (!subscriptionIsActive(order)) {
    return { ok: false, reason: "subscription_not_active" };
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

  if (profile?.role !== "admin") {
    return { ok: false, error: "Admin access required." };
  }

  return { ok: true, internal: false, user: data.user };
}

async function loadLatestSetupValues(adminClient: any, customerAutomationId: string) {
  const { data, error } = await adminClient
    .from("automation_setup_submissions")
    .select("answers, setup_answers")
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
  run: any;
  runKey: string;
  scheduledFor: string;
}) {
  const customerAutomation = params.customerAutomation;
  const order = params.order || {};

  return {
    customer_automation_id: customerAutomation.id,
    automation_id: customerAutomation.automation_id,
    order_id: customerAutomation.order_id,
    buyer_id: customerAutomation.buyer_id,
    run_id: params.run?.id || "",
    run_key: params.runKey,

    setup: params.setupAnswers || {},
    secrets: params.secrets || {},

    customer: {
      id: customerAutomation.buyer_id || order.buyer_id || "",
      email: order.buyer_email || "",
      name: order.buyer_name || "",
      company: order.buyer_company || "",
      order_id: customerAutomation.order_id || order.id || "",
    },

    schedule: {
      frequency: "monthly",
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
      n8n_workflow_id: pickFirstString(
        customerAutomation.n8n_workflow_id,
        params.automation?.n8n_workflow_id,
      ),
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

function extractExecutionId(responseBody: any) {
  return pickFirstString(
    responseBody?.executionId,
    responseBody?.execution_id,
    responseBody?.data?.executionId,
    responseBody?.data?.execution_id,
    responseBody?.id,
  );
}

async function loadCandidates(adminClient: any, options: { action: string; id?: string; limit: number }) {
  if (options.id) {
    const { data, error } = await adminClient
      .from("customer_automations")
      .select("*, automations(*), orders(*)")
      .eq("id", options.id)
      .maybeSingle();

    if (error) throw new Error(error.message);
    return data ? [data] : [];
  }

  const { data, error } = await adminClient
    .from("customer_automations")
    .select("*, automations(*), orders(*)")
    .eq("run_frequency", "monthly")
    .eq("schedule_status", "active")
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
}) {
  const customerAutomation = row;
  const automation = one(row.automations) || {};
  const order = one(row.orders) || {};
  const webhookUrl = getRuntimeWebhookUrl(customerAutomation, automation, order);
  const eligibility = scheduleIsRunnable(customerAutomation, order, webhookUrl);
  const scheduledFor = options.action === "run_one"
    ? nowIso()
    : cleanString(customerAutomation.next_run_at) || nowIso();

  if (!eligibility.ok) {
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

  const runKey = options.action === "run_one"
    ? `manual:${customerAutomation.id}:${Date.now()}`
    : `monthly:${customerAutomation.id}:${scheduledDateKey(scheduledFor)}`;

  const setupValues = await loadLatestSetupValues(adminClient, customerAutomation.id);
  const secrets = await loadSecretValues(adminClient, customerAutomation.id);

  const provisionalPayload = {
    customer_automation_id: customerAutomation.id,
    automation_id: customerAutomation.automation_id,
    order_id: customerAutomation.order_id,
    buyer_id: customerAutomation.buyer_id,
    run_id: "",
    run_key: runKey,
    setup: setupValues.setupAnswers,
    secrets,
    schedule: {
      frequency: "monthly",
      scheduled_for: scheduledFor,
      run_key: runKey,
    },
    system: {
      callback_url: buildCallbackUrl(),
      runtime_type: customerAutomation.runtime_type || automation?.runtime_type || "n8n_managed",
      runtime_webhook_path: getRuntimeWebhookPath(customerAutomation, automation, order),
      n8n_workflow_id: pickFirstString(customerAutomation.n8n_workflow_id, automation?.n8n_workflow_id),
    },
  };

  const { data: run, duplicate } = await createRunRecord(adminClient, {
    customer_automation_id: customerAutomation.id,
    buyer_id: customerAutomation.buyer_id,
    automation_id: customerAutomation.automation_id,
    order_id: customerAutomation.order_id,
    runtime_type: customerAutomation.runtime_type || automation?.runtime_type || "n8n_managed",
    trigger_type: options.action === "run_one" ? "manual_admin" : "scheduled_monthly",
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
    run,
    runKey,
    scheduledFor,
  });

  try {
    const response = await triggerWebhook(webhookUrl, runtimePayload);
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
      updatePayload.next_run_at = nextMonthlyDate(scheduledFor, new Date());
    }

    await updateCustomerAutomation(adminClient, customerAutomation.id, updatePayload);

    await insertAutomationEvent(adminClient, {
      customer_automation_id: customerAutomation.id,
      buyer_id: customerAutomation.buyer_id,
      automation_id: customerAutomation.automation_id,
      order_id: customerAutomation.order_id,
      event_type: options.action === "run_one"
        ? "manual_runtime_triggered"
        : "scheduled_runtime_triggered",
      title: options.action === "run_one"
        ? "Manual automation run started"
        : "Monthly automation run started",
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

    await updateRunRecord(adminClient, run.id, {
      status: "error",
      finished_at: now,
      updated_at: now,
      error_message: message,
      response_payload: {
        error: message,
      },
    });

    await updateCustomerAutomation(adminClient, customerAutomation.id, {
      status: "error",
      runtime_status: "error",
      health_status: "error",
      last_error_message: "This automation could not be started. Nexus has been notified.",
      last_error_details: {
        source: "run-scheduled-automations",
        error: message,
      },
      last_failed_at: now,
      updated_at: now,
    });

    await insertAutomationEvent(adminClient, {
      customer_automation_id: customerAutomation.id,
      buyer_id: customerAutomation.buyer_id,
      automation_id: customerAutomation.automation_id,
      order_id: customerAutomation.order_id,
      event_type: "scheduled_runtime_error",
      title: "Monthly automation run failed to start",
      message: JSON.stringify({
        run_id: run.id,
        run_key: runKey,
        scheduled_for: scheduledFor,
        error: message,
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

    if (!["dry_run", "run_due", "run_one"].includes(action)) {
      return errorResponse("Unknown action.", 400);
    }

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return errorResponse("Missing Supabase function secrets.", 500);
    }

    if (!NEXUS_RUNTIME_SECRET) {
      return errorResponse("Missing NEXUS_RUNTIME_SECRET.", 500);
    }

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const auth = await requireOperator(req, body, adminClient);

    if (!auth.ok) {
      return errorResponse(auth.error || "Unauthorized.", 401);
    }

    const customerAutomationId = cleanString(
      body.customer_automation_id ||
        body.customerAutomationId ||
        body.id,
    );

    if (action === "run_one" && !customerAutomationId) {
      return errorResponse("customer_automation_id is required for run_one.", 400);
    }

    const rows = await loadCandidates(adminClient, {
      action,
      id: customerAutomationId,
      limit,
    });

    const results = [];

    for (const row of rows) {
      const result = await runCandidate(adminClient, row, {
        action,
        dryRun: action === "dry_run" || Boolean(body.dry_run),
        advanceSchedule: action === "run_due" || body.advance_schedule === true,
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
