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

function asObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function isPlainObject(value: unknown) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseMaybeJson(value: unknown): unknown {
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

function pickFirstString(...values: unknown[]) {
  for (const value of values) {
    const cleaned = cleanString(value);
    if (cleaned) return cleaned;
  }
  return "";
}

function latestRunStoppedBeforeN8n(run: any) {
  if (!run) return false;

  const status = cleanString(run.status).toLowerCase();
  const executionId = cleanString(run.n8n_execution_id);
  const message = cleanString(run.error_message).toLowerCase();

  if (status !== "error" || executionId) return false;

  return (
    message.includes("webhook") ||
    message.includes("not registered") ||
    message.includes("requested webhook") ||
    message.includes("could not be started") ||
    message.includes("failed to start")
  );
}

function getNested(obj: any, path: string) {
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

function classifyRuntimeError(errorMessage: string, rawError: Record<string, unknown>) {
  const rawText = stringifySafe(rawError);
  const combined = `${errorMessage || ""} ${rawText || ""}`.toLowerCase();

  const customerCredentialSignals = [
    "invalid token",
    "access token",
    "oauth",
    "permission",
    "permissions",
    "unauthorized",
    "authentication",
    "authorization",
    "invalid api key",
    "api key invalid",
    "expired token",
    "token expired",
    "invalid oauth",
    "missing required scope",
    "insufficient scope",
    "does not have permission",
    "missing permissions",
    "cannot be loaded due to missing permissions",
    "session has expired",
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

async function getUserFromRequest(req: Request, supabaseUrl: string, anonKey: string) {
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return null;

  const token = authHeader.replace("Bearer ", "");
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

async function isAdmin(adminClient: any, userId: string) {
  const { data } = await adminClient
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();

  return data?.role === "admin" || data?.role === "admin_staff" || data?.role === "developer";
}

async function n8nFetch(path: string) {
  const baseUrl = cleanBaseUrl(env("N8N_BASE_URL"));
  const apiKey = env("N8N_API_KEY");

  if (!baseUrl || !apiKey) {
    throw new Error("Missing N8N_BASE_URL or N8N_API_KEY Supabase secrets.");
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: {
      "Accept": "application/json",
      "X-N8N-API-KEY": apiKey,
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
    throw new Error(`n8n API failed (${response.status}): ${text.slice(0, 800)}`);
  }

  return data;
}

function normalizeExecutionsList(payload: any) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.executions)) return payload.executions;
  return [];
}

function getExecutionStatus(execution: any) {
  const status = cleanString(execution?.status).toLowerCase();
  if (status) return status;

  if (execution?.data?.resultData?.error || execution?.resultData?.error || execution?.error) {
    return "error";
  }

  if (execution?.finished === true && execution?.stoppedAt && !execution?.data?.resultData?.error) {
    return "success";
  }

  if (execution?.finished === false && execution?.stoppedAt) {
    return "error";
  }

  if (execution?.finished === false || !execution?.stoppedAt) {
    return "running";
  }

  return "unknown";
}

function extractExecutionError(execution: any) {
  const error =
    execution?.data?.resultData?.error ||
    execution?.resultData?.error ||
    execution?.error ||
    execution?.data?.error ||
    {};

  const errorMessage = pickFirstString(
    error?.message,
    error?.description,
    error?.cause?.message,
    execution?.error?.message,
    execution?.stoppedAt && getExecutionStatus(execution) === "error"
      ? "n8n execution failed."
      : "",
    stringifySafe(error) !== "{}" ? stringifySafe(error) : "",
  ) || "n8n execution failed.";

  const errorNode = pickFirstString(
    execution?.data?.resultData?.lastNodeExecuted,
    execution?.resultData?.lastNodeExecuted,
    error?.node?.name,
    error?.nodeName,
    error?.node,
    execution?.lastNodeExecuted,
  );

  const rawError = asObject(error);

  return {
    errorMessage,
    errorNode,
    rawError: Object.keys(rawError).length ? rawError : asObject(execution),
  };
}

function unwrapOutputCandidate(value: unknown): unknown {
  const outputKeys = [
    "NEXUS_FINAL_OUTPUT",
    "Nexus_final_output",
    "nexus_final_output",
    "nexusFinalOutput",
    "final_output",
    "finalOutput",
    "automation_output",
    "automationOutput",
    "output",
    "result",
    "report",
    "payload",
    "data",
    "body",
  ];

  let current = parseMaybeJson(value);

  for (let index = 0; index < 5; index += 1) {
    if (Array.isArray(current)) {
      current = current.length === 1 ? parseMaybeJson(current[0]) : current;
      continue;
    }

    if (!isPlainObject(current)) return current;

    const objectValue = current as Record<string, unknown>;
    const key = outputKeys.find((candidate) => {
      const candidateValue = objectValue[candidate];
      return candidateValue !== undefined && candidateValue !== null && cleanString(candidateValue) !== "";
    });

    if (!key) return current;
    current = parseMaybeJson(objectValue[key]);
  }

  return current;
}

function extractExecutionItems(execution: any, nodeName: string) {
  const runData =
    execution?.data?.resultData?.runData ||
    execution?.resultData?.runData ||
    execution?.runData ||
    {};
  const runs = Array.isArray(runData?.[nodeName]) ? runData[nodeName] : [];
  const items: any[] = [];

  for (const run of runs.slice().reverse()) {
    const main = Array.isArray(run?.data?.main) ? run.data.main : [];

    for (const group of main) {
      if (!Array.isArray(group)) continue;

      for (const item of group) {
        if (item?.json !== undefined) {
          items.push(item.json);
        }
      }
    }
  }

  return items;
}

function extractFallbackOutputFromExecution(execution: any) {
  const runData =
    execution?.data?.resultData?.runData ||
    execution?.resultData?.runData ||
    execution?.runData ||
    {};
  const nodeNames = Object.keys(runData);
  const lastNode = pickFirstString(
    execution?.data?.resultData?.lastNodeExecuted,
    execution?.resultData?.lastNodeExecuted,
    execution?.lastNodeExecuted,
  );
  const preferredNames = [
    "NEXUS_FINAL_OUTPUT",
    "Nexus_final_output",
    "nexus_final_output",
    "Nexus Final Output",
    "Nexus Output",
    "Nexus output",
  ];
  const blockedNames = new Set([
    "Nexus Submit Output",
    "Nexus Webhook Trigger",
    "Nexus Runtime Context",
  ]);
  const orderedNames = [
    ...preferredNames.filter((name) => nodeNames.includes(name)),
    ...nodeNames
      .filter((name) =>
        !blockedNames.has(name) &&
        name !== lastNode
      )
      .reverse(),
    ...(lastNode && !blockedNames.has(lastNode) ? [lastNode] : []),
  ];

  for (const nodeName of orderedNames) {
    const items = extractExecutionItems(execution, nodeName);

    for (const item of items) {
      const unwrapped = unwrapOutputCandidate(item);
      const objectValue = isPlainObject(unwrapped) ? unwrapped as Record<string, unknown> : {};
      const textValue = typeof unwrapped === "string" ? unwrapped : "";
      const useful = Boolean(
        textValue ||
          objectValue.title ||
          objectValue.summary ||
          objectValue.content_html ||
          objectValue.contentHtml ||
          objectValue.html ||
          objectValue.content_text ||
          objectValue.contentText ||
          objectValue.text ||
          objectValue.markdown ||
          Object.keys(objectValue).length,
      );

      if (useful) {
        return { nodeName, value: unwrapped };
      }
    }
  }

  return null;
}

function buildFallbackOutputPayload(customerAutomation: any, execution: any, fallback: any) {
  const now = new Date().toISOString();
  const value = fallback?.value;
  const objectValue = isPlainObject(value) ? value as Record<string, unknown> : {};
  const textValue = typeof value === "string" ? value : "";
  const looksLikeHtml = /<[a-z][\s\S]*>/i.test(textValue);
  const contentHtml = pickFirstString(
    objectValue.content_html,
    objectValue.contentHtml,
    objectValue.html,
    objectValue.HTML,
    objectValue.report_html,
    objectValue.reportHtml,
    looksLikeHtml ? textValue : "",
  );
  const contentText = pickFirstString(
    objectValue.content_text,
    objectValue.contentText,
    objectValue.text,
    objectValue.markdown,
    objectValue.output_text,
    objectValue.outputText,
    !contentHtml ? textValue : "",
  );
  const contentJson = isPlainObject(value) || Array.isArray(value)
    ? value
    : (textValue ? { value: textValue } : {});

  return {
    customer_automation_id: customerAutomation.id,
    order_id: customerAutomation.order_id || null,
    buyer_id: customerAutomation.buyer_id,
    automation_id: customerAutomation.automation_id || null,
    output_type: pickFirstString(objectValue.output_type, objectValue.outputType) || "report",
    status: "published",
    title: pickFirstString(
      objectValue.title,
      objectValue.report_title,
      objectValue.reportTitle,
      objectValue.name,
    ) || "Automation output",
    summary: pickFirstString(objectValue.summary, objectValue.description),
    content_text: contentText,
    content_html: contentHtml,
    content_json: isPlainObject(contentJson) ? contentJson : { value: contentJson },
    file_url: pickFirstString(objectValue.file_url, objectValue.fileUrl),
    storage_path: pickFirstString(objectValue.storage_path, objectValue.storagePath),
    created_by: "runtime",
    created_at: now,
    updated_at: now,
  };
}

async function tryInsertRunError(adminClient: any, payload: Record<string, unknown>) {
  const { error } = await adminClient.from("automation_run_errors").insert(payload);
  if (error) console.warn("automation_run_errors insert failed/skipped:", error.message);
}

async function logEvent(adminClient: any, payload: Record<string, unknown>) {
  const { error } = await adminClient.from("automation_events").insert({
    ...payload,
    created_at: new Date().toISOString(),
  });

  if (error) console.warn("automation_events insert failed/skipped:", error.message);
}

async function applyExecutionFailure(adminClient: any, customerAutomation: any, execution: any) {
  const now = new Date().toISOString();
  const { errorMessage, errorNode, rawError } = extractExecutionError(execution);
  const classification = classifyRuntimeError(errorMessage, rawError);
  const failureCount = Number(customerAutomation.failure_count || 0) + 1;

  await adminClient
    .from("customer_automations")
    .update({
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

      n8n_last_execution_id: cleanString(execution?.id),
      n8n_last_execution_status: "error",
      n8n_last_execution_checked_at: now,
      updated_at: now,
    })
    .eq("id", customerAutomation.id);

  await adminClient
    .from("automation_runs")
    .update({
      status: "error",
      finished_at: now,
      updated_at: now,
      error_message: errorMessage,
      error_details: rawError,
      n8n_execution_id: cleanString(execution?.id),
    })
    .eq("customer_automation_id", customerAutomation.id)
    .eq("status", "running");

  await tryInsertRunError(adminClient, {
    customer_automation_id: customerAutomation.id,
    buyer_id: customerAutomation.buyer_id,
    automation_id: customerAutomation.automation_id,
    order_id: customerAutomation.order_id,
    source: "n8n_api_poll",
    error_type: classification.error_type,
    error_code: classification.error_code,
    error_node: errorNode || null,
    error_message: errorMessage,
    customer_message: classification.customer_message,
    raw_error: rawError,
    needs_customer_action: classification.needs_customer_action,
    resolved: false,
    created_at: now,
  });

  await logEvent(adminClient, {
    customer_automation_id: customerAutomation.id,
    buyer_id: customerAutomation.buyer_id,
    automation_id: customerAutomation.automation_id,
    order_id: customerAutomation.order_id,
    event_type: classification.needs_customer_action
      ? "customer_action_required"
      : "runtime_error",
    title: classification.needs_customer_action
      ? "Customer action required"
      : "Automation runtime error",
    message: JSON.stringify({
      customer_message: classification.customer_message,
      admin_error_message: errorMessage,
      error_type: classification.error_type,
      error_code: classification.error_code,
      error_node: errorNode,
      n8n_execution_id: cleanString(execution?.id),
      needs_customer_action: classification.needs_customer_action,
    }),
    created_by: "n8n_api_poll",
  });

  return {
    status: "error_recorded",
    error_type: classification.error_type,
    error_code: classification.error_code,
    error_node: errorNode,
    customer_message: classification.customer_message,
    admin_error_message: errorMessage,
    needs_customer_action: classification.needs_customer_action,
  };
}

async function applyExecutionRunning(adminClient: any, customerAutomation: any, execution: any) {
  const now = new Date().toISOString();

  await adminClient
    .from("customer_automations")
    .update({
      runtime_status: "running",
      health_status: "running",
      status: "running",
      n8n_last_execution_id: cleanString(execution?.id) || customerAutomation.n8n_last_execution_id || null,
      n8n_last_execution_status: "running",
      n8n_last_execution_checked_at: now,
      updated_at: now,
    })
    .eq("id", customerAutomation.id);

  return { status: "running" };
}

async function applyExecutionSuccess(
  adminClient: any,
  customerAutomation: any,
  execution: any,
  options: { forceRecover?: boolean } = {},
) {
  const now = new Date().toISOString();

  const { data: existingOutputs } = await adminClient
    .from("automation_outputs")
    .select("id")
    .eq("customer_automation_id", customerAutomation.id)
    .order("created_at", { ascending: false })
    .limit(1);

  let recoveredOutput: any = null;

  if (options.forceRecover || !Array.isArray(existingOutputs) || existingOutputs.length === 0) {
    const fallback = extractFallbackOutputFromExecution(execution);

    if (fallback) {
      const { data: output, error: outputError } = await adminClient
        .from("automation_outputs")
        .insert(buildFallbackOutputPayload(customerAutomation, execution, fallback))
        .select("id, title")
        .single();

      if (outputError) {
        console.warn("n8n execution output recovery skipped:", outputError.message);
      } else {
        recoveredOutput = {
          id: output?.id || null,
          title: output?.title || "",
          source_node: fallback.nodeName,
        };
      }
    }
  }

  await adminClient
    .from("customer_automations")
    .update({
      status: "active",
      runtime_status: "success",
      health_status: "healthy",
      last_output_at: recoveredOutput ? now : customerAutomation.last_output_at || null,
      last_error_code: null,
      last_error_node: null,
      last_error_message: null,
      last_error_details: {},
      n8n_last_execution_id: cleanString(execution?.id) || customerAutomation.n8n_last_execution_id || null,
      n8n_last_execution_status: "success",
      n8n_last_execution_checked_at: now,
      updated_at: now,
    })
    .eq("id", customerAutomation.id);

  await adminClient
    .from("automation_runs")
    .update({
      status: "success",
      finished_at: now,
      updated_at: now,
      n8n_execution_id: cleanString(execution?.id),
    })
    .eq("customer_automation_id", customerAutomation.id)
    .eq("status", "running");

  const order = Array.isArray(customerAutomation.orders)
    ? customerAutomation.orders[0]
    : customerAutomation.orders;

  if (customerAutomation.order_id && (recoveredOutput || Array.isArray(existingOutputs) && existingOutputs.length > 0)) {
    await adminClient
      .from("orders")
      .update({
        order_status: "completed",
        updated_at: now,
      })
      .eq("id", customerAutomation.order_id)
      .eq("payment_status", "paid")
      .not("order_status", "in", '("cancelled","checkout_expired","payment_failed","refunded")');
  }

  return {
    status: "success",
    recovered_output: recoveredOutput,
    had_existing_output: Array.isArray(existingOutputs) && existingOutputs.length > 0,
    order_status_checked: Boolean(order),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  if (req.method === "GET") {
    return jsonResponse({
      ok: true,
      message: "check-n8n-execution is alive.",
      env: {
        has_supabase_url: Boolean(env("SUPABASE_URL")),
        has_anon_key: Boolean(env("SUPABASE_ANON_KEY")),
        has_service_role: Boolean(env("SUPABASE_SERVICE_ROLE_KEY")),
        has_n8n_base_url: Boolean(env("N8N_BASE_URL")),
        has_n8n_api_key: Boolean(env("N8N_API_KEY")),
      },
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    const supabaseUrl = env("SUPABASE_URL");
    const anonKey = env("SUPABASE_ANON_KEY");
    const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return errorResponse("Missing Supabase function secrets.", 500);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const body = await req.json().catch(() => ({}));
    const user = await getUserFromRequest(req, supabaseUrl, anonKey);
    const internalSecret = env("NEXUS_RUNTIME_SECRET");
    const providedSecret = req.headers.get("x-nexus-runtime-secret") || cleanString(body.runtime_secret);
    const isInternal = internalSecret && providedSecret === internalSecret;

    if (!user && !isInternal) {
      return errorResponse("Authentication required.", 401);
    }

    const customerAutomationId = cleanString(
      body.customer_automation_id || body.customerAutomationId || body.id,
    );

    if (!customerAutomationId) {
      return errorResponse("customer_automation_id is required.", 400);
    }

    const { data: customerAutomation, error: caError } = await adminClient
      .from("customer_automations")
      .select(`
        *,
        automations(
          id,
          title,
          n8n_workflow_id,
          n8n_workflow_name,
          n8n_webhook_url,
          runtime_webhook_url
        ),
        orders(*)
      `)
      .eq("id", customerAutomationId)
      .maybeSingle();

    if (caError || !customerAutomation) {
      return errorResponse(caError?.message || "Customer automation not found.", 404);
    }

    if (!isInternal && user) {
      const admin = await isAdmin(adminClient, user.id);
      const ownsAutomation = customerAutomation.buyer_id === user.id;

      if (!admin && !ownsAutomation) {
        return errorResponse("Access denied.", 403);
      }
    }

    const { data: latestRun } = await adminClient
      .from("automation_runs")
      .select("id, status, n8n_execution_id, error_message, created_at, updated_at, finished_at")
      .eq("customer_automation_id", customerAutomationId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (latestRunStoppedBeforeN8n(latestRun)) {
      return jsonResponse({
        ok: true,
        customer_automation_id: customerAutomationId,
        status: "trigger_error_recorded",
        message: "The latest Nexus run failed before n8n created an execution.",
        latest_run: latestRun,
        result: {
          status: "trigger_error_recorded",
          error_type: "workflow_start_error",
          error_code: "WORKFLOW_TRIGGER_FAILED",
          needs_customer_action: false,
          customer_message:
            "This automation could not be started. Nexus has been notified and will review it.",
          admin_error_message: cleanString(latestRun?.error_message),
        },
      });
    }

    const product = Array.isArray(customerAutomation.automations)
      ? customerAutomation.automations[0]
      : customerAutomation.automations || {};

    const explicitExecutionId = cleanString(
      body.execution_id ||
        body.executionId,
    );

    let execution: any = null;

    if (explicitExecutionId) {
      execution = await n8nFetch(`/api/v1/executions/${encodeURIComponent(explicitExecutionId)}?includeData=true`);
    } else {
      const workflowId = cleanString(
        body.workflow_id ||
          body.workflowId ||
          customerAutomation.n8n_workflow_id ||
          product.n8n_workflow_id,
      );

      if (!workflowId) {
        return errorResponse(
          "No n8n workflow ID found. Re-import the workflow or store n8n_workflow_id on the automation.",
          400,
        );
      }

      const executionsPayload = await n8nFetch(
        `/api/v1/executions?workflowId=${encodeURIComponent(workflowId)}&limit=10&includeData=false`,
      );

      const executions = normalizeExecutionsList(executionsPayload);

      if (!executions.length) {
        return jsonResponse({
          ok: true,
          status: "no_execution_found",
          message: "No n8n execution was found for this workflow yet.",
        });
      }

      const sorted = executions.slice().sort((a: any, b: any) => {
        const aDate = new Date(a.startedAt || a.createdAt || 0).getTime();
        const bDate = new Date(b.startedAt || b.createdAt || 0).getTime();
        return bDate - aDate;
      });

      const latest = sorted[0];
      const latestId = cleanString(latest?.id);

      if (!latestId) {
        return errorResponse("Latest n8n execution did not include an execution ID.", 500, {
          latest,
        });
      }

      execution = await n8nFetch(`/api/v1/executions/${encodeURIComponent(latestId)}?includeData=true`);
    }

    const executionStatus = getExecutionStatus(execution);

    let result: Record<string, unknown>;

    if (["error", "failed", "failure", "crashed"].includes(executionStatus)) {
      result = await applyExecutionFailure(adminClient, customerAutomation, execution);
    } else if (["running", "waiting", "new", "unknown"].includes(executionStatus)) {
      result = await applyExecutionRunning(adminClient, customerAutomation, execution);
    } else {
      result = await applyExecutionSuccess(adminClient, customerAutomation, execution, {
        forceRecover: body.force_recover === true || body.forceRecover === true,
      });
    }

    return jsonResponse({
      ok: true,
      customer_automation_id: customerAutomationId,
      n8n_execution_id: cleanString(execution?.id),
      n8n_status: executionStatus,
      result,
      debug: body.debug_nodes === true || body.debugNodes === true
        ? {
          last_node: pickFirstString(
            execution?.data?.resultData?.lastNodeExecuted,
            execution?.resultData?.lastNodeExecuted,
            execution?.lastNodeExecuted,
          ),
          run_nodes: Object.keys(
            execution?.data?.resultData?.runData ||
              execution?.resultData?.runData ||
              execution?.runData ||
              {},
          ),
        }
        : undefined,
    });
  } catch (error) {
    console.error(error);

    return errorResponse(
      error instanceof Error ? error.message : "Could not check n8n execution.",
      500,
    );
  }
});
