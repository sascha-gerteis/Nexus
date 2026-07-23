import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SQL_HINT = "Run supabase/payment_test_mode_install_or_patch.sql in the Supabase SQL editor, then redeploy payment-mode and create-checkout-session.";

function nowIso() {
  return new Date().toISOString();
}

function cleanString(value: unknown) {
  return String(value || "").trim();
}

function userFacingError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "Unknown error.");

  if (/platform_settings|schema cache|could not find|relation .* does not exist|column .* does not exist/i.test(message)) {
    return `${message} ${SQL_HINT}`;
  }

  return message;
}

async function requireAdmin(req: Request) {
  const authHeader = req.headers.get("Authorization") || "";

  if (!authHeader.startsWith("Bearer ")) {
    return { user: null, profile: null, adminClient: null, error: "Missing auth token." };
  }

  const token = authHeader.replace("Bearer ", "").trim();
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userError } = await userClient.auth.getUser(token);

  if (userError || !userData?.user) {
    return { user: null, profile: null, adminClient: null, error: "Invalid auth token." };
  }

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("id, email, role, full_name")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (profileError || !profile) {
    return { user: userData.user, profile: null, adminClient, error: "Profile not found." };
  }

  if (profile.role !== "admin") {
    return { user: userData.user, profile, adminClient, error: "Full admin access required." };
  }

  return { user: userData.user, profile, adminClient, error: null };
}

async function getPaymentStatus(adminClient: any) {
  const { data, error } = await adminClient
    .from("platform_settings")
    .select("value, updated_at, updated_by")
    .eq("key", "payment_mode")
    .maybeSingle();

  if (error) throw new Error(error.message);

  const mode = cleanString(data?.value?.mode).toLowerCase() === "test" ? "test" : "live";

  return {
    ok: true,
    mode,
    test_mode_enabled: mode === "test",
    updated_at: data?.updated_at || null,
    updated_by: data?.updated_by || null,
    live_key_configured: Boolean(Deno.env.get("STRIPE_SECRET_KEY")),
    test_key_configured: Boolean(Deno.env.get("STRIPE_TEST_SECRET_KEY")),
    live_webhook_configured: Boolean(Deno.env.get("STRIPE_WEBHOOK_SECRET")),
    test_webhook_configured: Boolean(Deno.env.get("STRIPE_TEST_WEBHOOK_SECRET")),
    test_card: {
      number: "4242 4242 4242 4242",
      expiry: "Any future date",
      cvc: "Any 3 digits",
      zip: "Any value",
    },
  };
}

async function setPaymentMode(adminClient: any, userId: string, mode: "live" | "test") {
  if (mode === "test" && !Deno.env.get("STRIPE_TEST_SECRET_KEY")) {
    throw new Error("STRIPE_TEST_SECRET_KEY is missing. Add your Stripe test secret key before enabling test payments.");
  }

  const value = {
    mode,
    updated_at: nowIso(),
    updated_by: userId,
  };

  const { error } = await adminClient
    .from("platform_settings")
    .upsert(
      {
        key: "payment_mode",
        value,
        updated_at: value.updated_at,
        updated_by: userId,
      },
      { onConflict: "key" },
    );

  if (error) throw new Error(error.message);

  return getPaymentStatus(adminClient);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    const { user, adminClient, error } = await requireAdmin(req);
    if (error || !user || !adminClient) return errorResponse(error || "Admin access required.", 403);

    const body = await req.json().catch(() => ({}));
    const action = cleanString(body.action || "get_status");

    if (action === "get_status") {
      return jsonResponse(await getPaymentStatus(adminClient));
    }

    if (action === "enable_test") {
      return jsonResponse({
        ...(await setPaymentMode(adminClient, user.id, "test")),
        message: "Payment test mode is on. Stripe Checkout will use test mode until you turn it off.",
      });
    }

    if (action === "disable_test" || action === "enable_live") {
      return jsonResponse({
        ...(await setPaymentMode(adminClient, user.id, "live")),
        message: "Live payment mode is on. Stripe Checkout will use live payments.",
      });
    }

    return errorResponse("Unknown action.", 400);
  } catch (error) {
    console.error("payment-mode failed:", error);
    return errorResponse(userFacingError(error), 500);
  }
});
