import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

function env(name: string) {
  return Deno.env.get(name) || "";
}

function cleanString(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

async function getUserFromRequest(req: Request, supabaseUrl: string, anonKey: string) {
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return null;

  const token = authHeader.replace("Bearer ", "").trim();

  const userClient = createClient(supabaseUrl, anonKey, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  });

  const { data, error } = await userClient.auth.getUser(token);

  if (error || !data?.user) return null;

  return data.user;
}

async function getOperatorContext(adminClient: any, userId: string) {
  const { data: profile, error } = await adminClient
    .from("profiles")
    .select("id, role")
    .eq("id", userId)
    .maybeSingle();

  if (error || !profile) return { profile: null, developer: null };

  if (profile.role === "developer") {
    const { data: developer } = await adminClient
      .from("developers")
      .select("id, profile_id")
      .eq("profile_id", userId)
      .maybeSingle();

    return { profile, developer: developer || null };
  }

  return { profile, developer: null };
}

async function loadAutomation(adminClient: any, automationId: string) {
  const { data, error } = await adminClient
    .from("automations")
    .select("id, developer_id")
    .eq("id", automationId)
    .maybeSingle();

  if (error || !data) {
    throw new Error(error?.message || "Automation not found.");
  }

  return data;
}

function canAccessAutomation(operator: any, automation: any) {
  const role = cleanString(operator?.profile?.role).toLowerCase();
  if (role === "admin" || role === "admin_staff") return true;
  if (role !== "developer") return false;

  const developerId = cleanString(operator?.developer?.id);
  return Boolean(developerId && cleanString(automation?.developer_id) === developerId);
}

async function getDefaultProfile(adminClient: any, automationId: string) {
  const { data, error } = await adminClient
    .from("automation_test_profiles")
    .select("*")
    .eq("automation_id", automationId)
    .eq("is_default", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(error.message || "Could not load automation test profile.");
  }

  return data || null;
}

async function saveDefaultProfile(adminClient: any, params: {
  automation: any;
  userId: string;
  name: string;
  setupValues: Record<string, unknown>;
  secretValues: Record<string, unknown>;
}) {
  const now = new Date().toISOString();
  const name = cleanString(params.name) || "Default test profile";

  /*
    Keep one default profile per automation by name.
    If the row exists, update it. Otherwise insert it.
  */
  const { data: existing, error: existingError } = await adminClient
    .from("automation_test_profiles")
    .select("*")
    .eq("automation_id", params.automation.id)
    .eq("name", name)
    .maybeSingle();

  if (existingError) {
    throw new Error(existingError.message || "Could not check existing test profile.");
  }

  if (existing?.id) {
    const nextSecretValues = {
      ...asObject(existing.secret_values),
      ...params.secretValues,
    };

    const { data, error } = await adminClient
      .from("automation_test_profiles")
      .update({
        developer_id: params.automation.developer_id || null,
        setup_values: params.setupValues,
        secret_values: nextSecretValues,
        is_default: true,
        updated_at: now,
      })
      .eq("id", existing.id)
      .select()
      .single();

    if (error) {
      throw new Error(error.message || "Could not update test profile.");
    }

    return data;
  }

  const { data, error } = await adminClient
    .from("automation_test_profiles")
    .insert({
      automation_id: params.automation.id,
      developer_id: params.automation.developer_id || null,
      name,
      setup_values: params.setupValues,
      secret_values: params.secretValues,
      is_default: true,
      created_by: params.userId,
      created_at: now,
      updated_at: now,
    })
    .select()
    .single();

  if (error) {
    throw new Error(error.message || "Could not save test profile.");
  }

  return data;
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
      message: "automation-test-profile is alive.",
      modes: ["get", "save"],
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed.", 405);
  }

  try {
    const supabaseUrl = env("SUPABASE_URL");
    const anonKey = env("SUPABASE_ANON_KEY");
    const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return errorResponse("Missing Supabase function secrets.", 500);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const user = await getUserFromRequest(req, supabaseUrl, anonKey);

    if (!user) {
      return errorResponse("Admin login required.", 401);
    }

    const operator = await getOperatorContext(adminClient, user.id);

    if (!["admin", "admin_staff", "developer"].includes(cleanString(operator.profile?.role))) {
      return errorResponse("Admin or developer access required.", 403);
    }

    const body = await req.json().catch(() => ({}));
    const mode = cleanString(body.mode || "get").toLowerCase();
    const automationId = cleanString(body.automation_id || body.automationId);

    if (!automationId) {
      return errorResponse("automation_id is required.", 400);
    }

    const automation = await loadAutomation(adminClient, automationId);

    if (!canAccessAutomation(operator, automation)) {
      return errorResponse("You can only manage test data for your own products.", 403);
    }

    if (mode === "get") {
      const profile = await getDefaultProfile(adminClient, automation.id);

      return jsonResponse({
        ok: true,
        profile,
        has_profile: Boolean(profile?.id),
      });
    }

    if (mode === "save") {
      const profile = await saveDefaultProfile(adminClient, {
        automation,
        userId: user.id,
        name: cleanString(body.name || "Default test profile"),
        setupValues: asObject(body.setup_values || body.setupValues),
        secretValues: asObject(body.secret_values || body.secretValues),
      });

      return jsonResponse({
        ok: true,
        profile,
        message: "Automation test profile saved.",
      });
    }

    return errorResponse("Unsupported mode. Use get or save.", 400);
  } catch (error) {
    console.error("automation-test-profile failed:", error);

    return errorResponse(
      error instanceof Error ? error.message : "Could not process automation test profile.",
      500,
    );
  }
});
