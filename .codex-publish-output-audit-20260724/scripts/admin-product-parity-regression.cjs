const fs = require("node:fs");
const assert = require("node:assert/strict");

const html = fs.readFileSync("pages/admin/product-form.html", "utf8");
const app = fs.readFileSync("assets/js/nexus-app.js", "utf8");

const requiredHtml = [
  'id="adminSaveDraftButton"',
  'id="adminPublishProductButton"',
  'id="adminReadinessPanel"',
  'id="adminCredentialPanel"',
  'id="adminTechnicalTestDataPanel"',
  'id="adminPythonEditorModal"',
  'value="n8n"',
  'value="make"',
  'value="zapier"',
  'value="python"',
  'name="setup_schema"',
  'name="runtime_event_schema"',
  'name="credential_schema"',
  'name="workflow_placeholder_mappings"',
  'name="guided_install_enabled"',
  'name="preview_code"',
  'bindUnifiedFormSubmission(form)',
  'async publishProduct()',
  'async scanProductCredentials(options = {})',
  'async applyProductCredentials()',
  'async loadAdminTestProfile(',
  'async saveAdminTestProfile(',
  'async runAdminRealTest(',
  'testResultUsesSavedProfile(',
  'async savePythonEditor(',
  'async initializeProductWorkspace(',
  'reason: "real_test_profile"',
  'reason: "manual_import_test"',
  'reason: "credential_update"'
];

for (const marker of requiredHtml) {
  assert.ok(html.includes(marker), `Missing admin/developer parity marker: ${marker}`);
}

assert.ok(app.includes('NexusAdminUI.bindUnifiedFormSubmission(form)'), "Shared admin form must hand submission to the unified controller.");
assert.ok(app.includes('await NexusAdminUI.initializeProductWorkspace(existingProduct)'), "Shared admin form must initialize the unified workspace.");
assert.ok(!html.includes('provider !== "n8n" && provider !== "make"'), "Stale n8n/Make-only provider restriction returned.");
assert.ok(html.includes('["n8n", "make", "zapier", "python"].includes(provider)'), "Import action must support all launched developer runtimes.");
assert.ok(html.includes('statusOverride: "draft"'), "Draft save must force draft status.");
assert.ok(html.includes('statusOverride: "live"'), "Publish must be explicit and gated.");
assert.ok(html.includes('this.hasRealPassingTest(product)'), "Publishing must require saved-profile real-test evidence.");
assert.ok(html.includes('this.credentialScan?.errors'), "Publishing must include credential readiness.");

console.log("Admin product parity regression checks passed.");