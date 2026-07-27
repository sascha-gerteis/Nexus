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

const clean = (value: unknown) => String(value ?? "").trim();
const lower = (value: unknown) => clean(value).toLowerCase();
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const array = (value: unknown): any[] => Array.isArray(value) ? value : [];
const unique = (value: unknown) => [...new Set(array(value).map(clean).filter(Boolean))];
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

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

const getWorkflow = (id: string) => n8n(`/api/v1/workflows/${encodeURIComponent(id)}`);
const workflowPayload = (workflow: any) => ({
  name: clean(workflow?.name || "Nexus Workflow"),
  nodes: array(workflow?.nodes),
  connections: object(workflow?.connections),
  settings: object(workflow?.settings),
  staticData: object(workflow?.staticData),
});
const putWorkflow = (id: string, workflow: any) => n8n(`/api/v1/workflows/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(workflowPayload(workflow)) });
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
async function fingerprint(workflow: any) {
  const bytes = new TextEncoder().encode(JSON.stringify(workflowPayload(workflow)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function loadReferences(adminClient: any, body: any) {
  const requestedAutomationIds = unique(body.automation_ids);
  const requestedCustomerIds = unique(body.customer_automation_ids);
  let requestedCustomers: any[] = [];
  if (requestedCustomerIds.length) {
    const result = await adminClient.from("customer_automations").select("id,automation_id,order_id,bundle_id,n8n_workflow_id").in("id", requestedCustomerIds);
    if (result.error) throw new Error(result.error.message);
    requestedCustomers = result.data || [];
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

async function audit(adminClient: any, body: any) {
  let refs = await loadReferences(adminClient, body);
  const requestedWorkflowIds = new Set(unique(body.workflow_ids));
  if (requestedWorkflowIds.size) refs = refs.filter((ref: any) => requestedWorkflowIds.has(ref.workflow_id));
  const workflows = [];
  for (const ref of refs) {
    try {
      const workflow = await getWorkflow(ref.workflow_id);
      workflows.push({ ...ref, workflow_name: clean(workflow.name), active: Boolean(workflow.active), fingerprint: await fingerprint(workflow), ...contract(workflow), error: null });
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
    if (lower(body.action) === "audit_historical_bundle_outputs") {
      if (!secretMatches(clean(req.headers.get("x-nexus-repair-token")), REPAIR_TOKEN)) return errorResponse("One-time repair token is missing or invalid.", 403);
      return jsonResponse(await auditHistoricalBundleOutputs(adminClient, body));
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