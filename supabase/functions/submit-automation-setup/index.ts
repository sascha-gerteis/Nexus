import { createClient } from "npm:@supabase/supabase-js@2";
import { decryptCredentialPayload } from "../_shared/nexus-credentials.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-nexus-runtime-secret",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json",
    },
  });
}

function errorResponse(message: string, status = 400, extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({
      error: message,
      message,
      ...extra,
    }),
    {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
      },
    },
  );
}

function env(name: string) {
  return Deno.env.get(name) || "";
}

function cleanString(value: unknown) {
  return String(value ?? "").trim();
}

function lowerString(value: unknown) {
  return cleanString(value).toLowerCase();
}

function assignIfUseful(target: Record<string, unknown>, key: string, value: unknown) {
  if (target[key] !== undefined && cleanString(target[key])) return;
  if (value === undefined || value === null) return;
  if (Array.isArray(value) && !value.length) return;
  if (!Array.isArray(value) && !cleanString(value)) return;
  target[key] = value;
}

function pickSetupValue(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value) && value.length) return value;
    if (value !== undefined && value !== null && cleanString(value)) return value;
  }

  return undefined;
}

function joinSetupList(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => cleanString(item)).filter(Boolean).join("\n");
  return cleanString(value);
}

function expandBuyerSetupAliases(setup: Record<string, unknown>) {
  const output = { ...(setup || {}) };
  const companyUrl = pickSetupValue(output, [
    "company_url",
    "company_website",
    "main_website",
    "business_website",
    "buyer_website",
    "client_website",
    "customer_website",
  ]);
  const competitorUrls = pickSetupValue(output, [
    "competitor_urls",
    "competitor_websites",
    "competitor_sites",
    "competitors",
    "competitor_list",
  ]);
  const marketRegion = pickSetupValue(output, [
    "market_region",
    "market_or_region",
    "target_market",
    "local_market",
  ]);
  const targetCustomer = pickSetupValue(output, [
    "target_customer",
    "business_target_customer",
    "business_target_customer_profile",
    "business_target_audience",
    "target_audience",
    "ideal_customer",
    "buyer_persona",
    "customer_persona",
    "audience",
    "target_client",
  ]);

  if (companyUrl !== undefined) {
    for (const key of ["company_url", "company_website", "main_website"]) {
      assignIfUseful(output, key, companyUrl);
    }
  }

  if (competitorUrls !== undefined) {
    const joined = joinSetupList(competitorUrls);
    for (const key of ["competitor_urls", "competitor_websites", "competitor_sites"]) {
      assignIfUseful(output, key, competitorUrls);
    }
    for (const key of [
      "competitor_urls_join",
      "competitor_urls_joined",
      "competitor_urls_csv",
      "competitor_urls_lines",
      "competitor_websites_join",
    ]) {
      assignIfUseful(output, key, joined);
    }
  }

  if (marketRegion !== undefined) {
    for (const key of ["market_region", "market_or_region", "target_market"]) {
      assignIfUseful(output, key, marketRegion);
    }
  }

  if (targetCustomer !== undefined) {
    for (const key of [
      "target_customer",
      "business_target_customer",
      "business_target_customer_profile",
      "business_target_audience",
      "target_audience",
      "ideal_customer",
      "buyer_persona",
      "customer_persona",
      "audience",
      "target_client",
    ]) {
      assignIfUseful(output, key, targetCustomer);
    }
  }

  return output;
}

function sheetAccessConfigFromAutomation(automation: any) {
  const detected = normalizeJsonObject(automation?.detected_placeholders);
  const config = normalizeJsonObject(detected._nexus_sheet_access_config || automation?.sheet_access_config);
  const mode = cleanString(config.mode);

  return {
    mode: ["customer_owned", "developer_owned", "private_per_customer"].includes(mode)
      ? mode
      : "customer_owned",
    developer_sheet_id: cleanString(config.developer_sheet_id),
    template_sheet_id: cleanString(config.template_sheet_id),
    sheet_tab: cleanString(config.sheet_tab),
    sheet_range: cleanString(config.sheet_range),
  };
}

function applySheetAccessSetup(setup: Record<string, unknown>, automation: any, customerAutomation: any) {
  const config = sheetAccessConfigFromAutomation(automation);
  const output = { ...(setup || {}) };

  if (config.mode === "developer_owned" && config.developer_sheet_id) {
    assignIfUseful(output, "nexus_dev_sheet_id", config.developer_sheet_id);
    assignIfUseful(output, "google_sheet_id", config.developer_sheet_id);
    assignIfUseful(output, "google_sheet_url", config.developer_sheet_id);
  }

  if (config.mode === "private_per_customer" && config.template_sheet_id) {
    assignIfUseful(output, "nexus_private_sheet_template_id", config.template_sheet_id);
    assignIfUseful(output, "nexus_private_customer_sheet_id", cleanString(customerAutomation?.private_google_sheet_id) || config.template_sheet_id);
    assignIfUseful(output, "google_sheet_id", cleanString(customerAutomation?.private_google_sheet_id) || config.template_sheet_id);
    assignIfUseful(output, "nexus_private_sheet_customer_key", cleanString(customerAutomation?.id));
  }

  if (config.sheet_tab) {
    assignIfUseful(output, "nexus_sheet_tab", config.sheet_tab);
    assignIfUseful(output, "google_sheet_name", config.sheet_tab);
  }

  if (config.sheet_range) {
    assignIfUseful(output, "nexus_sheet_range", config.sheet_range);
    assignIfUseful(output, "google_sheet_range", config.sheet_range);
  }

  assignIfUseful(output, "google_sheet_access_mode", config.mode);
  return expandBuyerSetupAliases(output);
}

function base64UrlEncode(value: string | Uint8Array | ArrayBuffer) {
  const bytes = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value instanceof ArrayBuffer
      ? new Uint8Array(value)
      : value;
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function bytesFromBase64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function privateKeyBytesFromPem(privateKey: string) {
  const base64 = cleanString(privateKey)
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  if (!base64) throw new Error("Google service account private key is missing.");
  return bytesFromBase64(base64);
}

async function signGoogleServiceAccountJwt(fields: Record<string, unknown>, scopes: string) {
  const email = cleanString(
    fields.email ||
      fields.service_account_email ||
      fields.client_email,
  );
  const privateKey = cleanString(
    fields.privateKey ||
      fields.private_key,
  ).replace(/\\n/g, "\n");

  if (!email || !privateKey) {
    throw new Error("Private sheet provisioning needs a Google Service Account credential with email and private key.");
  }

  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: "RS256",
    typ: "JWT",
  };
  const claim = {
    iss: email,
    scope: scopes,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  };
  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claim))}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyBytesFromPem(privateKey),
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );

  return {
    jwt: `${signingInput}.${base64UrlEncode(signature)}`,
    email,
  };
}

async function googleAccessTokenFromServiceAccount(fields: Record<string, unknown>) {
  const scopes = cleanString(fields.scopes || fields.scope) ||
    "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive";
  const { jwt, email } = await signGoogleServiceAccountJwt(fields, scopes);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });
  const result = await response.json().catch(() => ({}));

  if (!response.ok || !cleanString(result?.access_token)) {
    throw new Error(
      `Google service account token failed for ${email}: ${
        result?.error_description ||
        result?.error ||
        "unknown Google OAuth error"
      }`,
    );
  }

  return {
    accessToken: cleanString(result.access_token),
    serviceAccountEmail: email,
  };
}

function extractGoogleSpreadsheetId(value: unknown) {
  const raw = cleanString(value);
  if (!raw) return "";

  const match = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (match?.[1]) return match[1];

  if (/^[a-zA-Z0-9-_]{20,}$/.test(raw)) return raw;
  return "";
}

async function findGoogleServiceAccountCredential(adminClient: any, automation: any) {
  const bindings = normalizeJsonArray(automation?.n8n_credential_bindings);
  const directBinding = bindings.find((binding: any) => (
    cleanString(binding?.developer_credential_id) &&
    (
      lowerString(binding?.provider) === "google_service_account" ||
      lowerString(binding?.n8n_credential_type || binding?.credential_key) === "googleapi"
    )
  ));

  if (directBinding?.developer_credential_id) {
    const { data, error } = await adminClient
      .from("developer_credentials")
      .select("*")
      .eq("id", directBinding.developer_credential_id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (data) return data;
  }

  let query = adminClient
    .from("developer_credentials")
    .select("*")
    .eq("status", "active")
    .eq("provider", "google_service_account")
    .order("updated_at", { ascending: false })
    .limit(1);

  if (cleanString(automation?.developer_id)) {
    query = query.eq("developer_id", automation.developer_id);
  } else {
    query = query.is("developer_id", null);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return Array.isArray(data) ? data[0] : null;
}

async function copyGoogleSheetFromTemplate(params: {
  accessToken: string;
  templateSheetId: string;
  name: string;
}) {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(params.templateSheetId)}/copy?supportsAllDrives=true&fields=id,name,webViewLink`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: params.name,
      }),
    },
  );
  const result = await response.json().catch(() => ({}));

  if (!response.ok || !cleanString(result?.id)) {
    throw new Error(
      `Could not copy private customer Google Sheet: ${
        result?.error?.message ||
        result?.message ||
        "Google Drive copy failed"
      }`,
    );
  }

  return {
    id: cleanString(result.id),
    url: cleanString(result.webViewLink),
    name: cleanString(result.name),
  };
}

async function provisionPrivateCustomerSheetIfNeeded(
  adminClient: any,
  automation: any,
  customerAutomation: any,
  user: any,
) {
  const config = sheetAccessConfigFromAutomation(automation);
  if (config.mode !== "private_per_customer") return null;

  const existingSheetId = cleanString(customerAutomation?.private_google_sheet_id);
  if (existingSheetId) {
    return {
      sheetId: existingSheetId,
      sheetUrl: cleanString(customerAutomation?.private_google_sheet_url),
      copied: false,
    };
  }

  const templateSheetId = extractGoogleSpreadsheetId(config.template_sheet_id);
  if (!templateSheetId) {
    throw new Error("Private per-customer sheet mode needs a valid Google Sheets template ID or URL.");
  }

  const credentialSecret = env("NEXUS_CREDENTIAL_SECRET");
  if (!credentialSecret) {
    throw new Error("NEXUS_CREDENTIAL_SECRET is required to copy private customer sheets.");
  }

  const credential = await findGoogleServiceAccountCredential(adminClient, automation);
  if (!credential?.encrypted_payload) {
    throw new Error(
      "Private per-customer sheet mode needs an active Google Service Account credential saved in Nexus. Share the template Sheet with that service-account email, then apply credentials and run the check again.",
    );
  }

  const fields = await decryptCredentialPayload(credential.encrypted_payload, credentialSecret);
  const { accessToken, serviceAccountEmail } = await googleAccessTokenFromServiceAccount(fields);
  const copied = await copyGoogleSheetFromTemplate({
    accessToken,
    templateSheetId,
    name: `Nexus - ${cleanString(automation?.title) || "Automation"} - ${cleanString(user?.email) || cleanString(customerAutomation?.buyer_id) || cleanString(customerAutomation?.id)}`,
  });

  const now = new Date().toISOString();
  await safeUpdateCustomerAutomation(adminClient, customerAutomation.id, {
    private_google_sheet_id: copied.id,
    private_google_sheet_url: copied.url,
    private_google_sheet_template_id: templateSheetId,
    private_google_sheet_service_account_email: serviceAccountEmail,
    private_google_sheet_provisioned_at: now,
    updated_at: now,
  });

  return {
    sheetId: copied.id,
    sheetUrl: copied.url,
    copied: true,
    serviceAccountEmail,
  };
}

function safeJsonParse(value: unknown, fallback: any) {
  if (Array.isArray(value) || (value && typeof value === "object")) return value;

  const raw = cleanString(value);
  if (!raw) return fallback;

  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizeJsonArray(value: unknown) {
  const parsed = safeJsonParse(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function normalizeJsonObject(value: unknown) {
  const parsed = safeJsonParse(value, {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBearerToken(req: Request) {
  const authHeader = req.headers.get("authorization") || "";
  return authHeader.replace(/^Bearer\s+/i, "").trim();
}

function isUuid(value: unknown) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    cleanString(value),
  );
}

function getCredentialFieldNames(credentialSchema: any[]) {
  return credentialSchema
    .map((field: any) => cleanString(field?.name))
    .filter(Boolean);
}

function splitSetupAndSecrets(answers: Record<string, unknown>, credentialSchema: any[]) {
  const credentialKeys = new Set(getCredentialFieldNames(credentialSchema));
  const setupAnswers: Record<string, string> = {};
  const secretAnswers: Record<string, string> = {};

  for (const [key, rawValue] of Object.entries(answers || {})) {
    const cleanKey = cleanString(key);
    const value = cleanString(rawValue);

    if (!cleanKey) continue;

    if (credentialKeys.has(cleanKey)) {
      /*
        Empty secret fields mean "keep the saved credential".
        Do not overwrite saved secrets with blank values.
      */
      if (value) {
        secretAnswers[cleanKey] = value;
      }
    } else {
      setupAnswers[cleanKey] = value;
    }
  }

  return {
    setupAnswers,
    secretAnswers,
    credentialKeys: [...credentialKeys],
  };
}

function pickFirstString(...values: unknown[]) {
  for (const value of values) {
    const cleaned = cleanString(value);
    if (cleaned) return cleaned;
  }

  return "";
}

function cleanBaseUrl(value: string) {
  return cleanString(value).replace(/\/+$/, "");
}

async function n8nApiRequest(path: string, options: RequestInit = {}) {
  const baseUrl = cleanBaseUrl(env("N8N_BASE_URL"));
  const apiKey = env("N8N_API_KEY");

  if (!baseUrl || !apiKey) {
    throw new Error("Missing N8N_BASE_URL or N8N_API_KEY Supabase secrets.");
  }

  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-N8N-API-KEY": apiKey,
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data: any = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(
      data?.message ||
        data?.error ||
        data?.raw ||
        `n8n API request failed with status ${response.status}`,
    );
  }

  return data;
}

function runtimeWorkflowId(customerAutomation: any, automation: any, order: any = null) {
  return pickFirstString(
    customerAutomation?.n8n_workflow_id,
    automation?.n8n_workflow_id,
    order?.n8n_workflow_id,
  );
}

async function activateRuntimeWorkflow(customerAutomation: any, automation: any, order: any = null) {
  const workflowId = runtimeWorkflowId(customerAutomation, automation, order);
  if (!workflowId) {
    return {
      ok: false,
      skipped: true,
      reason: "missing_n8n_workflow_id",
    };
  }

  try {
    const result = await n8nApiRequest(
      `/api/v1/workflows/${encodeURIComponent(workflowId)}/activate`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    );

    return {
      ok: true,
      workflow_id: workflowId,
      result,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.toLowerCase().includes("active")) {
      return {
        ok: true,
        already_active: true,
        workflow_id: workflowId,
      };
    }

    return {
      ok: false,
      workflow_id: workflowId,
      error: message,
    };
  }
}

function buildCallbackUrl() {
  const supabaseUrl = env("SUPABASE_URL").replace(/\/+$/, "");
  return `${supabaseUrl}/functions/v1/runtime-submit-output`;
}

async function provisionCustomerWorkflowBeforeTrigger(params: {
  supabaseUrl: string;
  token: string;
  customerAutomationId: string;
}) {
  const response = await fetch(
    `${params.supabaseUrl.replace(/\/+$/, "")}/functions/v1/provision-customer-workflow`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.token}`,
      },
      body: JSON.stringify({
        customer_automation_id: params.customerAutomationId,
      }),
    },
  );

  const text = await response.text();
  let data: any = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok || data?.ok === false) {
    throw new Error(
      data?.error ||
        data?.message ||
        data?.raw ||
        `Customer workflow provisioning failed with status ${response.status}`,
    );
  }

  return data;
}

function addMonths(date: Date, months: number) {
  const next = new Date(date.getTime());
  const day = next.getUTCDate();

  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + months);

  const lastDay = new Date(
    Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0),
  ).getUTCDate();

  next.setUTCDate(Math.min(day, lastDay));
  return next;
}

function subscriptionIsActive(order: any) {
  const paymentStatus = cleanString(order?.payment_status).toLowerCase();
  const subscriptionStatus = cleanString(order?.stripe_subscription_status).toLowerCase();
  const orderStatus = cleanString(order?.order_status).toLowerCase();

  if (paymentStatus !== "paid") return false;

  if (
    orderStatus.includes("cancel") ||
    orderStatus.includes("expired") ||
    orderStatus.includes("failed")
  ) {
    return false;
  }

  if (subscriptionStatus) {
    return subscriptionStatus === "active" || subscriptionStatus === "trialing";
  }

  return Boolean(order?.stripe_subscription_id || order?.stripe_mode === "subscription");
}

function orderIsPaidAndOpen(order: any) {
  const paymentStatus = cleanString(order?.payment_status).toLowerCase();
  const orderStatus = cleanString(order?.order_status).toLowerCase();

  if (paymentStatus !== "paid") return false;

  return !(
    orderStatus.includes("cancel") ||
    orderStatus.includes("expired") ||
    orderStatus.includes("failed")
  );
}

function isMonthlyOrder(order: any) {
  return Boolean(
    order?.stripe_mode === "subscription" ||
      order?.stripe_subscription_id ||
      cleanString(order?.price_display).toLowerCase().includes("/mo"),
  );
}

function runtimeTriggerMode(automation: any, order: any) {
  const mode = cleanString(automation?.runtime_trigger_mode).toLowerCase();
  if (["setup_complete", "on_demand", "scheduled_interval", "subscription_monthly", "manual"].includes(mode)) {
    return mode;
  }

  return isMonthlyOrder(order) ? "subscription_monthly" : "setup_complete";
}

function runtimeRunFrequency(automation: any, order: any) {
  const mode = runtimeTriggerMode(automation, order);
  const frequency = cleanString(automation?.runtime_run_frequency).toLowerCase();
  const allowed = new Set(["manual", "on_demand", "every_30_minutes", "hourly", "daily", "weekly", "monthly"]);

  if (mode === "on_demand") return "on_demand";
  if (mode === "subscription_monthly") return "monthly";
  if (mode === "scheduled_interval") {
    return allowed.has(frequency) && !["manual", "on_demand"].includes(frequency) ? frequency : "daily";
  }

  return "manual";
}

function nextScheduledDate(frequency: string, from = new Date()) {
  const next = new Date(from.getTime());

  if (frequency === "every_30_minutes") {
    next.setUTCMinutes(next.getUTCMinutes() + 30);
    return next.toISOString();
  }

  if (frequency === "hourly") {
    next.setUTCHours(next.getUTCHours() + 1);
    return next.toISOString();
  }

  if (frequency === "daily") {
    next.setUTCDate(next.getUTCDate() + 1);
    return next.toISOString();
  }

  if (frequency === "weekly") {
    next.setUTCDate(next.getUTCDate() + 7);
    return next.toISOString();
  }

  return addMonths(next, 1).toISOString();
}

function runtimeScheduleUpdate(order: any, automation: any, current: any, firstRunTriggered: boolean) {
  const frequency = runtimeRunFrequency(automation, order);
  const triggerMode = runtimeTriggerMode(automation, order);
  const scheduled = ["every_30_minutes", "hourly", "daily", "weekly", "monthly"].includes(frequency);

  if (!scheduled) {
    return {
      runtime_trigger_mode: triggerMode,
      run_frequency: frequency,
      schedule_status: frequency === "on_demand" ? "on_demand" : "inactive",
      next_run_at: null,
    };
  }

  const now = new Date();
  const active = triggerMode === "subscription_monthly"
    ? subscriptionIsActive(order)
    : orderIsPaidAndOpen(order);

  if (!active) {
    return {
      runtime_trigger_mode: triggerMode,
      run_frequency: frequency,
      schedule_status: "paused",
    };
  }

  if (!firstRunTriggered) {
    return {
      runtime_trigger_mode: triggerMode,
      run_frequency: frequency,
      schedule_status: "inactive",
      schedule_anchor_at: current?.schedule_anchor_at || now.toISOString(),
    };
  }

  return {
    runtime_trigger_mode: triggerMode,
    run_frequency: frequency,
    schedule_status: "active",
    schedule_anchor_at: current?.schedule_anchor_at || now.toISOString(),
    next_run_at: nextScheduledDate(frequency, now),
    last_run_requested_at: now.toISOString(),
  };
}

async function safeUpdateCustomerAutomation(
  adminClient: any,
  customerAutomationId: string,
  payload: Record<string, unknown>,
) {
  const { error } = await adminClient
    .from("customer_automations")
    .update(payload)
    .eq("id", customerAutomationId);

  if (!error) return null;

  /*
    Backward compatibility:
    If some launch columns are not added yet, retry with only older/core fields.
  */
  const fallbackPayload = { ...payload };

  const optionalColumns = [
    "needs_customer_action",
    "last_error_code",
    "last_error_node",
    "last_error_message",
    "last_error_details",
    "last_failed_at",
    "n8n_last_execution_id",
    "n8n_last_execution_status",
    "n8n_last_execution_checked_at",
    "health_status",
    "failure_count",
    "runtime_trigger_mode",
    "runtime_no_change_policy",
    "runtime_response_mode",
    "run_frequency",
    "schedule_status",
    "schedule_anchor_at",
    "next_run_at",
    "last_run_at",
    "last_run_requested_at",
    "private_google_sheet_id",
    "private_google_sheet_url",
    "private_google_sheet_template_id",
    "private_google_sheet_service_account_email",
    "private_google_sheet_provisioned_at",
  ];

  for (const column of optionalColumns) {
    delete fallbackPayload[column];
  }

  const { error: fallbackError } = await adminClient
    .from("customer_automations")
    .update(fallbackPayload)
    .eq("id", customerAutomationId);

  return fallbackError || error;
}

async function insertAutomationEvent(
  adminClient: any,
  payload: {
    customer_automation_id: string;
    buyer_id?: string | null;
    automation_id?: string | null;
    order_id?: string | null;
    event_type: string;
    title: string;
    message?: string;
    created_by?: string;
  },
) {
  const { error } = await adminClient.from("automation_events").insert({
    customer_automation_id: payload.customer_automation_id,
    buyer_id: payload.buyer_id || null,
    automation_id: payload.automation_id || null,
    order_id: payload.order_id || null,
    event_type: payload.event_type,
    title: payload.title,
    message: payload.message || "",
    created_by: payload.created_by || "system",
    created_at: new Date().toISOString(),
  });

  if (error) {
    console.warn("automation_events insert failed:", error.message);
  }
}

async function insertAutomationRun(
  adminClient: any,
  payload: Record<string, unknown>,
) {
  const { error } = await adminClient.from("automation_runs").insert(payload);

  if (!error) return;

  const fallbackPayload = { ...payload };
  delete fallbackPayload.run_key;
  delete fallbackPayload.scheduled_for;
  delete fallbackPayload.trigger_source;
  delete fallbackPayload.request_payload;
  delete fallbackPayload.response_payload;

  const { error: fallbackError } = await adminClient.from("automation_runs").insert(fallbackPayload);

  if (fallbackError) {
    console.warn("automation_runs insert failed:", fallbackError.message || error.message);
  }
}

async function saveSetupSubmission(
  adminClient: any,
  payload: {
    customer_automation: any;
    answers: Record<string, unknown>;
    setup_answers: Record<string, unknown>;
    credential_keys_available: string[];
  },
) {
  const now = new Date().toISOString();
  const customerAutomation = payload.customer_automation;

  const insertPayload = {
    customer_automation_id: customerAutomation.id,
    buyer_id: customerAutomation.buyer_id || null,
    automation_id: customerAutomation.automation_id || null,
    order_id: customerAutomation.order_id || null,

    answers: payload.answers || {},
    setup_answers: payload.setup_answers || {},
    credential_keys_available: payload.credential_keys_available || [],

    status: "submitted",
    submitted_at: now,
    created_at: now,
    updated_at: now,
  };

  let result = await adminClient
    .from("automation_setup_submissions")
    .insert(insertPayload)
    .select()
    .single();

  if (!result.error) {
    return {
      data: result.data,
      error: null,
    };
  }

  /*
    Backward compatibility for older table schemas.
  */
  const fallbackPayload = {
    customer_automation_id: customerAutomation.id,
    buyer_id: customerAutomation.buyer_id || null,
    automation_id: customerAutomation.automation_id || null,
    order_id: customerAutomation.order_id || null,
    answers: payload.answers || {},
    status: "submitted",
    created_at: now,
  };

  result = await adminClient
    .from("automation_setup_submissions")
    .insert(fallbackPayload)
    .select()
    .single();

  return result;
}

async function insertCredentialWithSchemaFallback(
  adminClient: any,
  payload: Record<string, unknown>,
) {
  /*
    Different Nexus deployments have slightly different
    customer_automation_credentials schemas.

    Current safe minimum:
    - customer_automation_id
    - credential_key
    - secret_value

    Older/newer optional columns may not exist:
    - buyer_id
    - automation_id
    - order_id
    - created_at
    - updated_at

    Supabase/PostgREST rejects unknown columns, so progressively retry with fewer fields.
  */
  const attempts = [
    payload,
    {
      customer_automation_id: payload.customer_automation_id,
      buyer_id: payload.buyer_id,
      automation_id: payload.automation_id,
      credential_key: payload.credential_key,
      secret_value: payload.secret_value,
      created_at: payload.created_at,
      updated_at: payload.updated_at,
    },
    {
      customer_automation_id: payload.customer_automation_id,
      credential_key: payload.credential_key,
      secret_value: payload.secret_value,
      created_at: payload.created_at,
      updated_at: payload.updated_at,
    },
    {
      customer_automation_id: payload.customer_automation_id,
      credential_key: payload.credential_key,
      secret_value: payload.secret_value,
    },
  ];

  let lastError: any = null;

  for (const attempt of attempts) {
    const cleanAttempt: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(attempt)) {
      if (value !== undefined) cleanAttempt[key] = value;
    }

    const { error } = await adminClient
      .from("customer_automation_credentials")
      .insert(cleanAttempt);

    if (!error) return null;

    lastError = error;

    const message = String(error.message || "").toLowerCase();
    const isSchemaColumnError =
      message.includes("could not find") &&
      message.includes("column") &&
      message.includes("schema cache");

    if (!isSchemaColumnError) {
      break;
    }
  }

  return lastError;
}

async function saveCustomerCredentials(
  adminClient: any,
  customerAutomation: any,
  secretAnswers: Record<string, string>,
) {
  const entries = Object.entries(secretAnswers || {}).filter(([, value]) => cleanString(value));

  if (!entries.length) {
    return {
      savedCredentialKeys: [],
    };
  }

  const now = new Date().toISOString();
  const savedCredentialKeys: string[] = [];

  for (const [credentialKey, secretValue] of entries) {
    const key = cleanString(credentialKey);
    const value = cleanString(secretValue);

    if (!key || !value) continue;

    /*
      Keep the credential table simple and robust:
      delete previous key for this customer automation, then insert the new value.
      This avoids depending on a unique constraint.
    */
    await adminClient
      .from("customer_automation_credentials")
      .delete()
      .eq("customer_automation_id", customerAutomation.id)
      .eq("credential_key", key);

    const error = await insertCredentialWithSchemaFallback(adminClient, {
      customer_automation_id: customerAutomation.id,
      buyer_id: customerAutomation.buyer_id || null,
      automation_id: customerAutomation.automation_id || null,
      order_id: customerAutomation.order_id || null,

      credential_key: key,
      secret_value: value,

      created_at: now,
      updated_at: now,
    });

    if (error) {
      throw new Error(`Could not save automation credential ${key}: ${error.message}`);
    }

    savedCredentialKeys.push(key);
  }

  return {
    savedCredentialKeys,
  };
}

async function loadSavedCredentials(adminClient: any, customerAutomationId: string) {
  const { data, error } = await adminClient
    .from("customer_automation_credentials")
    .select("credential_key, secret_value")
    .eq("customer_automation_id", customerAutomationId);

  if (error) {
    console.warn("Could not load saved credentials:", error.message);
    return {};
  }

  const secrets: Record<string, string> = {};

  for (const row of data || []) {
    const key = cleanString(row.credential_key);
    const value = cleanString(row.secret_value);

    if (key && value) {
      secrets[key] = value;
    }
  }

  return secrets;
}

async function loadCustomerAutomation(adminClient: any, id: string) {
  const { data, error } = await adminClient
    .from("customer_automations")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error || !data) {
    return {
      data: null,
      automation: null,
      order: null,
      error: error || new Error("Customer automation not found."),
    };
  }

  let automation = null;
  if (data.automation_id) {
    const result = await adminClient
      .from("automations")
      .select("*")
      .eq("id", data.automation_id)
      .maybeSingle();

    if (!result.error) {
      automation = result.data;
    }
  }

  let order = null;
  if (data.order_id) {
    const result = await adminClient
      .from("orders")
      .select("*")
      .eq("id", data.order_id)
      .maybeSingle();

    if (!result.error) {
      order = result.data;
    }
  }

  if (!automation && order?.automation_id) {
    const result = await adminClient
      .from("automations")
      .select("*")
      .eq("id", order.automation_id)
      .maybeSingle();

    if (!result.error) {
      automation = result.data;
    }
  }

  return {
    data,
    automation,
    order,
    error: null,
  };
}

function getRuntimeWebhookUrl(customerAutomation: any, automation: any, order: any) {
  return pickFirstString(
    customerAutomation?.runtime_webhook_url,
    customerAutomation?.n8n_webhook_url,
    automation?.runtime_webhook_url,
    automation?.n8n_webhook_url,
    order?.runtime_webhook_url,
    order?.n8n_webhook_url,
  );
}

function getRuntimeWebhookPath(customerAutomation: any, automation: any, order: any) {
  return pickFirstString(
    customerAutomation?.runtime_webhook_path,
    customerAutomation?.n8n_webhook_path,
    automation?.runtime_webhook_path,
    automation?.n8n_webhook_path,
    order?.runtime_webhook_path,
    order?.n8n_webhook_path,
  );
}

function getRuntimeType(customerAutomation: any, automation: any) {
  return pickFirstString(
    customerAutomation?.runtime_type,
    automation?.runtime_type,
  ) || "manual";
}

function buildCustomerPayload(user: any, customerAutomation: any, order: any) {
  return {
    id: user?.id || customerAutomation.buyer_id || order?.buyer_id || "",
    email: user?.email || order?.buyer_email || customerAutomation.buyer_email || "",
    name:
      user?.user_metadata?.full_name ||
      user?.user_metadata?.name ||
      order?.buyer_name ||
      "",
    order_id: customerAutomation.order_id || order?.id || "",
  };
}

function extractExecutionId(responseBody: any) {
  return pickFirstString(
    responseBody?.executionId,
    responseBody?.execution_id,
    responseBody?.data?.executionId,
    responseBody?.data?.execution_id,
    responseBody?.id,
  );
}

async function triggerN8nWebhook(params: {
  webhookUrl: string;
  customerAutomation: any;
  automation: any;
  order: any;
  user: any;
  setupAnswers: Record<string, string>;
  secrets: Record<string, string>;
  savedCredentialKeys: string[];
  submissionId: string;
}) {
  const runtimeSecret = env("NEXUS_RUNTIME_SECRET");
  const callbackUrl = buildCallbackUrl();
  const setupPayload = expandBuyerSetupAliases(params.setupAnswers || {});

  const payload = {
    customer_automation_id: params.customerAutomation.id,
    automation_id: params.customerAutomation.automation_id,
    order_id: params.customerAutomation.order_id,
    buyer_id: params.customerAutomation.buyer_id,

    setup: setupPayload,
    secrets: params.secrets || {},

    customer: buildCustomerPayload(params.user, params.customerAutomation, params.order),
    system: {
      customer_automation_id: params.customerAutomation.id,
      automation_id: params.customerAutomation.automation_id,
      order_id: params.customerAutomation.order_id,
      buyer_id: params.customerAutomation.buyer_id,

      callback_url: callbackUrl,
      runtime_secret: runtimeSecret,
      setup_submission_id: params.submissionId,
      saved_credential_keys: params.savedCredentialKeys || [],

      runtime_type: getRuntimeType(params.customerAutomation, params.automation),
      runtime_webhook_path: getRuntimeWebhookPath(
        params.customerAutomation,
        params.automation,
        params.order,
      ),
      n8n_workflow_id: pickFirstString(
        params.customerAutomation.n8n_workflow_id,
        params.automation?.n8n_workflow_id,
      ),
    },
  };

  const response = await fetch(params.webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-nexus-runtime-secret": runtimeSecret,
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  let responseBody: any = {};

  try {
    responseBody = responseText ? JSON.parse(responseText) : {};
  } catch {
    responseBody = {
      raw_response: responseText,
    };
  }

  if (!response.ok) {
    throw new Error(
      `n8n webhook failed (${response.status}): ${
        responseBody?.message ||
        responseBody?.error ||
        responseText ||
        "Unknown n8n webhook error"
      }`,
    );
  }

  return {
    response,
    responseBody,
    executionId: extractExecutionId(responseBody),
  };
}

async function callCheckN8nExecution(customerAutomationId: string) {
  const supabaseUrl = env("SUPABASE_URL").replace(/\/+$/, "");
  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
  const runtimeSecret = env("NEXUS_RUNTIME_SECRET");

  if (!supabaseUrl || !serviceRoleKey || !runtimeSecret || !customerAutomationId) {
    return {
      checked: false,
      reason:
        "Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, NEXUS_RUNTIME_SECRET, or customer automation ID.",
    };
  }

  const response = await fetch(`${supabaseUrl}/functions/v1/check-n8n-execution`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceRoleKey}`,
      "x-nexus-runtime-secret": runtimeSecret,
    },
    body: JSON.stringify({
      customer_automation_id: customerAutomationId,
    }),
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      checked: false,
      status: response.status,
      error: result?.error || result?.message || "check-n8n-execution failed.",
      result,
    };
  }

  return {
    checked: true,
    result,
  };
}

async function checkN8nExecutionAfterTrigger(customerAutomationId: string) {
  /*
    Give n8n time to create/fail the execution.
    This is intentionally bounded so the customer submit request does not hang forever.
    Dashboard/setup pages can call check-n8n-execution again later if the workflow is still running.
  */
  const delays = [5000, 10000, 20000];
  let lastResult: any = null;

  for (const delay of delays) {
    await sleep(delay);

    const check = await callCheckN8nExecution(customerAutomationId);
    lastResult = check;

    if (!check.checked) {
      return check;
    }

    const status = cleanString(
      check.result?.n8n_execution_status ||
        check.result?.execution_status ||
        check.result?.status ||
        check.result?.customer_automation_status ||
        check.result?.result?.status ||
        "",
    ).toLowerCase();

    if (
      status.includes("error") ||
      status.includes("failed") ||
      status.includes("success") ||
      status.includes("completed")
    ) {
      return check;
    }
  }

  return {
    checked: true,
    still_running: true,
    result: lastResult,
  };
}

function classifyImmediateWebhookError(message: string) {
  const lower = cleanString(message).toLowerCase();

  if (
    lower.includes("webhook failed") ||
    lower.includes("webhook") ||
    lower.includes("not registered") ||
    lower.includes("requested webhook") ||
    lower.includes("n8n")
  ) {
    return {
      needs_customer_action: false,
      error_code: "WORKFLOW_RUNTIME_REVIEW_REQUIRED",
      customer_message:
        "Your setup was submitted. Nexus is preparing the automation and will add the output to your dashboard when it is ready.",
    };
  }

  if (
    lower.includes("access token") ||
    lower.includes("oauth") ||
    lower.includes("credential") ||
    lower.includes("unauthorized") ||
    lower.includes("permission")
  ) {
    return {
      needs_customer_action: true,
      error_code: "CUSTOMER_CREDENTIAL_INVALID",
      customer_message:
        "The credentials you submitted are invalid, expired, or missing required permissions. Please update your setup details to continue.",
    };
  }

  return {
    needs_customer_action: false,
    error_code: "WORKFLOW_TRIGGER_FAILED",
    customer_message:
      "This automation could not be started. Nexus has been notified and will review it.",
  };
}

async function triggerPythonRunner(params: {
  customerAutomation: any;
  automation: any;
  order: any;
  user: any;
  setupAnswers: Record<string, string>;
  secrets: Record<string, string>;
  savedCredentialKeys: string[];
  submissionId: string;
}) {
  const runtimeSecret = env("NEXUS_RUNTIME_SECRET");
  const supabaseUrl = env("SUPABASE_URL").replace(/\/+$/, "");
  const callbackUrl = buildCallbackUrl();
  const setupPayload = expandBuyerSetupAliases(params.setupAnswers || {});

  if (!supabaseUrl || !runtimeSecret) {
    throw new Error("Missing SUPABASE_URL or NEXUS_RUNTIME_SECRET Supabase secrets for Python runtime.");
  }

  const payload = {
    customer_automation_id: params.customerAutomation.id,
    automation_id: params.customerAutomation.automation_id,
    order_id: params.customerAutomation.order_id,
    buyer_id: params.customerAutomation.buyer_id,

    setup: setupPayload,
    secrets: params.secrets || {},

    customer: buildCustomerPayload(params.user, params.customerAutomation, params.order),
    system: {
      customer_automation_id: params.customerAutomation.id,
      automation_id: params.customerAutomation.automation_id,
      order_id: params.customerAutomation.order_id,
      buyer_id: params.customerAutomation.buyer_id,

      callback_url: callbackUrl,
      runtime_secret: runtimeSecret,
      setup_submission_id: params.submissionId,
      saved_credential_keys: params.savedCredentialKeys || [],
      runtime_type: "python_runner",
    },
  };

  const response = await fetch(`${supabaseUrl}/functions/v1/run-python-automation`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-nexus-runtime-secret": runtimeSecret,
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  let responseBody: any = {};

  try {
    responseBody = responseText ? JSON.parse(responseText) : {};
  } catch {
    responseBody = {
      raw_response: responseText,
    };
  }

  if (!response.ok || responseBody?.ok === false) {
    throw new Error(
      `Python runtime failed (${response.status}): ${
        responseBody?.message ||
        responseBody?.error ||
        responseBody?.runner?.error ||
        responseText ||
        "Unknown Python runtime error"
      }`,
    );
  }

  return {
    response,
    responseBody,
    executionId: "",
  };
}

async function loadLatestSetupSubmission(adminClient: any, customerAutomationId: string, buyerId: string) {
  const { data, error } = await adminClient
    .from("automation_setup_submissions")
    .select("*")
    .eq("customer_automation_id", customerAutomationId)
    .eq("buyer_id", buyerId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return null;
  return data || null;
}

function isUnregisteredN8nWebhookError(message: string) {
  const lower = cleanString(message).toLowerCase();
  return (
    lower.includes("webhook failed (404)") &&
    (
      lower.includes("not registered") ||
      lower.includes("requested webhook")
    )
  );
}

async function recordTriggerError(
  adminClient: any,
  customerAutomation: any,
  message: string,
  rawError: Record<string, unknown> = {},
) {
  const now = new Date().toISOString();
  const classification = classifyImmediateWebhookError(message);
  const customerActionRequired = Boolean(classification.needs_customer_action);

  await safeUpdateCustomerAutomation(adminClient, customerAutomation.id, {
    status: customerActionRequired ? "setup_error" : "setup_submitted",
    runtime_status: customerActionRequired ? "error" : "not_started",
    health_status: customerActionRequired ? "needs_customer_action" : "pending",
    setup_status: customerActionRequired ? "needs_update" : "submitted",

    needs_customer_action: customerActionRequired,
    last_error_code: classification.error_code,
    last_error_node: "n8n webhook trigger",
    last_error_message: customerActionRequired ? classification.customer_message : null,
    last_error_details: {
      message,
      raw_error: rawError,
    },
    last_failed_at: now,

    updated_at: now,
  });

  await adminClient.from("automation_run_errors").insert({
    customer_automation_id: customerAutomation.id,
    buyer_id: customerAutomation.buyer_id || null,
    automation_id: customerAutomation.automation_id || null,
    order_id: customerAutomation.order_id || null,

    source: "submit-automation-setup",
    error_type: classification.needs_customer_action
      ? "credential_error"
      : "workflow_trigger_error",
    error_code: classification.error_code,
    error_node: "n8n webhook trigger",
    error_message: message,
    customer_message: classification.customer_message,
    raw_error: rawError || {},
    needs_customer_action: customerActionRequired,
    resolved: false,
    created_at: now,
  });

  await insertAutomationEvent(adminClient, {
    customer_automation_id: customerAutomation.id,
    buyer_id: customerAutomation.buyer_id,
    automation_id: customerAutomation.automation_id,
    order_id: customerAutomation.order_id,
    event_type: customerActionRequired
      ? "customer_action_required"
      : "runtime_error",
    title: customerActionRequired
      ? "Customer action required"
      : "Automation trigger failed",
    message: JSON.stringify({
      error_code: classification.error_code,
      customer_message: classification.customer_message,
      admin_error_message: message,
    }),
    created_by: "runtime",
  });

  return classification;
}

Deno.serve(async (req) => {
  /*
    CORS must be the very first runtime branch.
    Do not authenticate OPTIONS requests.
  */
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: corsHeaders,
    });
  }

  if (req.method === "GET") {
    return jsonResponse({
      ok: true,
      message: "submit-automation-setup is alive.",
      env: {
        has_supabase_url: Boolean(env("SUPABASE_URL")),
        has_service_role: Boolean(env("SUPABASE_SERVICE_ROLE_KEY")),
        has_runtime_secret: Boolean(env("NEXUS_RUNTIME_SECRET")),
      },
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    const supabaseUrl = env("SUPABASE_URL");
    const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      return errorResponse("Missing Supabase function secrets.", 500);
    }

    const token = getBearerToken(req);
    if (!token) {
      return errorResponse("Missing authorization token.", 401);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: userResult, error: userError } = await adminClient.auth.getUser(token);

    if (userError || !userResult?.user) {
      return errorResponse(userError?.message || "Invalid user session.", 401);
    }

    const user = userResult.user;
    const body = await req.json().catch(() => ({}));
    const { data: profile } = await adminClient
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .maybeSingle();

    const isAdmin = profile?.role === "admin";
    const isDeveloper = profile?.role === "developer";
    let developerProfile: any = null;

    if (isDeveloper) {
      const { data: developerData, error: developerError } = await adminClient
        .from("developers")
        .select("id, profile_id, status")
        .eq("profile_id", user.id)
        .maybeSingle();

      if (developerError) {
        return errorResponse(developerError.message, 500);
      }

      developerProfile = developerData || null;
    }

    const skipRuntimeTrigger = (isAdmin || isDeveloper) && Boolean(body.skip_runtime_trigger);

    const customerAutomationId = cleanString(
      body.customer_automation_id ||
        body.customerAutomationId ||
        body.id,
    );

    if (!isUuid(customerAutomationId)) {
      return errorResponse("A valid customer_automation_id is required.", 400);
    }

    const answers = normalizeJsonObject(body.answers || body.setup || {});

    const loaded = await loadCustomerAutomation(adminClient, customerAutomationId);

    if (loaded.error || !loaded.data) {
      return errorResponse(
        loaded.error instanceof Error ? loaded.error.message : "Customer automation not found.",
        404,
      );
    }

    const customerAutomation = loaded.data;
    const automation = loaded.automation || {};
    const order = loaded.order || {};
    const developerOwnsAutomation = Boolean(
      developerProfile?.id &&
        (
          cleanString(automation.developer_id) === cleanString(developerProfile.id) ||
          cleanString(order.developer_id) === cleanString(developerProfile.id)
        )
    );

    if (customerAutomation.buyer_id && customerAutomation.buyer_id !== user.id && !isAdmin && !developerOwnsAutomation) {
      return errorResponse("You do not have access to this automation.", 403);
    }

    const action = lowerString(body.action);
    const setupSchema = normalizeJsonArray(automation.setup_schema);
    const credentialSchema = normalizeJsonArray(automation.credential_schema);

    if (action === "load_setup" || action === "get_setup" || action === "setup_form") {
      const latestSubmission = await loadLatestSetupSubmission(
        adminClient,
        customerAutomation.id,
        customerAutomation.buyer_id || user.id,
      );

      return jsonResponse({
        ok: true,
        customer_automation: customerAutomation,
        automation: {
          ...automation,
          setup_schema: setupSchema,
          credential_schema: credentialSchema,
        },
        order,
        latest_submission: latestSubmission,
        schema_counts: {
          setup: setupSchema.length,
          credential: credentialSchema.length,
        },
      });
    }

    const privateSheetProvision = await provisionPrivateCustomerSheetIfNeeded(
      adminClient,
      automation,
      customerAutomation,
      user,
    );
    if (privateSheetProvision?.sheetId) {
      customerAutomation.private_google_sheet_id = privateSheetProvision.sheetId;
      customerAutomation.private_google_sheet_url = privateSheetProvision.sheetUrl || "";
    }

    const splitAnswers = splitSetupAndSecrets(
      answers,
      credentialSchema,
    );
    let { setupAnswers, secretAnswers, credentialKeys } = splitAnswers;
    setupAnswers = applySheetAccessSetup(setupAnswers, automation, customerAutomation) as Record<string, string>;

    /*
      Safety fallback for old temporary testing setup:
      If the credential schema expects meta_access_token but it is missing and brand_notes looks like a token,
      use it. This keeps the launch test flow working without depending on this behavior long-term.
    */
    let usedBrandNotesAsMetaToken = false;
    if (
      credentialKeys.includes("meta_access_token") &&
      !secretAnswers.meta_access_token &&
      cleanString(setupAnswers.brand_notes).startsWith("EAA")
    ) {
      secretAnswers.meta_access_token = cleanString(setupAnswers.brand_notes);
      usedBrandNotesAsMetaToken = true;
    }

    const { savedCredentialKeys } = await saveCustomerCredentials(
      adminClient,
      customerAutomation,
      secretAnswers,
    );

    const savedSecrets = await loadSavedCredentials(adminClient, customerAutomation.id);

    const submissionResult = await saveSetupSubmission(adminClient, {
      customer_automation: customerAutomation,
      answers,
      setup_answers: setupAnswers,
      credential_keys_available: Object.keys(savedSecrets),
    });

    if (submissionResult.error || !submissionResult.data) {
      return errorResponse(
        submissionResult.error?.message || "Could not save setup submission.",
        500,
      );
    }

    const submission = submissionResult.data;
    const now = new Date().toISOString();

    /*
      Important retry behavior:
      Buyer submissions move into running immediately.
      Admin setup-only submissions save values without firing the runtime yet.
    */
    const runningUpdateError = await safeUpdateCustomerAutomation(
      adminClient,
      customerAutomation.id,
      skipRuntimeTrigger
        ? {
            status: "setup_submitted",
            runtime_status: "not_started",
            health_status: "pending",
            setup_status: "submitted",

            needs_customer_action: false,
            last_error_code: null,
            last_error_node: null,
            last_error_message: null,
            last_error_details: {},
            last_failed_at: null,

            n8n_last_execution_id: null,
            n8n_last_execution_status: null,
            n8n_last_execution_checked_at: null,

            ...runtimeScheduleUpdate(order, automation, customerAutomation, false),
            updated_at: now,
          }
        : {
            status: "running",
            runtime_status: "running",
            health_status: "running",
            setup_status: "submitted",

            needs_customer_action: false,
            last_error_code: null,
            last_error_node: null,
            last_error_message: null,
            last_error_details: {},
            last_failed_at: null,

            n8n_last_execution_id: null,
            n8n_last_execution_status: null,
            n8n_last_execution_checked_at: null,

            updated_at: now,
          },
    );

    if (runningUpdateError) {
      return errorResponse(runningUpdateError.message, 500);
    }

    await insertAutomationEvent(adminClient, {
      customer_automation_id: customerAutomation.id,
      buyer_id: customerAutomation.buyer_id,
      automation_id: customerAutomation.automation_id,
      order_id: customerAutomation.order_id,
      event_type: "setup_submitted",
      title: "Setup submitted",
      message: JSON.stringify({
        setup_keys: Object.keys(setupAnswers),
        credential_keys_available: Object.keys(savedSecrets),
      }),
      created_by: isAdmin ? "admin" : isDeveloper ? "developer" : "buyer",
    });

    if (skipRuntimeTrigger) {
      return jsonResponse({
        ok: true,
        status: "submitted",
        triggered_n8n: false,
        skipped_runtime_trigger: true,
        submission_id: submission.id,
        setup_keys: Object.keys(setupAnswers),
        credential_keys_available: Object.keys(savedSecrets),
      });
    }

    let runtimeType = getRuntimeType(customerAutomation, automation);
    let isPythonRuntime = runtimeType === "python_runner";

    const hasManagedWorkflowTemplate = Boolean(
      customerAutomation.n8n_workflow_id ||
        automation?.n8n_workflow_id ||
        order?.n8n_workflow_id ||
        customerAutomation.runtime_webhook_url ||
        automation?.runtime_webhook_url ||
        order?.runtime_webhook_url,
    );

    if (!isPythonRuntime && (runtimeType === "n8n_managed" || hasManagedWorkflowTemplate)) {
      try {
        const provisionResult = await provisionCustomerWorkflowBeforeTrigger({
          supabaseUrl,
          token,
          customerAutomationId: customerAutomation.id,
        });

        if (provisionResult?.customer_automation) {
          Object.assign(customerAutomation, provisionResult.customer_automation);
        }

        runtimeType = getRuntimeType(customerAutomation, automation);
        isPythonRuntime = runtimeType === "python_runner";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || "");
        const classification = await recordTriggerError(
          adminClient,
          customerAutomation,
          `Customer workflow provisioning failed before trigger: ${message}`,
          { source: "provision-customer-workflow" },
        );

        if (!isAdmin && !isDeveloper) {
          return jsonResponse({
            ok: true,
            status: "submitted",
            triggered_n8n: false,
            runtime_review_required: true,
            submission_id: submission.id,
            setup_keys: Object.keys(setupAnswers),
            credential_keys_available: Object.keys(savedSecrets),
            message: classification?.customer_message ||
              "Your setup was submitted. Nexus is preparing the automation and will add the output to your dashboard when it is ready.",
          });
        }

        return errorResponse(message, 502, {
          status: "provision_failed",
          triggered_n8n: false,
        });
      }
    }

    const webhookUrl = getRuntimeWebhookUrl(customerAutomation, automation, order);

    const shouldTriggerRuntime =
      isPythonRuntime ||
      runtimeType === "n8n_managed" ||
      Boolean(webhookUrl);

    if (!shouldTriggerRuntime || (!isPythonRuntime && !webhookUrl)) {
      await safeUpdateCustomerAutomation(adminClient, customerAutomation.id, {
        status: "setup_submitted",
        runtime_status: "not_started",
        health_status: "pending",
        setup_status: "submitted",
        ...runtimeScheduleUpdate(order, automation, customerAutomation, false),
        updated_at: new Date().toISOString(),
      });

      return jsonResponse({
        ok: true,
        status: "submitted",
        triggered_n8n: false,
        submission_id: submission.id,
        setup_keys: Object.keys(setupAnswers),
        credential_keys_available: Object.keys(savedSecrets),
        used_brand_notes_as_meta_token: usedBrandNotesAsMetaToken,
      });
    }

    let triggerResult: any = null;

    try {
      triggerResult = isPythonRuntime
        ? await triggerPythonRunner({
          customerAutomation,
          automation,
          order,
          user: isAdmin || isDeveloper ? null : user,
          setupAnswers,
          secrets: savedSecrets,
          savedCredentialKeys,
          submissionId: submission.id,
        })
        : await triggerN8nWebhook({
          webhookUrl,
          customerAutomation,
          automation,
          order,
          user: isAdmin || isDeveloper ? null : user,
          setupAnswers,
          secrets: savedSecrets,
          savedCredentialKeys,
          submissionId: submission.id,
        });
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      let activationRetry: any = null;

      if (!isPythonRuntime && isUnregisteredN8nWebhookError(message)) {
        activationRetry = await activateRuntimeWorkflow(customerAutomation, automation, order);

        if (activationRetry?.ok) {
          try {
            triggerResult = await triggerN8nWebhook({
              webhookUrl,
              customerAutomation,
              automation,
              order,
              user: isAdmin || isDeveloper ? null : user,
              setupAnswers,
              secrets: savedSecrets,
              savedCredentialKeys,
              submissionId: submission.id,
            });
          } catch (retryError) {
            message = retryError instanceof Error ? retryError.message : String(retryError);
          }
        }
      }

      if (triggerResult) {
        await insertAutomationEvent(adminClient, {
          customer_automation_id: customerAutomation.id,
          buyer_id: customerAutomation.buyer_id,
          automation_id: customerAutomation.automation_id,
          order_id: customerAutomation.order_id,
          event_type: "runtime_webhook_recovered",
          title: "Runtime webhook activated and retried",
          message: JSON.stringify({
            webhook_path: getRuntimeWebhookPath(customerAutomation, automation, order),
            activation_retry: activationRetry,
          }),
          created_by: "runtime",
        });
      } else {
        const classification = await recordTriggerError(adminClient, customerAutomation, message, {
          webhook_url: webhookUrl,
          workflow_id: runtimeWorkflowId(customerAutomation, automation, order),
          activation_retry: activationRetry,
        });

        if (!isAdmin && !isDeveloper) {
          if (classification?.needs_customer_action) {
            return errorResponse(classification.customer_message, 400, {
              status: "customer_action_required",
              triggered_n8n: false,
            });
          }

          return jsonResponse({
            ok: true,
            status: "submitted",
            triggered_n8n: false,
            runtime_review_required: true,
            submission_id: submission.id,
            setup_keys: Object.keys(setupAnswers),
            credential_keys_available: Object.keys(savedSecrets),
            message: classification?.customer_message ||
              "Your setup was submitted. Nexus is preparing the automation and will add the output to your dashboard when it is ready.",
          });
        }

        return errorResponse(message, 502, {
          status: "trigger_failed",
          triggered_n8n: false,
          activation_retry: activationRetry,
        });
      }
    }

    const executionId = triggerResult?.executionId || "";

    if (executionId) {
      await safeUpdateCustomerAutomation(adminClient, customerAutomation.id, {
        n8n_last_execution_id: executionId,
        n8n_last_execution_status: "started",
        n8n_last_execution_checked_at: new Date().toISOString(),
        ...runtimeScheduleUpdate(order, automation, customerAutomation, true),
        updated_at: new Date().toISOString(),
      });
    } else {
      await safeUpdateCustomerAutomation(adminClient, customerAutomation.id, {
        ...runtimeScheduleUpdate(order, automation, customerAutomation, true),
        updated_at: new Date().toISOString(),
      });
    }

    await insertAutomationRun(adminClient, {
      customer_automation_id: customerAutomation.id,
      buyer_id: customerAutomation.buyer_id,
      automation_id: customerAutomation.automation_id,
      order_id: customerAutomation.order_id,
      runtime_type: runtimeType || "n8n_managed",
      trigger_type: "buyer_setup_submit",
      trigger_source: isAdmin ? "admin_setup_submit" : isDeveloper ? "developer_setup_submit" : "buyer_setup_submit",
      status: "running",
      n8n_execution_id: executionId || null,
      started_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    await insertAutomationEvent(adminClient, {
      customer_automation_id: customerAutomation.id,
      buyer_id: customerAutomation.buyer_id,
      automation_id: customerAutomation.automation_id,
      order_id: customerAutomation.order_id,
      event_type: "runtime_triggered",
      title: "Automation started",
      message: JSON.stringify({
        runtime_type: runtimeType,
        webhook_path: getRuntimeWebhookPath(customerAutomation, automation, order),
        n8n_execution_id: executionId || null,
      }),
      created_by: "runtime",
    });

    const n8nCheckResult = isPythonRuntime
      ? { checked: false, reason: "Python runner handles execution and callback status." }
      : await checkN8nExecutionAfterTrigger(customerAutomation.id);

    return jsonResponse({
      ok: true,
      status: "submitted_and_triggered",
      triggered_n8n: !isPythonRuntime,
      triggered_python: isPythonRuntime,
      submission_id: submission.id,
      setup_keys: Object.keys(setupAnswers),
      credential_keys_available: Object.keys(savedSecrets),
      used_brand_notes_as_meta_token: usedBrandNotesAsMetaToken,
      n8n_execution_id: executionId || null,
      n8n_check: n8nCheckResult,
    });
  } catch (error) {
    console.error("submit-automation-setup failed:", error);

    return errorResponse(
      error instanceof Error ? error.message : "Could not submit automation setup.",
      500,
    );
  }
});
