const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const read = (file) => fs.readFileSync(file, "utf8");
const admin = read("pages/admin/product-form.html");
const developer = read("pages/developer/dashboard.html");
const buyer = read("pages/buyer/webhook-setup.html");
const css = read("assets/css/nexus.css");

for (const [source, name] of [[admin, "admin"], [developer, "developer"]]) {
  assert.doesNotMatch(source, /<label>Automation mode<\/label>/, `${name} must not show the redundant automation mode selector.`);
  assert.match(source, /<input type="hidden" name="runtime_type"/, `${name} must preserve runtime_type as an inferred backend field.`);
  assert.match(source, /name="runtime_trigger_mode"/, `${name} must preserve runtime trigger selection.`);
  assert.match(source, /value="buyer_webhook"/, `${name} must preserve exact buyer_webhook opt-in.`);
  assert.match(source, /runtime-webhook-settings hidden/, `${name} must hide webhook usage settings outside webhook mode.`);
  assert.match(source, /runtime_run_frequency/, `${name} must preserve schedule cadence data.`);
  assert.match(source, /runtime_no_change_policy/, `${name} must preserve recurring no-change behavior.`);
  assert.match(source, /runtime_response_mode/, `${name} must preserve buyer response behavior.`);
}

assert.match(admin, /updateRuntimeConfigurationUI\(options = \{\}\)/, "Admin contextual runtime synchronizer is required.");
assert.match(developer, /updateDeveloperRuntimeConfigurationUI\(options = \{\}\)/, "Developer contextual runtime synchronizer is required.");
assert.match(css, /\.runtime-webhook-settings/, "Shared contextual webhook settings styling is required.");
assert.match(buyer, /id="webhookTestPayload"/, "Buyer needs an editable webhook JSON tester.");
assert.match(buyer, /async function finishEventMapping\(\)/, "Buyer needs one mapping validation action.");
assert.match(buyer, /action: "confirm", direction: "inbound"/, "Successful browser tests must confirm the inbound connection.");
assert.match(buyer, /Activate live requests/, "Live activation must remain explicit.");
assert.match(buyer, /Tests do not consume the monthly allowance/, "Test-mode usage disclosure is required.");
assert.match(buyer, /x-nexus-event-id: UNIQUE_EVENT_ID/, "Required idempotency header guidance is required.");
const activeBuyerFlow = buyer.slice(
  buyer.indexOf("function renderEventMapping(readOnly)"),
  buyer.indexOf("function showNotice(")
);
assert.match(buyer, /function suggestedSourceFor\(/, "Buyer mapping should suggest exact request-field matches.");
assert.match(buyer, /requestValues\[name\] = value/, "Buyer test JSON should be generated from actual workflow inputs.");
assert.match(activeBuyerFlow, /if \(!canValidate\)/, "Step 2 must stay collapsed until the connection test is confirmed.");
assert.match(activeBuyerFlow, /Finish the connection test first/, "Locked Step 2 needs one clear next action.");
assert.match(activeBuyerFlow, /Confirm field matches/, "Step 2 needs one clear confirmation action.");
assert.match(activeBuyerFlow, /Existing secret saved \(ending in/, "Stored secrets must be described honestly.");
assert.match(activeBuyerFlow, /webhookState\.newSecret \? `<button[^`]+toggleWebhookSecret/, "Show/hide must be available only for a newly issued visible secret.");
assert.match(activeBuyerFlow, /Stored securely/, "Existing hashed secrets need a non-interactive secure state.");
assert.doesNotMatch(activeBuyerFlow, /Secret hidden \?|Workflow input \?|Optional \?/, "Buyer UI must not contain corrupted separator symbols.");
assert.ok(
  activeBuyerFlow.indexOf("if (!canValidate)") < activeBuyerFlow.indexOf("webhook-mapping-list"),
  "Technical field controls must not render before Step 1 is complete."
);

for (const [source, filename] of [[admin, "admin-product-form-inline.js"], [developer, "developer-dashboard-inline.js"], [buyer, "buyer-webhook-setup-inline.js"]]) {
  const scripts = [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((match) => match[1]).filter((script) => script.trim());
  for (const script of scripts) new vm.Script(script, { filename });
}

const buyerController = [...buyer.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map((match) => match[1])
  .filter((script) => script.trim())
  .at(-1);
const buyerSandbox = {
  URLSearchParams,
  console,
  document: {
    addEventListener() {},
    getElementById() { return null; },
    querySelectorAll() { return []; }
  },
  history: { replaceState() {} },
  location: { search: "?id=test-customer-automation", pathname: "/pages/buyer/webhook-setup.html", hash: "" },
  navigator: { clipboard: { writeText: async () => {} } },
  window: {},
  NexusDB: {},
  NexusUI: { toast() {} },
  confirm: () => true,
  fetch: async () => ({ ok: true, json: async () => ({ ok: true }) })
};
vm.runInNewContext(`${buyerController}\n;globalThis.__webhookUi = { webhookState, defaultWebhookTestPayload, renderEventMapping, renderConnectionCard };`, buyerSandbox);
const webhookUi = buyerSandbox.__webhookUi;
webhookUi.webhookState.setupFields = [
  { name: "business_name", label: "Business Name", type: "text", required: true },
  { name: "event_message", label: "Event Message", type: "text", required: true },
  { name: "external_customer_id", label: "External Customer Id", type: "text", required: true }
];
webhookUi.webhookState.savedSetupKeys = [];
webhookUi.webhookState.eventSourcePaths = [];
webhookUi.webhookState.config = {
  inbound_status: "awaiting_test",
  inbound_last_event_id: "",
  event_mapping: [],
  event_mapping_status: "not_configured",
  inbound_secret_hint: "c3c9b4"
};
const generatedPayload = JSON.parse(webhookUi.defaultWebhookTestPayload());
assert.equal(generatedPayload.business_name, "Example Business", "Generated test payload should include the product's business input.");
assert.equal(generatedPayload.event_message, "Test request from the Nexus webhook setup page", "Generated test payload should include the product's message input.");
assert.equal(generatedPayload.external_customer_id, "customer-001", "Generated test payload should include the product's customer id input.");
const lockedMapping = webhookUi.renderEventMapping(false);
assert.match(lockedMapping, /Finish the connection test first/, "Locked Step 2 should show only the next action.");
assert.doesNotMatch(lockedMapping, /webhook-mapping-select/, "Locked Step 2 must hide technical mapping controls.");
const storedSecretCard = webhookUi.renderConnectionCard(false);
assert.match(storedSecretCard, /Existing secret saved \(ending in c3c9b4\)/, "Stored secret suffix should be clear.");
assert.doesNotMatch(storedSecretCard, /toggleWebhookSecret/, "A hashed stored secret must not show a reveal control.");
webhookUi.webhookState.config.inbound_status = "confirmed";
webhookUi.webhookState.config.inbound_last_event_id = "buyer-test-1";
webhookUi.webhookState.config.event_mapping_status = "awaiting_validation";
webhookUi.webhookState.eventSourcePaths = Object.entries(generatedPayload).map(([path, sample]) => ({ path, sample }));
const readyMapping = webhookUi.renderEventMapping(false);
assert.match(readyMapping, /value="business_name" selected/, "Exact business field should be suggested automatically.");
assert.match(readyMapping, /value="event_message" selected/, "Exact message field should be suggested automatically.");
assert.match(readyMapping, /Confirm field matches/, "Ready Step 2 should have one confirmation action.");

console.log(JSON.stringify({
  inferredRuntimeMode: true,
  contextualProductFields: true,
  webhookOnlyUsagePanel: true,
  editableBuyerTester: true,
  guidedMapping: true,
  explicitActivation: true,
  pageSyntax: true
}));
