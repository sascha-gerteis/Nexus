const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { stripTypeScriptTypes } = require("node:module");

const source = fs.readFileSync(path.join(__dirname, "..", "supabase", "functions", "repair-n8n-output-contract", "index.ts"), "utf8");

for (const invariant of [
  "UPGRADE_BUNDLE_OUTPUT_CONTRACT_V1",
  "NEXUS_OUTPUT_CONTRACT_REPAIR_TOKEN",
  "x-nexus-repair-token",
  "expected_workflows",
  "fingerprint",
  "Nexus Submit Output",
  "Nexus Runtime Context",
  'name: "run_id"',
  'name: "run_key"',
  "withoutIdentity",
  "Post-update workflow differs outside run_id/run_key.",
  "restore(id, original, originallyActive)",
  "rollback_performed",
]) assert.ok(source.includes(invariant), `Missing repair invariant: ${invariant}`);

assert.match(source, /action \|\| "audit"\) === "audit"[\s\S]*?audit\(adminClient, body\)/);
assert.match(source, /lower\(body\.action\) === "apply"[\s\S]*?x-nexus-repair-token/);
assert.match(source, /fingerprint\(original\) !== hash[\s\S]*?addIdentity\(original\)/);
assert.match(source, /updateStarted = true;[\s\S]*?putWorkflow\(id, patched\)[\s\S]*?contract\(verified\)\.contract_current[\s\S]*?withoutIdentity/);
assert.match(source, /catch \(error\)[\s\S]*?if \(updateStarted\)[\s\S]*?restore\(id, original, originallyActive\)/);
assert.doesNotMatch(source, /from\("orders"\)\.update|from\("customer_automations"\)\.update|stripe/i);
assert.doesNotMatch(source, /import-n8n-workflow|n8n_workflow_json|selected_customization/);

const pureStart = source.indexOf("const JSON_CONTRACT_MARKER");
const pureEnd = source.indexOf("async function fingerprint");
assert.ok(pureStart >= 0 && pureEnd > pureStart, "Could not isolate pure repair logic.");
const pureTypeScript = `${source.slice(pureStart, pureEnd)}\nglobalThis.__repairTest = { contract, addIdentity, withoutIdentity, workflowPayload, jsonBodyValue, wrapJsonBodyWithIdentity };`;
const context = { console };
vm.runInNewContext(stripTypeScriptTypes(pureTypeScript, { mode: "strip" }), context);
const repair = context.__repairTest;

const original = {
  name: "Nexus - fixture",
  active: true,
  nodes: [
    { name: "Nexus Runtime Context", type: "n8n-nodes-base.code", parameters: { jsCode: "return items" } },
    { name: "Report Builder", type: "n8n-nodes-base.code", parameters: { jsCode: "return report" } },
    {
      name: "Nexus Submit Output",
      type: "n8n-nodes-base.httpRequest",
      parameters: {
        method: "POST",
        url: "https://example.test/runtime-submit-output",
        bodyParameters: {
          parameters: [
            { name: "customer_automation_id", value: "={{ $json.system.customer_automation_id }}" },
            { name: "status", value: "success" },
            { name: "content_html", value: "={{ $json.content_html }}" },
          ],
        },
      },
    },
  ],
  connections: { "Report Builder": { main: [[{ node: "Nexus Submit Output", type: "main", index: 0 }]] } },
  settings: { executionOrder: "v1", saveExecutionProgress: true },
  staticData: { preserved: true },
};

assert.equal(repair.contract(original).contract_current, false);
assert.equal(repair.contract(original).repair_eligible, true);
const patched = repair.addIdentity(original);
assert.equal(repair.contract(patched).contract_current, true);
assert.deepEqual(JSON.parse(JSON.stringify(repair.withoutIdentity(patched))), JSON.parse(JSON.stringify(repair.withoutIdentity(original))));
assert.equal(original.nodes[2].parameters.bodyParameters.parameters.some((row) => row.name === "run_id"), false, "Pure repair mutated the original workflow.");
assert.equal(patched.nodes[1].parameters.jsCode, "return report", "Report-generation node changed.");
assert.deepEqual(JSON.parse(JSON.stringify(patched.connections)), original.connections, "Workflow connections changed.");
assert.deepEqual(JSON.parse(JSON.stringify(patched.settings)), original.settings, "Workflow settings changed.");
assert.throws(() => repair.addIdentity({ ...original, nodes: original.nodes.filter((node) => node.name !== "Nexus Runtime Context") }), /not eligible/);
const originalJsonBody = '={{ JSON.stringify({ customer_automation_id: $("Nexus Runtime Context").first().json.system.customer_automation_id, status: "success", content_html: $json.content_html }) }}';
const jsonOriginal = {
  ...original,
  nodes: [
    original.nodes[0],
    original.nodes[1],
    {
      ...original.nodes[2],
      parameters: {
        method: "POST",
        url: "https://example.test/runtime-submit-output",
        specifyBody: "json",
        jsonBody: originalJsonBody,
      },
    },
  ],
};

assert.equal(repair.contract(jsonOriginal).contract_current, false);
assert.equal(repair.contract(jsonOriginal).repair_eligible, true);
assert.equal(repair.contract(jsonOriginal).repair_mode, "json_expression");
const jsonPatched = repair.addIdentity(jsonOriginal);
const patchedJsonBody = repair.jsonBodyValue(jsonPatched);
assert.equal(repair.contract(jsonPatched).contract_current, true);
assert.equal(patchedJsonBody, repair.wrapJsonBodyWithIdentity(originalJsonBody));
assert.equal(repair.jsonBodyValue(jsonOriginal), originalJsonBody, "Pure JSON repair mutated the original workflow.");
assert.equal(jsonPatched.nodes[1].parameters.jsCode, "return report", "JSON repair changed the report-generation node.");
assert.deepEqual(JSON.parse(JSON.stringify(jsonPatched.connections)), jsonOriginal.connections, "JSON repair changed workflow connections.");
assert.deepEqual(JSON.parse(JSON.stringify(jsonPatched.settings)), jsonOriginal.settings, "JSON repair changed workflow settings.");
assert.deepEqual(JSON.parse(JSON.stringify(repair.withoutIdentity(jsonPatched))), JSON.parse(JSON.stringify(repair.withoutIdentity(jsonOriginal))));

const jsonInner = patchedJsonBody.slice(3, -2);
const system = { customer_automation_id: "customer-1", run_id: "run-1", run_key: "key-1" };
const evaluateJsonBody = new Function("$", "$json", `return (${jsonInner});`);
const evaluatedJsonBody = evaluateJsonBody(
  (nodeName) => {
    assert.equal(nodeName, "Nexus Runtime Context");
    return { first: () => ({ json: { system } }) };
  },
  { content_html: "<p>report</p>" },
);
assert.equal(typeof evaluatedJsonBody, "string", "JSON.stringify workflow changed its output type.");
assert.deepEqual(JSON.parse(evaluatedJsonBody), {
  customer_automation_id: "customer-1",
  status: "success",
  content_html: "<p>report</p>",
  run_id: "run-1",
  run_key: "key-1",
});

console.log("Bundle output contract repair regression checks passed.");