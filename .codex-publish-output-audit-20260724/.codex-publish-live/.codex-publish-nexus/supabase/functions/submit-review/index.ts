import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function cleanString(value: unknown) {
  return String(value ?? "").trim();
}

function normalizeRating(value: unknown) {
  const rating = Number(value || 0);
  if (!Number.isFinite(rating)) return 0;
  return Math.max(1, Math.min(5, Math.round(rating * 10) / 10));
}

function isUuid(value: unknown) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    cleanString(value),
  );
}

async function requireUser(req: Request) {
  const authHeader = req.headers.get("Authorization") || "";

  if (!authHeader.startsWith("Bearer ")) {
    return { user: null, profile: null, error: "Login required." };
  }

  const token = authHeader.replace("Bearer ", "");
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data, error } = await userClient.auth.getUser(token);

  if (error || !data?.user) {
    return { user: null, profile: null, error: "Invalid user session." };
  }

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: profile } = await adminClient
    .from("profiles")
    .select("*")
    .eq("id", data.user.id)
    .maybeSingle();

  return {
    user: data.user,
    profile: profile || null,
    error: null,
  };
}

async function requireAdmin(req: Request) {
  const auth = await requireUser(req);

  if (auth.error || !auth.user) {
    return { ...auth, error: auth.error || "Login required." };
  }

  if (auth.profile?.role !== "admin") {
    return { ...auth, error: "Admin access required." };
  }

  return auth;
}

async function ensureProfile(adminClient: any, user: any) {
  const email = cleanString(user.email);
  const fullName = cleanString(user.user_metadata?.full_name || user.user_metadata?.name);

  const { data: existingProfile } = await adminClient
    .from("profiles")
    .select("role, full_name")
    .eq("id", user.id)
    .maybeSingle();

  await adminClient.from("profiles").upsert(
    {
      id: user.id,
      email,
      full_name: cleanString(existingProfile?.full_name) || fullName,
      role: cleanString(existingProfile?.role) || "buyer",
    },
    { onConflict: "id", ignoreDuplicates: false },
  );
}

async function loadReviewerInfo(adminClient: any, user: any) {
  const { data: profile } = await adminClient
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  const { data: buyerProfile } = await adminClient
    .from("buyer_profiles")
    .select("*")
    .eq("user_id", user.id)
    .maybeSingle();

  return {
    name:
      cleanString(buyerProfile?.name) ||
      cleanString(profile?.full_name) ||
      cleanString(user.user_metadata?.full_name || user.user_metadata?.name) ||
      cleanString(user.email).split("@")[0] ||
      "Nexus user",
    company: cleanString(buyerProfile?.company),
    email: cleanString(user.email),
  };
}

async function findVerifiedProductPurchase(adminClient: any, userId: string, automationId: string) {
  const { data, error } = await adminClient
    .from("orders")
    .select("*")
    .eq("buyer_id", userId)
    .eq("automation_id", automationId)
    .eq("payment_status", "paid")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data || null;
}

async function userHasDeveloperPurchase(adminClient: any, userId: string, developerId: string) {
  const { data, error } = await adminClient
    .from("orders")
    .select("id")
    .eq("buyer_id", userId)
    .eq("developer_id", developerId)
    .eq("payment_status", "paid")
    .limit(1);

  if (error) {
    console.warn("Could not check developer purchase:", error.message);
    return false;
  }

  return Boolean((data || [])[0]?.id);
}

async function submitProductReview(adminClient: any, user: any, body: any) {
  const automationId = cleanString(body.automation_id || body.automationId);

  if (!isUuid(automationId)) {
    return errorResponse("automation_id is required.", 400);
  }

  const rating = normalizeRating(body.rating);
  const reviewText = cleanString(body.review_text || body.text);

  if (!rating) {
    return errorResponse("Rating must be between 1 and 5.", 400);
  }

  if (reviewText.length < 10) {
    return errorResponse("Review text must be at least 10 characters.", 400);
  }

  const { data: product, error: productError } = await adminClient
    .from("automations")
    .select("id, title, developer_id")
    .eq("id", automationId)
    .maybeSingle();

  if (productError || !product) {
    return errorResponse(productError?.message || "Product not found.", 404);
  }

  const order = await findVerifiedProductPurchase(adminClient, user.id, automationId);

  if (!order) {
    return errorResponse("Only buyers who purchased this product can review it.", 403);
  }

  const reviewer = await loadReviewerInfo(adminClient, user);
  const { data: customerAutomation } = await adminClient
    .from("customer_automations")
    .select("id")
    .eq("order_id", order.id)
    .maybeSingle();

  const payload = {
    review_type: "product",
    automation_id: automationId,
    developer_id: product.developer_id || order.developer_id || null,
    reviewer_user_id: user.id,
    buyer_id: user.id,
    order_id: order.id,
    customer_automation_id: customerAutomation?.id || null,
    reviewer_name: cleanString(body.reviewer_name) || reviewer.name,
    reviewer_company: cleanString(body.reviewer_company) || reviewer.company,
    reviewer_role: cleanString(body.reviewer_role),
    rating,
    review_text: reviewText,
    verified_purchase: true,
    source: "buyer_dashboard",
    status: "pending",
    updated_at: new Date().toISOString(),
  };

  const { data: existingReview } = await adminClient
    .from("reviews")
    .select("id")
    .eq("review_type", "product")
    .eq("reviewer_user_id", user.id)
    .eq("automation_id", automationId)
    .maybeSingle();

  const reviewQuery = existingReview?.id
    ? adminClient
        .from("reviews")
        .update(payload)
        .eq("id", existingReview.id)
    : adminClient
        .from("reviews")
        .insert({
          ...payload,
          created_at: new Date().toISOString(),
        });

  const { data, error } = await reviewQuery
    .select()
    .single();

  if (error) {
    return errorResponse(error.message, 500);
  }

  await adminClient.from("admin_notifications").insert({
    notification_type: "review_submitted",
    title: "New product review pending",
    message: `${payload.reviewer_name} reviewed ${product.title || "a product"}.`,
    related_order_id: order.id,
    status: "unread",
    created_at: new Date().toISOString(),
  });

  return jsonResponse({
    ok: true,
    review: data,
    message: "Review submitted. Nexus will review it before it appears publicly.",
  });
}

async function submitDeveloperReview(adminClient: any, user: any, body: any) {
  const developerId = cleanString(body.developer_id || body.developerId);

  if (!isUuid(developerId)) {
    return errorResponse("developer_id is required.", 400);
  }

  const rating = normalizeRating(body.rating);
  const reviewText = cleanString(body.review_text || body.text);

  if (!rating) {
    return errorResponse("Rating must be between 1 and 5.", 400);
  }

  if (reviewText.length < 10) {
    return errorResponse("Review text must be at least 10 characters.", 400);
  }

  const { data: developer, error: developerError } = await adminClient
    .from("developers")
    .select("id, display_name, profile_id")
    .eq("id", developerId)
    .maybeSingle();

  if (developerError || !developer) {
    return errorResponse(developerError?.message || "Developer not found.", 404);
  }

  if (developer.profile_id && developer.profile_id === user.id) {
    return errorResponse("You cannot review your own developer profile.", 403);
  }

  const reviewer = await loadReviewerInfo(adminClient, user);
  const verifiedPurchase = await userHasDeveloperPurchase(adminClient, user.id, developerId);

  const payload = {
    review_type: "developer",
    automation_id: null,
    developer_id: developerId,
    reviewer_user_id: user.id,
    buyer_id: user.id,
    reviewer_name: cleanString(body.reviewer_name) || reviewer.name,
    reviewer_company: cleanString(body.reviewer_company) || reviewer.company,
    reviewer_role: cleanString(body.reviewer_role),
    rating,
    review_text: reviewText,
    verified_purchase: verifiedPurchase,
    source: "developer_profile",
    status: "pending",
    updated_at: new Date().toISOString(),
  };

  const { data: existingReview } = await adminClient
    .from("reviews")
    .select("id")
    .eq("review_type", "developer")
    .eq("reviewer_user_id", user.id)
    .eq("developer_id", developerId)
    .maybeSingle();

  const reviewQuery = existingReview?.id
    ? adminClient
        .from("reviews")
        .update(payload)
        .eq("id", existingReview.id)
    : adminClient
        .from("reviews")
        .insert({
          ...payload,
          created_at: new Date().toISOString(),
        });

  const { data, error } = await reviewQuery
    .select()
    .single();

  if (error) {
    return errorResponse(error.message, 500);
  }

  await adminClient.from("admin_notifications").insert({
    notification_type: "review_submitted",
    title: "New developer review pending",
    message: `${payload.reviewer_name} reviewed ${developer.display_name || "a developer"}.`,
    status: "unread",
    created_at: new Date().toISOString(),
  });

  return jsonResponse({
    ok: true,
    review: data,
    message: "Review submitted. Nexus will review it before it appears publicly.",
  });
}

async function updateReviewStatus(adminClient: any, body: any) {
  const reviewId = cleanString(body.review_id || body.id);
  const status = cleanString(body.status).toLowerCase();

  if (!isUuid(reviewId)) {
    return errorResponse("review_id is required.", 400);
  }

  if (!["pending", "approved", "hidden"].includes(status)) {
    return errorResponse("Invalid review status.", 400);
  }

  const { data, error } = await adminClient
    .from("reviews")
    .update({
      status,
      moderation_notes: cleanString(body.moderation_notes),
      updated_at: new Date().toISOString(),
    })
    .eq("id", reviewId)
    .select()
    .single();

  if (error) {
    return errorResponse(error.message, 500);
  }

  return jsonResponse({
    ok: true,
    review: data,
  });
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
      message: "submit-review is alive.",
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed.", 405);
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
      return errorResponse("Missing Supabase function secrets.", 500);
    }

    const body = await req.json().catch(() => ({}));
    const action = cleanString(body.action || "submit_product_review");
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    if (action === "admin_update_status") {
      const auth = await requireAdmin(req);

      if (auth.error || !auth.user) {
        return errorResponse(auth.error || "Admin access required.", 401);
      }

      return await updateReviewStatus(adminClient, body);
    }

    const auth = await requireUser(req);

    if (auth.error || !auth.user) {
      return errorResponse(auth.error || "Login required.", 401);
    }

    await ensureProfile(adminClient, auth.user);

    if (action === "submit_product_review") {
      return await submitProductReview(adminClient, auth.user, body);
    }

    if (action === "submit_developer_review") {
      return await submitDeveloperReview(adminClient, auth.user, body);
    }

    return errorResponse("Unknown action.", 400);
  } catch (error) {
    console.error("submit-review failed:", error);

    return errorResponse(
      error instanceof Error ? error.message : "Could not submit review.",
      500,
    );
  }
});
