import { createClient } from "npm:@supabase/supabase-js@2";
import { errorResponse, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function cleanString(value: unknown) {
  return String(value || "").trim();
}

function slugify(value: unknown) {
  return cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function cleanUuidList(value: unknown) {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.map((item) => cleanString(item)).filter(Boolean))];
}

async function requireAdmin(req: Request) {
  const authHeader = req.headers.get("Authorization") || "";

  if (!authHeader.startsWith("Bearer ")) {
    return { adminClient: null, error: "Missing auth token." };
  }

  const token = authHeader.replace("Bearer ", "").trim();
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userError } = await userClient.auth.getUser(token);

  if (userError || !userData?.user) {
    return { adminClient: null, error: "Invalid auth token." };
  }

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("id, role")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (profileError || !profile) {
    return { adminClient: null, error: "Admin profile not found." };
  }

  if (profile.role !== "admin") {
    return { adminClient: null, error: "Admin access required." };
  }

  return { adminClient, error: null };
}

async function saveBundle(adminClient: any, payload: Record<string, unknown>) {
  const bundleInput = payload.bundle && typeof payload.bundle === "object"
    ? payload.bundle as Record<string, unknown>
    : {};
  const automationIds = cleanUuidList(payload.automation_ids);
  const title = cleanString(bundleInput.title);
  const slug = slugify(bundleInput.slug || title);

  if (!title) throw new Error("Bundle title is required.");
  if (!slug) throw new Error("Bundle slug is required.");
  if (!automationIds.length) throw new Error("Choose at least one live product for this bundle.");

  const { data: products, error: productsError } = await adminClient
    .from("automations")
    .select("id,status,price,price_usd,price_thb,currency")
    .in("id", automationIds);

  if (productsError) throw productsError;

  const liveIds = new Set(
    (products || [])
      .filter((product: Record<string, unknown>) =>
        ["live", "active", "published"].includes(cleanString(product.status).toLowerCase())
      )
      .map((product: Record<string, unknown>) => cleanString(product.id)),
  );
  const activeAutomationIds = automationIds.filter((id) => liveIds.has(id));

  if (!activeAutomationIds.length) {
    throw new Error("None of the selected products are live. Add at least one live product.");
  }

  const discountPercent = Math.max(0, Math.min(Number(bundleInput.discount_percent || 0), 95));
  const pricingType = cleanString(bundleInput.pricing_type || "monthly").toLowerCase();
  if (!["monthly", "one_time"].includes(pricingType)) {
    throw new Error("Bundle billing must be monthly or one-time.");
  }
  const discountMultiplier = 1 - discountPercent / 100;
  const selectedProducts = (products || []).filter((product: Record<string, unknown>) =>
    activeAutomationIds.includes(cleanString(product.id))
  );
  const baseUsd = selectedProducts.reduce((total: number, product: Record<string, unknown>) => {
    const currency = cleanString(product.currency || "USD").toUpperCase();
    const amount = Number(product.price_usd || (currency === "USD" ? product.price : 0) || 0);
    return total + amount;
  }, 0);
  const baseThb = selectedProducts.reduce((total: number, product: Record<string, unknown>) => {
    const currency = cleanString(product.currency || "").toUpperCase();
    const amount = Number(product.price_thb || (currency === "THB" ? product.price : 0) || 0);
    return total + amount;
  }, 0);

  const now = new Date().toISOString();
  const bundlePayload: Record<string, unknown> = {
    title,
    slug,
    status: cleanString(bundleInput.status || "draft") || "draft",
    discount_percent: discountPercent,
    category: cleanString(bundleInput.category || "Bundle") || "Bundle",
    badge: cleanString(bundleInput.badge || "Bundle") || "Bundle",
    icon: cleanString(bundleInput.icon || "PK") || "PK",
    color: cleanString(bundleInput.color || "cyan") || "cyan",
    short_description: cleanString(bundleInput.short_description),
    long_description: cleanString(bundleInput.long_description),
    outcome: cleanString(bundleInput.outcome),
    bundle_source: "manual",
    bundle_strategy: "admin_curated",
    pricing_type: pricingType,
    currency: cleanString(bundleInput.currency || "USD") || "USD",
    guided_install_enabled: false,
    included_count: activeAutomationIds.length,
    active_item_count: activeAutomationIds.length,
    base_amount_usd: Math.round(baseUsd * 100) / 100,
    discounted_amount_usd: Math.round(baseUsd * discountMultiplier * 100) / 100,
    price_usd: Math.round(baseUsd * discountMultiplier * 100) / 100,
    price_thb: baseThb ? Math.round(baseThb * discountMultiplier) : null,
    last_recalculated_at: now,
    updated_at: now,
  };

  const id = cleanString(bundleInput.id);
  if (id) bundlePayload.id = id;

  const { data: bundle, error: bundleError } = await adminClient
    .from("automation_bundles")
    .upsert(bundlePayload, { onConflict: id ? "id" : "slug" })
    .select("*")
    .single();

  if (bundleError) throw bundleError;

  const bundleId = bundle.id;
  const { error: deleteError } = await adminClient
    .from("automation_bundle_items")
    .delete()
    .eq("bundle_id", bundleId);

  if (deleteError) throw deleteError;

  const rows = activeAutomationIds.map((automationId, index) => ({
    bundle_id: bundleId,
    automation_id: automationId,
    position: index + 1,
    status: "active",
    include_in_price: true,
    updated_at: now,
  }));

  const { error: insertError } = await adminClient
    .from("automation_bundle_items")
    .insert(rows);

  if (insertError) throw insertError;

  const { data: savedItems, error: verifyError } = await adminClient
    .from("automation_bundle_items")
    .select("automation_id,status,position")
    .eq("bundle_id", bundleId)
    .eq("status", "active")
    .order("position", { ascending: true });

  if (verifyError) throw verifyError;

  const savedIds = new Set((savedItems || []).map((item: Record<string, unknown>) => cleanString(item.automation_id)));
  const missing = activeAutomationIds.filter((automationId) => !savedIds.has(automationId));

  if (missing.length) {
    throw new Error(`Bundle save failed verification. ${missing.length} selected product${missing.length === 1 ? "" : "s"} did not save.`);
  }

  return { bundle, items: savedItems || [] };
}

function calculateBundleDisplayPrices(bundle: Record<string, unknown>, products: Record<string, unknown>[]) {
  const discountPercent = Math.max(0, Math.min(Number(bundle.discount_percent || 0), 95));
  const discountMultiplier = 1 - discountPercent / 100;
  const summedUsd = products.reduce((total, product) => {
    const currency = cleanString(product.currency || "USD").toUpperCase();
    const amount = Number(product.price_usd || (currency === "USD" ? product.price : 0) || 0);
    return total + amount;
  }, 0);
  const summedThb = products.reduce((total, product) => {
    const currency = cleanString(product.currency || "").toUpperCase();
    const amount = Number(product.price_thb || (currency === "THB" ? product.price : 0) || 0);
    return total + amount;
  }, 0);
  const computedUsd = Math.round(summedUsd * discountMultiplier * 100) / 100;
  const computedThb = Math.round(summedThb * discountMultiplier);
  const priceUsd = computedUsd > 0
    ? computedUsd
    : Number(bundle.price_usd || bundle.discounted_amount_usd || 0);
  const priceThb = computedThb > 0
    ? computedThb
    : Number(bundle.price_thb || 0);
  const priceOverride = Number(bundle.price_override || 0);

  return {
    active_item_count: products.length,
    base_amount_usd: Math.round(summedUsd * 100) / 100,
    discounted_amount_usd: priceUsd,
    price_usd: priceUsd,
    price_thb: priceThb || null,
    price: priceOverride || priceUsd || priceThb || Number(bundle.price || 0),
    price_source: priceOverride ? "bundle_price_override" : "active_bundle_products",
  };
}

async function listBundles(adminClient: any) {
  const { data: bundles, error: bundlesError } = await adminClient
    .from("automation_bundles")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);

  if (bundlesError) throw bundlesError;

  const bundleRows = bundles || [];
  const bundleIds = bundleRows
    .map((bundle: Record<string, unknown>) => cleanString(bundle.id))
    .filter(Boolean);

  if (!bundleIds.length) {
    return { bundles: [] };
  }

  const { data: items, error: itemsError } = await adminClient
    .from("automation_bundle_items")
    .select("*")
    .in("bundle_id", bundleIds)
    .order("position", { ascending: true });

  if (itemsError) throw itemsError;

  const itemRows = items || [];
  const automationIds = [...new Set(
    itemRows
      .map((item: Record<string, unknown>) => cleanString(item.automation_id))
      .filter(Boolean),
  )];

  let products: Record<string, unknown>[] = [];

  if (automationIds.length) {
    const { data: productRows, error: productsError } = await adminClient
      .from("automations")
      .select("id,title,slug,status,category,badge,short_description,pricing_type,price,price_usd,price_thb,currency,color,icon,developer_id")
      .in("id", automationIds);

    if (productsError) throw productsError;
    products = productRows || [];
  }

  const productById = new Map(products.map((product) => [cleanString(product.id), product]));
  const itemsByBundleId = new Map<string, Record<string, unknown>[]>();

  for (const item of itemRows) {
    const bundleId = cleanString(item.bundle_id);
    const product = productById.get(cleanString(item.automation_id));
    const hydratedItem = {
      ...item,
      automations: product || null,
    };

    const existing = itemsByBundleId.get(bundleId) || [];
    existing.push(hydratedItem);
    itemsByBundleId.set(bundleId, existing);
  }

  const hydratedBundles = bundleRows.map((bundle: Record<string, unknown>) => {
    const bundleId = cleanString(bundle.id);
    const bundleItems = (itemsByBundleId.get(bundleId) || [])
      .filter((item) => cleanString(item.status || "active") === "active")
      .sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
    const bundleProducts = bundleItems
      .map((item) => item.automations)
      .filter(Boolean);
    const priceFields = calculateBundleDisplayPrices(bundle, bundleProducts);

    return {
      ...bundle,
      ...priceFields,
      is_bundle: true,
      item_type: "bundle",
      automation_bundle_items: bundleItems,
      bundle_products: bundleProducts,
    };
  });

  return { bundles: hydratedBundles };
}

async function listPublicBundles(adminClient: any, slug = "") {
  let query = adminClient
    .from("automation_bundles")
    .select("*")
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(slug ? 1 : 20);

  if (slug) query = query.eq("slug", slug);

  const { data: bundles, error: bundlesError } = await query;
  if (bundlesError) throw bundlesError;

  const bundleRows = bundles || [];
  const bundleIds = bundleRows
    .map((bundle: Record<string, unknown>) => cleanString(bundle.id))
    .filter(Boolean);

  if (!bundleIds.length) {
    return slug ? { bundle: null } : { bundles: [] };
  }

  const { data: items, error: itemsError } = await adminClient
    .from("automation_bundle_items")
    .select("*")
    .in("bundle_id", bundleIds)
    .eq("status", "active")
    .order("position", { ascending: true });

  if (itemsError) throw itemsError;

  const itemRows = items || [];
  const automationIds = [...new Set(
    itemRows
      .map((item: Record<string, unknown>) => cleanString(item.automation_id))
      .filter(Boolean),
  )];

  let products: Record<string, unknown>[] = [];

  if (automationIds.length) {
    const { data: productRows, error: productsError } = await adminClient
      .from("automations")
      .select(`
        id,
        status,
        created_at,
        updated_at,
        title,
        slug,
        category,
        badge,
        short_description,
        delivery_time,
        setup_type,
        pricing_type,
        price,
        price_usd,
        price_thb,
        setup_fee,
        setup_fee_usd,
        setup_fee_thb,
        currency,
        rating,
        review_count,
        color,
        icon,
        listing_type,
        guided_install_enabled,
        n8n_last_test_status,
        n8n_last_tested_at,
        health_status,
        health_last_checked_at,
        best_for,
        outputs,
        required_tools,
        developer_id,
        developers(id, display_name, avatar_letter, type, rating, handle)
      `)
      .in("id", automationIds)
      .in("status", ["live", "active", "published"]);

    if (productsError) throw productsError;
    products = productRows || [];
  }

  const productById = new Map(products.map((product) => [cleanString(product.id), product]));
  const itemsByBundleId = new Map<string, Record<string, unknown>[]>();

  for (const item of itemRows) {
    const product = productById.get(cleanString(item.automation_id));
    if (!product) continue;

    const bundleId = cleanString(item.bundle_id);
    const hydratedItem = {
      ...item,
      automations: product,
    };
    const existing = itemsByBundleId.get(bundleId) || [];
    existing.push(hydratedItem);
    itemsByBundleId.set(bundleId, existing);
  }

  const hydratedBundles = bundleRows.map((bundle: Record<string, unknown>) => {
    const bundleId = cleanString(bundle.id);
    const bundleItems = (itemsByBundleId.get(bundleId) || [])
      .sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
    const bundleProducts = bundleItems
      .map((item) => item.automations)
      .filter(Boolean);
    const priceFields = calculateBundleDisplayPrices(bundle, bundleProducts);

    return {
      ...bundle,
      ...priceFields,
      is_bundle: true,
      item_type: "bundle",
      listing_type: "bundle",
      automation_bundle_items: bundleItems,
      bundle_products: bundleProducts,
      delivery_time: `${bundleProducts.length || Number(bundle.active_item_count || 0)} included workflows`,
    };
  });

  return slug
    ? { bundle: hydratedBundles[0] || null }
    : { bundles: hydratedBundles };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return jsonResponse({ ok: true });
  if (req.method !== "POST") return errorResponse("Method not allowed.", 405);

  try {
    const payload = await req.json().catch(() => ({}));
    const action = cleanString(payload.action || "save_bundle");

    if (action === "get_public_bundle" || action === "list_public_bundles") {
      const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
      const data = await listPublicBundles(
        adminClient,
        action === "get_public_bundle" ? cleanString(payload.slug) : "",
      );
      return jsonResponse({ ok: true, ...data });
    }

    const { adminClient, error } = await requireAdmin(req);
    if (error || !adminClient) return errorResponse(error || "Admin access required.", 403);

    if (action === "list_bundles") {
      const data = await listBundles(adminClient);
      return jsonResponse({ ok: true, ...data });
    }

    if (action !== "save_bundle") {
      return errorResponse("Unknown admin bundle action.", 400);
    }

    const data = await saveBundle(adminClient, payload);
    return jsonResponse({ ok: true, ...data });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "Could not save bundle.");
    return errorResponse(message, 500);
  }
});
