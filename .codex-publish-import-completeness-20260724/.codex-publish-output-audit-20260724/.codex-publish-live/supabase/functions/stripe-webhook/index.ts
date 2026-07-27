import Stripe from "https://esm.sh/stripe@14.25.0?target=deno";
import { createClient } from "npm:@supabase/supabase-js@2";
import { safeEnqueueEmail } from "../_shared/nexus-email.ts";

function createStripeClient(secretKey: string) {
  return new Stripe(secretKey || "", {
    apiVersion: "2024-06-20",
  });
}

const liveStripe = createStripeClient(Deno.env.get("STRIPE_SECRET_KEY") || "");
const testStripe = createStripeClient(Deno.env.get("STRIPE_TEST_SECRET_KEY") || Deno.env.get("STRIPE_SECRET_KEY") || "");

const cryptoProvider = Stripe.createSubtleCryptoProvider();

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";
const STRIPE_TEST_WEBHOOK_SECRET = Deno.env.get("STRIPE_TEST_WEBHOOK_SECRET") || "";

async function constructStripeWebhookEvent(body: string, signature: string) {
  const candidates: Array<{ name: "live" | "test"; secret: string }> = [];

  if (STRIPE_WEBHOOK_SECRET) {
    candidates.push({ name: "live", secret: STRIPE_WEBHOOK_SECRET });
  }

  if (STRIPE_TEST_WEBHOOK_SECRET) {
    candidates.push({ name: "test", secret: STRIPE_TEST_WEBHOOK_SECRET });
  }

  const errors: string[] = [];

  for (const candidate of candidates) {
    try {
      const client = candidate.name === "test" ? testStripe : liveStripe;
      const event = await client.webhooks.constructEventAsync(
        body,
        signature,
        candidate.secret,
        undefined,
        cryptoProvider,
      );

      return {
        event,
        stripeClient: event.livemode ? liveStripe : testStripe,
        environment: event.livemode ? "live" : "test",
      };
    } catch (error) {
      errors.push(`${candidate.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(errors.join(" | ") || "Stripe webhook secret is not configured.");
}

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function nowIso() {
  return new Date().toISOString();
}

function cleanString(value: unknown) {
  return String(value ?? "").trim();
}

function bundleSnapshot(order: any) {
  const value = order?.bundle_snapshot;
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return {};

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function hasStrictBundleSelection(order: any) {
  return Number(bundleSnapshot(order)?.selection_version || 0) >= 1;
}

function fromUnix(value: unknown) {
  const seconds = Number(value || 0);
  return seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

function one(value: any) {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function pickFirstString(...values: unknown[]) {
  for (const value of values) {
    const cleaned = cleanString(value);
    if (cleaned) return cleaned;
  }

  return "";
}

function normalizeProductRunFrequency(product: any, isSubscription: boolean) {
  const mode = cleanString(product?.runtime_trigger_mode).toLowerCase();
  const frequency = cleanString(product?.runtime_run_frequency).toLowerCase();
  const allowed = new Set([
    "manual",
    "on_demand",
    "every_30_minutes",
    "hourly",
    "daily",
    "weekly",
    "monthly",
  ]);

  if (!mode || mode === "legacy") return isSubscription ? "monthly" : "manual";
  if (mode === "manual" || mode === "setup_complete") return "manual";
  if (mode === "on_demand") return "on_demand";
  if (mode === "subscription_monthly") return "monthly";
  if (mode === "scheduled_interval") return allowed.has(frequency) && !["manual", "on_demand"].includes(frequency)
    ? frequency
    : "daily";

  return isSubscription ? "monthly" : "manual";
}

function normalizeRuntimeTriggerMode(product: any, isSubscription: boolean) {
  const mode = cleanString(product?.runtime_trigger_mode).toLowerCase();
  if (["setup_complete", "on_demand", "scheduled_interval", "subscription_monthly", "manual"].includes(mode)) {
    return mode;
  }

  return isSubscription ? "subscription_monthly" : "setup_complete";
}

function normalizeRuntimeNoChangePolicy(product: any) {
  const policy = cleanString(product?.runtime_no_change_policy).toLowerCase();
  return ["no_output", "status_event", "empty_output"].includes(policy) ? policy : "no_output";
}

function normalizeRuntimeResponseMode(product: any) {
  const mode = cleanString(product?.runtime_response_mode).toLowerCase();
  return ["dashboard_output", "instant_message", "alert_only", "webhook_ack"].includes(mode)
    ? mode
    : "dashboard_output";
}

function roundMoney(value: number) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function stripeAmountToMajor(value: unknown) {
  return roundMoney(Number(value || 0) / 100);
}

async function loadDeveloperEmailRecipient(developerId: string) {
  if (!developerId) return null;

  const { data: developer, error: developerError } = await adminClient
    .from("developers")
    .select("id, display_name, profile_id")
    .eq("id", developerId)
    .maybeSingle();

  if (developerError || !developer?.profile_id) {
    if (developerError) console.warn("Could not load developer recipient:", developerError.message);
    return null;
  }

  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("email, full_name")
    .eq("id", developer.profile_id)
    .maybeSingle();

  if (profileError || !profile?.email) {
    if (profileError) console.warn("Could not load developer profile recipient:", profileError.message);
    return null;
  }

  return {
    email: profile.email,
    name: developer.display_name || profile.full_name || "Developer",
  };
}

function isMissingWalletSchemaError(error: any) {
  const message = [
    error?.message,
    error?.details,
    error?.hint,
    error?.code,
  ].filter(Boolean).join(" ");

  return /developer_earnings|developer_payout_requests|platform_net_amount|payout_request|created_at|requested_at|earnings_ids|source_id|schema cache|relation .* does not exist|could not find .* column/i.test(message);
}

function addMonths(date: Date, months: number) {
  const next = new Date(date.getTime());
  const day = next.getUTCDate();

  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + months);

  const lastDay = new Date(
    Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
  ).getUTCDate();

  next.setUTCDate(Math.min(day, lastDay));
  return next;
}

function subscriptionIsActiveStatus(status: string) {
  const value = cleanString(status).toLowerCase();
  return value === "active" || value === "trialing";
}

function subscriptionCancellationRequested(order: any) {
  return order?.stripe_cancel_at_period_end === true ||
    cleanString(order?.stripe_cancel_at_period_end).toLowerCase() === "true";
}

function getRuntimeWebhookUrl(customerAutomation: any, automationProduct: any, order: any) {
  return pickFirstString(
    customerAutomation?.runtime_webhook_url,
    customerAutomation?.n8n_webhook_url,
    automationProduct?.runtime_webhook_url,
    automationProduct?.n8n_webhook_url,
    order?.runtime_webhook_url,
    order?.n8n_webhook_url,
  );
}

function setupIsReady(customerAutomation: any) {
  const setupStatus = cleanString(customerAutomation?.setup_status).toLowerCase();
  const status = cleanString(customerAutomation?.status).toLowerCase();

  return (
    setupStatus === "submitted" ||
    setupStatus === "completed" ||
    setupStatus.includes("submitted") ||
    setupStatus.includes("complete") ||
    status === "active"
  );
}

function getInvoicePeriod(invoice: Stripe.Invoice) {
  const line = one((invoice as any).lines?.data);

  return {
    start: fromUnix(line?.period?.start),
    end: fromUnix(line?.period?.end),
  };
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

async function getSubscriptionSnapshot(subscriptionId: string, stripeClient = liveStripe) {
  if (!subscriptionId) {
    return {
      status: "",
      current_period_start: null,
      current_period_end: null,
      cancel_at_period_end: false,
    };
  }

  try {
    const subscription = await stripeClient.subscriptions.retrieve(subscriptionId);

    return {
      status: cleanString(subscription.status),
      current_period_start: fromUnix((subscription as any).current_period_start),
      current_period_end: fromUnix((subscription as any).current_period_end),
      cancel_at_period_end: Boolean((subscription as any).cancel_at_period_end),
    };
  } catch (error) {
    console.warn("Could not retrieve Stripe subscription:", error);

    return {
      status: "",
      current_period_start: null,
      current_period_end: null,
      cancel_at_period_end: false,
    };
  }
}

async function safeUpdateOrder(orderId: string, payload: Record<string, unknown>) {
  const { error } = await adminClient
    .from("orders")
    .update(payload)
    .eq("id", orderId);

  if (!error) return;

  const fallback = { ...payload };
  for (const key of [
    "stripe_subscription_status",
    "stripe_current_period_start",
    "stripe_current_period_end",
    "stripe_cancel_at_period_end",
    "last_invoice_paid_at",
    "stripe_fee_amount",
    "net_amount",
    "platform_fee_amount",
    "platform_net_amount",
    "developer_earning_amount",
    "revenue_share_status",
  ]) {
    delete fallback[key];
  }

  const { error: fallbackError } = await adminClient
    .from("orders")
    .update(fallback)
    .eq("id", orderId);

  if (fallbackError) {
    throw new Error(fallbackError.message || error.message);
  }
}

async function safeUpdateCustomerAutomationsByOrder(orderId: string, payload: Record<string, unknown>) {
  const { error } = await adminClient
    .from("customer_automations")
    .update(payload)
    .eq("order_id", orderId);

  if (!error) return;

  const fallback = { ...payload };
  for (const key of [
    "run_frequency",
    "runtime_trigger_mode",
    "runtime_no_change_policy",
    "runtime_response_mode",
    "schedule_status",
    "schedule_anchor_at",
    "next_run_at",
    "last_run_at",
    "last_run_requested_at",
  ]) {
    delete fallback[key];
  }

  await adminClient
    .from("customer_automations")
    .update(fallback)
    .eq("order_id", orderId);
}

async function safeInsertCustomerAutomation(payload: Record<string, unknown>) {
  let result = await adminClient
    .from("customer_automations")
    .insert(payload)
    .select()
    .single();

  if (!result.error) return result;

  const fallback = { ...payload };
  for (const key of [
    "run_frequency",
    "runtime_trigger_mode",
    "runtime_no_change_policy",
    "runtime_response_mode",
    "schedule_status",
    "schedule_anchor_at",
    "next_run_at",
    "last_run_at",
    "last_run_requested_at",
  ]) {
    delete fallback[key];
  }

  result = await adminClient
    .from("customer_automations")
    .insert(fallback)
    .select()
    .single();

  return result;
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
      runtime_trigger_mode,
      runtime_run_frequency,
      runtime_no_change_policy,
      runtime_response_mode,
      runtime_webhook_url,
      runtime_webhook_path,
      runtime_output_mode,
      n8n_workflow_id,
      n8n_workflow_name,
      n8n_webhook_url,
      setup_schema,
      credential_schema,
      developers(handle, display_name)
    `)
    .eq("id", automationId)
    .maybeSingle();

  if (error) {
    console.warn("Could not load automation product:", error.message);
    return null;
  }

  return data;
}

async function getStripeFeeSnapshot(paymentIntentId = "", stripeClient = liveStripe) {
  if (!paymentIntentId) {
    return {
      stripeFeeAmount: 0,
      chargeId: "",
      balanceTransactionId: "",
    };
  }

  try {
    const paymentIntent = await stripeClient.paymentIntents.retrieve(paymentIntentId, {
      expand: ["latest_charge.balance_transaction"],
    });

    const charge: any = paymentIntent.latest_charge;
    const balanceTransaction: any = charge?.balance_transaction;

    return {
      stripeFeeAmount: stripeAmountToMajor(balanceTransaction?.fee || 0),
      chargeId: cleanString(charge?.id),
      balanceTransactionId: cleanString(balanceTransaction?.id),
    };
  } catch (error) {
    console.warn("Could not retrieve Stripe fee snapshot:", error);

    return {
      stripeFeeAmount: 0,
      chargeId: "",
      balanceTransactionId: "",
    };
  }
}

async function getInvoicePaymentSnapshot(invoiceId = "", stripeClient = liveStripe) {
  if (!invoiceId) {
    return {
      sourceType: "subscription_invoice",
      sourceId: "",
      grossAmount: 0,
      paymentIntentId: "",
      stripeFeeAmount: undefined as number | undefined,
    };
  }

  try {
    const invoice: any = await stripeClient.invoices.retrieve(invoiceId, {
      expand: ["payment_intent"],
    });
    const paymentIntent: any = invoice.payment_intent;

    return {
      sourceType: "subscription_invoice",
      sourceId: cleanString(invoice.id),
      grossAmount: stripeAmountToMajor(invoice.amount_paid || 0),
      paymentIntentId: typeof paymentIntent === "string" ? paymentIntent : cleanString(paymentIntent?.id),
      stripeFeeAmount: undefined as number | undefined,
    };
  } catch (error) {
    console.warn("Could not retrieve subscription invoice snapshot:", error);

    return {
      sourceType: "subscription_invoice",
      sourceId: invoiceId,
      grossAmount: 0,
      paymentIntentId: "",
      stripeFeeAmount: undefined as number | undefined,
    };
  }
}

async function recordDeveloperEarningForOrder(
  order: any,
  options: {
    sourceType: string;
    sourceId: string;
    grossAmount?: number;
    paymentIntentId?: string;
    stripeFeeAmount?: number;
    stripeClient?: Stripe;
    metadata?: Record<string, unknown>;
  },
) {
  const sourceId = cleanString(options.sourceId);
  if (!sourceId) return;

  const automationProduct = await getAutomationProduct(order.automation_id);
  const developer = one(automationProduct?.developers);
  const developerHandle = cleanString(developer?.handle).toLowerCase();
  const developerId = cleanString(order.developer_id || automationProduct?.developer_id);
  const currency = cleanString(order.currency || order.stripe_currency || "THB").toUpperCase();
  const feeSnapshot = options.stripeFeeAmount !== undefined
    ? {
        stripeFeeAmount: Number(options.stripeFeeAmount || 0),
        chargeId: "",
        balanceTransactionId: "",
      }
    : await getStripeFeeSnapshot(
        options.paymentIntentId || cleanString(order.stripe_payment_intent_id),
        options.stripeClient || liveStripe,
      );

  const grossAmount = roundMoney(
    Number(options.grossAmount || 0) ||
      Number(order.stripe_amount_total || 0) ||
      Number(order.price || 0),
  );
  const stripeFeeAmount = roundMoney(feeSnapshot.stripeFeeAmount || 0);
  const netAmount = roundMoney(Math.max(0, grossAmount - stripeFeeAmount));

  if (!developerId || developerHandle === "nexus-internal") {
    await safeUpdateOrder(order.id, {
      stripe_fee_amount: stripeFeeAmount,
      net_amount: netAmount,
      platform_fee_amount: grossAmount,
      platform_net_amount: netAmount,
      developer_earning_amount: 0,
      revenue_share_status: "nexus_internal",
      updated_at: nowIso(),
    });
    return;
  }

  const platformFeeAmount = roundMoney(grossAmount * 0.2);
  const developerAmount = roundMoney(grossAmount * 0.8);
  const platformNetAmount = roundMoney(platformFeeAmount - stripeFeeAmount);

  const orderFinancialPatch = {
    stripe_fee_amount: stripeFeeAmount,
    net_amount: netAmount,
    platform_fee_amount: platformFeeAmount,
    platform_net_amount: platformNetAmount,
    developer_earning_amount: developerAmount,
    updated_at: nowIso(),
  };

  const { data: existing, error: existingError } = await adminClient
    .from("developer_earnings")
    .select("id")
    .eq("source_type", options.sourceType)
    .eq("source_id", sourceId)
    .maybeSingle();

  if (existingError) {
    if (isMissingWalletSchemaError(existingError)) {
      await safeUpdateOrder(order.id, {
        ...orderFinancialPatch,
        revenue_share_status: "wallet_schema_missing",
      });
      console.warn("Developer wallet schema missing. Run manual_payouts_install_or_patch.sql.");
      return;
    }

    console.warn("Could not check existing developer earning:", existingError.message);
    return;
  }

  if (existing?.id) {
    await safeUpdateOrder(order.id, {
      ...orderFinancialPatch,
      revenue_share_status: "allocated",
    });
    return;
  }

  const { error } = await adminClient
    .from("developer_earnings")
    .insert({
      developer_id: developerId,
      automation_id: order.automation_id || automationProduct?.id || null,
      order_id: order.id,
      source_type: options.sourceType,
      source_id: sourceId,
      currency,
      gross_amount: grossAmount,
      stripe_fee_amount: stripeFeeAmount,
      net_amount: netAmount,
      platform_fee_amount: platformFeeAmount,
      platform_net_amount: platformNetAmount,
      developer_amount: developerAmount,
      platform_fee_bps: 2000,
      developer_share_bps: 8000,
      status: "available",
      transfer_status: "available",
      payout_status: "available",
      stripe_payment_intent_id: cleanString(options.paymentIntentId || order.stripe_payment_intent_id),
      stripe_charge_id: feeSnapshot.chargeId,
      stripe_balance_transaction_id: feeSnapshot.balanceTransactionId,
      metadata: {
        source: "stripe_webhook_manual_payout",
        automation_title: order.automation_title || automationProduct?.title || "",
        buyer_email: order.buyer_email || "",
        ...options.metadata,
      },
      created_at: nowIso(),
      updated_at: nowIso(),
    });

  if (error) {
    if (isMissingWalletSchemaError(error)) {
      await safeUpdateOrder(order.id, {
        ...orderFinancialPatch,
        revenue_share_status: "wallet_schema_missing",
      });
      console.warn("Developer wallet schema missing. Run manual_payouts_install_or_patch.sql.");
      return;
    }

    console.warn("Could not create developer earning:", error.message);
    return;
  }

  await safeUpdateOrder(order.id, {
    ...orderFinancialPatch,
    revenue_share_status: "allocated",
  });

  const developerRecipient = await loadDeveloperEmailRecipient(developerId);
  if (developerRecipient) {
    await safeEnqueueEmail(
      adminClient,
      "developer_order_received",
      developerRecipient,
      {
        product_title: order.automation_title || automationProduct?.title || "Automation product",
        buyer_email: order.buyer_email || "",
        developer_amount: developerAmount,
        currency,
        dashboard_url: "/pages/developer/dashboard.html#wallet",
      },
      {
        dedupeKey: `developer_order_received:${order.id}:${developerId}`,
      },
    );
  }
}

async function markDeveloperEarningForCharge(
  charge: Stripe.Charge,
  nextStatus: "refunded" | "disputed",
) {
  const chargeId = cleanString(charge.id);
  const paymentIntentId = typeof charge.payment_intent === "string"
    ? charge.payment_intent
    : "";

  let result = chargeId
    ? await adminClient
      .from("developer_earnings")
      .select("*")
      .eq("stripe_charge_id", chargeId)
      .maybeSingle()
    : { data: null, error: null };

  if (!result.data && paymentIntentId) {
    result = await adminClient
      .from("developer_earnings")
      .select("*")
      .eq("stripe_payment_intent_id", paymentIntentId)
      .maybeSingle();
  }

  if (result.error || !result.data) {
    if (result.error && !isMissingWalletSchemaError(result.error)) {
      console.warn("Could not load earning for charge update:", result.error.message);
    }
    return;
  }

  const wasPaid = cleanString(result.data.payout_status).toLowerCase() === "paid";
  const payoutStatus = wasPaid ? `${nextStatus}_after_payout` : nextStatus;

  await adminClient
    .from("developer_earnings")
    .update({
      status: payoutStatus,
      transfer_status: payoutStatus,
      payout_status: payoutStatus,
      metadata: {
        ...(result.data.metadata || {}),
        last_finance_event: nextStatus,
        stripe_charge_id: chargeId,
        stripe_payment_intent_id: paymentIntentId,
        updated_by: "stripe_webhook",
      },
      updated_at: nowIso(),
    })
    .eq("id", result.data.id);

  if (result.data.order_id) {
    await safeUpdateOrder(result.data.order_id, {
      revenue_share_status: payoutStatus,
      updated_at: nowIso(),
    });
  }
}

async function activateScheduleIfReady(order: any, subscriptionStatus = "") {
  const status = cleanString(subscriptionStatus || order?.stripe_subscription_status).toLowerCase();

  if (subscriptionCancellationRequested(order)) {
    await safeUpdateCustomerAutomationsByOrder(order.id, {
      schedule_status: "cancelled",
      next_run_at: null,
      updated_at: nowIso(),
    });
    return;
  }

  if (!subscriptionIsActiveStatus(status) && status) {
    await safeUpdateCustomerAutomationsByOrder(order.id, {
      schedule_status: "paused",
      next_run_at: null,
      updated_at: nowIso(),
    });
    return;
  }

  const { data: customerAutomations, error } = await adminClient
    .from("customer_automations")
    .select("*, automations(*)")
    .eq("order_id", order.id);

  if (error) {
    console.warn("Could not load customer automations for schedule activation:", error.message);
    return;
  }

  for (const customerAutomation of customerAutomations || []) {
    const automationProduct = one(customerAutomation.automations) || {};
    const webhookUrl = getRuntimeWebhookUrl(customerAutomation, automationProduct, order);
    const runFrequency = normalizeProductRunFrequency(automationProduct, true);
    const ready = setupIsReady(customerAutomation) && Boolean(webhookUrl);

    await adminClient
      .from("customer_automations")
      .update({
        run_frequency: runFrequency,
        schedule_status: ready ? "active" : "inactive",
        schedule_anchor_at: customerAutomation.schedule_anchor_at || null,
        next_run_at: ready ? customerAutomation.next_run_at || nowIso() : null,
        updated_at: nowIso(),
      })
      .eq("id", customerAutomation.id);
  }
}

async function deactivateSubscriptionSchedules(orderId: string, scheduleStatus: "paused" | "cancelled") {
  await safeUpdateCustomerAutomationsByOrder(orderId, {
    schedule_status: scheduleStatus,
    next_run_at: null,
    updated_at: nowIso(),
  });
}
async function loadBundleOrderProducts(order: any) {
  const { data: orderItems, error: itemError } = await adminClient
    .from("order_items")
    .select("*, automations!order_items_automation_id_fkey(*)")
    .eq("order_id", order.id)
    .eq("status", "active")
    .order("created_at", { ascending: true });

  if (!itemError && Array.isArray(orderItems) && orderItems.length) {
    return orderItems
      .map((item: any) => ({
        item,
        product: one(item.automations),
      }))
      .filter((entry: any) => entry.product?.id);
  }

  if (hasStrictBundleSelection(order)) {
    if (itemError) {
      throw new Error(`Could not load the selected workflows for this paid bundle order: ${itemError.message}`);
    }

    throw new Error("Customized bundle order has no active order items. Fulfillment stopped before any unrelated workflows could be attached.");
  }

  if (itemError) {
    console.warn("Could not load bundle order_items:", itemError.message);
  }

  const bundleId = cleanString(order.bundle_id);
  if (!bundleId) return [];

  const { data: bundleItems, error } = await adminClient
    .from("automation_bundle_items")
    .select("*, automations!automation_bundle_items_automation_id_fkey(*)")
    .eq("bundle_id", bundleId)
    .eq("status", "active")
    .order("position", { ascending: true });

  if (error) {
    console.warn("Could not load bundle items:", error.message);
    return [];
  }

  return (bundleItems || [])
    .map((item: any) => ({
      item,
      product: one(item.automations),
    }))
    .filter((entry: any) => entry.product?.id);
}

async function handlePaidBundleOrder(order: any, isPaid: boolean, isSubscription: boolean, subscriptionStatus = "") {
  if (!isPaid) return;

  const { data: existing } = await adminClient
    .from("customer_automations")
    .select("id, automation_id")
    .eq("order_id", order.id);

  const existingAutomationIds = new Set(
    (existing || [])
      .map((row: any) => cleanString(row.automation_id))
      .filter(Boolean),
  );

  const entries = await loadBundleOrderProducts(order);
  let createdCount = 0;

  for (const entry of entries) {
    const product = entry.product || {};
    if (existingAutomationIds.has(cleanString(product.id))) {
      continue;
    }

    const runtimeType = product.runtime_type || "manual";
    const runFrequency = normalizeProductRunFrequency(product, isSubscription);
    const runtimeWebhookUrl = product.runtime_webhook_url || product.n8n_webhook_url || null;
    const runtimeWebhookPath = product.runtime_webhook_path || null;

    const { data: customerAutomation, error: automationError } = await safeInsertCustomerAutomation({
      order_id: order.id,
      buyer_id: order.buyer_id,
      automation_id: product.id,
      developer_id: product.developer_id || null,
      bundle_id: order.bundle_id || null,
      name: product.title || "Bundle automation",
      status: "pending_setup",
      install_type: "self_serve",
      setup_status: "setup_required",
      runtime_type: runtimeType,
      runtime_trigger_mode: normalizeRuntimeTriggerMode(product, isSubscription),
      runtime_webhook_url: runtimeWebhookUrl,
      runtime_webhook_path: runtimeWebhookPath,
      runtime_output_mode: product.runtime_output_mode || "standard",
      runtime_no_change_policy: normalizeRuntimeNoChangePolicy(product),
      runtime_response_mode: normalizeRuntimeResponseMode(product),
      n8n_workflow_id: product.n8n_workflow_id || null,
      n8n_workflow_name: product.n8n_workflow_name || null,
      runtime_status: "not_started",
      run_frequency: runFrequency,
      schedule_status: "inactive",
      schedule_anchor_at: null,
      next_run_at: null,
      health_status: "not_configured",
      failure_count: 0,
      last_error_message: null,
      created_at: nowIso(),
      updated_at: nowIso(),
    });

    if (automationError) {
      console.error("Could not create bundle customer automation:", automationError.message);
      continue;
    }

    if (!customerAutomation) continue;
    createdCount += 1;

    await adminClient.from("automation_events").insert({
      customer_automation_id: customerAutomation.id,
      buyer_id: order.buyer_id,
      automation_id: product.id,
      order_id: order.id,
      event_type: "bundle_payment_completed",
      title: "Bundle workflow unlocked",
      message: `${product.title || "This workflow"} is included in ${order.automation_title || "your bundle"}. Complete setup to start it.`,
      created_by: "system",
      created_at: nowIso(),
    });
  }

  if (isSubscription) {
    await activateBundleSchedulesIfReady(
      { ...order, stripe_subscription_status: subscriptionStatus || "active" },
      subscriptionStatus || "active",
    );
  }

  if (!createdCount) return;

  await adminClient.from("admin_notifications").insert({
    notification_type: "paid_bundle_order",
    title: "New paid bundle order",
    message: `${order.buyer_name || order.buyer_email || "A buyer"} purchased ${order.automation_title || "a bundle"}.`,
    related_order_id: order.id,
    status: "unread",
    created_at: nowIso(),
  });

  await safeEnqueueEmail(
    adminClient,
    "bundle_payment_received",
    { email: order.buyer_email, name: order.buyer_name },
    {
      bundle_title: order.automation_title || "Automation bundle",
      order_id: order.id,
      dashboard_url: "/pages/buyer/dashboard.html#automations",
    },
    {
      dedupeKey: `bundle_payment_received:${order.id}`,
    },
  );
}

async function activateBundleSchedulesIfReady(order: any, subscriptionStatus = "") {
  const status = cleanString(subscriptionStatus || order?.stripe_subscription_status).toLowerCase();

  if (subscriptionCancellationRequested(order)) {
    await deactivateSubscriptionSchedules(order.id, "cancelled");
    return;
  }

  if (!subscriptionIsActiveStatus(status) && status) {
    await deactivateSubscriptionSchedules(order.id, "paused");
    return;
  }

  const { data: rows, error } = await adminClient
    .from("customer_automations")
    .select(`
      *,
      automations(
        runtime_webhook_url,
        n8n_webhook_url,
        runtime_trigger_mode,
        runtime_run_frequency,
        runtime_no_change_policy,
        runtime_response_mode
      )
    `)
    .eq("order_id", order.id);

  if (error) {
    console.warn("Could not load bundle customer automations:", error.message);
    return;
  }

  for (const customerAutomation of rows || []) {
    const automationProduct = one(customerAutomation.automations) || {};
    const webhookUrl = getRuntimeWebhookUrl(customerAutomation, automationProduct, order);
    const ready = setupIsReady(customerAutomation) && Boolean(webhookUrl);
    const runFrequency = normalizeProductRunFrequency(automationProduct, true);

    await adminClient
      .from("customer_automations")
      .update({
        runtime_trigger_mode: normalizeRuntimeTriggerMode(automationProduct, true),
        runtime_no_change_policy: normalizeRuntimeNoChangePolicy(automationProduct),
        runtime_response_mode: normalizeRuntimeResponseMode(automationProduct),
        run_frequency: runFrequency,
        schedule_status: ready ? "active" : "inactive",
        schedule_anchor_at: customerAutomation.schedule_anchor_at || null,
        next_run_at: ready ? customerAutomation.next_run_at || nowIso() : null,
        updated_at: nowIso(),
      })
      .eq("id", customerAutomation.id);
  }
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session, stripeClient = liveStripe) {
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

  const isSubscription = session.mode === "subscription";
  const isPaid = session.payment_status === "paid" || isSubscription;
  const isTestPayment = cleanString(order.payment_environment).toLowerCase() === "test" || session.livemode === false;

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

  const subscriptionSnapshot = isSubscription
    ? await getSubscriptionSnapshot(stripeSubscriptionId, stripeClient)
    : {
        status: "",
        current_period_start: null,
        current_period_end: null,
        cancel_at_period_end: false,
      };

  await safeUpdateOrder(order.id, {
    payment_status: isPaid ? "paid" : "pending",
    order_status: isPaid ? "setup_requested" : "checkout_started",
    stripe_payment_status: session.payment_status,
    stripe_customer_id: stripeCustomerId,
    stripe_payment_intent_id: stripePaymentIntentId,
    stripe_subscription_id: stripeSubscriptionId,
    stripe_subscription_status: subscriptionSnapshot.status || (isSubscription ? "active" : null),
    stripe_current_period_start: subscriptionSnapshot.current_period_start,
    stripe_current_period_end: subscriptionSnapshot.current_period_end,
    stripe_cancel_at_period_end: subscriptionSnapshot.cancel_at_period_end,
    paid_at: isPaid ? nowIso() : null,
    updated_at: nowIso(),
  });

  if (order.order_type === "bundle" || order.bundle_id) {
    await handlePaidBundleOrder(
      {
        ...order,
        payment_status: isPaid ? "paid" : "pending",
        stripe_subscription_status: subscriptionSnapshot.status || (isSubscription ? "active" : ""),
        stripe_cancel_at_period_end: subscriptionSnapshot.cancel_at_period_end,
      },
      isPaid,
      isSubscription,
      subscriptionSnapshot.status || "active",
    );
    return;
  }

  if (!isSubscription && isPaid && !isTestPayment) {
    await recordDeveloperEarningForOrder(
      {
        ...order,
        payment_status: "paid",
        stripe_payment_intent_id: stripePaymentIntentId,
        stripe_customer_id: stripeCustomerId,
      },
      {
        sourceType: "order_payment",
        sourceId: stripePaymentIntentId || session.id,
        grossAmount: stripeAmountToMajor(session.amount_total || 0) || Number(order.stripe_amount_total || 0),
        paymentIntentId: stripePaymentIntentId,
        stripeClient,
        metadata: {
          checkout_session_id: session.id,
        },
      },
    );
  }

  if (isSubscription && isPaid && !isTestPayment) {
    const invoiceId = typeof (session as any).invoice === "string" ? (session as any).invoice : "";
    const invoiceSnapshot = await getInvoicePaymentSnapshot(invoiceId, stripeClient);

    await recordDeveloperEarningForOrder(
      {
        ...order,
        payment_status: "paid",
        stripe_subscription_id: stripeSubscriptionId,
        stripe_payment_intent_id: invoiceSnapshot.paymentIntentId || stripePaymentIntentId,
        stripe_customer_id: stripeCustomerId,
      },
      {
        sourceType: invoiceSnapshot.sourceType,
        sourceId: invoiceSnapshot.sourceId || stripeSubscriptionId || session.id,
        grossAmount:
          invoiceSnapshot.grossAmount ||
          stripeAmountToMajor(session.amount_total || 0) ||
          Number(order.stripe_amount_total || 0),
        paymentIntentId: invoiceSnapshot.paymentIntentId || stripePaymentIntentId,
        stripeFeeAmount: invoiceSnapshot.stripeFeeAmount,
        stripeClient,
        metadata: {
          checkout_session_id: session.id,
          stripe_invoice_id: invoiceId,
          stripe_subscription_id: stripeSubscriptionId,
        },
      },
    );
  }

  const { data: existingCustomerAutomation } = await adminClient
    .from("customer_automations")
    .select("id")
    .eq("order_id", order.id)
    .maybeSingle();

  if (existingCustomerAutomation || !isPaid) {
    if (isSubscription) {
      await activateScheduleIfReady(
        {
          ...order,
          stripe_subscription_status: subscriptionSnapshot.status || "active",
          stripe_cancel_at_period_end: subscriptionSnapshot.cancel_at_period_end,
        },
        subscriptionSnapshot.status || "active",
      );
    }

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
  const runFrequency = normalizeProductRunFrequency(automationProduct, isSubscription);

  const { data: customerAutomation, error: automationError } = await safeInsertCustomerAutomation({
    order_id: order.id,
    buyer_id: order.buyer_id,
    automation_id: order.automation_id,
    developer_id: order.developer_id || automationProduct?.developer_id || null,

    name: order.automation_title || automationProduct?.title || "Automation",

    status: "pending_setup",
    install_type: order.install_type || "self_serve",
    setup_status: "setup_required",

    runtime_type: runtimeType,
    runtime_trigger_mode: normalizeRuntimeTriggerMode(automationProduct, isSubscription),
    runtime_webhook_url: runtimeWebhookUrl,
    runtime_webhook_path: runtimeWebhookPath,
    runtime_output_mode: automationProduct?.runtime_output_mode || "standard",
    runtime_no_change_policy: normalizeRuntimeNoChangePolicy(automationProduct),
    runtime_response_mode: normalizeRuntimeResponseMode(automationProduct),
    n8n_workflow_id: n8nWorkflowId,
    n8n_workflow_name: n8nWorkflowName,
    runtime_status: "not_started",

    run_frequency: runFrequency,
    schedule_status: "inactive",
    schedule_anchor_at: null,
    next_run_at: null,

    health_status: "not_configured",
    failure_count: 0,
    last_error_message: null,

    created_at: nowIso(),
    updated_at: nowIso(),
  });

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

  await safeEnqueueEmail(
    adminClient,
    "order_payment_received",
    { email: order.buyer_email, name: order.buyer_name },
    {
      product_title: order.automation_title || automationProduct?.title || "Automation",
      order_id: order.id,
      dashboard_url: "/pages/buyer/dashboard.html#automations",
    },
    {
      dedupeKey: `order_payment_received:${order.id}`,
    },
  );
}

async function handleCheckoutExpired(session: Stripe.Checkout.Session) {
  const orderId = session.metadata?.order_id;

  if (!orderId) return;

  await safeUpdateOrder(orderId, {
    payment_status: "expired",
    order_status: "checkout_expired",
    updated_at: nowIso(),
  });
}

async function handleInvoicePaid(invoice: Stripe.Invoice, stripeClient = liveStripe) {
  const subscriptionId =
    typeof (invoice as any).subscription === "string" ? (invoice as any).subscription : "";

  if (!subscriptionId) return;

  const period = getInvoicePeriod(invoice);
  const subscriptionSnapshot = await getSubscriptionSnapshot(subscriptionId, stripeClient);

  const { data: order } = await adminClient
    .from("orders")
    .select("*")
    .eq("stripe_subscription_id", subscriptionId)
    .maybeSingle();

  if (!order) return;
  const isTestPayment = cleanString(order.payment_environment).toLowerCase() === "test" || invoice.livemode === false;

  await safeUpdateOrder(order.id, {
    payment_status: "paid",
    order_status: order.order_status === "payment_failed"
      ? "setup_requested"
      : order.order_status || "setup_requested",
    stripe_subscription_status: subscriptionSnapshot.status || "active",
    stripe_current_period_start: subscriptionSnapshot.current_period_start || period.start,
    stripe_current_period_end: subscriptionSnapshot.current_period_end || period.end,
    stripe_cancel_at_period_end: subscriptionSnapshot.cancel_at_period_end,
    last_invoice_paid_at: nowIso(),
    updated_at: nowIso(),
  });

  if (order.order_type === "bundle" || order.bundle_id) {
    await activateBundleSchedulesIfReady(
      {
        ...order,
        payment_status: "paid",
        stripe_subscription_status: subscriptionSnapshot.status || "active",
        stripe_cancel_at_period_end: subscriptionSnapshot.cancel_at_period_end,
      },
      subscriptionSnapshot.status || "active",
    );
    return;
  }

  const invoicePaymentIntentId =
    typeof (invoice as any).payment_intent === "string" ? (invoice as any).payment_intent : "";

  if (!isTestPayment) {
    await recordDeveloperEarningForOrder(
      {
        ...order,
        payment_status: "paid",
        stripe_subscription_status: subscriptionSnapshot.status || "active",
        stripe_payment_intent_id: invoicePaymentIntentId || order.stripe_payment_intent_id,
      },
      {
        sourceType: "subscription_invoice",
        sourceId: invoice.id,
        grossAmount: stripeAmountToMajor((invoice as any).amount_paid || 0),
        paymentIntentId: invoicePaymentIntentId,
        stripeClient,
        metadata: {
          stripe_invoice_id: invoice.id,
          stripe_subscription_id: subscriptionId,
          period_start: period.start,
          period_end: period.end,
        },
      },
    );
  }

  await activateScheduleIfReady(
    {
        ...order,
        payment_status: "paid",
        stripe_subscription_status: subscriptionSnapshot.status || "active",
        stripe_cancel_at_period_end: subscriptionSnapshot.cancel_at_period_end,
      },
    subscriptionSnapshot.status || "active",
  );
}

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice) {
  const subscriptionId =
    typeof (invoice as any).subscription === "string" ? (invoice as any).subscription : "";

  if (!subscriptionId) return;

  await adminClient
    .from("orders")
    .update({
      payment_status: "payment_failed",
      order_status: "payment_failed",
      stripe_subscription_status: "past_due",
      updated_at: nowIso(),
    })
    .eq("stripe_subscription_id", subscriptionId);

  const { data: order } = await adminClient
    .from("orders")
    .select("id, buyer_id, automation_id")
    .eq("stripe_subscription_id", subscriptionId)
    .maybeSingle();

  if (!order) return;

  await safeUpdateCustomerAutomationsByOrder(order.id, {
    status: "payment_failed",
    health_status: "payment_issue",
    schedule_status: "paused",
    next_run_at: null,
    updated_at: nowIso(),
  });
}

async function handleSubscriptionUpdated(subscription: Stripe.Subscription) {
  const subscriptionId = cleanString(subscription.id);
  if (!subscriptionId) return;

  const status = cleanString(subscription.status);
  const isActive = subscriptionIsActiveStatus(status);
  const cancelAtPeriodEnd = Boolean((subscription as any).cancel_at_period_end);

  const { data: order } = await adminClient
    .from("orders")
    .select("*")
    .eq("stripe_subscription_id", subscriptionId)
    .maybeSingle();

  if (!order) return;

  await safeUpdateOrder(order.id, {
    payment_status: isActive ? "paid" : order.payment_status || "pending",
    order_status: status === "canceled"
      ? "cancelled"
      : cancelAtPeriodEnd
        ? "cancellation_pending"
        : isActive
          ? order.order_status || "setup_requested"
          : order.order_status || status,
    stripe_subscription_status: status,
    stripe_current_period_start: fromUnix((subscription as any).current_period_start),
    stripe_current_period_end: fromUnix((subscription as any).current_period_end),
    stripe_cancel_at_period_end: cancelAtPeriodEnd,
    updated_at: nowIso(),
  });

  const scheduleOrder = {
    ...order,
    payment_status: isActive ? "paid" : order.payment_status,
    stripe_subscription_status: status,
    stripe_cancel_at_period_end: cancelAtPeriodEnd,
  };

  if (isActive && !cancelAtPeriodEnd) {
    if (order.order_type === "bundle" || order.bundle_id) {
      await activateBundleSchedulesIfReady(scheduleOrder, status);
    } else {
      await activateScheduleIfReady(scheduleOrder, status);
    }
    return;
  }

  if (cancelAtPeriodEnd || status === "canceled") {
    await safeUpdateCustomerAutomationsByOrder(order.id, {
      ...(status === "canceled" ? { status: "cancelled" } : {}),
      schedule_status: "cancelled",
      health_status: status === "canceled" ? "cancelled" : "cancellation_requested",
      next_run_at: null,
      updated_at: nowIso(),
    });
    return;
  }

  await safeUpdateCustomerAutomationsByOrder(order.id, {
    status: "payment_failed",
    schedule_status: "paused",
    health_status: "payment_issue",
    next_run_at: null,
    updated_at: nowIso(),
  });
}
async function handleSubscriptionDeleted(subscription: Stripe.Subscription) {
  const subscriptionId = cleanString(subscription.id);
  if (!subscriptionId) return;

  const { data: order } = await adminClient
    .from("orders")
    .select("*")
    .eq("stripe_subscription_id", subscriptionId)
    .maybeSingle();

  if (!order) return;

  await safeUpdateOrder(order.id, {
    payment_status: "cancelled",
    order_status: "cancelled",
    stripe_subscription_status: "canceled",
    stripe_current_period_start: fromUnix((subscription as any).current_period_start),
    stripe_current_period_end: fromUnix((subscription as any).current_period_end),
    stripe_cancel_at_period_end: Boolean((subscription as any).cancel_at_period_end),
    updated_at: nowIso(),
  });

  await safeUpdateCustomerAutomationsByOrder(order.id, {
    status: "cancelled",
    schedule_status: "cancelled",
    health_status: "cancelled",
    next_run_at: null,
    updated_at: nowIso(),
  });
}

Deno.serve(async (request) => {
  const signature = request.headers.get("Stripe-Signature");
  const body = await request.text();

  let event: Stripe.Event;
  let stripeClient = liveStripe;

  try {
    const constructed = await constructStripeWebhookEvent(body, signature || "");
    event = constructed.event;
    stripeClient = constructed.stripeClient;
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
        await handleCheckoutCompleted(session, stripeClient);
        break;
      }

      case "checkout.session.expired": {
        const session = event.data.object as Stripe.Checkout.Session;
        await handleCheckoutExpired(session);
        break;
      }

      case "invoice.paid": {
        const invoice = event.data.object as Stripe.Invoice;
        await handleInvoicePaid(invoice, stripeClient);
        break;
      }

      case "invoice.payment_failed": {
        const invoice = event.data.object as Stripe.Invoice;
        await handleInvoicePaymentFailed(invoice);
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionUpdated(subscription);
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        await handleSubscriptionDeleted(subscription);
        break;
      }

      case "charge.refunded": {
        const charge = event.data.object as Stripe.Charge;
        await markDeveloperEarningForCharge(charge, "refunded");
        break;
      }

      case "charge.dispute.created": {
        const dispute = event.data.object as Stripe.Dispute;
        const chargeId = typeof dispute.charge === "string" ? dispute.charge : "";

        if (chargeId) {
          const charge = await stripeClient.charges.retrieve(chargeId);
          await markDeveloperEarningForCharge(charge, "disputed");
        }

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
