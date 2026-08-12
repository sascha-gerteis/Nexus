import Stripe from "https://esm.sh/stripe@14.25.0?target=deno";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const PRODUCTION_SITE_URL = "https://nexus-ai.software";
const ZERO_DECIMAL_CURRENCIES = new Set(["jpy"]);
const SUPPORTED_CURRENCIES = new Set(["usd", "thb", "eur", "gbp", "jpy"]);

function stripeClient(secret: string) {
  return new Stripe(secret || "", { apiVersion: "2024-06-20" });
}

function cleanString(value: unknown) {
  return String(value ?? "").trim();
}

function one(value: any) {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function cleanSiteUrl(value: unknown) {
  try {
    const url = new URL(cleanString(value) || PRODUCTION_SITE_URL);
    if (["localhost", "127.0.0.1", "::1"].includes(url.hostname.toLowerCase())) return PRODUCTION_SITE_URL;
    return url.origin;
  } catch {
    return PRODUCTION_SITE_URL;
  }
}

const SITE_URL = cleanSiteUrl(Deno.env.get("SITE_URL"));

async function requireBuyer(req: Request) {
  const authHeader = req.headers.get("Authorization") || "";
  if (!/^Bearer\s+\S+/i.test(authHeader)) return { user: null, error: "Missing auth token" };
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user) return { user: null, error: "Invalid auth token" };
  return { user: data.user, error: null };
}

async function paymentMode(adminClient: any, requestedEnvironment = "") {
  const liveKey = Deno.env.get("STRIPE_SECRET_KEY") || "";
  const testKey = Deno.env.get("STRIPE_TEST_SECRET_KEY") || "";
  let environment = cleanString(requestedEnvironment).toLowerCase();

  if (!environment) {
    const { data, error } = await adminClient
      .from("platform_settings")
      .select("value")
      .eq("key", "payment_mode")
      .maybeSingle();
    if (!error) environment = cleanString(data?.value?.mode).toLowerCase();
  }

  if (environment === "test") {
    if (!testKey) throw new Error("Payment test mode is enabled, but STRIPE_TEST_SECRET_KEY is missing.");
    return { environment: "test", client: stripeClient(testKey) };
  }
  if (!liveKey) throw new Error("STRIPE_SECRET_KEY is missing.");
  return { environment: "live", client: stripeClient(liveKey) };
}

function unitAmount(amount: number, currency: string) {
  return ZERO_DECIMAL_CURRENCIES.has(currency) ? Math.round(amount) : Math.round(amount * 100);
}

function activePurchase(customerAutomation: any, product: any, order: any) {
  if (cleanString(product?.runtime_trigger_mode).toLowerCase() !== "buyer_webhook") {
    return "This product is not configured for buyer webhook usage.";
  }
  if (cleanString(product?.pricing_type).toLowerCase() !== "monthly") {
    return "Additional webhook runs require a monthly subscription product.";
  }
  if (cleanString(order?.stripe_mode).toLowerCase() !== "subscription" && !cleanString(order?.stripe_subscription_id)) {
    return "Additional webhook runs require a monthly subscription product.";
  }
  if (cleanString(order?.payment_status).toLowerCase() !== "paid") return "The subscription payment is not active.";
  const subscription = cleanString(order?.stripe_subscription_status).toLowerCase();
  if (subscription && !["active", "trialing"].includes(subscription)) return "The subscription is not active.";
  if (/cancel|expired|refund/i.test([customerAutomation?.status, order?.order_status].join(" "))) {
    return "This subscription is cancelled or expired.";
  }
  return "";
}

async function loadOwnedAutomation(adminClient: any, id: string, buyerId: string) {
  const { data, error } = await adminClient
    .from("customer_automations")
    .select(`
      *,
      automations(
        id, title, pricing_type, currency, runtime_trigger_mode,
        webhook_included_runs, webhook_topup_runs, webhook_topup_price
      ),
      orders(
        id, buyer_id, buyer_email, buyer_name, payment_status, order_status,
        stripe_mode, stripe_subscription_id, stripe_subscription_status, stripe_current_period_start,
        stripe_current_period_end, stripe_cancel_at_period_end
      )
    `)
    .eq("id", id)
    .eq("buyer_id", buyerId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Customer automation was not found for this buyer.");
  return data;
}

async function fulfillPaidSession(adminClient: any, topup: any, session: Stripe.Checkout.Session) {
  if (cleanString(session.metadata?.checkout_kind) !== "usage_topup") {
    throw new Error("This Stripe session is not a Nexus usage top-up.");
  }
  if (cleanString(session.metadata?.usage_topup_id) !== cleanString(topup.id)) {
    throw new Error("Stripe top-up identity does not match.");
  }
  if (session.payment_status !== "paid") {
    return { ok: false, status: "pending", error: "Stripe is still confirming this payment." };
  }
  const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : "";
  const { data, error } = await adminClient.rpc("fulfill_customer_automation_usage_topup", {
    p_topup_id: topup.id,
    p_stripe_checkout_session_id: session.id,
    p_stripe_payment_intent_id: paymentIntentId || null,
  });
  if (error) throw new Error(error.message);
  return data || { ok: false, status: "unknown" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
      return errorResponse("Usage top-up checkout is not configured.", 500);
    }
    const auth = await requireBuyer(req);
    if (!auth.user) return errorResponse(auth.error || "Login required", 401);

    const body = await req.json().catch(() => ({}));
    const action = cleanString(body.action || "create").toLowerCase();
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    if (action === "verify") {
      const sessionId = cleanString(body.session_id);
      if (!sessionId) return errorResponse("session_id is required", 400);
      const { data: topup, error } = await adminClient
        .from("automation_usage_topups")
        .select("*")
        .eq("buyer_id", auth.user.id)
        .eq("stripe_checkout_session_id", sessionId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!topup) return errorResponse("Usage top-up was not found for this buyer.", 404);
      const mode = await paymentMode(adminClient, topup.payment_environment);
      const session = await mode.client.checkout.sessions.retrieve(sessionId);
      const fulfillment = await fulfillPaidSession(adminClient, topup, session);
      return jsonResponse({ ok: fulfillment?.ok === true, fulfillment }, fulfillment?.ok === true ? 200 : 202);
    }

    if (action !== "create") return errorResponse("Unknown usage checkout action.", 400);
    const customerAutomationId = cleanString(body.customer_automation_id);
    if (!customerAutomationId) return errorResponse("customer_automation_id is required", 400);

    const customerAutomation = await loadOwnedAutomation(adminClient, customerAutomationId, auth.user.id);
    const product = one(customerAutomation.automations) || {};
    const order = one(customerAutomation.orders) || {};
    const purchaseError = activePurchase(customerAutomation, product, order);
    if (purchaseError) return errorResponse(purchaseError, 409);

    const units = Math.max(0, Math.floor(Number(product.webhook_topup_runs || 0)));
    const amount = Number(product.webhook_topup_price || 0);
    const currency = cleanString(product.currency || "USD").toLowerCase();
    if (!units || !Number.isFinite(amount) || amount <= 0) {
      return errorResponse("This product does not offer an additional-run pack.", 409);
    }
    if (!SUPPORTED_CURRENCIES.has(currency)) return errorResponse("Top-up currency is not supported.", 409);

    const { data: entitlement, error: entitlementError } = await adminClient.rpc(
      "ensure_customer_automation_usage_entitlement",
      { p_customer_automation_id: customerAutomation.id },
    );
    if (entitlementError) throw new Error(entitlementError.message);
    if (!entitlement?.ok) return errorResponse(entitlement?.error || "Usage entitlement is not active.", 409);

    const mode = await paymentMode(adminClient);
    const { data: topup, error: topupError } = await adminClient
      .from("automation_usage_topups")
      .insert({
        customer_automation_id: customerAutomation.id,
        buyer_id: auth.user.id,
        automation_id: product.id,
        order_id: order.id,
        entitlement_id: entitlement.entitlement_id,
        units,
        amount,
        currency: currency.toUpperCase(),
        payment_environment: mode.environment,
        status: "pending",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .select("*")
      .single();
    if (topupError || !topup) throw new Error(topupError?.message || "Could not create the usage top-up.");

    const metadata = {
      checkout_kind: "usage_topup",
      usage_topup_id: topup.id,
      customer_automation_id: customerAutomation.id,
      buyer_id: auth.user.id,
      automation_id: product.id,
      order_id: order.id,
      units: String(units),
      payment_environment: mode.environment,
    };

    let session: Stripe.Checkout.Session;
    try {
      session = await mode.client.checkout.sessions.create({
        mode: "payment",
        client_reference_id: auth.user.id,
        customer_email: cleanString(order.buyer_email || auth.user.email) || undefined,
        line_items: [{
          quantity: 1,
          price_data: {
            currency,
            unit_amount: unitAmount(amount, currency),
            product_data: {
              name: `${product.title || "Nexus automation"} - ${units} additional runs`,
              description: `Valid through the current subscription billing period ending ${entitlement.period_end}.`,
              metadata: { automation_id: product.id, usage_topup_id: topup.id },
            },
          },
        }],
        metadata,
        payment_intent_data: { metadata },
        success_url: `${SITE_URL}/pages/buyer/webhook-setup.html?id=${encodeURIComponent(customerAutomation.id)}&topup=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${SITE_URL}/pages/buyer/webhook-setup.html?id=${encodeURIComponent(customerAutomation.id)}&topup=cancelled`,
      });
    } catch (error) {
      await adminClient.from("automation_usage_topups").update({ status: "failed", updated_at: new Date().toISOString() }).eq("id", topup.id);
      throw error;
    }

    const { error: sessionSaveError } = await adminClient
      .from("automation_usage_topups")
      .update({ stripe_checkout_session_id: session.id, updated_at: new Date().toISOString() })
      .eq("id", topup.id)
      .eq("buyer_id", auth.user.id);
    if (sessionSaveError) {
      try { await mode.client.checkout.sessions.expire(session.id); } catch { /* best effort */ }
      throw new Error(`Could not save the Stripe top-up session: ${sessionSaveError.message}`);
    }

    return jsonResponse({
      ok: true,
      checkout_url: session.url,
      session_id: session.id,
      topup_id: topup.id,
      units,
      amount,
      currency: currency.toUpperCase(),
      payment_environment: mode.environment,
    });
  } catch (error) {
    console.error("create-usage-topup-checkout failed:", error);
    return errorResponse(error instanceof Error ? error.message : "Could not create usage top-up checkout.", 500);
  }
});
