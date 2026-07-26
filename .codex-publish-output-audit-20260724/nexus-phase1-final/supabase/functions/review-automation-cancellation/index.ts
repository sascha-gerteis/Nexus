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

async function requireAdmin(req: Request) {
  const authHeader = req.headers.get("Authorization") || "";

  if (!authHeader.startsWith("Bearer ")) {
    return { user: null, profile: null, error: "Missing auth token." };
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

  const { data: profile } = await adminClient
    .from("profiles")
    .select("id, email, role, full_name")
    .eq("id", data.user.id)
    .maybeSingle();

  if (!profile || profile.role !== "admin") {
    return { user: data.user, profile, error: "Admin access required." };
  }

  return { user: data.user, profile, error: null };
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
      message: "review-automation-cancellation is alive.",
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed.", 405);
  }

  try {
    const { user, profile, error: authError } = await requireAdmin(req);

    if (authError || !user || !profile) {
      return errorResponse(authError || "Admin access required.", 401);
    }

    const body = await req.json().catch(() => ({}));

    const requestId = cleanString(body.request_id);
    const decision = cleanString(body.decision).toLowerCase();
    const adminNotes = cleanString(body.admin_notes);

    if (!requestId) {
      return errorResponse("request_id is required.", 400);
    }

    if (!["approve", "reject"].includes(decision)) {
      return errorResponse("decision must be approve or reject.", 400);
    }

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: request, error: requestError } = await adminClient
      .from("automation_cancellation_requests")
      .select("*")
      .eq("id", requestId)
      .maybeSingle();

    if (requestError || !request) {
      return errorResponse(requestError?.message || "Cancellation request not found.", 404);
    }

    if (request.status !== "pending") {
      return errorResponse(`This request is already ${request.status}.`, 400);
    }

    const now = nowIso();

    if (decision === "reject") {
      const { error: updateRequestError } = await adminClient
        .from("automation_cancellation_requests")
        .update({
          status: "rejected",
          admin_notes: adminNotes,
          reviewed_by: user.id,
          reviewed_at: now,
          updated_at: now,
        })
        .eq("id", request.id);

      if (updateRequestError) {
        return errorResponse(updateRequestError.message, 500);
      }

      await adminClient
        .from("automation_events")
        .insert({
          customer_automation_id: request.customer_automation_id,
          buyer_id: request.buyer_id,
          automation_id: request.automation_id,
          order_id: request.order_id,
          event_type: "cancellation_rejected",
          title: "Cancellation request rejected",
          message: adminNotes || "Nexus rejected the cancellation request.",
          created_by: "admin",
          created_at: now,
        });

      return jsonResponse({
        ok: true,
        status: "rejected",
        message: "Cancellation request rejected.",
      });
    }

    const { error: updateRequestError } = await adminClient
      .from("automation_cancellation_requests")
      .update({
        status: "approved",
        admin_notes: adminNotes,
        reviewed_by: user.id,
        reviewed_at: now,
        updated_at: now,
      })
      .eq("id", request.id);

    if (updateRequestError) {
      return errorResponse(updateRequestError.message, 500);
    }

    const { error: automationUpdateError } = await adminClient
      .from("customer_automations")
      .update({
        status: "cancelled",
        setup_status: "cancelled",
        runtime_status: "cancelled",
        health_status: "cancelled",
        last_error_message: null,
        updated_at: now,
      })
      .eq("id", request.customer_automation_id);

    if (automationUpdateError) {
      return errorResponse(automationUpdateError.message, 500);
    }

    if (request.order_id) {
      await adminClient
        .from("orders")
        .update({
          order_status: "cancelled",
          updated_at: now,
        })
        .eq("id", request.order_id);
    }

    await adminClient
      .from("automation_events")
      .insert({
        customer_automation_id: request.customer_automation_id,
        buyer_id: request.buyer_id,
        automation_id: request.automation_id,
        order_id: request.order_id,
        event_type: "cancellation_approved",
        title: "Automation cancelled",
        message: adminNotes || "Nexus approved the cancellation request.",
        created_by: "admin",
        created_at: now,
      });

    return jsonResponse({
      ok: true,
      status: "approved",
      message: "Cancellation approved. Customer automation was cancelled.",
    });
  } catch (error) {
    console.error(error);

    return errorResponse(
      error instanceof Error ? error.message : "Could not review cancellation.",
      500,
    );
  }
});