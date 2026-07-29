import Stripe from "https://esm.sh/stripe@14.25.0?target=deno";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import { safeEnqueueEmail } from "../_shared/nexus-email.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const STRIPE_LIVE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";
const STRIPE_TEST_SECRET_KEY = Deno.env.get("STRIPE_TEST_SECRET_KEY") || "";

function nowIso() {
  return new Date().toISOString();
}

function cleanString(value: unknown) {
  return String(value ?? "").trim();
}

function createStripeClient(secretKey: string) {
  return new Stripe(secretKey, { apiVersion: "2024-06-20" });
}

function stripeForOrder(order: any) {
  const environment = cleanString(order?.payment_environment || "live").toLowerCase();
  const secretKey = environment === "test" ? STRIPE_TEST_SECRET_KEY : STRIPE_LIVE_SECRET_KEY;
  if (!secretKey) {
    throw new Error(`Stripe ${environment} secret key is not configured.`);
  }
  return { stripe: createStripeClient(secretKey), environment };
}

function refundDisplay(amount: number, currency: string) {
  const code = cleanString(currency || "USD").toUpperCase();
  const zeroDecimal = new Set(["BIF", "CLP", "DJF", "GNF", "JPY", "KMF", "KRW", "MGA", "PYG", "RWF", "UGX", "VND", "VUV", "XAF", "XOF", "XPF"]);
  const value = Number(amount || 0) / (zeroDecimal.has(code) ? 1 : 100);
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: code }).format(value);
  } catch {
    return `${code} ${value.toFixed(zeroDecimal.has(code) ? 0 : 2)}`;
  }
}

async function requireAdmin(req: Request) {
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return { user: null, profile: null, error: "Missing auth token." };
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const token = authHeader.replace("Bearer ", "");
  const { data, error } = await userClient.auth.getUser(token);

  if (error || !data?.user) {
    return { user: null, profile: null, error: "Invalid auth token." };
  }

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: profile } = await adminClient
    .from("profiles")
    .select("id, email, role, full_name")
    .eq("id", data.user.id)
    .maybeSingle();

  if (!profile || profile.role !== "admin") {
    return { user: data.user, profile, error: "Admin access required." };
  }

  return { user: data.user, profile, error: null };
}

async function latestInvoiceForSubscription(stripe: Stripe, subscription: Stripe.Subscription) {
  const latestInvoice = (subscription as any).latest_invoice;
  if (!latestInvoice) return null;
  if (typeof latestInvoice === "string") {
    return await stripe.invoices.retrieve(latestInvoice, { expand: ["payment_intent", "charge"] });
  }
  return latestInvoice as any;
}

async function refundableCharge(stripe: Stripe, subscription: Stripe.Subscription, order: any) {
  const invoice: any = await latestInvoiceForSubscription(stripe, subscription);
  let paymentIntentId = cleanString(
    typeof invoice?.payment_intent === "string" ? invoice.payment_intent : invoice?.payment_intent?.id,
  ) || cleanString(order?.stripe_payment_intent_id);
  let charge: any = typeof invoice?.charge === "object" ? invoice.charge : null;
  let chargeId = cleanString(typeof invoice?.charge === "string" ? invoice.charge : charge?.id);

  if (!chargeId && paymentIntentId) {
    const paymentIntent: any = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge"] });
    charge = typeof paymentIntent?.latest_charge === "object" ? paymentIntent.latest_charge : null;
    chargeId = cleanString(typeof paymentIntent?.latest_charge === "string" ? paymentIntent.latest_charge : charge?.id);
  }

  if (!chargeId) {
    throw new Error("The latest successful subscription payment could not be found in Stripe. Nothing was cancelled or approved; verify the Stripe invoice and retry.");
  }

  if (!charge || charge.id !== chargeId) {
    charge = await stripe.charges.retrieve(chargeId, { expand: ["refunds"] });
  }

  if (!paymentIntentId) {
    paymentIntentId = cleanString(typeof charge.payment_intent === "string" ? charge.payment_intent : charge.payment_intent?.id);
  }

  if (!charge.paid || charge.status !== "succeeded") {
    throw new Error("The latest Stripe charge is not a successful paid charge and cannot be refunded.");
  }

  return { charge, chargeId, paymentIntentId };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  if (req.method === "GET") {
    return jsonResponse({ ok: true, message: "review-automation-cancellation is alive." });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed.", 405);
  }

  try {
    const { user, profile, error: authError } = await requireAdmin(req);
    if (authError || !user || !profile) {
      return errorResponse(authError || "Admin access required.", 401);
    }

    const body = await req.json().catch(() => ({}));
    const requestId = cleanString(body.request_id);
    const decision = cleanString(body.decision).toLowerCase();
    const adminNotes = cleanString(body.admin_notes);

    if (!requestId) return errorResponse("request_id is required.", 400);
    if (!["approve", "reject"].includes(decision)) {
      return errorResponse("decision must be approve or reject.", 400);
    }

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data: request, error: requestError } = await adminClient
      .from("automation_cancellation_requests")
      .select("*")
      .eq("id", requestId)
      .maybeSingle();

    if (requestError || !request) {
      return errorResponse(requestError?.message || "Cancellation request not found.", 404);
    }
    if (request.status !== "pending") {
      return errorResponse(`This request is already ${request.status}.`, 400);
    }

    const { data: order, error: orderError } = await adminClient
      .from("orders")
      .select("*")
      .eq("id", request.order_id)
      .eq("buyer_id", request.buyer_id)
      .maybeSingle();

    if (orderError || !order) {
      return errorResponse(orderError?.message || "The order for this cancellation request was not found.", 404);
    }

    const now = nowIso();
    if (decision === "reject") {
      const { error: updateRequestError } = await adminClient
        .from("automation_cancellation_requests")
        .update({
          status: "rejected",
          admin_notes: adminNotes,
          reviewed_by: user.id,
          reviewed_at: now,
          external_action_error: null,
          updated_at: now,
        })
        .eq("id", request.id)
        .eq("status", "pending");

      if (updateRequestError) return errorResponse(updateRequestError.message, 500);

      await adminClient.from("automation_events").insert({
        customer_automation_id: request.customer_automation_id,
        buyer_id: request.buyer_id,
        automation_id: request.automation_id,
        order_id: request.order_id,
        event_type: "cancellation_rejected",
        title: "Cancellation request rejected",
        message: adminNotes || "Nexus rejected the cancellation request.",
        created_by: "admin",
        created_at: now,
      });

      await safeEnqueueEmail(
        adminClient,
        "subscription_cancellation_rejected",
        { email: order.buyer_email, name: order.buyer_name },
        {
          product_title: order.automation_title || "your subscription",
          admin_notes: adminNotes,
          dashboard_url: "/pages/buyer/dashboard.html#automations",
        },
        { dedupeKey: `subscription_cancellation_rejected:${request.id}` },
      );

      return jsonResponse({ ok: true, status: "rejected", message: "Cancellation request rejected. The subscription remains active." });
    }

    const stripeMode = cleanString(order.stripe_mode).toLowerCase();
    const subscriptionId = cleanString(order.stripe_subscription_id || request.stripe_subscription_id);
    if (stripeMode !== "subscription" || !subscriptionId) {
      return errorResponse("Approval blocked: only a verified monthly Stripe subscription can be cancelled and refunded. One-time purchases cannot be cancelled.", 409);
    }

    let cancelledSubscription: Stripe.Subscription;
    let refund: Stripe.Refund | any;
    let refundedAmount = 0;
    let refundCurrency = cleanString(order.currency || order.stripe_currency || "USD").toLowerCase();

    try {
      const { stripe, environment } = stripeForOrder(order);
      const subscription = await stripe.subscriptions.retrieve(subscriptionId, { expand: ["latest_invoice.payment_intent", "latest_invoice.charge"] });
      const payment = await refundableCharge(stripe, subscription, order);

      cancelledSubscription = subscription.status === "canceled"
        ? subscription
        : await stripe.subscriptions.cancel(
            subscriptionId,
            { invoice_now: false, prorate: false },
            { idempotencyKey: `nexus-cancel-${request.id}` },
          );

      const chargeAmount = Number(payment.charge.amount || 0);
      const previouslyRefunded = Number(payment.charge.amount_refunded || 0);
      const amountRemaining = Math.max(0, chargeAmount - previouslyRefunded);
      refundCurrency = cleanString(payment.charge.currency || refundCurrency).toLowerCase();

      if (amountRemaining > 0) {
        refund = await stripe.refunds.create(
          {
            charge: payment.chargeId,
            amount: amountRemaining,
            reason: "requested_by_customer",
            metadata: {
              nexus_cancellation_request_id: request.id,
              nexus_order_id: order.id,
              nexus_environment: environment,
            },
          },
          { idempotencyKey: `nexus-refund-${request.id}` },
        );
        refundedAmount = previouslyRefunded + Number(refund.amount || 0);
      } else {
        const existingRefunds = await stripe.refunds.list({ charge: payment.chargeId, limit: 100 });
        refund = existingRefunds.data[0] || {
          id: cleanString(order.stripe_refund_id) || "already_refunded",
          status: "succeeded",
          amount: previouslyRefunded,
          currency: refundCurrency,
        };
        refundedAmount = previouslyRefunded;
      }

      if (["failed", "canceled", "cancelled"].includes(cleanString(refund.status).toLowerCase())) {
        throw new Error(`Stripe returned refund status ${refund.status}.`);
      }
    } catch (stripeError) {
      const message = stripeError instanceof Error ? stripeError.message : String(stripeError);
      await adminClient
        .from("automation_cancellation_requests")
        .update({ external_action_error: message, updated_at: nowIso() })
        .eq("id", request.id)
        .eq("status", "pending");
      return errorResponse(`Stripe cancellation/refund did not complete: ${message}`, 502);
    }

    const refundStatus = cleanString(refund.status || "pending").toLowerCase();
    const { error: automationUpdateError } = await adminClient
      .from("customer_automations")
      .update({
        status: "cancelled",
        setup_status: "cancelled",
        runtime_status: "cancelled",
        health_status: "cancelled",
        schedule_status: "cancelled",
        next_run_at: null,
        last_error_message: null,
        updated_at: now,
      })
      .eq("order_id", order.id)
      .eq("buyer_id", request.buyer_id);

    if (automationUpdateError) {
      return errorResponse(`Stripe completed, but Nexus could not update the subscription records: ${automationUpdateError.message}. Retry this approval safely.`, 500);
    }

    const { error: orderUpdateError } = await adminClient
      .from("orders")
      .update({
        payment_status: "refunded",
        order_status: "cancelled",
        stripe_subscription_status: cleanString(cancelledSubscription.status || "canceled"),
        stripe_cancel_at_period_end: false,
        stripe_refund_id: cleanString(refund.id),
        refund_status: refundStatus,
        refunded_at: now,
        refunded_amount: refundedAmount,
        refunded_currency: refundCurrency,
        cancellation_approved_at: now,
        cancellation_approved_by: user.id,
        updated_at: now,
      })
      .eq("id", order.id);

    if (orderUpdateError) {
      return errorResponse(`Stripe completed, but Nexus could not update the order: ${orderUpdateError.message}. Retry this approval safely.`, 500);
    }

    const { error: updateRequestError } = await adminClient
      .from("automation_cancellation_requests")
      .update({
        status: "approved",
        admin_notes: adminNotes,
        reviewed_by: user.id,
        reviewed_at: now,
        stripe_subscription_id: subscriptionId,
        stripe_refund_id: cleanString(refund.id),
        stripe_refund_status: refundStatus,
        stripe_refunded_amount: refundedAmount,
        stripe_refunded_currency: refundCurrency,
        stripe_cancellation_status: cleanString(cancelledSubscription.status || "canceled"),
        stripe_cancelled_at: now,
        stripe_refunded_at: now,
        external_action_error: null,
        updated_at: now,
      })
      .eq("id", request.id)
      .eq("status", "pending");

    if (updateRequestError) {
      return errorResponse(`Stripe completed, but the review audit could not be saved: ${updateRequestError.message}. Retry this approval safely.`, 500);
    }

    const refundLabel = refundDisplay(refundedAmount, refundCurrency);
    await adminClient.from("automation_events").insert({
      customer_automation_id: request.customer_automation_id,
      buyer_id: request.buyer_id,
      automation_id: request.automation_id,
      order_id: request.order_id,
      event_type: "cancellation_approved",
      title: "Subscription cancelled and refund submitted",
      message: `${adminNotes ? `${adminNotes} ` : ""}Stripe refund ${cleanString(refund.id)} (${refundLabel}, ${refundStatus}). Existing outputs remain available.`,
      created_by: "admin",
      created_at: now,
    });

    await safeEnqueueEmail(
      adminClient,
      "subscription_cancellation_approved",
      { email: order.buyer_email, name: order.buyer_name },
      {
        product_title: order.automation_title || "your subscription",
        refund_display: refundLabel,
        refund_status: refundStatus,
        refund_id: cleanString(refund.id),
        dashboard_url: "/pages/buyer/dashboard.html#outputs",
      },
      { dedupeKey: `subscription_cancellation_approved:${request.id}` },
    );

    return jsonResponse({
      ok: true,
      status: "approved",
      refund_id: cleanString(refund.id),
      refund_status: refundStatus,
      refunded_amount: refundedAmount,
      refunded_currency: refundCurrency,
      message: `Subscription cancelled. ${refundLabel} refund ${refundStatus === "succeeded" ? "completed" : "submitted"}. Existing outputs remain in the buyer dashboard.`,
    });
  } catch (error) {
    console.error(error);
    return errorResponse(error instanceof Error ? error.message : "Could not review cancellation.", 500);
  }
});
