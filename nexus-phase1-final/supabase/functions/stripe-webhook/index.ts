import Stripe from "https://esm.sh/stripe@14.25.0?target=deno";
import { createClient } from "npm:@supabase/supabase-js@2";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
  apiVersion: "2024-06-20",
});

const cryptoProvider = Stripe.createSubtleCryptoProvider();

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function nowIso() {
  return new Date().toISOString();
}

async function alreadyProcessed(event: Stripe.Event) {
  const { data } = await adminClient
    .from("stripe_events")
    .select("id")
    .eq("id", event.id)
    .maybeSingle();

  return !!data;
}

async function recordEvent(event: Stripe.Event) {
  await adminClient.from("stripe_events").insert({
    id: event.id,
    type: event.type,
    livemode: event.livemode,
    payload: event as any,
  });
}

async function getAutomationProduct(automationId: string) {
  if (!automationId) return null;

  const { data, error } = await adminClient
    .from("automations")
    .select(`
      id,
      title,
      slug,
      developer_id,
      runtime_type,
      runtime_webhook_url,
      runtime_webhook_path,
      runtime_output_mode,
      n8n_workflow_id,
      n8n_workflow_name,
      n8n_webhook_url,
      setup_schema,
      credential_schema
    `)
    .eq("id", automationId)
    .maybeSingle();

  if (error) {
    console.warn("Could not load automation product:", error.message);
    return null;
  }

  return data;
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session) {
  const orderId = session.metadata?.order_id;

  if (!orderId) {
    console.warn("Missing order_id in checkout session metadata", session.id);
    return;
  }

  const { data: order, error: orderError } = await adminClient
    .from("orders")
    .select("*")
    .eq("id", orderId)
    .maybeSingle();

  if (orderError || !order) {
    console.warn("Order not found for Checkout Session", session.id);
    return;
  }

  const isPaid =
    session.payment_status === "paid" ||
    session.mode === "subscription";

  const stripeCustomerId =
    typeof session.customer === "string"
      ? session.customer
      : order.stripe_customer_id;

  const stripePaymentIntentId =
    typeof session.payment_intent === "string"
      ? session.payment_intent
      : order.stripe_payment_intent_id;

  const stripeSubscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : order.stripe_subscription_id;

  await adminClient
    .from("orders")
    .update({
      payment_status: isPaid ? "paid" : "pending",
      order_status: isPaid ? "setup_requested" : "checkout_started",
      stripe_payment_status: session.payment_status,
      stripe_customer_id: stripeCustomerId,
      stripe_payment_intent_id: stripePaymentIntentId,
      stripe_subscription_id: stripeSubscriptionId,
      paid_at: isPaid ? nowIso() : null,
      updated_at: nowIso(),
    })
    .eq("id", order.id);

  const { data: existingCustomerAutomation } = await adminClient
    .from("customer_automations")
    .select("id")
    .eq("order_id", order.id)
    .maybeSingle();

  if (existingCustomerAutomation || !isPaid) {
    return;
  }

  const automationProduct = await getAutomationProduct(order.automation_id);

  const runtimeType =
    automationProduct?.runtime_type ||
    order.runtime_type ||
    "manual";

  const runtimeWebhookUrl =
    automationProduct?.runtime_webhook_url ||
    automationProduct?.n8n_webhook_url ||
    order.runtime_webhook_url ||
    null;

  const runtimeWebhookPath =
    automationProduct?.runtime_webhook_path ||
    order.runtime_webhook_path ||
    null;

  const n8nWorkflowId =
    automationProduct?.n8n_workflow_id ||
    order.n8n_workflow_id ||
    null;

  const n8nWorkflowName =
    automationProduct?.n8n_workflow_name ||
    order.n8n_workflow_name ||
    null;

  const { data: customerAutomation, error: automationError } = await adminClient
    .from("customer_automations")
    .insert({
      order_id: order.id,
      buyer_id: order.buyer_id,
      automation_id: order.automation_id,
      developer_id: order.developer_id || automationProduct?.developer_id || null,

      name: order.automation_title || automationProduct?.title || "Automation",

      status: "pending_setup",
      install_type: order.install_type || "self_serve",
      setup_status: "setup_required",

      runtime_type: runtimeType,
      runtime_webhook_url: runtimeWebhookUrl,
      runtime_webhook_path: runtimeWebhookPath,
      runtime_output_mode: automationProduct?.runtime_output_mode || "standard",
      n8n_workflow_id: n8nWorkflowId,
      n8n_workflow_name: n8nWorkflowName,
      runtime_status: "not_started",

      health_status: "not_configured",
      failure_count: 0,
      last_error_message: null,

      created_at: nowIso(),
      updated_at: nowIso(),
    })
    .select()
    .single();

  if (automationError) {
    console.error("Could not create customer automation:", automationError.message);
    return;
  }

  if (!customerAutomation) return;

  await adminClient.from("automation_events").insert({
    customer_automation_id: customerAutomation.id,
    buyer_id: order.buyer_id,
    automation_id: order.automation_id,
    order_id: order.id,
    event_type: "payment_completed",
    title: "Payment received",
    message: `Your payment for ${order.automation_title || automationProduct?.title || "this automation"} was received. Complete setup to start the automation.`,
    created_by: "system",
    created_at: nowIso(),
  });

  await adminClient.from("admin_notifications").insert({
    notification_type: "paid_order",
    title: "New paid automation order",
    message: `${order.buyer_name || order.buyer_email || "A buyer"} purchased ${order.automation_title || automationProduct?.title || "an automation"}.`,
    related_order_id: order.id,
    related_customer_automation_id: customerAutomation.id,
    status: "unread",
    created_at: nowIso(),
  });
}

async function handleCheckoutExpired(session: Stripe.Checkout.Session) {
  const orderId = session.metadata?.order_id;

  if (!orderId) return;

  await adminClient
    .from("orders")
    .update({
      payment_status: "expired",
      order_status: "checkout_expired",
      updated_at: nowIso(),
    })
    .eq("id", orderId);
}

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
  const subscriptionId =
    typeof invoice.subscription === "string" ? invoice.subscription : "";

  if (!subscriptionId) return;

  await adminClient
    .from("orders")
    .update({
      payment_status: "payment_failed",
      order_status: "payment_failed",
      updated_at: nowIso(),
    })
    .eq("stripe_subscription_id", subscriptionId);

  const { data: order } = await adminClient
    .from("orders")
    .select("id, buyer_id, automation_id")
    .eq("stripe_subscription_id", subscriptionId)
    .maybeSingle();

  if (!order) return;

  await adminClient
    .from("customer_automations")
    .update({
      status: "payment_failed",
      health_status: "payment_issue",
      updated_at: nowIso(),
    })
    .eq("order_id", order.id);
}

Deno.serve(async (request) => {
  const signature = request.headers.get("Stripe-Signature");
  const body = await request.text();

  let event: Stripe.Event;

  try {
    event = await stripe.webhooks.constructEventAsync(
      body,
      signature || "",
      STRIPE_WEBHOOK_SECRET,
      undefined,
      cryptoProvider,
    );
  } catch (error) {
    console.error("Webhook signature verification failed:", error);

    return new Response(
      error instanceof Error ? error.message : "Webhook signature verification failed",
      {
        status: 400,
      },
    );
  }

  try {
    if (await alreadyProcessed(event)) {
      return new Response(JSON.stringify({ ok: true, duplicate: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    await recordEvent(event);

    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCheckoutCompleted(session);
        break;
      }

      case "checkout.session.expired": {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCheckoutExpired(session);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        await handleInvoicePaymentFailed(invoice);
        break;
      }

      default:
        break;
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Webhook processing failed:", error);

    return new Response(
      JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : "Webhook processing failed",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
});