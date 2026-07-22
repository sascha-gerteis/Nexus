import Stripe from "https://esm.sh/stripe@14.25.0?target=deno";
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") || "", {
  apiVersion: "2024-06-20",
});

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const N8N_BASE_URL = Deno.env.get("N8N_BASE_URL") || "";
const N8N_API_KEY = Deno.env.get("N8N_API_KEY") || "";

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
  const { data: userData, error: userError } = await userClient.auth.getUser(token);

  if (userError || !userData?.user) {
    return { user: null, profile: null, error: "Invalid auth token." };
  }

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("id, email, role, full_name")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (profileError || !profile) {
    return { user: userData.user, profile: null, error: "Admin profile not found." };
  }

  if (profile.role !== "admin") {
    return { user: userData.user, profile, error: "Admin access required." };
  }

  return { user: userData.user, profile, error: null };
}

async function countRows(adminClient: any, table: string, automationId: string, extraFilter?: (query: any) => any) {
  let query = adminClient
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("automation_id", automationId);

  if (extraFilter) {
    query = extraFilter(query);
  }

  const { count, error } = await query;

  if (error) {
    throw new Error(error.message);
  }

  return count || 0;
}

async function archiveStripeProduct(stripeProductId: string) {
  if (!stripeProductId) return { ok: true, skipped: true };

  try {
    await stripe.products.update(stripeProductId, {
      active: false,
    });

    return { ok: true, skipped: false };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      error: error instanceof Error ? error.message : "Could not archive Stripe product.",
    };
  }
}

async function deleteN8nWorkflow(workflowId: string) {
  if (!workflowId) {
    return { ok: true, skipped: true };
  }

  if (!N8N_BASE_URL || !N8N_API_KEY) {
    return {
      ok: false,
      skipped: false,
      error: "N8N_BASE_URL or N8N_API_KEY is missing.",
    };
  }

  const baseUrl = N8N_BASE_URL.replace(/\/$/, "");

  try {
    const response = await fetch(`${baseUrl}/api/v1/workflows/${encodeURIComponent(workflowId)}`, {
      method: "DELETE",
      headers: {
        "X-N8N-API-KEY": N8N_API_KEY,
        "Accept": "application/json",
      },
    });

    const text = await response.text();

    let data: unknown = null;

    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    /*
      If n8n says the workflow is already gone, we do not block product deletion.
    */
    if (response.status === 404) {
      return {
        ok: true,
        skipped: false,
        already_missing: true,
        response: data,
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        skipped: false,
        error: `n8n workflow delete failed (${response.status}): ${
          typeof data === "string" ? data : JSON.stringify(data)
        }`,
      };
    }

    return {
      ok: true,
      skipped: false,
      response: data,
    };
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      error: error instanceof Error ? error.message : "Could not delete n8n workflow.",
    };
  }
}

async function pauseProduct(adminClient: any, product: any, profile: any) {
  const now = nowIso();

  const { error } = await adminClient
    .from("automations")
    .update({
      status: "paused",
      stripe_sync_status: product.stripe_sync_status || null,
      updated_at: now,
      internal_notes: `${product.internal_notes || ""}\n\n[${now}] Paused by ${profile.email || profile.id}.`,
    })
    .eq("id", product.id);

  if (error) {
    throw new Error(error.message);
  }

  if (product.stripe_product_id) {
    await archiveStripeProduct(product.stripe_product_id);
  }

  return {
    ok: true,
    action: "pause",
    message: "Product paused. New buyers cannot purchase it, but existing buyers keep access.",
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
      message: "manage-automation-lifecycle is alive.",
      env: {
        has_supabase_url: Boolean(SUPABASE_URL),
        has_anon_key: Boolean(SUPABASE_ANON_KEY),
        has_service_role: Boolean(SUPABASE_SERVICE_ROLE_KEY),
        has_n8n_base_url: Boolean(N8N_BASE_URL),
        has_n8n_api_key: Boolean(N8N_API_KEY),
        has_stripe_secret: Boolean(Deno.env.get("STRIPE_SECRET_KEY") || ""),
      },
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

    const automationId = cleanString(body.automation_id);
    const action = cleanString(body.action || "delete").toLowerCase();

    if (!automationId) {
      return errorResponse("automation_id is required.", 400);
    }

    if (!["delete", "pause"].includes(action)) {
      return errorResponse("Invalid action. Use delete or pause.", 400);
    }

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: product, error: productError } = await adminClient
      .from("automations")
      .select("*")
      .eq("id", automationId)
      .maybeSingle();

    if (productError || !product) {
      return errorResponse(productError?.message || "Product not found.", 404);
    }

    if (action === "pause") {
      const result = await pauseProduct(adminClient, product, profile);
      return jsonResponse(result);
    }

    const customerAutomationCount = await countRows(
      adminClient,
      "customer_automations",
      automationId,
    );

    const orderCount = await countRows(
      adminClient,
      "orders",
      automationId,
    );

    const paidOrderCount = await countRows(
      adminClient,
      "orders",
      automationId,
      (query) => query.eq("payment_status", "paid"),
    );

    /*
      Strict safety rule:
      If there are any customer automation instances or paid orders,
      product cannot be deleted from the admin UI.
    */
    if (customerAutomationCount > 0 || paidOrderCount > 0) {
      return errorResponse(
        "This product has buyers or active customer automations. Pause it instead, or migrate/refund customers before deleting.",
        409,
        {
          can_delete: false,
          can_pause: true,
          customer_automation_count: customerAutomationCount,
          order_count: orderCount,
          paid_order_count: paidOrderCount,
          recommended_action: "pause",
        },
      );
    }

    /*
      If there are unpaid/pending orders, we also block deletion.
      This prevents a customer from being mid-checkout while the product disappears.
    */
    if (orderCount > 0) {
      return errorResponse(
        "This product has existing order records. Pause it instead, or clean up unfinished orders before deleting.",
        409,
        {
          can_delete: false,
          can_pause: true,
          customer_automation_count: customerAutomationCount,
          order_count: orderCount,
          paid_order_count: paidOrderCount,
          recommended_action: "pause",
        },
      );
    }

    const n8nWorkflowId = cleanString(product.n8n_workflow_id);
    const stripeProductId = cleanString(product.stripe_product_id);

    const n8nDeleteResult = await deleteN8nWorkflow(n8nWorkflowId);

    if (!n8nDeleteResult.ok) {
      return errorResponse(
        n8nDeleteResult.error || "Could not delete linked n8n workflow.",
        500,
        {
          product_deleted: false,
          n8n_deleted: false,
          n8n_result: n8nDeleteResult,
        },
      );
    }

    const stripeArchiveResult = await archiveStripeProduct(stripeProductId);

    /*
      Stripe archive failure should not block product deletion,
      because Stripe prices/products can be manually archived later.
    */

    await adminClient
      .from("reviews")
      .delete()
      .eq("automation_id", automationId);

    await adminClient
      .from("admin_notifications")
      .delete()
      .eq("related_automation_id", automationId);

    const { error: deleteError } = await adminClient
      .from("automations")
      .delete()
      .eq("id", automationId);

    if (deleteError) {
      return errorResponse(
        deleteError.message,
        500,
        {
          product_deleted: false,
          n8n_deleted: true,
          n8n_result: n8nDeleteResult,
          stripe_archive_result: stripeArchiveResult,
        },
      );
    }

    return jsonResponse({
      ok: true,
      action: "delete",
      product_deleted: true,
      n8n_deleted: !n8nDeleteResult.skipped,
      stripe_archived: stripeArchiveResult.ok && !stripeArchiveResult.skipped,
      message: "Product deleted safely. Linked n8n workflow was deleted if it existed.",
      n8n_result: n8nDeleteResult,
      stripe_archive_result: stripeArchiveResult,
    });
  } catch (error) {
    console.error(error);

    return errorResponse(
      error instanceof Error ? error.message : "Could not manage product lifecycle.",
      500,
    );
  }
});