import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import { detectWorkflowCredentialSlots } from "../_shared/nexus-credentials.ts";
import { isLegacyNexusProduct } from "../_shared/legacy-nexus-products.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const N8N_BASE_URL = (Deno.env.get("N8N_BASE_URL") || "").replace(/\/+$/, "");
const N8N_API_KEY = Deno.env.get("N8N_API_KEY") || "";
const NEXUS_RUNTIME_SECRET = Deno.env.get("NEXUS_RUNTIME_SECRET") || "";

const CHECK_INTERVAL_MS = 30 * 60 * 1000;

function cleanString(value: unknown) {
  return String(value ?? "").trim();
}

function lower(value: unknown) {
  return cleanString(value).toLowerCase();
}

function asObject(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, any>;
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function nowIso() {
  return new Date().toISOString();
}

function nextCheckIso(from = new Date()) {
  return new Date(from.getTime() + CHECK_INTERVAL_MS).toISOString();
}

function isPassingWorkflowTest(value: unknown) {
  return ["passed", "passed_with_expected_test_callback_error"].includes(lower(value));
}

function isDue(product: any) {
  const nextCheck = cleanString(product?.health_next_check_at);
  if (nextCheck && new Date(nextCheck).getTime() > Date.now()) return false;

  const lastChecked = cleanString(product?.health_last_checked_at);
  if (!lastChecked) return true;

  return Date.now() - new Date(lastChecked).getTime() >= CHECK_INTERVAL_MS;
}

function workflowFromN8nResponse(data: any) {
  return asObject(data?.data || data);
}

async function requireRuntimeOrAdmin(req: Request, adminClient: any) {
  const runtimeSecret = cleanString(req.headers.get("x-nexus-runtime-secret"));
  if (NEXUS_RUNTIME_SECRET && runtimeSecret && runtimeSecret === NEXUS_RUNTIME_SECRET) {
    return { ok: true, role: "runtime" };
  }

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) return { ok: false, error: "Authentication required." };

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data?.user) return { ok: false, error: "Invalid auth token." };

  const { data: profile } = await adminClient
    .from("profiles")
    .select("role")
    .eq("id", data.user.id)
    .maybeSingle();

  if (profile?.role !== "admin") {
    return { ok: false, error: "Admin access required." };
  }

  return { ok: true, role: "admin", user: data.user };
}

async function n8nRequest(path: string) {
  if (!N8N_BASE_URL || !N8N_API_KEY) {
    throw new Error("Missing N8N_BASE_URL or N8N_API_KEY.");
  }

  const response = await fetch(`${N8N_BASE_URL}${path}`, {
    headers: {
      accept: "application/json",
      "X-N8N-API-KEY": N8N_API_KEY,
    },
  });

  const text = await response.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!response.ok) {
    const message = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(`n8n API failed (${response.status}): ${message}`);
  }

  return data;
}

async function loadN8nWorkflow(product: any) {
  const workflowId = cleanString(product?.n8n_workflow_id);
  if (!workflowId) {
    return { ok: false, status: "failed", reason: "Hosted n8n workflow ID is missing.", workflow: null };
  }

  if (!N8N_BASE_URL || !N8N_API_KEY) {
    return {
      ok: false,
      status: "warning",
      reason: "n8n API is not configured, so Nexus skipped destructive product-level health actions.",
      workflow: null,
    };
  }

  try {
    const response = await n8nRequest(`/api/v1/workflows/${encodeURIComponent(workflowId)}`);
    const workflow = workflowFromN8nResponse(response);
    if (!Array.isArray(workflow.nodes)) {
      return { ok: false, status: "failed", reason: "Hosted n8n workflow could not be read.", workflow: null };
    }
    return { ok: true, status: "passed", reason: "Hosted n8n workflow exists.", workflow };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /n8n API failed \(404\)/i.test(message) ? "failed" : "warning";
    return { ok: false, status, reason: message, workflow: null };
  }
}

function workflowContainsNexusOutput(workflow: any) {
  const json = JSON.stringify(workflow || {}).toLowerCase();
  return json.includes("runtime-submit-output") ||
    json.includes("nexus_final_output") ||
    json.includes("nexus submit output") ||
    json.includes("automation output");
}

function bindingKey(value: any) {
  return [
    lower(value?.node_name),
    lower(value?.credential_key || value?.n8n_credential_type),
    lower(value?.n8n_credential_type || value?.credential_key),
  ].join("|");
}

function credentialStatus(product: any, workflow: any) {
  if (isLegacyNexusProduct(product)) {
    return {
      ok: true,
      status: "passed",
      reason: "Legacy Nexus product uses credentials stored directly in hosted n8n.",
      details: { legacy_nexus_direct_n8n_credentials: true },
    };
  }

  const slots = detectWorkflowCredentialSlots(workflow);
  if (!slots.length) {
    return {
      ok: true,
      status: "passed",
      reason: "No external credentials detected.",
      details: { slot_count: 0 },
    };
  }

  const bindings = asArray(product?.n8n_credential_bindings);
  const bindingMap = new Map(bindings.map((binding) => [bindingKey(binding), binding]));
  const missing = slots.filter((slot: any) => {
    const directCredential = cleanString(slot.current_id || slot.current_name);
    const binding = bindingMap.get(bindingKey(slot));

    if (binding?.uses_nexus_proxy && cleanString(binding?.developer_credential_id)) return false;
    if (cleanString(binding?.n8n_credential_id || binding?.n8n_credential_name)) return false;
    if (directCredential && lower(product?.credential_binding_status) !== "needs_credentials") return false;

    return true;
  });

  if (missing.length) {
    return {
      ok: false,
      status: "failed",
      reason: `Missing credential bindings for ${missing.length} workflow node${missing.length === 1 ? "" : "s"}.`,
      details: {
        slot_count: slots.length,
        missing: missing.map((slot: any) => ({
          node_name: slot.node_name,
          node_type: slot.node_type,
          provider: slot.provider_label || slot.provider,
          n8n_credential_type: slot.n8n_credential_type || slot.credential_key,
        })),
      },
    };
  }

  return {
    ok: true,
    status: "passed",
    reason: `${slots.length} credential node${slots.length === 1 ? "" : "s"} mapped.`,
    details: { slot_count: slots.length, binding_count: bindings.length },
  };
}

function structuralStatus(product: any, workflow: any) {
  const warnings: string[] = [];

  if (!Array.isArray(workflow?.nodes) || !workflow.nodes.length) {
    return {
      ok: false,
      status: "failed",
      reason: "Hosted workflow has no nodes.",
      details: { node_count: 0 },
    };
  }

  if (!workflowContainsNexusOutput(workflow)) {
    warnings.push("Nexus output callback node was not detected. Keep the final Nexus output node in the workflow.");
  }

  if (lower(product?.n8n_last_test_status) === "running") {
    return {
      ok: true,
      status: "warning",
      reason: "A full technical check is currently running.",
      details: {
        n8n_last_test_status: product?.n8n_last_test_status || null,
        n8n_last_tested_at: product?.n8n_last_tested_at || null,
      },
    };
  }

  if (!isPassingWorkflowTest(product?.n8n_last_test_status)) {
    return {
      ok: false,
      status: "failed",
      reason: product?.n8n_last_test_error || "Latest full technical test is not passing.",
      details: {
        n8n_last_test_status: product?.n8n_last_test_status || null,
        n8n_last_tested_at: product?.n8n_last_tested_at || null,
      },
    };
  }

  if (warnings.length) {
    return {
      ok: true,
      status: "warning",
      reason: warnings[0],
      details: {
        warnings,
        node_count: workflow.nodes.length,
      },
    };
  }

  return {
    ok: true,
    status: "passed",
    reason: "Hosted workflow structure and latest technical test look healthy.",
    details: {
      node_count: workflow.nodes.length,
      n8n_last_test_status: product?.n8n_last_test_status || null,
      n8n_last_tested_at: product?.n8n_last_tested_at || null,
    },
  };
}

function mergeDetails(...items: any[]) {
  return Object.fromEntries(items.map((item, index) => [`check_${index + 1}`, item]));
}

async function insertHealthCheck(adminClient: any, product: any, result: any) {
  await adminClient.from("automation_health_checks").insert({
    automation_id: product.id,
    developer_id: product.developer_id || null,
    check_type: "structural",
    status: result.check_status,
    reason: result.reason,
    details: result.details || {},
    checked_at: result.checked_at,
    created_at: result.checked_at,
  });
}

async function notifyHealthFailure(adminClient: any, product: any, reason: string) {
  await adminClient.from("admin_notifications").insert({
    notification_type: "product_health_failed",
    title: "Product workflow paused",
    message: `${product.title || product.slug || "A product"} was paused by the product health checker: ${reason}`,
    related_automation_id: product.id,
    status: "unread",
    created_at: nowIso(),
  });
}

async function persistHealthResult(adminClient: any, product: any, result: any, dryRun = false) {
  const checkedAt = result.checked_at || nowIso();
  const previousFailures = Number(product?.health_consecutive_failures || 0);
  const isFailure = result.check_status === "failed";
  const consecutiveFailures = isFailure ? previousFailures + 1 : 0;
  const shouldPause = isFailure && lower(product?.status) === "live";
  const healthStatus = shouldPause
    ? "paused_by_health_check"
    : result.check_status === "passed"
      ? "healthy"
      : result.check_status === "warning"
        ? "warning"
        : result.check_status === "skipped"
          ? "skipped"
          : "failed";

  const patch: Record<string, unknown> = {
    health_status: healthStatus,
    health_last_checked_at: checkedAt,
    health_next_check_at: nextCheckIso(new Date(checkedAt)),
    health_consecutive_failures: consecutiveFailures,
    health_failure_reason: isFailure ? result.reason : null,
    health_failure_details: isFailure ? result.details || {} : {},
    updated_at: checkedAt,
  };

  if (result.check_status === "passed" || result.check_status === "warning") {
    patch.health_last_passed_at = checkedAt;
    patch.health_last_failed_at = null;
  }

  if (isFailure) {
    patch.health_last_failed_at = checkedAt;
  }

  if (shouldPause) {
    patch.status = "paused";
    patch.health_auto_paused_at = checkedAt;
    patch.health_previous_status = product.status || "live";
    patch.internal_notes = `${cleanString(product.internal_notes)}${product.internal_notes ? "\n\n" : ""}[${checkedAt}] Auto-paused by product health checker: ${result.reason}`;
  }

  if (dryRun) {
    return { ...patch, dry_run: true };
  }

  await insertHealthCheck(adminClient, product, result);

  const { error } = await adminClient
    .from("automations")
    .update(patch)
    .eq("id", product.id);

  if (error) throw new Error(error.message);

  if (shouldPause) {
    try {
      await notifyHealthFailure(adminClient, product, result.reason);
    } catch (error) {
      console.warn("Could not create product health notification:", error instanceof Error ? error.message : error);
    }
  }

  return patch;
}

async function checkProduct(adminClient: any, product: any, dryRun = false) {
  const checkedAt = nowIso();

  if (lower(product?.listing_type) === "custom_request") {
    const result = {
      product_id: product.id,
      slug: product.slug,
      title: product.title,
      checked_at: checkedAt,
      check_status: "skipped",
      reason: "Custom request listings do not run hosted checkout workflows.",
      details: {},
    };
    await persistHealthResult(adminClient, product, result, dryRun);
    return result;
  }

  if (!cleanString(product?.n8n_workflow_id)) {
    const details: Record<string, unknown> = {
      n8n_import_status: product?.n8n_import_status || null,
    };
    const result = {
      product_id: product.id,
      slug: product.slug,
      title: product.title,
      checked_at: checkedAt,
      check_status: "failed",
      reason: "Live product is missing a hosted n8n workflow ID.",
      details,
    };
    details.patch = await persistHealthResult(adminClient, product, result, dryRun);
    return result;
  }

  const hosted = await loadN8nWorkflow(product);
  if (!hosted.ok) {
    const checkStatus = hosted.status === "warning" ? "warning" : "failed";
    const details: Record<string, unknown> = {
      workflow_id: product.n8n_workflow_id || null,
      skipped_pause: checkStatus === "warning",
    };
    const result = {
      product_id: product.id,
      slug: product.slug,
      title: product.title,
      checked_at: checkedAt,
      check_status: checkStatus,
      reason: hosted.reason,
      details,
    };
    details.patch = await persistHealthResult(adminClient, product, result, dryRun);
    return result;
  }

  const structure = structuralStatus(product, hosted.workflow);
  const credentials = credentialStatus(product, hosted.workflow);
  const failed = [structure, credentials].find((item) => !item.ok);
  const warning = [structure, credentials].find((item) => item.status === "warning");
  const status = failed ? "failed" : warning ? "warning" : "passed";
  const reason = failed?.reason || warning?.reason || "Product workflow health check passed.";

  const details: Record<string, unknown> = mergeDetails(
    { workflow_id: product.n8n_workflow_id },
    structure,
    credentials,
  );
  const result = {
    product_id: product.id,
    slug: product.slug,
    title: product.title,
    checked_at: checkedAt,
    check_status: status,
    reason,
    details,
  };

  details.patch = await persistHealthResult(adminClient, product, result, dryRun);
  return result;
}

async function loadDueProducts(adminClient: any, limit: number) {
  const { data, error } = await adminClient
    .from("automations")
    .select("*, developers(display_name, handle)")
    .eq("status", "live")
    .order("health_last_checked_at", { ascending: true, nullsFirst: true })
    .limit(limit);

  if (error) throw new Error(error.message);
  return (data || [])
    .filter((product: any) => lower(product?.listing_type) !== "custom_request")
    .filter(isDue);
}

async function loadProduct(adminClient: any, id: string) {
  const { data, error } = await adminClient
    .from("automations")
    .select("*, developers(display_name, handle)")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("Product not found.");
  return data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  if (req.method === "GET") {
    return jsonResponse({
      ok: true,
      message: "product-health-checker is alive.",
      env: {
        has_n8n_base_url: Boolean(N8N_BASE_URL),
        has_n8n_api_key: Boolean(N8N_API_KEY),
        has_runtime_secret: Boolean(NEXUS_RUNTIME_SECRET),
      },
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed.", 405);
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return errorResponse("Missing Supabase service configuration.", 500);
  }

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const auth = await requireRuntimeOrAdmin(req, adminClient);
  if (!auth.ok) return errorResponse(auth.error || "Access denied.", 403);

  try {
    const body = await req.json().catch(() => ({}));
    const action = cleanString(body.action) || "dry_run";
    const limit = Math.max(1, Math.min(Number(body.limit || 50) || 50, 100));
    const dryRun = action === "dry_run" || Boolean(body.dry_run);

    if (action === "run_one") {
      const product = await loadProduct(adminClient, cleanString(body.automation_id || body.id));
      const result = await checkProduct(adminClient, product, dryRun);
      return jsonResponse({ ok: true, action, dry_run: dryRun, result });
    }

    if (!["dry_run", "run_due"].includes(action)) {
      return errorResponse("Unknown product health checker action.", 400);
    }

    const products = await loadDueProducts(adminClient, limit);
    const results = [];

    for (const product of products) {
      results.push(await checkProduct(adminClient, product, dryRun));
    }

    return jsonResponse({
      ok: true,
      action,
      dry_run: dryRun,
      checked_at: nowIso(),
      count: results.length,
      results,
    });
  } catch (error) {
    return errorResponse(error instanceof Error ? error.message : "Product health checker failed.", 500);
  }
});
