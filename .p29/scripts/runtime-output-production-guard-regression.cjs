const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const runtimeOutput = fs.readFileSync(
  path.join(root, "supabase", "functions", "runtime-submit-output", "index.ts"),
  "utf8",
);
const submitSetup = fs.readFileSync(
  path.join(root, "supabase", "functions", "submit-automation-setup", "index.ts"),
  "utf8",
);
const provisionWorkflow = fs.readFileSync(
  path.join(root, "supabase", "functions", "provision-customer-workflow", "index.ts"),
  "utf8",
);
const migration = fs.readFileSync(
  path.join(root, "supabase", "migrations", "20260725000100_lock_runtime_identity.sql"),
  "utf8",
);

assert.doesNotMatch(runtimeOutput, /findLatestActiveRunForCallback/);
assert.match(
  runtimeOutput,
  /updateExistingRunFromCallback\(\s*adminClient,\s*callbackAutomationRunId,/,
);
assert.doesNotMatch(runtimeOutput, /trigger_type:\s*"runtime_callback"/);
assert.match(runtimeOutput, /runtime_callback_run_update_failed/);
assert.doesNotMatch(runtimeOutput, /Deno\.serveDeno\.serve/);
assert.doesNotMatch(runtimeOutput, /callbackRunReferencefunction callbackRunReference/);
assert.doesNotMatch(runtimeOutput, /await tryInsertRunError\s+await tryInsertRunError/);
assert.doesNotMatch(runtimeOutput, /await insertEvent\s+await insertEvent/);

assert.match(
  submitSetup,
  /replace\(\/\[\\s-\]\+\/g,\s*"_"\)[\s\S]*?\.includes\(status\)/,
);
assert.doesNotMatch(
  submitSetup,
  /runtimeStatusIsActive[\s\S]{0,300}status\.includes\(item\)/,
);
assert.match(
  submitSetup,
  /if \(!isUuid\(activeRun\.id\)\) \{[\s\S]*?workflow was not started/,
);
const createRunRegion = submitSetup.match(
  /async function createAutomationRun[\s\S]*?(?=async function updateAutomationRunById)/,
)?.[0] || "";
assert.ok(createRunRegion);
assert.doesNotMatch(createRunRegion, /fallbackPayload|delete .*run_key/);

for (const field of [
  "x-nexus-runtime-secret",
  "customer_automation_id",
  "run_id",
  "run_key",
]) {
  assert.match(provisionWorkflow, new RegExp(JSON.stringify(field)));
}

assert.match(migration, /enforce_automation_run_purchase_identity/);
assert.match(migration, /idx_automation_runs_run_key_unique/);
assert.match(migration, /idx_automation_outputs_run_unique/);
assert.match(migration, /idx_automation_outputs_bundle_item_unique/);
assert.match(migration, /having count\(\*\) > 1/);

console.log("Runtime output production guard regression checks passed.");
