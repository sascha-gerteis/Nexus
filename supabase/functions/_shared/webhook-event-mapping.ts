export type EventMappingItem = {
  target: string;
  source_path: string;
};

const MAX_MAPPING_ITEMS = 50;
const MAX_SOURCE_PATH_LENGTH = 240;
const BLOCKED_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const RESERVED_TARGETS = new Set([
  "system",
  "secrets",
  "credentials",
  "customer_automation_id",
  "customer_id",
  "external_customer_id",
  "nexus_customer_id",
  "automation_id",
  "order_id",
  "buyer_id",
  "run_id",
  "run_key",
  "bundle_id",
  "bundle_order_id",
  "bundle_run_attempt_id",
  "bundle_run_item_id",
]);
const NEXUS_GENERATED_SETUP_TARGETS = new Set([
  "customer_id",
  "external_customer_id",
  "nexus_customer_id",
  "customer_automation_id",
]);

export function cleanMappingString(value: unknown) {
  return String(value ?? "").trim();
}

export function mappingObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function normalizeSetupSchema(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      return normalizeSetupSchema(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (!value || typeof value !== "object") return [];
  const object = mappingObject(value);
  for (const candidate of [object.fields, object.setup_fields, object.setupFields, object.questions, object.schema, object.items]) {
    const fields = normalizeSetupSchema(candidate);
    if (fields.length) return fields;
  }
  return [];
}

export function setupFieldDefinitions(value: unknown) {
  const seen = new Set<string>();
  return normalizeSetupSchema(value).flatMap((field: any) => {
    const name = cleanMappingString(field?.name || field?.key);
    const canonical = name.toLowerCase();
    const fieldType = cleanMappingString(field?.type).toLowerCase();
    if (!name || seen.has(canonical) || RESERVED_TARGETS.has(canonical)) return [];
    if (["secret", "password", "credential", "api_key"].includes(fieldType)) return [];
    if (/token|secret|password|authorization|cookie|credential|api[_-]?key|private[_-]?key/i.test(name)) return [];
    if (!/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(name)) return [];
    seen.add(canonical);
    return [{
      name,
      label: cleanMappingString(field?.label || name),
      description: cleanMappingString(field?.description),
      required: field?.required === true,
      type: fieldType || "text",
      placeholder: cleanMappingString(field?.placeholder),
      options: Array.isArray(field?.options) ? field.options : [],
      default_value: field?.default_value ?? field?.defaultValue ?? field?.default ?? "",
    }];
  });
}

function perRequestFieldHint(field: any) {
  const name = cleanMappingString(field?.name || field?.key);
  const scope = cleanMappingString(field?.scope || field?.source || field?.usage).toLowerCase();
  return field?.per_request === true || field?.runtime_event === true || field?.event_field === true ||
    ["event", "request", "per_request", "runtime_event", "webhook"].includes(scope) ||
    /^(event|request|message|payload|prompt|question|query|command|input|content|text)(_|$)/i.test(name);
}

export function eventFieldDefinitions(runtimeEventSchema: unknown, setupSchema: unknown = []) {
  const explicit = setupFieldDefinitions(runtimeEventSchema);
  if (explicit.length) return explicit;
  return normalizeSetupSchema(setupSchema)
    .filter((field: any) => perRequestFieldHint(field))
    .flatMap((field: any) => setupFieldDefinitions([field]));
}

export function webhookInputFieldDefinitions(setupSchema: unknown, runtimeEventSchema: unknown = []) {
  const fields = [...setupFieldDefinitions(setupSchema), ...eventFieldDefinitions(runtimeEventSchema, setupSchema)];
  const seen = new Set<string>();
  return fields.filter((field) => {
    const canonical = field.name.toLowerCase();
    if (seen.has(canonical)) return false;
    seen.add(canonical);
    return true;
  });
}

function parseSourcePath(value: unknown) {
  const path = cleanMappingString(value);
  if (!path || path.length > MAX_SOURCE_PATH_LENGTH) return [];
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+|\[\d+\])*$/.test(path)) return [];
  const segments = path.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  if (!segments.length || segments.some((segment) => BLOCKED_SEGMENTS.has(segment.toLowerCase()))) return [];
  return segments;
}

export function valueAtEventPath(payload: unknown, sourcePath: unknown) {
  const segments = parseSourcePath(sourcePath);
  if (!segments.length) return { found: false, value: undefined };
  let current: any = payload;
  for (const segment of segments) {
    if (current === null || current === undefined || typeof current !== "object") {
      return { found: false, value: undefined };
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return { found: false, value: undefined };
    }
    current = current[segment];
  }
  if (current === undefined || current === "[redacted]" || current === "[nested]") {
    return { found: false, value: undefined };
  }
  return { found: true, value: current };
}

export function flattenEventPaths(payload: unknown, maxPaths = 120) {
  const output: Array<{ path: string; sample: unknown }> = [];
  const visit = (value: unknown, path: string, depth: number) => {
    if (output.length >= maxPaths || depth > 5) return;
    if (Array.isArray(value)) {
      value.slice(0, 5).forEach((child, index) => visit(child, `${path}[${index}]`, depth + 1));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
        if (BLOCKED_SEGMENTS.has(key.toLowerCase())) continue;
        visit(child, path ? `${path}.${key}` : key, depth + 1);
      }
      return;
    }
    if (path && value !== "[redacted]" && value !== "[nested]") output.push({ path, sample: value });
  };
  visit(payload, "", 0);
  return output;
}

export function normalizeEventMappings(value: unknown, setupSchema: unknown): EventMappingItem[] {
  const allowedTargets = new Map(
    setupFieldDefinitions(setupSchema).map((field) => [field.name.toLowerCase(), field.name]),
  );
  const rows = Array.isArray(value) ? value : [];
  if (rows.length > MAX_MAPPING_ITEMS) throw new Error(`A maximum of ${MAX_MAPPING_ITEMS} event mappings is allowed.`);
  const seen = new Set<string>();
  const output: EventMappingItem[] = [];
  for (const row of rows) {
    const object = mappingObject(row);
    const requestedTarget = cleanMappingString(object.target || object.target_field);
    const sourcePath = cleanMappingString(object.source_path || object.source);
    if (!requestedTarget && !sourcePath) continue;
    const requestedCanonical = requestedTarget.toLowerCase();
    const target = allowedTargets.get(requestedCanonical);
    // Older webhook configurations may have asked the buyer to supply Nexus
    // identity. Ignore those legacy mappings now that Nexus generates them.
    if (!target && NEXUS_GENERATED_SETUP_TARGETS.has(requestedCanonical)) continue;
    if (!target) throw new Error(`Event mapping target is not part of this product's setup schema: ${requestedTarget || "unknown"}.`);
    if (!parseSourcePath(sourcePath).length) throw new Error(`Invalid event source path for ${target}.`);
    if (seen.has(target.toLowerCase())) throw new Error(`Event field ${target} is mapped more than once.`);
    seen.add(target.toLowerCase());
    output.push({ target, source_path: sourcePath });
  }
  return output;
}

export function applyEventMappings(params: {
  payload: unknown;
  mappings: EventMappingItem[];
  savedSetup?: Record<string, unknown>;
  optionalTargets?: string[];
}) {
  const setup = { ...mappingObject(params.savedSetup) };
  const optionalTargets = new Set((params.optionalTargets || []).map((target) => cleanMappingString(target).toLowerCase()));
  const errors: string[] = [];
  const resolved: Array<{ target: string; source_path: string; value: unknown }> = [];
  for (const mapping of params.mappings) {
    const result = valueAtEventPath(params.payload, mapping.source_path);
    if (!result.found) {
      const fallback = setup[mapping.target];
      const hasFallback = fallback !== null && fallback !== undefined &&
        !(typeof fallback === "string" && !fallback.trim()) &&
        !(Array.isArray(fallback) && fallback.length === 0);
      if (!hasFallback && !optionalTargets.has(mapping.target.toLowerCase())) {
        errors.push(mapping.target + " could not be read from " + mapping.source_path + " and has no saved fallback.");
      }
      continue;
    }
    const empty = result.value === null || result.value === undefined ||
      (typeof result.value === "string" && !result.value.trim()) ||
      (Array.isArray(result.value) && result.value.length === 0) ||
      (typeof result.value === "object" && !Array.isArray(result.value) && Object.keys(mappingObject(result.value)).length === 0);
    if (empty) {
      const fallback = setup[mapping.target];
      const hasFallback = fallback !== null && fallback !== undefined &&
        !(typeof fallback === "string" && !fallback.trim()) &&
        !(Array.isArray(fallback) && fallback.length === 0);
      if (!hasFallback && !optionalTargets.has(mapping.target.toLowerCase())) {
        errors.push(mapping.target + " resolved from " + mapping.source_path + ", but the value and saved fallback were empty.");
      }
      continue;
    }
    setup[mapping.target] = result.value;
    resolved.push({ ...mapping, value: result.value });
  }
  return { ok: errors.length === 0, setup, resolved, errors };
}
function firstEventValue(payload: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const result = valueAtEventPath(payload, key);
    if (result.found && ["string", "number"].includes(typeof result.value)) return cleanMappingString(result.value);
  }
  return "";
}

export function canonicalWebhookEvent(payloadValue: unknown, eventId: string, receivedAt: string) {
  const payload = mappingObject(payloadValue);
  const type = firstEventValue(payload, ["event.type", "event", "type", "event_type", "action"]) || "external.request";
  const occurredAtCandidate = firstEventValue(payload, ["event.occurred_at", "occurred_at", "timestamp", "sent_at", "created_at"]);
  const parsedTime = occurredAtCandidate ? new Date(occurredAtCandidate) : null;
  const occurredAt = parsedTime && !Number.isNaN(parsedTime.getTime()) ? parsedTime.toISOString() : receivedAt;
  return {
    id: eventId,
    type: type.slice(0, 160),
    occurred_at: occurredAt,
    received_at: receivedAt,
    data: payload,
  };
}

export function buildWebhookRuntimeEnvelope(params: {
  customerAutomation: any;
  automation: any;
  order: any;
  payload: unknown;
  eventId: string;
  receivedAt: string;
  mappings: EventMappingItem[];
  savedSetup?: Record<string, unknown>;
  setupSchema?: unknown;
  eventSchema?: unknown;
}) {
  const customerAutomation = params.customerAutomation || {};
  const automation = params.automation || {};
  const order = params.order || {};
  const bundleId = cleanMappingString(customerAutomation.bundle_id || order.bundle_id);
  const identity = {
    customer_automation_id: cleanMappingString(customerAutomation.id),
    automation_id: cleanMappingString(customerAutomation.automation_id || automation.id),
    order_id: cleanMappingString(customerAutomation.order_id || order.id),
    buyer_id: cleanMappingString(customerAutomation.buyer_id || order.buyer_id),
    run_id: "assigned_at_dispatch",
    run_key: "assigned_at_dispatch",
    bundle_id: bundleId,
    bundle_order_id: bundleId ? cleanMappingString(customerAutomation.order_id || order.id) : "",
    bundle_run_attempt_id: bundleId ? "assigned_at_dispatch" : "",
    bundle_run_item_id: bundleId ? "assigned_at_dispatch" : "",
  };
  const mapped = applyEventMappings({
    payload: params.payload,
    mappings: params.mappings,
    savedSetup: params.savedSetup,
    optionalTargets: setupFieldDefinitions(params.eventSchema).filter((field) => !field.required).map((field) => field.name),
  });
  // Nexus owns purchase/runtime identity. Keep legacy setup aliases populated so
  // existing workflows continue to work without asking the buyer for IDs.
  const setup = {
    ...mapped.setup,
    customer_id: identity.buyer_id,
    external_customer_id: identity.buyer_id,
    nexus_customer_id: identity.buyer_id,
    customer_automation_id: identity.customer_automation_id,
    automation_id: identity.automation_id,
    order_id: identity.order_id,
    buyer_id: identity.buyer_id,
  };
  const requiredErrors = setupFieldDefinitions(params.setupSchema)
    .filter((field) => field.required)
    .flatMap((field) => {
      const value = setup[field.name];
      const missing = value === null || value === undefined ||
        (typeof value === "string" && !value.trim()) ||
        (Array.isArray(value) && value.length === 0);
      return missing ? [`Required runtime input ${field.label || field.name} is missing from both saved setup and the event mapping.`] : [];
    });
  const mappingErrors = [...mapped.errors, ...requiredErrors];
  const event = canonicalWebhookEvent(params.payload, params.eventId, params.receivedAt);
  const normalizedEventData = { ...mappingObject(event.data) };
  for (const field of setupFieldDefinitions(params.eventSchema)) {
    const value = setup[field.name];
    const useful = value !== null && value !== undefined &&
      !(typeof value === "string" && !value.trim()) &&
      !(Array.isArray(value) && value.length === 0);
    if (useful) normalizedEventData[field.name] = value;
  }
  event.data = normalizedEventData;
  return {
    ok: mappingErrors.length === 0,
    errors: mappingErrors,
    resolved: mapped.resolved,
    envelope: {
      ...identity,
      setup,
      event,
      request: mappingObject(params.payload),
      customer: {
        id: identity.buyer_id,
        email: cleanMappingString(order.buyer_email),
        name: cleanMappingString(order.buyer_name),
        company: cleanMappingString(order.buyer_company),
        order_id: identity.order_id,
      },
      system: {
        ...identity,
        contract_version: "nexus_runtime_v1",
        trigger_type: "webhook",
        trigger_source: "buyer_webhook",
        idempotency_key: `webhook:${identity.customer_automation_id}:${params.eventId}`,
        callback_url: "assigned_at_dispatch",
      },
    },
  };
}