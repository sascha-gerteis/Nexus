const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const migration = read("supabase/migrations/20260812000100_buyer_webhook_setup.sql");
const usageMigration = read("supabase/migrations/20260812000300_buyer_webhook_usage_metering.sql");
const configFunction = read("supabase/functions/buyer-webhook-config/index.ts");
const ingressFunction = read("supabase/functions/buyer-webhook-ingress/index.ts");
const cors = read("supabase/functions/_shared/cors.ts");
const supabaseConfig = read("supabase/config.toml");
const buyerPage = read("pages/buyer/webhook-setup.html");
const buyerDashboard = read("pages/buyer/dashboard.html");
const checkoutSuccess = read("pages/checkout/success.html");
const buyerSetup = read("pages/buyer/setup.html");
const nexusDb = read("assets/js/nexus-db.js");

for (const [source, marker, label] of [
  [migration, "create table if not exists public.customer_automation_webhook_configs", "buyer webhook config table"],
  [migration, "create table if not exists public.customer_automation_webhook_tests", "webhook test audit table"],
  [migration, "live_enabled boolean not null default false", "safe live default"],
  [migration, "enable row level security", "webhook RLS"],
  [migration, "revoke all on public.customer_automation_webhook_configs from anon, authenticated", "browser table access revoked"],
  [usageMigration, "reserve_buyer_webhook_runtime_dispatch", "atomic live reservation"],
  [usageMigration, "This product is not configured for buyer webhook requests", "database opt-in gate"],
  [configFunction, '.eq("buyer_id", buyerId)', "buyer ownership filter"],
  [configFunction, "inbound_secret_hash: await sha256(secret)", "hashed inbound secret"],
  [configFunction, "assertSafeOutboundUrl", "outbound SSRF validation"],
  [configFunction, 'redirect: "manual"', "redirect refusal"],
  [configFunction, 'action === "confirm"', "explicit confirmation action"],
  [configFunction, 'action === "activate"', "explicit live activation action"],
  [configFunction, 'toLowerCase() === "buyer_webhook"', "exact opt-in product gate"],
  [ingressFunction, "timingSafeEqual", "constant-time secret comparison"],
  [ingressFunction, "MAX_BODY_BYTES", "payload size limit"],
  [ingressFunction, "safePreview", "redacted payload preview"],
  [ingressFunction, "live_runtime_enabled: false", "ingress test-mode response"],
  [ingressFunction, "reserve_buyer_webhook_runtime_dispatch", "live ingress reservation"],
  [cors, "x-nexus-webhook-secret", "browser webhook test CORS header"],
  [supabaseConfig, "[functions.buyer-webhook-config]", "webhook config function declaration"],
  [supabaseConfig, "[functions.buyer-webhook-ingress]", "webhook ingress function declaration"],
  [supabaseConfig, "[functions.create-usage-topup-checkout]", "usage top-up function declaration"],
  [buyerPage, '<meta name="robots" content="noindex,nofollow">', "private page indexing guard"],
  [buyerPage, "NexusDB.requireBuyer", "buyer authentication"],
  [buyerPage, "Confirm received request", "inbound confirmation control"],
  [buyerPage, "Save and test destination", "outbound test control"],
  [buyerPage, "Connection tests do not consume the monthly allowance", "test-mode buyer disclosure"],
  [checkoutSuccess, 'runtimeTriggerMode === "buyer_webhook"', "checkout webhook route gate"],
  [checkoutSuccess, "/pages/buyer/webhook-setup.html?id=", "checkout webhook destination"],
  [buyerDashboard, "return getBuyerWebhookSetupUrl(item)", "primary dashboard webhook route"],
  [buyerDashboard, 'return "Connect webhook"', "dashboard webhook action label"],
  [buyerSetup, '!belongsToBundle && runtimeTriggerMode === "buyer_webhook"', "generic setup webhook guard"],
  [buyerSetup, "location.replace(`/pages/buyer/webhook-setup.html?id=", "stale setup link redirect"],
  [nexusDb, "runtime_trigger_mode,", "buyer query webhook mode"],
  [nexusDb, "runtime_event_schema", "buyer query event schema"],
  [buyerPage, "Activate live requests", "explicit activation control"],
  [buyerPage, "Request usage", "buyer usage display"],
  [buyerDashboard, "buyerWebhookSetupAvailable", "scoped dashboard visibility"],
  [buyerDashboard, 'return triggerMode === "buyer_webhook"', "exact dashboard opt-in gate"],
  [buyerDashboard, "Webhook setup", "dashboard webhook action"],
  [nexusDb, 'callNexusFunction("buyer-webhook-config", payload)', "buyer webhook client wrapper"],
  [nexusDb, 'callNexusFunction("create-usage-topup-checkout", payload)', "usage top-up client wrapper"],
]) {
  assert.ok(source.includes(marker), `Missing ${label}.`);
}

assert.doesNotMatch(migration, /inbound_secret\s+text/i, "Raw inbound secrets must not be stored.");
assert.match(ingressFunction, /if \(config\.live_enabled === true\)/, "Live dispatch must have an explicit config gate.");
assert.match(usageMigration, /dispatch_origin[\s\S]*buyer_webhook/, "Live dispatch must enter the durable backlog.");
assert.doesNotMatch(ingressFunction, /run-scheduled-automations|triggerWebhook\(/i, "Ingress must not bypass the durable dispatch backlog.");
assert.match(configFunction, /url\.protocol !== "https:"/, "Outbound destinations must require HTTPS.");
const checkoutBundleRoute = checkoutSuccess.indexOf("if (bundleId && orderId)");
const checkoutWebhookRoute = checkoutSuccess.indexOf('if (runtimeTriggerMode === "buyer_webhook")');
const checkoutGuidedRoute = checkoutSuccess.indexOf("if (isGuidedInstall)");
assert.ok(
  checkoutBundleRoute >= 0 && checkoutBundleRoute < checkoutWebhookRoute && checkoutWebhookRoute < checkoutGuidedRoute,
  "Checkout must preserve bundle routing, then route standalone webhook products before generic or guided setup."
);
const setupWebhookGuard = buyerSetup.indexOf('if (!belongsToBundle && runtimeTriggerMode === "buyer_webhook")');
const setupRender = buyerSetup.indexOf("renderSetupForm(root);", setupWebhookGuard);
assert.ok(
  setupWebhookGuard >= 0 && setupWebhookGuard < setupRender,
  "The generic setup page must redirect standalone webhook products before rendering fields."
);
assert.match(configFunction, /privateIpv4|privateIpv6/, "Outbound destinations must reject private IP ranges.");
assert.match(configFunction, /\["test_received", "confirmed"\]|\['test_received', 'confirmed'\]/, "Inbound confirmation must require a successful test.");
assert.match(configFunction, /\["test_succeeded", "confirmed"\]|\['test_succeeded', 'confirmed'\]/, "Outbound confirmation must require a successful test.");

for (const [page, filename] of [
  [buyerPage, "buyer-webhook-setup-inline.js"],
  [buyerDashboard, "buyer-dashboard-inline.js"],
  [buyerSetup, "buyer-setup-inline.js"],
  [checkoutSuccess, "checkout-success-inline.js"],
]) {
  const inlineScripts = [...page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((script) => script.trim());
  assert.ok(inlineScripts.length, `${filename} must include an inline controller script.`);
  for (const script of inlineScripts) new vm.Script(script, { filename });
}

console.log(JSON.stringify({
  schema: true,
  buyerOwnership: true,
  hashedSecret: true,
  safeTestMode: true,
  liveRuntimeOptIn: true,
  meteredDispatch: true,
  outboundSsrfGuard: true,
  explicitConfirmation: true,
  dashboardEntryPoint: true,
  pageSyntax: true,
}));
