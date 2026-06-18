import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

type OperatorContext = {
  profile: any;
  developer: any | null;
};

function nowIso() {
  return new Date().toISOString();
}

function cleanString(value: unknown) {
  return String(value ?? "").trim();
}

function lower(value: unknown) {
  return cleanString(value).toLowerCase();
}

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function safeJson(value: unknown, fallback: any) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeModuleKey(value: unknown) {
  return cleanString(value || "unknown")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9:_./-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180) || "unknown";
}

function normalizeName(value: unknown, fallback = "value") {
  return cleanString(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || fallback;
}

function inferFieldLabel(name: string) {
  return cleanString(name)
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase())
    .trim() || "Field";
}

function inferSetupFieldType(name: string) {
  const key = lower(name);
  if (key.includes("email")) return "email";
  if (key.includes("website") || key.includes("url") || key.includes("link")) return "url";
  if (key.includes("competitor") || key.includes("areas") || key.includes("notes") || key.includes("requirements")) return "textarea";
  return "text";
}

function makeSetupField(name: string, description = "Auto-generated from the uploaded Make blueprint.") {
  const key = normalizeName(name, "");
  return {
    name: key,
    label: inferFieldLabel(key),
    type: inferSetupFieldType(key),
    required: true,
    placeholder: "",
    description,
    options: [],
  };
}

function displayLabel(value: unknown) {
  return cleanString(value)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitModule(rawModule: string) {
  const raw = cleanString(rawModule);
  const [app = "", ...rest] = raw.split(":");
  const action = rest.join(":");
  return {
    source_app: app || raw,
    source_action: action,
    source_module: raw,
    source_module_key: normalizeModuleKey(raw),
  };
}

function getAuthHeader(req: Request) {
  const authHeader = req.headers.get("Authorization") || "";
  return authHeader.startsWith("Bearer ") ? authHeader : "";
}

async function getUserFromRequest(req: Request) {
  const authHeader = getAuthHeader(req);
  if (!authHeader) return null;

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  });

  const token = authHeader.replace("Bearer ", "").trim();
  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

async function requireOperator(req: Request, adminClient: any): Promise<{ operator: OperatorContext | null; error: string | null }> {
  const user = await getUserFromRequest(req);
  if (!user) return { operator: null, error: "Login required." };

  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("id, role, email, full_name")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError || !profile || !["admin", "developer"].includes(profile.role)) {
    return { operator: null, error: "Admin or developer access required." };
  }

  if (profile.role === "admin") {
    return { operator: { profile, developer: null }, error: null };
  }

  const { data: developer, error: developerError } = await adminClient
    .from("developers")
    .select("id, profile_id, display_name, handle, status")
    .eq("profile_id", user.id)
    .maybeSingle();

  if (developerError || !developer) {
    return { operator: null, error: "Developer profile not found." };
  }

  return { operator: { profile, developer }, error: null };
}

function canAccessAutomation(operator: OperatorContext, product: any) {
  if (operator.profile.role === "admin") return true;
  return Boolean(operator.developer?.id && product?.developer_id === operator.developer.id);
}

async function loadAutomation(adminClient: any, operator: OperatorContext, automationId: string) {
  if (!automationId) return null;

  const { data, error } = await adminClient
    .from("automations")
    .select("*")
    .eq("id", automationId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data || !canAccessAutomation(operator, data)) return null;
  return data;
}

function extractModuleObject(candidate: any) {
  const record = asObject(candidate);
  const rawModule = cleanString(
    record.module ||
      record.name ||
      record.type ||
      record.app ||
      record.appName ||
      record.moduleName ||
      "",
  );

  if (!rawModule) return null;

  const split = splitModule(rawModule);
  const label = cleanString(
    record.metadata?.designer?.name ||
      record.metadata?.name ||
      record.label ||
      record.name ||
      rawModule,
  );

  return {
    id: cleanString(record.id || record.uid || crypto.randomUUID()),
    label: label || rawModule,
    raw_module: rawModule,
    ...split,
    parameters: asObject(record.parameters),
    mapper: asObject(record.mapper),
    metadata: asObject(record.metadata),
    raw: record,
  };
}

function collectMakeModules(blueprint: any) {
  const modules: any[] = [];
  const seen = new Set<any>();

  function walk(value: any, path: string[] = []) {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    const maybeModule = extractModuleObject(value);
    if (maybeModule && (value.module || path[path.length - 1] === "flow" || path[path.length - 1] === "modules")) {
      modules.push(maybeModule);
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, [...path, String(index)]));
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (["metadata", "mapper", "parameters"].includes(key) && maybeModule) continue;
      walk(child, [...path, key]);
    }
  }

  walk(blueprint);

  const unique: any[] = [];
  const uniqueSeen = new Set<string>();
  for (const item of modules) {
    const key = `${item.id}:${item.source_module_key}`;
    if (uniqueSeen.has(key)) continue;
    uniqueSeen.add(key);
    unique.push(item);
  }

  return unique;
}

function groupModules(modules: any[]) {
  const groups = new Map<string, any>();

  for (const module of modules) {
    const key = module.source_module_key;
    if (!groups.has(key)) {
      groups.set(key, {
        source_platform: "make",
        source_app: module.source_app,
        source_action: module.source_action,
        source_module: module.source_module,
        source_module_key: key,
        source_module_label: module.label || module.source_module,
        usage_count: 0,
        node_ids: [],
        node_labels: [],
        sample: module.raw,
      });
    }

    const group = groups.get(key);
    group.usage_count += 1;
    group.node_ids.push(module.id);
    group.node_labels.push(module.label || module.source_module);
  }

  return Array.from(groups.values());
}

function builtInMappingFor(group: any) {
  const moduleKey = lower(group.source_module_key);
  const moduleText = `${group.source_module} ${group.source_app} ${group.source_action}`.toLowerCase();

  if (moduleText.includes("httprequest") || moduleText.includes("http:") || moduleKey.includes("http")) {
    const sample = asObject(group.sample);
    const mapper = asObject(sample.mapper);
    const parameters = asObject(sample.parameters);
    const url = cleanString(mapper.url || mapper.URL || parameters.url || parameters.URL);
    const method = cleanString(mapper.method || parameters.method || "GET").toUpperCase();

    if (!url || (!url.includes("{{") && !/^https:\/\//i.test(url))) return null;

    return {
      id: `builtin:${group.source_module_key}`,
      source_platform: "make",
      source_module_key: group.source_module_key,
      target_strategy: "http_request",
      target_n8n_node_type: "n8n-nodes-base.httpRequest",
      target_operation: "request",
      confidence: "medium",
      status: "global",
      scope: "global",
      http_template: {
        method,
        url,
        auth_type: "none",
      },
      built_in: true,
    };
  }

  if (moduleText.includes("webhook") || moduleText.includes("gateway:")) {
    return {
      id: `builtin:${group.source_module_key}`,
      target_strategy: "code_node",
      target_n8n_node_type: "n8n-nodes-base.code",
      target_operation: "input_passthrough",
      confidence: "high",
      status: "global",
      scope: "global",
      built_in: true,
    };
  }

  if (
    moduleText.includes("router") ||
    moduleText.includes("filter") ||
    moduleText.includes("tools:") ||
    moduleText.includes("json") ||
    moduleText.includes("text") ||
    moduleText.includes("array")
  ) {
    return {
      id: `builtin:${group.source_module_key}`,
      target_strategy: "code_node",
      target_n8n_node_type: "n8n-nodes-base.code",
      target_operation: "logic_passthrough",
      confidence: "medium",
      status: "global",
      scope: "global",
      built_in: true,
    };
  }

  return null;
}

async function loadMappings(adminClient: any, operator: OperatorContext) {
  const { data, error } = await adminClient
    .from("workflow_node_mappings")
    .select("*")
    .eq("source_platform", "make")
    .neq("status", "disabled")
    .order("last_validated_at", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(1500);

  if (error) throw new Error(error.message);

  const developerId = operator.developer?.id || "";
  const profileId = operator.profile.id || "";

  const allowed = (data || []).filter((mapping: any) => {
    if (["validated", "global"].includes(mapping.status)) return true;
    if (mapping.developer_id && mapping.developer_id === developerId) return true;
    if (mapping.created_by && mapping.created_by === profileId) return true;
    if (operator.profile.role === "admin") return true;
    return false;
  });

  return allowed.sort((a: any, b: any) => {
    const score = (mapping: any) => {
      let value = 0;
      if (mapping.created_by === profileId) value += 100;
      if (developerId && mapping.developer_id === developerId) value += 80;
      if (mapping.status === "validated" || mapping.status === "global") value += 40;
      if (mapping.scope === "global") value += 10;
      return value;
    };

    return score(b) - score(a);
  });
}

function chooseMapping(group: any, mappings: any[]) {
  const exact = mappings.find((mapping) => mapping.source_module_key === group.source_module_key);
  return exact || builtInMappingFor(group);
}

function summarizeGroups(groups: any[], mappings: any[]) {
  const resolved: any[] = [];
  const unresolved: any[] = [];

  for (const group of groups) {
    const mapping = chooseMapping(group, mappings);

    if (mapping && mapping.target_strategy !== "manual_support") {
      const mappingStatus = mapping.status || "draft";
      const mappingIsValidated = ["validated", "global"].includes(mappingStatus) || Boolean(mapping.built_in);
      resolved.push({
        ...group,
        mapping_id: mapping.id,
        target_strategy: mapping.target_strategy,
        target_n8n_node_type: mapping.target_n8n_node_type,
        confidence: mapping.confidence || "low",
        mapping_status: mappingStatus,
        mapping_validated: mappingIsValidated,
        needs_validation: mapping.target_strategy === "http_request" && !mappingIsValidated,
        http_template: mapping.target_strategy === "http_request" ? mapping.http_template || null : null,
        built_in: Boolean(mapping.built_in),
      });
    } else {
      unresolved.push({
        ...group,
        suggested_strategy: "http_request",
        reason: "No safe reusable n8n mapping exists yet. Add one HTTP substitute for this module group or request Nexus support.",
      });
    }
  }

  return { resolved, unresolved };
}

function safeBlueprint(value: unknown) {
  const parsed = safeJson(value, null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Upload or paste a Make.com blueprint JSON object.");
  }

  const serialized = JSON.stringify(parsed);
  if (serialized.length > 2000000) {
    throw new Error("Make blueprint is too large for the MVP importer. Keep the file under about 2 MB.");
  }

  return parsed;
}

function headersObjectToArray(value: any) {
  const input = safeJson(value, {});
  if (Array.isArray(input)) {
    return input
      .map((item) => asObject(item))
      .map((item) => ({
        name: cleanString(item.name || item.key),
        value: cleanString(item.value),
      }))
      .filter((item) => item.name);
  }

  return Object.entries(asObject(input))
    .map(([name, value]) => ({
      name,
      value: cleanString(value),
    }))
    .filter((item) => item.name);
}

function containsLiteralSecret(value: unknown) {
  const text = JSON.stringify(value || "");
  return /(sk-[a-z0-9_-]{12,}|api[_-]?key["']?\s*[:=]\s*["'][a-z0-9_-]{16,}|bearer\s+[a-z0-9._-]{16,})/i.test(text);
}

function validatePublicHttpsUrl(rawUrl: string) {
  if (!rawUrl || rawUrl.includes("{{")) return;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("HTTP substitute URL must be a valid HTTPS URL or a template using {{...}} placeholders.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("HTTP substitute URLs must use HTTPS.");
  }

  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)
  ) {
    throw new Error("HTTP substitute URL cannot target localhost or private network addresses.");
  }
}

function normalizeHttpTemplate(body: any) {
  let method = cleanString(body.method || body.http_method || "GET").toUpperCase();
  const url = cleanString(body.url || body.endpoint);
  const authType = cleanString(body.auth_type || "bearer").toLowerCase();
  const credentialProvider = normalizeName(body.credential_provider || body.provider || body.source_app || "custom", "custom");
  const credentialLabel = cleanString(body.credential_label || body.provider_label || displayLabel(credentialProvider) || "API credential");
  const n8nCredentialType = cleanString(body.n8n_credential_type || (authType === "bearer" ? "httpBearerAuth" : ""));
  const headers = headersObjectToArray(body.headers || body.headers_json);
  const query = asObject(safeJson(body.query || body.query_json, {}));
  const bodyJson = safeJson(body.body_json || body.body || {}, {});

  if (method === "GET" && hasPayload(bodyJson)) {
    method = "POST";
  }

  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    throw new Error("HTTP substitute method must be GET, POST, PUT, PATCH, or DELETE.");
  }

  if (!url) throw new Error("HTTP substitute URL is required.");
  validatePublicHttpsUrl(url);

  const template = {
    method,
    url,
    auth_type: authType,
    credential_provider: credentialProvider,
    credential_label: credentialLabel,
    n8n_credential_type: n8nCredentialType,
    headers,
    query,
    body_json: bodyJson,
    response_path: cleanString(body.response_path),
    notes: cleanString(body.notes),
  };

  if (containsLiteralSecret(template)) {
    throw new Error("Do not paste raw API keys into HTTP substitutes. Use credential placeholders or the credential vault.");
  }

  return template;
}

function extractRuntimeSetupKeys(text: string) {
  const setupNames = new Set<string>();
  const source = String(text || "");
  const patterns = [
    /NEXUS_SETUP\.([a-zA-Z0-9_.-]+)/g,
    /NEXUS_SETUP[_:-]([a-zA-Z0-9_.-]+)/gi,
    /\bsetup\.([a-zA-Z][a-zA-Z0-9_.-]*)/g,
    /\bbody\.setup\.([a-zA-Z][a-zA-Z0-9_.-]*)/g,
    /\$json\.setup\.([a-zA-Z][a-zA-Z0-9_.-]*)/g,
    /\$json\.body\.setup\.([a-zA-Z][a-zA-Z0-9_.-]*)/g,
    /json\.setup\.([a-zA-Z][a-zA-Z0-9_.-]*)/g,
    /json\.body\.setup\.([a-zA-Z][a-zA-Z0-9_.-]*)/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const key = normalizeName(match[1], "");
      if (key) setupNames.add(key);
    }
  }

  return [...setupNames].sort();
}

function inferMakeSetupKeysFromText(text: string) {
  const setupNames = new Set<string>();
  const source = String(text || "").toLowerCase();
  const rules = [
    {
      key: "company_website",
      pattern: /\b(company|business|buyer|client|customer)(?:'s)?\s+(?:main\s+)?(?:website|site|url)\b|\bmain\s+website\b/,
    },
    {
      key: "competitor_websites",
      pattern: /\bcompetitor(?:s)?\s+(?:websites?|sites?|urls?)\b|\bcompetitor\s+list\b/,
    },
    {
      key: "focus_areas",
      pattern: /\bfocus\s+areas?\b|\bfocus\s+topics?\b|\bpricing,\s*offers,\s*messaging\b|\bpricing\s+offers\s+messaging\b/,
    },
    {
      key: "market_or_region",
      pattern: /\bmarket\s*(?:or|\/)\s*region\b|\bmarket\s+region\b|\btarget\s+market\b|\blocal\s+market\b/,
    },
    {
      key: "report_title",
      pattern: /\breport\s+title\b|\btitle\s+for\s+(?:the\s+)?report\b/,
    },
  ];

  for (const rule of rules) {
    if (rule.pattern.test(source)) setupNames.add(rule.key);
  }

  return [...setupNames].sort();
}

function mergeGeneratedSetupSchema(existingSchema: unknown, generatedFields: any[]) {
  const schema = asArray(existingSchema)
    .filter((field) => field && typeof field === "object")
    .map((field) => ({ ...field }));
  const names = new Set(schema.map((field) => normalizeName(field.name, "")).filter(Boolean));
  const added: any[] = [];

  for (const field of generatedFields || []) {
    const name = normalizeName(field?.name, "");
    if (!name || names.has(name)) continue;
    const cleanField = {
      ...makeSetupField(name),
      ...field,
      name,
      label: cleanString(field.label || inferFieldLabel(name)),
      type: cleanString(field.type || inferSetupFieldType(name)),
      required: field.required !== false,
    };
    schema.push(cleanField);
    names.add(name);
    added.push(cleanField);
  }

  return { schema, added };
}

function generatedSetupFieldsForMake(blueprint: any, generatedWorkflow: any) {
  const sourceText = `${JSON.stringify(blueprint || {})}\n${JSON.stringify(generatedWorkflow || {})}`;
  const names = new Set<string>([
    ...extractRuntimeSetupKeys(sourceText),
    ...inferMakeSetupKeysFromText(sourceText),
  ]);

  return [...names].sort().map((name) => makeSetupField(
    name,
    "Auto-generated by Nexus from the Make blueprint and workflow setup references. You can edit this before launch.",
  ));
}

function credentialRequirementsFromTemplate(template: any) {
  if (template.auth_type === "none") return [];

  return [{
    provider: template.credential_provider || "custom",
    provider_label: template.credential_label || "API credential",
    credential_type: "api_key",
    credential_key: template.n8n_credential_type || "httpBearerAuth",
    n8n_credential_type: template.n8n_credential_type || "httpBearerAuth",
    required: true,
  }];
}

function n8nNodeId() {
  return crypto.randomUUID();
}

function makeCodeNode(name: string, index: number, code: string) {
  return {
    id: n8nNodeId(),
    name,
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [420 + index * 280, 0],
    parameters: {
      jsCode: code,
    },
  };
}

function makeProxyFetchCode(name: string, template: any, headersJson: Record<string, string>, query: Record<string, any>, bodyJson: any) {
  const proxyUrl = `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/runtime-http-proxy`;
  const payloadTemplate = {
    method: cleanString(template.method || "GET").toUpperCase(),
    url: cleanString(template.url),
    headers: headersJson || {},
    query: query || {},
    body: bodyJson || {},
    auth_type: cleanString(template.auth_type || "bearer"),
    provider: cleanString(template.credential_provider || "custom"),
    provider_label: cleanString(template.credential_label || "API credential"),
    credential_key: cleanString(template.n8n_credential_type || "httpBearerAuth"),
  };

  return [
    "const context = $('Nexus Runtime Context').first().json || {};",
    `const template = ${JSON.stringify(payloadTemplate, null, 2)};`,
    "function valueAt(path) {",
    "  const parts = String(path || '').split('.').filter(Boolean);",
    "  let value = context;",
    "  for (const part of parts) value = value == null ? undefined : value[part];",
    "  return value == null ? '' : value;",
    "}",
    "function renderString(value) {",
    "  return String(value ?? '')",
    "    .replace(/\\{\\{\\s*NEXUS_SETUP\\.([a-zA-Z0-9_.-]+)\\s*\\}\\}/g, (_, key) => String(valueAt(`setup.${key}`)))",
    "    .replace(/\\{\\{\\s*NEXUS_SECRET\\.([a-zA-Z0-9_.-]+)\\s*\\}\\}/g, (_, key) => String(valueAt(`secrets.${key}`)))",
    "    .replace(/\\{\\{\\s*NEXUS_CUSTOMER\\.([a-zA-Z0-9_.-]+)\\s*\\}\\}/g, (_, key) => String(valueAt(`customer.${key}`)))",
    "    .replace(/\\{\\{\\s*NEXUS_ORDER\\.([a-zA-Z0-9_.-]+)\\s*\\}\\}/g, (_, key) => String(valueAt(`order.${key}`)))",
    "    .replace(/\\{\\{\\s*NEXUS_SYSTEM\\.([a-zA-Z0-9_.-]+)\\s*\\}\\}/g, (_, key) => String(valueAt(`system.${key}`)));",
    "}",
    "function renderValue(value) {",
    "  if (Array.isArray(value)) return value.map(renderValue);",
    "  if (value && typeof value === 'object') {",
    "    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, renderValue(inner)]));",
    "  }",
    "  if (typeof value === 'string') return renderString(value);",
    "  return value;",
    "}",
    "function appendQuery(rawUrl, query) {",
    "  const entries = Object.entries(query || {}).filter(([, value]) => value !== '' && value !== null && value !== undefined);",
    "  if (!entries.length) return rawUrl;",
    "  const joiner = rawUrl.includes('?') ? '&' : '?';",
    "  return rawUrl + joiner + entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`).join('&');",
    "}",
    "const nexusHelpers = typeof this !== 'undefined' && this ? this.helpers : null;",
    "async function callNexusProxy(payload) {",
    "  const headers = {",
    "    'content-type': 'application/json',",
    `    'authorization': 'Bearer ${SUPABASE_ANON_KEY}',`,
    `    'apikey': '${SUPABASE_ANON_KEY}',`,
    "    'x-nexus-runtime-secret': context.system?.runtime_secret || ''",
    "  };",
    "  if (typeof fetch === 'function') {",
    "    const response = await fetch(" + JSON.stringify(proxyUrl) + ", { method: 'POST', headers, body: JSON.stringify(payload) });",
    "    const text = await response.text();",
    "    let data;",
    "    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }",
    "    if (!response.ok) throw new Error(data.message || data.error || data.raw || `Nexus proxy request failed with status ${response.status}`);",
    "    return data;",
    "  }",
    "  if (nexusHelpers?.request) {",
    "    return await nexusHelpers.request({ method: 'POST', uri: " + JSON.stringify(proxyUrl) + ", headers, body: payload, json: true });",
    "  }",
    "  if (nexusHelpers?.httpRequest) {",
    "    return await nexusHelpers.httpRequest({ method: 'POST', url: " + JSON.stringify(proxyUrl) + ", headers, body: payload, json: true });",
    "  }",
    "  throw new Error('This n8n Code node cannot make HTTP requests because fetch and n8n HTTP helpers are unavailable. Update n8n or run this product through the Nexus Make proxy runner.');",
    "}",
    "const query = renderValue(template.query || {});",
    "const url = appendQuery(renderString(template.url), query);",
    "const data = await callNexusProxy({",
    "    automation_id: context.automation_id || context.system?.automation_id || '',",
    `    node_name: ${JSON.stringify(name)},`,
    "    credential_key: template.credential_key,",
    "    provider: template.provider,",
    "    provider_label: template.provider_label,",
    "    method: template.method,",
    "    url,",
    "    headers: renderValue(template.headers || {}),",
    "    body: renderValue(template.body || {}),",
    "    auth_type: template.auth_type",
    "});",
    "return [{ json: data.result ?? data }];",
  ].join("\n");
}

function runtimeContextExpression(source: string, key: string) {
  const sourceKey = cleanString(source).toLowerCase();
  const cleanKey = cleanString(key);
  const bucket =
    sourceKey === "secret" || sourceKey === "secrets" || sourceKey === "credential" || sourceKey === "credentials"
      ? "secrets"
      : sourceKey === "customer"
        ? "customer"
        : sourceKey === "order"
          ? "order"
          : sourceKey === "system"
            ? "system"
            : "setup";

  return `{{ $('Nexus Runtime Context').first().json.${bucket}.${cleanKey} }}`;
}

function renderNexusRuntimeTemplates(value: any, prefixExpression = true): any {
  if (Array.isArray(value)) return value.map((item) => renderNexusRuntimeTemplates(item, prefixExpression));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, renderNexusRuntimeTemplates(inner, prefixExpression)]));
  }
  if (typeof value !== "string") return value;

  const rendered = value.replace(
    /\{\{\s*NEXUS_(SETUP|SECRET|SECRETS|CUSTOMER|ORDER|SYSTEM)\.([a-zA-Z0-9_.-]+)\s*\}\}/g,
    (_match, source, key) => runtimeContextExpression(source, key),
  );

  return prefixExpression && rendered.includes("$('Nexus Runtime Context').first().json") && !rendered.trim().startsWith("=")
    ? `=${rendered}`
    : rendered;
}

function objectToParameterRows(value: Record<string, any>) {
  return Object.entries(value || {})
    .filter(([key]) => cleanString(key))
    .map(([name, inner]) => ({
      name,
      value: renderNexusRuntimeTemplates(inner),
    }));
}

function hasPayload(value: any) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return value !== undefined && value !== null && value !== "";
}

function stripContentTypeHeader(headers: Record<string, any>) {
  return Object.entries(headers || {}).reduce((accumulator: Record<string, any>, [key, value]) => {
    if (cleanString(key).toLowerCase() === "content-type") return accumulator;
    accumulator[key] = value;
    return accumulator;
  }, {});
}

function templateBody(template: Record<string, any>) {
  if (template.body_json !== undefined && template.body_json !== null) return template.body_json;
  if (template.body !== undefined && template.body !== null) return template.body;
  if (template.jsonBody !== undefined && template.jsonBody !== null) return safeJson(template.jsonBody, {});
  if (template.bodyParametersJson !== undefined && template.bodyParametersJson !== null) {
    return safeJson(template.bodyParametersJson, {});
  }
  return {};
}

function makeLegacyHttpParameters(input: {
  method: string;
  url: string;
  authType: string;
  credentialKey: string;
  headers: Record<string, any>;
  query: Record<string, any>;
  body: any;
}) {
  const body = renderNexusRuntimeTemplates(input.body || {}, false);
  const methodFromInput = cleanString(input.method || "GET").toUpperCase();
  const method = methodFromInput === "GET" && hasPayload(body) ? "POST" : methodFromInput;
  const parameters: Record<string, any> = {
    authentication: input.credentialKey ? "genericCredentialType" : "none",
    requestMethod: method,
    url: renderNexusRuntimeTemplates(input.url),
    responseFormat: "json",
    jsonParameters: true,
    options: {},
  };

  if (input.credentialKey) {
    parameters.genericAuthType = input.credentialKey;
  }

  const headers = stripContentTypeHeader(renderNexusRuntimeTemplates(input.headers || {}, false));
  if (Object.keys(headers).length) {
    parameters.headerParametersJson = JSON.stringify(headers, null, 2);
  }

  const query = renderNexusRuntimeTemplates(input.query || {}, false);
  if (Object.keys(query).length) {
    parameters.queryParametersJson = JSON.stringify(query, null, 2);
  }

  if (method !== "GET" && hasPayload(body)) {
    parameters.bodyParametersJson = JSON.stringify(body, null, 2);
    parameters.options.bodyContentType = "raw";
    parameters.options.bodyContentCustomMimeType = "application/json";
  }

  return parameters;
}

function makeHttpNode(name: string, index: number, mapping: any) {
  const template = asObject(mapping.http_template);
  let method = cleanString(template.method || "GET").toUpperCase();
  const headers = headersObjectToArray(template.headers);
  const query = asObject(template.query);
  const bodyJson = templateBody(template);
  if (method === "GET" && hasPayload(bodyJson)) method = "POST";
  const n8nCredentialType = cleanString(template.n8n_credential_type || "httpBearerAuth");
  const authType = cleanString(template.auth_type || "bearer").toLowerCase();
  const credentialKey = authType === "none" ? "" : n8nCredentialType;

  const headersJson = headers.reduce((accumulator: Record<string, string>, item: any) => {
    if (item.name) accumulator[item.name] = cleanString(item.value);
    return accumulator;
  }, {});

  const node: Record<string, any> = {
    id: n8nNodeId(),
    name,
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 2,
    position: [420 + index * 280, 0],
    parameters: {
      ...makeLegacyHttpParameters({
        method,
        url: cleanString(template.url),
        authType,
        credentialKey,
        headers: headersJson,
        query,
        body: bodyJson,
      }),
      nexusProxyTemplate: {
        method: cleanString(template.method || "GET").toUpperCase(),
        url: cleanString(template.url),
        headers: headersJson || {},
        query: query || {},
        body: bodyJson || {},
        body_json: bodyJson || {},
        auth_type: cleanString(template.auth_type || "bearer"),
        provider: cleanString(template.credential_provider || "custom"),
        provider_label: cleanString(template.credential_label || "API credential"),
        credential_key: credentialKey,
      },
      ...(credentialKey
        ? {
            nexusCredential: {
              uses_nexus_proxy: false,
              provider: cleanString(template.credential_provider || "custom"),
              provider_label: cleanString(template.credential_label || "API credential"),
              credential_key: credentialKey,
              n8n_credential_type: credentialKey,
              url: cleanString(template.url),
              allowed_host: (() => {
                try {
                  return new URL(cleanString(template.url)).hostname;
                } catch {
                  return "";
                }
              })(),
            },
          }
        : {}),
    },
  };

  return node;
}

function buildN8nWorkflow(product: any, groups: any[], mappings: any[]) {
  const nodes: any[] = [];
  const connections: Record<string, any> = {};
  const workflowName = `${cleanString(product?.title || "Make import")} - converted from Make`;

  const inputNode = {
    id: n8nNodeId(),
    name: "NEXUS_INPUT",
    type: "n8n-nodes-base.webhook",
    typeVersion: 2,
    position: [0, 0],
    parameters: {
      httpMethod: "POST",
      path: `nexus-make-${crypto.randomUUID().slice(0, 8)}`,
      responseMode: "lastNode",
      options: {},
    },
  };
  nodes.push(inputNode);

  let previous = inputNode.name;

  groups.forEach((group, index) => {
    const mapping = chooseMapping(group, mappings);
    if (!mapping || mapping.target_strategy === "manual_support") return;

    const safeName = `${String(index + 1).padStart(2, "0")} ${displayLabel(group.source_module_label || group.source_module).slice(0, 60)}`;
    let node: any;

    if (mapping.target_strategy === "http_request") {
      node = makeHttpNode(safeName, index + 1, mapping);
    } else {
      node = makeCodeNode(
        safeName,
        index + 1,
        [
          `// Converted from Make module: ${group.source_module}`,
          "// This logic node preserves workflow order. Replace with exact n8n logic if the imported Make module used custom filters/routes.",
          "return items;",
        ].join("\n"),
      );
    }

    nodes.push(node);
    connections[previous] = { main: [[{ node: node.name, type: "main", index: 0 }]] };
    previous = node.name;
  });

  const outputNode = makeCodeNode(
    "NEXUS_FINAL_OUTPUT",
    groups.length + 2,
    [
      "const first = items[0]?.json || {};",
      "return [{",
      "  json: {",
      "    status: 'success',",
      "    output_type: 'report',",
      "    title: first.title || 'Automation output',",
      "    summary: first.summary || 'Converted Make workflow completed successfully.',",
      "    content_html: first.content_html || '<h1>Automation output</h1><p>The converted Make workflow ran successfully.</p>',",
      "    raw_result: first",
      "  }",
      "}];",
    ].join("\n"),
  );
  nodes.push(outputNode);
  connections[previous] = { main: [[{ node: outputNode.name, type: "main", index: 0 }]] };

  return {
    name: workflowName,
    nodes,
    connections,
    settings: {
      executionOrder: "v1",
    },
  };
}

function makeSummary(modules: any[], groups: any[], resolved: any[], unresolved: any[]) {
  return {
    module_count: modules.length,
    group_count: groups.length,
    resolved_count: resolved.length,
    unresolved_count: unresolved.length,
    confidence_percent: groups.length ? Math.round((resolved.length / groups.length) * 100) : 0,
  };
}

async function upsertImportSession(adminClient: any, operator: OperatorContext, product: any, blueprint: any, result: any) {
  const patch = {
    automation_id: product?.id || null,
    developer_id: product?.developer_id || operator.developer?.id || null,
    source_platform: "make",
    source_blueprint: blueprint,
    module_summary: result.summary,
    resolved_groups: result.resolved,
    unresolved_groups: result.unresolved,
    generated_workflow_json: result.generated_workflow_json || null,
    status: result.status,
    created_by: operator.profile.id,
    updated_by: operator.profile.id,
    updated_at: nowIso(),
  };

  const existingId = cleanString(product?.make_import_session_id);

  if (existingId) {
    const { data, error } = await adminClient
      .from("workflow_import_sessions")
      .update(patch)
      .eq("id", existingId)
      .select()
      .maybeSingle();

    if (!error && data) return data;
  }

  const { data, error } = await adminClient
    .from("workflow_import_sessions")
    .insert({
      ...patch,
      created_at: nowIso(),
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

async function updateAutomationAfterScan(adminClient: any, product: any, session: any, result: any, blueprint: any) {
  if (!product?.id) return;
  const generatedSetupFields = generatedSetupFieldsForMake(blueprint, result.generated_workflow_json);
  const mergedSetup = mergeGeneratedSetupSchema(product.setup_schema, generatedSetupFields);

  const patch: Record<string, any> = {
    workflow_source_platform: "make",
    make_blueprint: blueprint,
    make_import_status: result.status,
    make_import_session_id: session.id,
    make_conversion_summary: result.summary,
    make_unresolved_modules: result.unresolved,
    updated_at: nowIso(),
  };

  if (mergedSetup.added.length) {
    patch.setup_schema = mergedSetup.schema;
    patch.n8n_last_import_result = {
      ...(asObject(product.n8n_last_import_result)),
      generated_setup_fields: mergedSetup.added,
      generated_setup_source: "make_blueprint",
    };
  }

  if (result.generated_workflow_json && result.status === "converted") {
    patch.n8n_workflow_json = result.generated_workflow_json;
    patch.runtime_type = "n8n_managed";
    patch.n8n_import_status = "not_imported";
    patch.n8n_import_error = null;
    patch.n8n_last_test_status = "not_tested";
    patch.n8n_last_test_error = null;
  }

  const { error } = await adminClient
    .from("automations")
    .update(patch)
    .eq("id", product.id);

  if (error) throw new Error(error.message);

  return {
    setup_schema: patch.setup_schema || product.setup_schema || [],
    generated_setup_fields: mergedSetup.added,
  };
}

async function runScan(adminClient: any, operator: OperatorContext, body: any) {
  const automationId = cleanString(body.automation_id);
  const product = await loadAutomation(adminClient, operator, automationId);
  if (automationId && !product) throw new Error("Product not found or access denied.");

  const blueprint = safeBlueprint(body.blueprint || product?.make_blueprint);
  const modules = collectMakeModules(blueprint);
  const groups = groupModules(modules);
  const mappings = await loadMappings(adminClient, operator);
  const { resolved, unresolved } = summarizeGroups(groups, mappings);
  const status = unresolved.length ? "needs_substitutes" : "converted";
  const generatedWorkflow = status === "converted" && product
    ? buildN8nWorkflow(product, groups, mappings)
    : null;
  const summary = makeSummary(modules, groups, resolved, unresolved);
  const result = {
    status,
    summary,
    modules,
    groups,
    resolved,
    unresolved,
    generated_workflow_json: generatedWorkflow,
  };

  let session = null;
  let productPatchResult: any = null;
  if (product?.id) {
    session = await upsertImportSession(adminClient, operator, product, blueprint, result);
    productPatchResult = await updateAutomationAfterScan(adminClient, product, session, result, blueprint);
  }

  return {
    session,
    ...result,
    setup_schema: productPatchResult?.setup_schema || product?.setup_schema || [],
    generated_setup_fields: productPatchResult?.generated_setup_fields || [],
    message: unresolved.length
      ? "Make blueprint scanned. Add HTTP substitutes or request Nexus support for unresolved module groups."
      : "Make blueprint converted into n8n workflow JSON. Import and run the technical test next.",
  };
}

async function loadSession(adminClient: any, operator: OperatorContext, sessionId: string) {
  const { data, error } = await adminClient
    .from("workflow_import_sessions")
    .select("*, automations(*)")
    .eq("id", sessionId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("Import session not found.");
  if (data.automation_id && !canAccessAutomation(operator, data.automations)) {
    throw new Error("You cannot access this import session.");
  }
  return data;
}

async function getImportSession(adminClient: any, operator: OperatorContext, body: any) {
  const automationId = cleanString(body.automation_id);
  const product = automationId ? await loadAutomation(adminClient, operator, automationId) : null;
  const sessionId = cleanString(body.session_id || product?.make_import_session_id);

  if (!sessionId) {
    return {
      session: null,
      status: product?.make_import_status || "not_started",
      summary: product?.make_conversion_summary || {},
      resolved: [],
      unresolved: product?.make_unresolved_modules || [],
      message: "No Make import session is linked to this product yet.",
    };
  }

  const session = await loadSession(adminClient, operator, sessionId);
  const unresolved = asArray(session.unresolved_groups);

  return {
    session: { id: session.id },
    status: session.status,
    summary: session.module_summary || {},
    resolved: asArray(session.resolved_groups),
    unresolved,
    generated_workflow_json: session.generated_workflow_json || null,
    message: unresolved.length
      ? "Make blueprint scanned. Add or edit HTTP substitutes for unresolved module groups."
      : "Make blueprint converted. Draft HTTP substitutes remain editable until the workflow test passes.",
  };
}

async function saveHttpSubstitute(adminClient: any, operator: OperatorContext, body: any) {
  const session = await loadSession(adminClient, operator, cleanString(body.session_id));
  const sourceModuleKey = normalizeModuleKey(body.source_module_key);
  const unresolved = asArray(session.unresolved_groups);
  const group = unresolved.find((item) => item.source_module_key === sourceModuleKey)
    || asArray(session.resolved_groups).find((item) => item.source_module_key === sourceModuleKey);

  if (!group) throw new Error("Unsupported Make module group was not found in this import session.");

  const httpTemplate = normalizeHttpTemplate({
    ...body.http_template,
    source_app: group.source_app,
  });
  const credentialRequirements = credentialRequirementsFromTemplate(httpTemplate);
  const developerId = operator.profile.role === "developer" ? operator.developer?.id : session.developer_id;
  const scope = operator.profile.role === "admin" ? "admin" : "developer";

  const mappingPatch = {
    source_platform: "make",
    source_app: group.source_app,
    source_module: group.source_module,
    source_action: group.source_action,
    source_module_key: sourceModuleKey,
    target_strategy: "http_request",
    target_n8n_node_type: "n8n-nodes-base.httpRequest",
    target_operation: "request",
    http_template: httpTemplate,
    credential_requirements: credentialRequirements,
    confidence: "medium",
    status: "draft",
    scope,
    developer_id: developerId || null,
    created_by: operator.profile.id,
    updated_by: operator.profile.id,
    notes: cleanString(body.notes),
    updated_at: nowIso(),
  };

  const { data: existing } = await adminClient
    .from("workflow_node_mappings")
    .select("*")
    .eq("source_platform", "make")
    .eq("source_module_key", sourceModuleKey)
    .eq("created_by", operator.profile.id)
    .neq("status", "disabled")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let mapping;
  if (existing?.id) {
    const { data, error } = await adminClient
      .from("workflow_node_mappings")
      .update(mappingPatch)
      .eq("id", existing.id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    mapping = data;
  } else {
    const { data, error } = await adminClient
      .from("workflow_node_mappings")
      .insert({
        ...mappingPatch,
        created_at: nowIso(),
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    mapping = data;
  }

  const { error: supportUpdateError } = await adminClient
    .from("workflow_import_support_requests")
    .update({
      status: "resolved",
      resolution_mapping_id: mapping.id,
      updated_by: operator.profile.id,
      updated_at: nowIso(),
    })
    .eq("import_session_id", session.id)
    .eq("source_module_key", sourceModuleKey)
    .in("status", ["open", "in_review"]);

  if (supportUpdateError) {
    console.warn("Could not resolve Make import support request:", supportUpdateError.message);
  }

  const product = session.automations;
  const rerun = await runScan(adminClient, operator, {
    automation_id: product?.id,
    blueprint: session.source_blueprint,
  });

  return {
    mapping,
    ...rerun,
    message: rerun.unresolved?.length
      ? "HTTP substitute saved. Resolve the remaining Make module groups before importing."
      : "HTTP substitute saved and Make blueprint converted. Import and run the technical test next.",
  };
}

async function requestSupport(adminClient: any, operator: OperatorContext, body: any) {
  const session = await loadSession(adminClient, operator, cleanString(body.session_id));
  const sourceModuleKey = normalizeModuleKey(body.source_module_key);
  const group = asArray(session.unresolved_groups).find((item) => item.source_module_key === sourceModuleKey);
  if (!group) throw new Error("Unsupported Make module group was not found in this import session.");

  const row = {
    import_session_id: session.id,
    automation_id: session.automation_id,
    developer_id: session.developer_id,
    source_platform: "make",
    source_module_key: sourceModuleKey,
    source_app: group.source_app,
    source_module: group.source_module,
    source_action: group.source_action,
    source_module_label: group.source_module_label,
    usage_count: group.usage_count || 1,
    dev_notes: cleanString(body.notes),
    status: "open",
    created_by: operator.profile.id,
    updated_by: operator.profile.id,
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  const { data, error } = await adminClient
    .from("workflow_import_support_requests")
    .insert(row)
    .select()
    .single();

  if (error) throw new Error(error.message);

  await adminClient
    .from("workflow_import_sessions")
    .update({
      status: "support_requested",
      updated_by: operator.profile.id,
      updated_at: nowIso(),
    })
    .eq("id", session.id);

  await adminClient
    .from("automations")
    .update({
      make_import_status: "support_requested",
      updated_at: nowIso(),
    })
    .eq("id", session.automation_id);

  try {
    await adminClient.from("admin_notifications").insert({
      notification_type: "make_import_support",
      title: "Make import support requested",
      message: `${session.automations?.title || "A product"} needs a Make module mapping for ${group.source_module_label || group.source_module}.`,
      status: "unread",
      metadata: {
        support_request_id: data.id,
        import_session_id: session.id,
        automation_id: session.automation_id,
        source_module_key: sourceModuleKey,
      },
      created_at: nowIso(),
    });
  } catch (error) {
    console.warn("Could not create Make import notification:", error);
  }

  return {
    request: data,
    message: "Nexus support request sent. Admin can create the reusable mapping from the request.",
  };
}

async function validateSuccessfulMappings(adminClient: any, operator: OperatorContext, body: any) {
  const product = await loadAutomation(adminClient, operator, cleanString(body.automation_id));
  if (!product) throw new Error("Product not found or access denied.");

  const passed = ["passed", "passed_with_expected_test_callback_error"].includes(lower(product.n8n_last_test_status));
  if (!passed) {
    return {
      promoted_count: 0,
      message: "Workflow test has not passed yet, so Make HTTP substitutes were not made reusable.",
    };
  }

  const sessionId = cleanString(product.make_import_session_id);
  if (!sessionId) {
    return {
      promoted_count: 0,
      message: "No Make import session is linked to this product.",
    };
  }

  const session = await loadSession(adminClient, operator, sessionId);
  const mappingIds = asArray(session.resolved_groups)
    .map((group) => cleanString(group.mapping_id))
    .filter((id) => id && !id.startsWith("builtin:"));

  if (!mappingIds.length) {
    return {
      promoted_count: 0,
      message: "No reusable HTTP substitutes needed validation for this Make import.",
    };
  }

  const { data, error } = await adminClient
    .from("workflow_node_mappings")
    .update({
      status: "validated",
      scope: "global",
      confidence: "high",
      validated_by_automation_id: product.id,
      last_validated_at: nowIso(),
      updated_by: operator.profile.id,
      updated_at: nowIso(),
    })
    .in("id", mappingIds)
    .select("id");

  if (error) throw new Error(error.message);

  return {
    promoted_count: data?.length || 0,
    message: `${data?.length || 0} Make substitute mapping${data?.length === 1 ? "" : "s"} validated for reuse.`,
  };
}

async function listSupportRequests(adminClient: any, operator: OperatorContext, body: any) {
  if (operator.profile.role !== "admin") throw new Error("Admin access required.");

  let query = adminClient
    .from("workflow_import_support_requests")
    .select("*, automations(id, title, slug), developers(id, display_name, handle)")
    .order("created_at", { ascending: false })
    .limit(200);

  if (body.status) {
    query = query.eq("status", cleanString(body.status));
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return {
    requests: data || [],
  };
}

async function listMappings(adminClient: any, operator: OperatorContext) {
  if (operator.profile.role !== "admin") throw new Error("Admin access required.");

  const { data, error } = await adminClient
    .from("workflow_node_mappings")
    .select("*, developers(id, display_name, handle)")
    .eq("source_platform", "make")
    .order("updated_at", { ascending: false })
    .limit(500);

  if (error) throw new Error(error.message);
  return { mappings: data || [] };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: corsHeaders,
    });
  }

  if (req.method === "GET") {
    return jsonResponse({
      ok: true,
      message: "make-import-assistant is alive.",
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed.", 405);
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
      return errorResponse("Missing Supabase function secrets.", 500);
    }

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { operator, error: authError } = await requireOperator(req, adminClient);

    if (authError || !operator) {
      return errorResponse(authError || "Access required.", 401);
    }

    const body = await req.json().catch(() => ({}));
    const action = cleanString(body.action || "scan");

    let result;
    if (action === "scan") {
      result = await runScan(adminClient, operator, body);
    } else if (action === "get_session") {
      result = await getImportSession(adminClient, operator, body);
    } else if (action === "save_http_substitute") {
      result = await saveHttpSubstitute(adminClient, operator, body);
    } else if (action === "request_support") {
      result = await requestSupport(adminClient, operator, body);
    } else if (action === "validate_successful_mappings") {
      result = await validateSuccessfulMappings(adminClient, operator, body);
    } else if (action === "list_support_requests") {
      result = await listSupportRequests(adminClient, operator, body);
    } else if (action === "list_mappings") {
      result = await listMappings(adminClient, operator);
    } else {
      return errorResponse("Unknown Make import assistant action.", 400);
    }

    return jsonResponse({
      ok: true,
      ...result,
    });
  } catch (error) {
    console.error(error);

    const message = error instanceof Error ? error.message : "Could not run Make import assistant.";
    const schemaMissing = /workflow_node_mappings|workflow_import_sessions|workflow_import_support_requests|schema cache|relation .* does not exist|could not find/i.test(message);

    return errorResponse(
      schemaMissing
        ? `${message} Run supabase/make_import_assistant_install_or_patch.sql in the Supabase SQL editor, then redeploy make-import-assistant.`
        : message,
      schemaMissing ? 500 : 400,
    );
  }
});
