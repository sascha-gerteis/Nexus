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

function isUuid(value: unknown) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cleanString(value));
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

function runContextMatchTokens(runContext: any) {
  const responsePayload = isPlainObject(runContext?.response_payload)
    ? runContext.response_payload
    : {};
  // Only the unique Nexus run identity may match an n8n execution. Bundle
  // attempt/item IDs can be shared by retries and are not proof of ownership.
  const tokens = [
    runContext?.id,
    runContext?.run_key,
    responsePayload?.run_id,
    responsePayload?.runId,
    responsePayload?.run_key,
    responsePayload?.runKey,
  ]
    .map((token) => cleanString(token))
    .filter((token) => token.length >= 8);

  return Array.from(new Set(tokens));
}

function executionMatchesRunContext(execution: any, runContext: any) {
  const tokens = runContextMatchTokens(runContext);
  if (!tokens.length) return false;

  const haystack = stringifySafe(execution);
  if (!haystack || haystack === "{}") return false;

  return tokens.some((token) => haystack.includes(token));
}

async function findExecutionForRunContext(workflowId: string, runContext: any) {
  const runStartedAt = new Date(
    runContext?.started_at || runContext?.created_at || 0,
  ).getTime();
  const executions: any[] = [];
  const seenExecutionIds = new Set<string>();
  let cursor = "";

  // Legacy Nexus runs can remain unresolved long after newer executions push
  // them off n8n's first page. Walk workflow-scoped history until we pass this
  // run's timestamp instead of assuming the newest executions are enough.
  for (let page = 0; page < 12; page += 1) {
    let path = `/api/v1/executions?workflowId=${encodeURIComponent(workflowId)}&limit=100&includeData=false`;
    if (cursor) path += `&cursor=${encodeURIComponent(cursor)}`;

    const payload = await n8nFetch(path);
    const pageExecutions = normalizeExecutionsList(payload);
    let reachedRunWindow = false;

    for (const candidate of pageExecutions) {
      const candidateId = cleanString(candidate?.id);
      if (!candidateId || seenExecutionIds.has(candidateId)) continue;
      seenExecutionIds.add(candidateId);
      executions.push(candidate);

      const candidateStartedAt = new Date(
        candidate?.startedAt || candidate?.createdAt || 0,
      ).getTime();
      if (runStartedAt && candidateStartedAt && candidateStartedAt < runStartedAt - 15000) {
        reachedRunWindow = true;
      }
    }

    cursor = cleanString(payload?.nextCursor || payload?.next_cursor);
    if (!cursor || reachedRunWindow) break;
  }

  const sorted = executions.slice().sort((a: any, b: any) => {
    const aDate = new Date(a.startedAt || a.createdAt || 0).getTime();
    const bDate = new Date(b.startedAt || b.createdAt || 0).getTime();
    return bDate - aDate;
  });

  const candidateIds = sorted
    .map((candidate: any) => cleanString(candidate?.id))
    .filter(Boolean);
  const needsExactMatch = runContextMatchTokens(runContext).length > 0;
  const temporalCandidates: any[] = [];

  for (const candidate of sorted) {
    const candidateId = cleanString(candidate?.id);
    if (!candidateId) continue;

    const executionDetail = await n8nFetch(`/api/v1/executions/${encodeURIComponent(candidateId)}?includeData=true`);
    // n8n's detail endpoint can omit fields that are present on the list
    // response (notably the terminal status). Preserve the list status so a
    // cancelled execution can never be inferred as successful merely because
    // it has finished and has a stoppedAt timestamp.
    const execution = {
      ...candidate,
      ...executionDetail,
      status: cleanString(executionDetail?.status) || cleanString(candidate?.status),
    };
    const executionStartedAt = new Date(
      execution?.startedAt || execution?.createdAt || 0,
    ).getTime();
    const freshForRun = !runStartedAt || (
      executionStartedAt && executionStartedAt >= runStartedAt - 15000
    );

    if (freshForRun && (!needsExactMatch || executionMatchesRunContext(execution, runContext))) {
      return {
        execution,
        matched: needsExactMatch,
        inspected: candidateIds.length,
        candidate_ids: candidateIds.slice(0, 10),
      };
    }

    // A run can be cancelled before the Nexus Runtime Context node executes.
    // In that case the execution has no run token to inspect. Keep only
    // candidates in a tight window around this exact Nexus run; below we use
    // one only when it is unambiguous for the workflow.
    const closeToRun = Boolean(
      runStartedAt &&
        executionStartedAt &&
        executionStartedAt >= runStartedAt - 15000 &&
        executionStartedAt <= runStartedAt + 120000,
    );
    if (needsExactMatch && closeToRun) temporalCandidates.push(execution);
  }

  if (needsExactMatch && temporalCandidates.length === 1) {
    return {
      execution: temporalCandidates[0],
      matched: "unique_temporal_workflow_match",
      inspected: candidateIds.length,
      candidate_ids: candidateIds.slice(0, 10),
    };
  }

  return {
    execution: null,
    matched: false,
    inspected: candidateIds.length,
    candidate_ids: candidateIds.slice(0, 10),
  };
}
async function findExecutionForLegacyOrder(
  workflowId: string,
  customerAutomationId: string,
  orderId: string,
  startedAfter: string,
  bundleAttemptId = "",
  bundleRunItemId = "",
) {
  const cutoff = new Date(startedAfter || 0).getTime();
  const inspected = new Set<string>();

  const scan = async (workflowFilter: string, requireExactItem: boolean) => {
    let cursor = "";
    for (let page = 0; page < 12; page += 1) {
      let path = "/api/v1/executions?limit=100&includeData=false";
      if (workflowFilter) path += "&workflowId=" + encodeURIComponent(workflowFilter);
      if (cursor) path += "&cursor=" + encodeURIComponent(cursor);
      const payload = await n8nFetch(path);
      const executions = normalizeExecutionsList(payload).slice().sort((a: any, b: any) =>
        new Date(b.startedAt || b.createdAt || 0).getTime() -
        new Date(a.startedAt || a.createdAt || 0).getTime()
      );
      let reachedCutoff = false;

      for (const candidate of executions) {
        const candidateId = cleanString(candidate?.id);
        if (!candidateId || inspected.has(candidateId)) continue;
        inspected.add(candidateId);
        const candidateTime = new Date(candidate?.startedAt || candidate?.createdAt || 0).getTime();
        if (cutoff && candidateTime && candidateTime + 15000 < cutoff) {
          reachedCutoff = true;
          continue;
        }
        const detail = await n8nFetch(
          "/api/v1/executions/" + encodeURIComponent(candidateId) + "?includeData=true",
        );
        const execution = {
          ...candidate,
          ...detail,
          status: cleanString(detail?.status) || cleanString(candidate?.status),
        };
        const haystack = stringifySafe(execution);
        if (bundleRunItemId && haystack.includes(bundleRunItemId)) return execution;
        if (requireExactItem) continue;
        if (
          bundleAttemptId &&
          haystack.includes(bundleAttemptId) &&
          (haystack.includes(customerAutomationId) || haystack.includes(orderId))
        ) return execution;
        if (haystack.includes(customerAutomationId)) return execution;
      }

      cursor = cleanString(payload?.nextCursor || payload?.next_cursor);
      if (!cursor || reachedCutoff) break;
    }
    return null;
  };

  const workflowExecution = await scan(workflowId, false);
  if (workflowExecution) return workflowExecution;
  if (bundleRunItemId) return await scan("", true);
  return null;
}
function getExecutionStatus(execution: any) {
  const status = cleanString(execution?.status).toLowerCase();
  if (status) return status;

  if (execution?.data?.resultData?.error || execution?.resultData?.error || execution?.error) {
    return "error";
  }


  if (execution?.finished === false && execution?.stoppedAt) {
    return "error";
  }

  if (execution?.finished === false || !execution?.stoppedAt) {
    return "running";
  }

  return "unknown";
}
const EXECUTION_SUCCESS_STATUSES = new Set([
  "success",
  "succeeded",
  "completed",
  "complete",
]);

const EXECUTION_FAILURE_STATUSES = new Set([
  "error",
  "failed",
  "failure",
  "crashed",
  "canceled",
  "cancelled",
  "aborted",
  "stopped",
]);

const EXECUTION_ACTIVE_STATUSES = new Set([
  "running",
  "waiting",
  "new",
  "unknown",
  "queued",
  "pending",
]);

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

function buildFallbackOutputPayload(customerAutomation: any, execution: any, fallback: any, runContext: any = {}) {
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
    // A customer automation can be reused by multiple purchases. Recovery
    // must inherit the order captured for this exact run, never the reusable
    // customer_automations row, or a later purchase can receive old output.
    order_id: cleanString(runContext?.order_id) || customerAutomation.order_id || null,
    buyer_id: customerAutomation.buyer_id,
    automation_id: customerAutomation.automation_id || null,
    automation_run_id: cleanString(runContext?.id) || null,
    bundle_run_attempt_id: cleanString(runContext?.bundle_run_attempt_id) || null,
    bundle_run_item_id: cleanString(runContext?.bundle_run_item_id) || null,
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

async function refreshBundleRunAttemptRollup(adminClient: any, bundleAttemptId: string) {
  if (!isUuid(bundleAttemptId)) return null;

  const { data: items, error } = await adminClient
    .from("bundle_run_items")
    .select("id,status")
    .eq("bundle_run_attempt_id", bundleAttemptId);

  if (error) {
    console.warn("bundle_run_attempts execution rollup read failed:", error.message);
    return error;
  }

  const rows = items || [];
  const expectedCount = rows.length;
  const completedCount = rows.filter((item: any) => cleanString(item.status).toLowerCase() === "success").length;
  const failedCount = rows.filter((item: any) => ["failed", "cancelled", "timed_out", "error"].includes(cleanString(item.status).toLowerCase())).length;
  const runningCount = rows.filter((item: any) => ["queued", "running", "processing", "pending", "in_progress"].includes(cleanString(item.status).toLowerCase())).length;
  const status = expectedCount && completedCount >= expectedCount
    ? "success"
    : expectedCount && failedCount >= expectedCount
    ? "failed"
    : failedCount && !runningCount
    ? "partial_failed"
    : "running";

  const { error: updateError } = await adminClient
    .from("bundle_run_attempts")
    .update({
      status,
      expected_count: expectedCount,
      completed_count: completedCount,
      failed_count: failedCount,
      finished_at: ["success", "failed", "partial_failed"].includes(status) ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", bundleAttemptId);

  if (updateError) {
    console.warn("bundle_run_attempts execution rollup update failed:", updateError.message);
    return updateError;
  }

  return null;
}

async function updateBundleRunItemFromRun(adminClient: any, runContext: any, payload: Record<string, unknown>) {
  const bundleRunItemId = cleanString(runContext?.bundle_run_item_id);
  const bundleAttemptId = cleanString(runContext?.bundle_run_attempt_id);

  if (!isUuid(bundleRunItemId)) return null;

  const { error } = await adminClient
    .from("bundle_run_items")
    .update({
      ...payload,
      updated_at: new Date().toISOString(),
    })
    .eq("id", bundleRunItemId);

  if (error) {
    console.warn("bundle_run_items execution update failed:", error.message);
    return error;
  }

  await refreshBundleRunAttemptRollup(adminClient, bundleAttemptId);
  return null;
}

function runUpdateQuery(adminClient: any, customerAutomationId: string, runContext: any, executionId: string, payload: Record<string, unknown>) {
  let query = adminClient
    .from("automation_runs")
    .update(payload)
    .select("id,bundle_run_attempt_id,bundle_run_item_id")
    .eq("customer_automation_id", customerAutomationId);

  const runId = cleanString(runContext?.id);
  if (runId) {
    query = query.eq("id", runId);
  } else if (executionId) {
    query = query.eq("n8n_execution_id", executionId);
  } else {
    query = query.eq("status", "running");
  }

  return query;
}

async function applyExecutionFailure(adminClient: any, customerAutomation: any, execution: any, options: { runContext?: any } = {}) {
  const now = new Date().toISOString();
  const { errorMessage, errorNode, rawError } = extractExecutionError(execution);
  const classification = classifyRuntimeError(errorMessage, rawError);
  const failureCount = Number(customerAutomation.failure_count || 0) + 1;
  const executionStatus = cleanString(execution?.status).toLowerCase();
  const failureStatus = executionStatus.includes("cancel") ? "cancelled" : "error";
  const runContext = options.runContext || {};
  const executionId = cleanString(execution?.id) || cleanString(runContext?.n8n_execution_id);

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

      n8n_last_execution_id: executionId || null,
      n8n_last_execution_status: failureStatus,
      n8n_last_execution_checked_at: now,
      updated_at: now,
    })
    .eq("id", customerAutomation.id);

  const { data: updatedRuns, error: runUpdateError } = await runUpdateQuery(
    adminClient,
    customerAutomation.id,
    runContext,
    executionId,
    {
      status: failureStatus,
      finished_at: now,
      updated_at: now,
      error_message: errorMessage,
      error_details: rawError,
      n8n_execution_id: executionId || null,
    },
  );

  if (runUpdateError) console.warn("automation_runs execution failure update failed:", runUpdateError.message);

  const bundleContext = (updatedRuns || []).find((run: any) => cleanString(run?.bundle_run_item_id)) || runContext;
  await updateBundleRunItemFromRun(adminClient, bundleContext, {
    status: failureStatus,
    output_id: null,
    error_message: classification.customer_message || errorMessage,
    finished_at: now,
  });

  await tryInsertRunError(adminClient, {
    customer_automation_id: customerAutomation.id,
    buyer_id: customerAutomation.buyer_id,
    automation_id: customerAutomation.automation_id,
    order_id: cleanString(bundleContext?.order_id) || customerAutomation.order_id,
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
    order_id: cleanString(bundleContext?.order_id) || customerAutomation.order_id,
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
      n8n_execution_id: executionId || null,
      needs_customer_action: classification.needs_customer_action,
    }),
    created_by: "n8n_api_poll",
  });

  return {
    status: failureStatus === "cancelled" ? "cancelled_recorded" : "error_recorded",
    error_type: classification.error_type,
    error_code: classification.error_code,
    error_node: errorNode,
    customer_message: classification.customer_message,
    admin_error_message: errorMessage,
    needs_customer_action: classification.needs_customer_action,
  };
}

async function applyExecutionRunning(adminClient: any, customerAutomation: any, execution: any, options: { runContext?: any } = {}) {
  const now = new Date().toISOString();
  const runContext = options.runContext || {};
  const executionId = cleanString(execution?.id) || cleanString(runContext?.n8n_execution_id);

  await adminClient
    .from("customer_automations")
    .update({
      runtime_status: "running",
      health_status: "running",
      status: "running",
      n8n_last_execution_id: executionId || customerAutomation.n8n_last_execution_id || null,
      n8n_last_execution_status: "running",
      n8n_last_execution_checked_at: now,
      updated_at: now,
    })
    .eq("id", customerAutomation.id);

  const { error: runUpdateError } = await runUpdateQuery(
    adminClient,
    customerAutomation.id,
    runContext,
    executionId,
    {
      status: "running",
      updated_at: now,
      n8n_execution_id: executionId || null,
    },
  );

  if (runUpdateError) console.warn("automation_runs execution running update failed:", runUpdateError.message);

  await updateBundleRunItemFromRun(adminClient, runContext, {
    status: "running",
    error_message: null,
    finished_at: null,
  });

  return { status: "running" };
}

async function applyExecutionSuccess(
  adminClient: any,
  customerAutomation: any,
  execution: any,
  options: { forceRecover?: boolean; runContext?: any } = {},
) {
  const now = new Date().toISOString();
  const runContext = options.runContext || {};
  const bundleRunItemId = cleanString(runContext?.bundle_run_item_id);
  const automationRunId = cleanString(runContext?.id);
  const executionId = cleanString(execution?.id) || cleanString(runContext?.n8n_execution_id);

  let existingOutputsQuery = adminClient
    .from("automation_outputs")
    .select("id")
    .eq("customer_automation_id", customerAutomation.id)
    .order("created_at", { ascending: false })
    .limit(1);

  if (bundleRunItemId) {
    existingOutputsQuery = existingOutputsQuery.eq("bundle_run_item_id", bundleRunItemId);
  } else if (automationRunId) {
    existingOutputsQuery = existingOutputsQuery.eq("automation_run_id", automationRunId);
  }

  const { data: existingOutputs } = await existingOutputsQuery;

  let recoveredOutput: any = null;

  if (options.forceRecover || !Array.isArray(existingOutputs) || existingOutputs.length === 0) {
    const fallback = extractFallbackOutputFromExecution(execution);

    if (fallback) {
      const { data: output, error: outputError } = await adminClient
        .from("automation_outputs")
        .insert(buildFallbackOutputPayload(customerAutomation, execution, fallback, runContext))
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

  const currentOutputId = cleanString(recoveredOutput?.id) || cleanString(existingOutputs?.[0]?.id);

  if (bundleRunItemId && !currentOutputId) {
    const { error: runUpdateError } = await runUpdateQuery(
      adminClient,
      customerAutomation.id,
      runContext,
      executionId,
      {
        status: "running",
        updated_at: now,
        n8n_execution_id: executionId || null,
        response_payload: {
          status: "waiting_for_output",
          message: "n8n finished but Nexus has not received this bundle item's output yet.",
        },
      },
    );

    if (runUpdateError) console.warn("automation_runs waiting-for-output update failed:", runUpdateError.message);

    await updateBundleRunItemFromRun(adminClient, runContext, {
      status: "running",
      error_message: "n8n finished but Nexus has not received this workflow output yet.",
      finished_at: null,
    });

    return {
      status: "waiting_for_output",
      recovered_output: recoveredOutput,
      had_existing_output: false,
      order_status_checked: false,
    };
  }

  await adminClient
    .from("customer_automations")
    .update({
      status: "active",
      runtime_status: "success",
      health_status: "healthy",
      last_output_at: currentOutputId ? now : customerAutomation.last_output_at || null,
      last_error_code: null,
      last_error_node: null,
      last_error_message: null,
      last_error_details: {},
      n8n_last_execution_id: executionId || customerAutomation.n8n_last_execution_id || null,
      n8n_last_execution_status: "success",
      n8n_last_execution_checked_at: now,
      updated_at: now,
    })
    .eq("id", customerAutomation.id);

  const { data: updatedRuns, error: runUpdateError } = await runUpdateQuery(
    adminClient,
    customerAutomation.id,
    runContext,
    executionId,
    {
      status: "success",
      finished_at: now,
      updated_at: now,
      n8n_execution_id: executionId || null,
      response_payload: {
        status: "success",
        n8n_execution_verified: true,
        n8n_execution_id: executionId || null,
        output_id: currentOutputId || null,
        checked_at: now,
      },
    },
  );

  if (runUpdateError) console.warn("automation_runs execution success update failed:", runUpdateError.message);

  const bundleContext = (updatedRuns || []).find((run: any) => cleanString(run?.bundle_run_item_id)) || runContext;
  const bundlePayload: Record<string, unknown> = {
    status: "success",
    automation_run_id: cleanString(bundleContext?.id) || automationRunId || null,
    error_message: null,
    finished_at: now,
  };
  if (currentOutputId) bundlePayload.output_id = currentOutputId;
  await updateBundleRunItemFromRun(adminClient, bundleContext, bundlePayload);

  const order = Array.isArray(customerAutomation.orders)
    ? customerAutomation.orders[0]
    : customerAutomation.orders;

  if (customerAutomation.order_id && currentOutputId) {
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
    had_existing_output: Boolean(currentOutputId) && !recoveredOutput,
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

    const requestedRunId = cleanString(body.run_id || body.runId);
    const requestedOrderId = cleanString(body.order_id || body.orderId);
    const recoverMissingRun = body.recover_missing_run === true || body.recoverMissingRun === true;
    const requestedBundleAttemptId = cleanString(body.bundle_run_attempt_id || body.bundleRunAttemptId);
    const requestedBundleRunItemId = cleanString(body.bundle_run_item_id || body.bundleRunItemId);

    if (requestedOrderId && requestedOrderId !== cleanString(customerAutomation.order_id)) {
      return errorResponse("The requested order does not own this customer automation.", 409);
    }

    if (recoverMissingRun && (requestedBundleAttemptId || requestedBundleRunItemId)) {
      if (!requestedBundleAttemptId || !requestedBundleRunItemId || !requestedOrderId) {
        return errorResponse("Bundle recovery requires an order, attempt, and item ID.", 400);
      }
      const { data: recoveryItem, error: recoveryItemError } = await adminClient
        .from("bundle_run_items")
        .select("id,bundle_run_attempt_id,order_id,customer_automation_id")
        .eq("id", requestedBundleRunItemId)
        .eq("bundle_run_attempt_id", requestedBundleAttemptId)
        .eq("order_id", requestedOrderId)
        .eq("customer_automation_id", customerAutomationId)
        .maybeSingle();
      if (recoveryItemError || !recoveryItem?.id) {
        return errorResponse(recoveryItemError?.message || "The bundle run item does not belong to this purchase.", 409);
      }
    }
    let runQuery = adminClient
      .from("automation_runs")
      .select("id, status, n8n_execution_id, error_message, created_at, updated_at, started_at, finished_at, run_key, order_id, bundle_run_attempt_id, bundle_run_item_id, response_payload")
      .eq("customer_automation_id", customerAutomationId);

    runQuery = requestedRunId
      ? runQuery.eq("id", requestedRunId)
      : runQuery.order("created_at", { ascending: false }).limit(1);

    if (!requestedRunId && requestedOrderId) {
      runQuery = runQuery.eq("order_id", requestedOrderId);
    }
    if (!requestedRunId && requestedBundleRunItemId) {
      runQuery = runQuery.eq("bundle_run_item_id", requestedBundleRunItemId);
    } else if (!requestedRunId && requestedBundleAttemptId) {
      runQuery = runQuery.eq("bundle_run_attempt_id", requestedBundleAttemptId);
    }

    const { data: latestRunData, error: latestRunError } = await runQuery.maybeSingle();
    let latestRun: any = latestRunData || null;

    if (latestRunError || (requestedRunId && !latestRun?.id)) {
      return errorResponse(latestRunError?.message || "The requested Nexus automation run was not found.", 404);
    }

    const recoveryProduct = Array.isArray(customerAutomation.automations)
      ? customerAutomation.automations[0]
      : customerAutomation.automations || {};
    let recoveredExecution: any = null;

    if (!latestRun?.id && recoverMissingRun && requestedOrderId) {
      const workflowId = cleanString(
        body.workflow_id ||
          body.workflowId ||
          customerAutomation.n8n_workflow_id ||
          recoveryProduct.n8n_workflow_id,
      );
      if (!workflowId) {
        return errorResponse("No n8n workflow ID found for legacy run recovery.", 400);
      }

      const orderRecord = Array.isArray(customerAutomation.orders)
        ? customerAutomation.orders[0]
        : customerAutomation.orders || {};
      recoveredExecution = await findExecutionForLegacyOrder(
        workflowId,
        customerAutomationId,
        requestedOrderId,
        cleanString(orderRecord?.created_at || customerAutomation.created_at),
        requestedBundleAttemptId,
        requestedBundleRunItemId,
      );

      if (!recoveredExecution) {
        return jsonResponse({ ok: true, status: "legacy_execution_not_found" });
      }

      const startedAt = cleanString(recoveredExecution.startedAt || recoveredExecution.createdAt) ||
        new Date().toISOString();
      const { data: recoveredRun, error: recoveredRunError } = await adminClient
        .from("automation_runs")
        .insert({
          customer_automation_id: customerAutomationId,
          buyer_id: customerAutomation.buyer_id,
          automation_id: customerAutomation.automation_id,
          order_id: requestedOrderId,
          bundle_run_attempt_id: requestedBundleAttemptId || null,
          bundle_run_item_id: requestedBundleRunItemId || null,
          runtime_type: "n8n_managed",
          trigger_type: "buyer_setup_submit",
          trigger_source: "legacy_bundle_recovery",
          status: "running",
          n8n_execution_id: cleanString(recoveredExecution.id) || null,
          request_payload: { legacy_bundle_recovery: true },
          response_payload: { legacy_bundle_recovery: true },
          started_at: startedAt,
          created_at: startedAt,
          updated_at: new Date().toISOString(),
        })
        .select("id, status, n8n_execution_id, error_message, created_at, updated_at, started_at, finished_at, run_key, order_id, bundle_run_attempt_id, bundle_run_item_id, response_payload")
        .single();

      if (recoveredRunError || !recoveredRun?.id) {
        return errorResponse(
          recoveredRunError?.message || "Could not persist the recovered legacy run.",
          500,
        );
      }

      latestRun = recoveredRun;
      if (requestedBundleRunItemId) {
        const { error: recoveryLinkError } = await adminClient
          .from("bundle_run_items")
          .update({
            automation_run_id: recoveredRun.id,
            started_at: startedAt,
            updated_at: new Date().toISOString(),
          })
          .eq("id", requestedBundleRunItemId)
          .eq("bundle_run_attempt_id", requestedBundleAttemptId);
        if (recoveryLinkError) {
          return errorResponse(recoveryLinkError.message || "Could not link the recovered run to its bundle item.", 500);
        }
      }
    }

    if (!latestRun?.id) {
      return errorResponse("No Nexus automation run was found for this purchase.", 404);
    }
    if (
      requestedBundleAttemptId &&
      cleanString(latestRun?.bundle_run_attempt_id) !== requestedBundleAttemptId
    ) {
      return errorResponse("The requested run does not belong to this bundle attempt.", 409);
    }

    if (
      requestedBundleRunItemId &&
      cleanString(latestRun?.bundle_run_item_id) !== requestedBundleRunItemId
    ) {
      return errorResponse("The requested run does not belong to this bundle workflow item.", 409);
    }

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
        body.executionId ||
        latestRun?.n8n_execution_id,
    );

    if (
      (body.execution_id || body.executionId) &&
      latestRun?.n8n_execution_id &&
      cleanString(body.execution_id || body.executionId) !== cleanString(latestRun.n8n_execution_id)
    ) {
      return errorResponse("The requested n8n execution does not belong to this Nexus run.", 409);
    }

    let execution: any = recoveredExecution;
    let rejectedStoredExecutionId = "";
    const exactRunIdentityRequired = Boolean(
      requestedRunId || latestRun?.bundle_run_attempt_id || latestRun?.bundle_run_item_id,
    );

    if (explicitExecutionId) {
      const storedExecution = await n8nFetch(
        `/api/v1/executions/${encodeURIComponent(explicitExecutionId)}?includeData=true`,
      );

      if (!exactRunIdentityRequired || executionMatchesRunContext(storedExecution, latestRun)) {
        execution = storedExecution;
      } else {
        // Older matcher versions could persist a nearby execution ID. Do not
        // trust it unless the execution payload proves the exact Nexus run.
        rejectedStoredExecutionId = explicitExecutionId;
      }
    }

    if (!execution) {
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

      const executionMatch = await findExecutionForRunContext(workflowId, latestRun);

      if (!executionMatch.execution) {
        const now = new Date().toISOString();
        const message = rejectedStoredExecutionId
          ? "The stored n8n execution belonged to a different Nexus run. Waiting for the exact execution."
          : "No n8n execution matched this exact Nexus run yet.";

        await runUpdateQuery(
          adminClient,
          customerAutomation.id,
          latestRun,
          "",
          {
            status: "running",
            n8n_execution_id: null,
            updated_at: now,
            response_payload: {
              status: "waiting_for_matching_execution",
              message,
              rejected_execution_id: rejectedStoredExecutionId || null,
              inspected_executions: executionMatch.inspected,
              candidate_ids: executionMatch.candidate_ids,
            },
          },
        );

        await updateBundleRunItemFromRun(adminClient, latestRun, {
          status: "running",
          output_id: null,
          error_message: null,
          finished_at: null,
        });

        return jsonResponse({
          ok: true,
          status: "waiting_for_matching_execution",
          message,
          rejected_execution_id: rejectedStoredExecutionId || null,
          inspected_executions: executionMatch.inspected,
          candidate_ids: executionMatch.candidate_ids,
        });
      }

      execution = executionMatch.execution;
    }

    const executionStatus = getExecutionStatus(execution);

    let result: Record<string, unknown>;

    if (EXECUTION_FAILURE_STATUSES.has(executionStatus)) {
      result = await applyExecutionFailure(adminClient, customerAutomation, execution, {
        runContext: latestRun,
      });
    } else if (EXECUTION_SUCCESS_STATUSES.has(executionStatus)) {
      result = await applyExecutionSuccess(adminClient, customerAutomation, execution, {
        forceRecover: body.force_recover === true || body.forceRecover === true,
        runContext: latestRun,
      });
    } else {
      // Never turn an unfamiliar n8n status into a successful customer output.
      // If n8n has stopped, fail closed and clear any provisional bundle output;
      // otherwise keep polling until n8n reports an explicit terminal status.
      if (execution?.stoppedAt && !EXECUTION_ACTIVE_STATUSES.has(executionStatus)) {
        execution = {
          ...execution,
          status: executionStatus || "stopped",
          error: execution?.error || {
            message: `n8n execution stopped with non-success status: ${executionStatus || "unknown"}.`,
          },
        };
        result = await applyExecutionFailure(adminClient, customerAutomation, execution, {
          runContext: latestRun,
        });
      } else {
        result = await applyExecutionRunning(adminClient, customerAutomation, execution, {
          runContext: latestRun,
        });
      }
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



