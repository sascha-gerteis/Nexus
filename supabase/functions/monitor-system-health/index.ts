import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import { safeEnqueueEmail } from "../_shared/nexus-email.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const N8N_BASE_URL = (Deno.env.get("N8N_BASE_URL") || "").replace(/\/+$/, "");
const N8N_API_KEY = Deno.env.get("N8N_API_KEY") || "";
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";
const SITE_URL = (Deno.env.get("NEXUS_SITE_URL") || Deno.env.get("SITE_URL") || "https://nexus-ai.software").replace(/\/+$/, "");
const MONITOR_KEY = "nexus-production";
const FAILURE_THRESHOLD = 2;

function cleanString(value: unknown, maxLength = 1000) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function nowIso() {
  return new Date().toISOString();
}

type MonitorCheck = {
  key: string;
  label: string;
  status: "ok" | "warning" | "error";
  message: string;
  details?: Record<string, unknown>;
};

function result(key: string, label: string, status: MonitorCheck["status"], message: string, details: Record<string, unknown> = {}): MonitorCheck {
  return { key, label, status, message: cleanString(message, 1200), details };
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function checkProductionSite() {
  try {
    const response = await fetchWithTimeout(SITE_URL, {
      method: "GET",
      headers: { "Cache-Control": "no-cache", "User-Agent": "Nexus-System-Monitor/1.0" },
    });
    if (!response.ok) return result("site", "Production website", "error", `Website returned HTTP ${response.status}.`, { status: response.status });
    return result("site", "Production website", "ok", "Production website is reachable.", { status: response.status });
  } catch (error) {
    return result("site", "Production website", "error", error instanceof Error ? error.message : "Website request failed.");
  }
}

async function checkN8n() {
  if (!N8N_BASE_URL || !N8N_API_KEY) {
    return result("n8n", "n8n runtime", "error", "N8N_BASE_URL or N8N_API_KEY is missing.");
  }

  try {
    const response = await fetchWithTimeout(`${N8N_BASE_URL}/api/v1/workflows?limit=1`, {
      headers: { "X-N8N-API-KEY": N8N_API_KEY },
    });
    const body = cleanString(await response.text().catch(() => ""), 500);
    if (!response.ok) {
      const message = body || `n8n returned HTTP ${response.status}.`;
      return result("n8n", "n8n runtime", "error", message, { status: response.status });
    }
    return result("n8n", "n8n runtime", "ok", "n8n API and database are ready.", { status: response.status });
  } catch (error) {
    return result("n8n", "n8n runtime", "error", error instanceof Error ? error.message : "n8n request failed.");
  }
}

async function checkStripe() {
  if (!STRIPE_SECRET_KEY) return result("stripe", "Stripe", "error", "STRIPE_SECRET_KEY is missing.");
  try {
    const response = await fetchWithTimeout("https://api.stripe.com/v1/balance", {
      headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
    });
    const body = cleanString(await response.text().catch(() => ""), 400);
    if (!response.ok) return result("stripe", "Stripe", "error", body || `Stripe returned HTTP ${response.status}.`, { status: response.status });
    return result("stripe", "Stripe", "ok", "Stripe API is reachable.", { status: response.status });
  } catch (error) {
    return result("stripe", "Stripe", "error", error instanceof Error ? error.message : "Stripe request failed.");
  }
}

async function exactCount(query: any) {
  const { count, error } = await query;
  if (error) throw new Error(error.message);
  return Number(count || 0);
}

async function checkRuntimeBacklog(adminClient: any) {
  const staleCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const recentCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  try {
    const [stalePending, staleProcessing, recentDeadLetters] = await Promise.all([
      exactCount(adminClient.from("runtime_dispatch_queue").select("id", { count: "exact", head: true }).eq("status", "pending").lt("created_at", staleCutoff)),
      exactCount(adminClient.from("runtime_dispatch_queue").select("id", { count: "exact", head: true }).eq("status", "processing").lt("locked_at", staleCutoff)),
      exactCount(adminClient.from("runtime_dispatch_queue").select("id", { count: "exact", head: true }).eq("status", "dead_letter").gte("updated_at", recentCutoff)),
    ]);
    const total = stalePending + staleProcessing + recentDeadLetters;
    if (total) {
      return result(
        "runtime_backlog",
        "Runtime dispatch backlog",
        "error",
        `${stalePending} stale pending, ${staleProcessing} stale processing, and ${recentDeadLetters} recent dead-letter dispatches require attention.`,
        { stale_pending: stalePending, stale_processing: staleProcessing, recent_dead_letters: recentDeadLetters },
      );
    }
    return result("runtime_backlog", "Runtime dispatch backlog", "ok", "No stale or recently dead-lettered setup dispatches.");
  } catch (error) {
    return result("runtime_backlog", "Runtime dispatch backlog", "error", error instanceof Error ? error.message : "Could not inspect runtime backlog.");
  }
}

async function checkEmailBacklog(adminClient: any) {
  const staleCutoff = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  try {
    const stalePending = await exactCount(
      adminClient.from("email_queue").select("id", { count: "exact", head: true }).eq("status", "pending").lt("created_at", staleCutoff),
    );
    if (stalePending) {
      return result("email_queue", "Transactional email queue", "warning", `${stalePending} emails have been pending for more than 20 minutes.`, { stale_pending: stalePending });
    }
    return result("email_queue", "Transactional email queue", "ok", "Transactional email queue has no stale pending mail.");
  } catch (error) {
    return result("email_queue", "Transactional email queue", "warning", error instanceof Error ? error.message : "Could not inspect email queue.");
  }
}

function alertRecipientsFromEnvironment() {
  return cleanString(Deno.env.get("NEXUS_ALERT_EMAILS") || Deno.env.get("NEXUS_ALERT_EMAIL") || "", 3000)
    .split(/[;,\s]+/)
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
}

async function loadAdminRecipients(adminClient: any) {
  const recipients = new Map<string, { email: string; name: string }>();
  for (const email of alertRecipientsFromEnvironment()) recipients.set(email, { email, name: "Nexus admin" });

  const { data, error } = await adminClient
    .from("profiles")
    .select("email, full_name, role")
    .in("role", ["admin", "admin_staff"]);
  if (!error) {
    for (const profile of data || []) {
      const email = cleanString(profile.email, 240).toLowerCase();
      if (email) recipients.set(email, { email, name: cleanString(profile.full_name, 180) || "Nexus admin" });
    }
  }
  return [...recipients.values()];
}

async function sendTransitionAlert(adminClient: any, kind: "outage" | "recovered", checks: MonitorCheck[], transitionId: string) {
  const errors = checks.filter((item) => item.status === "error");
  const summary = kind === "outage"
    ? errors.map((item) => `${item.label}: ${item.message}`).join(" | ")
    : "All monitored Nexus services are responding normally again.";
  const title = kind === "outage" ? "Nexus production outage detected" : "Nexus production services recovered";

  await adminClient.from("admin_notifications").insert({
    notification_type: kind === "outage" ? "system_outage" : "system_recovered",
    title,
    message: summary,
    status: "unread",
    metadata: { monitor_key: MONITOR_KEY, checks, transition_id: transitionId },
    created_at: nowIso(),
  });

  const recipients = await loadAdminRecipients(adminClient);
  for (const recipient of recipients) {
    await safeEnqueueEmail(
      adminClient,
      kind === "outage" ? "system_outage_alert" : "system_outage_recovered",
      recipient,
      {
        monitor_summary: summary,
        monitor_details: checks.map((item) => `${item.label}: ${item.status.toUpperCase()} ? ${item.message}`).join("\n"),
        checked_at: nowIso(),
        dashboard_url: "/pages/admin/health.html",
      },
      { dedupeKey: `system_${kind}:${MONITOR_KEY}:${transitionId}:${recipient.email}` },
    );
  }
  return recipients.length;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return errorResponse("Missing Supabase service configuration.", 500);

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const workerToken = cleanString(req.headers.get("x-nexus-monitor-worker"), 500);
  const { data: authorized, error: authorizationError } = await adminClient.rpc("authorize_system_monitor_worker", { p_token: workerToken });
  if (authorizationError || authorized !== true) return errorResponse("Monitor worker authorization failed.", 401);
  if (req.method !== "POST" && req.method !== "GET") return errorResponse("Method not allowed.", 405);

  const checks = await Promise.all([
    checkProductionSite(),
    checkN8n(),
    checkStripe(),
    checkRuntimeBacklog(adminClient),
    checkEmailBacklog(adminClient),
  ]);
  const errors = checks.filter((item) => item.status === "error");
  const warnings = checks.filter((item) => item.status === "warning");

  const { data: previous } = await adminClient
    .from("system_monitor_states")
    .select("*")
    .eq("monitor_key", MONITOR_KEY)
    .maybeSingle();

  const consecutiveFailures = errors.length ? Number(previous?.consecutive_failures || 0) + 1 : 0;
  const nextStatus = errors.length ? (consecutiveFailures >= FAILURE_THRESHOLD ? "error" : "warning") : "ok";
  const wasError = previous?.current_status === "error";
  const transition = nextStatus === "error" && !wasError ? "outage" : nextStatus === "ok" && wasError ? "recovered" : "none";
  const checkedAt = nowIso();
  const transitionId = transition === "none" ? cleanString(previous?.last_transition_id) : crypto.randomUUID();

  const statePatch: Record<string, unknown> = {
    monitor_key: MONITOR_KEY,
    current_status: nextStatus,
    consecutive_failures: consecutiveFailures,
    last_message: errors[0]?.message || warnings[0]?.message || "All monitored services are healthy.",
    last_details: { checks, errors: errors.length, warnings: warnings.length },
    last_checked_at: checkedAt,
    last_transition_id: transitionId || null,
    updated_at: checkedAt,
  };
  if (!previous || previous.current_status !== nextStatus) statePatch.last_changed_at = checkedAt;
  if (transition === "outage") statePatch.last_alerted_at = checkedAt;
  if (transition === "recovered") statePatch.last_recovered_at = checkedAt;

  const { error: stateError } = await adminClient
    .from("system_monitor_states")
    .upsert(statePatch, { onConflict: "monitor_key" });
  if (stateError) return errorResponse(stateError.message, 500);

  let alertedRecipients = 0;
  if (transition === "outage" || transition === "recovered") {
    alertedRecipients = await sendTransitionAlert(adminClient, transition, checks, transitionId);
  }

  return jsonResponse({
    ok: errors.length === 0,
    status: nextStatus,
    checked_at: checkedAt,
    consecutive_failures: consecutiveFailures,
    failure_threshold: FAILURE_THRESHOLD,
    transition,
    alerted_recipients: alertedRecipients,
    checks,
  }, errors.length ? 503 : 200);
});
