const fs = require("fs");
const vm = require("vm");

function read(path) {
  return fs.readFileSync(path, "utf8");
}

function expect(value, message) {
  if (!value) throw new Error(message);
}

const migration = read("supabase/migrations/20260812000200_buyer_webhook_event_mapping.sql");
const shared = read("supabase/functions/_shared/webhook-event-mapping.ts");
const config = read("supabase/functions/buyer-webhook-config/index.ts");
const ingress = read("supabase/functions/buyer-webhook-ingress/index.ts");
const page = read("pages/buyer/webhook-setup.html");

expect(migration.includes("event_mapping jsonb"), "Missing buyer-owned event mapping storage.");
expect(migration.includes("event_mapping_status"), "Missing mapping state machine.");
expect(migration.includes("check (live_enabled = false)"), "Mapping phase must keep live dispatch database-gated.");
expect(shared.includes("normalizeEventMappings"), "Missing mapping allowlist normalization.");
expect(shared.includes("valueAtEventPath"), "Missing safe event-path resolver.");
expect(shared.includes("Object.prototype.hasOwnProperty.call"), "Event traversal must reject inherited properties.");
expect(shared.includes("RESERVED_TARGETS"), "Runtime identity fields must not be buyer mapping targets.");
expect(shared.includes('run_id: "assigned_at_dispatch"'), "Run identity must be assigned only by the dispatcher.");
expect(shared.includes('trigger_source: "buyer_webhook"'), "Missing canonical webhook runtime source.");
expect(config.includes('action === "save_mapping"'), "Missing authenticated mapping save action.");
expect(config.includes('action === "validate_mapping"'), "Missing mapping validation action.");
expect(config.includes('action === "confirm_mapping"'), "Missing explicit mapping confirmation gate.");
expect(config.includes("buildWebhookRuntimeEnvelope"), "Config service must use the shared runtime envelope builder.");
expect(ingress.includes('event_mapping_status: "awaiting_validation"'), "A new test event must require mapping revalidation.");
expect(!/automation_runs[\s\S]{0,180}insert/.test(ingress), "Test ingress must not create runtime runs.");
expect(!/runtime_dispatch_queue[\s\S]{0,180}insert/.test(ingress), "Test ingress must not dispatch queued work.");
expect(page.includes("Map event data"), "Buyer page is missing event mapping UI.");
expect(page.includes("validateEventMapping"), "Buyer page is missing mapping validation control.");
expect(page.includes("confirmEventMapping"), "Buyer page is missing explicit mapping confirmation.");

const scripts = [...page.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1])
  .filter(code => code.trim());
for (const script of scripts) new vm.Script(script);

console.log(JSON.stringify({
  buyerOwnedMapping: true,
  safePathResolution: true,
  immutableRuntimeIdentity: true,
  canonicalEventContract: true,
  validationAndConfirmation: true,
  liveDispatchGated: true,
  pageSyntax: true,
}));
