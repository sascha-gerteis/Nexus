import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const N8N_BASE_URL = (Deno.env.get("N8N_BASE_URL") || "").replace(/\/+$/, "");
const N8N_API_KEY = Deno.env.get("N8N_API_KEY") || "";
const NEXUS_RUNTIME_SECRET = Deno.env.get("NEXUS_RUNTIME_SECRET") || "";
const REPAIR_TOKEN = Deno.env.get("NEXUS_OUTPUT_CONTRACT_REPAIR_TOKEN") || "";
const CONFIRMATION = "UPGRADE_BUNDLE_OUTPUT_CONTRACT_V1";
const JSON_CONTRACT_MARKER = "NEXUS_BUNDLE_IDENTITY_V1";
const NODE_RESTORE_CONFIRMATION = "RESTORE_AI_SOCIAL_CONNECTED_OUTPUT_V1";
const INCIDENT_TECHNICAL_TEST_AUTOMATION_ID = "fdacfdea-6a8f-4406-ab7e-2c54cc4c06d0";
const INCIDENT_TECHNICAL_TEST_RECONCILIATION = "RECONCILE_AI_SOCIAL_TECHNICAL_TEST_V1";

const clean = (value: unknown) => String(value ?? "").trim();
const lower = (value: unknown) => clean(value).toLowerCase();
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const array = (value: unknown): any[] => Array.isArray(value) ? value : [];
const unique = (value: unknown) => [...new Set(array(value).map(clean).filter(Boolean))];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function stableValue(value: any): any {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  return value;
}
const stableJson = (value: any) => JSON.stringify(stableValue(value));

function secretMatches(received: string, expected: string) {
  if (!received || !expected || received.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < received.length; index += 1) difference |= received.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}

async function requireOperator(req: Request, adminClient: any) {
  if (secretMatches(clean(req.headers.get("x-nexus-repair-token")), REPAIR_TOKEN)) return true;
  if (secretMatches(clean(req.headers.get("x-nexus-runtime-secret")), NEXUS_RUNTIME_SECRET)) return true;
  const authorization = req.headers.get("Authorization") || "";
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authorization } } });
  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data?.user) return false;
  const { data: profile } = await adminClient.from("profiles").select("role").eq("id", data.user.id).maybeSingle();
  return ["admin", "admin_staff"].includes(lower(profile?.role));
}

async function n8n(path: string, options: RequestInit = {}) {
  const response = await fetch(`${N8N_BASE_URL}${path}`, {
    ...options,
    headers: { accept: "application/json", "content-type": "application/json", "X-N8N-API-KEY": N8N_API_KEY, ...(options.headers || {}) },
  });
  const text = await response.text();
  let data: any = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`n8n API failed (${response.status}): ${clean(data?.message || data?.error || data?.raw).slice(0, 400)}`);
  return object(data?.data || data);
}

async function listN8nWorkflows() {
  const workflows: any[] = [];
  let cursor = "";
  for (let page = 0; page < 20; page += 1) {
    const query = new URLSearchParams({ limit: "250" });
    if (cursor) query.set("cursor", cursor);
    const response = await fetch(`${N8N_BASE_URL}/api/v1/workflows?${query.toString()}`, {
      headers: { accept: "application/json", "X-N8N-API-KEY": N8N_API_KEY },
    });
    const text = await response.text();
    let payload: any = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { raw: text }; }
    if (!response.ok) throw new Error(`n8n API failed (${response.status}): ${clean(payload?.message || payload?.error || payload?.raw).slice(0, 400)}`);
    workflows.push(...array(payload?.data || payload?.workflows || payload));
    cursor = clean(payload?.nextCursor || payload?.next_cursor);
    if (!cursor) break;
  }
  return workflows;
}

const getWorkflow = (id: string) => n8n(`/api/v1/workflows/${encodeURIComponent(id)}`);
const workflowPayload = (workflow: any) => ({
  name: clean(workflow?.name || "Nexus Workflow"),
  nodes: array(workflow?.nodes),
  connections: object(workflow?.connections),
  settings: object(workflow?.settings),
  staticData: object(workflow?.staticData),
});
function workflowWritePayload(workflow: any) {
  const payload = clone(workflowPayload(workflow));
  const settings = object(payload.settings);
  const binaryMode = clean(settings.binaryMode);
  if (binaryMode && !["default", "separate", "combined"].includes(binaryMode)) throw new Error(`n8n public API cannot preserve unsupported binaryMode ${binaryMode}; write refused.`);
  delete settings.binaryMode;
  payload.settings = settings;
  return payload;
}
const putWorkflow = (id: string, workflow: any) => n8n(`/api/v1/workflows/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(workflowWritePayload(workflow)) });
const activateWorkflow = (id: string) => n8n(`/api/v1/workflows/${encodeURIComponent(id)}/activate`, { method: "POST", body: "{}" });
const deactivateWorkflow = (id: string) => n8n(`/api/v1/workflows/${encodeURIComponent(id)}/deactivate`, { method: "POST", body: "{}" });

function submitNode(workflow: any) {
  return array(workflow?.nodes).find((node: any) => clean(node?.name) === "Nexus Submit Output") || null;
}
function contextNode(workflow: any) {
  return array(workflow?.nodes).find((node: any) => clean(node?.name) === "Nexus Runtime Context") || null;
}
function bodyRows(node: any) {
  return array(node?.parameters?.bodyParameters?.parameters);
}
const rowName = (row: any) => lower(row?.name);
const runIdExpression = '={{ $("Nexus Runtime Context").first().json.system.run_id || "" }}';
const runKeyExpression = '={{ $("Nexus Runtime Context").first().json.system.run_key || "" }}';

function jsonBodyValue(workflow: any) {
  return clean(submitNode(workflow)?.parameters?.jsonBody);
}

function isN8nJsonExpression(value: string) {
  const body = clean(value);
  return body.startsWith("={{") && body.endsWith("}}");
}

function wrapJsonBodyWithIdentity(value: string) {
  const original = clean(value);
  if (!isN8nJsonExpression(original)) throw new Error("JSON body is not a standard n8n expression.");
  const inner = original.slice(3, -2).trim();
  if (!inner) throw new Error("JSON body expression is empty.");
  return `={{ (() => {
  /* ${JSON_CONTRACT_MARKER} */
  const nexusOriginalPayload = (${inner});
  const nexusSystem = $("Nexus Runtime Context").first().json.system || {};
  const nexusIdentity = {
    run_id: nexusSystem.run_id || "",
    run_key: nexusSystem.run_key || ""
  };
  if (typeof nexusOriginalPayload === "string") {
    return JSON.stringify({ ...JSON.parse(nexusOriginalPayload), ...nexusIdentity });
  }
  return { ...(nexusOriginalPayload || {}), ...nexusIdentity };
})() }}`;
}

function contract(workflow: any) {
  const submit = submitNode(workflow);
  const context = contextNode(workflow);
  const rows = bodyRows(submit);
  const names = new Set(rows.map(rowName));
  const runId = rows.find((row: any) => rowName(row) === "run_id");
  const runKey = rows.find((row: any) => rowName(row) === "run_key");
  const keypairCurrent = clean(runId?.value) === runIdExpression && clean(runKey?.value) === runKeyExpression;
  const parameterText = JSON.stringify(submit?.parameters || {});
  const jsonBody = clean(submit?.parameters?.jsonBody);
  const jsonCurrent = jsonBody.includes(JSON_CONTRACT_MARKER) && jsonBody.includes("nexusSystem.run_id") && jsonBody.includes("nexusSystem.run_key");
  const keypairEligible = Boolean(submit && context && names.has("customer_automation_id") && Array.isArray(submit?.parameters?.bodyParameters?.parameters));
  const jsonEligible = Boolean(submit && context && clean(submit?.parameters?.specifyBody) === "json" && isN8nJsonExpression(jsonBody) && parameterText.includes("customer_automation_id") && !jsonCurrent);
  return {
    json_body_is_expression: isN8nJsonExpression(jsonBody),
    json_body_uses_json_stringify: jsonBody.includes("JSON.stringify"),
    json_body_length: jsonBody.length,
    node_type: clean(submit?.type),
    node_version: submit?.typeVersion || null,
    body_mode: clean(submit?.parameters?.specifyBody),
    body_content_type: clean(submit?.parameters?.bodyContentType),
    has_keypair_body: Array.isArray(submit?.parameters?.bodyParameters?.parameters),
    has_json_body: Boolean(jsonBody),
    parameters_mention_customer_automation_id: parameterText.includes("customer_automation_id"),
    parameters_mention_run_id: parameterText.includes("run_id"),
    parameters_mention_run_key: parameterText.includes("run_key"),
    has_submit_output: Boolean(submit),
    has_runtime_context: Boolean(context),
    has_run_id: Boolean(runId) || jsonCurrent,
    has_run_key: Boolean(runKey) || jsonCurrent,
    contract_current: keypairCurrent || jsonCurrent,
    repair_mode: keypairEligible ? "keypair" : jsonEligible ? "json_expression" : "manual_review",
    repair_eligible: keypairEligible || jsonEligible,
  };
}

function workflowStructure(workflow: any) {
  const nodes = array(workflow?.nodes);
  const connections = object(workflow?.connections);
  const serialized = JSON.stringify(workflowPayload(workflow));
  const webhookPaths = nodes
    .filter((node: any) => lower(node?.type).includes("webhook"))
    .map((node: any) => clean(node?.parameters?.path))
    .filter(Boolean);

  return {
    node_count: nodes.length,
    connection_source_count: Object.keys(connections).length,
    settings_keys: Object.keys(object(workflow?.settings)).sort(),
    webhook_paths: [...new Set(webhookPaths)],
    runtime_context_reference_count: (serialized.match(/Nexus Runtime Context/g) || []).length,
    node_signatures: nodes.map((node: any) => ({
      name: clean(node?.name),
      type: clean(node?.type),
      type_version: node?.typeVersion ?? null,
    })),
  };
}

function withoutIdentity(workflow: any) {
  const copy = clone(workflowPayload(workflow));
  const submit = submitNode(copy);
  if (!submit) return copy;
  if (Array.isArray(submit?.parameters?.bodyParameters?.parameters)) {
    submit.parameters.bodyParameters.parameters = bodyRows(submit).filter((row: any) => !["run_id", "run_key"].includes(rowName(row)));
  } else if (clean(submit?.parameters?.jsonBody)) {
    submit.parameters.jsonBody = "__NEXUS_JSON_BODY_CONTRACT__";
  }
  return copy;
}

function addIdentity(workflow: any) {
  const analysis = contract(workflow);
  if (!analysis.repair_eligible) throw new Error("Workflow is not eligible for the contract-only repair.");
  const copy = clone(workflowPayload(workflow));
  const submit = submitNode(copy);
  if (analysis.repair_mode === "keypair") {
    const rows = bodyRows(submit).filter((row: any) => !["run_id", "run_key"].includes(rowName(row)));
    const customerIndex = rows.findIndex((row: any) => rowName(row) === "customer_automation_id");
    if (customerIndex < 0) throw new Error("Nexus Submit Output is missing customer_automation_id.");
    submit.parameters.bodyParameters.parameters = [
      ...rows.slice(0, customerIndex + 1),
      { name: "run_id", value: runIdExpression },
      { name: "run_key", value: runKeyExpression },
      ...rows.slice(customerIndex + 1),
    ];
  } else {
    submit.parameters.jsonBody = wrapJsonBodyWithIdentity(jsonBodyValue(workflow));
  }
  if (JSON.stringify(withoutIdentity(workflow)) !== JSON.stringify(withoutIdentity(copy))) throw new Error("Repair changed data outside run_id/run_key.");
  return copy;
}
function workflowOutsideNodeImplementation(workflow: any, nodeName: string) {
  const copy = clone(workflowPayload(workflow));
  if (["default", "separate", "combined"].includes(clean(copy?.settings?.binaryMode))) delete copy.settings.binaryMode;
  copy.nodes = array(copy.nodes).map((node: any) => clean(node?.name) === nodeName
    ? { id: node?.id || null, name: clean(node?.name), position: clone(node?.position || []), webhookId: node?.webhookId || null }
    : node);
  return copy;
}

function patchSingleNodeFromSource(targetWorkflow: any, sourceWorkflow: any, nodeName: string) {
  const sourceMatches = array(sourceWorkflow?.nodes).filter((node: any) => clean(node?.name) === nodeName);
  const targetMatches = array(targetWorkflow?.nodes).filter((node: any) => clean(node?.name) === nodeName);
  if (sourceMatches.length !== 1 || targetMatches.length !== 1) throw new Error(`Node ${nodeName} must exist exactly once in source and target workflows.`);
  const targetNode = targetMatches[0];
  const replacement = clone(sourceMatches[0]);
  replacement.id = targetNode?.id;
  replacement.position = clone(targetNode?.position || replacement?.position || []);
  if (targetNode?.webhookId) replacement.webhookId = targetNode.webhookId;
  const patched = clone(workflowPayload(targetWorkflow));
  patched.nodes = array(patched.nodes).map((node: any) => clean(node?.name) === nodeName ? replacement : node);
  if (JSON.stringify(workflowOutsideNodeImplementation(targetWorkflow, nodeName)) !== JSON.stringify(workflowOutsideNodeImplementation(patched, nodeName))) {
    throw new Error("Node restore changed data outside the selected node implementation.");
  }
  return patched;
}

async function fingerprint(workflow: any) {
  const bytes = new TextEncoder().encode(JSON.stringify(workflowPayload(workflow)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function loadReferences(adminClient: any, body: any) {
  const requestedAutomationIds = unique(body.automation_ids);
  const requestedCustomerIds = unique(body.customer_automation_ids);
  const requestedCustomerPrefixes = unique(body.customer_automation_prefixes)
    .map((value) => lower(value))
    .filter((value) => /^[0-9a-f]{8,32}$/.test(value));
  let requestedCustomers: any[] = [];
  if (requestedCustomerIds.length) {
    const result = await adminClient.from("customer_automations").select("id,automation_id,order_id,bundle_id,n8n_workflow_id").in("id", requestedCustomerIds);
    if (result.error) throw new Error(result.error.message);
    requestedCustomers = result.data || [];
  }
  if (requestedCustomerPrefixes.length) {
    const result = await adminClient
      .from("customer_automations")
      .select("id,automation_id,order_id,bundle_id,n8n_workflow_id")
      .limit(5000);
    if (result.error) throw new Error(result.error.message);
    for (const prefix of requestedCustomerPrefixes) {
      const matches = (result.data || []).filter((row: any) => lower(row?.id).startsWith(prefix));
      if (matches.length !== 1) throw new Error(`Customer automation prefix ${prefix} matched ${matches.length} rows; exact one-row match required.`);
      requestedCustomers.push(matches[0]);
    }
    requestedCustomers = [...new Map(requestedCustomers.map((row: any) => [clean(row.id), row])).values()];
  }
  const bundlesResult = await adminClient.from("automation_bundles").select("id,status").in("status", ["active", "live", "published"]).limit(200);
  if (bundlesResult.error) throw new Error(bundlesResult.error.message);
  const bundleIds = (bundlesResult.data || []).map((row: any) => row.id);
  let items: any[] = [];
  if (bundleIds.length) {
    const result = await adminClient.from("automation_bundle_items").select("bundle_id,automation_id,status").in("bundle_id", bundleIds).limit(1000);
    if (result.error) throw new Error(result.error.message);
    items = (result.data || []).filter((row: any) => !clean(row.status) || ["active", "live", "published", "included"].includes(lower(row.status)));
  }
  const automationIds = [...new Set([...items.map((row: any) => clean(row.automation_id)), ...requestedAutomationIds, ...requestedCustomers.map((row: any) => clean(row.automation_id))].filter(Boolean))];
  if (!automationIds.length) return [];
  const productsResult = await adminClient.from("automations").select("id,title,slug,status,n8n_workflow_id").in("id", automationIds);
  if (productsResult.error) throw new Error(productsResult.error.message);
  const products = (productsResult.data || []).filter((row: any) => ["live", "active", "published"].includes(lower(row.status)));
  let customers: any[] = [];
  if (products.length) {
    const result = await adminClient.from("customer_automations").select("id,automation_id,order_id,bundle_id,n8n_workflow_id").in("automation_id", products.map((row: any) => row.id)).not("bundle_id", "is", null).limit(2000);
    if (result.error) throw new Error(result.error.message);
    customers = result.data || [];
  }
  const productById = new Map(products.map((row: any) => [clean(row.id), row]));
  const refs = new Map<string, any>();
  const add = (workflowId: unknown, kind: string, product: any, customer: any = null) => {
    const id = clean(workflowId);
    if (!id) return;
    if (!refs.has(id)) refs.set(id, { workflow_id: id, kinds: new Set(), product_ids: new Set(), product_titles: new Set(), customer_automation_ids: new Set(), order_ids: new Set() });
    const ref = refs.get(id);
    ref.kinds.add(kind);
    if (product?.id) ref.product_ids.add(clean(product.id));
    if (product?.title) ref.product_titles.add(clean(product.title));
    if (customer?.id) ref.customer_automation_ids.add(clean(customer.id));
    if (customer?.order_id) ref.order_ids.add(clean(customer.order_id));
  };
  products.forEach((product: any) => add(product.n8n_workflow_id, "product_master", product));
  const combinedCustomers = [...new Map([...customers, ...requestedCustomers].map((row: any) => [clean(row.id), row])).values()];
  combinedCustomers.forEach((customer: any) => {
    const product = productById.get(clean(customer.automation_id));
    if (product && clean(customer.n8n_workflow_id) && clean(customer.n8n_workflow_id) !== clean(product.n8n_workflow_id)) add(customer.n8n_workflow_id, "customer_clone", product, customer);
  });
  return [...refs.values()].map((ref: any) => ({ workflow_id: ref.workflow_id, kinds: [...ref.kinds], product_ids: [...ref.product_ids], product_titles: [...ref.product_titles], customer_automation_ids: [...ref.customer_automation_ids], order_ids: [...ref.order_ids] }));
}

function stringLeaves(value: any, prefix = "", rows: any[] = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => stringLeaves(item, `${prefix}[${index}]`, rows));
    return rows;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, inner]) => stringLeaves(inner, prefix ? `${prefix}.${key}` : key, rows));
    return rows;
  }
  const text = typeof value === "string" || typeof value === "number" ? clean(value) : "";
  if (text.length >= 4 && !["true", "false", "null", "undefined"].includes(lower(text))) rows.push({ path: prefix, value: text });
  return rows;
}

async function auditCustomerBoundValues(adminClient: any, workflow: any, customerAutomationIds: string[]) {
  const serialized = JSON.stringify(workflowPayload(workflow));
  const audits = [];
  for (const customerAutomationId of customerAutomationIds) {
    const setupResult = await adminClient
      .from("automation_setup_submissions")
      .select("answers")
      .eq("customer_automation_id", customerAutomationId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (setupResult.error) throw new Error(setupResult.error.message);
    const credentialResult = await adminClient
      .from("customer_automation_credentials")
      .select("key,credential_key,value,credential_value,secret_value")
      .eq("customer_automation_id", customerAutomationId);
    if (credentialResult.error) throw new Error(credentialResult.error.message);

    const setupMatches = stringLeaves(object(setupResult.data?.answers))
      .filter((row: any) => serialized.includes(JSON.stringify(row.value).slice(1, -1)))
      .map((row: any) => row.path);
    const credentialMatches = (credentialResult.data || [])
      .map((row: any) => ({ key: clean(row?.key || row?.credential_key), value: clean(row?.value || row?.credential_value || row?.secret_value) }))
      .filter((row: any) => row.key && row.value.length >= 4 && serialized.includes(JSON.stringify(row.value).slice(1, -1)))
      .map((row: any) => row.key);

    audits.push({
      customer_automation_id: customerAutomationId,
      setup_paths_found: [...new Set(setupMatches)],
      credential_keys_found: [...new Set(credentialMatches)],
      embedded_value_count: new Set([...setupMatches.map((key: string) => `setup:${key}`), ...credentialMatches.map((key: string) => `credential:${key}`)]).size,
    });
  }
  return audits;
}

async function inspectWorkflowsByIdentifier(adminClient: any, body: any) {
  const identifiers = unique(body.identifiers)
    .map((value) => lower(value))
    .filter((value) => value.length >= 6);
  if (!identifiers.length || identifiers.length > 10) throw new Error("One to ten workflow identifiers of at least six characters are required.");

  const listed = await listN8nWorkflows();
  const matches = listed.filter((workflow: any) => {
    const name = lower(workflow?.name);
    const paths = array(workflow?.nodes)
      .filter((node: any) => lower(node?.type).includes("webhook"))
      .map((node: any) => lower(node?.parameters?.path));
    return identifiers.some((identifier) => name.includes(identifier) || paths.some((path) => path.includes(identifier)));
  });
  if (!matches.length) return { ok: true, dry_run: true, identifiers, match_count: 0, workflows: [] };
  if (matches.length > 20) throw new Error(`Workflow identifiers matched ${matches.length} rows; narrow the identifiers before continuing.`);

  const workflowIds = matches.map((workflow: any) => clean(workflow?.id)).filter(Boolean);
  const productResult = await adminClient
    .from("automations")
    .select("id,title,status,n8n_workflow_id,runtime_webhook_path")
    .in("n8n_workflow_id", workflowIds);
  if (productResult.error) throw new Error(productResult.error.message);
  const customerResult = await adminClient
    .from("customer_automations")
    .select("id,automation_id,order_id,bundle_id,n8n_workflow_id,runtime_webhook_path")
    .in("n8n_workflow_id", workflowIds)
    .limit(5000);
  if (customerResult.error) throw new Error(customerResult.error.message);
  const auditCustomerIds = unique((customerResult.data || []).map((row: any) => row.id));

  const workflows = [];
  for (const listedWorkflow of matches) {
    const workflow = await getWorkflow(clean(listedWorkflow.id));
    const id = clean(workflow?.id || listedWorkflow?.id);
    workflows.push({
      workflow_id: id,
      workflow_name: clean(workflow?.name),
      active: Boolean(workflow?.active),
      fingerprint: await fingerprint(workflow),
      product_references: (productResult.data || []).filter((row: any) => clean(row?.n8n_workflow_id) === id),
      customer_references: (customerResult.data || []).filter((row: any) => clean(row?.n8n_workflow_id) === id),
      customer_bound_value_audit: await auditCustomerBoundValues(adminClient, workflow, auditCustomerIds),
      ...workflowStructure(workflow),
      ...contract(workflow),
    });
  }

  return { ok: true, dry_run: true, identifiers, match_count: workflows.length, workflows };
}

function redactedDifferencePaths(left: any, right: any, prefix = "", rows: string[] = []) {
  if (rows.length >= 500 || JSON.stringify(left) === JSON.stringify(right)) return rows;
  if (Array.isArray(left) || Array.isArray(right)) {
    const leftRows = array(left);
    const rightRows = array(right);
    const length = Math.max(leftRows.length, rightRows.length);
    for (let index = 0; index < length; index += 1) {
      redactedDifferencePaths(leftRows[index], rightRows[index], `${prefix}[${index}]`, rows);
    }
    return rows;
  }
  if ((left && typeof left === "object") || (right && typeof right === "object")) {
    const keys = [...new Set([...Object.keys(object(left)), ...Object.keys(object(right))])].sort();
    for (const key of keys) redactedDifferencePaths(object(left)[key], object(right)[key], prefix ? `${prefix}.${key}` : key, rows);
    return rows;
  }
  rows.push(prefix || "(root)");
  return rows;
}

function nodeForRedactedComparison(node: any) {
  const copy = clone(object(node));
  delete copy.id;
  delete copy.position;
  delete copy.webhookId;
  return copy;
}

function safeNodeDiagnostics(node: any, workflow: any) {
  if (!node) return null;
  const parameters = object(node?.parameters);
  const serializedParameters = JSON.stringify(parameters);
  const url = clean(parameters.url);
  let target = url.startsWith("=") ? "dynamic" : "";
  if (url && !target) {
    try { target = new URL(url).hostname; } catch { target = "non-url"; }
  }
  const incomingSources = [];
  for (const [sourceName, sourceConnections] of Object.entries(object(workflow?.connections)) as any[]) {
    const groups = array(sourceConnections?.main);
    if (groups.some((group: any) => array(group).some((connection: any) => clean(connection?.node) === clean(node?.name)))) incomingSources.push(sourceName);
  }
  const outgoingTargets = array(object(workflow?.connections)?.[clean(node?.name)]?.main)
    .flatMap((group: any) => array(group).map((connection: any) => clean(connection?.node)).filter(Boolean));
  return {
    type: clean(node?.type),
    type_version: node?.typeVersion ?? null,
    retry_on_fail: Boolean(node?.retryOnFail),
    max_tries: node?.maxTries ?? null,
    wait_between_tries: node?.waitBetweenTries ?? null,
    authentication: clean(parameters.authentication),
    generic_auth_type: clean(parameters.genericAuthType),
    credential_types: Object.keys(object(node?.credentials)).sort(),
    target,
    header_names: array(parameters?.headerParameters?.parameters).map((row: any) => clean(row?.name)).filter(Boolean),
    body_field_names: array(parameters?.bodyParameters?.parameters).map((row: any) => clean(row?.name)).filter(Boolean),
    uses_json_body: Boolean(clean(parameters.jsonBody) || parameters.jsonParameters),
    mentions_customer_automation_id: serializedParameters.includes("customer_automation_id"),
    mentions_runtime_secret: serializedParameters.includes("runtime_secret"),
    mentions_run_id: serializedParameters.includes("run_id"),
    mentions_run_key: serializedParameters.includes("run_key"),
    incoming_sources: [...new Set(incomingSources)].sort(),
    outgoing_targets: [...new Set(outgoingTargets)].sort(),
  };
}

async function compareWorkflowsById(body: any) {
  const sourceWorkflowId = clean(body.source_workflow_id);
  const targetWorkflowId = clean(body.target_workflow_id);
  if (!sourceWorkflowId || !targetWorkflowId || sourceWorkflowId === targetWorkflowId) throw new Error("Distinct source_workflow_id and target_workflow_id are required.");
  const [source, target] = await Promise.all([getWorkflow(sourceWorkflowId), getWorkflow(targetWorkflowId)]);
  const sourceNodes = new Map(array(source?.nodes).map((node: any) => [clean(node?.name), node]));
  const targetNodes = new Map(array(target?.nodes).map((node: any) => [clean(node?.name), node]));
  const names = [...new Set([...sourceNodes.keys(), ...targetNodes.keys()])].filter(Boolean).sort();
  const nodeDifferences = names.flatMap((name) => {
    const sourceNode = sourceNodes.get(name);
    const targetNode = targetNodes.get(name);
    if (!sourceNode) return [{ node_name: name, state: "target_only", changed_paths: [], source: null, target: safeNodeDiagnostics(targetNode, target) }];
    if (!targetNode) return [{ node_name: name, state: "source_only", changed_paths: [], source: safeNodeDiagnostics(sourceNode, source), target: null }];
    const paths = redactedDifferencePaths(nodeForRedactedComparison(sourceNode), nodeForRedactedComparison(targetNode));
    return paths.length ? [{ node_name: name, state: "changed", changed_paths: paths, source: safeNodeDiagnostics(sourceNode, source), target: safeNodeDiagnostics(targetNode, target) }] : [];
  });
  const connectionDifferences = [...new Set([
    ...Object.keys(object(source?.connections)),
    ...Object.keys(object(target?.connections)),
  ])].sort().filter((name) => JSON.stringify(object(source?.connections)[name]) !== JSON.stringify(object(target?.connections)[name]));
  return {
    ok: true,
    dry_run: true,
    source: { workflow_id: sourceWorkflowId, workflow_name: clean(source?.name), active: Boolean(source?.active), fingerprint: await fingerprint(source), ...workflowStructure(source), ...contract(source) },
    target: { workflow_id: targetWorkflowId, workflow_name: clean(target?.name), active: Boolean(target?.active), fingerprint: await fingerprint(target), ...workflowStructure(target), ...contract(target) },
    node_difference_count: nodeDifferences.length,
    node_differences: nodeDifferences,
    connection_difference_count: connectionDifferences.length,
    connection_sources_changed: connectionDifferences,
  };
}

async function audit(adminClient: any, body: any) {
  let refs = await loadReferences(adminClient, body);
  const requestedWorkflowIds = new Set(unique(body.workflow_ids));
  if (requestedWorkflowIds.size) refs = refs.filter((ref: any) => requestedWorkflowIds.has(ref.workflow_id));
  const workflows = [];
  for (const ref of refs) {
    try {
      const workflow = await getWorkflow(ref.workflow_id);
      workflows.push({ ...ref, workflow_name: clean(workflow.name), active: Boolean(workflow.active), fingerprint: await fingerprint(workflow), ...workflowStructure(workflow), ...contract(workflow), error: null });
    } catch (error) {
      workflows.push({ ...ref, workflow_name: "", active: null, fingerprint: "", contract_current: false, repair_eligible: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const stale = workflows.filter((row: any) => !row.contract_current);
  return { ok: true, dry_run: true, summary: { workflow_count: workflows.length, current_count: workflows.length - stale.length, stale_count: stale.length, repair_eligible_count: stale.filter((row: any) => row.repair_eligible && !row.error).length }, workflows };
}

async function auditHistoricalBundleOutputs(adminClient: any, body: any) {
  const requestedOrderIds = unique(body.order_ids);
  let issueQuery = adminClient
    .from("bundle_purchase_integrity_issues")
    .select("issue_type,order_id,record_id,automation_id,details")
    .eq("issue_type", "invalid_bundle_output_identity")
    .limit(2000);
  if (requestedOrderIds.length) issueQuery = issueQuery.in("order_id", requestedOrderIds);

  const { data: issueRows, error: issueError } = await issueQuery;
  if (issueError) throw new Error(issueError.message);
  const issues = issueRows || [];
  const orderIds = unique(issues.map((row: any) => row.order_id));
  if (!orderIds.length) {
    return {
      ok: true,
      dry_run: true,
      summary: { affected_order_count: 0, invalid_output_count: 0, exact_repair_candidate_count: 0 },
      orders: [],
    };
  }

  const [ordersResult, attemptsResult, itemsResult, outputsResult, runsResult, customersResult] = await Promise.all([
    adminClient.from("orders").select("id,buyer_id,bundle_id,order_type,payment_status,order_status,created_at").in("id", orderIds),
    adminClient.from("bundle_run_attempts").select("id,order_id,bundle_id,status,expected_count,completed_count,failed_count,started_at,finished_at,created_at,updated_at").in("order_id", orderIds).limit(2000),
    adminClient.from("bundle_run_items").select("id,bundle_run_attempt_id,order_id,bundle_id,customer_automation_id,automation_id,automation_run_id,output_id,status,started_at,finished_at,created_at,updated_at").in("order_id", orderIds).limit(5000),
    adminClient.from("automation_outputs").select("id,order_id,customer_automation_id,automation_id,automation_run_id,bundle_run_attempt_id,bundle_run_item_id,status,title,created_at,updated_at").in("order_id", orderIds).limit(5000),
    adminClient.from("automation_runs").select("id,order_id,customer_automation_id,automation_id,bundle_run_attempt_id,bundle_run_item_id,status,n8n_execution_id,response_payload,started_at,finished_at,created_at,updated_at").in("order_id", orderIds).limit(5000),
    adminClient.from("customer_automations").select("id,order_id,automation_id,status,setup_status,runtime_status,health_status,last_run_requested_at,last_run_at,created_at,updated_at").in("order_id", orderIds).limit(5000),
  ]);
  for (const result of [ordersResult, attemptsResult, itemsResult, outputsResult, runsResult, customersResult]) {
    if (result.error) throw new Error(result.error.message);
  }

  const orders = ordersResult.data || [];
  const attempts = attemptsResult.data || [];
  const items = itemsResult.data || [];
  const outputs = outputsResult.data || [];
  const runs = runsResult.data || [];
  const customers = customersResult.data || [];
  const invalidOutputIds = new Set(issues.map((row: any) => clean(row.record_id)));
  const productIds = unique([
    ...items.map((row: any) => row.automation_id),
    ...outputs.map((row: any) => row.automation_id),
  ]);
  const productsResult = productIds.length
    ? await adminClient.from("automations").select("id,title").in("id", productIds)
    : { data: [], error: null };
  if (productsResult.error) throw new Error(productsResult.error.message);
  const productTitles = new Map((productsResult.data || []).map((row: any) => [clean(row.id), clean(row.title)]));
  const buyerOutputWindows = new Map<string, { total: number; ids: Set<string> }>();
  for (const buyerId of unique(orders.map((row: any) => row.buyer_id))) {
    const result = await adminClient
      .from("automation_outputs")
      .select("id,order_id", { count: "exact" })
      .eq("buyer_id", buyerId)
      .eq("status", "published")
      .order("created_at", { ascending: false })
      .limit(100);
    if (result.error) throw new Error(result.error.message);
    buyerOutputWindows.set(buyerId, {
      total: Number(result.count || (result.data || []).length),
      ids: new Set((result.data || []).map((row: any) => clean(row.id))),
    });
  }

  const orderAudits = orders.map((order: any) => {
    const orderId = clean(order.id);
    const orderAttempts = attempts
      .filter((row: any) => clean(row.order_id) === orderId)
      .sort((left: any, right: any) => Date.parse(right.created_at || "") - Date.parse(left.created_at || ""));
    const orderItems = items.filter((row: any) => clean(row.order_id) === orderId);
    const orderRuns = runs.filter((row: any) => clean(row.order_id) === orderId);
    const orderCustomers = customers.filter((row: any) => clean(row.order_id) === orderId);
    const orderOutputs = outputs.filter((row: any) => clean(row.order_id) === orderId);
    const invalidOutputs = orderOutputs.filter((row: any) => invalidOutputIds.has(clean(row.id)));
    const buyerWindow = buyerOutputWindows.get(clean(order.buyer_id)) || { total: 0, ids: new Set<string>() };
    const outputsInsideCurrentDashboardLimit = orderOutputs.filter((row: any) => buyerWindow.ids.has(clean(row.id))).length;

    const outputAudits = invalidOutputs.map((output: any) => {
      const outputId = clean(output.id);
      const matchingItems = orderItems.filter((item: any) => {
        if (clean(item.customer_automation_id) !== clean(output.customer_automation_id)) return false;
        if (clean(output.automation_id) && clean(item.automation_id) !== clean(output.automation_id)) return false;
        return true;
      });
      const provenItems = matchingItems.filter((item: any) => {
        const itemRunId = clean(item.automation_run_id);
        const linkedRun = orderRuns.find((run: any) => clean(run.id) === itemRunId);
        const responseOutputId = clean(object(linkedRun?.response_payload).output_id);
        return Boolean(
          (clean(item.output_id) === outputId && itemRunId) ||
          (itemRunId && clean(output.automation_run_id) === itemRunId) ||
          (itemRunId && responseOutputId === outputId)
        );
      });
      const exactItem = provenItems.length === 1 ? provenItems[0] : null;
      const exactRun = exactItem
        ? orderRuns.find((run: any) => clean(run.id) === clean(exactItem.automation_run_id)) || null
        : null;
      const proof = [];
      if (exactItem && clean(exactItem.output_id) === outputId) proof.push("bundle_run_item.output_id");
      if (exactItem && clean(output.automation_run_id) === clean(exactItem.automation_run_id)) proof.push("output.automation_run_id");
      if (exactRun && clean(object(exactRun.response_payload).output_id) === outputId) proof.push("automation_run.response_payload.output_id");
      const repairable = Boolean(
        exactItem?.id &&
        exactItem?.bundle_run_attempt_id &&
        exactItem?.automation_run_id &&
        exactRun?.id &&
        proof.length
      );
      return {
        output_id: outputId,
        title: clean(output.title),
        product_title: productTitles.get(clean(output.automation_id)) || "",
        status: clean(output.status),
        customer_automation_id: clean(output.customer_automation_id),
        automation_id: clean(output.automation_id),
        created_at: output.created_at || null,
        current_identity: {
          automation_run_id: clean(output.automation_run_id) || null,
          bundle_run_attempt_id: clean(output.bundle_run_attempt_id) || null,
          bundle_run_item_id: clean(output.bundle_run_item_id) || null,
        },
        matching_item_count: matchingItems.length,
        proven_item_count: provenItems.length,
        exact_repair_candidate: repairable,
        proof,
        recommended_identity: repairable ? {
          automation_run_id: clean(exactItem.automation_run_id),
          bundle_run_attempt_id: clean(exactItem.bundle_run_attempt_id),
          bundle_run_item_id: clean(exactItem.id),
        } : null,
      };
    });

    return {
      order_id: orderId,
      bundle_id: clean(order.bundle_id) || null,
      order_type: clean(order.order_type),
      payment_status: clean(order.payment_status),
      order_status: clean(order.order_status),
      created_at: order.created_at || null,
      attempt_count: orderAttempts.length,
      legacy_customer_automations: orderCustomers.map((customer: any) => ({
        customer_automation_id: clean(customer.id),
        automation_id: clean(customer.automation_id),
        product_title: productTitles.get(clean(customer.automation_id)) || "",
        status: clean(customer.status),
        setup_status: clean(customer.setup_status),
        runtime_status: clean(customer.runtime_status),
        health_status: clean(customer.health_status),
        last_run_requested_at: customer.last_run_requested_at || null,
        last_run_at: customer.last_run_at || null,
        created_at: customer.created_at || null,
        updated_at: customer.updated_at || null,
      })),
      legacy_run_count: orderRuns.length,
      legacy_runs: orderRuns.map((run: any) => ({
        run_id: clean(run.id),
        customer_automation_id: clean(run.customer_automation_id),
        automation_id: clean(run.automation_id),
        product_title: productTitles.get(clean(run.automation_id)) || "",
        status: clean(run.status),
        n8n_execution_id: clean(run.n8n_execution_id) || null,
        started_at: run.started_at || null,
        finished_at: run.finished_at || null,
        created_at: run.created_at || null,
        updated_at: run.updated_at || null,
      })),
      latest_attempt: orderAttempts[0] || null,
      item_count: orderItems.length,
      published_output_count: orderOutputs.filter((row: any) => lower(row.status) === "published").length,
      buyer_published_output_count: buyerWindow.total,
      outputs_inside_current_dashboard_limit: outputsInsideCurrentDashboardLimit,
      outputs_dropped_by_current_dashboard_limit: Math.max(0, orderOutputs.length - outputsInsideCurrentDashboardLimit),
      exact_output_count: orderOutputs.filter((row: any) => (
        clean(row.automation_run_id) &&
        clean(row.bundle_run_attempt_id) &&
        clean(row.bundle_run_item_id)
      )).length,
      invalid_output_count: invalidOutputs.length,
      invalid_outputs: outputAudits,
    };
  }).sort((left: any, right: any) => Date.parse(right.created_at || "") - Date.parse(left.created_at || ""));

  const invalidOutputAudits = orderAudits.flatMap((row: any) => row.invalid_outputs);
  return {
    ok: true,
    dry_run: true,
    summary: {
      affected_order_count: orderAudits.length,
      invalid_output_count: invalidOutputAudits.length,
      exact_repair_candidate_count: invalidOutputAudits.filter((row: any) => row.exact_repair_candidate).length,
    },
    orders: orderAudits,
  };
}
async function restore(id: string, original: any, originallyActive: boolean) {
  await putWorkflow(id, original);
  let restored = await getWorkflow(id);
  if (originallyActive && !restored.active) await activateWorkflow(id);
  if (!originallyActive && restored.active) await deactivateWorkflow(id);
  restored = await getWorkflow(id);
  return restored;
}

async function loadWorkflowNodeRestorePlan(adminClient: any, body: any) {
  const specification = {
    automation_id: "fdacfdea-6a8f-4406-ab7e-2c54cc4c06d0",
    source_workflow_id: "WwEeQ6NKzqwOgEti",
    target_workflow_id: "hRRUzwbyHdKzphNG",
    node_name: "Nexus Submit Output3",
  };
  for (const [key, value] of Object.entries(specification)) {
    if (clean(body?.[key]) !== value) throw new Error(`Exact ${key} is required for this limited restore.`);
  }
  const expectedSourceFingerprint = clean(body.source_fingerprint);
  const expectedTargetFingerprint = clean(body.target_fingerprint);
  if (!expectedSourceFingerprint || !expectedTargetFingerprint) throw new Error("Exact source_fingerprint and target_fingerprint are required.");

  const productResult = await adminClient
    .from("automations")
    .select("id,title,status,n8n_workflow_id,runtime_webhook_path")
    .eq("id", specification.automation_id)
    .maybeSingle();
  if (productResult.error) throw new Error(productResult.error.message);
  const product = productResult.data;
  if (!product || clean(product.n8n_workflow_id) !== specification.target_workflow_id) throw new Error("Product no longer references the expected shared workflow.");

  const [source, target] = await Promise.all([
    getWorkflow(specification.source_workflow_id),
    getWorkflow(specification.target_workflow_id),
  ]);
  workflowWritePayload(target);
  const [sourceFingerprint, targetFingerprint] = await Promise.all([fingerprint(source), fingerprint(target)]);
  if (sourceFingerprint !== expectedSourceFingerprint || targetFingerprint !== expectedTargetFingerprint) throw new Error("Source or target workflow changed after the read-only audit; restore refused.");
  if (Boolean(source?.active)) throw new Error("Historical source workflow unexpectedly became active; restore refused.");
  if (!Boolean(target?.active)) throw new Error("Shared target workflow is not active; restore refused.");
  if (!contract(target).contract_current) throw new Error("Shared target workflow lost the exact bundle run identity contract; restore refused.");
  if (stableJson(object(source?.connections)) !== stableJson(object(target?.connections))) throw new Error("Source and target connections differ; one-node restore refused.");

  const sourceMatches = array(source?.nodes).filter((node: any) => clean(node?.name) === specification.node_name);
  const targetMatches = array(target?.nodes).filter((node: any) => clean(node?.name) === specification.node_name);
  if (sourceMatches.length !== 1 || targetMatches.length !== 1) throw new Error("Connected output node is not unique in source and target workflows.");
  const sourceNode = sourceMatches[0];
  const targetNode = targetMatches[0];
  const sourceDiagnostics = safeNodeDiagnostics(sourceNode, source);
  const targetDiagnostics = safeNodeDiagnostics(targetNode, target);
  const requiredSourceFields = [
    sourceDiagnostics?.mentions_customer_automation_id,
    sourceDiagnostics?.mentions_runtime_secret,
    sourceDiagnostics?.mentions_run_id,
    sourceDiagnostics?.mentions_run_key,
  ];
  if (requiredSourceFields.some((value) => !value)) throw new Error("Historical connected output node is missing dynamic customer or bundle run identity fields.");
  if (array(sourceDiagnostics?.credential_types).length) throw new Error("Historical connected output node contains an n8n credential binding; restore refused.");
  const expectedHost = new URL(SUPABASE_URL).hostname;
  if (clean(sourceDiagnostics?.target) !== expectedHost || clean(targetDiagnostics?.target) !== expectedHost) throw new Error("Connected output node target is not the expected Supabase host.");
  if (JSON.stringify(sourceDiagnostics?.incoming_sources) !== JSON.stringify(["NEXUS_FINAL_OUTPUT"]) || JSON.stringify(targetDiagnostics?.incoming_sources) !== JSON.stringify(["NEXUS_FINAL_OUTPUT"])) {
    throw new Error("Connected output node is not fed exclusively by NEXUS_FINAL_OUTPUT.");
  }
  const sourceSerialized = JSON.stringify(sourceNode);
  if (sourceSerialized.includes("39ebfa1b-3ff0-49b7-905f-45788ffdc18f") || sourceSerialized.includes("39ebfa1b")) throw new Error("Historical connected output node contains a customer-specific identifier; restore refused.");

  const webhookPath = clean(product.runtime_webhook_path);
  const sourcePaths = workflowStructure(source).webhook_paths;
  const targetPaths = workflowStructure(target).webhook_paths;
  if (!webhookPath || !sourcePaths.includes(webhookPath) || !targetPaths.includes(webhookPath)) throw new Error("Product webhook identity does not match both audited workflows.");

  return {
    specification,
    product,
    source,
    target,
    sourceNode,
    targetNode,
    originallyActive: Boolean(target.active),
    sourceFingerprint,
    targetFingerprint,
    safe: {
      ok: true,
      dry_run: true,
      product: { id: clean(product.id), title: clean(product.title), status: clean(product.status), n8n_workflow_id: clean(product.n8n_workflow_id), runtime_webhook_path: webhookPath },
      source: { workflow_id: specification.source_workflow_id, workflow_name: clean(source.name), active: Boolean(source.active), fingerprint: sourceFingerprint },
      target: { workflow_id: specification.target_workflow_id, workflow_name: clean(target.name), active: Boolean(target.active), fingerprint: targetFingerprint },
      node_name: specification.node_name,
      source_node: sourceDiagnostics,
      target_node: targetDiagnostics,
      guards: {
        product_reference_locked: true,
        webhook_identity_locked: true,
        connections_identical: true,
        non_selected_nodes_locked: true,
        current_bundle_contract_locked: true,
        derived_binary_mode_merge_locked: ["default", "separate", "combined"].includes(clean(target?.settings?.binaryMode)),
        automatic_rollback: true,
      },
    },
  };
}

async function planWorkflowNodeRestore(adminClient: any, body: any) {
  const plan = await loadWorkflowNodeRestorePlan(adminClient, body);
  return plan.safe;
}

async function applyWorkflowNodeRestore(adminClient: any, body: any) {
  if (clean(body.confirm) !== NODE_RESTORE_CONFIRMATION) return errorResponse("Exact one-node restore confirmation is required.", 400);
  const plan = await loadWorkflowNodeRestorePlan(adminClient, body);
  const patched = patchSingleNodeFromSource(plan.target, plan.source, plan.specification.node_name);
  let updateStarted = false;
  try {
    if (await fingerprint(await getWorkflow(plan.specification.target_workflow_id)) !== plan.targetFingerprint) throw new Error("Target workflow changed immediately before update.");
    await putWorkflow(plan.specification.target_workflow_id, patched);
    updateStarted = true;
    let verified = await getWorkflow(plan.specification.target_workflow_id);
    if (plan.originallyActive && !verified.active) {
      await activateWorkflow(plan.specification.target_workflow_id);
      verified = await getWorkflow(plan.specification.target_workflow_id);
    }
    if (Boolean(verified.active) !== plan.originallyActive) throw new Error("Activation state changed during one-node restore.");
    if (clean(verified?.settings?.binaryMode) !== clean(plan.target?.settings?.binaryMode)) throw new Error("Derived binaryMode changed during one-node restore.");
    if (!contract(verified).contract_current) throw new Error("Exact bundle run identity contract was not retained.");
    if (stableJson(workflowOutsideNodeImplementation(plan.target, plan.specification.node_name)) !== stableJson(workflowOutsideNodeImplementation(verified, plan.specification.node_name))) {
      throw new Error("Post-update workflow differs outside the selected connected output node.");
    }
    const verifiedNode = array(verified?.nodes).find((node: any) => clean(node?.name) === plan.specification.node_name);
    if (!verifiedNode || JSON.stringify(nodeForRedactedComparison(verifiedNode)) !== JSON.stringify(nodeForRedactedComparison(plan.sourceNode))) {
      throw new Error("Restored connected output node does not exactly match the audited working implementation.");
    }
    const verifiedDiagnostics = safeNodeDiagnostics(verifiedNode, verified);
    if (array(verifiedDiagnostics?.credential_types).length || !verifiedDiagnostics?.mentions_customer_automation_id || !verifiedDiagnostics?.mentions_runtime_secret || !verifiedDiagnostics?.mentions_run_id || !verifiedDiagnostics?.mentions_run_key) {
      throw new Error("Restored connected output node failed the dynamic identity safety check.");
    }
    const productCheck = await adminClient
      .from("automations")
      .select("id,n8n_workflow_id,runtime_webhook_path")
      .eq("id", plan.specification.automation_id)
      .maybeSingle();
    if (productCheck.error) throw new Error(productCheck.error.message);
    if (clean(productCheck.data?.n8n_workflow_id) !== plan.specification.target_workflow_id || clean(productCheck.data?.runtime_webhook_path) !== clean(plan.product.runtime_webhook_path)) {
      throw new Error("Product reference changed during restore.");
    }
    return jsonResponse({
      ok: true,
      dry_run: false,
      restored_node_count: 1,
      workflow_id: plan.specification.target_workflow_id,
      workflow_name: clean(verified.name),
      product_id: plan.specification.automation_id,
      product_status: clean(plan.product.status),
      node_name: plan.specification.node_name,
      active: Boolean(verified.active),
      fingerprint_before: plan.targetFingerprint,
      fingerprint_after: await fingerprint(verified),
      bundle_contract_current: contract(verified).contract_current,
      dynamic_identity_verified: true,
      product_reference_unchanged: true,
      webhook_identity_unchanged: true,
      connections_unchanged: true,
      binary_mode_unchanged: true,
      rollback_performed: false,
    });
  } catch (error) {
    let rollbackError = "";
    if (updateStarted) {
      try { await restore(plan.specification.target_workflow_id, plan.target, plan.originallyActive); }
      catch (restoreError) { rollbackError = restoreError instanceof Error ? restoreError.message : String(restoreError); }
    }
    return errorResponse(`Connected output restore failed.${updateStarted && !rollbackError ? " Original workflow restored." : ""}`, 500, {
      restore_error: error instanceof Error ? error.message : String(error),
      rollback_performed: updateStarted && !rollbackError,
      rollback_error: rollbackError || null,
    });
  }
}

async function auditTechnicalTestState(adminClient: any, body: any) {
  const automationId = clean(body.automation_id || INCIDENT_TECHNICAL_TEST_AUTOMATION_ID);
  if (automationId !== INCIDENT_TECHNICAL_TEST_AUTOMATION_ID) throw new Error("This incident audit is locked to the AI Social Media Reports product.");

  const [productResult, runsResult, profilesResult] = await Promise.all([
    adminClient
      .from("automations")
      .select("id,title,status,n8n_workflow_id,runtime_webhook_path,n8n_last_test_status,n8n_last_test_error,n8n_last_test_result,n8n_last_tested_at,health_status")
      .eq("id", automationId)
      .maybeSingle(),
    adminClient
      .from("automation_test_runs")
      .select("*")
      .eq("automation_id", automationId)
      .order("created_at", { ascending: false })
      .limit(5),
    adminClient
      .from("automation_test_profiles")
      .select("*")
      .eq("automation_id", automationId)
      .eq("is_default", true)
      .order("updated_at", { ascending: false })
      .limit(1),
  ]);

  if (productResult.error) throw new Error(productResult.error.message);
  if (!productResult.data) throw new Error("Incident product was not found.");
  if (runsResult.error) throw new Error(runsResult.error.message);
  if (profilesResult.error) throw new Error(profilesResult.error.message);

  const product = productResult.data;
  const latestResult = object(product.n8n_last_test_result);
  const latestWebhook = object(latestResult.webhook_response);
  const profile = array(profilesResult.data)[0] || null;
  const rawTestRuns = array(runsResult.data);
  const testRuns = rawTestRuns.map((run: any) => {
    const webhook = object(run.webhook_response);
    return {
      id: clean(run.id),
      status: clean(run.status),
      test_id: clean(run.test_id),
      n8n_workflow_id: clean(run.n8n_workflow_id),
      n8n_execution_id: clean(run.n8n_execution_id) || null,
      started_at: run.started_at || null,
      finished_at: run.finished_at || null,
      last_checked_at: run.last_checked_at || null,
      created_at: run.created_at || null,
      updated_at: run.updated_at || null,
      elapsed_seconds: Number(run.elapsed_seconds || 0),
      error_node: clean(run.error_node) || null,
      error_message: clean(run.error_message) || null,
      used_test_profile: Boolean(webhook.used_test_profile || webhook.test_profile_id || run.test_profile_id),
      test_profile_id: clean(webhook.test_profile_id || run.test_profile_id) || null,
      test_profile_name: clean(webhook.test_profile_name || run.test_profile_name) || null,
    };
  });

  const query = new URLSearchParams({ workflowId: clean(product.n8n_workflow_id), limit: "5", includeData: "false" });
  const executionResponse = await fetch(`${N8N_BASE_URL}/api/v1/executions?${query.toString()}`, {
    headers: { accept: "application/json", "X-N8N-API-KEY": N8N_API_KEY },
  });
  const executionText = await executionResponse.text();
  let executionPayload: any = {};
  try { executionPayload = executionText ? JSON.parse(executionText) : {}; } catch { executionPayload = {}; }
  if (!executionResponse.ok) throw new Error(`Could not audit recent n8n executions (${executionResponse.status}).`);
  const recentExecutions = array(executionPayload?.data || executionPayload?.executions || executionPayload).map((execution: any) => ({
    id: clean(execution.id),
    status: clean(execution.status),
    workflow_id: clean(execution.workflowId || execution.workflow_id),
    started_at: execution.startedAt || execution.started_at || null,
    stopped_at: execution.stoppedAt || execution.stopped_at || null,
    finished: Boolean(execution.finished),
  }));

  return {
    ok: true,
    read_only: true,
    automation: {
      id: clean(product.id),
      title: clean(product.title),
      status: clean(product.status),
      workflow_id: clean(product.n8n_workflow_id),
      runtime_webhook_path: clean(product.runtime_webhook_path),
      last_test_status: clean(product.n8n_last_test_status),
      last_test_error: clean(product.n8n_last_test_error) || null,
      last_tested_at: product.n8n_last_tested_at || null,
      health_status: clean(product.health_status) || null,
      last_result_status: clean(latestResult.status) || null,
      last_result_used_test_profile: Boolean(latestResult.used_test_profile || latestResult.test_profile_id || latestWebhook.used_test_profile || latestWebhook.test_profile_id),
      last_result_test_profile_id: clean(latestResult.test_profile_id || latestWebhook.test_profile_id) || null,
    },
    default_test_profile: profile ? {
      id: clean(profile.id),
      name: clean(profile.name),
      is_default: Boolean(profile.is_default),
      setup_value_count: Object.keys(object(profile.setup_values)).length,
      secret_value_count: Object.keys(object(profile.secret_values)).length,
      created_at: profile.created_at || null,
      updated_at: profile.updated_at || null,
    } : null,
    test_run_columns: Object.keys(rawTestRuns[0] || {}).sort(),
    test_runs: testRuns,
    recent_n8n_executions: recentExecutions,
  };
}
async function reconcileTechnicalTestState(body: any) {
  const automationId = clean(body.automation_id || INCIDENT_TECHNICAL_TEST_AUTOMATION_ID);
  if (automationId !== INCIDENT_TECHNICAL_TEST_AUTOMATION_ID) throw new Error("This incident reconciliation is locked to the AI Social Media Reports product.");
  if (clean(body.confirm) !== INCIDENT_TECHNICAL_TEST_RECONCILIATION) throw new Error("Exact technical-test reconciliation confirmation is required.");
  if (!NEXUS_RUNTIME_SECRET) throw new Error("NEXUS_RUNTIME_SECRET is not configured for technical-test reconciliation.");

  const response = await fetch(`${SUPABASE_URL}/functions/v1/test-n8n-workflow`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-nexus-runtime-secret": NEXUS_RUNTIME_SECRET,
    },
    body: JSON.stringify({ mode: "latest", automation_id: automationId }),
  });
  const text = await response.text();
  let payload: any = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
  if (!response.ok || payload?.error) throw new Error(clean(payload?.error || payload?.message || `Technical-test reconciliation failed (${response.status}).`));

  const webhook = object(payload.webhook_response);
  return {
    ok: true,
    reconciled_via_test_function: true,
    automation_id: clean(payload.automation_id || automationId),
    test_run_id: clean(payload.test_run_id) || null,
    execution_id: clean(payload.execution_id) || null,
    status: clean(payload.status),
    used_test_profile: Boolean(payload.used_test_profile || payload.test_profile_id || webhook.used_test_profile || webhook.test_profile_id),
    test_profile_id: clean(payload.test_profile_id || webhook.test_profile_id) || null,
    finished_at: payload.finished_at || null,
    last_checked_at: payload.last_checked_at || null,
    message: clean(payload.message) || null,
  };
}
async function apply(adminClient: any, body: any) {
  if (clean(body.confirm) !== CONFIRMATION) return errorResponse("Exact repair confirmation is required.", 400);
  const expected = array(body.expected_workflows);
  const expectedById = new Map(expected.map((row: any) => [clean(row.workflow_id), clean(row.fingerprint)]));
  if (!expected.length || expectedById.size !== expected.length || [...expectedById].some(([id, hash]) => !id || !hash)) return errorResponse("Unique expected_workflows with fingerprints are required.", 400);
  const snapshot = await audit(adminClient, { ...body, workflow_ids: [...expectedById.keys()] });
  const audited = new Map(snapshot.workflows.map((row: any) => [row.workflow_id, row]));
  for (const [id, hash] of expectedById) {
    const row = audited.get(id);
    if (!row || row.error || !row.repair_eligible || row.contract_current || row.fingerprint !== hash) return errorResponse(`Workflow ${id} is not the exact audited stale workflow. Repair refused.`, 409);
  }
  const results = [];
  for (const [id, hash] of expectedById) {
    const original = await getWorkflow(id);
    const originallyActive = Boolean(original.active);
    let updateStarted = false;
    try {
      if (await fingerprint(original) !== hash) throw new Error("Workflow changed immediately before update.");
      const originalContract = contract(original);
      const expectedJsonBody = originalContract.repair_mode === "json_expression"
        ? wrapJsonBodyWithIdentity(jsonBodyValue(original))
        : "";
      const patched = addIdentity(original);
      updateStarted = true;
      await putWorkflow(id, patched);
      let verified = await getWorkflow(id);
      if (originallyActive && !verified.active) { await activateWorkflow(id); verified = await getWorkflow(id); }
      if (!contract(verified).contract_current) throw new Error("Exact run identity contract was not retained.");
      if (expectedJsonBody && jsonBodyValue(verified) !== expectedJsonBody) throw new Error("JSON output body does not exactly match the audited contract wrapper.");
      if (JSON.stringify(withoutIdentity(original)) !== JSON.stringify(withoutIdentity(verified))) throw new Error("Post-update workflow differs outside run_id/run_key.");
      if (Boolean(verified.active) !== originallyActive) throw new Error("Activation state changed during repair.");
      results.push({ workflow_id: id, workflow_name: clean(verified.name), status: "repaired", active: Boolean(verified.active), fingerprint_before: hash, fingerprint_after: await fingerprint(verified), rollback_performed: false });
    } catch (error) {
      let rollbackError = "";
      if (updateStarted) try { await restore(id, original, originallyActive); } catch (restoreError) { rollbackError = restoreError instanceof Error ? restoreError.message : String(restoreError); }
      return errorResponse(`Workflow ${id} repair failed.${updateStarted && !rollbackError ? " Original workflow restored." : ""}`, 500, { repair_error: error instanceof Error ? error.message : String(error), rollback_performed: updateStarted && !rollbackError, rollback_error: rollbackError || null, completed_before_failure: results });
    }
  }
  return jsonResponse({ ok: true, dry_run: false, repaired_count: results.length, results });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return errorResponse("Method not allowed.", 405);
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY || !N8N_BASE_URL || !N8N_API_KEY) return errorResponse("Repair service is not configured.", 503);
  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  if (!await requireOperator(req, adminClient)) return errorResponse("Authentication required.", 401);
  const body = await req.json().catch(() => ({}));
  try {
    if (lower(body.action || "audit") === "audit") return jsonResponse(await audit(adminClient, body));
    if (lower(body.action) === "inspect_workflows_by_identifier") {
      if (!secretMatches(clean(req.headers.get("x-nexus-repair-token")), REPAIR_TOKEN)) return errorResponse("One-time repair token is missing or invalid.", 403);
      return jsonResponse(await inspectWorkflowsByIdentifier(adminClient, body));
    }
    if (lower(body.action) === "compare_workflows_by_id") {
      if (!secretMatches(clean(req.headers.get("x-nexus-repair-token")), REPAIR_TOKEN)) return errorResponse("One-time repair token is missing or invalid.", 403);
      return jsonResponse(await compareWorkflowsById(body));
    }
    if (lower(body.action) === "plan_workflow_node_restore") {
      if (!secretMatches(clean(req.headers.get("x-nexus-repair-token")), REPAIR_TOKEN)) return errorResponse("One-time repair token is missing or invalid.", 403);
      return jsonResponse(await planWorkflowNodeRestore(adminClient, body));
    }
    if (lower(body.action) === "apply_workflow_node_restore") {
      if (!secretMatches(clean(req.headers.get("x-nexus-repair-token")), REPAIR_TOKEN)) return errorResponse("One-time repair token is missing or invalid.", 403);
      return await applyWorkflowNodeRestore(adminClient, body);
    }
    if (lower(body.action) === "audit_historical_bundle_outputs") {
      if (!secretMatches(clean(req.headers.get("x-nexus-repair-token")), REPAIR_TOKEN)) return errorResponse("One-time repair token is missing or invalid.", 403);
      return jsonResponse(await auditHistoricalBundleOutputs(adminClient, body));
    }
    if (lower(body.action) === "audit_technical_test_state") {
      if (!secretMatches(clean(req.headers.get("x-nexus-repair-token")), REPAIR_TOKEN)) return errorResponse("One-time repair token is missing or invalid.", 403);
      return jsonResponse(await auditTechnicalTestState(adminClient, body));
    }    if (lower(body.action) === "reconcile_technical_test_state") {
      if (!secretMatches(clean(req.headers.get("x-nexus-repair-token")), REPAIR_TOKEN)) return errorResponse("One-time repair token is missing or invalid.", 403);
      return jsonResponse(await reconcileTechnicalTestState(body));
    }
    if (lower(body.action) === "apply") {
      if (!secretMatches(clean(req.headers.get("x-nexus-repair-token")), REPAIR_TOKEN)) return errorResponse("One-time repair token is missing or invalid.", 403);
      return await apply(adminClient, body);
    }
    return errorResponse("Unsupported repair action.", 400);
  } catch (error) {
    console.error("n8n output contract repair failed:", error);
    return errorResponse(error instanceof Error ? error.message : "Repair request failed.", 500);
  }
});