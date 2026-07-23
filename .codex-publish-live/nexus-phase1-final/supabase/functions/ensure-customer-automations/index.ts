import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function nowIso() {
  return new Date().toISOString();
}

function normalizeInstallType(value: unknown) {
  const raw = String(value || "self_serve").trim().toLowerCase();

  if (
    raw === "nexus_guided" ||
    raw === "nexus guided" ||
    raw === "nexus_install" ||
    raw === "guided_install" ||
    raw === "guided" ||
    raw === "nexus"
  ) {
    return "nexus_install";
  }

  return "self_serve";
}

function setupStatusForInstallType(installType: string) {
  return installType === "nexus_install"
    ? "guided_install_needed"
    : "requested";
}

function statusForInstallType(installType: string) {
  return installType === "nexus_install"
    ? "waiting_for_nexus_install"
    : "pending_setup";
}

async function requireUser(req: Request) {
  const authHeader = req.headers.get("Authorization") || "";

  if (!authHeader.startsWith("Bearer ")) {
    return { user: null, error: "Missing auth token." };
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
    return { user: null, error: "Invalid auth token." };
  }

  return {
    user: data.user,
    error: null,
  };
}

async function ensureForOrder(adminClient: any, order: any) {
  if (!order?.id) {
    return null;
  }

  const { data: existing, error: existingError } = await adminClient
    .from("customer_automations")
    .select("*")
    .eq("order_id", order.id)
    .maybeSingle();

  if (existingError) {
    throw new Error(existingError.message);
  }

  const installType = normalizeInstallType(order.install_type);
  const setupStatus = setupStatusForInstallType(installType);
  const status = statusForInstallType(installType);

  if (existing?.id) {
    const { data: updated, error: updateError } = await adminClient
      .from("customer_automations")
      .update({
        install_type: installType,
        updated_at: nowIso(),
      })
      .eq("id", existing.id)
      .select()
      .single();

    if (updateError) {
      throw new Error(updateError.message);
    }

    return updated;
  }

  const { data: created, error: createError } = await adminClient
    .from("customer_automations")
    .insert({
      order_id: order.id,
      buyer_id: order.buyer_id,
      automation_id: order.automation_id,
      developer_id: order.developer_id || null,
      name: order.automation_title || "Automation",
      status,
      install_type: installType,
      setup_status: setupStatus,
      runtime_status: "not_started",
      health_status: "not_configured",
      created_at: nowIso(),
      updated_at: nowIso(),
    })
    .select()
    .single();

  if (createError) {
    throw new Error(createError.message);
  }

  await adminClient.from("automation_events").insert({
    customer_automation_id: created.id,
    buyer_id: order.buyer_id,
    automation_id: order.automation_id,
    order_id: order.id,
    event_type: "customer_automation_created",
    title: "Automation access created",
    message:
      installType === "nexus_install"
        ? "Your Nexus Guided Install automation is ready for the install request form."
        : "Your automation setup page is ready.",
    created_by: "system",
    created_at: nowIso(),
  });

  return created;
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
      message: "ensure-customer-automations is alive.",
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed.", 405);
  }

  try {
    const { user, error: authError } = await requireUser(req);

    if (authError || !user) {
      return errorResponse(authError || "Login required.", 401);
    }

    const body = await req.json().catch(() => ({}));
    const orderId = String(body.order_id || "").trim();

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    let query = adminClient
      .from("orders")
      .select("*")
      .eq("buyer_id", user.id)
      .eq("payment_status", "paid")
      .order("created_at", { ascending: false });

    if (orderId) {
      query = query.eq("id", orderId);
    }

    const { data: orders, error: ordersError } = await query;

    if (ordersError) {
      return errorResponse(ordersError.message, 500);
    }

    const createdOrExisting = [];

    for (const order of orders || []) {
      const automation = await ensureForOrder(adminClient, order);
      if (automation) {
        createdOrExisting.push(automation);
      }
    }

    return jsonResponse({
      ok: true,
      automations: createdOrExisting,
      count: createdOrExisting.length,
    });
  } catch (error) {
    console.error(error);

    return errorResponse(
      error instanceof Error ? error.message : "Could not ensure customer automations.",
      500,
    );
  }
});