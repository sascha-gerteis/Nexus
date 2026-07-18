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

function isMonthlyOrder(order: any) {
  return Boolean(
    order?.stripe_mode === "subscription" ||
      order?.stripe_subscription_id ||
      String(order?.price_display || "").toLowerCase().includes("/mo"),
  );
}

function one(value: any) {
  return Array.isArray(value) ? value[0] || null : value || null;
}

function cleanString(value: unknown) {
  return String(value || "").trim();
}

function rowUpdatedTime(row: any) {
  const time = Date.parse(row?.updated_at || row?.created_at || "");
  return Number.isFinite(time) ? time : 0;
}

function isArchivedCustomerAutomationRow(row: any) {
  const values = [
    row?.status,
    row?.setup_status,
    row?.runtime_status,
    row?.health_status,
  ].map((value) => cleanString(value).toLowerCase());

  return values.some((value) =>
    value.includes("archived") ||
    value.includes("deleted") ||
    value.includes("removed") ||
    value.includes("cancelled")
  );
}

function scoreCustomerAutomationRow(row: any) {
  let score = rowUpdatedTime(row);

  if (row?.runtime_webhook_url || row?.runtime_webhook_path || row?.n8n_workflow_id) score += 1_000_000;
  if (row?.last_error_message || cleanString(row?.runtime_status).toLowerCase().includes("error")) score -= 500_000;
  if (isArchivedCustomerAutomationRow(row)) score -= 10_000_000_000_000;

  return score;
}

function productWorkflowId(product: any) {
  return cleanString(product?.n8n_workflow_id);
}

function productWebhookUrl(product: any) {
  return cleanString(product?.runtime_webhook_url || product?.n8n_webhook_url);
}

function productWebhookPath(product: any) {
  return cleanString(product?.runtime_webhook_path || product?.n8n_webhook_path);
}

function existingHasCustomerRuntime(existing: any, product: any) {
  const existingWorkflowId = cleanString(existing?.n8n_workflow_id);
  const existingWebhookUrl = cleanString(existing?.runtime_webhook_url || existing?.n8n_webhook_url);
  const existingWebhookPath = cleanString(existing?.runtime_webhook_path || existing?.n8n_webhook_path);
  const masterWorkflowId = productWorkflowId(product);
  const masterWebhookUrl = productWebhookUrl(product);
  const masterWebhookPath = productWebhookPath(product);

  if (!existingWorkflowId) return false;
  if (masterWorkflowId && existingWorkflowId === masterWorkflowId) return false;
  if (masterWebhookUrl && existingWebhookUrl && existingWebhookUrl === masterWebhookUrl) return false;
  if (masterWebhookPath && existingWebhookPath && existingWebhookPath === masterWebhookPath) return false;

  return true;
}

function existingHasAnyRuntimeTarget(existing: any) {
  return Boolean(
    cleanString(existing?.n8n_workflow_id) ||
      cleanString(existing?.runtime_webhook_url || existing?.n8n_webhook_url) ||
      cleanString(existing?.runtime_webhook_path || existing?.n8n_webhook_path)
  );
}

function productRuntimeChangedSinceCustomerSync(existing: any, product: any) {
  if (!existing?.id) return false;

  const productUpdatedAt = Date.parse(product?.updated_at || product?.created_at || "");
  const customerUpdatedAt = Date.parse(existing?.updated_at || existing?.created_at || "");

  if (!Number.isFinite(productUpdatedAt) || !Number.isFinite(customerUpdatedAt)) {
    return false;
  }

  return productUpdatedAt > customerUpdatedAt + 1000;
}

function normalizeRuntimeTriggerMode(product: any, isSubscription: boolean) {
  const raw = cleanString(product?.runtime_trigger_mode || product?.trigger_mode).toLowerCase();

  if (["on_demand", "on-demand", "chat", "manual_trigger"].includes(raw)) return "on_demand";
  if (["scheduled", "recurring", "monthly", "daily", "weekly"].includes(raw)) return "scheduled";
  if (isSubscription) return "scheduled";

  return "setup";
}

function normalizeRunFrequency(product: any, order: any) {
  const raw = cleanString(product?.runtime_run_frequency || product?.run_frequency || product?.frequency).toLowerCase();

  if (["daily", "weekly", "monthly", "quarterly"].includes(raw)) return raw;
  return isMonthlyOrder(order) ? "monthly" : "manual";
}

async function loadBundleProducts(adminClient: any, order: any) {
  const { data: orderItems, error: itemError } = await adminClient
    .from("order_items")
    .select("*, automations(*)")
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

  const bundleId = cleanString(order.bundle_id);
  if (!bundleId) return [];

  const { data: bundleItems, error } = await adminClient
    .from("automation_bundle_items")
    .select("*, automations!automation_bundle_items_automation_id_fkey(*)")
    .eq("bundle_id", bundleId)
    .eq("status", "active")
    .order("position", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return (bundleItems || [])
    .map((item: any) => ({
      item,
      product: one(item.automations),
    }))
    .filter((entry: any) => entry.product?.id);
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

  if (order.order_type === "bundle" || order.bundle_id) {
    return ensureBundleForOrder(adminClient, order);
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
    const updatePayload = {
      install_type: installType,
      run_frequency: isMonthlyOrder(order) ? "monthly" : existing.run_frequency || "manual",
      updated_at: nowIso(),
    };

    let result = await adminClient
      .from("customer_automations")
      .update(updatePayload)
      .eq("id", existing.id)
      .select()
      .single();

    if (result.error) {
      result = await adminClient
        .from("customer_automations")
        .update({
          install_type: installType,
          updated_at: nowIso(),
        })
        .eq("id", existing.id)
        .select()
        .single();
    }

    if (result.error) {
      throw new Error(result.error.message);
    }

    return result.data;
  }

  const createPayload: Record<string, unknown> = {
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
    run_frequency: isMonthlyOrder(order) ? "monthly" : "manual",
    schedule_status: "inactive",
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  let createResult = await adminClient
    .from("customer_automations")
    .insert(createPayload)
    .select()
    .single();

  if (createResult.error) {
    const fallbackPayload = { ...createPayload };
    delete fallbackPayload.run_frequency;
    delete fallbackPayload.schedule_status;

    createResult = await adminClient
      .from("customer_automations")
      .insert(fallbackPayload)
      .select()
      .single();
  }

  if (createResult.error) {
    throw new Error(createResult.error.message);
  }

  const created = createResult.data;

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

async function upsertBundleCustomerAutomation(adminClient: any, order: any, product: any, existing: any) {
  const installType = normalizeInstallType(order.install_type);
  const setupStatus = setupStatusForInstallType(installType);
  const status = statusForInstallType(installType);
  const runFrequency = normalizeRunFrequency(product, order);
  const hasCustomerRuntime = existingHasCustomerRuntime(existing, product);
  const productRuntimeChanged = productRuntimeChangedSinceCustomerSync(existing, product);
  const shouldResetRuntimeState = Boolean(
    existing?.id &&
      (productRuntimeChanged || (!hasCustomerRuntime && existingHasAnyRuntimeTarget(existing)))
  );

  const payload: Record<string, unknown> = {
    order_id: order.id,
    buyer_id: order.buyer_id,
    automation_id: product.id,
    developer_id: product.developer_id || null,
    bundle_id: order.bundle_id || null,
    name: product.title || "Bundle automation",
    status: existing?.status || status,
    install_type: installType,
    setup_status: existing?.setup_status || setupStatus,
    runtime_type: product.runtime_type || existing?.runtime_type || "manual",
    runtime_trigger_mode: normalizeRuntimeTriggerMode(product, isMonthlyOrder(order)),
    /*
      Bundle children must not store the product/template workflow as if it
      were the buyer-specific runtime. If a customer clone already exists, keep
      it. Otherwise leave runtime fields empty so submit-automation-setup
      provisions from the current product template before triggering.
    */
    runtime_webhook_url: hasCustomerRuntime ? existing?.runtime_webhook_url || null : null,
    runtime_webhook_path: hasCustomerRuntime ? existing?.runtime_webhook_path || null : null,
    runtime_output_mode: product.runtime_output_mode || existing?.runtime_output_mode || "standard",
    runtime_no_change_policy: product.runtime_no_change_policy || existing?.runtime_no_change_policy || "record_no_change",
    runtime_response_mode: product.runtime_response_mode || existing?.runtime_response_mode || "async",
    n8n_workflow_id: hasCustomerRuntime ? existing?.n8n_workflow_id || null : null,
    n8n_workflow_name: hasCustomerRuntime ? existing?.n8n_workflow_name || null : null,
    runtime_status: shouldResetRuntimeState ? "not_started" : existing?.runtime_status || "not_started",
    health_status: shouldResetRuntimeState ? "pending" : existing?.health_status || "not_configured",
    last_error_message: shouldResetRuntimeState ? null : existing?.last_error_message || null,
    run_frequency: runFrequency,
    schedule_status: existing?.schedule_status || "inactive",
    updated_at: nowIso(),
  };

  if (existing?.id) {
    let result = await adminClient
      .from("customer_automations")
      .update(payload)
      .eq("id", existing.id)
      .select()
      .single();

    if (result.error) {
      const fallbackPayload = { ...payload };
      delete fallbackPayload.runtime_trigger_mode;
      delete fallbackPayload.runtime_webhook_path;
      delete fallbackPayload.runtime_output_mode;
      delete fallbackPayload.runtime_no_change_policy;
      delete fallbackPayload.runtime_response_mode;
      delete fallbackPayload.n8n_workflow_name;
      delete fallbackPayload.run_frequency;
      delete fallbackPayload.schedule_status;

      result = await adminClient
        .from("customer_automations")
        .update(fallbackPayload)
        .eq("id", existing.id)
        .select()
        .single();
    }

    if (result.error) throw new Error(result.error.message);
    return result.data;
  }

  const insertPayload = {
    ...payload,
    created_at: nowIso(),
  };

  let result = await adminClient
    .from("customer_automations")
    .insert(insertPayload)
    .select()
    .single();

  if (result.error) {
    const fallbackPayload = { ...insertPayload };
    delete fallbackPayload.runtime_trigger_mode;
    delete fallbackPayload.runtime_webhook_path;
    delete fallbackPayload.runtime_output_mode;
    delete fallbackPayload.runtime_no_change_policy;
    delete fallbackPayload.runtime_response_mode;
    delete fallbackPayload.n8n_workflow_name;
    delete fallbackPayload.run_frequency;
    delete fallbackPayload.schedule_status;

    result = await adminClient
      .from("customer_automations")
      .insert(fallbackPayload)
      .select()
      .single();
  }

  if (result.error) throw new Error(result.error.message);

  await adminClient.from("automation_events").insert({
    customer_automation_id: result.data.id,
    buyer_id: order.buyer_id,
    automation_id: product.id,
    order_id: order.id,
    event_type: "bundle_workflow_created",
    title: "Bundle workflow unlocked",
    message: `${product.title || "This workflow"} is included in ${order.automation_title || "your bundle"}. Complete the bundle setup form to start it.`,
    created_by: "system",
    created_at: nowIso(),
  });

  return result.data;
}

async function ensureBundleForOrder(adminClient: any, order: any) {
  const { data: existingRows, error: existingError } = await adminClient
    .from("customer_automations")
    .select("*")
    .eq("order_id", order.id);

  if (existingError) {
    throw new Error(existingError.message);
  }

  const entries = await loadBundleProducts(adminClient, order);
  const existingByAutomationId = new Map();
  for (const row of existingRows || []) {
    if (!row?.automation_id || isArchivedCustomerAutomationRow(row)) continue;
    const current = existingByAutomationId.get(row.automation_id);

    if (!current || scoreCustomerAutomationRow(row) > scoreCustomerAutomationRow(current)) {
      existingByAutomationId.set(row.automation_id, row);
    }
  }

  const createdOrExisting = [];

  for (const entry of entries) {
    const product = entry.product || {};
    const existing = existingByAutomationId.get(product.id);
    const row = await upsertBundleCustomerAutomation(adminClient, order, product, existing);
    if (row) createdOrExisting.push(row);
  }

  return createdOrExisting;
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
      if (Array.isArray(automation)) {
        createdOrExisting.push(...automation);
      } else if (automation) {
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
