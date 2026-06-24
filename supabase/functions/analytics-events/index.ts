import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function cleanString(value: unknown, max = 500) {
  return String(value ?? "").trim().slice(0, max);
}

function lower(value: unknown) {
  return cleanString(value).toLowerCase();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeJsonObject(value: unknown, fallback: Record<string, unknown> = {}) {
  if (isObject(value)) return value;
  if (typeof value !== "string") return fallback;

  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function numberValue(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function daysFromBody(body: any) {
  return Math.max(1, Math.min(numberValue(body.days || body.range_days || 30), 365));
}

function sinceIso(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function dayKey(value: unknown) {
  const date = value ? new Date(String(value)) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function inc(map: Map<string, any>, key: string, patch: Record<string, unknown> = {}) {
  const safeKey = key || "Unknown";
  const current = map.get(safeKey) || { key: safeKey, count: 0, ...patch };
  current.count += 1;

  for (const [name, value] of Object.entries(patch)) {
    if (current[name] === undefined || current[name] === "" || current[name] === null) {
      current[name] = value;
    }
  }

  map.set(safeKey, current);
  return current;
}

function top(map: Map<string, any>, limit = 10) {
  return Array.from(map.values())
    .sort((a, b) => Number(b.count || 0) - Number(a.count || 0))
    .slice(0, limit);
}

function emptySummary(days: number) {
  return {
    days,
    totals: {
      events: 0,
      unique_visitors: 0,
      page_views: 0,
      product_views: 0,
      profile_views: 0,
      checkout_starts: 0,
      message_clicks: 0,
      custom_request_starts: 0,
    },
    daily: [],
    events_by_name: [],
    top_pages: [],
    top_products: [],
    top_developers: [],
    recent_events: [],
  };
}

async function getUserFromRequest(req: Request, adminClient: any) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  if (!token || token === SUPABASE_ANON_KEY) {
    return { user: null, profile: null };
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  });

  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data?.user) return { user: null, profile: null };

  const { data: profile } = await adminClient
    .from("profiles")
    .select("id, role")
    .eq("id", data.user.id)
    .maybeSingle();

  return { user: data.user, profile: profile || null };
}

async function requireAdmin(req: Request, adminClient: any) {
  const auth = await getUserFromRequest(req, adminClient);
  if (auth.profile?.role !== "admin") throw new Error("Admin access required.");
  return auth;
}

async function requireDeveloper(req: Request, adminClient: any) {
  const auth = await getUserFromRequest(req, adminClient);
  if (auth.profile?.role !== "developer" && auth.profile?.role !== "admin") {
    throw new Error("Developer access required.");
  }

  if (auth.profile?.role === "admin") {
    return { ...auth, developer: null };
  }

  const { data: developer, error } = await adminClient
    .from("developers")
    .select("id, display_name, handle, profile_id")
    .eq("profile_id", auth.user.id)
    .maybeSingle();

  if (error || !developer) throw new Error(error?.message || "Developer profile not found.");
  return { ...auth, developer };
}

async function lookupAutomation(adminClient: any, body: any) {
  const automationId = cleanString(body.automation_id || body.product_id, 80);
  const slug = cleanString(body.product_slug || body.slug, 160);

  if (!automationId && !slug) return null;

  let query = adminClient
    .from("automations")
    .select("id, title, slug, developer_id, developers(id, display_name, handle)")
    .limit(1);

  query = automationId ? query.eq("id", automationId) : query.eq("slug", slug);

  const { data } = await query.maybeSingle();
  return data || null;
}

async function lookupDeveloper(adminClient: any, developerId: string) {
  if (!developerId) return null;

  const { data } = await adminClient
    .from("developers")
    .select("id, display_name, handle")
    .eq("id", developerId)
    .maybeSingle();

  return data || null;
}

function sanitizeEventName(value: unknown) {
  return cleanString(value || "event", 80)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "event";
}

async function trackEvent(req: Request, adminClient: any, body: any) {
  const auth = await getUserFromRequest(req, adminClient);
  const automation = await lookupAutomation(adminClient, body);
  const profileDeveloperId = cleanString(body.profile_developer_id || body.developer_profile_id, 80);
  const profileDeveloper = profileDeveloperId ? await lookupDeveloper(adminClient, profileDeveloperId) : null;
  const metadata = safeJsonObject(body.metadata, {});
  const viewport = safeJsonObject(body.viewport, {});
  const eventName = sanitizeEventName(body.event_name || body.event || body.name);

  const row = {
    event_name: eventName,
    event_type: cleanString(body.event_type || "interaction", 40),
    page_path: cleanString(body.page_path || body.path || "", 500),
    page_url: cleanString(body.page_url || body.url || "", 1000),
    referrer: cleanString(body.referrer || "", 1000),
    anonymous_id: cleanString(body.anonymous_id || "", 120),
    session_id: cleanString(body.session_id || "", 120),
    user_id: auth.user?.id || null,
    user_role: auth.profile?.role || "anonymous",
    developer_id: automation?.developer_id || cleanString(body.developer_id, 80) || null,
    profile_developer_id: profileDeveloper?.id || null,
    automation_id: automation?.id || null,
    product_slug: automation?.slug || cleanString(body.product_slug || body.slug, 160) || null,
    product_title: automation?.title || cleanString(body.product_title, 240) || null,
    developer_name:
      automation?.developers?.display_name ||
      profileDeveloper?.display_name ||
      cleanString(body.developer_name, 240) ||
      null,
    metadata,
    viewport,
    user_agent: cleanString(req.headers.get("user-agent") || body.user_agent || "", 1000),
  };

  const { error } = await adminClient.from("analytics_events").insert(row);

  if (error) {
    const message = error.message || "Could not record analytics event.";
    if (/analytics_events|schema cache|relation .* does not exist|could not find/i.test(message)) {
      throw new Error(`${message} Run supabase/analytics_install_or_patch.sql in the Supabase SQL editor, then redeploy analytics-events.`);
    }
    throw new Error(message);
  }

  return { tracked: true };
}

function summarizeEvents(events: any[], days: number) {
  const summary = emptySummary(days);
  const visitors = new Set<string>();
  const daily = new Map<string, any>();
  const byName = new Map<string, any>();
  const byPage = new Map<string, any>();
  const byProduct = new Map<string, any>();
  const byDeveloper = new Map<string, any>();

  for (const event of events) {
    const name = cleanString(event.event_name);
    summary.totals.events += 1;

    const visitor = cleanString(event.anonymous_id || event.user_id || event.session_id);
    if (visitor) visitors.add(visitor);

    if (name === "page_view") summary.totals.page_views += 1;
    if (name === "product_view") summary.totals.product_views += 1;
    if (name === "developer_profile_view") summary.totals.profile_views += 1;
    if (name === "checkout_start") summary.totals.checkout_starts += 1;
    if (name === "message_developer_click" || name === "message_product_click") summary.totals.message_clicks += 1;
    if (name === "custom_request_start") summary.totals.custom_request_starts += 1;

    inc(daily, dayKey(event.created_at), { date: dayKey(event.created_at) });
    inc(byName, name || "unknown", { event_name: name || "unknown" });

    if (event.page_path) {
      inc(byPage, event.page_path, {
        page_path: event.page_path,
        page_url: event.page_url || "",
      });
    }

    if (event.automation_id || event.product_slug || event.product_title) {
      inc(byProduct, cleanString(event.automation_id || event.product_slug || event.product_title), {
        automation_id: event.automation_id || "",
        product_slug: event.product_slug || "",
        product_title: event.product_title || "Untitled product",
        developer_id: event.developer_id || "",
        developer_name: event.developer_name || "",
      });
    }

    if (event.developer_id || event.profile_developer_id || event.developer_name) {
      inc(byDeveloper, cleanString(event.developer_id || event.profile_developer_id || event.developer_name), {
        developer_id: event.developer_id || event.profile_developer_id || "",
        developer_name: event.developer_name || "Unknown developer",
      });
    }
  }

  summary.totals.unique_visitors = visitors.size;
  summary.daily = Array.from(daily.values()).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  summary.events_by_name = top(byName, 20);
  summary.top_pages = top(byPage, 12);
  summary.top_products = top(byProduct, 12);
  summary.top_developers = top(byDeveloper, 12);
  summary.recent_events = events.slice(0, 25).map((event) => ({
    id: event.id,
    event_name: event.event_name,
    page_path: event.page_path,
    product_title: event.product_title,
    developer_name: event.developer_name,
    user_role: event.user_role,
    created_at: event.created_at,
  }));

  return summary;
}

async function fetchEvents(adminClient: any, days: number, build: (query: any) => any) {
  let query = adminClient
    .from("analytics_events")
    .select("*")
    .gte("created_at", sinceIso(days))
    .order("created_at", { ascending: false })
    .limit(20000);

  query = build(query);

  const { data, error } = await query;
  if (error) {
    const message = error.message || "Could not load analytics events.";
    if (/analytics_events|schema cache|relation .* does not exist|could not find/i.test(message)) {
      throw new Error(`${message} Run supabase/analytics_install_or_patch.sql in the Supabase SQL editor, then redeploy analytics-events.`);
    }
    throw new Error(message);
  }

  return data || [];
}

async function adminSummary(req: Request, adminClient: any, body: any) {
  await requireAdmin(req, adminClient);
  const days = daysFromBody(body);
  const events = await fetchEvents(adminClient, days, (query) => query);
  return summarizeEvents(events, days);
}

async function developerSummary(req: Request, adminClient: any, body: any) {
  const auth: any = await requireDeveloper(req, adminClient);
  const days = daysFromBody(body);

  if (auth.profile?.role === "admin" && body.developer_id) {
    const developerId = cleanString(body.developer_id, 80);
    const events = await fetchEvents(adminClient, days, (query) =>
      query.or(`developer_id.eq.${developerId},profile_developer_id.eq.${developerId}`)
    );
    return summarizeEvents(events, days);
  }

  const developerId = cleanString(auth.developer?.id, 80);
  const events = await fetchEvents(adminClient, days, (query) =>
    query.or(`developer_id.eq.${developerId},profile_developer_id.eq.${developerId}`)
  );
  const summary = summarizeEvents(events, days);
  return {
    ...summary,
    developer: auth.developer || null,
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
      message: "analytics-events is alive.",
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed.", 405);
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
      return errorResponse("Missing Supabase function secrets.", 500);
    }

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = await req.json().catch(() => ({}));
    const action = cleanString(body.action || "track");

    let result;
    if (action === "track") {
      result = await trackEvent(req, adminClient, body);
    } else if (action === "admin_summary") {
      result = await adminSummary(req, adminClient, body);
    } else if (action === "developer_summary") {
      result = await developerSummary(req, adminClient, body);
    } else {
      return errorResponse("Unknown analytics action.", 400);
    }

    return jsonResponse({
      ok: true,
      ...result,
    });
  } catch (error) {
    console.error("analytics-events failed:", error);
    return errorResponse(error instanceof Error ? error.message : "Analytics request failed.", 500);
  }
});
