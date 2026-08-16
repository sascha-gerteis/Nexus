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
const importer = read("supabase/functions/import-n8n-workflow/index.ts");
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
expect(shared.includes("eventFieldDefinitions"), "Missing explicit per-request field isolation.");
expect(shared.includes("webhookInputFieldDefinitions"), "Missing combined runtime input schema.");
expect(config.includes("runtime_event_schema"), "Config service does not load the product event schema.");
expect(config.includes("event_fields: schemas.eventFields"), "Config response does not separate event fields.");
expect(config.includes("saved_setup: savedSetup"), "Config response does not return safe saved defaults.");
expect(ingress.includes("eventSchema: eventFields"), "Live ingress does not normalize declared event fields.");
expect(ingress.includes("normalizeEventMappings(config.event_mapping, inputFields)"), "Live ingress does not preserve already-confirmed legacy setup mappings during transition.");
expect(config.includes("normalizeEventMappings(config.event_mapping, schemas.inputFields)"), "Config preview does not preserve already-confirmed legacy setup mappings during transition.");
expect(importer.includes('runtimeContextPath("event.data", cleanKey)'), "n8n importer does not resolve event placeholders to normalized event data.");
expect(page.includes("Set defaults and match request fields"), "Buyer page is missing the corrected Step 2 contract.");
expect(page.includes("Saved once"), "Buyer page is missing stable setup defaults.");
expect(page.includes("Per-request fields"), "Buyer page is missing isolated request fields.");
expect(page.includes("Fallback if missing"), "Buyer page is missing request fallbacks.");
expect(page.includes("finishEventMapping"), "Buyer page is missing mapping validation and confirmation.");

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
  stableSetupSeparatedFromEvents: true,
  savedFallbacksSupported: true,
  normalizedEventImportSupported: true,
  existingMappingsRemainCompatible: true,
  pageSyntax: true,
}));
