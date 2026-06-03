import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-nexus-runtime-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function errorResponse(message: string, status = 400, extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      error: message,
      message,
      ...extra,
    }),
    {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    },
  );
}

function env(name: string) {
  return Deno.env.get(name) || "";
}

function cleanString(value: unknown) {
  return String(value ?? "").trim();
}

function safeJsonParse(value: unknown, fallback: any) {
  if (Array.isArray(value) || (value && typeof value === "object")) return value;

  const raw = cleanString(value);
  if (!raw) return fallback;

  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizeJsonArray(value: unknown) {
  const parsed = safeJsonParse(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function normalizeJsonObject(value: unknown) {
  const parsed = safeJsonParse(value, {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBearerToken(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  return authHeader.replace(/^Bearer\s+/i, "").trim();
}

function isUuid(value: unknown) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    cleanString(value),
  );
}

function getCredentialFieldNames(credentialSchema: any[]) {
  return credentialSchema
    .map((field: any) => cleanString(field?.name))
    .filter(Boolean);
}

function splitSetupAndSecrets(answers: Record<string, unknown>, credentialSchema: any[]) {
  const credentialKeys = new Set(getCredentialFieldNames(credentialSchema));
  const setupAnswers: Record<string, string> = {};
  const secretAnswers: Record<string, string> = {};

  for (const [key, rawValue] of Object.entries(answers || {})) {
    const cleanKey = cleanString(key);
    const value = cleanString(rawValue);

    if (!cleanKey) continue;

    if (credentialKeys.has(cleanKey)) {
      /*
        Empty secret fields mean "keep the saved credential".
        Do not overwrite saved secrets with blank values.
      */
      if (value) {
        secretAnswers[cleanKey] = value;
      }
    } else {
      setupAnswers[cleanKey] = value;
    }
  }

  return {
    setupAnswers,
    secretAnswers,
    credentialKeys: [...credentialKeys],
  };
}

function pickFirstString(...values: unknown[]) {
  for (const value of values) {
    const cleaned = cleanString(value);
    if (cleaned) return cleaned;
  }

  return "";
}

function buildCallbackUrl() {
  const supabaseUrl = env("SUPABASE_URL").replace(/\/+$/, "");
  return `${supabaseUrl}/functions/v1/runtime-submit-output`;
}

async function safeUpdateCustomerAutomation(
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
    If some launch columns are not added yet, retry with only older/core fields.
  */
  const fallbackPayload = { ...payload };

  const optionalColumns = [
    "needs_customer_action",
    "last_error_code",
    "last_error_node",
    "last_error_message",
    "last_error_details",
    "last_failed_at",
    "n8n_last_execution_id",
    "n8n_last_execution_status",
    "n8n_last_execution_checked_at",
    "health_status",
    "failure_count",
  ];

  for (const column of optionalColumns) {
    delete fallbackPayload[column];
  }

  const { error: fallbackError } = await adminClient
    .from("customer_automations")
    .update(fallbackPayload)
    .eq("id", customerAutomationId);

  return fallbackError || error;
}

async function insertAutomationEvent(
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
  const { error } = await adminClient.from("automation_events").insert({
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

  if (error) {
    console.warn("automation_events insert failed:", error.message);
  }
}

async function insertAutomationRun(
  adminClient: any,
  payload: Record<string, unknown>,
) {
  const { error } = await adminClient.from("automation_runs").insert(payload);

  if (error) {
    console.warn("automation_runs insert failed:", error.message);
  }
}

async function saveSetupSubmission(
  adminClient: any,
  payload: {
    customer_automation: any;
    answers: Record<string, unknown>;
    setup_answers: Record<string, unknown>;
    credential_keys_available: string[];
  },
) {
  const now = new Date().toISOString();
  const customerAutomation = payload.customer_automation;

  const insertPayload = {
    customer_automation_id: customerAutomation.id,
    buyer_id: customerAutomation.buyer_id || null,
    automation_id: customerAutomation.automation_id || null,
    order_id: customerAutomation.order_id || null,

    answers: payload.answers || {},
    setup_answers: payload.setup_answers || {},
    credential_keys_available: payload.credential_keys_available || [],

    status: "submitted",
    submitted_at: now,
    created_at: now,
    updated_at: now,
  };

  let result = await adminClient
    .from("automation_setup_submissions")
    .insert(insertPayload)
    .select()
    .single();

  if (!result.error) {
    return {
      data: result.data,
      error: null,
    };
  }

  /*
    Backward compatibility for older table schemas.
  */
  const fallbackPayload = {
    customer_automation_id: customerAutomation.id,
    buyer_id: customerAutomation.buyer_id || null,
    automation_id: customerAutomation.automation_id || null,
    order_id: customerAutomation.order_id || null,
    answers: payload.answers || {},
    status: "submitted",
    created_at: now,
  };

  result = await adminClient
    .from("automation_setup_submissions")
    .insert(fallbackPayload)
    .select()
    .single();

  return result;
}

async function insertCredentialWithSchemaFallback(
  adminClient: any,
  payload: Record<string, unknown>,
) {
  /*
    Different Nexus deployments have slightly different
    customer_automation_credentials schemas.

    Current safe minimum:
    - customer_automation_id
    - credential_key
    - secret_value

    Older/newer optional columns may not exist:
    - buyer_id
    - automation_id
    - order_id
    - created_at
    - updated_at

    Supabase/PostgREST rejects unknown columns, so progressively retry with fewer fields.
  */
  const attempts = [
    payload,
    {
      customer_automation_id: payload.customer_automation_id,
      buyer_id: payload.buyer_id,
      automation_id: payload.automation_id,
      credential_key: payload.credential_key,
      secret_value: payload.secret_value,
      created_at: payload.created_at,
      updated_at: payload.updated_at,
    },
    {
      customer_automation_id: payload.customer_automation_id,
      credential_key: payload.credential_key,
      secret_value: payload.secret_value,
      created_at: payload.created_at,
      updated_at: payload.updated_at,
    },
    {
      customer_automation_id: payload.customer_automation_id,
      credential_key: payload.credential_key,
      secret_value: payload.secret_value,
    },
  ];

  let lastError: any = null;

  for (const attempt of attempts) {
    const cleanAttempt: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(attempt)) {
      if (value !== undefined) cleanAttempt[key] = value;
    }

    const { error } = await adminClient
      .from("customer_automation_credentials")
      .insert(cleanAttempt);

    if (!error) return null;

    lastError = error;

    const message = String(error.message || "").toLowerCase();
    const isSchemaColumnError =
      message.includes("could not find") &&
      message.includes("column") &&
      message.includes("schema cache");

    if (!isSchemaColumnError) {
      break;
    }
  }

  return lastError;
}

async function saveCustomerCredentials(
  adminClient: any,
  customerAutomation: any,
  secretAnswers: Record<string, string>,
) {
  const entries = Object.entries(secretAnswers || {}).filter(([, value]) => cleanString(value));

  if (!entries.length) {
    return {
      savedCredentialKeys: [],
    };
  }

  const now = new Date().toISOString();
  const savedCredentialKeys: string[] = [];

  for (const [credentialKey, secretValue] of entries) {
    const key = cleanString(credentialKey);
    const value = cleanString(secretValue);

    if (!key || !value) continue;

    /*
      Keep the credential table simple and robust:
      delete previous key for this customer automation, then insert the new value.
      This avoids depending on a unique constraint.
    */
    await adminClient
      .from("customer_automation_credentials")
      .delete()
      .eq("customer_automation_id", customerAutomation.id)
      .eq("credential_key", key);

    const error = await insertCredentialWithSchemaFallback(adminClient, {
      customer_automation_id: customerAutomation.id,
      buyer_id: customerAutomation.buyer_id || null,
      automation_id: customerAutomation.automation_id || null,
      order_id: customerAutomation.order_id || null,

      credential_key: key,
      secret_value: value,

      created_at: now,
      updated_at: now,
    });

    if (error) {
      throw new Error(`Could not save automation credential ${key}: ${error.message}`);
    }

    savedCredentialKeys.push(key);
  }

  return {
    savedCredentialKeys,
  };
}

async function loadSavedCredentials(adminClient: any, customerAutomationId: string) {
  const { data, error } = await adminClient
    .from("customer_automation_credentials")
    .select("credential_key, secret_value")
    .eq("customer_automation_id", customerAutomationId);

  if (error) {
    console.warn("Could not load saved credentials:", error.message);
    return {};
  }

  const secrets: Record<string, string> = {};

  for (const row of data || []) {
    const key = cleanString(row.credential_key);
    const value = cleanString(row.secret_value);

    if (key && value) {
      secrets[key] = value;
    }
  }

  return secrets;
}

async function loadCustomerAutomation(adminClient: any, id: string) {
  const { data, error } = await adminClient
    .from("customer_automations")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error || !data) {
    return {
      data: null,
      automation: null,
      order: null,
      error: error || new Error("Customer automation not found."),
    };
  }

  let automation = null;
  if (data.automation_id) {
    const result = await adminClient
      .from("automations")
      .select("*")
      .eq("id", data.automation_id)
      .maybeSingle();

    if (!result.error) {
      automation = result.data;
    }
  }

  let order = null;
  if (data.order_id) {
    const result = await adminClient
      .from("orders")
      .select("*")
      .eq("id", data.order_id)
      .maybeSingle();

    if (!result.error) {
      order = result.data;
    }
  }

  return {
    data,
    automation,
    order,
    error: null,
  };
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

function getRuntimeType(customerAutomation: any, automation: any) {
  return pickFirstString(
    customerAutomation?.runtime_type,
    automation?.runtime_type,
  ) || "manual";
}

function buildCustomerPayload(user: any, customerAutomation: any, order: any) {
  return {
    id: user?.id || customerAutomation.buyer_id || order?.buyer_id || "",
    email: user?.email || order?.buyer_email || customerAutomation.buyer_email || "",
    name:
      user?.user_metadata?.full_name ||
      user?.user_metadata?.name ||
      order?.buyer_name ||
      "",
    order_id: customerAutomation.order_id || order?.id || "",
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

async function triggerN8nWebhook(params: {
  webhookUrl: string;
  customerAutomation: any;
  automation: any;
  order: any;
  user: any;
  setupAnswers: Record<string, string>;
  secrets: Record<string, string>;
  savedCredentialKeys: string[];
  submissionId: string;
}) {
  const runtimeSecret = env("NEXUS_RUNTIME_SECRET");
  const callbackUrl = buildCallbackUrl();

  const payload = {
    customer_automation_id: params.customerAutomation.id,
    automation_id: params.customerAutomation.automation_id,
    order_id: params.customerAutomation.order_id,
    buyer_id: params.customerAutomation.buyer_id,

    setup: params.setupAnswers || {},
    secrets: params.secrets || {},

    customer: buildCustomerPayload(params.user, params.customerAutomation, params.order),
    system: {
      customer_automation_id: params.customerAutomation.id,
      automation_id: params.customerAutomation.automation_id,
      order_id: params.customerAutomation.order_id,
      buyer_id: params.customerAutomation.buyer_id,

      callback_url: callbackUrl,
      runtime_secret: runtimeSecret,
      setup_submission_id: params.submissionId,
      saved_credential_keys: params.savedCredentialKeys || [],

      runtime_type: getRuntimeType(params.customerAutomation, params.automation),
      runtime_webhook_path: getRuntimeWebhookPath(
        params.customerAutomation,
        params.automation,
        params.order,
      ),
      n8n_workflow_id: pickFirstString(
        params.customerAutomation.n8n_workflow_id,
        params.automation?.n8n_workflow_id,
      ),
    },
  };

  const response = await fetch(params.webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-nexus-runtime-secret": runtimeSecret,
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  let responseBody: any = {};

  try {
    responseBody = responseText ? JSON.parse(responseText) : {};
  } catch {
    responseBody = {
      raw_response: responseText,
    };
  }

  if (!response.ok) {
    throw new Error(
      `n8n webhook failed (${response.status}): ${
        responseBody?.message ||
        responseBody?.error ||
        responseText ||
        "Unknown n8n webhook error"
      }`,
    );
  }

  return {
    response,
    responseBody,
    executionId: extractExecutionId(responseBody),
  };
}

async function callCheckN8nExecution(customerAutomationId: string) {
  const supabaseUrl = env("SUPABASE_URL").replace(/\/+$/, "");
  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const runtimeSecret = env("NEXUS_RUNTIME_SECRET");

  if (!supabaseUrl || !serviceRoleKey || !runtimeSecret || !customerAutomationId) {
    return {
      checked: false,
      reason:
        "Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEXUS_RUNTIME_SECRET, or customer automation ID.",
    };
  }

  const response = await fetch(`${supabaseUrl}/functions/v1/check-n8n-execution`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceRoleKey}`,
      "x-nexus-runtime-secret": runtimeSecret,
    },
    body: JSON.stringify({
      customer_automation_id: customerAutomationId,
    }),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      checked: false,
      status: response.status,
      error: result?.error || result?.message || "check-n8n-execution failed.",
      result,
    };
  }

  return {
    checked: true,
    result,
  };
}

async function checkN8nExecutionAfterTrigger(customerAutomationId: string) {
  /*
    Give n8n time to create/fail the execution.
    This is intentionally bounded so the customer submit request does not hang forever.
    Dashboard/setup pages can call check-n8n-execution again later if the workflow is still running.
  */
  const delays = [5000, 10000, 20000];
  let lastResult: any = null;

  for (const delay of delays) {
    await sleep(delay);

    const check = await callCheckN8nExecution(customerAutomationId);
    lastResult = check;

    if (!check.checked) {
      return check;
    }

    const status = cleanString(
      check.result?.n8n_execution_status ||
        check.result?.execution_status ||
        check.result?.status ||
        check.result?.customer_automation_status ||
        check.result?.result?.status ||
        "",
    ).toLowerCase();

    if (
      status.includes("error") ||
      status.includes("failed") ||
      status.includes("success") ||
      status.includes("completed")
    ) {
      return check;
    }
  }

  return {
    checked: true,
    still_running: true,
    result: lastResult,
  };
}

function classifyImmediateWebhookError(message: string) {
  const lower = cleanString(message).toLowerCase();

  if (
    lower.includes("access token") ||
    lower.includes("oauth") ||
    lower.includes("credential") ||
    lower.includes("unauthorized") ||
    lower.includes("permission")
  ) {
    return {
      needs_customer_action: true,
      error_code: "CUSTOMER_CREDENTIAL_INVALID",
      customer_message:
        "The credentials you submitted are invalid, expired, or missing required permissions. Please update your setup details to continue.",
    };
  }

  return {
    needs_customer_action: false,
    error_code: "WORKFLOW_TRIGGER_FAILED",
    customer_message:
      "This automation could not be started. Nexus has been notified and will review it.",
  };
}

async function recordTriggerError(
  adminClient: any,
  customerAutomation: any,
  message: string,
  rawError: Record<string, unknown> = {},
) {
  const now = new Date().toISOString();
  const classification = classifyImmediateWebhookError(message);

  await safeUpdateCustomerAutomation(adminClient, customerAutomation.id, {
    status: classification.needs_customer_action ? "setup_error" : "error",
    runtime_status: "error",
    health_status: classification.needs_customer_action ? "needs_customer_action" : "error",
    setup_status: classification.needs_customer_action ? "needs_update" : "submitted",

    needs_customer_action: classification.needs_customer_action,
    last_error_code: classification.error_code,
    last_error_node: "n8n webhook trigger",
    last_error_message: classification.customer_message,
    last_error_details: {
      message,
      raw_error: rawError,
    },
    last_failed_at: now,

    updated_at: now,
  });

  await adminClient.from("automation_run_errors").insert({
    customer_automation_id: customerAutomation.id,
    buyer_id: customerAutomation.buyer_id || null,
    automation_id: customerAutomation.automation_id || null,
    order_id: customerAutomation.order_id || null,

    source: "submit-automation-setup",
    error_type: classification.needs_customer_action
      ? "credential_error"
      : "workflow_trigger_error",
    error_code: classification.error_code,
    error_node: "n8n webhook trigger",
    error_message: message,
    customer_message: classification.customer_message,
    raw_error: rawError || {},
    needs_customer_action: classification.needs_customer_action,
    resolved: false,
    created_at: now,
  });

  await insertAutomationEvent(adminClient, {
    customer_automation_id: customerAutomation.id,
    buyer_id: customerAutomation.buyer_id,
    automation_id: customerAutomation.automation_id,
    order_id: customerAutomation.order_id,
    event_type: classification.needs_customer_action
      ? "customer_action_required"
      : "runtime_error",
    title: classification.needs_customer_action
      ? "Customer action required"
      : "Automation trigger failed",
    message: JSON.stringify({
      error_code: classification.error_code,
      customer_message: classification.customer_message,
      admin_error_message: message,
    }),
    created_by: "runtime",
  });
}

Deno.serve(async (req) => {
  /*
    CORS must be the very first runtime branch.
    Do not authenticate OPTIONS requests.
  */
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: corsHeaders,
    });
  }

  if (req.method === "GET") {
    return jsonResponse({
      ok: true,
      message: "submit-automation-setup is alive.",
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

    if (!supabaseUrl || !serviceRoleKey) {
      return errorResponse("Missing Supabase function secrets.", 500);
    }

    const token = getBearerToken(req);
    if (!token) {
      return errorResponse("Missing authorization token.", 401);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: userResult, error: userError } = await adminClient.auth.getUser(token);

    if (userError || !userResult?.user) {
      return errorResponse(userError?.message || "Invalid user session.", 401);
    }

    const user = userResult.user;
    const body = await req.json().catch(() => ({}));

    const customerAutomationId = cleanString(
      body.customer_automation_id ||
        body.customerAutomationId ||
        body.id,
    );

    if (!isUuid(customerAutomationId)) {
      return errorResponse("A valid customer_automation_id is required.", 400);
    }

    const answers = normalizeJsonObject(body.answers || body.setup || {});

    const loaded = await loadCustomerAutomation(adminClient, customerAutomationId);

    if (loaded.error || !loaded.data) {
      return errorResponse(
        loaded.error instanceof Error ? loaded.error.message : "Customer automation not found.",
        404,
      );
    }

    const customerAutomation = loaded.data;
    const automation = loaded.automation || {};
    const order = loaded.order || {};

    if (customerAutomation.buyer_id && customerAutomation.buyer_id !== user.id) {
      return errorResponse("You do not have access to this automation.", 403);
    }

    const setupSchema = normalizeJsonArray(automation.setup_schema);
    const credentialSchema = normalizeJsonArray(automation.credential_schema);

    const { setupAnswers, secretAnswers, credentialKeys } = splitSetupAndSecrets(
      answers,
      credentialSchema,
    );

    /*
      Safety fallback for old temporary testing setup:
      If the credential schema expects meta_access_token but it is missing and brand_notes looks like a token,
      use it. This keeps the launch test flow working without depending on this behavior long-term.
    */
    let usedBrandNotesAsMetaToken = false;
    if (
      credentialKeys.includes("meta_access_token") &&
      !secretAnswers.meta_access_token &&
      cleanString(setupAnswers.brand_notes).startsWith("EAA")
    ) {
      secretAnswers.meta_access_token = cleanString(setupAnswers.brand_notes);
      usedBrandNotesAsMetaToken = true;
    }

    const { savedCredentialKeys } = await saveCustomerCredentials(
      adminClient,
      customerAutomation,
      secretAnswers,
    );

    const savedSecrets = await loadSavedCredentials(adminClient, customerAutomation.id);

    const submissionResult = await saveSetupSubmission(adminClient, {
      customer_automation: customerAutomation,
      answers,
      setup_answers: setupAnswers,
      credential_keys_available: Object.keys(savedSecrets),
    });

    if (submissionResult.error || !submissionResult.data) {
      return errorResponse(
        submissionResult.error?.message || "Could not save setup submission.",
        500,
      );
    }

    const submission = submissionResult.data;
    const now = new Date().toISOString();

    /*
      Important retry behavior:
      Immediately clear old errors and move the automation from setup_error/error to running
      as soon as the customer resubmits.
    */
    const runningUpdateError = await safeUpdateCustomerAutomation(
      adminClient,
      customerAutomation.id,
      {
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

        n8n_last_execution_id: null,
        n8n_last_execution_status: null,
        n8n_last_execution_checked_at: null,

        updated_at: now,
      },
    );

    if (runningUpdateError) {
      return errorResponse(runningUpdateError.message, 500);
    }

    await insertAutomationEvent(adminClient, {
      customer_automation_id: customerAutomation.id,
      buyer_id: customerAutomation.buyer_id,
      automation_id: customerAutomation.automation_id,
      order_id: customerAutomation.order_id,
      event_type: "setup_submitted",
      title: "Setup submitted",
      message: JSON.stringify({
        setup_keys: Object.keys(setupAnswers),
        credential_keys_available: Object.keys(savedSecrets),
      }),
      created_by: "buyer",
    });

    const runtimeType = getRuntimeType(customerAutomation, automation);
    const webhookUrl = getRuntimeWebhookUrl(customerAutomation, automation, order);

    const shouldTriggerN8n =
      runtimeType === "n8n_managed" ||
      Boolean(webhookUrl);

    if (!shouldTriggerN8n || !webhookUrl) {
      await safeUpdateCustomerAutomation(adminClient, customerAutomation.id, {
        status: "setup_submitted",
        runtime_status: "not_started",
        health_status: "pending",
        setup_status: "submitted",
        updated_at: new Date().toISOString(),
      });

      return jsonResponse({
        ok: true,
        status: "submitted",
        triggered_n8n: false,
        submission_id: submission.id,
        setup_keys: Object.keys(setupAnswers),
        credential_keys_available: Object.keys(savedSecrets),
        used_brand_notes_as_meta_token: usedBrandNotesAsMetaToken,
      });
    }

    let triggerResult: any = null;

    try {
      triggerResult = await triggerN8nWebhook({
        webhookUrl,
        customerAutomation,
        automation,
        order,
        user,
        setupAnswers,
        secrets: savedSecrets,
        savedCredentialKeys,
        submissionId: submission.id,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      await recordTriggerError(adminClient, customerAutomation, message, {
        webhook_url: webhookUrl,
      });

      return errorResponse(message, 502, {
        status: "trigger_failed",
        triggered_n8n: false,
      });
    }

    const executionId = triggerResult?.executionId || "";

    if (executionId) {
      await safeUpdateCustomerAutomation(adminClient, customerAutomation.id, {
        n8n_last_execution_id: executionId,
        n8n_last_execution_status: "started",
        n8n_last_execution_checked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    await insertAutomationRun(adminClient, {
      customer_automation_id: customerAutomation.id,
      buyer_id: customerAutomation.buyer_id,
      automation_id: customerAutomation.automation_id,
      order_id: customerAutomation.order_id,
      runtime_type: runtimeType || "n8n_managed",
      trigger_type: "buyer_setup_submit",
      status: "running",
      n8n_execution_id: executionId || null,
      started_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    await insertAutomationEvent(adminClient, {
      customer_automation_id: customerAutomation.id,
      buyer_id: customerAutomation.buyer_id,
      automation_id: customerAutomation.automation_id,
      order_id: customerAutomation.order_id,
      event_type: "runtime_triggered",
      title: "Automation started",
      message: JSON.stringify({
        runtime_type: runtimeType,
        webhook_path: getRuntimeWebhookPath(customerAutomation, automation, order),
        n8n_execution_id: executionId || null,
      }),
      created_by: "runtime",
    });

    const n8nCheckResult = await checkN8nExecutionAfterTrigger(customerAutomation.id);

    return jsonResponse({
      ok: true,
      status: "submitted_and_triggered",
      triggered_n8n: true,
      submission_id: submission.id,
      setup_keys: Object.keys(setupAnswers),
      credential_keys_available: Object.keys(savedSecrets),
      used_brand_notes_as_meta_token: usedBrandNotesAsMetaToken,
      n8n_execution_id: executionId || null,
      n8n_check: n8nCheckResult,
    });
  } catch (error) {
    console.error("submit-automation-setup failed:", error);

    return errorResponse(
      error instanceof Error ? error.message : "Could not submit automation setup.",
      500,
    );
  }
});
