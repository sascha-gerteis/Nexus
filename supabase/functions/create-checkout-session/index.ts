import Stripe from "https://esm.sh/stripe@14.25.0?target=deno";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
  apiVersion: "2024-06-20",
});

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const PRODUCTION_SITE_URL = "https://nexus-ai.software";

function cleanSiteUrl(value = "") {
  const raw = String(value || "").trim().replace(/\/+$/, "");

  if (!raw) return PRODUCTION_SITE_URL;

  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase();

    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
      return PRODUCTION_SITE_URL;
    }

    return url.origin;
  } catch {
    return PRODUCTION_SITE_URL;
  }
}

const SITE_URL = cleanSiteUrl(Deno.env.get("SITE_URL") || PRODUCTION_SITE_URL);

const FX_API_BASE_URL = "https://api.frankfurter.dev";
type SupportedCheckoutCurrency = "usd" | "thb" | "eur" | "gbp" | "jpy";
const SUPPORTED_CHECKOUT_CURRENCIES: SupportedCheckoutCurrency[] = ["thb", "usd", "eur", "gbp", "jpy"];
const ZERO_DECIMAL_STRIPE_CURRENCIES = new Set<SupportedCheckoutCurrency>(["jpy"]);

function fallbackFxRates(): Record<SupportedCheckoutCurrency, number> {
  return {
    usd: 1,
    thb: Number(Deno.env.get("USD_TO_THB_FALLBACK_RATE") || 36),
    eur: Number(Deno.env.get("USD_TO_EUR_FALLBACK_RATE") || 0.92),
    gbp: Number(Deno.env.get("USD_TO_GBP_FALLBACK_RATE") || 0.78),
    jpy: Number(Deno.env.get("USD_TO_JPY_FALLBACK_RATE") || 157),
  };
}

function nowIso() {
  return new Date().toISOString();
}

function cleanString(value: unknown) {
  return String(value || "").trim();
}

function isPassingWorkflowTest(status: unknown) {
  return ["passed", "passed_with_expected_test_callback_error"].includes(cleanString(status).toLowerCase());
}

function hasAttachedCheckoutFlow(product: any) {
  if (cleanString(product?.listing_type) === "custom_request") return true;

  return Boolean(
    product?.n8n_workflow_json ||
      cleanString(product?.n8n_workflow_id) ||
      cleanString(product?.runtime_webhook_url || product?.n8n_webhook_url)
  );
}

async function pauseInvalidCheckoutProduct(adminClient: any, product: any) {
  const now = nowIso();

  await adminClient
    .from("automations")
    .update({
      status: "paused",
      updated_at: now,
      internal_notes: `${cleanString(product.internal_notes)}${product.internal_notes ? "\n\n" : ""}[${now}] Auto-paused because checkout product is missing an attached workflow/flow.`,
    })
    .eq("id", product.id);
}

function normalizeCurrency(value: unknown): SupportedCheckoutCurrency {
  const currency = String(value || "THB").trim().toLowerCase() as SupportedCheckoutCurrency;
  return SUPPORTED_CHECKOUT_CURRENCIES.includes(currency) ? currency : "thb";
}

function normalizePricingType(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function normalizeInstallType(value: unknown) {
  const raw = cleanString(value).toLowerCase();

  if (
    raw === "nexus_guided" ||
    raw === "nexus_install" ||
    raw === "guided" ||
    raw === "guided_install" ||
    raw === "managed" ||
    raw === "managed_install"
  ) {
    return "nexus_guided";
  }

  return "self_serve";
}

function productAllowsGuidedInstall(product: any) {
  const developerId = cleanString(product?.developer_id || product?.developers?.id);

  if (!developerId) return true;

  return product?.guided_install_enabled === true ||
    cleanString(product?.guided_install_enabled).toLowerCase() === "true";
}

function roundMoney(amount: number, currency: SupportedCheckoutCurrency) {
  if (currency === "thb" || currency === "jpy") {
    return Math.round(amount);
  }

  return Math.round(amount * 100) / 100;
}

function toStripeUnitAmount(amount: number, currency: SupportedCheckoutCurrency) {
  if (ZERO_DECIMAL_STRIPE_CURRENCIES.has(currency)) {
    return Math.round(Number(amount || 0));
  }

  return Math.round(Number(amount || 0) * 100);
}

function getStripeMode(product: any): "payment" | "subscription" | "unsupported" {
  const pricingType = normalizePricingType(product.pricing_type);

  if (pricingType === "monthly") return "subscription";
  if (pricingType === "one_time") return "payment";
  if (pricingType === "setup_fee") return "payment";

  return "unsupported";
}

function getPriceIdColumn(currency: SupportedCheckoutCurrency) {
  if (currency === "usd") return "stripe_price_id_usd";
  if (currency === "thb") return "stripe_price_id_thb";
  return "";
}

function getStripeAmountColumn(currency: SupportedCheckoutCurrency) {
  if (currency === "usd") return "stripe_price_amount_usd";
  if (currency === "thb") return "stripe_price_amount_thb";
  return "";
}

function getPriceIdForCurrency(product: any, currency: SupportedCheckoutCurrency) {
  const column = getPriceIdColumn(currency);
  return column ? product[column] : "";
}

function getConfiguredPriceValues(product: any) {
  const pricingType = normalizePricingType(product.pricing_type);
  const isSetupFee = pricingType === "setup_fee";

  return {
    values: SUPPORTED_CHECKOUT_CURRENCIES.reduce((acc, currency) => {
      const field = isSetupFee ? `setup_fee_${currency}` : `price_${currency}`;
      acc[currency] = Number(product[field] || 0);
      return acc;
    }, {} as Record<SupportedCheckoutCurrency, number>),
    usdValue: isSetupFee
      ? Number(product.setup_fee_usd || 0)
      : Number(product.price_usd || 0),
    thbValue: isSetupFee
      ? Number(product.setup_fee_thb || 0)
      : Number(product.price_thb || 0),
    genericValue: isSetupFee
      ? Number(product.setup_fee || 0)
      : Number(product.price || 0),

    isSetupFee,
  };
}

function getMissingPriceMessage(product: any, currency: SupportedCheckoutCurrency) {
  const pricingType = normalizePricingType(product.pricing_type);
  const selected = currency.toUpperCase();

  if (pricingType === "setup_fee") {
    return `No ${selected} setup fee is configured for this product. Add setup_fee_${currency}, setup_fee in a matching base currency, or a USD/THB price so Nexus can convert it.`;
  }

  return `No ${selected} price is configured for this product. Add price_${currency}, price in a matching base currency, or a USD/THB price so Nexus can convert it.`;
}

function formatPriceDisplay(amount: number, currency: "usd" | "thb", mode: "payment" | "subscription") {
  const suffix = mode === "subscription" ? "/mo" : "";

  if (currency === "thb") {
    return `฿${Number(amount).toLocaleString("en-US")}${suffix}`;
  }

  return `$${Number(amount).toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  })}${suffix}`;
}

function formatCheckoutPriceDisplay(amount: number, currency: SupportedCheckoutCurrency, mode: "payment" | "subscription") {
  const suffix = mode === "subscription" ? "/mo" : "";
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: currency === "thb" || currency === "jpy" ? 0 : undefined,
    maximumFractionDigits: currency === "thb" || currency === "jpy" ? 0 : 2,
  });

  return `${formatter.format(Number(amount || 0))}${suffix}`;
}

async function getLiveUsdToThbRate() {
  const fallbackRate = Number(Deno.env.get("USD_TO_THB_FALLBACK_RATE") || 0);

  try {
    const response = await fetch(`${FX_API_BASE_URL}/v2/rate/USD/THB`, {
      method: "GET",
      headers: {
        accept: "application/json",
      },
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data?.message || `FX API failed with status ${response.status}`);
    }

    const rate = Number(data.rate || 0);

    if (!rate || rate <= 0) {
      throw new Error("FX API returned an invalid USD/THB rate.");
    }

    return {
      rate,
      source: "frankfurter_live",
      date: data.date || null,
    };
  } catch (error) {
    if (fallbackRate > 0) {
      return {
        rate: fallbackRate,
        source: "fallback_secret",
        date: null,
      };
    }

    throw new Error(
      `Could not fetch live USD/THB exchange rate. Set USD_TO_THB_FALLBACK_RATE as a backup. ${
        error instanceof Error ? error.message : ""
      }`,
    );
  }
}

async function resolveAmountForCurrency(product: any, currency: "usd" | "thb") {
  const productBaseCurrency = normalizeCurrency(product.currency || "USD");
  const { usdValue, thbValue, genericValue, isSetupFee } = getConfiguredPriceValues(product);
  

  if (currency === "usd" && usdValue > 0) {
    return {
      amount: roundMoney(usdValue, "usd"),
      source: "exact_usd",
      derived: false,
      fxRate: null as number | null,
      fxSource: null as string | null,
      fxDate: null as string | null,
      updateField: null as string | null,
      isSetupFee,
    };
  }

  if (currency === "thb" && thbValue > 0) {
    return {
      amount: roundMoney(thbValue, "thb"),
      source: "exact_thb",
      derived: false,
      fxRate: null as number | null,
      fxSource: null as string | null,
      fxDate: null as string | null,
      updateField: null as string | null,
      isSetupFee,
    };
  }

  const fx = await getLiveUsdToThbRate();

  if (currency === "usd") {
    if (thbValue > 0) {
      return {
        amount: roundMoney(thbValue / fx.rate, "usd"),
        source: "converted_from_thb",
        derived: true,
        fxRate: fx.rate,
        fxSource: fx.source,
        fxDate: fx.date,
        updateField: isSetupFee ? "setup_fee_usd" : "price_usd",
        isSetupFee,
      };
    }

    if (productBaseCurrency === "usd" && genericValue > 0) {
      return {
        amount: roundMoney(genericValue, "usd"),
        source: "generic_usd",
        derived: false,
        fxRate: null,
        fxSource: null,
        fxDate: null,
        updateField: null,
        isSetupFee,
      };
    }

    if (productBaseCurrency === "thb" && genericValue > 0) {
      return {
        amount: roundMoney(genericValue / fx.rate, "usd"),
        source: "converted_from_generic_thb",
        derived: true,
        fxRate: fx.rate,
        fxSource: fx.source,
        fxDate: fx.date,
        updateField: isSetupFee ? "setup_fee_usd" : "price_usd",
        isSetupFee,
      };
    }
  }

  if (currency === "thb") {
    if (usdValue > 0) {
      return {
        amount: roundMoney(usdValue * fx.rate, "thb"),
        source: "converted_from_usd",
        derived: true,
        fxRate: fx.rate,
        fxSource: fx.source,
        fxDate: fx.date,
        updateField: isSetupFee ? "setup_fee_thb" : "price_thb",
        isSetupFee,
      };
    }

    if (productBaseCurrency === "thb" && genericValue > 0) {
      return {
        amount: roundMoney(genericValue, "thb"),
        source: "generic_thb",
        derived: false,
        fxRate: null,
        fxSource: null,
        fxDate: null,
        updateField: null,
        isSetupFee,
      };
    }

    if (productBaseCurrency === "usd" && genericValue > 0) {
      return {
        amount: roundMoney(genericValue * fx.rate, "thb"),
        source: "converted_from_generic_usd",
        derived: true,
        fxRate: fx.rate,
        fxSource: fx.source,
        fxDate: fx.date,
        updateField: isSetupFee ? "setup_fee_thb" : "price_thb",
        isSetupFee,
      };
    }
  }

  return {
    amount: 0,
    source: "missing",
    derived: false,
    fxRate: fx.rate,
    fxSource: fx.source,
    fxDate: fx.date,
    updateField: null,
    isSetupFee,
  };
}

async function getLiveFxRates() {
  const fallback = fallbackFxRates();

  try {
    const response = await fetch(`${FX_API_BASE_URL}/v2/latest?from=USD&to=THB,EUR,GBP,JPY`, {
      method: "GET",
      headers: {
        accept: "application/json",
      },
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data?.message || `FX API failed with status ${response.status}`);
    }

    const liveRates = {
      usd: 1,
      thb: Number(data?.rates?.THB || 0),
      eur: Number(data?.rates?.EUR || 0),
      gbp: Number(data?.rates?.GBP || 0),
      jpy: Number(data?.rates?.JPY || 0),
    };

    const hasValidRates = SUPPORTED_CHECKOUT_CURRENCIES.every((currency) => {
      return liveRates[currency] && liveRates[currency] > 0;
    });

    if (!hasValidRates) {
      throw new Error("FX API returned invalid rates.");
    }

    return {
      rates: liveRates,
      source: "frankfurter_live",
      date: data.date || null,
    };
  } catch {
    return {
      rates: fallback,
      source: "fallback_secret",
      date: null,
    };
  }
}

function convertCurrencyAmount(
  amount: number,
  fromCurrency: SupportedCheckoutCurrency,
  toCurrency: SupportedCheckoutCurrency,
  rates: Record<SupportedCheckoutCurrency, number>,
) {
  if (fromCurrency === toCurrency) return Number(amount || 0);

  const fromRate = rates[fromCurrency] || 1;
  const toRate = rates[toCurrency] || 1;

  return (Number(amount || 0) / fromRate) * toRate;
}

function priceUpdateFieldForCurrency(isSetupFee: boolean, currency: SupportedCheckoutCurrency) {
  if (currency !== "usd" && currency !== "thb") return null;
  return isSetupFee ? `setup_fee_${currency}` : `price_${currency}`;
}

async function resolveCheckoutAmountForCurrency(product: any, currency: SupportedCheckoutCurrency) {
  const productBaseCurrency = normalizeCurrency(product.currency || "USD");
  const { values, genericValue, isSetupFee } = getConfiguredPriceValues(product);
  const exactValue = Number(values[currency] || 0);

  if (exactValue > 0) {
    return {
      amount: roundMoney(exactValue, currency),
      source: `exact_${currency}`,
      derived: false,
      fxRate: null as number | null,
      fxSource: null as string | null,
      fxDate: null as string | null,
      updateField: null as string | null,
      isSetupFee,
    };
  }

  const fx = await getLiveFxRates();

  const sourceCurrency = SUPPORTED_CHECKOUT_CURRENCIES.find((candidate) => {
    return Number(values[candidate] || 0) > 0;
  });

  if (sourceCurrency) {
    const sourceAmount = Number(values[sourceCurrency] || 0);
    const convertedAmount = convertCurrencyAmount(sourceAmount, sourceCurrency, currency, fx.rates);

    return {
      amount: roundMoney(convertedAmount, currency),
      source: `converted_from_${sourceCurrency}`,
      derived: true,
      fxRate: fx.rates[currency],
      fxSource: fx.source,
      fxDate: fx.date,
      updateField: priceUpdateFieldForCurrency(isSetupFee, currency),
      isSetupFee,
    };
  }

  if (genericValue > 0) {
    const convertedAmount = convertCurrencyAmount(genericValue, productBaseCurrency, currency, fx.rates);
    const isGenericExact = productBaseCurrency === currency;

    return {
      amount: roundMoney(convertedAmount, currency),
      source: isGenericExact ? `generic_${currency}` : `converted_from_generic_${productBaseCurrency}`,
      derived: !isGenericExact,
      fxRate: isGenericExact ? null : fx.rates[currency],
      fxSource: isGenericExact ? null : fx.source,
      fxDate: isGenericExact ? null : fx.date,
      updateField: !isGenericExact ? priceUpdateFieldForCurrency(isSetupFee, currency) : null,
      isSetupFee,
    };
  }

  return {
    amount: 0,
    source: "missing",
    derived: false,
    fxRate: fx.rates[currency],
    fxSource: fx.source,
    fxDate: fx.date,
    updateField: null,
    isSetupFee,
  };
}

async function requireBuyer(req: Request) {
  const authHeader = req.headers.get("Authorization") || "";

  if (!authHeader.startsWith("Bearer ")) {
    return { user: null, error: "Missing auth token" };
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  });

  const token = authHeader.replace("Bearer ", "");
  const { data: userData, error: userError } = await userClient.auth.getUser(token);

  if (userError || !userData?.user) {
    return { user: null, error: "Invalid auth token" };
  }

  return { user: userData.user, error: null };
}

async function ensureStripePrice(adminClient: any, product: any, currency: SupportedCheckoutCurrency) {
  const mode = getStripeMode(product);

  if (mode === "unsupported") {
    throw new Error("This product cannot be purchased through Stripe checkout.");
  }

  const resolvedPrice = await resolveCheckoutAmountForCurrency(product, currency);
  const amount = resolvedPrice.amount;

  if (!amount || amount <= 0) {
    throw new Error(getMissingPriceMessage(product, currency));
  }

  const expectedUnitAmount = toStripeUnitAmount(amount, currency);

  let stripeProductId = product.stripe_product_id;

  if (!stripeProductId) {
    const createdProduct = await stripe.products.create({
      name: product.title || "Nexus Automation",
      description: product.short_description || product.long_description || "",
      active: product.status === "live",
      metadata: {
        automation_id: product.id,
        slug: product.slug || "",
        source: "nexus",
      },
    });

    stripeProductId = createdProduct.id;
  }

  let priceId = getPriceIdForCurrency(product, currency);
  let shouldCreatePrice = !priceId;

  if (priceId) {
    try {
      const existingPrice = await stripe.prices.retrieve(priceId);

      const existingCurrencyMatches = existingPrice.currency === currency;
      const existingAmountMatches = existingPrice.unit_amount === expectedUnitAmount;
      const existingModeMatches =
        mode === "subscription"
          ? Boolean(existingPrice.recurring)
          : !existingPrice.recurring;

      if (
        !existingPrice.active ||
        !existingCurrencyMatches ||
        !existingAmountMatches ||
        !existingModeMatches
      ) {
        shouldCreatePrice = true;
      }
    } catch {
      shouldCreatePrice = true;
    }
  }

  const updates: Record<string, unknown> = {
    stripe_product_id: stripeProductId,
    stripe_price_type: mode,
    stripe_sync_status: "synced",
    stripe_sync_error: null,
    stripe_last_synced_at: nowIso(),
  };

  if (resolvedPrice.derived && resolvedPrice.updateField) {
    updates[resolvedPrice.updateField] = amount;
  }

  if (shouldCreatePrice) {
    const pricePayload: Stripe.PriceCreateParams = {
      product: stripeProductId,
      currency,
      unit_amount: expectedUnitAmount,
      nickname: `${product.title || "Nexus Automation"} ${currency.toUpperCase()} ${amount}`,
      metadata: {
        automation_id: product.id,
        slug: product.slug || "",
        currency,
        amount: String(amount),
        price_source: resolvedPrice.source,
        derived_price: String(resolvedPrice.derived),
        fx_rate: resolvedPrice.fxRate ? String(resolvedPrice.fxRate) : "",
        fx_source: resolvedPrice.fxSource || "",
        fx_date: resolvedPrice.fxDate || "",
        source: "nexus",
      },
    };

    if (mode === "subscription") {
      pricePayload.recurring = { interval: "month" };
    }

    const newPrice = await stripe.prices.create(pricePayload);
    priceId = newPrice.id;

    const priceIdColumn = getPriceIdColumn(currency);
    const amountColumn = getStripeAmountColumn(currency);

    if (priceIdColumn) updates[priceIdColumn] = newPrice.id;
    if (amountColumn) updates[amountColumn] = amount;
  }

  await adminClient
    .from("automations")
    .update(updates)
    .eq("id", product.id);

  return {
    priceId,
    amount,
    unitAmount: expectedUnitAmount,
    mode,
    currency,
    priceSource: resolvedPrice.source,
    derivedPrice: resolvedPrice.derived,
    fxRate: resolvedPrice.fxRate,
    fxSource: resolvedPrice.fxSource,
    fxDate: resolvedPrice.fxDate,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    const { user, error: authError } = await requireBuyer(req);

    if (authError || !user) {
      return errorResponse(authError || "Login required", 401);
    }

    const body = await req.json().catch(() => ({}));

    const automationId = body.automation_id;
    const installType = normalizeInstallType(body.install_type || "self_serve");
    const selectedCustomization = String(body.selected_customization || "");
    const currency = normalizeCurrency(body.currency || "THB");

    const buyerName = String(body.buyer_name || user.user_metadata?.full_name || "");
    const buyerEmail = String(body.buyer_email || user.email || "");
    const buyerCompany = String(body.buyer_company || "");
    const buyerWebsite = String(body.buyer_website || "");
    const setupNotes = String(body.setup_notes || "");

    if (!automationId) {
      return errorResponse("automation_id is required", 400);
    }

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: product, error: productError } = await adminClient
      .from("automations")
      .select("*, developers(*)")
      .eq("id", automationId)
      .maybeSingle();

    if (productError || !product) {
      return errorResponse(productError?.message || "Product not found", 404);
    }

    if (product.status !== "live") {
      return errorResponse("This product is not live.", 400);
    }

    if (installType === "nexus_guided" && !productAllowsGuidedInstall(product)) {
      return errorResponse("Guided install is not available for this product.", 400);
    }

    if (!hasAttachedCheckoutFlow(product)) {
      await pauseInvalidCheckoutProduct(adminClient, product);
      return errorResponse(
        "This product was paused because it has no workflow attached. Please contact Nexus or choose another automation.",
        409,
      );
    }

    if (product.pricing_type === "custom_quote" || product.pricing_type === "free_demo") {
      return errorResponse("This product is not available for direct checkout.", 400);
    }

    const {
      priceId,
      amount,
      unitAmount,
      mode,
      priceSource,
      derivedPrice,
      fxRate,
      fxSource,
      fxDate,
    } = await ensureStripePrice(adminClient, product, currency);

    const { data: existingProfile, error: existingProfileError } = await adminClient
      .from("profiles")
      .select("id, full_name, role")
      .eq("id", user.id)
      .maybeSingle();

    if (existingProfileError) {
      return errorResponse(existingProfileError.message, 500);
    }

    await adminClient.from("profiles").upsert(
      {
        id: user.id,
        email: buyerEmail,
        full_name: existingProfile?.full_name || buyerName,
        role: existingProfile?.role || "buyer",
      },
      { onConflict: "id" },
    );

    await adminClient.from("buyer_profiles").upsert(
      {
        user_id: user.id,
        name: buyerName,
        email: buyerEmail,
        company: buyerCompany,
        website: buyerWebsite,
      },
      { onConflict: "user_id" },
    );

    const priceDisplay = formatCheckoutPriceDisplay(amount, currency, mode);

    const { data: order, error: orderError } = await adminClient
      .from("orders")
      .insert({
        buyer_id: user.id,
        automation_id: product.id,
        developer_id: product.developer_id || product.developers?.id || null,

        automation_title: product.title,
        install_type: installType,
        selected_customization: selectedCustomization,

        currency: currency.toUpperCase(),
        price_display: priceDisplay,

        payment_status: "pending",
        order_status: "checkout_started",

        buyer_name: buyerName,
        buyer_email: buyerEmail,
        buyer_company: buyerCompany,
        buyer_website: buyerWebsite,
        setup_notes: setupNotes,

        stripe_mode: mode,
stripe_currency: currency,
stripe_amount_total: amount,
stripe_unit_amount: unitAmount,

price_source: priceSource,
derived_price: derivedPrice,
fx_rate: fxRate,
fx_source: fxSource,
fx_date: fxDate,

created_at: nowIso(),
updated_at: nowIso(),
      })
      .select()
      .single();

    if (orderError) {
      return errorResponse(orderError.message, 500);
    }

    const metadata = {
      order_id: order.id,
      buyer_id: user.id,
      automation_id: product.id,
      developer_id: product.developer_id || product.developers?.id || "",
      install_type: installType,
      selected_customization: selectedCustomization,
      currency,
      amount: String(amount),
      price_source: priceSource,
      derived_price: String(derivedPrice),
      fx_rate: fxRate ? String(fxRate) : "",
      fx_source: fxSource || "",
      fx_date: fxDate || "",
      source: "nexus",
    };

    const sessionParams: Stripe.Checkout.SessionCreateParams = {
      mode,
      customer_email: buyerEmail || undefined,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${SITE_URL}/pages/checkout/success.html?order_id=${order.id}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_URL}/pages/checkout/index.html?slug=${encodeURIComponent(product.slug || "")}&step=setup&checkout=cancelled&order_id=${order.id}`,
      metadata,
    };

    if (mode === "payment") {
      sessionParams.payment_intent_data = {
        metadata,
      };
    }

    if (mode === "subscription") {
      sessionParams.subscription_data = {
        metadata,
      };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);

    await adminClient
      .from("orders")
      .update({
        stripe_checkout_session_id: session.id,
        stripe_customer_id: typeof session.customer === "string" ? session.customer : null,
        updated_at: nowIso(),
      })
      .eq("id", order.id);

    return jsonResponse({
      ok: true,
      checkout_url: session.url,
      session_id: session.id,
      order_id: order.id,
      currency: currency.toUpperCase(),
      amount,
      unit_amount: unitAmount,
      price_display: priceDisplay,
      price_source: priceSource,
      derived_price: derivedPrice,
      fx_rate: fxRate,
      fx_source: fxSource,
      fx_date: fxDate,
    });
  } catch (error) {
    console.error(error);

    return errorResponse(
      error instanceof Error ? error.message : "Could not create Checkout Session",
      500,
    );
  }
});
