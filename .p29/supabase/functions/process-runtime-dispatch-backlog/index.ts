import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const NEXUS_RUNTIME_SECRET = Deno.env.get("NEXUS_RUNTIME_SECRET") || "";
const N8N_BASE_URL = Deno.env.get("N8N_BASE_URL") || "";

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

function one(value: any) {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function pickFirstString(...values: unknown[]) {
  for (const value of values) {
    const cleaned = cleanString(value);
    if (cleaned) return cleaned;
  }
  return "";
}

function normalizeWorkflowCloneMode(...values: unknown[]) {
  const raw = values
    .map((value) => cleanString(value))
    .find(Boolean)
    ?.toLowerCase()
    .replace(/[\s-]+/g, "_") || "";

  return [
    "per_customer",
    "clone_per_customer",
    "customer_clone",
    "customer_cloned",
    "customer_workflow",
    "dedicated_customer_workflow",
    "isolated",
    "isolated_customer_workflow",
  ].includes(raw)
    ? "per_customer"
    : "shared_product";
}

function shouldUseCustomerWorkflowClone(automation: any, order: any, customerAutomation: any) {
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

function runtimeWorkflowId(customerAutomation: any, automation: any, order: any) {
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

function runtimeWebhookPath(customerAutomation: any, automation: any, order: any) {
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

function runtimeWebhookUrl(customerAutomation: any, automation: any, order: any) {
  const direct = shouldUseCustomerWorkflowClone(automation, order, customerAutomation)
    ? pickFirstString(
      customerAutomation?.runtime_webhook_url,
      customerAutomation?.n8n_webhook_url,
      automation?.runtime_webhook_url,
      automation?.n8n_webhook_url,
      order?.runtime_webhook_url,
      order?.n8n_webhook_url,
    )
    : pickFirstString(
      automation?.runtime_webhook_url,
      automation?.n8n_webhook_url,
      order?.runtime_webhook_url,
      order?.n8n_webhook_url,
      customerAutomation?.runtime_webhook_url,
      customerAutomation?.n8n_webhook_url,
    );

  if (direct) return direct;

  const path = runtimeWebhookPath(customerAutomation, automation, order);
  const baseUrl = cleanBaseUrl(N8N_BASE_URL);
  return path && baseUrl ? `${baseUrl}/webhook/${path}` : "";
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

function isTerminalSuccessStatus(value: unknown) {
  const status = cleanString(value).toLowerCase().replace(/[\s-]+/g, "_");
  return [
    "running",
    "processing",
    "started",
    "output_received",
    "success",
    "succeeded",
    "complete",
    "completed",
  ].includes(status);
}

function isCancelledStatus(value: unknown) {
  const status = cleanString(value).toLowerCase();
  return status.includes("cancel") || status.includes("refund") || status.includes("expired");
}

function classifyDispatchError(error: unknown) {
  const message = error instanceof Error ? error.message : cleanString(error);
  const lower = message.toLowerCase();
  const customerSignals = [
    "invalid token",
    "access token",
    "oauth",
    "unauthorized",
    "authorisation",
    "authorization",
    "authentication",
    "forbidden",
    "access denied",
    "permission",
    "scope",
    "invalid grant",
    "invalid client",
    "invalid api key",
    "expired token",
    "token expired",
    "invalid credentials",
    "invalid page id",
    "invalid object id",
    "unsupported get request",
    "invalid channel id",
    "missing required field",
    "required parameter",
  ];
  const transientSignals = [
    "database not ready",
    "database is not ready",
    "service unavailable",
    "bad gateway",
    "gateway timeout",
    "connection refused",
    "connection reset",
    "connection closed",
    "network",
    "fetch failed",
    "timed out",
    "timeout",
    "econnrefused",
    "econnreset",
    "webhook",
    "not registered",
    "requested webhook",
    "n8n",
    "(500)",
    "(502)",
    "(503)",
    "(504)",
  ];

  if (customerSignals.some((signal) => lower.includes(signal))) {
    return {
      permanent: true,
      code: "CUSTOMER_SETUP_INVALID",
      message,
      customerMessage:
        "The saved setup or credentials need an update before this automation can start.",
    };
  }

  return {
    permanent: false,
    code: transientSignals.some((signal) => lower.includes(signal))
      ? "RUNTIME_TEMPORARILY_UNAVAILABLE"
      : "RUNTIME_DISPATCH_RETRYING",
    message,
    customerMessage:
      "Your setup is safely queued. Nexus will start it automatically when the runtime is available.",
  };
}

function retryDelaySeconds(attemptCount: number) {
  const attempt = Math.max(1, Number(attemptCount) || 1);
  return Math.min(15 * 60, Math.max(60, 30 * (2 ** Math.min(attempt - 1, 8))));
}

async function loadCredentials(adminClient: any, customerAutomationId: string) {
  const { data, error } = await adminClient
    .from("customer_automation_credentials")
    .select("key, credential_key, value, credential_value, secret_value")
    .eq("customer_automation_id", customerAutomationId);

  if (error) throw new Error(`Could not load saved credentials: ${error.message}`);

  const secrets: Record<string, string> = {};
  for (const row of data || []) {
    const key = cleanString(row.key || row.credential_key);
    const value = cleanString(row.value || row.credential_value || row.secret_value);
    if (key && value) secrets[key] = value;
  }
  return secrets;
}

async function loadSetupSubmission(adminClient: any, queue: any) {
  let query = adminClient
    .from("automation_setup_submissions")
    .select("id, customer_automation_id, answers, setup_answers, credential_keys_available, created_at")
    .eq("customer_automation_id", queue.customer_automation_id);

  if (queue.setup_submission_id) {
    query = query.eq("id", queue.setup_submission_id);
  } else {
    query = query.order("created_at", { ascending: false }).limit(1);
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`Could not load saved setup: ${error.message}`);
  if (!data) throw new Error("The saved setup submission no longer exists.");
  return data;
}

async function provisionCustomerWorkflow(customerAutomationId: string) {
  const response = await fetch(
    `${cleanBaseUrl(SUPABASE_URL)}/functions/v1/provision-customer-workflow`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-nexus-runtime-secret": NEXUS_RUNTIME_SECRET,
      },
      body: JSON.stringify({ customer_automation_id: customerAutomationId }),
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
      `Workflow provisioning failed (${response.status}): ${
        data?.error || data?.message || data?.raw || "Unknown provisioning error"
      }`,
    );
  }
  return data;
}

function buildRuntimePayload(params: {
  queue: any;
  run: any;
  customerAutomation: any;
  automation: any;
  order: any;
  submission: any;
  secrets: Record<string, string>;
}) {
  const { queue, run, customerAutomation, automation, order, submission, secrets } = params;
  const setupAnswers = asObject(submission?.setup_answers);
  const rawSetup = Object.keys(setupAnswers).length
    ? { ...setupAnswers }
    : { ...asObject(submission?.answers) };
  for (const secretKey of Object.keys(secrets)) delete rawSetup[secretKey];
  const setup = applySheetAccessSetup(rawSetup, automation, customerAutomation);
  const runKey = cleanString(run.run_key);

  return {
    customer_automation_id: customerAutomation.id,
    automation_id: customerAutomation.automation_id,
    order_id: customerAutomation.order_id,
    buyer_id: customerAutomation.buyer_id,
    run_id: run.id,
    run_key: runKey,
    bundle_run_attempt_id: run.bundle_run_attempt_id || "",
    bundle_run_item_id: run.bundle_run_item_id || "",
    bundle_id: customerAutomation.bundle_id || order?.bundle_id || "",
    bundle_order_id: customerAutomation.order_id || order?.id || "",
    setup,
    event: asObject(queue.event_payload),
    request: asObject(queue.event_payload),
    secrets,
    customer: {
      id: customerAutomation.buyer_id || order?.buyer_id || "",
      email: order?.buyer_email || "",
      name: order?.buyer_name || "",
      company: order?.buyer_company || "",
      order_id: customerAutomation.order_id || order?.id || "",
    },
    schedule: {
      frequency: customerAutomation.run_frequency || "manual",
      scheduled_for: run.scheduled_for || queue.created_at,
      run_key: runKey,
    },
    system: {
      customer_automation_id: customerAutomation.id,
      automation_id: customerAutomation.automation_id,
      order_id: customerAutomation.order_id,
      buyer_id: customerAutomation.buyer_id,
      setup_submission_id: submission.id,
      run_id: run.id,
      run_key: runKey,
      bundle_run_attempt_id: run.bundle_run_attempt_id || "",
      bundle_run_item_id: run.bundle_run_item_id || "",
      bundle_id: customerAutomation.bundle_id || order?.bundle_id || "",
      bundle_order_id: customerAutomation.order_id || order?.id || "",
      callback_url: `${cleanBaseUrl(SUPABASE_URL)}/functions/v1/runtime-submit-output`,
      runtime_secret: NEXUS_RUNTIME_SECRET,
      saved_credential_keys: Object.keys(secrets),
      runtime_type: customerAutomation.runtime_type || automation?.runtime_type || "n8n_managed",
      runtime_webhook_path: runtimeWebhookPath(customerAutomation, automation, order),
      n8n_workflow_id: runtimeWorkflowId(customerAutomation, automation, order),
    },
  };
}

async function postRuntime(url: string, payload: any) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-nexus-runtime-secret": NEXUS_RUNTIME_SECRET,
      "x-nexus-run-key": cleanString(payload.run_key),
      "Idempotency-Key": cleanString(payload.run_key),
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
      `Runtime webhook failed (${response.status}): ${
        data?.message || data?.error || text || "Unknown runtime error"
      }`,
    );
  }

  return { status: response.status, data };
}

async function dispatchRuntime(params: {
  customerAutomation: any;
  automation: any;
  order: any;
  payload: any;
}) {
  const { customerAutomation, automation, order, payload } = params;
  const runtimeType = cleanString(
    customerAutomation.runtime_type || automation?.runtime_type || "n8n_managed",
  ).toLowerCase();

  if (runtimeType === "python_runner") {
    return await postRuntime(
      `${cleanBaseUrl(SUPABASE_URL)}/functions/v1/run-python-automation`,
      payload,
    );
  }

  const useClone = shouldUseCustomerWorkflowClone(automation, order, customerAutomation);
  if (useClone && !hasCustomerRuntimeTarget(customerAutomation)) {
    const provisioned = await provisionCustomerWorkflow(customerAutomation.id);
    if (provisioned?.customer_automation) {
      Object.assign(customerAutomation, provisioned.customer_automation);
    }
    if (provisioned?.workflow_id) customerAutomation.n8n_workflow_id = provisioned.workflow_id;
    if (provisioned?.webhook_path) customerAutomation.runtime_webhook_path = provisioned.webhook_path;
    if (provisioned?.webhook_url) customerAutomation.runtime_webhook_url = provisioned.webhook_url;
  }

  let webhookUrl = runtimeWebhookUrl(customerAutomation, automation, order);
  if (!webhookUrl) throw new Error("n8n runtime webhook is not ready.");

  payload.system.runtime_webhook_path = runtimeWebhookPath(customerAutomation, automation, order);
  payload.system.n8n_workflow_id = runtimeWorkflowId(customerAutomation, automation, order);

  try {
    return await postRuntime(webhookUrl, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : cleanString(error);
    const webhookNotRegistered = message.toLowerCase().includes("webhook") &&
      (
        message.toLowerCase().includes("not registered") ||
        message.toLowerCase().includes("requested webhook")
      );

    if (!webhookNotRegistered || !useClone) throw error;

    const provisioned = await provisionCustomerWorkflow(customerAutomation.id);
    if (provisioned?.customer_automation) {
      Object.assign(customerAutomation, provisioned.customer_automation);
    }
    if (provisioned?.workflow_id) customerAutomation.n8n_workflow_id = provisioned.workflow_id;
    if (provisioned?.webhook_path) customerAutomation.runtime_webhook_path = provisioned.webhook_path;
    if (provisioned?.webhook_url) customerAutomation.runtime_webhook_url = provisioned.webhook_url;

    webhookUrl = runtimeWebhookUrl(customerAutomation, automation, order);
    if (!webhookUrl) throw error;

    payload.system.runtime_webhook_path = runtimeWebhookPath(customerAutomation, automation, order);
    payload.system.n8n_workflow_id = runtimeWorkflowId(customerAutomation, automation, order);
    return await postRuntime(webhookUrl, payload);
  }
}

async function updateOwnedQueue(
  adminClient: any,
  queue: any,
  payload: Record<string, unknown>,
) {
  const { error } = await adminClient
    .from("runtime_dispatch_queue")
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq("id", queue.id)
    .eq("worker_id", queue.worker_id);

  if (error) throw new Error(`Could not update dispatch queue: ${error.message}`);
}

async function markAccepted(
  adminClient: any,
  queue: any,
  run: any,
  customerAutomation: any,
  response: any = {},
) {
  const now = new Date().toISOString();
  const executionId = extractExecutionId(response?.data);

  const { error: runError } = await adminClient
    .from("automation_runs")
    .update({
      status: isTerminalSuccessStatus(run.status) ? run.status : "running",
      started_at: run.started_at || now,
      n8n_execution_id: executionId || run.n8n_execution_id || null,
      response_payload: Object.keys(asObject(response)).length ? response : run.response_payload,
      error_message: null,
      finished_at: null,
      updated_at: now,
    })
    .eq("id", run.id)
    .eq("customer_automation_id", customerAutomation.id);

  if (runError) throw new Error(`Could not mark run accepted: ${runError.message}`);

  if (run.bundle_run_item_id) {
    await adminClient
      .from("bundle_run_items")
      .update({
        status: "running",
        error_message: null,
        finished_at: null,
        updated_at: now,
      })
      .eq("id", run.bundle_run_item_id)
      .eq("automation_run_id", run.id);
  }

  await adminClient
    .from("customer_automations")
    .update({
      status: "running",
      runtime_status: "running",
      health_status: "running",
      setup_status: "submitted",
      needs_customer_action: false,
      last_error_code: null,
      last_error_node: null,
      last_error_message: null,
      last_error_details: {},
      last_failed_at: null,
      last_run_requested_at: now,
      last_run_at: now,
      ...(executionId
        ? {
          n8n_last_execution_id: executionId,
          n8n_last_execution_status: "started",
          n8n_last_execution_checked_at: now,
        }
        : {}),
      updated_at: now,
    })
    .eq("id", customerAutomation.id);

  await updateOwnedQueue(adminClient, queue, {
    status: "accepted",
    accepted_at: now,
    locked_at: null,
    worker_id: null,
    last_error_code: null,
    last_error_message: null,
    last_error_details: {},
  });

  await adminClient.from("automation_events").insert({
    customer_automation_id: customerAutomation.id,
    buyer_id: customerAutomation.buyer_id || null,
    automation_id: customerAutomation.automation_id || null,
    order_id: customerAutomation.order_id || null,
    event_type: "runtime_dispatch_recovered",
    title: queue.attempt_count > 1 ? "Queued automation started" : "Automation started",
    message: JSON.stringify({
      run_id: run.id,
      run_key: run.run_key,
      queue_id: queue.id,
      attempt_count: queue.attempt_count,
      n8n_execution_id: executionId || null,
    }),
    created_by: "runtime",
    created_at: now,
  });

  return {
    queue_id: queue.id,
    run_id: run.id,
    status: "accepted",
    attempt_count: queue.attempt_count,
  };
}

async function deferDispatch(
  adminClient: any,
  queue: any,
  run: any,
  customerAutomation: any,
  error: unknown,
) {
  const classification = classifyDispatchError(error);
  const now = new Date().toISOString();

  if (classification.permanent) {
    await adminClient
      .from("automation_runs")
      .update({
        status: "error",
        error_message: classification.message,
        finished_at: now,
        updated_at: now,
      })
      .eq("id", run.id);

    if (run.bundle_run_item_id) {
      await adminClient
        .from("bundle_run_items")
        .update({
          status: "failed",
          error_message: classification.message,
          finished_at: now,
          updated_at: now,
        })
        .eq("id", run.bundle_run_item_id);
    }

    await adminClient
      .from("customer_automations")
      .update({
        status: "setup_error",
        runtime_status: "error",
        health_status: "needs_customer_action",
        setup_status: "needs_update",
        needs_customer_action: true,
        last_error_code: classification.code,
        last_error_node: "runtime dispatch backlog",
        last_error_message: classification.customerMessage,
        last_error_details: { error: classification.message, queue_id: queue.id },
        last_failed_at: now,
        updated_at: now,
      })
      .eq("id", customerAutomation.id);

    await updateOwnedQueue(adminClient, queue, {
      status: "dead_letter",
      locked_at: null,
      worker_id: null,
      last_error_code: classification.code,
      last_error_message: classification.message,
      last_error_details: { permanent: true },
    });

    return {
      queue_id: queue.id,
      run_id: run.id,
      status: "dead_letter",
      attempt_count: queue.attempt_count,
      error_code: classification.code,
    };
  }

  const delaySeconds = retryDelaySeconds(queue.attempt_count);
  const nextAttemptAt = new Date(Date.now() + delaySeconds * 1000).toISOString();

  await adminClient
    .from("automation_runs")
    .update({
      status: "queued",
      error_message: null,
      finished_at: null,
      updated_at: now,
      response_payload: {
        status: "queued_for_retry",
        attempt_count: queue.attempt_count,
        next_attempt_at: nextAttemptAt,
      },
    })
    .eq("id", run.id);

  if (run.bundle_run_item_id) {
    await adminClient
      .from("bundle_run_items")
      .update({
        status: "queued",
        error_message: null,
        finished_at: null,
        updated_at: now,
      })
      .eq("id", run.bundle_run_item_id);
  }

  await adminClient
    .from("customer_automations")
    .update({
      status: "queued",
      runtime_status: "queued",
      health_status: "pending",
      setup_status: "submitted",
      needs_customer_action: false,
      last_error_code: classification.code,
      last_error_node: "runtime dispatch backlog",
      last_error_message: null,
      last_error_details: {
        retrying: true,
        queue_id: queue.id,
        attempt_count: queue.attempt_count,
        next_attempt_at: nextAttemptAt,
        admin_error: classification.message,
      },
      last_failed_at: now,
      updated_at: now,
    })
    .eq("id", customerAutomation.id);

  await updateOwnedQueue(adminClient, queue, {
    status: "pending",
    next_attempt_at: nextAttemptAt,
    locked_at: null,
    worker_id: null,
    last_error_code: classification.code,
    last_error_message: classification.message,
    last_error_details: { retrying: true, delay_seconds: delaySeconds },
  });

  return {
    queue_id: queue.id,
    run_id: run.id,
    status: "queued",
    attempt_count: queue.attempt_count,
    next_attempt_at: nextAttemptAt,
    error_code: classification.code,
  };
}

async function processQueueItem(adminClient: any, queue: any) {
  const { data: run, error: runError } = await adminClient
    .from("automation_runs")
    .select("*")
    .eq("id", queue.run_id)
    .eq("customer_automation_id", queue.customer_automation_id)
    .maybeSingle();

  if (runError) throw new Error(`Could not load queued run: ${runError.message}`);
  if (!run) {
    await updateOwnedQueue(adminClient, queue, {
      status: "cancelled",
      locked_at: null,
      worker_id: null,
      last_error_code: "RUN_NOT_FOUND",
      last_error_message: "The queued automation run no longer exists.",
    });
    return { queue_id: queue.id, run_id: queue.run_id, status: "cancelled" };
  }

  const { data: customerAutomation, error: automationError } = await adminClient
    .from("customer_automations")
    .select("*, automations(*), orders(*)")
    .eq("id", queue.customer_automation_id)
    .maybeSingle();

  if (automationError) {
    throw new Error(`Could not load queued customer automation: ${automationError.message}`);
  }
  if (!customerAutomation || isCancelledStatus(customerAutomation.status)) {
    await updateOwnedQueue(adminClient, queue, {
      status: "cancelled",
      locked_at: null,
      worker_id: null,
      last_error_code: "AUTOMATION_NOT_RUNNABLE",
      last_error_message: "The customer automation was cancelled or removed.",
    });
    return { queue_id: queue.id, run_id: run.id, status: "cancelled" };
  }

  if (isTerminalSuccessStatus(run.status) || run.n8n_execution_id) {
    return await markAccepted(adminClient, queue, run, customerAutomation);
  }

  const automation = one(customerAutomation.automations) || {};
  const order = one(customerAutomation.orders) || {};

  try {
    const [submission, secrets] = await Promise.all([
      loadSetupSubmission(adminClient, queue),
      loadCredentials(adminClient, customerAutomation.id),
    ]);
    const payload = buildRuntimePayload({
      queue,
      run,
      customerAutomation,
      automation,
      order,
      submission,
      secrets,
    });
    const response = await dispatchRuntime({
      customerAutomation,
      automation,
      order,
      payload,
    });

    return await markAccepted(adminClient, queue, run, customerAutomation, response);
  } catch (error) {
    return await deferDispatch(adminClient, queue, run, customerAutomation, error);
  }
}

async function triggerDueSchedules(limit: number) {
  const response = await fetch(
    `${cleanBaseUrl(SUPABASE_URL)}/functions/v1/run-scheduled-automations`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-nexus-runtime-secret": NEXUS_RUNTIME_SECRET,
      },
      body: JSON.stringify({ action: "run_due", limit }),
    },
  );

  const data = await response.json().catch(() => ({}));
  return {
    ok: response.ok && data?.ok !== false,
    status: response.status,
    count: Number(data?.count || 0),
    error: response.ok ? null : cleanString(data?.error || data?.message),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  if (req.method === "GET") {
    return jsonResponse({
      ok: true,
      message: "process-runtime-dispatch-backlog is alive.",
    });
  }

  if (req.method !== "POST") return errorResponse("Method not allowed.", 405);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !NEXUS_RUNTIME_SECRET) {
    return errorResponse("Missing required Supabase function secrets.", 500);
  }

  const body = await req.json().catch(() => ({}));
  const workerToken = cleanString(req.headers.get("x-nexus-dispatch-worker"));
  const limit = Math.max(1, Math.min(Number(body.limit || 25) || 25, 100));
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: authorized, error: authError } = await adminClient.rpc(
    "authorize_runtime_dispatch_worker",
    { p_token: workerToken },
  );

  if (authError || authorized !== true) {
    return errorResponse("Unauthorized dispatch worker.", 401);
  }

  const workerId = crypto.randomUUID();
  const { data: queueRows, error: claimError } = await adminClient.rpc(
    "claim_runtime_dispatch_queue",
    { p_limit: limit, p_worker_id: workerId },
  );

  if (claimError) return errorResponse(`Could not claim dispatch backlog: ${claimError.message}`, 500);

  const results = [];
  for (const queue of queueRows || []) {
    try {
      results.push(await processQueueItem(adminClient, queue));
    } catch (error) {
      console.error("runtime dispatch queue item failed:", queue?.id, error);
      results.push({
        queue_id: queue?.id || null,
        run_id: queue?.run_id || null,
        status: "worker_error",
        error: error instanceof Error ? error.message : cleanString(error),
      });
    }
  }

  const schedules = body.run_due === true
    ? await triggerDueSchedules(limit).catch((error) => ({
      ok: false,
      status: 0,
      count: 0,
      error: error instanceof Error ? error.message : cleanString(error),
    }))
    : null;

  return jsonResponse({
    ok: true,
    claimed: (queueRows || []).length,
    accepted: results.filter((result: any) => result.status === "accepted").length,
    queued: results.filter((result: any) => result.status === "queued").length,
    dead_letter: results.filter((result: any) => result.status === "dead_letter").length,
    cancelled: results.filter((result: any) => result.status === "cancelled").length,
    worker_errors: results.filter((result: any) => result.status === "worker_error").length,
    schedules,
    results,
  });
});
