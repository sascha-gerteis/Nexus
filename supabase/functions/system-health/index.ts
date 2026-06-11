import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function env(name: string) {
  return Deno.env.get(name) || "";
}

function check(name: string, status: "ok" | "warning" | "error", message: string, details: Record<string, unknown> = {}) {
  return { name, status, message, details };
}

function group(title: string, checks: ReturnType<typeof check>[]) {
  return { title, checks };
}

async function requireAdmin(req: Request, adminClient: any) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!token) {
    return { ok: false, error: "Authentication required." };
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data, error } = await userClient.auth.getUser(token);

  if (error || !data?.user) {
    return { ok: false, error: "Invalid auth token." };
  }

  const { data: profile } = await adminClient
    .from("profiles")
    .select("role")
    .eq("id", data.user.id)
    .maybeSingle();

  if (profile?.role !== "admin") {
    return { ok: false, error: "Admin access required." };
  }

  return { ok: true, user: data.user };
}

async function countTable(adminClient: any, table: string) {
  const { count, error } = await adminClient
    .from(table)
    .select("id", { count: "exact", head: true });

  if (error) {
    return check(table, "error", error.message);
  }

  return check(table, "ok", `${count || 0} row${count === 1 ? "" : "s"} available.`, { count: count || 0 });
}

async function filteredCount(adminClient: any, table: string, label: string, build: (query: any) => any) {
  let query = adminClient
    .from(table)
    .select("id", { count: "exact", head: true });

  query = build(query);

  const { count, error } = await query;

  if (error) {
    return check(label, "warning", error.message);
  }

  return check(label, "ok", `${count || 0} found.`, { count: count || 0 });
}

async function checkN8n() {
  const baseUrl = env("N8N_BASE_URL").replace(/\/+$/, "");
  const apiKey = env("N8N_API_KEY");

  if (!baseUrl || !apiKey) {
    return check("n8n API", "error", "Missing N8N_BASE_URL or N8N_API_KEY.");
  }

  try {
    const response = await fetch(`${baseUrl}/api/v1/workflows?limit=1`, {
      headers: { "X-N8N-API-KEY": apiKey },
    });

    if (!response.ok) {
      return check("n8n API", "error", `n8n responded with ${response.status}.`);
    }

    return check("n8n API", "ok", "n8n API is reachable.");
  } catch (error) {
    return check("n8n API", "error", error instanceof Error ? error.message : "Could not reach n8n.");
  }
}

async function checkStripe() {
  const secretKey = env("STRIPE_SECRET_KEY");

  if (!secretKey) {
    return check("Stripe API", "error", "Missing STRIPE_SECRET_KEY.");
  }

  try {
    const response = await fetch("https://api.stripe.com/v1/balance", {
      headers: { Authorization: `Bearer ${secretKey}` },
    });

    if (!response.ok) {
      return check("Stripe API", "error", `Stripe responded with ${response.status}.`);
    }

    return check("Stripe API", "ok", "Stripe API is reachable.");
  } catch (error) {
    return check("Stripe API", "error", error instanceof Error ? error.message : "Could not reach Stripe.");
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: corsHeaders,
    });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return errorResponse("Missing Supabase service configuration.", 500);
  }

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const auth = await requireAdmin(req, adminClient);

  if (!auth.ok) {
    return errorResponse(auth.error || "Admin access required.", 403);
  }

  const requiredSecrets = [
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "SITE_URL",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "N8N_BASE_URL",
    "N8N_API_KEY",
    "NEXUS_RUNTIME_SECRET",
    "NEXUS_CREDENTIAL_SECRET",
  ];

  const secretChecks = requiredSecrets.map((name) =>
    env(name)
      ? check(name, "ok", "Configured.")
      : check(name, "error", "Missing Supabase secret."),
  );

  const tableChecks = await Promise.all([
    countTable(adminClient, "automations"),
    countTable(adminClient, "developers"),
    countTable(adminClient, "orders"),
    countTable(adminClient, "customer_automations"),
    countTable(adminClient, "automation_outputs"),
    countTable(adminClient, "automation_runs"),
    countTable(adminClient, "developer_earnings"),
    countTable(adminClient, "developer_payout_requests"),
    countTable(adminClient, "message_threads"),
    countTable(adminClient, "reviews"),
  ]);

  const monthlyChecks = await Promise.all([
    filteredCount(adminClient, "customer_automations", "Active monthly schedules", (query) =>
      query.eq("run_frequency", "monthly").eq("schedule_status", "active")
    ),
    filteredCount(adminClient, "customer_automations", "Monthly runs due now", (query) =>
      query.eq("run_frequency", "monthly").eq("schedule_status", "active").lte("next_run_at", new Date().toISOString())
    ),
    filteredCount(adminClient, "automation_runs", "Runs in last 32 days", (query) =>
      query.gte("created_at", new Date(Date.now() - 32 * 24 * 60 * 60 * 1000).toISOString())
    ),
  ]);

  monthlyChecks.push(
    check(
      "Supabase Cron",
      "warning",
      "Confirm the pg_cron job nexus-monthly-runner-daily exists in Supabase SQL. This function cannot safely expose cron.job through the browser.",
    ),
  );

  const externalChecks = await Promise.all([
    checkN8n(),
    checkStripe(),
  ]);

  const sections = [
    group("Secrets", secretChecks),
    group("Database", tableChecks),
    group("Monthly runner", monthlyChecks),
    group("External services", externalChecks),
  ];

  const allChecks = sections.flatMap((section) => section.checks);
  const errors = allChecks.filter((item) => item.status === "error").length;
  const warnings = allChecks.filter((item) => item.status === "warning").length;

  return jsonResponse({
    ok: errors === 0,
    checked_at: new Date().toISOString(),
    summary: {
      status: errors ? "error" : warnings ? "warning" : "ok",
      errors,
      warnings,
      checks: allChecks.length,
    },
    sections,
  });
});
