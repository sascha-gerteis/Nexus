const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const migration = read("supabase/migrations/20260812000100_buyer_webhook_setup.sql");
const usageMigration = read("supabase/migrations/20260812000300_buyer_webhook_usage_metering.sql");
const testWindowMigration = read("supabase/migrations/20260816000100_webhook_connection_test_windows.sql");
const pendingStatusMigration = read("supabase/migrations/20260816000200_webhook_test_pending_status.sql");
const configFailedStatusMigration = read("supabase/migrations/20260816000300_webhook_config_failed_status.sql");
const configFunction = read("supabase/functions/buyer-webhook-config/index.ts");
const ingressFunction = read("supabase/functions/buyer-webhook-ingress/index.ts");
const dispatchFunction = read("supabase/functions/process-runtime-dispatch-backlog/index.ts");
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
  [testWindowMigration, "inbound_test_started_at", "server-recorded inbound test window"],
  [pendingStatusMigration, "'pending', 'succeeded', 'failed'", "pending request-history status"],
  [configFailedStatusMigration, "'test_failed'", "config timeout status constraint"],
  [usageMigration, "This product is not configured for buyer webhook requests", "database opt-in gate"],
  [configFunction, '.eq("buyer_id", buyerId)', "buyer ownership filter"],
  [configFunction, "inbound_secret_hash: await sha256(secret)", "hashed inbound secret"],
  [configFunction, "assertSafeOutboundUrl", "outbound SSRF validation"],
  [configFunction, 'redirect: "manual"', "redirect refusal"],
  [configFunction, 'action === "begin_inbound_test"', "explicit inbound test start action"],
  [configFunction, "requestedTestEventId", "server-bound connection-test event ID"],
  [configFunction, 'status: "pending"', "Start-created pending request-history row"],
  [configFunction, 'eq("status", "pending")', "superseded pending test cleanup"],
  [configFunction, "INBOUND_TEST_TIMEOUT_MS = 2 * 60 * 1000", "bounded two-minute test window"],
  [configFunction, "expireTimedOutInboundTest", "server-side pending test expiry"],
  [configFunction, "reconcileReceivedInboundTest", "receipt/history race reconciliation"],
  [configFunction, 'eq("inbound_status", "awaiting_test")', "race-safe timeout update"],
  [configFunction, 'action === "confirm"', "explicit confirmation action"],
  [configFunction, "requestReceivedAt < testStartedAt", "fresh inbound receipt guard"],
  [configFunction, 'action === "activate"', "explicit live activation action"],
  [configFunction, 'toLowerCase() === "buyer_webhook"', "exact opt-in product gate"],
  [ingressFunction, "timingSafeEqual", "constant-time secret comparison"],
  [ingressFunction, "MAX_BODY_BYTES", "payload size limit"],
  [ingressFunction, "safePreview", "redacted payload preview"],
  [ingressFunction, "WEBHOOK_EVENT_ID_ALREADY_USED", "clear stale duplicate event error"],

  [ingressFunction, "recordConnectionTestFailure", "visible connection-test authentication failure"],
  [ingressFunction, "live_runtime_enabled: false", "ingress test-mode response"],
  [ingressFunction, "reserve_buyer_webhook_runtime_dispatch", "live ingress reservation"],
  [ingressFunction, "wakeRuntimeDispatchBacklog", "immediate live dispatcher wake-up"],
  [ingressFunction, "EdgeRuntime.waitUntil(task)", "supported Supabase background dispatch"],
  [configFunction, "wakeDueRuntimeDispatches", "buyer-page queued dispatch recovery"],
  [configFunction, 'setup_status: "completed"', "webhook setup state synchronization"],
  [buyerDashboard, '"Webhook retrying"', "accurate queued webhook card state"],
  [ingressFunction, 'inbound_status: "confirmed"', "test request auto-confirmation"],
  [dispatchFunction, 'req.headers.get("x-nexus-runtime-secret")', "internal dispatcher authentication"],
  [dispatchFunction, '"authorize_runtime_dispatch_worker"', "external worker authentication preserved"],
  [cors, "x-nexus-webhook-secret", "browser webhook test CORS header"],
  [supabaseConfig, "[functions.buyer-webhook-config]", "webhook config function declaration"],
  [supabaseConfig, "[functions.buyer-webhook-ingress]", "webhook ingress function declaration"],
  [supabaseConfig, "[functions.create-usage-topup-checkout]", "usage top-up function declaration"],
  [buyerPage, '<meta name="robots" content="noindex,nofollow">', "private page indexing guard"],
  [buyerPage, "NexusDB.requireBuyer", "buyer authentication"],
  [buyerPage, "Start connection test", "explicit external connection-test start"],
  [buyerPage, "Nexus will not generate the request for you", "no browser-generated connection sample disclosure"],
  [buyerPage, "hasFreshInboundTestReceipt", "fresh receipt polling guard"],
  [buyerPage, "createConnectionTestEventId", "fresh generated connection-test event ID"],
  [buyerPage, 'action: "begin_inbound_test", event_id: eventId', "browser/server connection-test identity binding"],
  [buyerPage, "connectionTestFailureMessage", "visible rejected-request diagnosis"],
  [buyerPage, "Try connection test again", "post-timeout test recovery"],
  [buyerPage, 'data-nexus-action="start-inbound-test"', "dedicated Start-button action"],
  [buyerPage, "showImmediateInboundStatus", "immediate click feedback independent of the API"],
  [buyerPage, 'test.status === "pending" ? "waiting for request"', "pending request-history label"],
  [buyerPage, "Waiting for request...", "persistent active-test button state"],
  [buyerPage, "stop waiting after two minutes", "buyer-visible timeout disclosure"],
  [buyerPage, "confirmed the connection automatically", "automatic inbound confirmation feedback"],
  [buyerPage, "Save and test destination", "outbound test control"],
  [buyerPage, "Connection tests do not consume the monthly allowance", "test-mode buyer disclosure"],
  [checkoutSuccess, 'runtimeTriggerMode === "buyer_webhook"', "checkout webhook route gate"],
  [checkoutSuccess, "/pages/buyer/webhook-setup.html?id=", "checkout webhook destination"],
  [buyerDashboard, "return getBuyerWebhookSetupUrl(item)", "primary dashboard webhook route"],
  [buyerDashboard, '? "Manage webhook" : "Connect webhook"', "dashboard connected/manage action label"],
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
assert.doesNotMatch(buyerPage, /Run connection test|Send browser test/, "Pre-live setup must not offer a Nexus-generated self-test.");
assert.doesNotMatch(buyerPage, /Confirm received request/, "Inbound test receipt must auto-confirm without a redundant buyer click.");
assert.doesNotMatch(buyerPage, /x-nexus-event-id: your-unique-event-id/, "Connection-test instructions must never reuse a static event ID.");
assert.match(ingressFunction, /existingReceivedAt >= testStartedAt/, "Only a duplicate from the active connection-test window may be restored.");
assert.doesNotMatch(ingressFunction, /WEBHOOK_CONNECTION_TEST_EVENT_ID_MISMATCH/, "Fresh authenticated app-generated event IDs must remain valid during connection tests.");
assert.match(configFunction, /inbound_last_event_id: requestedTestEventId/, "Connection-test start must store the exact ID shown to the buyer.");
assert.match(buyerPage, /begin_inbound_test".*, event_id: eventId/, "The page must register its generated event ID before waiting.");
assert.match(buyerPage, /connection_test_error/, "The page must display ingress authentication failures instead of waiting silently.");
assert.match(buyerPage, /rotateWebhookSecret[\s\S]*?waitingForInboundTest = false[\s\S]*?stopInboundTestPolling/, "Replacing a secret must clear any stale connection-test wait.");
assert.match(buyerPage, /if \(!liveRequest\) \{[\s\S]*?return;/, "Browser-generated requests must be blocked until the connection is already live.");
assert.match(configFunction, /inbound_test_started_at[\s\S]*requestReceivedAt < testStartedAt/, "Inbound confirmation must require a receipt newer than the server-recorded test start.");

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

const buyerControllerScript = [...buyerPage.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .find((script) => script.includes("async function startInboundConnectionTest"));
assert.ok(buyerControllerScript, "Buyer webhook controller script must exist.");
let capturedStartPayload = null;
const runtimeRoot = { innerHTML: "" };
const runtimeContext = {
  URLSearchParams,
  location: { search: "?id=runtime-button-check" },
  document: {
    getElementById: () => runtimeRoot,
    addEventListener: () => {},
  },
  window: {},
  NexusDB: {
    manageBuyerWebhook: async (payload) => {
      capturedStartPayload = payload;
      return { data: {
        customer_automation: { id: "runtime-button-check", status: "active" },
        automation: { title: "Webhook regression product" },
        order: { order_status: "paid" },
        config: {
          inbound_status: "awaiting_test",
          inbound_test_started_at: new Date().toISOString(),
          inbound_last_received_at: null,
          inbound_last_event_id: payload.event_id,
          inbound_last_payload_preview: {},
          inbound_secret_hint: "123456",
          inbound_url: "https://example.invalid/webhook",
          outbound_status: "not_configured",
          event_mapping_status: "not_configured",
          live_enabled: false,
        },
        tests: [],
        setup_fields: [],
        saved_setup_keys: [],
        event_source_paths: [],
        usage: {},
      } };
    },
  },
  crypto: { randomUUID: () => "runtime-click-id" },
  setTimeout: () => 1,
  clearTimeout: () => {},
  console, Intl, Date, Math, Number, String, Array, Object, JSON, RegExp, Boolean,
};
vm.createContext(runtimeContext);
new vm.Script(buyerControllerScript, { filename: "buyer-webhook-button-runtime.js" }).runInContext(runtimeContext);
const startButtonRuntimeCheck = runtimeContext.startInboundConnectionTest().then(async () => {
  assert.equal(capturedStartPayload?.action, "begin_inbound_test", "Start button must call the begin test action.");
  assert.match(capturedStartPayload?.event_id || "", /^nexus-connect-/, "Start button must send a fresh event ID.");
  assert.match(runtimeRoot.innerHTML, /Waiting for your request/, "Start button must visibly enter the waiting state.");
  runtimeContext.NexusDB.manageBuyerWebhook = async () => ({ error: { message: "Forced begin failure" } });
  await runtimeContext.startInboundConnectionTest();
  assert.match(runtimeRoot.innerHTML, /Forced begin failure/, "A rejected begin-test request must remain visible beside the Start button.");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

console.log(JSON.stringify({
  schema: true,
  buyerOwnership: true,
  hashedSecret: true,
  safeTestMode: true,
  freshExternalRequestRequired: true,
  freshEventIdGenerated: true,
  staleDuplicateRejected: true,
  testCorrelationIdentity: true,
  authenticationFailureVisible: true,
  staleWaitRecoverable: true,
  startButtonImmediateFeedback: true,
  startButtonApiFailureVisible: true,
  pendingHistoryVisible: true,
  boundedWaitingState: true,
  liveRuntimeOptIn: true,
  meteredDispatch: true,
  outboundSsrfGuard: true,
  explicitConfirmation: true,
  dashboardEntryPoint: true,
  pageSyntax: true,
}));
