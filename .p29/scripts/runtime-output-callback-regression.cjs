const assert = require("assert");
const fs = require("fs");
const path = require("path");

const source = fs.readFileSync(
  path.join(__dirname, "..", "supabase", "functions", "runtime-submit-output", "index.ts"),
  "utf8",
);
const reconciliationSource = fs.readFileSync(
  path.join(__dirname, "..", "supabase", "functions", "check-n8n-execution", "index.ts"),
  "utf8",
);

assert.match(source, /safeEnqueueOutputReadyEmail/);
assert.match(source, /outputId: output\.id/);
assert.match(reconciliationSource, /safeEnqueueOutputReadyEmail/);
assert.match(reconciliationSource, /if \(recoveredOutput\?\.id\)/);
assert.match(reconciliationSource, /outputId: recoveredOutput\.id/);
assert.doesNotMatch(reconciliationSource, /outputId: currentOutputId/);
assert.match(reconciliationSource, /\.select\("id, title"\)/);

assert.match(source, /function selectLegacyStandaloneCallbackRun\(/);
assert.match(source, /cleanString\(run\?\.order_id\) === orderId/);
assert.match(source, /!cleanString\(run\?\.bundle_run_attempt_id\)/);
assert.match(source, /!cleanString\(run\?\.bundle_run_item_id\)/);
assert.match(source, /cleanString\(customerAutomation\.order_id\)/);

const active = new Set(["running", "processing", "queued", "started", "pending", "in_progress"]);
const successful = new Set(["success", "succeeded", "completed", "complete"]);
const normalize = (value) => String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");

function select(rows, expectedOrderId) {
  if (!expectedOrderId) return null;
  const candidates = rows.filter((run) =>
    run.order_id === expectedOrderId &&
    !run.bundle_run_attempt_id &&
    !run.bundle_run_item_id
  );
  const newestRun = candidates[0] || null;
  return newestRun &&
    (active.has(normalize(newestRun.status)) || successful.has(normalize(newestRun.status)))
    ? newestRun
    : null;
}

const orderId = "order-current";
const newest = { id: "run-new", order_id: orderId, status: "running" };
const older = { id: "run-old", order_id: orderId, status: "running" };

assert.equal(select([newest, older], orderId).id, "run-new");
assert.equal(
  select([{ id: "done", order_id: orderId, status: "success" }], orderId).id,
  "done",
);
assert.equal(
  select([{ id: "cancelled", order_id: orderId, status: "cancelled" }], orderId),
  null,
);
assert.equal(
  select([{ id: "not-started", order_id: orderId, status: "not_started" }], orderId),
  null,
);
assert.equal(
  select([
    { id: "cancelled-new", order_id: orderId, status: "cancelled" },
    { id: "success-old", order_id: orderId, status: "success" },
  ], orderId),
  null,
);
assert.equal(
  select([
    { id: "cancelled-new", order_id: orderId, status: "cancelled" },
    { id: "running-old", order_id: orderId, status: "running" },
  ], orderId),
  null,
);
assert.equal(
  select([{ id: "wrong-order", order_id: "order-old", status: "running" }], orderId),
  null,
);
assert.equal(
  select([{
    id: "bundle-run",
    order_id: orderId,
    status: "running",
    bundle_run_attempt_id: "attempt-1",
  }], orderId),
  null,
);

console.log("Runtime output callback regression checks passed.");
