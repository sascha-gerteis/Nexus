import Stripe from "https://esm.sh/stripe@14.25.0?target=deno";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
  apiVersion: "2024-06-20",
});

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SITE_URL = (Deno.env.get("SITE_URL") || "https://nexus-ai.software").replace(/\/$/, "");
const DEFAULT_CONNECT_COUNTRY = (Deno.env.get("STRIPE_CONNECT_DEFAULT_COUNTRY") || "TH").toUpperCase();
const WALLET_SQL_HINT = "Run supabase/manual_payouts_install_or_patch.sql in the Supabase SQL editor, then redeploy the wallet and webhook functions.";

function nowIso() {
  return new Date().toISOString();
}

function cleanString(value: unknown) {
  return String(value || "").trim();
}

function parseMoneyFromDisplay(value: unknown) {
  const raw = cleanString(value);
  if (!raw) return 0;

  const parsed = Number(raw.replace(/[^0-9.-]+/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function cleanObject(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function isMissingWalletSchemaError(error: any) {
  const message = [
    error?.message,
    error?.details,
    error?.hint,
    error?.code,
  ].filter(Boolean).join(" ");

  return /developer_earnings|developer_payout_requests|stripe_connected_account_id|stripe_connect_|developer_earning_|payout_request|payout_method|payout_details|payment_receipt|platform_net_amount|created_at|requested_at|earnings_ids|source_id|schema cache|relation .* does not exist|could not find .* column/i.test(message);
}

function isConnectNotEnabledError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /signed up for Connect|dashboard\.stripe\.com\/connect|connect account/i.test(message);
}

function userFacingError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "Unknown error.");

  if (isConnectNotEnabledError(error)) {
    return "Stripe Connect is not enabled on this Stripe account yet. Open https://dashboard.stripe.com/connect, sign up for Connect/Express, then try wallet setup again.";
  }

  if (isMissingWalletSchemaError(error)) {
    return `${message} ${WALLET_SQL_HINT}`;
  }

  if (/api key|apikey|authenticator|STRIPE_SECRET_KEY/i.test(message)) {
    return "STRIPE_SECRET_KEY is missing or invalid for the developer-stripe-account Edge Function.";
  }

  return message;
}

function userFacingStatus(error: unknown) {
  if (isConnectNotEnabledError(error)) return 409;
  return 500;
}

function requireStripeSecret() {
  if (!Deno.env.get("STRIPE_SECRET_KEY")) {
    throw new Error("STRIPE_SECRET_KEY is missing for the developer-stripe-account Edge Function.");
  }
}

function onboardingStatusFromAccount(account: Stripe.Account) {
  if (!account.details_submitted) return "onboarding_started";
  if (account.payouts_enabled) return "enabled";
  if (account.requirements?.disabled_reason) return "disabled";
  if ((account.requirements?.currently_due || []).length) return "restricted";
  return "pending";
}

function developerPatchFromAccount(account: Stripe.Account) {
  return {
    stripe_connected_account_id: account.id,
    stripe_connect_onboarding_status: onboardingStatusFromAccount(account),
    stripe_connect_country: account.country || DEFAULT_CONNECT_COUNTRY,
    stripe_connect_default_currency: account.default_currency || null,
    stripe_connect_charges_enabled: Boolean(account.charges_enabled),
    stripe_connect_payouts_enabled: Boolean(account.payouts_enabled),
    stripe_connect_details_submitted: Boolean(account.details_submitted),
    stripe_connect_requirements_currently_due: account.requirements?.currently_due || [],
    stripe_connect_requirements_disabled_reason: account.requirements?.disabled_reason || null,
    stripe_connect_last_synced_at: nowIso(),
    updated_at: nowIso(),
  };
}

async function requireUserContext(req: Request) {
  const authHeader = req.headers.get("Authorization") || "";

  if (!authHeader.startsWith("Bearer ")) {
    return { user: null, profile: null, developer: null, error: "Missing auth token." };
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  });

  const token = authHeader.replace("Bearer ", "").trim();
  const { data: userData, error: userError } = await userClient.auth.getUser(token);

  if (userError || !userData?.user) {
    return { user: null, profile: null, developer: null, error: "Invalid auth token." };
  }

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("id, email, role, full_name")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (profileError || !profile) {
    return { user: userData.user, profile: null, developer: null, error: "Profile not found." };
  }

  let developer = null;

  if (profile.role === "developer") {
    const { data, error } = await adminClient
      .from("developers")
      .select("*")
      .eq("profile_id", userData.user.id)
      .maybeSingle();

    if (error || !data) {
      return { user: userData.user, profile, developer: null, error: "Developer account not found." };
    }

    developer = data;
  }

  return { user: userData.user, profile, developer, error: null };
}

function requireDeveloper(profile: any, developer: any) {
  if (profile?.role !== "developer" || !developer) {
    return "Developer access required.";
  }

  return "";
}

function requireAdmin(profile: any) {
  if (profile?.role !== "admin") {
    return "Admin access required.";
  }

  return "";
}

async function syncDeveloperStripeAccount(adminClient: any, developer: any) {
  const accountId = cleanString(developer?.stripe_connected_account_id);

  if (!accountId) {
    return {
      developer,
      account: null,
    };
  }

  requireStripeSecret();

  const account = await stripe.accounts.retrieve(accountId);
  const patch = developerPatchFromAccount(account);

  const { data, error } = await adminClient
    .from("developers")
    .update(patch)
    .eq("id", developer.id)
    .select()
    .single();

  if (error) throw new Error(error.message);

  return {
    developer: data,
    account,
  };
}

async function ensureWeeklyPayoutSchedule(accountId: string) {
  try {
    await stripe.accounts.update(accountId, {
      settings: {
        payouts: {
          schedule: {
            interval: "weekly",
            weekly_anchor: "friday",
          },
        },
      },
    });
  } catch (error) {
    console.warn("Could not set weekly payout schedule:", error);
  }
}

async function createOrLoadConnectedAccount(adminClient: any, user: any, developer: any, country: string) {
  requireStripeSecret();

  const existingAccountId = cleanString(developer.stripe_connected_account_id);

  if (existingAccountId) {
    return await syncDeveloperStripeAccount(adminClient, developer);
  }

  const account = await stripe.accounts.create({
    type: "express",
    country: country || DEFAULT_CONNECT_COUNTRY,
    email: user.email || undefined,
    business_profile: {
      name: developer.display_name || "Nexus Developer",
      product_description: "AI automation workflow products sold through Nexus AI.",
      url: developer.website || undefined,
    },
    capabilities: {
      transfers: {
        requested: true,
      },
    },
    metadata: {
      developer_id: developer.id,
      profile_id: developer.profile_id || "",
      source: "nexus_developer_dashboard",
    },
  });

  await ensureWeeklyPayoutSchedule(account.id);

  const { data: savedDeveloper, error } = await adminClient
    .from("developers")
    .update({
      ...developerPatchFromAccount(account),
      stripe_connect_onboarding_status: "onboarding_started",
    })
    .eq("id", developer.id)
    .select()
    .single();

  if (error) throw new Error(error.message);

  return {
    developer: savedDeveloper,
    account,
  };
}

function summarizeEarnings(rows: any[]) {
  const totals: Record<string, any> = {};

  for (const row of rows || []) {
    const currency = cleanString(row.currency || "THB").toUpperCase();

    if (!totals[currency]) {
      totals[currency] = {
        currency,
        gross_amount: 0,
        stripe_fee_amount: 0,
        net_amount: 0,
        platform_fee_amount: 0,
        platform_net_amount: 0,
        developer_amount: 0,
        pending_amount: 0,
        available_amount: 0,
        requested_amount: 0,
        paid_amount: 0,
        transferred_amount: 0,
        failed_amount: 0,
        refunded_amount: 0,
        disputed_amount: 0,
      };
    }

    const total = totals[currency];
    const developerAmount = Number(row.developer_amount || 0);
    const status = cleanString(row.transfer_status);
    const payoutStatus = cleanString(row.payout_status || row.transfer_status);

    total.gross_amount += Number(row.gross_amount || 0);
    total.stripe_fee_amount += Number(row.stripe_fee_amount || 0);
    total.net_amount += Number(row.net_amount || 0);
    total.platform_fee_amount += Number(row.platform_fee_amount || 0);
    total.platform_net_amount += Number(
      row.platform_net_amount ??
        Math.round((Number(row.platform_fee_amount || 0) - Number(row.stripe_fee_amount || 0)) * 100) / 100
    );
    total.developer_amount += developerAmount;

    if (["available", "unrequested", "recorded"].includes(payoutStatus)) total.available_amount += developerAmount;
    if (["requested", "approved", "pending"].includes(payoutStatus)) total.requested_amount += developerAmount;
    if (["paid", "transferred"].includes(payoutStatus)) total.paid_amount += developerAmount;
    if (status === "pending") total.pending_amount += developerAmount;
    if (["transferred", "paid"].includes(status)) total.transferred_amount += developerAmount;
    if (status === "failed") total.failed_amount += developerAmount;
    if (status === "refunded") total.refunded_amount += developerAmount;
    if (status === "disputed") total.disputed_amount += developerAmount;
  }

  return Object.values(totals);
}

function orderGrossAmount(order: any) {
  return roundMoney(
    Number(order.stripe_amount_total || 0) ||
      Number(order.price || 0) ||
      parseMoneyFromDisplay(order.price_display)
  );
}

async function getSubscriptionInvoiceSnapshot(subscriptionId: string) {
  if (!subscriptionId) {
    return {
      sourceType: "order_payment",
      sourceId: "",
      grossAmount: 0,
      paymentIntentId: "",
    };
  }

  try {
    const subscription: any = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ["latest_invoice.payment_intent"],
    });
    const invoice: any = subscription.latest_invoice;
    const paymentIntent: any = invoice?.payment_intent;

    return {
      sourceType: "subscription_invoice",
      sourceId: cleanString(invoice?.id),
      grossAmount: roundMoney(Number(invoice?.amount_paid || 0) / 100),
      paymentIntentId: typeof paymentIntent === "string" ? paymentIntent : cleanString(paymentIntent?.id),
    };
  } catch (error) {
    console.warn("Could not retrieve subscription invoice for wallet backfill:", error);

    return {
      sourceType: "subscription_invoice",
      sourceId: subscriptionId,
      grossAmount: 0,
      paymentIntentId: "",
    };
  }
}

async function backfillDeveloperEarningsForPaidOrders(adminClient: any, developer: any) {
  const result = {
    message: "",
    warning: "",
  };

  const { data: paidOrders, error: ordersError } = await adminClient
    .from("orders")
    .select("*")
    .eq("developer_id", developer.id)
    .eq("payment_status", "paid")
    .order("created_at", { ascending: false })
    .limit(200);

  if (ordersError) {
    if (isMissingWalletSchemaError(ordersError)) {
      result.warning = `${ordersError.message || "Could not read paid developer orders."} ${WALLET_SQL_HINT}`;
      return result;
    }
    throw new Error(ordersError.message);
  }

  const orders = (paidOrders || []).filter((order: any) => {
    return cleanString(order.payment_environment || "live").toLowerCase() !== "test";
  });
  if (!orders.length) return result;

  const { data: existing, error: existingError } = await adminClient
    .from("developer_earnings")
    .select("order_id, source_type, source_id")
    .eq("developer_id", developer.id);

  if (existingError) {
    if (isMissingWalletSchemaError(existingError)) {
      result.warning = `${existingError.message || "Could not read existing developer earnings."} ${WALLET_SQL_HINT}`;
      return result;
    }
    throw new Error(existingError.message);
  }

  const existingOrderIds = new Set((existing || []).map((row: any) => row.order_id).filter(Boolean));
  const existingSources = new Set(
    (existing || [])
      .map((row: any) => `${cleanString(row.source_type)}:${cleanString(row.source_id)}`)
      .filter((key: string) => key !== ":")
  );

  let created = 0;

  for (const order of orders) {
    if (!order?.id || existingOrderIds.has(order.id)) continue;

    let sourceType = "order_payment";
    let sourceId = cleanString(order.stripe_payment_intent_id || order.stripe_checkout_session_id || order.id);
    let paymentIntentId = cleanString(order.stripe_payment_intent_id);
    let grossAmount = orderGrossAmount(order);

    if (cleanString(order.stripe_subscription_id)) {
      const snapshot = await getSubscriptionInvoiceSnapshot(cleanString(order.stripe_subscription_id));
      sourceType = snapshot.sourceType || "subscription_invoice";
      sourceId = snapshot.sourceId || cleanString(order.stripe_subscription_id || order.id);
      paymentIntentId = snapshot.paymentIntentId || paymentIntentId;
      grossAmount = snapshot.grossAmount || grossAmount;
    }

    if (!grossAmount || grossAmount <= 0 || existingSources.has(`${sourceType}:${sourceId}`)) continue;

    const currency = cleanString(order.currency || order.stripe_currency || "THB").toUpperCase();
    const stripeFeeAmount = roundMoney(Number(order.stripe_fee_amount || 0));
    const netAmount = roundMoney(Math.max(0, grossAmount - stripeFeeAmount));
    const platformFeeAmount = roundMoney(Number(order.platform_fee_amount || 0) || grossAmount * 0.2);
    const developerAmount = roundMoney(Number(order.developer_earning_amount || 0) || grossAmount * 0.8);
    const platformNetAmount = roundMoney(
      Number(order.platform_net_amount ?? Number.NaN) ||
        Math.max(0, platformFeeAmount - stripeFeeAmount)
    );

    const { error } = await adminClient
      .from("developer_earnings")
      .insert({
        developer_id: developer.id,
        automation_id: order.automation_id || null,
        order_id: order.id,
        source_type: sourceType,
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
        stripe_payment_intent_id: paymentIntentId,
        metadata: {
          source: "developer_wallet_paid_order_backfill",
          automation_title: order.automation_title || "",
          buyer_email: order.buyer_email || "",
          stripe_checkout_session_id: order.stripe_checkout_session_id || "",
          stripe_subscription_id: order.stripe_subscription_id || "",
        },
        created_at: nowIso(),
        updated_at: nowIso(),
      });

    if (error) {
      if (isMissingWalletSchemaError(error)) {
        result.warning = `${error.message || "Could not create developer earning."} ${WALLET_SQL_HINT}`;
        return result;
      }
      console.warn("Could not backfill developer earning:", error.message);
      continue;
    }

    await adminClient
      .from("orders")
      .update({
        stripe_fee_amount: stripeFeeAmount,
        net_amount: netAmount,
        platform_fee_amount: platformFeeAmount,
        platform_net_amount: platformNetAmount,
        developer_earning_amount: developerAmount,
        revenue_share_status: "allocated",
        updated_at: nowIso(),
      })
      .eq("id", order.id);

    existingOrderIds.add(order.id);
    existingSources.add(`${sourceType}:${sourceId}`);
    created += 1;
  }

  result.message = created ? `Backfilled ${created} paid developer order${created === 1 ? "" : "s"} into wallet.` : "";
  return result;
}

async function getWalletSummary(adminClient: any, developer: any) {
  const backfill = await backfillDeveloperEarningsForPaidOrders(adminClient, developer);

  const { data: earnings, error } = await adminClient
    .from("developer_earnings")
    .select("*")
    .eq("developer_id", developer.id)
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    if (isMissingWalletSchemaError(error)) {
      return {
        developer,
        account: null,
        totals: [],
        earnings: [],
        payout_requests: [],
        schema_warning: WALLET_SQL_HINT,
      };
    }

    throw new Error(error.message);
  }

  const { data: payoutRequests, error: payoutError } = await adminClient
    .from("developer_payout_requests")
    .select("*")
    .eq("developer_id", developer.id)
    .order("created_at", { ascending: false })
    .limit(50);

  if (payoutError && !isMissingWalletSchemaError(payoutError)) {
    throw new Error(payoutError.message);
  }

  return {
    developer,
    account: null,
    totals: summarizeEarnings(earnings || []),
    earnings: earnings || [],
    payout_requests: payoutRequests || [],
    schema_warning: backfill.warning || (payoutError ? WALLET_SQL_HINT : ""),
    backfill_message: backfill.message,
  };
}

async function requestManualPayout(adminClient: any, user: any, developer: any, body: any) {
  const currency = cleanString(body.currency || "THB").toUpperCase();
  const payoutMethod = cleanString(body.payout_method || developer.payout_method || "manual_bank_transfer");
  const developerNote = cleanString(body.developer_note || body.note);
  const savedDetails = cleanObject(developer.payout_details);
  const submittedDetails = cleanObject(body.payout_details);
  const payoutDetails = Object.keys(submittedDetails).length
    ? submittedDetails
    : cleanString(body.payout_details || body.payoutDetails)
      ? { details: cleanString(body.payout_details || body.payoutDetails) }
      : savedDetails;

  if (
    !Object.keys(payoutDetails).length ||
    !cleanString(
      (payoutDetails as any).details ||
        (payoutDetails as any).account_number ||
        (payoutDetails as any).promptpay
    )
  ) {
    return errorResponse("Add payout details before requesting a payout.", 400);
  }

  const { data: earnings, error } = await adminClient
    .from("developer_earnings")
    .select("id, developer_amount, currency")
    .eq("developer_id", developer.id)
    .eq("currency", currency)
    .in("payout_status", ["available", "unrequested"])
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);

  const eligible = earnings || [];
  const amount = eligible.reduce((sum: number, row: any) => {
    return sum + Number(row.developer_amount || 0);
  }, 0);

  const minThb = Number(Deno.env.get("MIN_MANUAL_PAYOUT_THB") || 0);

  if (!eligible.length || amount <= 0) {
    return errorResponse("No available earnings to request for this currency.", 400);
  }

  if (currency === "THB" && minThb > 0 && amount < minThb) {
    return errorResponse(`Minimum payout is ${minThb} THB.`, 400);
  }

  const earningsIds = eligible.map((row: any) => row.id);

  const { data: payoutRequest, error: requestError } = await adminClient
    .from("developer_payout_requests")
    .insert({
      developer_id: developer.id,
      requested_by: user.id,
      currency,
      amount,
      earnings_ids: earningsIds,
      payout_method: payoutMethod,
      payout_details: payoutDetails,
      developer_note: developerNote,
      status: "pending",
      requested_at: nowIso(),
      created_at: nowIso(),
      updated_at: nowIso(),
    })
    .select()
    .single();

  if (requestError) throw new Error(requestError.message);

  const { error: updateError } = await adminClient
    .from("developer_earnings")
    .update({
      payout_request_id: payoutRequest.id,
      payout_status: "requested",
      updated_at: nowIso(),
    })
    .in("id", earningsIds);

  if (updateError) throw new Error(updateError.message);

  await adminClient.from("admin_notifications").insert({
    notification_type: "developer_payout_request",
    title: "Developer payout requested",
    message: `${developer.display_name || "A developer"} requested ${amount.toLocaleString("en-US")} ${currency}.`,
    status: "unread",
    created_at: nowIso(),
  });

  return jsonResponse({
    ok: true,
    payout_request: payoutRequest,
    message: "Payout request submitted. Nexus will review and send payment manually.",
  });
}

async function updatePayoutSettings(adminClient: any, developer: any, body: any) {
  const payoutMethod = cleanString(body.payout_method || body.method || "manual_bank_transfer");
  const payoutDetails = cleanObject(body.payout_details);
  const payoutNote = cleanString(body.payout_note || body.note);

  if (
    !Object.keys(payoutDetails).length ||
    !cleanString(
      (payoutDetails as any).details ||
        (payoutDetails as any).account_number ||
        (payoutDetails as any).promptpay
    )
  ) {
    return errorResponse("Payout details are required.", 400);
  }

  const { data, error } = await adminClient
    .from("developers")
    .update({
      payout_method: payoutMethod,
      payout_details: payoutDetails,
      payout_note: payoutNote,
      payout_settings_updated_at: nowIso(),
      updated_at: nowIso(),
    })
    .eq("id", developer.id)
    .select()
    .single();

  if (error) throw new Error(error.message);

  return jsonResponse({
    ok: true,
    developer: data,
    message: "Payout settings saved.",
  });
}

async function adminUpdatePayoutRequest(adminClient: any, adminUser: any, body: any) {
  const payoutRequestId = cleanString(body.payout_request_id || body.id);
  const status = cleanString(body.status).toLowerCase();
  const adminNote = cleanString(body.admin_note);
  const paymentReference = cleanString(body.payment_reference);
  const paymentReceiptUrl = cleanString(body.payment_receipt_url || body.receipt_url);
  const paymentReceiptFileName = cleanString(body.payment_receipt_file_name || body.receipt_file_name);
  const paymentReceiptMimeType = cleanString(body.payment_receipt_mime_type || body.receipt_mime_type);
  const paymentReceiptBase64 = cleanString(body.payment_receipt_base64 || body.receipt_base64);

  if (!payoutRequestId) {
    return errorResponse("payout_request_id is required.", 400);
  }

  if (!["approved", "paid", "rejected", "cancelled"].includes(status)) {
    return errorResponse("Invalid payout status.", 400);
  }

  const { data: payoutRequest, error: loadError } = await adminClient
    .from("developer_payout_requests")
    .select("*")
    .eq("id", payoutRequestId)
    .maybeSingle();

  if (loadError || !payoutRequest) {
    return errorResponse(loadError?.message || "Payout request not found.", 404);
  }

  const paidAt = status === "paid" ? nowIso() : payoutRequest.paid_at || null;

  const { data: updatedRequest, error: updateError } = await adminClient
    .from("developer_payout_requests")
    .update({
      status,
      admin_note: adminNote || payoutRequest.admin_note,
      payment_reference: paymentReference || payoutRequest.payment_reference,
      payment_receipt_url: paymentReceiptUrl || payoutRequest.payment_receipt_url,
      payment_receipt_file_name: paymentReceiptFileName || payoutRequest.payment_receipt_file_name,
      payment_receipt_mime_type: paymentReceiptMimeType || payoutRequest.payment_receipt_mime_type,
      payment_receipt_base64: paymentReceiptBase64 || payoutRequest.payment_receipt_base64,
      reviewed_at: nowIso(),
      paid_at: paidAt,
      paid_by: status === "paid" ? adminUser.id : payoutRequest.paid_by,
      updated_at: nowIso(),
    })
    .eq("id", payoutRequestId)
    .select()
    .single();

  if (updateError) throw new Error(updateError.message);

  const earningsIds = payoutRequest.earnings_ids || [];

  if (earningsIds.length) {
    if (status === "paid") {
      await adminClient
        .from("developer_earnings")
        .update({
          payout_status: "paid",
          transfer_status: "paid",
          status: "paid",
          updated_at: nowIso(),
        })
        .in("id", earningsIds);
    } else if (status === "rejected" || status === "cancelled") {
      await adminClient
        .from("developer_earnings")
        .update({
          payout_request_id: null,
          payout_status: "available",
          transfer_status: "available",
          status: "available",
          updated_at: nowIso(),
        })
        .in("id", earningsIds);
    } else if (status === "approved") {
      await adminClient
        .from("developer_earnings")
        .update({
          payout_status: "approved",
          transfer_status: "approved",
          updated_at: nowIso(),
        })
        .in("id", earningsIds);
    }
  }

  return jsonResponse({
    ok: true,
    payout_request: updatedRequest,
  });
}

function summarizePaidOrders(rows: any[], earnings: any[] = []) {
  const totals: Record<string, any> = {};
  const earningOrderIds = new Set((earnings || []).map((item: any) => item.order_id).filter(Boolean));

  for (const row of rows || []) {
    const currency = cleanString(row.currency || row.stripe_currency || "THB").toUpperCase();

    if (!totals[currency]) {
      totals[currency] = {
        currency,
        gross_amount: 0,
        stripe_fee_amount: 0,
        net_amount: 0,
        platform_fee_amount: 0,
        platform_net_amount: 0,
        developer_amount: 0,
        internal_or_unallocated_gross_amount: 0,
      };
    }

    const amount =
      Number(row.stripe_amount_total || 0) ||
      Number(row.net_amount || 0) ||
      Number(row.developer_earning_amount || 0) + Number(row.platform_fee_amount || 0) ||
      parseMoneyFromDisplay(row.price_display);

    const stripeFee = Number(row.stripe_fee_amount || 0);
    const developerAmount = Number(row.developer_earning_amount || 0);
    const platformFee = Number(row.platform_fee_amount || 0);
    const platformNet = Number(
      row.platform_net_amount ??
        Math.round((platformFee - stripeFee) * 100) / 100
    );

    totals[currency].gross_amount += amount;
    totals[currency].stripe_fee_amount += stripeFee;
    totals[currency].net_amount += Number(row.net_amount || Math.max(0, amount - stripeFee));
    totals[currency].developer_amount += developerAmount;
    totals[currency].platform_fee_amount += platformFee;
    totals[currency].platform_net_amount += platformNet;

    if (!earningOrderIds.has(row.id)) {
      totals[currency].internal_or_unallocated_gross_amount += amount;
    }
  }

  return Object.values(totals);
}

async function getAdminFinanceSummary(adminClient: any) {
  const { data: earnings, error } = await adminClient
    .from("developer_earnings")
    .select("*, developers(display_name, handle), automations(title, slug), orders(buyer_name, buyer_email, automation_title, created_at)")
    .order("created_at", { ascending: false })
    .limit(500);

  let safeEarnings = earnings || [];
  let schemaWarning = "";

  if (error) {
    if (isMissingWalletSchemaError(error)) {
      safeEarnings = [];
      schemaWarning = WALLET_SQL_HINT;
    } else {
      throw new Error(error.message);
    }
  }

  const { data: paidOrders, error: ordersError } = await adminClient
    .from("orders")
    .select("*, developers(display_name, handle), automations(title, slug)")
    .eq("payment_status", "paid")
    .order("created_at", { ascending: false })
    .limit(500);

  if (ordersError) throw new Error(ordersError.message);

  const { data: developers, error: developerError } = await adminClient
    .from("developers")
    .select("id, display_name, handle")
    .order("display_name", { ascending: true });

  if (developerError) throw new Error(developerError.message);

  const { data: payoutRequests, error: payoutError } = await adminClient
    .from("developer_payout_requests")
    .select("*, developers(display_name, handle)")
    .order("created_at", { ascending: false })
    .limit(200);

  if (payoutError && !isMissingWalletSchemaError(payoutError)) {
    throw new Error(payoutError.message);
  }

  const livePaidOrders = (paidOrders || []).filter((order: any) => {
    return cleanString(order.payment_environment || "live").toLowerCase() !== "test";
  });

  return {
    totals: summarizeEarnings(safeEarnings),
    order_totals: summarizePaidOrders(livePaidOrders, safeEarnings),
    earnings: safeEarnings,
    paid_orders: livePaidOrders,
    developers: developers || [],
    payout_requests: payoutRequests || [],
    schema_warning: schemaWarning,
  };
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
      message: "developer-stripe-account is alive.",
      env: {
        has_stripe_secret: Boolean(Deno.env.get("STRIPE_SECRET_KEY") || ""),
        has_site_url: Boolean(Deno.env.get("SITE_URL") || ""),
        default_country: DEFAULT_CONNECT_COUNTRY,
      },
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed.", 405);
  }

  try {
    const { user, profile, developer, error: authError } = await requireUserContext(req);

    if (authError || !user || !profile) {
      return errorResponse(authError || "Authentication required.", 401);
    }

    const body = await req.json().catch(() => ({}));
    const action = cleanString(body.action || "get_status");
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    if (action === "admin_get_finance_summary") {
      const adminError = requireAdmin(profile);
      if (adminError) return errorResponse(adminError, 403);

      const summary = await getAdminFinanceSummary(adminClient);
      return jsonResponse({
        ok: true,
        ...summary,
      });
    }

    if (action === "admin_update_payout_request") {
      const adminError = requireAdmin(profile);
      if (adminError) return errorResponse(adminError, 403);

      return await adminUpdatePayoutRequest(adminClient, user, body);
    }

    const developerError = requireDeveloper(profile, developer);
    if (developerError) return errorResponse(developerError, 403);

    if (action === "get_status" || action === "refresh_account") {
      const synced = await syncDeveloperStripeAccount(adminClient, developer);
      return jsonResponse({
        ok: true,
        developer: synced.developer,
        account: synced.account,
      });
    }

    if (action === "create_onboarding_link") {
      const country = cleanString(body.country || developer.stripe_connect_country || DEFAULT_CONNECT_COUNTRY).toUpperCase();
      const loaded = await createOrLoadConnectedAccount(adminClient, user, developer, country);
      const refreshUrl = `${SITE_URL}/pages/developer/dashboard.html?tab=wallet&stripe=refresh`;
      const returnUrl = `${SITE_URL}/pages/developer/dashboard.html?tab=wallet&stripe=return`;
      const accountLink = await stripe.accountLinks.create({
        account: loaded.developer.stripe_connected_account_id,
        refresh_url: refreshUrl,
        return_url: returnUrl,
        type: "account_onboarding",
      });

      return jsonResponse({
        ok: true,
        url: accountLink.url,
        developer: loaded.developer,
      });
    }

    if (action === "create_dashboard_login_link") {
      const synced = await syncDeveloperStripeAccount(adminClient, developer);
      const accountId = cleanString(synced.developer?.stripe_connected_account_id);

      if (!accountId) {
        return errorResponse("Set up payouts before opening the Stripe Express dashboard.", 409);
      }

      const loginLink = await stripe.accounts.createLoginLink(accountId);

      return jsonResponse({
        ok: true,
        url: loginLink.url,
        developer: synced.developer,
      });
    }

    if (action === "get_wallet_summary") {
      const summary = await getWalletSummary(adminClient, developer);
      return jsonResponse({
        ok: true,
        ...summary,
      });
    }

    if (action === "update_payout_settings") {
      return await updatePayoutSettings(adminClient, developer, body);
    }

    if (action === "request_manual_payout") {
      return await requestManualPayout(adminClient, user, developer, body);
    }

    return errorResponse("Unknown developer wallet action.", 400);
  } catch (error) {
    console.error(error);

    return errorResponse(
      userFacingError(error),
      userFacingStatus(error),
    );
  }
});
