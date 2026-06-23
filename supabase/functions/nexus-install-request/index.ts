import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function nowIso() {
  return new Date().toISOString();
}

function cleanString(value: unknown) {
  return String(value || "").trim();
}

function subscriptionIsActive(order: any) {
  const paymentStatus = cleanString(order?.payment_status).toLowerCase();
  const subscriptionStatus = cleanString(order?.stripe_subscription_status).toLowerCase();
  const orderStatus = cleanString(order?.order_status).toLowerCase();

  if (paymentStatus !== "paid") return false;

  if (
    orderStatus.includes("cancel") ||
    orderStatus.includes("expired") ||
    orderStatus.includes("failed")
  ) {
    return false;
  }

  if (subscriptionStatus) {
    return subscriptionStatus === "active" || subscriptionStatus === "trialing";
  }

  return Boolean(order?.stripe_subscription_id || order?.stripe_mode === "subscription");
}

function isMonthlyOrder(order: any) {
  return Boolean(
    order?.stripe_mode === "subscription" ||
      order?.stripe_subscription_id ||
      cleanString(order?.price_display).toLowerCase().includes("/mo"),
  );
}

function hasRuntimeWebhook(customerAutomation: any) {
  return Boolean(
    cleanString(customerAutomation?.runtime_webhook_url) ||
      cleanString(customerAutomation?.n8n_webhook_url),
  );
}

function scheduleUpdateForCompletedInstall(order: any, customerAutomation: any) {
  if (!isMonthlyOrder(order)) return {};

  if (!subscriptionIsActive(order) || !hasRuntimeWebhook(customerAutomation)) {
    return {
      run_frequency: "monthly",
      schedule_status: "inactive",
    };
  }

  return {
    run_frequency: "monthly",
    schedule_status: "active",
    schedule_anchor_at: customerAutomation?.schedule_anchor_at || new Date().toISOString(),
    next_run_at: customerAutomation?.next_run_at || new Date().toISOString(),
  };
}

async function requireUser(req: Request) {
  const authHeader = req.headers.get("Authorization") || "";

  if (!authHeader.startsWith("Bearer ")) {
    return { user: null, profile: null, error: "Missing auth token." };
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const token = authHeader.replace("Bearer ", "");
  const { data, error } = await userClient.auth.getUser(token);

  if (error || !data?.user) {
    return { user: null, profile: null, error: "Invalid auth token." };
  }

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: profile } = await adminClient
    .from("profiles")
    .select("id, email, role, full_name")
    .eq("id", data.user.id)
    .maybeSingle();

  return {
    user: data.user,
    profile,
    error: null,
  };
}

async function requireAdmin(req: Request) {
  const { user, profile, error } = await requireUser(req);

  if (error || !user) {
    return { user: null, profile: null, error: error || "Login required." };
  }

  if (!profile || profile.role !== "admin") {
    return { user, profile, error: "Admin access required." };
  }

  return { user, profile, error: null };
}

async function requireDeveloper(req: Request, adminClient: any) {
  const { user, profile, error } = await requireUser(req);

  if (error || !user) {
    return { user: null, profile: null, developer: null, error: error || "Login required." };
  }

  if (!profile || profile.role !== "developer") {
    return { user, profile, developer: null, error: "Developer access required." };
  }

  const { data: developer, error: developerError } = await adminClient
    .from("developers")
    .select("*")
    .eq("profile_id", user.id)
    .maybeSingle();

  if (developerError) {
    return { user, profile, developer: null, error: developerError.message };
  }

  if (!developer) {
    return { user, profile, developer: null, error: "Developer profile not found." };
  }

  return { user, profile, developer, error: null };
}

function isGuidedInstallRow(row: any) {
  return Boolean(cleanString(row?.install_request?.id));
}

function developerOwnsInstallRow(row: any, developerId: string) {
  const id = cleanString(developerId);
  if (!id) return false;

  return cleanString(row?.order?.developer_id) === id ||
    cleanString(row?.automation?.developer_id) === id;
}

async function getBuyerInstallRequest(adminClient: any, userId: string, customerAutomationId: string) {
  let query = adminClient
    .from("customer_automations")
    .select(`
      *,
      automations(id, title, slug, icon, color, setup_schema, credential_schema),
      orders(id, buyer_name, buyer_email, buyer_company, payment_status, order_status, price_display, created_at)
    `)
    .eq("buyer_id", userId)
    .order("created_at", { ascending: false })
    .limit(1);

  if (customerAutomationId) {
    query = adminClient
      .from("customer_automations")
      .select(`
        *,
        automations(id, title, slug, icon, color, setup_schema, credential_schema),
        orders(id, buyer_name, buyer_email, buyer_company, payment_status, order_status, price_display, created_at)
      `)
      .eq("id", customerAutomationId)
      .eq("buyer_id", userId)
      .limit(1);
  }

  const { data, error } = await query;

  if (error) {
    throw new Error(error.message);
  }

  const customerAutomation = Array.isArray(data) ? data[0] : data;

  if (!customerAutomation) {
    return {
      customer_automation: null,
      install_request: null,
    };
  }

  const { data: request, error: requestError } = await adminClient
    .from("nexus_install_requests")
    .select("*")
    .eq("customer_automation_id", customerAutomation.id)
    .maybeSingle();

  if (requestError) {
    throw new Error(requestError.message);
  }

  return {
    customer_automation: customerAutomation,
    install_request: request || null,
  };
}

async function submitBuyerInstallRequest(adminClient: any, userId: string, body: any) {
  const customerAutomationId = cleanString(body.customer_automation_id);

  if (!customerAutomationId) {
    return errorResponse("customer_automation_id is required.", 400);
  }

  const { data: customerAutomation, error } = await adminClient
    .from("customer_automations")
    .select(`
      *,
      automations(id, title, slug),
      orders(id, buyer_name, buyer_email, buyer_company, payment_status, order_status)
    `)
    .eq("id", customerAutomationId)
    .eq("buyer_id", userId)
    .maybeSingle();

  if (error || !customerAutomation) {
    return errorResponse(error?.message || "Customer automation not found.", 404);
  }

  const now = nowIso();

  const payload = {
    customer_automation_id: customerAutomation.id,
    order_id: customerAutomation.order_id,
    automation_id: customerAutomation.automation_id,
    buyer_id: userId,

    contact_name: cleanString(body.contact_name),
    contact_email: cleanString(body.contact_email),
    contact_phone: cleanString(body.contact_phone),
    company_name: cleanString(body.company_name),

    technical_contact_name: cleanString(body.technical_contact_name),
    technical_contact_email: cleanString(body.technical_contact_email),
    technical_contact_phone: cleanString(body.technical_contact_phone),

    preferred_contact_method: cleanString(body.preferred_contact_method),
    preferred_contact_time: cleanString(body.preferred_contact_time),

    tools_involved: cleanString(body.tools_involved),
    account_access_notes: cleanString(body.account_access_notes),
    install_notes: cleanString(body.install_notes),

    status: "pending",
    updated_at: now,
  };

  if (!payload.contact_name || !payload.contact_email) {
    return errorResponse("Main contact name and email are required.", 400);
  }

  const { data: request, error: upsertError } = await adminClient
    .from("nexus_install_requests")
    .upsert(payload, {
      onConflict: "customer_automation_id",
    })
    .select()
    .single();

  if (upsertError) {
    return errorResponse(upsertError.message, 500);
  }

  await adminClient
    .from("customer_automations")
    .update({
      setup_status: "guided_install_requested",
      runtime_status: customerAutomation.runtime_status || "not_started",
      health_status: customerAutomation.health_status || "not_configured",
      updated_at: now,
    })
    .eq("id", customerAutomation.id);

  if (customerAutomation.order_id) {
    await adminClient
      .from("orders")
      .update({
        order_status: "guided_install_requested",
        updated_at: now,
      })
      .eq("id", customerAutomation.order_id);
  }

  await adminClient.from("automation_events").insert({
    customer_automation_id: customerAutomation.id,
    buyer_id: userId,
    automation_id: customerAutomation.automation_id,
    order_id: customerAutomation.order_id,
    event_type: "guided_install_requested",
    title: "Nexus Guided Install requested",
    message: `${payload.contact_name} submitted a guided install request.`,
    created_by: "buyer",
    created_at: now,
  });

  await adminClient.from("admin_notifications").insert({
    notification_type: "guided_install_requested",
    title: "New Nexus Guided Install request",
    message: `${payload.contact_name} submitted an install request for ${customerAutomation.automations?.title || "an automation"}.`,
    related_order_id: customerAutomation.order_id,
    related_customer_automation_id: customerAutomation.id,
    status: "unread",
    created_at: now,
  });

  return jsonResponse({
    ok: true,
    request,
    message: "Your Nexus Guided Install request was submitted. Nexus will contact you to complete setup.",
  });
}

async function listAdminOrders(adminClient: any) {
  const { data: orders, error: ordersError } = await adminClient
    .from("orders")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(300);

  if (ordersError) {
    throw new Error(ordersError.message);
  }

  const orderIds = (orders || []).map((item: any) => item.id).filter(Boolean);
  const automationIds = (orders || []).map((item: any) => item.automation_id).filter(Boolean);

  const { data: customerAutomations, error: caError } = await adminClient
    .from("customer_automations")
    .select("*")
    .in("order_id", orderIds.length ? orderIds : ["00000000-0000-0000-0000-000000000000"]);

  if (caError) {
    throw new Error(caError.message);
  }

  const customerAutomationIds = (customerAutomations || []).map((item: any) => item.id).filter(Boolean);

  const { data: installRequests, error: installError } = await adminClient
    .from("nexus_install_requests")
    .select("*")
    .in("customer_automation_id", customerAutomationIds.length ? customerAutomationIds : ["00000000-0000-0000-0000-000000000000"]);

  if (installError) {
    throw new Error(installError.message);
  }

  const { data: automations, error: automationError } = await adminClient
    .from("automations")
    .select(`
      id,
      title,
      slug,
      icon,
      color,
      developer_id,
      status,
      setup_schema,
      credential_schema,
      runtime_type,
      runtime_webhook_url,
      runtime_webhook_path,
      n8n_workflow_id,
      n8n_workflow_name
    `)
    .in("id", automationIds.length ? automationIds : ["00000000-0000-0000-0000-000000000000"]);

  if (automationError) {
    throw new Error(automationError.message);
  }

  const { data: setupSubmissions, error: setupError } = await adminClient
    .from("automation_setup_submissions")
    .select("*")
    .in("customer_automation_id", customerAutomationIds.length ? customerAutomationIds : ["00000000-0000-0000-0000-000000000000"])
    .order("created_at", { ascending: false });

  if (setupError) {
    console.warn("Could not load setup submissions:", setupError.message);
  }

  const automationById = new Map((automations || []).map((item: any) => [item.id, item]));
  const caByOrderId = new Map((customerAutomations || []).map((item: any) => [item.order_id, item]));
  const requestByCustomerAutomationId = new Map((installRequests || []).map((item: any) => [item.customer_automation_id, item]));
  const latestSetupByCustomerAutomationId = new Map();

  for (const submission of setupSubmissions || []) {
    if (!latestSetupByCustomerAutomationId.has(submission.customer_automation_id)) {
      latestSetupByCustomerAutomationId.set(submission.customer_automation_id, submission);
    }
  }

  const rows = (orders || []).map((order: any) => {
    const customerAutomation = caByOrderId.get(order.id) || null;
    const installRequest = customerAutomation
      ? requestByCustomerAutomationId.get(customerAutomation.id) || null
      : null;

    return {
      order,
      automation: automationById.get(order.automation_id) || null,
      customer_automation: customerAutomation,
      install_request: installRequest,
      latest_setup_submission: customerAutomation
        ? latestSetupByCustomerAutomationId.get(customerAutomation.id) || null
        : null,
    };
  });

  return rows;
}

async function listDeveloperOrders(adminClient: any, developer: any) {
  const rows = await listAdminOrders(adminClient);
  const developerId = cleanString(developer?.id);

  return rows.filter((row: any) =>
    developerOwnsInstallRow(row, developerId) &&
    isGuidedInstallRow(row)
  );
}

async function updateAdminInstallRequest(adminClient: any, userId: string, body: any, actor = "admin") {
  const installRequestId = cleanString(body.install_request_id);
  const customerAutomationId = cleanString(body.customer_automation_id);
  const orderId = cleanString(body.order_id);
  const status = cleanString(body.status);
  const adminNotes = cleanString(body.admin_notes);
  const actorLabel = actor === "developer" ? "Developer" : "Admin";

  if (!installRequestId && !customerAutomationId && !orderId) {
    return errorResponse("install_request_id, customer_automation_id, or order_id is required.", 400);
  }

  if (!status) {
    return errorResponse("status is required.", 400);
  }

  const allowed = new Set([
    "pending",
    "contacted",
    "in_progress",
    "blocked",
    "completed",
    "cancelled",
  ]);

  if (!allowed.has(status)) {
    return errorResponse("Invalid status.", 400);
  }

  let request: any = null;

  if (installRequestId) {
    const { data, error } = await adminClient
      .from("nexus_install_requests")
      .select("*")
      .eq("id", installRequestId)
      .maybeSingle();

    if (error) {
      return errorResponse(error.message, 500);
    }

    request = data || null;
  }

  if (!request && customerAutomationId) {
    const { data, error } = await adminClient
      .from("nexus_install_requests")
      .select("*")
      .eq("customer_automation_id", customerAutomationId)
      .maybeSingle();

    if (error) {
      return errorResponse(error.message, 500);
    }

    request = data || null;
  }

  let customerAutomation: any = null;

  if (request?.customer_automation_id) {
    const { data, error } = await adminClient
      .from("customer_automations")
      .select("*")
      .eq("id", request.customer_automation_id)
      .maybeSingle();

    if (error) {
      return errorResponse(error.message, 500);
    }

    customerAutomation = data || null;
  }

  if (!customerAutomation && customerAutomationId) {
    const { data, error } = await adminClient
      .from("customer_automations")
      .select("*")
      .eq("id", customerAutomationId)
      .maybeSingle();

    if (error) {
      return errorResponse(error.message, 500);
    }

    customerAutomation = data || null;
  }

  if (!customerAutomation && orderId) {
    const { data, error } = await adminClient
      .from("customer_automations")
      .select("*")
      .eq("order_id", orderId)
      .maybeSingle();

    if (error) {
      return errorResponse(error.message, 500);
    }

    customerAutomation = data || null;
  }

  if (!customerAutomation) {
    return errorResponse("Customer automation not found.", 404);
  }

  const now = nowIso();
  let orderForSchedule: any = null;

  if (customerAutomation.order_id) {
    const { data } = await adminClient
      .from("orders")
      .select("*")
      .eq("id", customerAutomation.order_id)
      .maybeSingle();

    orderForSchedule = data || null;
  }

  /*
    If buyer never submitted the install form, create a minimal admin-side install request.
    This allows admin to still manage and complete the guided install order.
  */
  if (!request) {
    const { data: createdRequest, error: createRequestError } = await adminClient
      .from("nexus_install_requests")
      .insert({
        customer_automation_id: customerAutomation.id,
        order_id: customerAutomation.order_id,
        automation_id: customerAutomation.automation_id,
        buyer_id: customerAutomation.buyer_id,

        status: "pending",
        admin_notes: adminNotes || `Created by ${actorLabel.toLowerCase()} from guided installs page.`,
        created_at: now,
        updated_at: now,
      })
      .select()
      .single();

    if (createRequestError) {
      return errorResponse(createRequestError.message, 500);
    }

    request = createdRequest;
  }

  const requestUpdates: Record<string, unknown> = {
    status,
    admin_notes: adminNotes || request.admin_notes || "",
    updated_at: now,
  };

  if (status === "contacted" && !request.contacted_at) {
    requestUpdates.contacted_at = now;
  }

  if (status === "in_progress" && !request.started_at) {
    requestUpdates.started_at = now;
  }

  if (status === "completed") {
    requestUpdates.completed_at = now;
    requestUpdates.completed_by = userId;
  }

  const { data: updatedRequest, error: updateRequestError } = await adminClient
    .from("nexus_install_requests")
    .update(requestUpdates)
    .eq("id", request.id)
    .select()
    .single();

  if (updateRequestError) {
    return errorResponse(updateRequestError.message, 500);
  }

  const customerAutomationUpdates: Record<string, unknown> = {
    updated_at: now,
  };

  if (status === "pending") {
    customerAutomationUpdates.setup_status = "guided_install_needed";
    customerAutomationUpdates.status = "waiting_for_nexus_install";
  }

  if (status === "contacted") {
    customerAutomationUpdates.setup_status = "guided_install_contacted";
    customerAutomationUpdates.status = "waiting_for_nexus_install";
  }

  if (status === "in_progress") {
    customerAutomationUpdates.setup_status = "guided_install_in_progress";
    customerAutomationUpdates.status = "waiting_for_nexus_install";
  }

  if (status === "blocked") {
    customerAutomationUpdates.setup_status = "blocked";
    customerAutomationUpdates.status = "blocked";
    customerAutomationUpdates.health_status = "attention_required";
    customerAutomationUpdates.last_error_message = adminNotes || "Guided install is blocked.";
  }

  if (status === "completed") {
    customerAutomationUpdates.setup_status = "completed";
    customerAutomationUpdates.status = "active";
    customerAutomationUpdates.health_status = "configured";
    customerAutomationUpdates.last_error_message = null;

    Object.assign(
      customerAutomationUpdates,
      scheduleUpdateForCompletedInstall(orderForSchedule, customerAutomation),
    );
  }

  if (status === "cancelled") {
    customerAutomationUpdates.setup_status = "cancelled";
    customerAutomationUpdates.status = "cancelled";
  }

  let customerAutomationUpdateResult = await adminClient
    .from("customer_automations")
    .update(customerAutomationUpdates)
    .eq("id", customerAutomation.id);

  if (customerAutomationUpdateResult.error) {
    const fallbackUpdates = { ...customerAutomationUpdates };
    delete fallbackUpdates.run_frequency;
    delete fallbackUpdates.schedule_status;
    delete fallbackUpdates.schedule_anchor_at;
    delete fallbackUpdates.next_run_at;
    delete fallbackUpdates.last_run_at;
    delete fallbackUpdates.last_run_requested_at;

    customerAutomationUpdateResult = await adminClient
      .from("customer_automations")
      .update(fallbackUpdates)
      .eq("id", customerAutomation.id);
  }

  if (customerAutomationUpdateResult.error) {
    return errorResponse(customerAutomationUpdateResult.error.message, 500);
  }

  if (customerAutomation.order_id) {
    const orderStatus =
      status === "completed"
        ? "completed"
        : status === "cancelled"
          ? "cancelled"
          : `guided_install_${status}`;

    const { error: orderUpdateError } = await adminClient
      .from("orders")
      .update({
        order_status: orderStatus,
        updated_at: now,
      })
      .eq("id", customerAutomation.order_id);

    if (orderUpdateError) {
      return errorResponse(orderUpdateError.message, 500);
    }
  }

  await adminClient.from("automation_events").insert({
    customer_automation_id: customerAutomation.id,
    buyer_id: customerAutomation.buyer_id,
    automation_id: customerAutomation.automation_id,
    order_id: customerAutomation.order_id,
    event_type: `guided_install_${status}`,
    title: `Guided install ${status}`,
    message: adminNotes || `${actorLabel} marked guided install as ${status}.`,
    created_by: actor === "developer" ? "developer" : "admin",
    created_at: now,
  });

  return jsonResponse({
    ok: true,
    request: updatedRequest,
    message: `Guided install marked as ${status}.`,
  });
}

async function updateDeveloperInstallRequest(adminClient: any, userId: string, developer: any, body: any) {
  const rows = await listDeveloperOrders(adminClient, developer);
  const installRequestId = cleanString(body.install_request_id);
  const customerAutomationId = cleanString(body.customer_automation_id);
  const orderId = cleanString(body.order_id);

  const row = rows.find((item: any) =>
    (installRequestId && cleanString(item.install_request?.id) === installRequestId) ||
    (customerAutomationId && cleanString(item.customer_automation?.id) === customerAutomationId) ||
    (orderId && cleanString(item.order?.id) === orderId)
  );

  if (!row) {
    return errorResponse("Guided install request not found for this developer.", 404);
  }

  if (cleanString(body.status) === "completed") {
    const customerAutomation = row.customer_automation || {};
    const hasCustomerWorkflow = Boolean(
      cleanString(customerAutomation.n8n_workflow_id) ||
        cleanString(customerAutomation.runtime_webhook_url || customerAutomation.n8n_webhook_url)
    );
    const hasRunCheck = Boolean(
      cleanString(customerAutomation.last_run_requested_at) ||
        cleanString(customerAutomation.last_run_at)
    );

    if (!hasCustomerWorkflow || !hasRunCheck) {
      return errorResponse(
        "Provision the customer workflow and run the output check before marking this guided install complete.",
        400,
      );
    }
  }

  return await updateAdminInstallRequest(adminClient, userId, body, "developer");
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
      message: "nexus-install-request is alive.",
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed.", 405);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const action = cleanString(body.action || "get");

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    if (action === "get") {
      const { user, error } = await requireUser(req);

      if (error || !user) {
        return errorResponse(error || "Login required.", 401);
      }

      const result = await getBuyerInstallRequest(
        adminClient,
        user.id,
        cleanString(body.customer_automation_id || body.id),
      );

      return jsonResponse({
        ok: true,
        ...result,
      });
    }

    if (action === "submit") {
      const { user, error } = await requireUser(req);

      if (error || !user) {
        return errorResponse(error || "Login required.", 401);
      }

      return await submitBuyerInstallRequest(adminClient, user.id, body);
    }

    if (action === "admin_list") {
      const { user, profile, error } = await requireAdmin(req);

      if (error || !user || !profile) {
        return errorResponse(error || "Admin access required.", 401);
      }

      const rows = await listAdminOrders(adminClient);

      return jsonResponse({
        ok: true,
        rows,
      });
    }

    if (action === "admin_update") {
      const { user, profile, error } = await requireAdmin(req);

      if (error || !user || !profile) {
        return errorResponse(error || "Admin access required.", 401);
      }

      return await updateAdminInstallRequest(adminClient, user.id, body);
    }

    if (action === "developer_list") {
      const { user, developer, error } = await requireDeveloper(req, adminClient);

      if (error || !user || !developer) {
        return errorResponse(error || "Developer access required.", 401);
      }

      const rows = await listDeveloperOrders(adminClient, developer);

      return jsonResponse({
        ok: true,
        rows,
      });
    }

    if (action === "developer_update") {
      const { user, developer, error } = await requireDeveloper(req, adminClient);

      if (error || !user || !developer) {
        return errorResponse(error || "Developer access required.", 401);
      }

      return await updateDeveloperInstallRequest(adminClient, user.id, developer, body);
    }

    return errorResponse("Unknown action.", 400);
  } catch (error) {
    console.error(error);

    return errorResponse(
      error instanceof Error ? error.message : "Could not process Nexus install request.",
      500,
    );
  }
});
