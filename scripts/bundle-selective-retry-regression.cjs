"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const setupPath = path.join(root, "pages", "buyer", "setup.html");
const setupHtml = fs.readFileSync(setupPath, "utf8");
const inlineScripts = [...setupHtml.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .filter((source) => source.includes("function bundleEntryNeedsRuntimeSubmit"));
assert.equal(inlineScripts.length, 1, "Expected one buyer setup application script");
const setupSource = inlineScripts[0];

const context = vm.createContext({
  console: { warn() {}, error() {}, log() {} },
  URLSearchParams,
  location: { search: "", pathname: "/pages/buyer/setup.html" },
  localStorage: { getItem() { return null; }, setItem() {} },
  document: {
    visibilityState: "visible",
    addEventListener() {},
    getElementById() { return null; },
    querySelectorAll() { return []; },
  },
  window: {
    CSS: { escape(value) { return String(value); } },
    addEventListener() {},
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
  RegExp,
});
vm.runInContext(setupSource, context, { filename: setupPath });

const selectorResult = vm.runInContext(`(() => {
  const now = new Date().toISOString();
  const attemptId = "attempt-current";
  const makeEntry = (id) => ({ automation: { id, automation_id: "product-" + id } });
  const entries = ["completed", "active", "failed", "waiting", "backlog", "skipped"].map(makeEntry);
  const items = [
    { id: "item-completed", customer_automation_id: "completed", output_id: "output-completed", status: "success", updated_at: now },
    { id: "item-active", customer_automation_id: "active", automation_run_id: "run-active", status: "running", updated_at: now },
    { id: "item-failed", customer_automation_id: "failed", automation_run_id: "run-failed", status: "failed", error_message: "Callback failed", updated_at: now },
    { id: "item-waiting", customer_automation_id: "waiting", automation_run_id: "run-waiting", status: "running", error_message: "n8n finished but Nexus has not received this workflow output yet.", updated_at: now },
    { id: "item-backlog", customer_automation_id: "backlog", automation_run_id: "run-backlog", status: "queued", error_message: "Runtime unavailable; queued for retry", updated_at: now },
    { id: "item-skipped", customer_automation_id: "skipped", status: "skipped", updated_at: now },
  ];

  activeBundleRuntime = {
    outputsByAutomation: new Map([
      ["completed", [{ id: "output-completed", bundle_run_attempt_id: attemptId, bundle_run_item_id: "item-completed", status: "published", created_at: now }]],
    ]),
    runsByAutomation: new Map([
      ["active", [{ id: "run-active", bundle_run_attempt_id: attemptId, bundle_run_item_id: "item-active", status: "running", updated_at: now }]],
      ["failed", [{ id: "run-failed", bundle_run_attempt_id: attemptId, bundle_run_item_id: "item-failed", status: "error", error_message: "Callback failed", finished_at: now, updated_at: now }]],
      ["waiting", [{ id: "run-waiting", bundle_run_attempt_id: attemptId, bundle_run_item_id: "item-waiting", status: "running", response_payload: { status: "waiting_for_output", message: "n8n finished but Nexus has not received this bundle item's output yet." }, updated_at: now }]],
      ["backlog", [{ id: "run-backlog", bundle_run_attempt_id: attemptId, bundle_run_item_id: "item-backlog", status: "queued", error_message: "Runtime unavailable; queued for retry", updated_at: now }]],
    ]),
    attempts: [],
    latestAttempt: { id: attemptId, order_id: "order-1", bundle_id: "bundle-1", status: "partial_failed", bundle_run_items: items },
  };

  return Object.fromEntries(entries.map((entry) => [entry.automation.id, bundleEntryNeedsRuntimeSubmit(entry)]));
})()`, context);

assert.equal(selectorResult.completed, false, "A workflow with an exact published output must never restart");
assert.equal(selectorResult.active, false, "A genuinely active workflow must never restart");
assert.equal(selectorResult.failed, true, "A failed workflow must be selectable for retry");
assert.equal(selectorResult.waiting, true, "A finished n8n run waiting for a missing callback must be retryable");
assert.equal(selectorResult.backlog, false, "A queued runtime backlog item must not be started twice");
assert.equal(selectorResult.skipped, false, "An intentionally skipped workflow must not restart");

const submitStart = setupSource.indexOf("async function submitBundleSetupForm");
const submitEnd = setupSource.indexOf("function renderSingleSetup", submitStart);
const submitBlock = setupSource.slice(submitStart, submitEnd > submitStart ? submitEnd : undefined);
assert.match(submitBlock, /entries\.filter\(entry => bundleEntryNeedsRuntimeSubmit\(entry\)\)/);
assert.match(submitBlock, /for \(const \[index, entry\] of targetEntries\.entries\(\)\)/);
assert.doesNotMatch(submitBlock, /for \(const \[index, entry\] of entries\.entries\(\)\)/);
assert.match(submitBlock, /action: isSelectiveRetry \? "retry_failed_bundle_workflow" : "submit_bundle_setup"/);
assert.match(submitBlock, /const bundleAttemptId = String\(latestAttempt\?\.id \|\| generatedAttemptId\)/);
assert.match(submitBlock, /bundle_expected_count: entries\.length/);
assert.match(setupSource, /Retry \$\{bundleRetryEntries\.length\} failed workflow/);
assert.match(setupSource, /No failed workflows to retry/);
assert.match(setupSource, /Reload to verify workflow status/);
assert.match(setupSource, /hasBundleRuntimeHistory && !activeBundleRuntime\.attemptsLoaded/);

const submitFunction = fs.readFileSync(path.join(root, "supabase", "functions", "submit-automation-setup", "index.ts"), "utf8");
assert.match(submitFunction, /action === "retry_failed_bundle_workflow"/);
assert.match(submitFunction, /authorizeFailedBundleWorkflowRetry/);
assert.match(submitFunction, /authorizeBundleSetupAttemptStart/);
assert.match(submitFunction, /This bundle purchase already has a tracked run\. Reload the setup page so Nexus can retry only failed workflows/);
assert.match(submitFunction, /\.from\("bundle_run_attempts"\)/);
assert.match(submitFunction, /\.from\("bundle_run_items"\)/);
assert.match(submitFunction, /\.from\("automation_outputs"\)[\s\S]*?\.eq\("status", "published"\)/);
assert.match(submitFunction, /This workflow already has a completed output and was not restarted\./);
assert.match(submitFunction, /This workflow is still running\. Nexus did not restart it\./);
assert.match(submitFunction, /responseStatus === "waiting_for_output"/);
assert.match(submitFunction, /trigger_source: runtimeTriggerSource/);
assert.match(submitFunction, /"buyer_bundle_retry"/);
assert.match(submitFunction, /retryFailedBundleWorkflow \? cleanString\(bundleRetryAuthorization\?\.retryRunId\) : ""/);

const runtimeCallback = fs.readFileSync(path.join(root, "supabase", "functions", "runtime-submit-output", "index.ts"), "utf8");
assert.match(runtimeCallback, /Bundle output callback is missing Nexus run identity/);
assert.match(runtimeCallback, /Nexus will not guess bundle ownership from customer_automation_id alone/);

const sharedOutput = fs.readFileSync(path.join(root, "supabase", "functions", "_shared", "nexus-output-selection.ts"), "utf8");
assert.match(sharedOutput, /nexusRuntimeValueExpression/);
assert.match(sharedOutput, /Nexus Webhook Trigger/);
for (const field of ["customer_automation_id", "run_id", "run_key", "order_id", "bundle_run_attempt_id", "bundle_run_item_id"]) {
  assert.ok(sharedOutput.includes(`nexusRuntimeValueExpression("${field}")`), `Missing shared runtime identity field: ${field}`);
}

const nodePath = path.join(root, "workflow-templates", "nexus-submit-output-bundle-safe.node.json");
const nodeTemplate = JSON.parse(fs.readFileSync(nodePath, "utf8"));
const submitNode = nodeTemplate.nodes.find((node) => node.name === "Nexus Submit Output");
assert.ok(submitNode, "Pasteable Nexus Submit Output node is missing");
const bodyByName = new Map(submitNode.parameters.bodyParameters.parameters.map((parameter) => [parameter.name, parameter.value]));
const expectedWebhookIdentity = {
  customer_automation_id: "customer-1",
  run_id: "run-1",
  run_key: "setup:customer-1:submission-1",
  order_id: "order-1",
  bundle_run_attempt_id: "attempt-1",
  bundle_run_item_id: "item-1",
};
const fakeN8nNode = (name) => ({
  first() {
    if (name === "Nexus Runtime Context") return { json: { system: {}, body: {} } };
    if (name === "Nexus Webhook Trigger") return { json: { body: { system: expectedWebhookIdentity } } };
    throw new Error(`Unknown n8n node: ${name}`);
  },
});
for (const field of ["customer_automation_id", "run_id", "run_key", "order_id", "bundle_run_attempt_id", "bundle_run_item_id"]) {
  const expression = bodyByName.get(field) || "";
  assert.match(expression, /Nexus Runtime Context/, `${field} must read Nexus Runtime Context`);
  assert.match(expression, /Nexus Webhook Trigger/, `${field} must fall back to the original Nexus webhook`);
  const javascript = expression.replace(/^=\{\{\s*/, "").replace(/\s*\}\}$/, "");
  const evaluated = Function("$", `return (${javascript});`)(fakeN8nNode);
  assert.equal(evaluated, expectedWebhookIdentity[field], `${field} webhook fallback returned the wrong identity`);
}

console.log("Bundle selective retry regression passed");