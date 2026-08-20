const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const resilience = read("supabase/functions/_shared/n8n-resilience.ts");
const credentials = read("supabase/functions/_shared/nexus-credentials.ts");
const developerCredentials = read("supabase/functions/developer-credentials/index.ts");
const technicalTest = read("supabase/functions/test-n8n-workflow/index.ts");
const editor = read("supabase/functions/n8n-editor-gateway/index.ts");
const dbClient = read("assets/js/nexus-db.js");
const developerPage = read("pages/developer/dashboard.html");

assert(resilience.includes("408, 425, 429, 500, 502, 503, 504"), "Transient n8n HTTP statuses must be explicit.");
assert(resilience.includes("N8N_TEMPORARILY_UNAVAILABLE"), "Transient n8n errors need a stable machine-readable code.");
assert(resilience.includes("Nexus preserved the current workflow and credentials"), "Outage errors must state that live configuration was preserved.");
assert(resilience.includes("Math.max(1, Math.min(Number(config.attempts || 4), 5))"), "n8n retries must remain bounded.");

assert(editor.includes("fetchN8nWithRetry(`${baseUrl}/rest/login`"), "Editor login must use bounded n8n retries.");
assert(editor.includes('retryMethods: ["POST"]'), "Only the idempotent login POST may retry in the editor login path.");
assert(editor.includes('retryMethods: ["GET", "HEAD"]'), "Editor proxy retries must be limited to safe read requests.");
assert(editor.includes("isN8nUnavailableError(error) ? 503 : 403"), "Editor proxy must surface a retryable 503 instead of a misleading authorization error.");

assert(developerCredentials.includes("fetchN8nWithRetry(`${baseUrl}/api/v1/workflows/"), "Credential scans must read the live hosted workflow with retries.");
assert(!developerCredentials.includes("Could not fetch live n8n workflow for credential scan:"), "Credential scans must not silently fall back after an n8n failure.");
assert(developerCredentials.includes("credentials_preserved: true"), "Credential API outages must confirm binding preservation.");

assert(credentials.includes("if (isN8nUnavailableError(error)) throw error;"), "Credential binding must stop immediately on infrastructure outages.");
assert(credentials.includes('retryMethods: ["GET", "HEAD", "PUT", "PATCH"]'), "Credential retries must avoid unsafe credential-creation POST retries.");

assert(technicalTest.includes("const liveWorkflow = await fetchLiveN8nWorkflow(workflowId);"), "Technical tests must preflight the live hosted workflow.");
assert(!technicalTest.includes("const workflowInput = liveWorkflow || automation.n8n_normalized_workflow_json"), "Technical tests must never overwrite live credentials from stale stored JSON.");
assert(technicalTest.includes("if (!infrastructureError)"), "Infrastructure failures must not replace the product's last real technical-test result.");
assert(technicalTest.includes("credentials_preserved: true"), "Technical-test outage responses must confirm preservation.");
assert(technicalTest.includes('const dataQuery = includeData ? "?includeData=true" : "";'), "Technical tests must use lightweight execution metadata by default.");
assert(!technicalTest.includes("for (const candidate of candidates.slice(0, 8))"), "Technical tests must not load full payloads for several recent executions.");
assert(technicalTest.includes("Fetch full data only once, and only when a failed run"), "Full execution data must be limited to one failed run for diagnostics.");
assert(technicalTest.includes("ts <= startedAtMs + 120_000"), "Technical tests must not claim an unrelated later execution.");
assert(technicalTest.includes('["active", "published", "live"]'), "Technical tests must never deactivate an already-live product.");

assert(dbClient.includes("retryable: data.retryable === true"), "The browser client must preserve retryable outage metadata.");
assert(developerPage.includes("n8n temporarily unavailable"), "The developer UI must distinguish an n8n outage from a workflow failure.");
assert(developerPage.includes("Your saved credentials and confirmed workflow bindings were preserved."), "The developer UI must confirm binding preservation.");
assert(developerPage.includes("NEXUS_FINAL_OUTPUT before importing"), "The final-output marker must be explained before the readiness check.");
assert(developerPage.includes("Nexus will keep checking this same test."), "The developer UI must keep polling the same test through a temporary n8n restart.");

console.log(JSON.stringify({
  transient_retry: true,
  unsafe_post_retry_blocked: true,
  stale_workflow_fallback_blocked: true,
  credential_state_preserved: true,
  technical_result_preserved: true,
  lightweight_execution_verification: true,
  outage_polling_recovery: true,
  live_product_activation_preserved: true,
  developer_guidance: true,
}));
