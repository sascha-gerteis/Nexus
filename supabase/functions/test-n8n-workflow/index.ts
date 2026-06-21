import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

function env(name: string) {
  return Deno.env.get(name) || "";
}

function cleanString(value: unknown) {
  return String(value ?? "").trim();
}

function cleanBaseUrl(url: string) {
  return String(url || "").replace(/\/+$/, "");
}

function stringifySafe(value: unknown) {
  try {
    if (typeof value === "string") return value;
    return JSON.stringify(value || {});
  } catch {
    return String(value || "");
  }
}

function parseJson(value: unknown, fallback: any) {
  if (Array.isArray(value) || (value && typeof value === "object")) return value;

  const raw = cleanString(value);
  if (!raw) return fallback;

  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizeSchema(value: unknown) {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
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

function usefulString(value: unknown) {
  const cleaned = cleanString(value);
  if (!cleaned) return "";
  if (cleaned === "{}" || cleaned === "[]" || cleaned === "[object Object]") return "";
  return cleaned;
}

function pickFirstUsefulString(...values: unknown[]) {
  for (const value of values) {
    const cleaned = usefulString(value);
    if (cleaned) return cleaned;
  }

  return "";
}

function isTerminalStatus(status: string) {
  const safe = cleanString(status).toLowerCase();
  return [
    "passed",
    "failed",
    "execution_not_found_after_timeout",
    "passed_with_expected_test_callback_error",
    "cancelled",
    "timeout"
  ].includes(safe);
}

async function getUserFromRequest(req: Request, supabaseUrl: string, anonKey: string) {
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return null;

  const token = authHeader.replace("Bearer ", "").trim();

  const userClient = createClient(supabaseUrl, anonKey, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  });

  const { data, error } = await userClient.auth.getUser(token);

  if (error || !data?.user) return null;

  return data.user;
}

async function getOperatorContext(adminClient: any, userId: string) {
  const { data, error } = await adminClient
    .from("profiles")
    .select("id, role")
    .eq("id", userId)
    .maybeSingle();

  if (error || !data || !["admin", "developer"].includes(data.role)) {
    return null;
  }

  if (data.role !== "developer") {
    return { profile: data, developer: null };
  }

  const { data: developer, error: developerError } = await adminClient
    .from("developers")
    .select("id, profile_id")
    .eq("profile_id", userId)
    .maybeSingle();

  if (developerError || !developer) return null;

  return { profile: data, developer };
}

function canAccessAutomation(operator: any, automation: any) {
  if (operator?.profile?.role === "admin") return true;
  return Boolean(operator?.developer?.id && automation?.developer_id === operator.developer.id);
}

function canAccessTestRun(operator: any, testRun: any) {
  if (operator?.profile?.role === "admin") return true;
  return Boolean(operator?.developer?.id && testRun?.developer_id === operator.developer.id);
}

function testValueForField(field: any) {
  const name = cleanString(field?.name).toLowerCase();
  const type = cleanString(field?.type).toLowerCase();

  if (name.includes("email")) return "admin-test@nexus.local";
  if (name.includes("url") || type === "url") return "https://example.com";
  if (name.includes("page_id")) return "1234567890";
  if (name.includes("business_account_id")) return "17841400000000000";
  if (name.includes("channel_id")) return "UC_TEST_CHANNEL_ID";
  if (name.includes("username") || name.includes("handle")) return "test_brand";
  if (name.includes("company") || name.includes("brand")) return "Nexus Test Brand";
  if (name.includes("frequency")) return "Weekly";
  if (type === "number") return 1;
  if (type === "select" && Array.isArray(field?.options) && field.options.length) {
    return field.options[0];
  }
  if (type === "textarea") return "This is a Nexus technical test run. Values are placeholders.";
  return "TEST_VALUE";
}

function buildSetupFromSchema(setupSchema: any[]) {
  const setup: Record<string, unknown> = {};

  for (const field of setupSchema) {
    const key = cleanString(field?.name);
    if (!key) continue;
    setup[key] = testValueForField(field);
  }

  return setup;
}

function buildSecretsFromSchema(credentialSchema: any[]) {
  const secrets: Record<string, string> = {};

  for (const field of credentialSchema) {
    const key = cleanString(field?.name);
    if (!key) continue;
    secrets[key] = "NEXUS_TEST_SECRET_VALUE";
  }

  return secrets;
}

function mergeObjectValues(base: Record<string, unknown>, override: unknown) {
  const cleanOverride = asObject(override);
  return {
    ...(base || {}),
    ...cleanOverride,
  };
}

async function loadDefaultTestProfile(adminClient: any, automationId: string) {
  if (!automationId) return null;

  const { data, error } = await adminClient
    .from("automation_test_profiles")
    .select("*")
    .eq("automation_id", automationId)
    .eq("is_default", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    /*
      Do not break technical tests if the profile table has not been added yet.
      The function falls back to generated fake values.
    */
    const message = String(error.message || "").toLowerCase();

    if (
      message.includes("automation_test_profiles") ||
      message.includes("does not exist") ||
      message.includes("schema cache")
    ) {
      console.warn("automation_test_profiles unavailable; using generated test values:", error.message);
      return null;
    }

    throw new Error(`Could not load automation test profile: ${error.message}`);
  }

  return data || null;
}

function buildTestSetupAndSecrets(automation: any, testProfile: any) {
  const setupSchema = normalizeSchema(automation.setup_schema);
  const credentialSchema = normalizeSchema(automation.credential_schema);

  const generatedSetup = buildSetupFromSchema(setupSchema);
  const generatedSecrets = buildSecretsFromSchema(credentialSchema);

  if (!testProfile) {
    return {
      setup: generatedSetup,
      secrets: generatedSecrets,
      used_test_profile: false,
      test_profile_id: null,
      test_profile_name: null,
    };
  }

  /*
    Merge generated defaults with saved profile values.
    Saved profile values win. Generated values keep optional/missing
    workflow fields from becoming undefined during early testing.
  */
  return {
    setup: mergeObjectValues(generatedSetup, testProfile.setup_values),
    secrets: mergeObjectValues(generatedSecrets, testProfile.secret_values) as Record<string, string>,
    used_test_profile: true,
    test_profile_id: testProfile.id || null,
    test_profile_name: testProfile.name || "Default test profile",
  };
}

function buildCallbackUrl() {
  const supabaseUrl = cleanBaseUrl(env("SUPABASE_URL"));
  return `${supabaseUrl}/functions/v1/runtime-submit-output`;
}

async function n8nFetch(path: string, options: RequestInit = {}) {
  const baseUrl = cleanBaseUrl(env("N8N_BASE_URL"));
  const apiKey = env("N8N_API_KEY");

  if (!baseUrl || !apiKey) {
    throw new Error("Missing N8N_BASE_URL or N8N_API_KEY Supabase secrets.");
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
    data = {
      raw: text,
    };
  }

  if (!response.ok) {
    throw new Error(
      data?.message ||
        data?.error ||
        data?.raw ||
        `n8n API request failed with status ${response.status}`,
    );
  }

  return data;
}

async function getExecutionById(executionId: string) {
  if (!executionId) return null;
  return await n8nFetch(`/api/v1/executions/${encodeURIComponent(executionId)}?includeData=true`);
}

async function activateWorkflow(workflowId: string) {
  if (!workflowId) return null;
  return await n8nFetch(`/api/v1/workflows/${encodeURIComponent(workflowId)}/activate`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

async function deactivateWorkflow(workflowId: string) {
  if (!workflowId) return null;
  return await n8nFetch(`/api/v1/workflows/${encodeURIComponent(workflowId)}/deactivate`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

function shouldDeactivateAfterTechnicalTest(automation: any) {
  return !["active", "published"].includes(cleanString(automation?.status).toLowerCase());
}

async function listRecentExecutions(workflowId: string) {
  const encodedWorkflowId = encodeURIComponent(workflowId);
  const data = await n8nFetch(`/api/v1/executions?workflowId=${encodedWorkflowId}&limit=25`);

  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data)) return data;

  return [];
}

function executionTimestamp(execution: any) {
  const raw =
    execution?.startedAt ||
    execution?.stoppedAt ||
    execution?.createdAt ||
    execution?.created_at ||
    execution?.finishedAt ||
    "";

  const time = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function executionIdOf(execution: any) {
  return cleanString(execution?.id || execution?.executionId || execution?.execution_id);
}

function resultDataOf(execution: any) {
  return asObject(
    execution?.data?.resultData ||
      execution?.data?.executionData?.resultData ||
      execution?.resultData,
  );
}

function errorMessageFromObject(error: any) {
  const safe = asObject(error);
  const cause = asObject(safe.cause);
  const context = asObject(safe.context);

  return pickFirstUsefulString(
    safe.message,
    safe.description,
    safe.errorMessage,
    safe.reason,
    cause.message,
    cause.description,
    context.message,
    context.description,
    typeof error === "string" ? error : "",
    stringifySafe(error),
  );
}

function extractKnownN8nErrorText(value: unknown) {
  const raw = stringifySafe(value)
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n");
  const forbidden = raw.match(/Forbidden\s+-\s+perhaps check your credentials\??/i);
  const modelAccess = raw.match(/Project\s+[A-Za-z0-9_-]+\s+does not have access to model\s+[A-Za-z0-9_.:-]+/i);
  const incorrectKey = raw.match(/Incorrect API key provided:\s*[^.\n\r"]+/i);

  if (forbidden && modelAccess) return `${forbidden[0]} ${modelAccess[0]}`;
  if (modelAccess) return modelAccess[0];
  if (incorrectKey) return incorrectKey[0];

  const patterns = [
    /Credential with ID\s+"[^"]+"\s+does not exist for type\s+"[^"]+"/i,
    /Project\s+[A-Za-z0-9_-]+\s+does not have access to model\s+[A-Za-z0-9_.:-]+/i,
    /Incorrect API key provided:\s*[^.\n\r"]+/i,
    /Forbidden\s+-\s+perhaps check your credentials\??/i,
    /Authorization failed\s+-\s+please check your credentials[^"\n\r]*(?:Missing authorization header)?/i,
    /config\.headers\.setContentType is not a function/i,
    /Missing authorization header/i,
    /UNAUTHORIZED_NO_AUTH_HEADER/i,
    /NodeOperationError:\s*([^\n\r]+)/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const message = usefulString(match?.[1] || match?.[0]);
    if (message) return message;
  }

  return "";
}

function extractRunDataError(resultData: Record<string, unknown>) {
  const runData = asObject(resultData.runData);

  for (const [nodeName, entries] of Object.entries(runData)) {
    const nodeExecutions = Array.isArray(entries) ? entries : [entries];

    for (const entry of nodeExecutions) {
      const safeEntry = asObject(entry);
      const error = safeEntry.error;
      const message = errorMessageFromObject(error);

      if (message) {
        const safeError = asObject(error);
        const node = asObject(safeError.node);

        return {
          message,
          node: pickFirstUsefulString(node.name, safeError.nodeName, nodeName),
          node_type: pickFirstUsefulString(node.type, safeError.nodeType, safeEntry.nodeType),
          raw_error: error || {},
        };
      }
    }
  }

  return null;
}

function formatExecutionErrorMessage(message: string, nodeName: string, nodeType: string) {
  if (!message) return "";

  const parts = [message];
  const nodeParts = [nodeName, nodeType].filter(Boolean).join(" / ");

  if (nodeParts) {
    parts.push(`Node: ${nodeParts}`);
  }

  return parts.join(" ");
}

function extractExecutionError(execution: any) {
  const resultData = resultDataOf(execution);
  const error =
    resultData.error ||
    execution?.error ||
    execution?.data?.error ||
    null;

  const runDataError = extractRunDataError(resultData);
  const status = cleanString(execution?.status).toLowerCase();
  const shouldScanRawErrorText = Boolean(error || runDataError || ["error", "failed", "crashed"].includes(status));

  const node = asObject(asObject(error).node);
  const lastNodeExecuted = pickFirstUsefulString(
    resultData.lastNodeExecuted,
    execution?.lastNodeExecuted,
    node.name,
    asObject(error).nodeName,
    runDataError?.node,
  );

  const nodeType = pickFirstUsefulString(
    node.type,
    asObject(error).nodeType,
    runDataError?.node_type,
  );
  const knownMessage = shouldScanRawErrorText ? pickFirstUsefulString(
    extractKnownN8nErrorText(resultData),
    extractKnownN8nErrorText(execution),
  ) : "";
  const objectMessage = pickFirstUsefulString(
    errorMessageFromObject(error),
    runDataError?.message,
  );
  const message =
    knownMessage && (!objectMessage || knownMessage.length > objectMessage.length)
      ? knownMessage
      : pickFirstUsefulString(objectMessage, knownMessage);

  return {
    message,
    display_message: formatExecutionErrorMessage(message, lastNodeExecuted, nodeType),
    node: lastNodeExecuted,
    node_type: nodeType,
    raw_error: error || runDataError?.raw_error || {},
  };
}

function hasExecutionError(execution: any) {
  const extracted = extractExecutionError(execution);
  const status = cleanString(execution?.status).toLowerCase();

  return Boolean(extracted.message || extracted.display_message) ||
    status === "error" ||
    status === "failed" ||
    status === "crashed";
}

function executionStatusOf(execution: any) {
  const status = cleanString(
    execution?.status ||
      execution?.finished ||
      execution?.mode ||
      execution?.data?.status,
  ).toLowerCase();

  if (hasExecutionError(execution)) return "error";
  if (status === "true") return "success";
  if (status === "false" && execution?.stoppedAt) return "error";
  if (status === "false") return "running";
  if (execution?.stoppedAt && !hasExecutionError(execution)) return "success";

  return status || "unknown";
}

function classifyExecution(execution: any) {
  const status = executionStatusOf(execution);
  const extractedError = extractExecutionError(execution);
  const rawMessage = extractedError.message || "";
  const message = extractedError.display_message || rawMessage || "";
  const lower = message.toLowerCase();

  /*
    If workflow reaches runtime-submit-output with fake customer ID,
    callback may reject the fake ID. That means the workflow reached
    Nexus output callback, so the technical route is working.
  */
  const reachedNexusCallback =
    lower.includes("customer automation not found") ||
    lower.includes("customer_automation") ||
    lower.includes("runtime-submit-output");

  if (lower.includes("missing authorization header") || lower.includes("unauthorized_no_auth_header")) {
    return {
      ok: false,
      status: "failed",
      message:
        "Nexus output callback was blocked by Supabase before runtime-submit-output could run. Deploy runtime-submit-output with verify_jwt=false.",
      error_node: extractedError.node || "Nexus Submit Output",
      error_node_type: extractedError.node_type,
      error_message: rawMessage || message || "Missing authorization header.",
      raw_error: extractedError.raw_error,
    };
  }

  if (reachedNexusCallback) {
    return {
      ok: true,
      status: "passed_with_expected_test_callback_error",
      message:
        "Workflow reached the Nexus output callback. The callback rejected the fake test customer automation ID, which is expected in a technical test.",
      error_node: extractedError.node,
      error_node_type: extractedError.node_type,
      error_message: rawMessage || message,
      raw_error: extractedError.raw_error,
    };
  }

  if (hasExecutionError(execution)) {
    return {
      ok: false,
      status: "failed",
      message: message || "n8n execution failed.",
      error_node: extractedError.node,
      error_node_type: extractedError.node_type,
      error_message: message || "n8n execution failed.",
      raw_error: extractedError.raw_error,
    };
  }

  if (status === "success" || status === "completed") {
    return {
      ok: true,
      status: "passed",
      message: "n8n execution completed successfully.",
      error_node: "",
      error_message: "",
      raw_error: {},
    };
  }

  return {
    ok: true,
    status: "running",
    message: `n8n execution is still ${status}.`,
    error_node: "",
    error_message: "",
    raw_error: {},
  };
}

async function triggerWorkflow(webhookUrl: string, automation: any, testRun: any, testProfile: any = null) {
  const testData = buildTestSetupAndSecrets(automation, testProfile);

  const setup = testData.setup;
  const secrets = testData.secrets;
  const runtimeSecret = env("NEXUS_RUNTIME_SECRET");

  const payload = {
    status: "test",
    test_mode: true,
    test_id: testRun.test_id,
    test_run_id: testRun.id,
    used_test_profile: testData.used_test_profile,
    test_profile_id: testData.test_profile_id,
    test_profile_name: testData.test_profile_name,

    customer_automation_id: `TEST_ADMIN_RUN_${testRun.test_id}`,
    automation_id: automation.id,
    order_id: `TEST_ORDER_${testRun.test_id}`,
    buyer_id: `TEST_BUYER_${testRun.test_id}`,

    setup,
    secrets,

    customer: {
      id: `TEST_BUYER_${testRun.test_id}`,
      email: "admin-test@nexus.local",
      name: "Nexus Admin Test",
      order_id: `TEST_ORDER_${testRun.test_id}`,
    },

    system: {
      test_mode: true,
      test_id: testRun.test_id,
      test_run_id: testRun.id,
      customer_automation_id: `TEST_ADMIN_RUN_${testRun.test_id}`,
      automation_id: automation.id,
      order_id: `TEST_ORDER_${testRun.test_id}`,
      buyer_id: `TEST_BUYER_${testRun.test_id}`,
      callback_url: buildCallbackUrl(),
      runtime_secret: runtimeSecret,
      runtime_type: automation.runtime_type || "n8n_managed",
      n8n_workflow_id: automation.n8n_workflow_id || "",
      used_test_profile: testData.used_test_profile,
      test_profile_id: testData.test_profile_id,
      test_profile_name: testData.test_profile_name,
    },
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-nexus-runtime-secret": runtimeSecret,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let data: any = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {
      raw: text,
    };
  }

  if (!response.ok) {
    throw new Error(
      data?.message ||
        data?.error ||
        data?.raw ||
        `n8n test webhook failed with status ${response.status}`,
    );
  }

  return {
    response: data,
    execution_id: pickFirstString(data?.executionId, data?.execution_id, data?.data?.executionId, data?.id),
  };
}

async function findExecutionForTestRun(testRun: any) {
  if (testRun.n8n_execution_id) {
    const byId = await getExecutionById(testRun.n8n_execution_id).catch(() => null);
    if (byId) return byId;
  }

  const workflowId = cleanString(testRun.n8n_workflow_id);
  if (!workflowId) return null;

  const startedAtMs = testRun.started_at
    ? new Date(testRun.started_at).getTime()
    : Date.now() - 60_000;

  const recent = await listRecentExecutions(workflowId);
  const candidates = recent
    .filter((execution: any) => {
      const ts = executionTimestamp(execution);
      return !ts || ts >= startedAtMs - 20_000;
    })
    .sort((a: any, b: any) => executionTimestamp(b) - executionTimestamp(a));

  if (!candidates.length) return null;

  /*
    Fetch details. Prefer executions whose full data includes this test_id.
    This is important when multiple tests/customers run the same workflow.
  */
  const detailed: any[] = [];

  for (const candidate of candidates.slice(0, 8)) {
    const id = executionIdOf(candidate);
    const full = id ? await getExecutionById(id).catch(() => candidate) : candidate;
    detailed.push(full);
  }

  const exactMatch = detailed.find((execution) => {
    const raw = stringifySafe(execution);
    return raw.includes(testRun.test_id) || raw.includes(testRun.id);
  });

  return exactMatch || detailed[0] || candidates[0];
}

async function updateAutomationTestResult(adminClient: any, automationId: string, result: any) {
  const storedResult = {
    ...result,
    raw_execution: undefined,
    webhook_response: undefined,
  };

  const { error } = await adminClient
    .from("automations")
    .update({
      n8n_last_test_status: result.status,
      n8n_last_test_error: result.ok ? null : result.error_message || result.message,
      n8n_last_test_result: storedResult,
      n8n_last_tested_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", automationId);

  if (error) {
    console.warn("Could not update automations test columns:", error.message);
  }
}

async function updateTestRun(adminClient: any, testRunId: string, updates: Record<string, unknown>) {
  const { data, error } = await adminClient
    .from("automation_test_runs")
    .update({
      ...updates,
      updated_at: new Date().toISOString(),
    })
    .eq("id", testRunId)
    .select()
    .single();

  if (error) {
    /*
      Older MVP databases may have an automation_test_runs table that is missing
      newer audit columns or stricter status constraints. Do not let that break
      the dashboard poll after n8n already finished. Return a synthetic merged row
      so the caller can still update automations.n8n_last_test_status and respond.
    */
    console.warn("Could not update automation test run:", error.message);

    const { data: existing } = await adminClient
      .from("automation_test_runs")
      .select("*")
      .eq("id", testRunId)
      .maybeSingle();

    return {
      ...(existing || { id: testRunId }),
      ...updates,
      updated_at: new Date().toISOString(),
      _update_warning: error.message,
    };
  }

  return data;
}

async function loadAutomation(adminClient: any, automationId: string) {
  const { data, error } = await adminClient
    .from("automations")
    .select("*")
    .eq("id", automationId)
    .maybeSingle();

  if (error || !data) {
    throw new Error(error?.message || "Automation not found.");
  }

  return data;
}

async function loadTestRun(adminClient: any, body: any) {
  const testRunId = cleanString(body.test_run_id || body.testRunId);
  const automationId = cleanString(body.automation_id || body.automationId);

  let query = adminClient.from("automation_test_runs").select("*");

  if (testRunId) {
    query = query.eq("id", testRunId);
  } else if (automationId) {
    query = query.eq("automation_id", automationId).order("created_at", { ascending: false }).limit(1);
  } else {
    throw new Error("test_run_id or automation_id is required.");
  }

  const { data, error } = testRunId
    ? await query.maybeSingle()
    : await query.maybeSingle();

  if (error || !data) {
    throw new Error(error?.message || "No test run found.");
  }

  return data;
}

function publicRunPayload(testRun: any, extra: Record<string, unknown> = {}) {
  const elapsedSeconds = testRun.started_at
    ? Math.max(0, Math.round((Date.now() - new Date(testRun.started_at).getTime()) / 1000))
    : Number(testRun.elapsed_seconds || 0);

  return {
    ok: !["failed", "execution_not_found_after_timeout", "timeout"].includes(cleanString(testRun.status)),
    status: testRun.status,
    test_run_id: testRun.id,
    test_id: testRun.test_id,
    automation_id: testRun.automation_id,
    workflow_id: testRun.n8n_workflow_id,
    execution_id: testRun.n8n_execution_id,
    elapsed_seconds: Number(testRun.elapsed_seconds || elapsedSeconds),
    started_at: testRun.started_at,
    finished_at: testRun.finished_at,
    last_checked_at: testRun.last_checked_at,
    error_node: testRun.error_node,
    error_message: testRun.error_message,
    message:
      testRun.error_message ||
      (testRun.status === "running"
        ? "Technical test is still running."
        : `Technical test status: ${testRun.status}`),
    raw_execution: testRun.raw_execution || {},
    webhook_response: testRun.webhook_response || {},
    ...extra,
  };
}

async function startTestRun(adminClient: any, automation: any, userId: string, options: Record<string, unknown> = {}) {
  const workflowId = cleanString(automation.n8n_workflow_id);
  const webhookUrl = pickFirstString(automation.runtime_webhook_url, automation.n8n_webhook_url);
  const forceNew = Boolean(options.force_new || options.forceNew);

  if (!workflowId) {
    throw new Error("This automation has no n8n_workflow_id. Import the workflow first.");
  }

  if (!webhookUrl) {
    throw new Error("This automation has no runtime webhook URL. Import the workflow first.");
  }

  if (!forceNew) {
    /*
      If a test is already running, return it instead of starting another.
      Credential updates pass force_new so every key change gets its own run.
    */
    const { data: existingRunning } = await adminClient
      .from("automation_test_runs")
      .select("*")
      .eq("automation_id", automation.id)
      .eq("status", "running")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingRunning) {
      return publicRunPayload(existingRunning, {
        reused_existing_run: true,
        message: "A technical test is already running. Nexus resumed the existing run instead of starting a new one.",
      });
    }
  }

  const now = new Date().toISOString();
  const testId = crypto.randomUUID();

  const { data: testRun, error } = await adminClient
    .from("automation_test_runs")
    .insert({
      automation_id: automation.id,
      developer_id: automation.developer_id || null,
      test_id: testId,
      n8n_workflow_id: workflowId,
      status: "running",
      started_at: now,
      last_checked_at: now,
      elapsed_seconds: 0,
      created_by: userId,
      created_at: now,
      updated_at: now,
    })
    .select()
    .single();

  if (error || !testRun) {
    throw new Error(error?.message || "Could not create automation test run.");
  }

  const deactivateAfterTest = shouldDeactivateAfterTechnicalTest(automation);
  let activationResult: unknown = null;
  let deactivationResult: unknown = null;

  try {
    if (deactivateAfterTest) {
      activationResult = await activateWorkflow(workflowId);
    }

    const testProfile = await loadDefaultTestProfile(adminClient, automation.id);
    const trigger = await triggerWorkflow(webhookUrl, automation, testRun, testProfile);

    if (deactivateAfterTest) {
      try {
        deactivationResult = await deactivateWorkflow(workflowId);
      } catch (deactivationError) {
        deactivationResult = {
          warning: deactivationError instanceof Error ? deactivationError.message : String(deactivationError),
        };
      }
    }

    const updated = await updateTestRun(adminClient, testRun.id, {
      webhook_response: {
        ...(trigger.response || {}),
        used_test_profile: Boolean(testProfile?.id),
        test_profile_id: testProfile?.id || null,
        test_profile_name: testProfile?.name || null,
        temporary_activation: deactivateAfterTest,
        activation_result: activationResult,
        deactivation_result: deactivationResult,
      },
      n8n_execution_id: trigger.execution_id || null,
      last_checked_at: new Date().toISOString(),
    });

    const startResult = publicRunPayload(updated, {
      status: "running",
      used_test_profile: Boolean(testProfile?.id),
      test_profile_id: testProfile?.id || null,
      test_profile_name: testProfile?.name || null,
      message: testProfile?.id
        ? "Technical test started using the saved test profile. Nexus will keep checking the central n8n execution."
        : "Technical test started using generated placeholder values because no test profile is saved yet.",
    });

    await updateAutomationTestResult(adminClient, automation.id, startResult);

    return startResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (deactivateAfterTest) {
      try {
        deactivationResult = await deactivateWorkflow(workflowId);
      } catch (deactivationError) {
        deactivationResult = {
          warning: deactivationError instanceof Error ? deactivationError.message : String(deactivationError),
        };
      }
    }

    const failed = await updateTestRun(adminClient, testRun.id, {
      status: "failed",
      finished_at: new Date().toISOString(),
      last_checked_at: new Date().toISOString(),
      error_node: "n8n webhook trigger",
      error_message: message,
      error_details: {
        message,
        temporary_activation: deactivateAfterTest,
        activation_result: activationResult,
        deactivation_result: deactivationResult,
      },
    });

    const result = publicRunPayload(failed, {
      ok: false,
      status: "failed",
      message,
    });

    await updateAutomationTestResult(adminClient, automation.id, result);

    return result;
  }
}

async function checkTestRun(adminClient: any, testRun: any) {
  const now = new Date();
  const elapsedSeconds = testRun.started_at
    ? Math.max(0, Math.round((now.getTime() - new Date(testRun.started_at).getTime()) / 1000))
    : Number(testRun.elapsed_seconds || 0);

  if (isTerminalStatus(testRun.status)) {
    return publicRunPayload(testRun);
  }

  const execution = await findExecutionForTestRun(testRun);

  if (!execution) {
    /*
      Do not fail quickly. Keep it running. If it has been very long,
      make it a clear timeout so dev sees Nexus could not verify it.
    */
    const timeoutSeconds = 60 * 60; // 1 hour

    if (elapsedSeconds >= timeoutSeconds) {
      const timedOut = await updateTestRun(adminClient, testRun.id, {
        status: "execution_not_found_after_timeout",
        finished_at: now.toISOString(),
        last_checked_at: now.toISOString(),
        elapsed_seconds: elapsedSeconds,
        error_message:
          "Nexus triggered the webhook but could not find the matching n8n execution after 1 hour.",
      });

      const result = publicRunPayload(timedOut, {
        ok: false,
      });

      await updateAutomationTestResult(adminClient, testRun.automation_id, result);

      return result;
    }

    const stillRunning = await updateTestRun(adminClient, testRun.id, {
      status: "running",
      last_checked_at: now.toISOString(),
      elapsed_seconds: elapsedSeconds,
    });

    const result = publicRunPayload(stillRunning, {
      ok: true,
      status: "running",
      message:
        "Technical test is still running or waiting for n8n execution history. Nexus will keep checking.",
    });

    await updateAutomationTestResult(adminClient, testRun.automation_id, result);

    return result;
  }

  const executionId = executionIdOf(execution);
  const classified = classifyExecution(execution);

  if (classified.status === "running") {
    const running = await updateTestRun(adminClient, testRun.id, {
      status: "running",
      n8n_execution_id: executionId || testRun.n8n_execution_id || null,
      last_checked_at: now.toISOString(),
      elapsed_seconds: elapsedSeconds,
      raw_execution: execution,
    });

    const result = publicRunPayload(running, {
      ok: true,
      status: "running",
      message: classified.message,
    });

    await updateAutomationTestResult(adminClient, testRun.automation_id, result);

    return result;
  }

  const finished = await updateTestRun(adminClient, testRun.id, {
    status: classified.status,
    n8n_execution_id: executionId || testRun.n8n_execution_id || null,
    finished_at: now.toISOString(),
    last_checked_at: now.toISOString(),
    elapsed_seconds: elapsedSeconds,
    error_node: classified.error_node || null,
    error_message: classified.ok ? null : classified.error_message || classified.message,
    error_details: classified.raw_error || {},
    raw_execution: execution,
  });

  const result = publicRunPayload(finished, {
    ok: classified.ok,
    status: classified.status,
    message: classified.message,
    error_node: classified.error_node,
    error_node_type: classified.error_node_type,
    error_message: classified.error_message,
  });

  await updateAutomationTestResult(adminClient, testRun.automation_id, result);

  return result;
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
      message: "test-n8n-workflow is alive with persistent start/check/latest modes.",
      modes: ["start", "check", "latest"],
      env: {
        has_n8n_base_url: Boolean(env("N8N_BASE_URL")),
        has_n8n_api_key: Boolean(env("N8N_API_KEY")),
        has_runtime_secret: Boolean(env("NEXUS_RUNTIME_SECRET")),
      },
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed.", 405);
  }

  try {
    const supabaseUrl = env("SUPABASE_URL");
    const anonKey = env("SUPABASE_ANON_KEY");
    const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return errorResponse("Missing Supabase function secrets.", 500);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const user = await getUserFromRequest(req, supabaseUrl, anonKey);

    if (!user) {
      return errorResponse("Admin login required.", 401);
    }

    const operator = await getOperatorContext(adminClient, user.id);

    if (!operator) {
      return errorResponse("Admin or developer access required.", 403);
    }

    const body = await req.json().catch(() => ({}));
    const mode = cleanString(body.mode || "start").toLowerCase();
    const automationId = cleanString(body.automation_id || body.automationId);

    if (!automationId && mode === "start") {
      return errorResponse("automation_id is required.", 400);
    }

    if (mode === "start") {
      const automation = await loadAutomation(adminClient, automationId);
      if (!canAccessAutomation(operator, automation)) {
        return errorResponse("Developer can only test their own products.", 403);
      }
      const result = await startTestRun(adminClient, automation, user.id, body);
      return jsonResponse(result, 200);
    }

    if (mode === "check" || mode === "latest") {
      const testRun = await loadTestRun(adminClient, body);
      if (!canAccessTestRun(operator, testRun)) {
        return errorResponse("Developer can only check tests for their own products.", 403);
      }
      const result = await checkTestRun(adminClient, testRun);
      return jsonResponse(result, 200);
    }

    return errorResponse("Unsupported mode. Use start, check, or latest.", 400);
  } catch (error) {
    console.error("test-n8n-workflow failed:", error);

    return errorResponse(
      error instanceof Error ? error.message : "Could not test n8n workflow.",
      500,
    );
  }
});
