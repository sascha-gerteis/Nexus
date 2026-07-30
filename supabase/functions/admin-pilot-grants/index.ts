import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import { isLegacyNexusProduct } from "../_shared/legacy-nexus-products.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const PILOT_PRICE_SOURCE = "admin_pilot";
const PILOT_MODES = new Set(["buyer_setup", "output_only"]);

function cleanString(value: unknown) {
  return String(value || "").trim();
}

function lowerString(value: unknown) {
  return cleanString(value).toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

function one(value: any) {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function isPassingWorkflowTest(status: unknown) {
  return [
    "passed",
    "passed_with_expected_test_callback_error",
    "passed_with_expected_test_input_error",
  ].includes(lowerString(status));
}

function hasAttachedCheckoutFlow(product: any) {
  return Boolean(
    product?.n8n_workflow_json ||
      cleanString(product?.n8n_workflow_id) ||
      cleanString(product?.runtime_webhook_url || product?.n8n_webhook_url),
  );
}

function pilotReadinessIssue(product: any) {
  if (!product || lowerString(product.status) !== "live") {
    return "This product is not live.";
  }

  if (lowerString(product.listing_type) === "custom_request") {
    return "Custom-request listings cannot be granted as a product pilot.";
  }

  if (!hasAttachedCheckoutFlow(product)) {
    return "This product has no runnable workflow attached.";
  }

  if (isLegacyNexusProduct(product)) return "";

  const runtimeType = lowerString(product.runtime_type);
  const hasN8nWorkflow = Boolean(
    product?.n8n_workflow_json ||
      cleanString(product?.n8n_workflow_id) ||
      cleanString(product?.runtime_webhook_url || product?.n8n_webhook_url),
  );

  if (runtimeType !== "n8n_managed" && !hasN8nWorkflow) return "";

  if (lowerString(product.n8n_import_status) !== "imported") {
    return "This product is not fully imported.";
  }

  if (!isPassingWorkflowTest(product.n8n_last_test_status)) {
    return "This product needs a passing technical test.";
  }

  return "";
}

async function requireOwnerAdmin(req: Request) {
  const authHeader = req.headers.get("Authorization") || "";

  if (!authHeader.startsWith("Bearer ")) {
    return { user: null, profile: null, error: "Missing auth token." };
  }

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return { user: null, profile: null, error: "Missing Supabase function secrets." };
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  });

  const token = authHeader.replace("Bearer ", "");
  const { data, error } = await userClient.auth.getUser(token);

  if (error || !data?.user) {
    return { user: null, profile: null, error: "Invalid auth token." };
  }

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("id, email, role, full_name")
    .eq("id", data.user.id)
    .maybeSingle();

  if (profileError) {
    return { user: data.user, profile: null, error: profileError.message };
  }

  if (lowerString(profile?.role) !== "admin") {
    return { user: data.user, profile, error: "Owner admin access required." };
  }

  return { user: data.user, profile, error: null };
}

async function loadBuyers(adminClient: any) {
  const { data: profiles, error: profilesError } = await adminClient
    .from("profiles")
    .select("id, email, full_name, role, created_at")
    .eq("role", "buyer")
    .order("created_at", { ascending: false })
    .limit(500);

  if (profilesError) throw new Error(profilesError.message);

  const buyerIds = (profiles || []).map((profile: any) => profile.id).filter(Boolean);
  let buyerProfiles: any[] = [];

  if (buyerIds.length) {
    const { data, error } = await adminClient
      .from("buyer_profiles")
      .select("user_id, name, email, company, website")
      .in("user_id", buyerIds);

    if (error) throw new Error(error.message);
    buyerProfiles = data || [];
  }

  const buyerProfileById = new Map(
    buyerProfiles.map((profile: any) => [profile.user_id, profile]),
  );

  return (profiles || []).map((profile: any) => {
    const buyerProfile = buyerProfileById.get(profile.id) || {};

    return {
      id: profile.id,
      email: cleanString(buyerProfile.email || profile.email),
      name: cleanString(buyerProfile.name || profile.full_name),
      company: cleanString(buyerProfile.company),
      website: cleanString(buyerProfile.website),
      created_at: profile.created_at,
    };
  });
}

async function loadPilotProducts(adminClient: any, includeWorkflowJson = false) {
  const { data, error } = await adminClient
    .from("automations")
    .select(`
      id,
      title,
      slug,
      short_description,
      category,
      icon,
      color,
      status,
      listing_type,
      developer_id,
      setup_schema,
      credential_schema,
      runtime_type,
      runtime_trigger_mode,
      runtime_run_frequency,
      runtime_no_change_policy,
      runtime_response_mode,
      runtime_output_mode,
      runtime_webhook_url,
      runtime_webhook_path,
      n8n_webhook_url,
      n8n_workflow_id,
      n8n_workflow_name,
      n8n_workflow_json,
      n8n_import_status,
      n8n_last_test_status,
      developers(id, display_name, handle)
    `)
    .eq("status", "live")
    .order("title", { ascending: true })
    .limit(500);

  if (error) throw new Error(error.message);

  return (data || [])
    .filter((product: any) => !pilotReadinessIssue(product))
    .map((product: any) => ({
      ...product,
      n8n_workflow_json: includeWorkflowJson ? product.n8n_workflow_json : undefined,
      developer: one(product.developers),
      developers: undefined,
    }));
}

async function loadRecentPilotGrants(adminClient: any) {
  const { data: orders, error: ordersError } = await adminClient
    .from("orders")
    .select(`
      id,
      buyer_id,
      automation_id,
      automation_title,
      install_type,
      buyer_name,
      buyer_email,
      buyer_company,
      price_display,
      price_source,
      payment_status,
      order_status,
      setup_notes,
      created_at,
      updated_at
    `)
    .eq("price_source", PILOT_PRICE_SOURCE)
    .order("created_at", { ascending: false })
    .limit(100);

  if (ordersError) throw new Error(ordersError.message);

  const orderIds = (orders || []).map((order: any) => order.id).filter(Boolean);
  let customerAutomations: any[] = [];

  if (orderIds.length) {
    const { data, error } = await adminClient
      .from("customer_automations")
      .select(`
        id,
        order_id,
        buyer_id,
        automation_id,
        name,
        install_type,
        status,
        setup_status,
        runtime_status,
        health_status,
        last_error_message,
        created_at,
        updated_at
      `)
      .in("order_id", orderIds);

    if (error) throw new Error(error.message);
    customerAutomations = data || [];
  }

  const customerAutomationByOrderId = new Map(
    customerAutomations.map((item: any) => [item.order_id, item]),
  );

  return (orders || []).map((order: any) => ({
    order,
    customer_automation: customerAutomationByOrderId.get(order.id) || null,
    mode: lowerString(order.install_type) === "admin_managed_pilot"
      ? "output_only"
      : "buyer_setup",
  }));
}

async function loadBuyer(adminClient: any, buyerId: string) {
  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("id, email, full_name, role")
    .eq("id", buyerId)
    .maybeSingle();

  if (profileError) throw new Error(profileError.message);
  if (!profile || lowerString(profile.role) !== "buyer") {
    throw new Error("Select a valid buyer account.");
  }

  const { data: buyerProfile, error: buyerProfileError } = await adminClient
    .from("buyer_profiles")
    .select("user_id, name, email, company, website")
    .eq("user_id", buyerId)
    .maybeSingle();

  if (buyerProfileError) throw new Error(buyerProfileError.message);

  return {
    id: profile.id,
    email: cleanString(buyerProfile?.email || profile.email),
    name: cleanString(buyerProfile?.name || profile.full_name),
    company: cleanString(buyerProfile?.company),
    website: cleanString(buyerProfile?.website),
  };
}

async function loadProduct(adminClient: any, automationId: string) {
  const products = await loadPilotProducts(adminClient, true);
  const product = products.find((item: any) => item.id === automationId) || null;

  if (!product) {
    throw new Error("Select a live, technically ready product.");
  }

  const readinessIssue = pilotReadinessIssue(product);
  if (readinessIssue) throw new Error(readinessIssue);
  return product;
}

async function findExistingPilot(
  adminClient: any,
  buyerId: string,
  automationId: string,
) {
  const { data: order, error } = await adminClient
    .from("orders")
    .select("*")
    .eq("buyer_id", buyerId)
    .eq("automation_id", automationId)
    .eq("price_source", PILOT_PRICE_SOURCE)
    .eq("payment_status", "paid")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!order) return null;

  const { data: customerAutomation, error: customerAutomationError } = await adminClient
    .from("customer_automations")
    .select("*")
    .eq("order_id", order.id)
    .eq("buyer_id", buyerId)
    .eq("automation_id", automationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (customerAutomationError) throw new Error(customerAutomationError.message);

  return {
    order,
    customer_automation: customerAutomation || null,
  };
}

function customerAutomationPayload(order: any, product: any, buyerId: string, mode: string) {
  const outputOnly = mode === "output_only";

  return {
    order_id: order.id,
    buyer_id: buyerId,
    automation_id: product.id,
    developer_id: product.developer_id || product.developer?.id || null,
    name: product.title || "Pilot automation",
    status: outputOnly ? "waiting_for_nexus" : "pending_setup",
    install_type: outputOnly ? "admin_managed_pilot" : "self_serve",
    setup_status: outputOnly ? "admin_managed" : "setup_required",
    runtime_status: "not_started",
    health_status: "not_configured",
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

async function createCustomerAutomation(
  adminClient: any,
  order: any,
  product: any,
  buyerId: string,
  mode: string,
) {
  const payload = customerAutomationPayload(order, product, buyerId, mode);
  let result = await adminClient
    .from("customer_automations")
    .insert(payload)
    .select()
    .single();

  if (!result.error) return result.data;

  const compatiblePayload = { ...payload };
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
    delete compatiblePayload[key];
  }

  result = await adminClient
    .from("customer_automations")
    .insert(compatiblePayload)
    .select()
    .single();

  if (result.error) throw new Error(result.error.message);
  return result.data;
}

async function grantPilot(adminClient: any, adminUser: any, body: any) {
  const buyerId = cleanString(body.buyer_id || body.buyerId);
  const automationId = cleanString(body.automation_id || body.automationId);
  const mode = lowerString(body.mode);
  const note = cleanString(body.note).slice(0, 2000);

  if (!buyerId || !automationId) {
    throw new Error("A buyer and product are required.");
  }

  if (!PILOT_MODES.has(mode)) {
    throw new Error("Choose whether the buyer completes setup or Nexus prepares the output.");
  }

  const [buyer, product] = await Promise.all([
    loadBuyer(adminClient, buyerId),
    loadProduct(adminClient, automationId),
  ]);

  const existing = await findExistingPilot(adminClient, buyerId, automationId);

  if (existing?.customer_automation) {
    return {
      ok: true,
      existing: true,
      message: "This buyer already has this complimentary pilot.",
      ...existing,
    };
  }

  if (existing?.order) {
    const recoveredCustomerAutomation = await createCustomerAutomation(
      adminClient,
      existing.order,
      product,
      buyerId,
      lowerString(existing.order.install_type) === "admin_managed_pilot"
        ? "output_only"
        : "buyer_setup",
    );

    return {
      ok: true,
      existing: true,
      recovered: true,
      message: "The existing pilot access was repaired without creating a duplicate order.",
      order: existing.order,
      customer_automation: recoveredCustomerAutomation,
    };
  }

  const now = nowIso();
  const outputOnly = mode === "output_only";
  const installType = outputOnly ? "admin_managed_pilot" : "self_serve";
  const setupNotes = note;

  const { data: order, error: orderError } = await adminClient
    .from("orders")
    .insert({
      buyer_id: buyerId,
      automation_id: product.id,
      developer_id: product.developer_id || product.developer?.id || null,
      automation_title: product.title,
      install_type: installType,
      selected_customization: "",
      currency: "USD",
      price_display: "Complimentary pilot",
      payment_status: "paid",
      order_status: outputOnly ? "pilot_preparing" : "setup_requested",
      buyer_name: buyer.name,
      buyer_email: buyer.email,
      buyer_company: buyer.company,
      buyer_website: buyer.website,
      setup_notes: setupNotes,
      stripe_mode: "payment",
      stripe_payment_status: "paid",
      stripe_currency: "usd",
      stripe_amount_total: 0,
      stripe_unit_amount: 0,
      price_source: PILOT_PRICE_SOURCE,
      derived_price: false,
      order_type: "automation",
      paid_at: now,
      created_at: now,
      updated_at: now,
    })
    .select()
    .single();

  if (orderError || !order) {
    throw new Error(orderError?.message || "Could not create the pilot order.");
  }

  let customerAutomation: any = null;

  try {
    customerAutomation = await createCustomerAutomation(
      adminClient,
      order,
      product,
      buyerId,
      mode,
    );
  } catch (error) {
    await adminClient
      .from("orders")
      .delete()
      .eq("id", order.id)
      .eq("buyer_id", buyerId)
      .eq("automation_id", automationId)
      .eq("price_source", PILOT_PRICE_SOURCE);
    throw error;
  }

  const eventTitle = outputOnly
    ? "Your complimentary pilot is being prepared"
    : "Your complimentary pilot is ready for setup";
  const eventMessage = outputOnly
    ? `${product.title} was added to your Nexus account. Nexus is completing setup and the output will appear in your dashboard when it is ready.`
    : `${product.title} was added to your Nexus account. Complete its setup form in your dashboard to start the pilot.`;

  const { error: eventError } = await adminClient.from("automation_events").insert({
    customer_automation_id: customerAutomation.id,
    buyer_id: buyerId,
    automation_id: automationId,
    order_id: order.id,
    event_type: "pilot_product_granted",
    title: eventTitle,
    message: eventMessage,
    created_by: adminUser.id,
    created_at: nowIso(),
  });

  if (eventError) {
    console.warn("Pilot grant event could not be recorded:", eventError.message);
  }

  return {
    ok: true,
    existing: false,
    message: outputOnly
      ? "Pilot granted. Open the order to complete setup and run it for the buyer."
      : "Pilot granted. The buyer can now complete setup from their dashboard.",
    order,
    customer_automation: customerAutomation,
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
      message: "admin-pilot-grants is alive.",
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed.", 405);
  }

  try {
    const { user, profile, error: authError } = await requireOwnerAdmin(req);

    if (authError || !user || !profile) {
      return errorResponse(authError || "Owner admin access required.", 401);
    }

    const body = await req.json().catch(() => ({}));
    const action = lowerString(body.action || "list");
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    if (action === "list") {
      const [buyers, products, grants] = await Promise.all([
        loadBuyers(adminClient),
        loadPilotProducts(adminClient),
        loadRecentPilotGrants(adminClient),
      ]);

      return jsonResponse({
        ok: true,
        buyers,
        products,
        grants,
      });
    }

    if (action === "grant") {
      const result = await grantPilot(adminClient, user, body);
      return jsonResponse(result);
    }

    return errorResponse("Unknown action.", 400);
  } catch (error) {
    console.error("admin-pilot-grants failed:", error);

    return errorResponse(
      error instanceof Error ? error.message : "Could not manage the pilot grant.",
      400,
    );
  }
});
