import {
  applyEventMappings,
  buildWebhookRuntimeEnvelope,
  normalizeEventMappings,
  setupFieldDefinitions,
} from "../supabase/functions/_shared/webhook-event-mapping.ts";

function expect(value, message) {
  if (!value) throw new Error(message);
}

const schema = [
  { name: "message", label: "Message", type: "text" },
  { name: "api_key", label: "API key", type: "secret" },
  { name: "company", label: "Company", type: "text", required: true },
];

const fields = setupFieldDefinitions(schema);
expect(fields.map((field) => field.name).join(",") === "message,company", "Secret fields were exposed as mapping targets.");

const mappings = normalizeEventMappings([
  { target: "message", source_path: "payload.text" },
], schema);
const mapped = applyEventMappings({
  payload: { payload: { text: "Hello" } },
  mappings,
  savedSetup: { company: "Nexus" },
});
expect(mapped.ok, "Valid event mapping did not resolve.");
expect(mapped.setup.message === "Hello", "Mapped event value did not reach setup.");
expect(mapped.setup.company === "Nexus", "Unmapped saved setup value was not preserved.");

const runtime = buildWebhookRuntimeEnvelope({
  customerAutomation: {
    id: "ca-1",
    automation_id: "automation-1",
    order_id: "order-1",
    buyer_id: "buyer-1",
    bundle_id: "bundle-1",
  },
  automation: { id: "automation-1" },
  order: { id: "order-1", bundle_id: "bundle-1" },
  payload: {
    event: { type: "message.received" },
    payload: { text: "Hello" },
  },
  eventId: "event-1",
  receivedAt: "2026-08-12T00:00:00.000Z",
  mappings,
  savedSetup: { company: "Nexus" },
  setupSchema: schema,
});

expect(runtime.ok, "Runtime envelope rejected a valid event.");
expect(runtime.envelope.event.type === "message.received", "Canonical event type was not preserved.");
expect(runtime.envelope.system.order_id === "order-1", "Exact order identity was not preserved.");
expect(runtime.envelope.system.run_id === "assigned_at_dispatch", "Run identity was assigned outside the dispatcher.");
expect(runtime.envelope.system.bundle_run_attempt_id === "assigned_at_dispatch", "Bundle attempt identity was not reserved.");
expect(runtime.envelope.system.bundle_run_item_id === "assigned_at_dispatch", "Bundle item identity was not reserved.");
expect(runtime.envelope.system.idempotency_key === "webhook:ca-1:event-1", "Stable webhook idempotency identity was not constructed.");

const missingRequired = buildWebhookRuntimeEnvelope({
  customerAutomation: { id: "ca-2", automation_id: "automation-1", order_id: "order-2", buyer_id: "buyer-2" },
  automation: { id: "automation-1" },
  order: { id: "order-2" },
  payload: { payload: { text: "Hello" } },
  eventId: "event-2",
  receivedAt: "2026-08-12T00:00:00.000Z",
  mappings,
  savedSetup: {},
  setupSchema: schema,
});
expect(!missingRequired.ok, "Runtime mapping accepted a missing required setup value.");
expect(missingRequired.errors.some((message) => message.includes("Required runtime input Company")), "Missing required input was not explained.");

let blockedIdentity = false;
try {
  normalizeEventMappings([{ target: "run_id", source_path: "payload.id" }], schema);
} catch {
  blockedIdentity = true;
}
expect(blockedIdentity, "Reserved runtime identity was accepted as a buyer mapping target.");

console.log(JSON.stringify({
  secretTargetsExcluded: true,
  savedSetupPreserved: true,
  eventMappingApplied: true,
  canonicalEventBuilt: true,
  standaloneIdentityPreserved: true,
  bundleIdentityReserved: true,
  dispatcherOwnsRunIdentity: true,
  stableIdempotencyIdentity: true,
  requiredInputsEnforced: true,
}));
