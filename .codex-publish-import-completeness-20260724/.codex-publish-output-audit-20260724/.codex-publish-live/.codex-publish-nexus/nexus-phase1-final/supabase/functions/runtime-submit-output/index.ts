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
    "authorisation",
    "authorization",
    "authentication",
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

  const { error: fallbackError } = await adminClient
    .from("customer_automations")
    .update(fallbackPayload)
    .eq("id", customerAutomationId);

  return fallbackError || error;
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

    const headerSecret = req.headers.get("x-nexus-runtime-secret") || "";
    const body = await req.json().catch(() => ({}));

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
        body.customerAutomationId,
    );

    if (!customerAutomationId) {
      return errorResponse("customer_automation_id is required.", 400);
    }

    const status = cleanString(body.status || "success").toLowerCase();

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

      await adminClient
        .from("automation_runs")
        .insert({
          customer_automation_id: customerAutomation.id,
          buyer_id: customerAutomation.buyer_id,
          automation_id: customerAutomation.automation_id,
          order_id: customerAutomation.order_id,
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

      await tryInsertRunError(adminClient, {
        customer_automation_id: customerAutomation.id,
        buyer_id: customerAutomation.buyer_id,
        automation_id: customerAutomation.automation_id,
        order_id: customerAutomation.order_id,

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

    const outputTitle =
      cleanString(body.title) ||
      "Automation output";

    const outputType =
      cleanString(body.output_type) ||
      "report";

    const outputPayload = {
      customer_automation_id: customerAutomation.id,
      order_id: customerAutomation.order_id || null,
      buyer_id: customerAutomation.buyer_id,
      automation_id: customerAutomation.automation_id || null,

      output_type: outputType,
      status: "published",

      title: outputTitle,
      summary: cleanString(body.summary),
      content_text: cleanString(body.content_text),
      content_html: cleanString(body.content_html || body.html),
      content_json: asJsonObject(body.content_json || body.data || {}),
      file_url: cleanString(body.file_url),
      storage_path: cleanString(body.storage_path),

      created_by: "runtime",
      created_at: now,
      updated_at: now,
    };

    const { data: output, error: outputError } = await adminClient
      .from("automation_outputs")
      .insert(outputPayload)
      .select()
      .single();

    if (outputError) {
      return errorResponse(outputError.message, 500);
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

    await adminClient
      .from("automation_runs")
      .insert({
        customer_automation_id: customerAutomation.id,
        buyer_id: customerAutomation.buyer_id,
        automation_id: customerAutomation.automation_id,
        order_id: customerAutomation.order_id,
        runtime_type: customerAutomation.runtime_type || "n8n_managed",
        trigger_type: "runtime_callback",
        status: "success",
        started_at: now,
        finished_at: now,
        created_at: now,
        updated_at: now,
      });

    await insertEvent(adminClient, {
      customer_automation_id: customerAutomation.id,
      buyer_id: customerAutomation.buyer_id,
      automation_id: customerAutomation.automation_id,
      order_id: customerAutomation.order_id,
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
