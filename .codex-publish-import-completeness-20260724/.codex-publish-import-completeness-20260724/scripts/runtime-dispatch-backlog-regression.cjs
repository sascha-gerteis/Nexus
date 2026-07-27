const fs = require("fs");

function read(path) {
  return fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}

function requireText(source, text, label) {
  if (!source.includes(text)) {
    throw new Error(`Missing ${label}: ${text}`);
  }
}

function requireOrder(source, first, second, label) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  if (firstIndex < 0 || secondIndex < 0 || firstIndex >= secondIndex) {
    throw new Error(`Invalid order for ${label}`);
  }
}

function rejectText(source, text, label) {
  if (source.includes(text)) {
    throw new Error(`Forbidden ${label}: ${text}`);
  }
}

const submit = read("supabase/functions/submit-automation-setup/index.ts");
const scheduled = read("supabase/functions/run-scheduled-automations/index.ts");
const worker = read("supabase/functions/process-runtime-dispatch-backlog/index.ts");
const migration = read("supabase/migrations/20260725000200_runtime_dispatch_backlog.sql");
const dashboard = read("pages/buyer/dashboard.html");
const config = read("supabase/config.toml");

[
  [migration, "constraint runtime_dispatch_queue_run_unique unique (run_id)", "one queue row per run"],
  [migration, "add column if not exists setup_answers jsonb", "non-secret setup storage"],
  [migration, "submission.answers - coalesce(", "historical setup-answer redaction"],
  [migration, "left join public.customer_automation_credentials", "credential-key redaction source"],
  [migration, "for update skip locked", "atomic concurrent queue claim"],
  [migration, "queue.locked_at < now() - interval '5 minutes'", "stale worker lock recovery"],
  [migration, "alter table public.runtime_dispatch_queue enable row level security", "queue RLS"],
  [migration, "revoke all on public.runtime_dispatch_queue from anon, authenticated", "private queue"],
  [migration, "authorize_runtime_dispatch_worker", "hashed worker-token authorization"],
  [migration, "encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')", "worker token hashing"],
  [migration, "'nexus-runtime-dispatch-backlog-1min'", "one-minute retry heartbeat"],
  [migration, "'* * * * *'", "one-minute cron schedule"],
  [migration, "where jobname = 'nexus-monthly-runner-daily'", "broken legacy cron removal"],
  [submit, "status: \"queued\"", "queued-first setup run"],
  [submit, "answers: payload.setup_answers || {}", "future setup secret separation"],
  [submit, "enqueueRuntimeDispatch(adminClient", "setup outbox insert"],
  [submit, "status: \"queued_for_retry\"", "successful queued response"],
  [submit, "await acceptRuntimeDispatch(adminClient, activeRun.id)", "setup dispatch acceptance"],
  [submit, "\"Idempotency-Key\": params.runKey || \"\"", "setup stable idempotency header"],
  [scheduled, "enqueueScheduledDispatch(", "scheduled outbox insert"],
  [scheduled, "status: \"queued\"", "queued-first scheduled run"],
  [scheduled, "await acceptScheduledDispatch(adminClient, run.id)", "scheduled acceptance"],
  [scheduled, "await deferScheduledDispatch(", "scheduled retry deferral"],
  [scheduled, "\"Idempotency-Key\": cleanString(payload?.run_key)", "scheduled idempotency header"],
  [worker, "authorize_runtime_dispatch_worker", "worker authentication"],
  [worker, "claim_runtime_dispatch_queue", "atomic worker claim"],
  [worker, ".eq(\"id\", queue.run_id)", "exact queued run lookup"],
  [worker, ".eq(\"customer_automation_id\", queue.customer_automation_id)", "run ownership lookup"],
  [worker, "queue.setup_submission_id", "exact saved setup lookup"],
  [worker, "for (const secretKey of Object.keys(secrets)) delete rawSetup[secretKey]", "retry payload secret separation"],
  [worker, "applySheetAccessSetup(rawSetup, automation, customerAutomation)", "retry setup normalization parity"],
  [worker, "status: \"pending\"", "retry requeue"],
  [worker, "status: \"accepted\"", "accepted terminal queue state"],
  [worker, "status: \"dead_letter\"", "permanent customer error state"],
  [worker, "database is not ready", "n8n database outage classification"],
  [worker, "Math.min(15 * 60", "capped exponential backoff"],
  [worker, "\"Idempotency-Key\": cleanString(payload.run_key)", "worker stable idempotency header"],
  [worker, "body.run_due === true", "scheduler heartbeat"],
  [dashboard, "label: \"Queued\"", "truthful queued dashboard label"],
  [dashboard, "Your setup is safely saved.", "queued dashboard explanation"],
  [config, "[functions.process-runtime-dispatch-backlog]", "worker function config"],
  [config, "verify_jwt = false", "worker custom-auth deployment mode"],
].forEach(([source, text, label]) => requireText(source, text, label));

requireOrder(
  submit,
  "enqueueRuntimeDispatch(adminClient",
  "? await triggerPythonRunner({",
  "setup queue insert before the first runtime request",
);
requireOrder(
  submit,
  "await updateAutomationRunById(adminClient, activeRun.id, {\n      status: \"running\"",
  "await acceptRuntimeDispatch(adminClient, activeRun.id)",
  "accepted run state before queue completion",
);
requireOrder(
  worker,
  "authorize_runtime_dispatch_worker",
  "claim_runtime_dispatch_queue",
  "worker authentication before queue claim",
);
requireOrder(
  dashboard,
  "label: \"Queued\"",
  "if (runIsStaleActive(latestRun))",
  "queued dashboard state before stale-running warning",
);

rejectText(
  migration,
  "runtime_secret text",
  "runtime secret storage in the queue",
);
rejectText(
  migration,
  "secrets jsonb",
  "customer secret storage in the queue",
);
rejectText(
  submit,
  "Buyer submissions move into running immediately.",
  "old pre-acceptance running behavior",
);

console.log("Runtime dispatch backlog regression checks passed.");
