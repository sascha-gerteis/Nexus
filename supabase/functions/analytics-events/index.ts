import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const IPINFO_TOKEN = Deno.env.get("IPINFO_TOKEN") || "";

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

function isAdminAccessRole(role: unknown) {
  const value = cleanString(role, 80).toLowerCase();
  return value === "admin" || value === "admin_staff";
}

function daysFromBody(body: any) {
  return Math.max(1, Math.min(numberValue(body.days || body.range_days || 30), 365));
}

function audienceFromBody(body: any) {
  const audience = lower(body.audience || "customer");
  return ["customer", "developer", "admin", "all"].includes(audience) ? audience : "customer";
}

function visitorKey(event: any) {
  return cleanString(event.visitor_key || event.anonymous_id || event.user_id || event.session_id || event.id, 160);
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
      sessions: 0,
      page_views: 0,
      new_visitors: 0,
      returning_visitors: 0,
      authenticated_visitors: 0,
      pages_per_session: 0,
      events_per_session: 0,
      avg_session_seconds: 0,
      bounce_rate: 0,
      product_views: 0,
      profile_views: 0,
      checkout_starts: 0,
      message_clicks: 0,
      custom_request_starts: 0,
      custom_request_submits: 0,
    },
    meta: {
      aggregation_mode: "empty",
      data_complete: true,
    },
    daily: [],
    events_by_name: [],
    top_actions: [],
    top_pages: [],
    top_landing_pages: [],
    top_exit_pages: [],
    top_sources: [],
    countries: [],
    devices: [],
    user_roles: [],
    funnel: [],
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
  if (!isAdminAccessRole(auth.profile?.role)) throw new Error("Admin access required.");
  return auth;
}

async function requireDeveloper(req: Request, adminClient: any) {
  const auth = await getUserFromRequest(req, adminClient);
  if (auth.profile?.role !== "developer" && auth.profile?.role !== "admin") {
    throw new Error("Developer access required.");
  }

  if (isAdminAccessRole(auth.profile?.role)) {
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

function requestCountryCode(req: Request, body: any) {
  const value = cleanString(
    body.country_code ||
      req.headers.get("cf-ipcountry") ||
      req.headers.get("x-country-code") ||
      req.headers.get("x-vercel-ip-country") ||
      "",
    8,
  ).toUpperCase();
  return /^[A-Z]{2}$/.test(value) ? value : "";
}

function requestIpAddress(req: Request) {
  const forwarded = cleanString(
    req.headers.get("x-forwarded-for") ||
      req.headers.get("cf-connecting-ip") ||
      req.headers.get("x-real-ip") ||
      "",
    500,
  );
  const candidate = cleanString(forwarded.split(",")[0], 64).replace(/^\[|\]$/g, "");
  if (!candidate || !/^[0-9a-f:.]+$/i.test(candidate)) return "";
  if (
    candidate === "::1" ||
    /^f[cd][0-9a-f]{2}:/i.test(candidate) ||
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(candidate)
  ) return "";
  return candidate;
}

async function resolveCountryCode(req: Request, body: any, adminClient: any, effectiveVisitorKey: string) {
  const directCode = requestCountryCode(req, body);
  if (directCode) return directCode;

  if (effectiveVisitorKey) {
    const { data: previous } = await adminClient
      .from("analytics_events")
      .select("country_code")
      .eq("visitor_key", effectiveVisitorKey)
      .not("country_code", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const previousCode = cleanString(previous?.country_code, 8).toUpperCase();
    if (/^[A-Z]{2}$/.test(previousCode)) return previousCode;
  }

  if (!IPINFO_TOKEN) return "";
  const ipAddress = requestIpAddress(req);
  if (!ipAddress) return "";

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1800);
  try {
    const response = await fetch(
      `https://ipinfo.io/${encodeURIComponent(ipAddress)}?token=${encodeURIComponent(IPINFO_TOKEN)}`,
      { headers: { Accept: "application/json" }, signal: controller.signal },
    );
    if (!response.ok) return "";
    const payload = await response.json();
    const countryCode = cleanString(payload?.country, 8).toUpperCase();
    return /^[A-Z]{2}$/.test(countryCode) ? countryCode : "";
  } catch {
    return "";
  } finally {
    clearTimeout(timeoutId);
  }
}

function userAgentDimensions(value: unknown, hintedDevice: unknown = "") {
  const agent = lower(value);
  let deviceType = lower(hintedDevice);
  if (!["desktop", "mobile", "tablet"].includes(deviceType)) {
    deviceType = /ipad|tablet|kindle|silk/.test(agent)
      ? "tablet"
      : /mobi|android|iphone|ipod/.test(agent)
        ? "mobile"
        : "desktop";
  }

  const browserName = /edg\//.test(agent) ? "Edge"
    : /opr\//.test(agent) ? "Opera"
    : /firefox\//.test(agent) ? "Firefox"
    : /chrome\//.test(agent) ? "Chrome"
    : /safari\//.test(agent) ? "Safari"
    : "Other";
  const osName = /windows/.test(agent) ? "Windows"
    : /iphone|ipad|ipod/.test(agent) ? "iOS"
    : /android/.test(agent) ? "Android"
    : /mac os|macintosh/.test(agent) ? "macOS"
    : /linux/.test(agent) ? "Linux"
    : "Other";
  return { deviceType, browserName, osName };
}

async function trackEvent(req: Request, adminClient: any, body: any) {
  const auth = await getUserFromRequest(req, adminClient);
  const automation = await lookupAutomation(adminClient, body);
  const profileDeveloperId = cleanString(body.profile_developer_id || body.developer_profile_id, 80);
  const profileDeveloper = profileDeveloperId ? await lookupDeveloper(adminClient, profileDeveloperId) : null;
  const metadata = safeJsonObject(body.metadata, {});
  const viewport = safeJsonObject(body.viewport, {});
  const eventName = sanitizeEventName(body.event_name || body.event || body.name);
  const userAgent = cleanString(req.headers.get("user-agent") || body.user_agent || "", 1000);
  if (/bot\b|crawler|spider|slurp|headlesschrome|lighthouse/i.test(userAgent)) {
    return { tracked: false, ignored: "automated_client" };
  }

  const dimensions = userAgentDimensions(userAgent, body.device_type);
  const anonymousId = cleanString(body.anonymous_id || "", 120);
  const effectiveVisitorKey = anonymousId || auth.user?.id || cleanString(body.session_id || "", 120);
  const countryCode = await resolveCountryCode(req, body, adminClient, effectiveVisitorKey);

  const row = {
    event_name: eventName,
    event_type: cleanString(body.event_type || "interaction", 40),
    page_path: cleanString(body.page_path || body.path || "", 500),
    page_url: cleanString(body.page_url || body.url || "", 1000),
    referrer: cleanString(body.referrer || "", 1000),
    referrer_host: lower(body.referrer_host || "").replace(/^www\./, "").slice(0, 240),
    source: cleanString(body.source || "direct", 120).toLowerCase(),
    medium: cleanString(body.medium || "none", 120).toLowerCase(),
    campaign: cleanString(body.campaign || "", 160),
    landing_page: cleanString(body.landing_page || body.page_path || "/", 500),
    anonymous_id: anonymousId,
    session_id: cleanString(body.session_id || "", 120),
    visitor_key: effectiveVisitorKey || null,
    user_id: auth.user?.id || null,
    user_role: auth.profile?.role || "anonymous",
    country_code: countryCode || null,
    timezone: cleanString(body.timezone || "", 120),
    language: cleanString(body.language || "", 40),
    device_type: dimensions.deviceType,
    browser_name: dimensions.browserName,
    os_name: dimensions.osName,
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
    user_agent: userAgent,
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

function summarizeEvents(events, days) {
  const summary = emptySummary(days);
  const visitors = new Set();
  const authenticatedVisitors = new Set();
  const sessions = new Map();
  const daily = new Map();
  const byName = new Map();
  const byAction = new Map();
  const byPage = new Map();
  const byProduct = new Map();
  const byDeveloper = new Map();
  const byCountry = new Map();
  const byDevice = new Map();
  const byRole = new Map();
  const firstSeenByVisitor = new Map();
  const funnelVisitors = {
    product_view: new Set(),
    checkout_start: new Set(),
    message_intent: new Set(),
    custom_request_submit: new Set(),
  };

  function touchDimension(map, key, visitor, session, patch = {}) {
    const safeKey = key || "unknown";
    const item = map.get(safeKey) || { key: safeKey, events: 0, visitors: new Set(), sessions: new Set(), ...patch };
    item.events += 1;
    if (visitor) item.visitors.add(visitor);
    if (session) item.sessions.add(session);
    map.set(safeKey, item);
    return item;
  }

  function dimensionRows(map, limit = 20) {
    return Array.from(map.values())
      .map((item) => ({
        ...item,
        count: item.visitors.size,
        visitors: item.visitors.size,
        sessions: item.sessions.size,
      }))
      .map(({ key: _key, ...item }) => item)
      .sort((a, b) => Number(b.count || 0) - Number(a.count || 0))
      .slice(0, limit);
  }

  for (const event of events) {
    const name = cleanString(event.event_name);
    const visitor = visitorKey(event);
    const sessionId = cleanString(event.session_id || `event:${event.id}`, 160);
    const timestamp = new Date(event.created_at || 0).getTime() || 0;
    summary.totals.events += 1;

    if (visitor) visitors.add(visitor);
    if (visitor && event.user_id) authenticatedVisitors.add(visitor);

    const eventMetadata = safeJsonObject(event.metadata, {});
    const firstSeen = new Date(cleanString(eventMetadata.visitor_first_seen_at)).getTime();
    if (visitor && Number.isFinite(firstSeen) && firstSeen > 0) {
      firstSeenByVisitor.set(visitor, Math.min(firstSeenByVisitor.get(visitor) || firstSeen, firstSeen));
    }

    if (name === "page_view") summary.totals.page_views += 1;
    if (name === "product_view") summary.totals.product_views += 1;
    if (name === "developer_profile_view") summary.totals.profile_views += 1;
    if (name === "checkout_start") summary.totals.checkout_starts += 1;
    if (name === "message_developer_click" || name === "message_product_click") summary.totals.message_clicks += 1;
    if (name === "custom_request_start") summary.totals.custom_request_starts += 1;
    if (name === "custom_request_submit") summary.totals.custom_request_submits += 1;

    if (visitor && funnelVisitors[name]) funnelVisitors[name].add(visitor);
    if (visitor && (name === "message_developer_click" || name === "message_product_click")) funnelVisitors.message_intent.add(visitor);

    const session = sessions.get(sessionId) || {
      id: sessionId,
      visitor,
      firstAt: timestamp,
      lastAt: timestamp,
      events: 0,
      pageViews: 0,
      source: cleanString(event.source || "direct"),
      medium: cleanString(event.medium || "none"),
      campaign: cleanString(event.campaign || ""),
      landingPage: cleanString(event.landing_page || ""),
      exitPage: "",
    };
    session.events += 1;
    if (timestamp <= session.firstAt) {
      session.firstAt = timestamp;
      session.source = cleanString(event.source || session.source || "direct");
      session.medium = cleanString(event.medium || session.medium || "none");
      session.campaign = cleanString(event.campaign || session.campaign || "");
      session.landingPage = cleanString(event.landing_page || event.page_path || session.landingPage || "/");
    }
    if (timestamp >= session.lastAt) session.lastAt = timestamp;
    if (name === "page_view") {
      session.pageViews += 1;
      if (timestamp <= session.firstPageAt || !session.firstPageAt) {
        session.firstPageAt = timestamp;
        session.landingPage = cleanString(event.page_path || session.landingPage || "/");
      }
      if (timestamp >= session.lastPageAt || !session.lastPageAt) {
        session.lastPageAt = timestamp;
        session.exitPage = cleanString(event.page_path || "/");
      }
    }
    sessions.set(sessionId, session);

    const day = dayKey(event.created_at);
    const dayItem = daily.get(day) || { date: day, events: 0, page_views: 0, visitors: new Set(), sessions: new Set() };
    dayItem.events += 1;
    if (name === "page_view") dayItem.page_views += 1;
    if (visitor) dayItem.visitors.add(visitor);
    if (sessionId) dayItem.sessions.add(sessionId);
    daily.set(day, dayItem);

    const eventItem = touchDimension(byName, name || "unknown", visitor, sessionId, { event_name: name || "unknown" });
    eventItem.count = eventItem.events;
    if (name !== "page_view") {
      const actionItem = touchDimension(byAction, name || "unknown", visitor, sessionId, { event_name: name || "unknown" });
      actionItem.count = actionItem.events;
    }

    if (name === "page_view" && event.page_path) {
      const page = touchDimension(byPage, event.page_path, visitor, sessionId, {
        page_path: event.page_path,
        page_url: event.page_url || "",
      });
      page.page_views = page.events;
      page.count = page.events;
    }

    if (event.automation_id || event.product_slug || event.product_title) {
      const key = cleanString(event.automation_id || event.product_slug || event.product_title);
      const product = byProduct.get(key) || {
        key,
        count: 0,
        views: 0,
        checkout_starts: 0,
        message_clicks: 0,
        visitors: new Set(),
        automation_id: event.automation_id || "",
        product_slug: event.product_slug || "",
        product_title: event.product_title || "Untitled product",
        developer_id: event.developer_id || "",
        developer_name: event.developer_name || "",
      };
      product.count += 1;
      if (name === "product_view") product.views += 1;
      if (name === "checkout_start") product.checkout_starts += 1;
      if (name === "message_developer_click" || name === "message_product_click") product.message_clicks += 1;
      if (visitor) product.visitors.add(visitor);
      byProduct.set(key, product);
    }

    if (event.developer_id || event.profile_developer_id || event.developer_name) {
      const developer = touchDimension(byDeveloper, cleanString(event.developer_id || event.profile_developer_id || event.developer_name), visitor, sessionId, {
        developer_id: event.developer_id || event.profile_developer_id || "",
        developer_name: event.developer_name || "Unknown developer",
      });
      developer.count = developer.events;
      if (name === "developer_profile_view") developer.profile_views = Number(developer.profile_views || 0) + 1;
      if (name === "product_view") developer.product_views = Number(developer.product_views || 0) + 1;
    }

    const country = touchDimension(byCountry, cleanString(event.country_code || "UNKNOWN").toUpperCase(), visitor, sessionId, {
      country_code: cleanString(event.country_code || "UNKNOWN").toUpperCase(),
    });
    if (name === "page_view") country.page_views = Number(country.page_views || 0) + 1;
    touchDimension(byDevice, [event.device_type || "unknown", event.browser_name || "Other", event.os_name || "Other"].join("|"), visitor, sessionId, {
      device_type: event.device_type || "unknown",
      browser_name: event.browser_name || "Other",
      os_name: event.os_name || "Other",
    });
    touchDimension(byRole, cleanString(event.user_role || "anonymous"), visitor, sessionId, {
      user_role: cleanString(event.user_role || "anonymous"),
    });
  }

  summary.totals.unique_visitors = visitors.size;
  summary.totals.sessions = sessions.size;
  summary.totals.authenticated_visitors = authenticatedVisitors.size;
  summary.totals.pages_per_session = sessions.size ? Number((summary.totals.page_views / sessions.size).toFixed(2)) : 0;
  summary.totals.events_per_session = sessions.size ? Number((summary.totals.events / sessions.size).toFixed(2)) : 0;
  summary.totals.avg_session_seconds = sessions.size
    ? Number((Array.from(sessions.values()).reduce((total, session) => total + Math.max(0, session.lastAt - session.firstAt) / 1000, 0) / sessions.size).toFixed(1))
    : 0;
  summary.totals.bounce_rate = sessions.size
    ? Number((100 * Array.from(sessions.values()).filter((session) => session.pageViews <= 1).length / sessions.size).toFixed(1))
    : 0;
  const rangeStart = new Date(sinceIso(days)).getTime();
  summary.totals.new_visitors = Array.from(visitors).filter((visitor) => Number(firstSeenByVisitor.get(visitor) || 0) >= rangeStart).length;
  summary.totals.returning_visitors = Array.from(visitors).filter((visitor) => {
    const firstSeen = Number(firstSeenByVisitor.get(visitor) || 0);
    return firstSeen > 0 && firstSeen < rangeStart;
  }).length;
  summary.meta = { aggregation_mode: "paginated_fallback", data_complete: true };
  summary.daily = Array.from(daily.values()).map((item) => ({
    date: item.date,
    count: item.events,
    events: item.events,
    page_views: item.page_views,
    visitors: item.visitors.size,
    sessions: item.sessions.size,
  })).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  summary.events_by_name = dimensionRows(byName, 30).map((item) => ({ ...item, count: item.events }));
  summary.top_actions = dimensionRows(byAction, 20).map((item) => ({ ...item, count: item.events }));
  summary.top_pages = dimensionRows(byPage, 20).map((item) => ({ ...item, count: item.events, page_views: item.events }));

  const bySource = new Map();
  const byLanding = new Map();
  const byExit = new Map();
  for (const session of sessions.values()) {
    const source = touchDimension(bySource, `${session.source}|${session.medium}`, session.visitor, session.id, {
      source: session.source || "direct",
      medium: session.medium || "none",
      campaign_sessions: 0,
    });
    if (session.campaign) source.campaign_sessions += 1;
    touchDimension(byLanding, session.landingPage || "/", session.visitor, session.id, { page_path: session.landingPage || "/" });
    touchDimension(byExit, session.exitPage || session.landingPage || "/", session.visitor, session.id, { page_path: session.exitPage || session.landingPage || "/" });
  }
  summary.top_sources = dimensionRows(bySource, 20).map((item) => ({ ...item, count: item.sessions }));
  summary.top_landing_pages = dimensionRows(byLanding, 20).map((item) => ({ ...item, count: item.sessions }));
  summary.top_exit_pages = dimensionRows(byExit, 20).map((item) => ({ ...item, count: item.sessions }));
  summary.countries = dimensionRows(byCountry, 20);
  summary.devices = dimensionRows(byDevice, 20);
  summary.user_roles = dimensionRows(byRole, 20);
  summary.top_products = Array.from(byProduct.values()).map((item) => ({ ...item, visitors: item.visitors.size }))
    .map(({ key: _key, ...item }) => item)
    .sort((a, b) => Number(b.views || 0) - Number(a.views || 0) || Number(b.count || 0) - Number(a.count || 0)).slice(0, 20);
  summary.top_developers = dimensionRows(byDeveloper, 20).map((item) => ({ ...item, count: item.events }));
  summary.funnel = [
    { stage: "Visitors", visitors: visitors.size, rate: visitors.size ? 100 : 0 },
    { stage: "Product viewers", visitors: funnelVisitors.product_view.size },
    { stage: "Checkout starts", visitors: funnelVisitors.checkout_start.size },
    { stage: "Message intent", visitors: funnelVisitors.message_intent.size },
    { stage: "Custom requests sent", visitors: funnelVisitors.custom_request_submit.size },
  ].map((item) => ({ ...item, rate: item.rate ?? (visitors.size ? Number((100 * item.visitors / visitors.size).toFixed(1)) : 0) }));
  summary.recent_events = events.slice(0, 40).map((event) => ({
    id: event.id,
    event_name: event.event_name,
    page_path: event.page_path,
    product_title: event.product_title,
    developer_name: event.developer_name,
    user_role: event.user_role,
    source: event.source || "direct",
    country_code: event.country_code || "UNKNOWN",
    device_type: event.device_type || "unknown",
    created_at: event.created_at,
  }));

  return summary;
}

async function fetchEvents(adminClient: any, days: number, build: (query: any) => any) {
  const pageSize = 1000;
  const maxRows = 100000;
  const events: any[] = [];

  while (events.length < maxRows) {
    let query = adminClient
      .from("analytics_events")
      .select("*")
      .gte("created_at", sinceIso(days))
      .order("created_at", { ascending: false })
      .range(events.length, events.length + pageSize - 1);

    query = build(query);
    const { data, error } = await query;
    if (error) {
      const message = error.message || "Could not load analytics events.";
      if (/analytics_events|schema cache|relation .* does not exist|could not find/i.test(message)) {
        throw new Error(`${message} Run supabase/analytics_install_or_patch.sql in the Supabase SQL editor, then redeploy analytics-events.`);
      }
      throw new Error(message);
    }

    const page = data || [];
    events.push(...page);
    if (page.length < pageSize) break;
  }

  return { events, truncated: events.length >= maxRows };
}

async function adminSummary(req: Request, adminClient: any, body: any) {
  await requireAdmin(req, adminClient);
  const days = daysFromBody(body);
  const audience = audienceFromBody(body);
  const { data: aggregate, error: aggregateError } = await adminClient.rpc("get_admin_analytics_summary", {
    p_days: days,
    p_audience: audience,
  });

  if (!aggregateError && aggregate) {
    return {
      ...aggregate,
      meta: {
        ...safeJsonObject(aggregate.meta, {}),
        country_lookup_configured: Boolean(IPINFO_TOKEN),
      },
    };
  }

  console.warn("Database analytics aggregation unavailable; using paginated fallback:", aggregateError?.message || "unknown error");
  const audienceFilter = (query: any) => {
    if (audience === "customer") return query.or("user_role.is.null,user_role.in.(anonymous,buyer,customer)");
    if (audience === "developer") return query.eq("user_role", "developer");
    if (audience === "admin") return query.in("user_role", ["admin", "admin_staff"]);
    return query;
  };
  const fetched = await fetchEvents(adminClient, days, audienceFilter);
  const summary = summarizeEvents(fetched.events, days);
  summary.meta = {
    aggregation_mode: "paginated_fallback",
    data_complete: !fetched.truncated,
    row_limit: fetched.truncated ? 100000 : null,
    audience,
    country_lookup_configured: Boolean(IPINFO_TOKEN),
  };
  return summary;
}

async function developerSummary(req: Request, adminClient: any, body: any) {
  const auth: any = await requireDeveloper(req, adminClient);
  const days = daysFromBody(body);

  if (isAdminAccessRole(auth.profile?.role) && body.developer_id) {
    const developerId = cleanString(body.developer_id, 80);
    const fetched = await fetchEvents(adminClient, days, (query) =>
      query.or(`developer_id.eq.${developerId},profile_developer_id.eq.${developerId}`)
    );
    return summarizeEvents(fetched.events, days);
  }

  const developerId = cleanString(auth.developer?.id, 80);
  const fetched = await fetchEvents(adminClient, days, (query) =>
    query.or(`developer_id.eq.${developerId},profile_developer_id.eq.${developerId}`)
  );
  const summary = summarizeEvents(fetched.events, days);
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
