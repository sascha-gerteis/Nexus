"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const setupPath = path.join(root, "pages", "buyer", "setup.html");
const cssPath = path.join(root, "assets", "css", "nexus.css");
const html = fs.readFileSync(setupPath, "utf8");
const css = fs.readFileSync(cssPath, "utf8");
const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1])
  .filter(source => source.includes("CREDENTIAL_TUTORIALS"));

assert.equal(inlineScripts.length, 1, "Expected one setup-page application script");
const source = inlineScripts[0];
const context = vm.createContext({
  console: { warn() {}, error() {}, log() {} },
  URLSearchParams,
  location: { search: "", pathname: "/pages/buyer/setup.html" },
  localStorage: { getItem() { return null; }, setItem() {} },
  document: {
    visibilityState: "visible",
    addEventListener() {},
    getElementById() { return null; },
    querySelectorAll() { return []; }
  },
  window: {
    CSS: { escape(value) { return String(value); } },
    addEventListener() {}
  },
  setInterval() { return 1; },
  clearInterval() {},
  setTimeout() { return 1; },
  clearTimeout() {},
  encodeURIComponent,
  Date,
  Map,
  Set,
  Math,
  JSON,
  String,
  Number,
  Boolean,
  Object,
  Array,
  RegExp
});

vm.runInContext(source, context, { filename: setupPath });

function evaluate(expression) {
  return vm.runInContext(expression, context);
}

function tutorialLabel(field) {
  const serialized = JSON.stringify(field);
  return evaluate(`credentialTutorialForField(${serialized})?.label || null`);
}

const tutorialCases = [
  [{ name: "instagram_account_id" }, "Instagram Account ID"],
  [{ name: "facebook_page_id" }, "Facebook Page ID"],
  [{ name: "meta_access_token" }, "Temporary Meta Access Token"],
  [{ name: "system_user_access_token" }, "Permanent Meta System User Token"],
  [{ name: "whatsapp_phone_number_id" }, "WhatsApp Number Setup / Verification"],
  [{ name: "ad_account_id" }, "Meta Ad Account ID"],
  [{ name: "pixel_id" }, "Meta Pixel ID"],
  [{ name: "bundle_x_credential_value", sources: [{ field_name: "facebook_page_id" }] }, "Facebook Page ID"]
];

for (const [field, expected] of tutorialCases) {
  assert.equal(tutorialLabel(field), expected, `Tutorial mismatch for ${JSON.stringify(field)}`);
}

for (const field of [
  { name: "openai_api_key" },
  { name: "business_phone_number" },
  { name: "facebook_page_name" }
]) {
  assert.equal(tutorialLabel(field), null, `Unrelated field received a tutorial: ${field.name}`);
}

assert.equal(evaluate("formatProcessingElapsed(102000)"), "1m 42s");
assert.equal(evaluate("formatProcessingElapsed(3723000)"), "1h 2m 3s");
assert.equal(evaluate('setupSubmissionIsPending({ code: "FUNCTION_TIMEOUT" })'), true);
assert.equal(evaluate('setupSubmissionIsPending({ timed_out: true })'), true);
assert.equal(evaluate('setupSubmissionIsPending({ message: "submit-automation-setup is taking longer than expected. Nexus will keep checking it." })'), true);
assert.equal(evaluate('setupSubmissionIsPending({ code: "FUNCTION_REQUEST_FAILED", message: "Invalid setup" })'), false);

const processingPanel = evaluate("renderSetupProcessingPanel({ isBundle: false, expectedCount: 1 })");
assert.match(processingPanel, /Your report is being generated/);
assert.match(processingPanel, /This usually takes a few minutes\. You can leave this page and return later\./);
assert.match(processingPanel, /The report will appear here automatically when it’s ready\./);
assert.match(processingPanel, /Processing for 0s/);

const tutorialLinks = evaluate('renderCredentialTutorialLinks({ name: "meta_access_token" })');
assert.match(tutorialLinks, /target="_blank"/);
assert.match(tutorialLinks, /rel="noopener noreferrer"/);
assert.match(tutorialLinks, />\s*Docs\s*</);
assert.match(tutorialLinks, />\s*Video\s*</);

const expectedUrls = [
  "https://developers.facebook.com/docs/instagram-platform/",
  "https://www.youtube.com/watch?v=OFm4laUrv3Y",
  "https://www.facebook.com/help/1503421039731588",
  "https://www.youtube.com/watch?v=zCuZXEJFLXc",
  "https://developers.facebook.com/docs/facebook-login/guides/access-tokens/",
  "https://www.youtube.com/watch?v=IWryr_lyBRI",
  "https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens/",
  "https://www.youtube.com/watch?v=NdkPxSf8Whw",
  "https://developers.facebook.com/docs/whatsapp/cloud-api/phone-numbers/",
  "https://www.youtube.com/watch?v=q0ojEbdezFU",
  "https://help.leadsie.com/article/106-find-facebook-meta-ad-account-id",
  "https://www.youtube.com/watch?v=F1Rr30cgISw",
  "https://www.facebook.com/help/952192354843755",
  "https://www.youtube.com/watch?v=QmlPvwi6Us4"
];

for (const url of expectedUrls) {
  assert.ok(source.includes(url), `Missing tutorial URL: ${url}`);
}

const outputMatchResult = evaluate(`(() => {
  const startedAt = Date.parse("2026-07-28T10:00:00.000Z");
  const current = {
    customerAutomationIds: ["automation-1"],
    orderId: "order-1",
    bundleAttemptId: "attempt-1",
    startedAt
  };
  return {
    current: setupOutputMatchesProcessing({
      customer_automation_id: "automation-1",
      order_id: "order-1",
      bundle_run_attempt_id: "attempt-1",
      created_at: "2026-07-28T10:00:05.000Z"
    }, current),
    old: setupOutputMatchesProcessing({
      customer_automation_id: "automation-1",
      order_id: "order-1",
      created_at: "2026-07-28T09:55:00.000Z"
    }, current),
    wrongOrder: setupOutputMatchesProcessing({
      customer_automation_id: "automation-1",
      order_id: "order-2",
      created_at: "2026-07-28T10:00:05.000Z"
    }, current),
    wrongAttempt: setupOutputMatchesProcessing({
      customer_automation_id: "automation-1",
      order_id: "order-1",
      bundle_run_attempt_id: "attempt-2",
      created_at: "2026-07-28T10:00:05.000Z"
    }, current)
  };
})()`);

assert.equal(outputMatchResult.current, true, "Current output should complete processing");
assert.equal(outputMatchResult.old, false, "Old output must not complete a new submission");
assert.equal(outputMatchResult.wrongOrder, false, "Another order must not complete processing");
assert.equal(outputMatchResult.wrongAttempt, false, "Another bundle attempt must not complete processing");

const bundleSubmitStart = source.indexOf("async function submitBundleSetupForm");
const immediateBundleTimer = source.indexOf("const processingContext = currentSetupProcessingContext(", bundleSubmitStart);
const firstBundleDispatch = source.indexOf("for (const [index, entry] of targetEntries.entries())", bundleSubmitStart);
assert.ok(bundleSubmitStart >= 0 && immediateBundleTimer > bundleSubmitStart, "Bundle timer must start inside bundle submission");
assert.ok(immediateBundleTimer < firstBundleDispatch, "Bundle timer must appear before waiting for workflow requests");
assert.ok(source.includes("still confirming ${pendingConfirmations.length}"), "Pending workflow starts must not be reported as failed");
const pendingBranch = source.slice(source.indexOf("if (onlyRuntimeWaits)", bundleSubmitStart), source.indexOf("const failureDetails", bundleSubmitStart));
assert.ok(!pendingBranch.includes("Started ${submittedCount}/${attemptedCount || entries.length}"), "Timeouts must not display the misleading Started 0/N message");

assert.ok(source.includes("listBuyerAutomationOutputsByCustomerAutomationIds"), "Expected buyer-scoped read-only output polling");
assert.ok(!source.includes("checkN8nExecution("), "Processing UI must not mutate n8n execution state");
assert.ok(!/setTimeout\s*\(\s*function\s*\(\)\s*\{\s*location\.href/.test(source), "Post-submit auto-redirect returned");
assert.ok(css.includes(".setup-credential-help-link"), "Missing tutorial button styles");
assert.ok(css.includes(".setup-processing-panel"), "Missing processing panel styles");
assert.ok(css.includes(".setup-report-ready"), "Missing ready panel styles");

console.log("Buyer setup UX regression passed");