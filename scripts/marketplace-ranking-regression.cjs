const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const assert = (condition, message) => {
  if (!condition) throw new Error(`Marketplace ranking regression failed: ${message}`);
};
const includesAll = (source, markers, label) => {
  for (const marker of markers) assert(source.includes(marker), `${label} is missing: ${marker}`);
};

const migration = read("supabase/migrations/20260819000300_marketplace_click_ranking.sql");
const install = read("supabase/analytics_install_or_patch.sql");
const endpoint = read("supabase/functions/analytics-events/index.ts");
const nexusDb = read("assets/js/nexus-db.js");
const nexusApp = read("assets/js/nexus-app.js");
const marketplace = read("pages/marketplace/index.html");

includesAll(migration, [
  "create or replace function public.get_marketplace_product_ranking",
  "e.event_name in ('product_view', 'bundle_view')",
  "count(distinct n.effective_visitor)",
  "interval '30 days'",
  "grant execute on function public.get_marketplace_product_ranking(integer) to service_role",
  "revoke all on function public.get_marketplace_product_ranking(integer) from anon",
  "revoke all on function public.get_marketplace_product_ranking(integer) from authenticated",
], "ranking migration");
assert(install.includes("get_marketplace_product_ranking"), "analytics recovery SQL must restore the ranking function");

includesAll(endpoint, [
  "async function marketplaceRanking(adminClient: any)",
  'adminClient.rpc("get_marketplace_product_ranking"',
  'action === "marketplace_ranking"',
  "result = await marketplaceRanking(adminClient)",
  "unique_clicks_30: numberValue(item.unique_clicks_30)",
], "analytics aggregate endpoint");
const publicAction = endpoint.slice(endpoint.indexOf('if (action === "track")'), endpoint.indexOf('} else if (action === "admin_summary")'));
assert(!publicAction.includes("requireAdmin") && !publicAction.includes("analytics_events"), "public ranking action must expose only aggregate RPC data");

includesAll(nexusDb, [
  "async function getMarketplaceProductRanking()",
  'cachedQuery("marketplace:click-ranking:v1"',
  'action: "marketplace_ranking"',
  "5 * 60 * 1000",
  "getMarketplaceProductRanking,",
], "browser ranking wrapper");

includesAll(nexusApp, [
  'const NICHE_BOTTOM_PRODUCT_SLUGS = new Set(["tech-sales-job-alerts"])',
  "function rankMarketplaceItems(items = [])",
  '["unique_clicks_30", "clicks_30", "unique_clicks_90", "clicks_90"]',
  "NexusDB.getMarketplaceProductRanking()",
  "loadMarketplaceClickRanking(rankingResult)",
  "items = rankMarketplaceItems(items);",
  "window.NexusMarketplaceProducts = rankMarketplaceItems",
], "marketplace sorter");
assert(marketplace.includes("20260819-click-ranking"), "marketplace cache key must load the new ranking code");

const functionStart = nexusApp.indexOf("  function marketplaceRankingKeys");
const functionEnd = nexusApp.indexOf("  async function renderMarketplace", functionStart);
assert(functionStart >= 0 && functionEnd > functionStart, "could not isolate ranking functions for semantic test");
const rankingFunctions = nexusApp.slice(functionStart, functionEnd);
const context = vm.createContext({ Map, Set, String, Number, Boolean });
new vm.Script(`
  let marketplaceClickRanking = new Map();
  const NICHE_BOTTOM_PRODUCT_SLUGS = new Set(["tech-sales-job-alerts"]);
  ${rankingFunctions}
  globalThis.testRanking = { loadMarketplaceClickRanking, rankMarketplaceItems };
`).runInContext(context);

context.testRanking.loadMarketplaceClickRanking({ data: { ranking: [
  { listing_type: "product", listing_id: "broad", unique_clicks_30: 5, clicks_30: 6, unique_clicks_90: 5, clicks_90: 6 },
  { listing_type: "product", listing_id: "repeat", unique_clicks_30: 3, clicks_30: 100, unique_clicks_90: 3, clicks_90: 100 },
  { listing_type: "product", listing_id: "tie", unique_clicks_30: 5, clicks_30: 8, unique_clicks_90: 5, clicks_90: 8 },
  { listing_type: "product", listing_id: "tech", unique_clicks_30: 999, clicks_30: 999, unique_clicks_90: 999, clicks_90: 999 },
] } });
const ranked = context.testRanking.rankMarketplaceItems([
  { id: "repeat", slug: "repeat" },
  { id: "tech", slug: "tech-sales-job-alerts" },
  { id: "broad", slug: "broad" },
  { id: "tie", slug: "tie" },
]);
assert(ranked.map((item) => item.id).join(",") === "tie,broad,repeat,tech", "unique recent clicks, total clicks, and niche override must determine order");

new vm.Script(nexusDb, { filename: "nexus-db.js" });
new vm.Script(nexusApp, { filename: "nexus-app.js" });
console.log("Marketplace click ranking regression passed.");
