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

for (const [source, filename] of [[admin, "admin-product-form-inline.js"], [developer, "developer-dashboard-inline.js"], [buyer, "buyer-webhook-setup-inline.js"]]) {
  const scripts = [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map((match) => match[1]).filter((script) => script.trim());
  for (const script of scripts) new vm.Script(script, { filename });
}

console.log(JSON.stringify({
  inferredRuntimeMode: true,
  contextualProductFields: true,
  webhookOnlyUsagePanel: true,
  editableBuyerTester: true,
  guidedMapping: true,
  explicitActivation: true,
  pageSyntax: true
}));
