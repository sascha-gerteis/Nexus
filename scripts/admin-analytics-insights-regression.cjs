const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const assert = (condition, message) => {
  if (!condition) throw new Error(`Admin analytics regression failed: ${message}`);
};
const includesAll = (source, markers, label) => {
  for (const marker of markers) assert(source.includes(marker), `${label} is missing: ${marker}`);
};

const edge = read("supabase/functions/analytics-events/index.ts");
const client = read("assets/js/nexus-db.js");
const adminPage = read("pages/admin/analytics.html");
const schema = read("supabase/analytics_install_or_patch.sql");
const migration = read("supabase/migrations/20260801000100_analytics_insights.sql");
const privacy = read("pages/legal/privacy.html");
const workflow = read(".github/workflows/deploy-pages.yml");

includesAll(edge, [
  'const pageSize = 1000',
  'const maxRows = 100000',
  '.range(events.length, events.length + pageSize - 1)',
  'adminClient.rpc("get_admin_analytics_summary"',
  'p_audience: audience',
  'aggregation_mode: "paginated_fallback"',
  'req.headers.get("cf-ipcountry")',
  'req.headers.get("x-forwarded-for")',
  'const IPINFO_TOKEN = Deno.env.get("IPINFO_TOKEN")',
  'https://ipinfo.io/',
  'resolveCountryCode(req, body, adminClient, effectiveVisitorKey)',
  'country_lookup_configured: Boolean(IPINFO_TOKEN)',
  'visitor_key:',
  'country_code:',
  'device_type:',
  'top_landing_pages',
  'top_exit_pages',
  'top_sources',
  'automated_client',
], "analytics Edge Function");
assert(!edge.includes(".limit(20000)"), "the incomplete 20,000-row fetch must not return");

const summarizeSource = edge.match(/function summarizeEvents[\s\S]*?(?=\nasync function fetchEvents)/)?.[0] || "";
assert(summarizeSource, "fallback summarizer could not be extracted");
const emptySummary = (days) => ({
  days,
  totals: {
    events: 0,
    page_views: 0,
    unique_visitors: 0,
    sessions: 0,
    new_visitors: 0,
    returning_visitors: 0,
    authenticated_visitors: 0,
    product_views: 0,
    developer_profile_views: 0,
    checkout_clicks: 0,
    orders: 0,
    setup_submissions: 0,
    output_views: 0,
    custom_submits: 0,
    pages_per_session: 0,
    events_per_session: 0,
    avg_session_seconds: 0,
    bounce_rate: 0,
  },
  aggregation_mode: "empty",
  data_complete: true,
  scanned_rows: 0,
  truncated: false,
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
  top_products: [],
  top_developers: [],
  funnel: [],
  recent_events: [],
});
const cleanString = (value, max = 500) => String(value ?? "").trim().slice(0, max);
const safeJsonObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const visitorKey = (event) => cleanString(event.visitor_key || event.anonymous_id || event.user_id || event.session_id || "anonymous");
const sinceIso = (days) => new Date(Date.now() - days * 86400000).toISOString();
const dayKey = (value) => new Date(value).toISOString().slice(0, 10);
const summarizeEvents = new Function(
  "emptySummary",
  "cleanString",
  "safeJsonObject",
  "visitorKey",
  "sinceIso",
  "dayKey",
  `${summarizeSource}; return summarizeEvents;`,
)(emptySummary, cleanString, safeJsonObject, visitorKey, sinceIso, dayKey);

const largeFixture = Array.from({ length: 2505 }, (_, index) => {
  const visitor = `visitor-${index % 35}`;
  const session = `session-${index % 70}`;
  const eventNames = ["page_view", "product_view", "checkout_click", "order_created", "setup_submit", "output_view"];
  const event_name = eventNames[index % eventNames.length];
  return {
    id: `event-${index}`,
    event_name,
    action: event_name,
    visitor_key: visitor,
    anonymous_id: visitor,
    session_id: session,
    user_id: index % 5 === 0 ? `user-${index % 11}` : null,
    user_role: index % 5 === 0 ? "buyer" : "anonymous",
    page_path: index % 2 === 0 ? "/" : "/pages/marketplace.html",
    page_title: index % 2 === 0 ? "Nexus" : "Marketplace",
    landing_page: index % 3 === 0 ? "/" : "/pages/marketplace.html",
    referrer_host: index % 4 === 0 ? "google.com" : "",
    source: index % 4 === 0 ? "google" : "direct",
    medium: index % 4 === 0 ? "organic" : "none",
    campaign: "",
    country_code: index % 2 === 0 ? "TH" : "CH",
    device_type: index % 2 === 0 ? "desktop" : "mobile",
    browser_name: "Chrome",
    os_name: index % 2 === 0 ? "Windows" : "Android",
    metadata: { is_new_visitor: index < 35 },
    created_at: new Date(Date.now() - index * 1000).toISOString(),
  };
});
const largeSummary = summarizeEvents(largeFixture, 30);
assert(largeSummary.totals.events === 2505, "fallback summary was capped below 2,505 events");
assert(largeSummary.totals.unique_visitors === 35, "fallback unique visitors are incorrect");
assert(largeSummary.totals.sessions === 70, "fallback sessions are incorrect");
assert(largeSummary.top_sources.length >= 2, "fallback sources were not aggregated");
assert(largeSummary.countries.some((country) => country.country_code === "TH" && country.page_views > 0), "country page views were not aggregated");
assert(largeSummary.devices.length >= 2, "fallback devices were not aggregated");
assert(largeSummary.funnel.length >= 5, "fallback funnel was not aggregated");

includesAll(client, [
  "ANALYTICS_SESSION_TIMEOUT_MS",
  'nexus_analytics_session_v2',
  'landing_page: session.landing_page',
  'referrer_host: session.referrer_host',
  'source: session.source',
  'campaign: session.campaign',
  'timezone: Intl.DateTimeFormat().resolvedOptions().timeZone',
  'device_type: analyticsDeviceType()',
  'navigator.globalPrivacyControl === true',
  'nexus_analytics_opt_out',
  'async function getAdminAnalytics(days = 30, audience = "customer")',
], "browser analytics client");

for (const column of [
  "visitor_key",
  "landing_page",
  "referrer_host",
  "source",
  "medium",
  "campaign",
  "country_code",
  "timezone",
  "language",
  "device_type",
  "browser_name",
  "os_name",
]) {
  assert(schema.includes(`add column if not exists ${column}`), `installer is missing ${column}`);
  assert(migration.includes(`add column if not exists ${column}`), `migration is missing ${column}`);
}

includesAll(migration, [
  "create or replace function public.get_admin_analytics_summary",
  "period_events as materialized",
  "count(distinct effective_visitor)",
  "session_stats as materialized",
  "'top_landing_pages'",
  "'top_exit_pages'",
  "'top_sources'",
  "'countries'",
  "'devices'",
  "'funnel'",
  "'aggregation_mode', 'database'",
  "grant execute on function public.get_admin_analytics_summary(integer, text) to service_role",
], "database aggregation migration");

includesAll(adminPage, [
  'id="analyticsAudience"',
  'id="analyticsIntentSummary"',
  'id="analyticsDataQuality"',
  'id="topSources"',
  'id="topLandingPages"',
  'id="topExitPages"',
  'id="topCountries"',
  'id="topDevices"',
  'id="userRoles"',
  'id="topActions"',
  'id="analyticsFunnel"',
  "Full-range database aggregation",
  "no 1,000-row ceiling",
  "country lookup needs an IPINFO_TOKEN",
  "NexusDB.getAdminAnalytics(days, audience)",
], "admin analytics page");

const inlineScript = adminPage.match(/<script>\s*([\s\S]*?)<\/script>\s*<\/body>/)?.[1] || "";
assert(inlineScript, "admin inline script could not be extracted");
new Function(inlineScript);

includesAll(privacy, [
  "referrer domain",
  "approximate country code",
  "Nexus analytics does not store the raw IP address",
], "privacy disclosure");

const htmlFiles = [];
const ignoredDirectories = new Set([".git", ".p29", "node_modules", "nexus-phase1-final"]);
const walk = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const ignored =
        ignoredDirectories.has(entry.name) ||
        entry.name.startsWith(".codex-");
      if (!ignored) walk(fullPath);
    }
    else if (entry.name.endsWith(".html")) htmlFiles.push(fullPath);
  }
};
walk(root);
assert(
  !htmlFiles.some((file) => read(path.relative(root, file)).includes("nexus-db.js?v=20260714-paid-orders-only")),
  "an HTML page still uses the old analytics client cache key",
);
assert(workflow.includes("node scripts/admin-analytics-insights-regression.cjs"), "deployment workflow is missing the analytics regression");

console.log("Admin analytics insights regression passed.");
