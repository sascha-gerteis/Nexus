import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const NEXUS_RUNTIME_SECRET = Deno.env.get("NEXUS_RUNTIME_SECRET") || "";
const N8N_BASE_URL = Deno.env.get("N8N_BASE_URL") || "";
const N8N_API_KEY = Deno.env.get("N8N_API_KEY") || "";

function cleanString(value: unknown) {
  return String(value || "").trim();
}

function isAdminRole(value: unknown) {
  const role = cleanString(value).toLowerCase();
  return role === "admin" || role === "admin_staff";
}

function secretMatches(received: string, expected: string) {
  if (!received || !expected || received.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < received.length; index += 1) {
    difference |= received.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

async function requireAdminOrRuntime(req: Request) {
  const runtimeSecret = req.headers.get("x-nexus-runtime-secret") || "";
  if (secretMatches(runtimeSecret, NEXUS_RUNTIME_SECRET)) return { ok: true, actor: "runtime" };

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return { ok: false, error: "Admin authentication required." };

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const token = authHeader.replace("Bearer ", "");
  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data?.user) return { ok: false, error: "Invalid auth token." };

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("role")
    .eq("id", data.user.id)
    .maybeSingle();

  if (profileError || !profile || !isAdminRole(profile.role)) {
    return { ok: false, error: "Admin access required." };
  }
  return { ok: true, actor: "admin" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse("Method not allowed.", 405);

  const auth = await requireAdminOrRuntime(req);
  if (!auth.ok) return errorResponse(auth.error || "Admin authentication required.", 401);

  if (!N8N_BASE_URL || !N8N_API_KEY) {
    return errorResponse("n8n connection is not configured.", 503);
  }

  try {
    const url = `${N8N_BASE_URL.replace(/\/$/, "")}/api/v1/workflows?limit=1`;
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "accept": "application/json",
        "X-N8N-API-KEY": N8N_API_KEY,
      },
    });

    if (!response.ok) {
      return errorResponse("n8n API test failed.", 502, {
        upstream_status: response.status,
      });
    }

    return jsonResponse({
      ok: true,
      message: "Nexus can connect to n8n.",
      status: response.status,
    });
  } catch (error) {
    console.error("n8n connection test failed:", error);
    return errorResponse("Could not reach n8n.", 502);
  }
});
