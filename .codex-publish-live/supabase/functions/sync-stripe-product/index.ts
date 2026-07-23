import Stripe from "https://esm.sh/stripe@14.25.0?target=deno";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
  apiVersion: "2024-06-20",
});

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function toStripeUnitAmount(amount: number) {
  return Math.round(Number(amount || 0) * 100);
}

function getAmountForCurrency(product: any, currency: "usd" | "thb") {
  if (currency === "usd") {
    return Number(product.price_usd || product.price || 0);
  }

  return Number(product.price_thb || product.price || 0);
}

function getStripeMode(product: any) {
  if (product.pricing_type === "monthly") return "subscription";
  if (product.pricing_type === "one_time") return "payment";
  if (product.pricing_type === "setup_fee") return "payment";
  return "unsupported";
}

async function requireAdmin(req: Request) {
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

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("role")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (profileError || profile?.role !== "admin") {
    return { user: null, error: "Admin access required" };
  }

  return { user: userData.user, error: null };
}

async function ensureStripeProductAndPrices(product: any) {
  const mode = getStripeMode(product);

  if (mode === "unsupported") {
    return {
      updates: {
        stripe_sync_status: "skipped",
        stripe_sync_error: "Product pricing type does not require Stripe checkout.",
        stripe_last_synced_at: new Date().toISOString(),
      },
    };
  }

  let stripeProductId = product.stripe_product_id;

  if (!stripeProductId) {
    const stripeProduct = await stripe.products.create({
      name: product.title || "Nexus Automation",
      description: product.short_description || product.long_description || "",
      active: product.status === "live",
      metadata: {
        automation_id: product.id,
        slug: product.slug || "",
        source: "nexus",
      },
    });

    stripeProductId = stripeProduct.id;
  } else {
    await stripe.products.update(stripeProductId, {
      name: product.title || "Nexus Automation",
      description: product.short_description || product.long_description || "",
      active: product.status === "live",
      metadata: {
        automation_id: product.id,
        slug: product.slug || "",
        source: "nexus",
      },
    });
  }

  const updates: Record<string, unknown> = {
    stripe_product_id: stripeProductId,
    stripe_price_type: mode,
    stripe_sync_status: "synced",
    stripe_sync_error: null,
    stripe_last_synced_at: new Date().toISOString(),
  };

  for (const currency of ["usd", "thb"] as const) {
    const amount = getAmountForCurrency(product, currency);

    if (!amount || amount <= 0) continue;

    const existingPriceId =
      currency === "usd" ? product.stripe_price_id_usd : product.stripe_price_id_thb;

    const existingAmount =
      currency === "usd"
        ? Number(product.stripe_price_amount_usd || 0)
        : Number(product.stripe_price_amount_thb || 0);

    let shouldCreateNewPrice = !existingPriceId || existingAmount !== amount;

    if (existingPriceId) {
      try {
        const existingPrice = await stripe.prices.retrieve(existingPriceId);
        if (!existingPrice.active) shouldCreateNewPrice = true;
      } catch {
        shouldCreateNewPrice = true;
      }
    }

    if (!shouldCreateNewPrice) continue;

    const pricePayload: Stripe.PriceCreateParams = {
      product: stripeProductId,
      currency,
      unit_amount: toStripeUnitAmount(amount),
      nickname: `${product.title || "Nexus Automation"} ${currency.toUpperCase()}`,
      metadata: {
        automation_id: product.id,
        slug: product.slug || "",
        currency,
        source: "nexus",
      },
    };

    if (mode === "subscription") {
      pricePayload.recurring = {
        interval: "month",
      };
    }

    const newPrice = await stripe.prices.create(pricePayload);

    if (currency === "usd") {
      updates.stripe_price_id_usd = newPrice.id;
      updates.stripe_price_amount_usd = amount;
    } else {
      updates.stripe_price_id_thb = newPrice.id;
      updates.stripe_price_amount_thb = amount;
    }
  }

  return { updates };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    const { error: authError } = await requireAdmin(req);

    if (authError) {
      return errorResponse(authError, 401);
    }

    const body = await req.json();
    const automationId = body.automation_id;

    if (!automationId) {
      return errorResponse("automation_id is required", 400);
    }

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: product, error: productError } = await adminClient
      .from("automations")
      .select("*")
      .eq("id", automationId)
      .maybeSingle();

    if (productError || !product) {
      return errorResponse(productError?.message || "Product not found", 404);
    }

    const { updates } = await ensureStripeProductAndPrices(product);

    const { data: updatedProduct, error: updateError } = await adminClient
      .from("automations")
      .update(updates)
      .eq("id", automationId)
      .select()
      .single();

    if (updateError) {
      return errorResponse(updateError.message, 500);
    }

    return jsonResponse({
      ok: true,
      product: updatedProduct,
    });
  } catch (error) {
    console.error(error);

    return errorResponse(error.message || "Stripe sync failed", 500);
  }
});