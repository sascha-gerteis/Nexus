import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import { safeEnqueueEmail } from "../_shared/nexus-email.ts";
import {
  buildWebhookRuntimeEnvelope,
  mappingObject,
  normalizeEventMappings,
  setupFieldDefinitions,
} from "../_shared/webhook-event-mapping.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const CONFIG_TABLE = "customer_automation_webhook_configs";
const TEST_TABLE = "customer_automation_webhook_tests";
const MAX_BODY_BYTES = 64 * 1024;

function nowIso() {
  return new Date().toISOString();
}

function cleanString(value: unknown) {
  return String(value || "").trim();
}

function one(value: any) {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function endpointIdFromRequest(req: Request) {
  const parts = new URL(req.url).pathname.split("/").filter(Boolean);
  const functionIndex = parts.lastIndexOf("buyer-webhook-ingress");
  return functionIndex >= 0 ? cleanString(parts[functionIndex + 1]) : "";
}

function suppliedSecret(req: Request) {
  const direct = cleanString(req.headers.get("x-nexus-webhook-secret"));
  if (direct) return direct;
  const authorization = cleanString(req.headers.get("Authorization"));
  return authorization.replace(/^Bearer\s+/i, "").trim();
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function bytesFromHex(value: string) {
  const clean = cleanString(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(clean)) return new Uint8Array();
  const output = new Uint8Array(clean.length / 2);
  for (let index = 0; index < clean.length; index += 2) {
    output[index / 2] = Number.parseInt(clean.slice(index, index + 2), 16);
  }
  return output;
}

function sensitiveKey(value: string) {
  return /token|secret|password|authorization|cookie|credential|api[_-]?key|private[_-]?key/i.test(value);
}

function safePreview(value: unknown, depth = 0): unknown {
  if (depth > 7) return "[nested]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safePreview(item, depth + 1));
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 40)) {
      output[key] = sensitiveKey(key) ? "[redacted]" : safePreview(child, depth + 1);
    }
    return output;
  }
  if (typeof value === "string") return value.slice(0, 240);
  if (["number", "boolean"].includes(typeof value) || value === null) return value;
  return cleanString(value).slice(0, 240);
}

async function loadRuntimeContext(adminClient: any, config: any) {
  const { data, error } = await adminClient
    .from("customer_automations")
    .select(`
      *,
      automations(
        id, title, runtime_type, runtime_trigger_mode, setup_schema,
        webhook_included_runs, webhook_topup_runs, webhook_topup_price, currency
      ),
      orders(
        id, bundle_id, order_type, buyer_id, buyer_email, buyer_name, buyer_company,
        payment_status, order_status, stripe_mode, stripe_subscription_status,
        stripe_current_period_start, stripe_current_period_end
      )
    `)
    .eq("id", config.customer_automation_id)
    .eq("buyer_id", config.buyer_id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Webhook purchase identity was not found.");
  return data;
}

async function loadSavedSetup(adminClient: any, customerAutomation: any, automation: any) {
  const { data, error } = await adminClient
    .from("automation_setup_submissions")
    .select("answers, setup_answers")
    .eq("customer_automation_id", customerAutomation.id)
    .eq("buyer_id", customerAutomation.buyer_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const preferred = mappingObject(data?.setup_answers);
  const answers = Object.keys(preferred).length ? preferred : mappingObject(data?.answers);
  const safe: Record<string, unknown> = {};
  for (const field of setupFieldDefinitions(automation.setup_schema)) {
    if (Object.prototype.hasOwnProperty.call(answers, field.name)) safe[field.name] = answers[field.name];
  }
  return safe;
}

async function recordInboundHistory(adminClient: any, config: any, params: {
  status: "succeeded" | "failed";
  eventId: string;
  responseStatus: number;
  preview: Record<string, unknown>;
  errorMessage?: string;
}) {
  const payload = {
    status: params.status,
    response_status: params.responseStatus,
    error_message: cleanString(params.errorMessage).slice(0, 1000) || null,
    payload_preview: params.preview,
  };
  const { data: existing, error: existingError } = await adminClient
    .from(TEST_TABLE)
    .select("id")
    .eq("webhook_config_id", config.id)
    .eq("direction", "inbound")
    .eq("event_id", params.eventId)
    .maybeSingle();
  if (existingError) throw new Error(existingError.message);
  if (existing?.id) {
    const { error: updateError } = await adminClient
      .from(TEST_TABLE)
      .update(payload)
      .eq("id", existing.id);
    if (updateError) throw new Error(updateError.message);
    return;
  }

  const { error } = await adminClient.from(TEST_TABLE).insert({
    webhook_config_id: config.id,
    customer_automation_id: config.customer_automation_id,
    buyer_id: config.buyer_id,
    direction: "inbound",
    event_id: params.eventId,
    created_at: nowIso(),
    ...payload,
  });
  if (error && !/duplicate|unique/i.test(cleanString(error.message))) throw new Error(error.message);
}

async function sendUsageAlert(adminClient: any, context: any, reservation: any) {
  if (!["warning", "exhausted"].includes(cleanString(reservation?.notification))) return;
  const order = one(context.orders) || {};
  const product = one(context.automations) || {};
  if (!order.buyer_email) return;
  const exhausted = reservation.notification === "exhausted";
  await safeEnqueueEmail(
    adminClient,
    exhausted ? "webhook_usage_exhausted" : "webhook_usage_warning",
    { email: order.buyer_email, name: order.buyer_name },
    {
      product_title: product.title || context.name || "your automation",
      remaining_units: Number(reservation.remaining_units || 0),
      total_units: Number(reservation.total_units || 0),
      period_end: reservation.period_end || "",
      dashboard_url: `/pages/buyer/webhook-setup.html?id=${encodeURIComponent(context.id)}`,
    },
    { dedupeKey: `webhook_usage:${reservation.notification}:${reservation.entitlement_id || context.id}` },
  );
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders });
  if (req.method === "GET") return jsonResponse({ ok: true, message: "Nexus buyer webhook ingress is available." });
  if (req.method !== "POST") return errorResponse("Method not allowed.", 405);

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return errorResponse("Webhook ingress is not configured.", 500);
    }

    const endpointId = endpointIdFromRequest(req);
    if (!endpointId) return errorResponse("Webhook endpoint ID is missing.", 404);

    const contentLength = Number(req.headers.get("content-length") || 0);
    if (contentLength > MAX_BODY_BYTES) return errorResponse("Webhook payload is too large.", 413);

    const rawBody = await req.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) {
      return errorResponse("Webhook payload is too large.", 413);
    }

    let payload: unknown = {};
    if (rawBody) {
      try {
        payload = JSON.parse(rawBody);
      } catch {
        payload = { text: rawBody.slice(0, 2000) };
      }
    }

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: config, error } = await adminClient
      .from(CONFIG_TABLE)
      .select("*")
      .eq("inbound_endpoint_id", endpointId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!config) return errorResponse("Webhook endpoint was not found.", 404);
    if (config.inbound_status === "disabled") return errorResponse("Webhook endpoint is disabled.", 410);

    const secret = suppliedSecret(req);
    if (!secret) return errorResponse("Webhook secret is required.", 401);
    const suppliedHash = await sha256(secret);
    const storedHash = bytesFromHex(config.inbound_secret_hash);
    if (!storedHash.length || !timingSafeEqual(suppliedHash, storedHash)) {
      return errorResponse("Webhook secret is invalid.", 401);
    }

    const now = nowIso();
    const suppliedEventId = cleanString(req.headers.get("x-nexus-event-id"));
    if (suppliedEventId.length > 200) return errorResponse("Webhook event ID is too long.", 400);
    const eventId = suppliedEventId || crypto.randomUUID();
    const { data: existingEvent, error: existingEventError } = await adminClient
      .from(TEST_TABLE)
      .select("id, status, response_status, error_message, created_at")
      .eq("webhook_config_id", config.id)
      .eq("direction", "inbound")
      .eq("event_id", eventId)
      .maybeSingle();
    if (existingEventError) throw new Error(existingEventError.message);
    // Successful events are immutable idempotent duplicates. Failed events
    // continue below so a corrected payload or newly purchased quota can retry.
    if (existingEvent?.status === "succeeded") {
      return jsonResponse({
        ok: true,
        accepted: true,
        duplicate: true,
        test_only: config.live_enabled !== true,
        live_runtime_enabled: config.live_enabled === true,
        event_id: eventId,
        received_at: existingEvent.created_at,
        message: "This webhook event was already received and was not counted twice.",
      }, 200);
    }

    const preview = safePreview(payload) as Record<string, unknown>;

    if (config.live_enabled === true) {
      const customerAutomation = await loadRuntimeContext(adminClient, config);
      const automation = one(customerAutomation.automations) || {};
      const order = one(customerAutomation.orders) || {};
      if (cleanString(automation.runtime_trigger_mode).toLowerCase() !== "buyer_webhook") {
        return errorResponse("This product is not configured for buyer webhook requests.", 409);
      }

      const savedSetup = await loadSavedSetup(adminClient, customerAutomation, automation);
      const mappings = normalizeEventMappings(config.event_mapping, automation.setup_schema);
      const runtime = buildWebhookRuntimeEnvelope({
        customerAutomation,
        automation,
        order,
        payload: mappingObject(payload),
        eventId,
        receivedAt: now,
        mappings,
        savedSetup,
        setupSchema: automation.setup_schema,
      });
      if (!runtime.ok) {
        const message = runtime.errors.join(" ") || "Webhook event mapping is invalid.";
        await recordInboundHistory(adminClient, config, {
          status: "failed", eventId, responseStatus: 422, preview, errorMessage: message,
        });
        return errorResponse(message, 422, { event_id: eventId, accepted: false });
      }

      const { data: reservation, error: reserveError } = await adminClient.rpc(
        "reserve_buyer_webhook_runtime_dispatch",
        {
          p_webhook_config_id: config.id,
          p_event_id: eventId,
          p_event_payload: runtime.envelope.event,
          p_setup_overrides: runtime.envelope.setup,
          p_request_payload: runtime.envelope.request,
          p_request_preview: { event_id: eventId, received_at: now, payload: preview },
        },
      );
      if (reserveError) throw new Error(reserveError.message);

      const responseStatus = reservation?.ok ? 202 : reservation?.status === "quota_exhausted" ? 429 : 409;
      await recordInboundHistory(adminClient, config, {
        status: reservation?.ok ? "succeeded" : "failed",
        eventId,
        responseStatus,
        preview,
        errorMessage: reservation?.error || "",
      });
      const { error: updateError } = await adminClient.from(CONFIG_TABLE).update({
        inbound_last_received_at: now,
        inbound_last_event_id: eventId,
        inbound_last_payload_preview: preview,
        updated_at: now,
      }).eq("id", config.id);
      if (updateError) console.warn("Could not update live webhook receipt preview:", updateError.message);
      await sendUsageAlert(adminClient, customerAutomation, reservation);

      if (!reservation?.ok) {
        const retryAfter = reservation?.period_end
          ? Math.max(60, Math.ceil((new Date(reservation.period_end).getTime() - Date.now()) / 1000))
          : 3600;
        return new Response(JSON.stringify({
          ok: false,
          accepted: false,
          live_runtime_enabled: true,
          event_id: eventId,
          ...reservation,
          manage_usage_url: `/pages/buyer/webhook-setup.html?id=${encodeURIComponent(customerAutomation.id)}`,
        }), {
          status: responseStatus,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
            ...(responseStatus === 429 ? { "Retry-After": String(retryAfter) } : {}),
          },
        });
      }

      return jsonResponse({
        ok: true,
        accepted: true,
        queued: reservation.status === "queued",
        duplicate: reservation.duplicate === true,
        test_only: false,
        live_runtime_enabled: true,
        event_id: eventId,
        run_id: reservation.run_id,
        remaining_runs: reservation.remaining_units,
        total_runs: reservation.total_units,
        received_at: now,
        message: reservation.duplicate
          ? "This event was already accepted and was not counted twice."
          : "Webhook request accepted and queued for processing.",
      }, reservation.duplicate ? 200 : 202);
    }

    const nextStatus = config.inbound_status === "confirmed" ? "confirmed" : "test_received";
    const { error: updateError } = await adminClient.from(CONFIG_TABLE).update({
      inbound_status: nextStatus,
      inbound_last_received_at: now,
      inbound_last_event_id: eventId,
      inbound_last_payload_preview: preview,
      event_mapping_status: "awaiting_validation",
      event_mapping_last_event_id: null,
      event_mapping_last_validated_at: null,
      event_mapping_last_error: null,
      event_mapping_preview: {},
      event_mapping_confirmed_at: null,
      live_enabled: false,
      updated_at: now,
    }).eq("id", config.id);
    if (updateError) throw new Error(updateError.message);
    await recordInboundHistory(adminClient, config, {
      status: "succeeded", eventId, responseStatus: 202, preview,
    });

    return jsonResponse({
      ok: true,
      accepted: true,
      test_only: true,
      live_runtime_enabled: false,
      event_id: eventId,
      received_at: now,
      message: "Webhook test received. Return to Nexus to confirm the connection.",
    }, 202);
  } catch (error) {
    console.error("buyer-webhook-ingress failed:", error);
    return errorResponse(error instanceof Error ? error.message : "Could not receive webhook request.", 500);
  }
});
