import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function nowIso() {
  return new Date().toISOString();
}

function cleanString(value: unknown) {
  return String(value || "").trim();
}

function one(value: any) {
  return Array.isArray(value) ? value[0] || null : value || null;
}

async function requireBuyer(req: Request) {
  const authHeader = req.headers.get("Authorization") || "";

  if (!authHeader.startsWith("Bearer ")) {
    return { user: null, error: "Missing auth token." };
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const token = authHeader.replace("Bearer ", "");
  const { data, error } = await userClient.auth.getUser(token);

  if (error || !data?.user) {
    return { user: null, error: "Invalid auth token." };
  }

  return { user: data.user, error: null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  if (req.method === "GET") {
    return jsonResponse({ ok: true, message: "request-automation-cancellation is alive." });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed.", 405);
  }

  try {
    const { user, error: authError } = await requireBuyer(req);
    if (authError || !user) {
      return errorResponse(authError || "Buyer login required.", 401);
    }

    const body = await req.json().catch(() => ({}));
    const customerAutomationId = cleanString(body.customer_automation_id);
    const reason = cleanString(body.reason);

    if (!customerAutomationId) {
      return errorResponse("customer_automation_id is required.", 400);
    }

    if (!reason || reason.length < 10) {
      return errorResponse("Please provide a cancellation reason with at least 10 characters.", 400);
    }

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: customerAutomation, error: automationError } = await adminClient
      .from("customer_automations")
      .select(`
        id,
        buyer_id,
        order_id,
        automation_id,
        status,
        orders(
          id,
          payment_status,
          order_status,
          stripe_mode,
          stripe_subscription_id,
          stripe_subscription_status,
          order_type,
          bundle_id
        )
      `)
      .eq("id", customerAutomationId)
      .eq("buyer_id", user.id)
      .maybeSingle();

    if (automationError || !customerAutomation) {
      return errorResponse(automationError?.message || "Automation not found for this buyer.", 404);
    }

    const order = one((customerAutomation as any).orders);
    if (!order?.id || order.id !== customerAutomation.order_id) {
      return errorResponse("The paid order for this automation could not be verified.", 409);
    }

    const stripeMode = cleanString(order.stripe_mode).toLowerCase();
    const subscriptionId = cleanString(order.stripe_subscription_id);
    const paymentStatus = cleanString(order.payment_status).toLowerCase();
    const orderStatus = cleanString(order.order_status).toLowerCase();
    const subscriptionStatus = cleanString(order.stripe_subscription_status).toLowerCase();

    if (stripeMode !== "subscription" || !subscriptionId) {
      return errorResponse("Only monthly subscription products can be cancelled. One-time purchases stay available permanently.", 400);
    }

    if (
      ["cancelled", "canceled", "refunded"].includes(paymentStatus) ||
      ["cancelled", "canceled", "refunded"].includes(orderStatus) ||
      ["cancelled", "canceled"].includes(subscriptionStatus)
    ) {
      return errorResponse("This subscription is already cancelled.", 400);
    }

    if (paymentStatus !== "paid") {
      return errorResponse("Only a paid monthly subscription can be submitted for cancellation.", 400);
    }

    const { data: existingRequest, error: existingError } = await adminClient
      .from("automation_cancellation_requests")
      .select("id, status")
      .eq("order_id", order.id)
      .eq("buyer_id", user.id)
      .eq("status", "pending")
      .maybeSingle();

    if (existingError) {
      return errorResponse(existingError.message, 500);
    }

    if (existingRequest) {
      return jsonResponse({
        ok: true,
        already_exists: true,
        request_id: existingRequest.id,
        message: "A cancellation request for this subscription is already pending admin review.",
      });
    }

    const now = nowIso();
    const { data: request, error: requestError } = await adminClient
      .from("automation_cancellation_requests")
      .insert({
        customer_automation_id: customerAutomation.id,
        order_id: order.id,
        automation_id: customerAutomation.automation_id,
        buyer_id: user.id,
        reason,
        status: "pending",
        stripe_subscription_id: subscriptionId,
        created_at: now,
        updated_at: now,
      })
      .select()
      .single();

    if (requestError) {
      return errorResponse(requestError.message, 500);
    }

    await adminClient.from("automation_events").insert({
      customer_automation_id: customerAutomation.id,
      buyer_id: user.id,
      automation_id: customerAutomation.automation_id,
      order_id: order.id,
      event_type: "cancellation_requested",
      title: "Subscription cancellation requested",
      message: reason,
      created_by: "buyer",
      created_at: now,
    });

    await adminClient.from("admin_notifications").insert({
      notification_type: "cancellation_requested",
      title: "Monthly subscription cancellation needs approval",
      message: reason,
      related_order_id: order.id,
      related_customer_automation_id: customerAutomation.id,
      status: "unread",
      created_at: now,
    });

    return jsonResponse({
      ok: true,
      request,
      message: "Cancellation request submitted. Your subscription stays active until a Nexus admin approves it. Existing outputs will remain available.",
    });
  } catch (error) {
    console.error(error);
    return errorResponse(error instanceof Error ? error.message : "Could not request cancellation.", 500);
  }
});
