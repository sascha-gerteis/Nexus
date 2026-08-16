import {
  applyEventMappings,
  buildWebhookRuntimeEnvelope,
  eventFieldDefinitions,
  normalizeEventMappings,
  setupFieldDefinitions,
  webhookInputFieldDefinitions,
} from "../supabase/functions/_shared/webhook-event-mapping.ts";

function expect(value, message) {
  if (!value) throw new Error(message);
}

const schema = [
  { name: "message", label: "Message", type: "text" },
  { name: "api_key", label: "API key", type: "secret" },
  { name: "company", label: "Company", type: "text", required: true },
  { name: "external_customer_id", label: "External customer ID", type: "text", required: true },
];

const fields = setupFieldDefinitions(schema);
expect(fields.map((field) => field.name).join(",") === "message,company", "Secret or Nexus-owned identity fields were exposed as mapping targets.");

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
expect(runtime.envelope.setup.external_customer_id === "buyer-1", "Nexus did not generate the legacy external customer identity alias.");
expect(runtime.envelope.setup.customer_automation_id === "ca-1", "Nexus did not generate the customer automation identity alias.");
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

const legacyIdentityMappings = normalizeEventMappings([
  { target: "external_customer_id", source_path: "payload.customer_id" },
], schema);
expect(legacyIdentityMappings.length === 0, "Legacy Nexus-owned identity mapping was not discarded safely.");

const legacyWebhookSetup = [
  { name: "business_name", label: "Business Name", required: true },
  { name: "default_priority", label: "Default Priority", required: true },
  { name: "event_message", label: "Event Message", required: true },
  { name: "event_priority", label: "Event Priority", required: true },
  { name: "reply_prefix", label: "Reply Prefix", required: true },
  { name: "external_customer_id", label: "External Customer ID", required: true },
];
const inferredEventFields = eventFieldDefinitions([], legacyWebhookSetup);
expect(inferredEventFields.map((field) => field.name).join(",") === "event_message,event_priority", "Legacy webhook event fields were not isolated from stable setup.");
const combinedInputFields = webhookInputFieldDefinitions(legacyWebhookSetup, []);
expect(combinedInputFields.map((field) => field.name).join(",") === "business_name,default_priority,event_message,event_priority,reply_prefix", "Webhook inputs did not exclude Nexus identity or preserve setup.");
const explicitEventFields = eventFieldDefinitions([{ name: "question", label: "Question", required: true }], legacyWebhookSetup);
expect(explicitEventFields.length === 1 && explicitEventFields[0].name === "question", "Explicit runtime event schema did not take precedence.");

const fallbackMappings = normalizeEventMappings([
  { target: "event_message", source_path: "message" },
  { target: "event_priority", source_path: "priority" },
], inferredEventFields);
const fallbackRuntime = buildWebhookRuntimeEnvelope({
  customerAutomation: { id: "ca-3", automation_id: "automation-1", order_id: "order-3", buyer_id: "buyer-3" },
  automation: { id: "automation-1" },
  order: { id: "order-3" },
  payload: { message: "Hello from sender" },
  eventId: "event-3",
  receivedAt: "2026-08-16T00:00:00.000Z",
  mappings: fallbackMappings,
  savedSetup: {
    business_name: "Nexus",
    default_priority: "normal",
    event_priority: "normal",
    reply_prefix: "Re:",
  },
  setupSchema: combinedInputFields,
  eventSchema: inferredEventFields,
});
expect(fallbackRuntime.ok, "Saved fallback did not safely replace a missing required request value.");
expect(fallbackRuntime.envelope.setup.event_priority === "normal", "Required event fallback was not preserved.");
expect(fallbackRuntime.envelope.event.data.event_message === "Hello from sender", "Normalized event data did not expose mapped event value.");
expect(fallbackRuntime.envelope.event.data.event_priority === "normal", "Normalized event data did not expose saved event fallback.");
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
  nexusIdentityGenerated: true,
  legacyIdentityMappingDiscarded: true,
  stableSetupSeparatedFromEvents: true,
  explicitEventSchemaPreferred: true,
  requiredEventFallbackSupported: true,
  normalizedEventDataAvailable: true,
}));
