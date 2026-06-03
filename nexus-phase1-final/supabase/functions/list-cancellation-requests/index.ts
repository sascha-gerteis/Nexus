import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

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
      message: "list-cancellation-requests is alive.",
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

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data, error } = await adminClient
      .from("automation_cancellation_requests")
      .select(`
        *,
        customer_automations(
          id,
          name,
          status,
          setup_status,
          runtime_status,
          health_status,
          last_error_message,
          automations(title, slug, icon, color)
        ),
        orders(
          id,
          buyer_name,
          buyer_email,
          buyer_company,
          automation_title,
          price_display,
          payment_status,
          order_status,
          created_at
        ),
        automations(title, slug, icon, color)
      `)
      .order("created_at", { ascending: false });

    if (error) {
      return errorResponse(error.message, 500);
    }

    return jsonResponse({
      ok: true,
      requests: data || [],
    });
  } catch (error) {
    console.error(error);

    return errorResponse(
      error instanceof Error ? error.message : "Could not list cancellation requests.",
      500,
    );
  }
});