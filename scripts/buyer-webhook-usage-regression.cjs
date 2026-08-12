const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const migration = read("supabase/migrations/20260812000300_buyer_webhook_usage_metering.sql");
const ingress = read("supabase/functions/buyer-webhook-ingress/index.ts");
const config = read("supabase/functions/buyer-webhook-config/index.ts");
const topup = read("supabase/functions/create-usage-topup-checkout/index.ts");
const stripe = read("supabase/functions/stripe-webhook/index.ts");
const setup = read("supabase/functions/submit-automation-setup/index.ts");
const ensure = read("supabase/functions/ensure-customer-automations/index.ts");
const backlog = read("supabase/functions/process-runtime-dispatch-backlog/index.ts");
const output = read("supabase/functions/runtime-submit-output/index.ts");
const developerProducts = read("supabase/functions/developer-products/index.ts");
const developerPage = read("pages/developer/dashboard.html");
const adminPage = read("pages/admin/product-form.html");
const buyerPage = read("pages/buyer/webhook-setup.html");
const buyerDashboard = read("pages/buyer/dashboard.html");
const nexusDb = read("assets/js/nexus-db.js");
const scheduler = read("supabase/functions/run-scheduled-automations/index.ts");

for (const [source, marker, label] of [
  [migration, "webhook_included_runs integer not null default 0", "zero-default included units"],
  [migration, "webhook_topup_runs integer not null default 0", "zero-default top-up units"],
  [migration, "customer_automation_usage_entitlements", "period entitlement table"],
  [migration, "customer_automation_usage_ledger", "immutable usage ledger"],
  [migration, "automation_usage_topups", "top-up purchase table"],
  [migration, "reserve_buyer_webhook_runtime_dispatch", "atomic dispatch reservation"],
  [migration, "customer_automation_usage_event_unique", "event idempotency key"],
  [migration, "'legacy', 'setup_complete', 'on_demand', 'buyer_webhook'", "additive runtime mode constraint"],
  [migration, "status', 'quota_exhausted'", "hard quota result"],
  [migration, "attempt_kind in ('setup_bundle', 'runtime_event')", "bundle runtime isolation"],
  [migration, "renew_order_usage_entitlements", "billing-period renewal"],
  [ingress, 'runtime_trigger_mode).toLowerCase() !== "buyer_webhook"', "ingress exact mode gate"],
  [ingress, "reserve_buyer_webhook_runtime_dispatch", "ingress atomic reservation call"],
  [ingress, 'status: reservation?.ok ? "succeeded" : "failed"', "retry-safe ingress history"],
  [ingress, '"Retry-After"', "quota retry header"],
  [config, 'action === "activate"', "explicit activation"],
  [config, 'action === "deactivate"', "explicit pause"],
  [config, "webhook_included_runs", "allowance readiness check"],
  [topup, 'checkout_kind: "usage_topup"', "separate Stripe checkout identity"],
  [topup, 'mode: "payment"', "one-time run pack payment"],
  [topup, "fulfill_customer_automation_usage_topup", "buyer return fulfillment"],
  [stripe, "isUsageTopupSession", "Stripe event branch isolation"],
  [stripe, "handleUsageTopupCompleted", "Stripe top-up fulfillment"],
  [stripe, "renewBuyerWebhookUsageEntitlements", "Stripe renewal integration"],
  [stripe, 'if (mode === "buyer_webhook") return "manual"', "scheduler exclusion on fulfillment"],
  [stripe, 'runtimeTriggerMode !== "buyer_webhook"', "schedule activation exclusion"],
  [setup, 'runtimeTriggerMode(automation, order) === "buyer_webhook"', "setup submission does not dispatch"],
  [ensure, 'if (raw === "buyer_webhook") return "buyer_webhook"', "provisioning preserves exact mode"],
  [backlog, "...asObject(queue.setup_overrides)", "event setup override merge"],
  [backlog, "asObject(queue.request_payload)", "raw event request dispatch"],
  [output, 'productMode !== "buyer_webhook" || runTrigger !== "buyer_webhook"', "outbound exact product and run gate"],
  [output, "safeLiveOutboundUrl", "live outbound SSRF check"],
  [output, 'redirect: "error"', "live outbound redirect refusal"],
  [developerProducts, 'triggerMode === "buyer_webhook"', "developer backend opt-in handling"],
  [developerPage, 'value="buyer_webhook"', "developer product option"],
  [adminPage, 'value="buyer_webhook"', "admin product option"],
  [buyerPage, "Webhook request usage", "buyer usage UI"],
  [buyerPage, "purchaseUsageTopup", "buyer run-pack action"],
  [buyerDashboard, 'return triggerMode === "buyer_webhook"', "dashboard exact opt-in gate"],
  [buyerDashboard, 'attempt.attempt_kind || "setup_bundle"', "bundle setup attempt filter"],
  [nexusDb, "createUsageTopupCheckout", "browser top-up client"],
  [nexusDb, "attempt_kind", "bundle attempt kind selection"],
  [scheduler, '.not("run_frequency", "in", "(manual,on_demand)")', "manual product scheduler exclusion"],
]) {
  assert.ok(source.includes(marker), `Missing ${label}.`);
}

// These are the production compatibility boundaries: existing modes are never
// inferred into buyer_webhook and their saved usage fields are forced to zero.
assert.doesNotMatch(migration, /runtime_trigger_mode[^\n]*on_demand[^\n]*buyer_webhook/i, "on_demand must never be eligible for metered webhook usage.");
assert.match(developerProducts, /triggerMode === "buyer_webhook"[\s\S]{0,500}: 0/, "Non-webhook developer products must persist zero usage values.");
assert.match(adminPage, /runtime_trigger_mode[\s\S]{0,300}=== "buyer_webhook"[\s\S]{0,150}: 0/, "Non-webhook admin products must persist zero usage values.");
assert.match(migration, /product\.pricing_type[\s\S]{0,120}<> 'monthly'/, "Entitlements must require monthly product pricing.");
assert.match(migration, /linked_order\.stripe_mode[\s\S]{0,180}stripe_subscription_id/, "Entitlements must require an actual subscription purchase.");
assert.match(migration, /on conflict \(customer_automation_id, event_key\) do nothing/, "Top-up fulfillment must be idempotent.");
assert.match(stripe, /stripe_events"\)\.delete\(\)\.eq\("id", event\.id\)/, "Failed Stripe events must remain retryable.");

for (const [html, filename] of [
  [buyerPage, "buyer-webhook-setup-inline.js"],
  [adminPage, "admin-product-form-inline.js"],
  [developerPage, "developer-dashboard-inline.js"],
]) {
  const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((script) => script.trim());
  assert.ok(inlineScripts.length, `${filename} inline script was not found.`);
  for (const script of inlineScripts) new vm.Script(script, { filename });
}

console.log(JSON.stringify({
  exactOptInOnly: true,
  existingModesUnchanged: true,
  atomicQuota: true,
  duplicateSafe: true,
  retrySafe: true,
  bundleIsolated: true,
  setupDoesNotRun: true,
  topupCheckoutIsolated: true,
  allowanceRenewal: true,
  outboundDeliveryGated: true,
  pageSyntax: true,
}));
