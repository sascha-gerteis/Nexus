const fs = require("fs");

function read(path) {
  return fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

function requireText(source, text, label) {
  if (!source.includes(text)) throw new Error(`Missing ${label}: ${text}`);
}

function requireOrder(source, first, second, label) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  if (firstIndex < 0 || secondIndex < 0 || firstIndex >= secondIndex) {
    throw new Error(`Invalid order for ${label}`);
  }
}

function rejectText(source, text, label) {
  if (source.includes(text)) throw new Error(`Forbidden ${label}: ${text}`);
}

const checker = read("supabase/functions/check-n8n-execution/index.ts");
const worker = read("supabase/functions/process-runtime-dispatch-backlog/index.ts");
const monitor = read("supabase/functions/monitor-system-health/index.ts");

[
  [checker, "const memorySignals = [", "dedicated memory classifier"],
  [checker, '"heap out of memory"', "V8 heap signal"],
  [checker, '"allocation failed"', "allocation failure signal"],
  [checker, 'error_code: "N8N_OUT_OF_MEMORY"', "memory error code"],
  [checker, 'env("N8N_MISSING_EXECUTION_TIMEOUT_MINUTES") || "45"', "bounded missing-execution timeout"],
  [checker, 'status: "success_recovered_from_existing_output"', "delivered output preservation"],
  [checker, '.eq("automation_run_id", latestRun.id)', "standalone exact output identity"],
  [checker, '"bundle_run_item_id",', "bundle exact output identity"],
  [checker, 'status: "missing_execution_timeout_recorded"', "terminal missing-execution state"],
  [worker, "async function reconcileStaleN8nRuns", "background reconciler"],
  [worker, '.eq("runtime_type", "n8n_managed")', "n8n-only reconciliation scope"],
  [worker, '.eq("status", "running")', "running-only reconciliation scope"],
  [worker, '.order("created_at", { ascending: false })', "recent stale run priority"],
  [worker, "const latestLookups = await Promise.all", "latest-run ownership lookup"],
  [worker, ".filter((run: any) => latestRunIds.has(cleanString(run.id)))", "superseded run exclusion"],
  [worker, "superseded_skipped:", "superseded run accounting"],
  [worker, '"x-nexus-runtime-secret": NEXUS_RUNTIME_SECRET', "internal checker authentication"],
  [worker, "customer_automation_id: run.customer_automation_id", "exact automation identity"],
  [worker, "run_id: run.id", "exact run identity"],
  [worker, "Number(body.reconcile_limit || 2)", "bounded reconciliation batch"],
  [worker, "reconciliation,", "worker reconciliation result"],
  [monitor, "async function checkStaleN8nRuns", "stale-run health check"],
  [monitor, 'error_code", "N8N_OUT_OF_MEMORY"', "recent memory alert query"],
  [monitor, "checkStaleN8nRuns(adminClient)", "production monitor integration"],
].forEach(([source, text, label]) => requireText(source, text, label));

requireOrder(checker, "const memorySignals = [", "if (customerCredentialSignals.some", "memory classification before credential classification");
requireOrder(checker, "const existingOutput =", "const timeoutMessage =", "output recovery before stale failure");
requireOrder(worker, "const schedules = body.run_due === true", "const reconciliation = body.run_due === true", "schedule dispatch before reconciliation");
requireOrder(worker, "const latestRunIds = new Set(", "const results = await Promise.all(latestStaleRuns", "latest ownership gate before reconciliation calls");
rejectText(checker, "The runtime may have restarted or exhausted its memory.", "unproven memory diagnosis");

console.log("n8n memory resilience regression checks passed.");
