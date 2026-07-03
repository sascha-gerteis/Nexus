import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import { bindAutomationCredentials } from "../_shared/nexus-credentials.ts";

function env(name: string) {
  return Deno.env.get(name) || "";
}

function cleanString(value: unknown) {
  return String(value ?? "").trim();
}

function cleanBaseUrl(url: string) {
  return String(url || "").replace(/\/+$/, "");
}

function stringifySafe(value: unknown) {
  try {
    if (typeof value === "string") return value;
    return JSON.stringify(value || {});
  } catch {
    return String(value || "");
  }
}

function parseJson(value: unknown, fallback: any) {
  if (Array.isArray(value) || (value && typeof value === "object")) return value;

  const raw = cleanString(value);
  if (!raw) return fallback;

  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function asArray(value: unknown) {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function normalizeSchema(value: unknown) {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

function asObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function lower(value: unknown) {
  return cleanString(value).toLowerCase();
}

function sourcePlatform(value: unknown) {
  const platform = lower(value);
  if (platform === "make" || platform === "zapier") return platform;
  return "";
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

function normalizedSetupKey(value: unknown) {
  return cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function stripDerivedSetupSuffix(key: string) {
  for (const suffix of ["_join", "_joined", "_csv", "_lines", "_text", "_string"]) {
    if (key.endsWith(suffix) && key.length > suffix.length + 2) {
      return key.slice(0, -suffix.length);
    }
  }

  return key;
}

function canonicalSetupKey(value: unknown) {
  const key = stripDerivedSetupSuffix(normalizedSetupKey(value));
  const aliases: Record<string, string> = {
    landing_page: "landing_page_url",
    landing_page_url: "landing_page_url",
    landing_page_website: "landing_page_url",
    landing_page_link: "landing_page_url",
    page_url: "landing_page_url",
    website_url: "company_url",
    website: "company_url",
    main_website: "company_url",
    company_website: "company_url",
    company_site: "company_url",
    company_url: "company_url",
    business_website: "company_url",
    business_site: "company_url",
    buyer_website: "company_url",
    buyer_site: "company_url",
    client_website: "company_url",
    client_site: "company_url",
    customer_website: "company_url",
    customer_site: "company_url",
    competitor_websites: "competitor_urls",
    competitor_sites: "competitor_urls",
    competitor_urls: "competitor_urls",
    competitors: "competitor_urls",
    competitor_list: "competitor_urls",
    focus_area: "focus_areas",
    focus_areas: "focus_areas",
    market_or_region: "market_region",
    market_region: "market_region",
    target_market: "market_region",
    local_market: "market_region",
    business_target_customer: "target_customer",
    business_target_customer_profile: "target_customer",
    business_target_audience: "target_customer",
    target_audience: "target_customer",
    ideal_customer: "target_customer",
    buyer_persona: "target_customer",
    customer_persona: "target_customer",
    audience: "target_customer",
    target_client: "target_customer",
    report_title: "report_title",
  };

  return aliases[key] || key;
}

function addSetupAliasesForValue(output: Record<string, unknown>, rawKey: string, value: unknown) {
  const normalized = normalizedSetupKey(rawKey);
  const canonical = canonicalSetupKey(rawKey);

  if (normalized) assignIfUseful(output, normalized, value);
  if (canonical) assignIfUseful(output, canonical, value);
}

function expandBuyerSetupAliases(setup: Record<string, unknown>) {
  const output = { ...(setup || {}) };

  for (const [key, value] of Object.entries(setup || {})) {
    addSetupAliasesForValue(output, key, value);
  }

  const companyUrl = pickSetupValue(output, [
    "landing_page_url",
    "page_url",
    "website_url",
    "website",
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
    for (const key of ["landing_page_url", "page_url", "website_url", "website", "company_url", "company_website", "main_website"]) {
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

function pickFirstString(...values: unknown[]) {
  for (const value of values) {
    const cleaned = cleanString(value);
    if (cleaned) return cleaned;
  }

  return "";
}

function usefulString(value: unknown) {
  const cleaned = cleanString(value);
  if (!cleaned) return "";
  if (cleaned === "{}" || cleaned === "[]" || cleaned === "[object Object]") return "";
  return cleaned;
}

function pickFirstUsefulString(...values: unknown[]) {
  for (const value of values) {
    const cleaned = usefulString(value);
    if (cleaned) return cleaned;
  }

  return "";
}

function isTerminalStatus(status: string) {
  const safe = cleanString(status).toLowerCase();
  return [
    "passed",
    "failed",
    "execution_not_found_after_timeout",
    "passed_with_expected_test_callback_error",
    "passed_with_expected_test_input_error",
    "cancelled",
    "timeout"
  ].includes(safe);
}

async function getUserFromRequest(req: Request, supabaseUrl: string, anonKey: string) {
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return null;

  const token = authHeader.replace("Bearer ", "").trim();

  const userClient = createClient(supabaseUrl, anonKey, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  });

  const { data, error } = await userClient.auth.getUser(token);

  if (error || !data?.user) return null;

  return data.user;
}

function getRuntimeOperatorFromRequest(req: Request) {
  const runtimeSecret = cleanString(req.headers.get("x-nexus-runtime-secret"));
  if (!runtimeSecret || runtimeSecret !== env("NEXUS_RUNTIME_SECRET")) return null;

  return {
    userId: null,
    operator: {
      profile: {
        id: null,
        role: "admin",
      },
      developer: null,
      runtime: true,
    },
  };
}

async function getOperatorContext(adminClient: any, userId: string) {
  const { data, error } = await adminClient
    .from("profiles")
    .select("id, role")
    .eq("id", userId)
    .maybeSingle();

  if (error || !data || !["admin", "developer"].includes(data.role)) {
    return null;
  }

  if (data.role !== "developer") {
    return { profile: data, developer: null };
  }

  const { data: developer, error: developerError } = await adminClient
    .from("developers")
    .select("id, profile_id")
    .eq("profile_id", userId)
    .maybeSingle();

  if (developerError || !developer) return null;

  return { profile: data, developer };
}

function canAccessAutomation(operator: any, automation: any) {
  if (operator?.profile?.role === "admin") return true;
  return Boolean(operator?.developer?.id && automation?.developer_id === operator.developer.id);
}

function canAccessTestRun(operator: any, testRun: any) {
  if (operator?.profile?.role === "admin") return true;
  return Boolean(operator?.developer?.id && testRun?.developer_id === operator.developer.id);
}

function testValueForField(field: any) {
  const name = cleanString(field?.name).toLowerCase();
  const type = cleanString(field?.type).toLowerCase();

  if (name.includes("email")) return "admin-test@nexus.local";
  if (name.includes("url") || type === "url") return "https://example.com";
  if (name.includes("page_id")) return "1234567890";
  if (name.includes("business_account_id")) return "17841400000000000";
  if (name.includes("channel_id")) return "UC_TEST_CHANNEL_ID";
  if (name.includes("username") || name.includes("handle")) return "test_brand";
  if (name.includes("company") || name.includes("brand")) return "Nexus Test Brand";
  if (name.includes("frequency")) return "Weekly";
  if (type === "number") return 1;
  if (type === "select" && Array.isArray(field?.options) && field.options.length) {
    return field.options[0];
  }
  if (type === "textarea") return "This is a Nexus technical test run. Values are placeholders.";
  return "TEST_VALUE";
}

function inferSetupFieldType(name: string) {
  const key = cleanString(name).toLowerCase();
  if (key.includes("email")) return "email";
  if (key.includes("url") || key.includes("website") || key.includes("link")) return "url";
  if (key.includes("count") || key.includes("limit") || key.includes("max_") || key.includes("amount")) return "number";
  if (key.includes("notes") || key.includes("description") || key.includes("instructions") || key.includes("customer") || key.includes("audience")) return "textarea";
  return "text";
}

function inferredSetupField(name: string) {
  const key = canonicalSetupKey(name);
  return key
    ? {
        name: key,
        label: key.replace(/[_-]+/g, " ").replace(/\b\w/g, (match) => match.toUpperCase()),
        type: inferSetupFieldType(key),
        required: true,
      }
    : null;
}

function inferSetupKeysFromWorkflow(automation: any) {
  const setupNames = new Set<string>();
  const source = stringifySafe(
    automation?.n8n_normalized_workflow_json ||
      automation?.n8n_workflow_json ||
      automation?.workflow_json ||
      {},
  );
  const patterns = [
    /NEXUS_SETUP\.([a-zA-Z0-9_.-]+)/g,
    /NEXUS_SETUP[_:-]([a-zA-Z0-9_.-]+)/gi,
    /\{\{\s*(?:(?:NEXUS|NX)[\s_-]*SETUP|SETUP[\s_-]*(?:NEXUS|NX))\s*(?:[|:.=_\-\[\(]|\s+)\s*([a-zA-Z0-9_. -]+?)\s*(?:[\]\)])?\s*\}\}/gi,
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
      const key = canonicalSetupKey(match[1]);
      if (key) setupNames.add(key);
    }
  }

  return [...setupNames].sort();
}

function schemaWithInferredWorkflowSetupFields(setupSchema: any[], automation: any) {
  const existing = new Set(
    setupSchema
      .map((field) => canonicalSetupKey(field?.name))
      .filter(Boolean),
  );
  const output = [...setupSchema];

  for (const key of inferSetupKeysFromWorkflow(automation)) {
    if (!key || existing.has(key)) continue;
    const field = inferredSetupField(key);
    if (!field) continue;
    output.push(field);
    existing.add(key);
  }

  return output;
}

function setupFieldNeedsRealTestValue(field: any) {
  const text = [
    field?.name,
    field?.label,
    field?.placeholder,
    field?.description,
  ].map((value) => cleanString(value).toLowerCase()).join(" ");

  const signals = [
    "spreadsheet",
    "google sheet",
    "sheet url",
    "sheet id",
    "sheet tab",
    "sheet name",
    "sheet range",
    "cell range",
    "worksheet",
    "tab name",
    "google drive",
    "drive file",
    "drive folder",
    "folder id",
    "folder url",
    "document id",
  ];

  return signals.some((signal) => text.includes(signal));
}

function realTestFieldLabel(field: any) {
  return cleanString(field?.label || field?.name || "setup field");
}

function missingRealTestFields(setupSchema: any[], testProfile: any) {
  const savedSetup = asObject(testProfile?.setup_values);
  return setupSchema
    .filter(setupFieldNeedsRealTestValue)
    .filter((field) => {
      const key = cleanString(field?.name);
      if (!key) return false;
      return !cleanString(savedSetup[key]);
    })
    .map(realTestFieldLabel);
}

function buildSetupFromSchema(setupSchema: any[]) {
  const setup: Record<string, unknown> = {};

  for (const field of setupSchema) {
    const key = cleanString(field?.name);
    if (!key) continue;
    const value = testValueForField(field);
    setup[key] = value;
    addSetupAliasesForValue(setup, key, value);
    if (field?.label) addSetupAliasesForValue(setup, cleanString(field.label), value);
  }

  return expandBuyerSetupAliases(setup);
}

function buildSecretsFromSchema(credentialSchema: any[]) {
  const secrets: Record<string, string> = {};

  for (const field of credentialSchema) {
    const key = cleanString(field?.name);
    if (!key) continue;
    secrets[key] = "NEXUS_TEST_SECRET_VALUE";
  }

  return secrets;
}

function mergeObjectValues(base: Record<string, unknown>, override: unknown) {
  const cleanOverride = asObject(override);
  return {
    ...(base || {}),
    ...cleanOverride,
  };
}

function sheetAccessConfigFromAutomation(automation: any) {
  const detected = asObject(automation?.detected_placeholders);
  const config = asObject(detected._nexus_sheet_access_config || automation?.sheet_access_config);
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

function applySheetAccessSetup(setup: Record<string, unknown>, automation: any) {
  const config = sheetAccessConfigFromAutomation(automation);
  const output = { ...(setup || {}) };

  if (config.mode === "developer_owned" && config.developer_sheet_id) {
    assignIfUseful(output, "nexus_dev_sheet_id", config.developer_sheet_id);
    assignIfUseful(output, "google_sheet_id", config.developer_sheet_id);
    assignIfUseful(output, "google_sheet_url", config.developer_sheet_id);
  }

  if (config.mode === "private_per_customer" && config.template_sheet_id) {
    /*
      Technical tests use the template sheet as the stand-in target.
      Live provisioning can replace nexus_private_customer_sheet_id
      with a copied per-customer sheet before runtime execution.
    */
    assignIfUseful(output, "nexus_private_sheet_template_id", config.template_sheet_id);
    assignIfUseful(output, "nexus_private_customer_sheet_id", config.template_sheet_id);
    assignIfUseful(output, "google_sheet_id", config.template_sheet_id);
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

async function loadDefaultTestProfile(adminClient: any, automationId: string) {
  if (!automationId) return null;

  const { data, error } = await adminClient
    .from("automation_test_profiles")
    .select("*")
    .eq("automation_id", automationId)
    .eq("is_default", true)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    /*
      Do not break technical tests if the profile table has not been added yet.
      The function falls back to generated fake values.
    */
    const message = String(error.message || "").toLowerCase();

    if (
      message.includes("automation_test_profiles") ||
      message.includes("does not exist") ||
      message.includes("schema cache")
    ) {
      console.warn("automation_test_profiles unavailable; using generated test values:", error.message);
      return null;
    }

    throw new Error(`Could not load automation test profile: ${error.message}`);
  }

  return data || null;
}

function buildTestSetupAndSecrets(automation: any, testProfile: any) {
  const setupSchema = schemaWithInferredWorkflowSetupFields(normalizeSchema(automation.setup_schema), automation);
  const credentialSchema = normalizeSchema(automation.credential_schema);
  const missingRealFields = missingRealTestFields(setupSchema, testProfile);

  if (missingRealFields.length) {
    throw new Error(
      `This workflow needs real technical test data before Nexus can run it. Save real values for: ${missingRealFields.join(", ")}. For Google Sheets or Drive, the saved service account must have access to the exact sheet, tab, file, or range used in the test.`,
    );
  }

  const generatedSetup = buildSetupFromSchema(setupSchema);
  const generatedSecrets = buildSecretsFromSchema(credentialSchema);

  if (!testProfile) {
    return {
      setup: applySheetAccessSetup(generatedSetup, automation),
      secrets: generatedSecrets,
      used_test_profile: false,
      test_profile_id: null,
      test_profile_name: null,
    };
  }

  /*
    Merge generated defaults with saved profile values.
    Saved profile values win. Generated values keep optional/missing
    workflow fields from becoming undefined during early testing.
  */
  return {
    setup: applySheetAccessSetup(mergeObjectValues(generatedSetup, testProfile.setup_values), automation),
    secrets: mergeObjectValues(generatedSecrets, testProfile.secret_values) as Record<string, string>,
    used_test_profile: true,
    test_profile_id: testProfile.id || null,
    test_profile_name: testProfile.name || "Default test profile",
  };
}

function buildCallbackUrl() {
  const supabaseUrl = cleanBaseUrl(env("SUPABASE_URL"));
  return `${supabaseUrl}/functions/v1/runtime-submit-output`;
}

async function n8nFetch(path: string, options: RequestInit = {}) {
  const baseUrl = cleanBaseUrl(env("N8N_BASE_URL"));
  const apiKey = env("N8N_API_KEY");

  if (!baseUrl || !apiKey) {
    throw new Error("Missing N8N_BASE_URL or N8N_API_KEY Supabase secrets.");
  }

  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
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
    data = {
      raw: text,
    };
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

async function getExecutionById(executionId: string) {
  if (!executionId) return null;
  return await n8nFetch(`/api/v1/executions/${encodeURIComponent(executionId)}?includeData=true`);
}

async function activateWorkflow(workflowId: string) {
  if (!workflowId) return null;
  return await n8nFetch(`/api/v1/workflows/${encodeURIComponent(workflowId)}/activate`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

async function deactivateWorkflow(workflowId: string) {
  if (!workflowId) return null;
  return await n8nFetch(`/api/v1/workflows/${encodeURIComponent(workflowId)}/deactivate`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

function shouldDeactivateAfterTechnicalTest(automation: any) {
  return !["active", "published"].includes(cleanString(automation?.status).toLowerCase());
}

async function listRecentExecutions(workflowId: string) {
  const encodedWorkflowId = encodeURIComponent(workflowId);
  const data = await n8nFetch(`/api/v1/executions?workflowId=${encodedWorkflowId}&limit=25`);

  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data)) return data;

  return [];
}

function executionTimestamp(execution: any) {
  const raw =
    execution?.startedAt ||
    execution?.stoppedAt ||
    execution?.createdAt ||
    execution?.created_at ||
    execution?.finishedAt ||
    "";

  const time = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function executionIdOf(execution: any) {
  return cleanString(execution?.id || execution?.executionId || execution?.execution_id);
}

function resultDataOf(execution: any) {
  return asObject(
    execution?.data?.resultData ||
      execution?.data?.executionData?.resultData ||
      execution?.resultData,
  );
}

function errorMessageFromObject(error: any) {
  const safe = asObject(error);
  const cause = asObject(safe.cause);
  const context = asObject(safe.context);

  return pickFirstUsefulString(
    safe.message,
    safe.description,
    safe.errorMessage,
    safe.reason,
    cause.message,
    cause.description,
    context.message,
    context.description,
    typeof error === "string" ? error : "",
    stringifySafe(error),
  );
}

function extractKnownN8nErrorText(value: unknown) {
  const raw = stringifySafe(value)
    .replace(/\\"/g, '"')
    .replace(/\\n/g, "\n");
  const forbidden = raw.match(/Forbidden\s+-\s+perhaps check your credentials\??/i);
  const modelAccess = raw.match(/Project\s+[A-Za-z0-9_-]+\s+does not have access to model\s+[A-Za-z0-9_.:-]+/i);
  const incorrectKey = raw.match(/Incorrect API key provided:\s*[^.\n\r"]+/i);

  if (forbidden && modelAccess) return `${forbidden[0]} ${modelAccess[0]}`;
  if (modelAccess) return modelAccess[0];
  if (incorrectKey) return incorrectKey[0];

  const patterns = [
    /Credential with ID\s+"[^"]+"\s+does not exist for type\s+"[^"]+"/i,
    /Project\s+[A-Za-z0-9_-]+\s+does not have access to model\s+[A-Za-z0-9_.:-]+/i,
    /Incorrect API key provided:\s*[^.\n\r"]+/i,
    /Forbidden\s+-\s+perhaps check your credentials\??/i,
    /Authorization failed\s+-\s+please check your credentials[^"\n\r]*(?:Missing authorization header)?/i,
    /Input is not valid:\s*[^"\n\r]+/i,
    /Values in input\.[^"\n\r]+/i,
    /config\.headers\.setContentType is not a function/i,
    /Missing authorization header/i,
    /UNAUTHORIZED_NO_AUTH_HEADER/i,
    /NodeOperationError:\s*([^\n\r]+)/i,
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const message = usefulString(match?.[1] || match?.[0]);
    if (message) return message;
  }

  return "";
}

function extractRunDataError(resultData: Record<string, unknown>) {
  const runData = asObject(resultData.runData);

  for (const [nodeName, entries] of Object.entries(runData)) {
    const nodeExecutions = Array.isArray(entries) ? entries : [entries];

    for (const entry of nodeExecutions) {
      const safeEntry = asObject(entry);
      const error = safeEntry.error;
      const message = errorMessageFromObject(error);

      if (message) {
        const safeError = asObject(error);
        const node = asObject(safeError.node);

        return {
          message,
          node: pickFirstUsefulString(node.name, safeError.nodeName, nodeName),
          node_type: pickFirstUsefulString(node.type, safeError.nodeType, safeEntry.nodeType),
          raw_error: error || {},
        };
      }
    }
  }

  return null;
}

function extractItemErrorMessage(value: unknown) {
  const item = asObject(value);
  const json = asObject(item.json || item);
  const error = json.error || item.error;
  const errorObject = asObject(error);
  const message = pickFirstUsefulString(
    errorObject.message,
    errorObject.description,
    errorObject.errorMessage,
    errorObject.reason,
    json.message,
    json.error_message,
    json.errorMessage,
    typeof error === "string" ? error : "",
  );

  if (!message) return "";

  const hasErrorShape = Boolean(
    error ||
      json.error ||
      json.error_message ||
      json.errorMessage ||
      errorObject.name ||
      errorObject.code ||
      errorObject.status,
  );

  return hasErrorShape ? message : "";
}

function extractRunDataOutputError(resultData: Record<string, unknown>) {
  const runData = asObject(resultData.runData);

  for (const [nodeName, entries] of Object.entries(runData)) {
    const nodeExecutions = Array.isArray(entries) ? entries : [entries];

    for (const entry of nodeExecutions) {
      const safeEntry = asObject(entry);
      const main = Array.isArray(asObject(safeEntry.data).main) ? asObject(safeEntry.data).main : [];

      for (const output of main) {
        const outputItems = Array.isArray(output) ? output : [output];
        for (const item of outputItems) {
          const message = extractItemErrorMessage(item);
          if (message) {
            return {
              message,
              node: pickFirstUsefulString(nodeName, safeEntry.nodeName),
              node_type: pickFirstUsefulString(safeEntry.nodeType),
              raw_error: asObject(item).json || item || {},
            };
          }
        }
      }
    }
  }

  return null;
}

function friendlyExecutionErrorMessage(message: string, nodeName: string, nodeType: string) {
  const cleanMessage = cleanString(message);
  if (!cleanMessage) return "";

  const combined = lower(`${cleanMessage} ${nodeName} ${nodeType}`);
  const isResourceNotFound =
    combined.includes("resource you are requesting could not be found") ||
    combined.includes("resource could not be found") ||
    combined.includes("requested resource") && combined.includes("not found");
  const isGoogleSheetsNode =
    combined.includes("googlesheets") ||
    combined.includes("google sheets") ||
    combined.includes("google sheet") ||
    combined.includes("spreadsheet");
  const isApifyNode =
    combined.includes("apify") ||
    combined.includes("api.apify.com") ||
    combined.includes("apify.com");
  const isApifyMaxCostTooLow =
    combined.includes("max-total-charge-usd-below-minimum") ||
    combined.includes("maximum cost per run is less than") ||
    combined.includes("maxtotalchargeusd") ||
    combined.includes("max total charge");
  const isInvalidProviderInput =
    combined.includes("invalid-input") ||
    combined.includes("input is not valid") ||
    combined.includes("input.directurls") ||
    combined.includes("directurls");

  if (isApifyNode && isApifyMaxCostTooLow) {
    return [
      "Apify rejected this run because the workflow sets the maximum cost per run below Apify's minimum of $0.50.",
      "Set the Nexus setup/test field max_apify_cost_usd to 0.50 or higher, or update the Apify HTTP node parameter maxTotalChargeUsd to 0.50 or higher.",
      "This is not a Nexus Submit Output problem; the output node only surfaced Apify's response.",
      "After changing the value, sync the workflow and run the technical check again.",
      `Original n8n error: ${cleanMessage}`,
    ].join(" ");
  }

  if (isApifyNode && isInvalidProviderInput) {
    return [
      "Apify rejected the workflow test input, not the saved Apify credential.",
      "The Apify key is bound, but the URL or directUrls value sent to the actor is invalid for this node.",
      "Check the buyer setup fields or technical test data for the affected Instagram, TikTok, or Facebook URL, then run the check again.",
      `Original n8n error: ${cleanMessage}`,
    ].join(" ");
  }

  if (isResourceNotFound && isGoogleSheetsNode) {
    return [
      "Google Sheets could not find the spreadsheet, sheet tab, or range used by this node.",
      "Check the Sheet ID/URL and tab/range in the workflow node or Nexus buyer setup fields.",
      "If this workflow uses a Google Service Account, share the target Google Sheet with the service-account email saved in Nexus credentials, then Sync changes and Run check again.",
      `Original n8n error: ${cleanMessage}`,
    ].join(" ");
  }

  if (combined.includes("forbidden") && isGoogleSheetsNode) {
    return [
      "Google Sheets rejected the saved credential for this spreadsheet.",
      "If this uses a Google Service Account, share the target Google Sheet with the service-account email saved in Nexus credentials.",
      "Then confirm the Sheet ID/URL, tab, and range in the workflow node or Nexus technical test data, sync changes, and run the check again.",
      `Original n8n error: ${cleanMessage}`,
    ].join(" ");
  }

  return cleanMessage;
}

function formatExecutionErrorMessage(message: string, nodeName: string, nodeType: string) {
  const friendlyMessage = friendlyExecutionErrorMessage(message, nodeName, nodeType);
  if (!friendlyMessage) return "";

  const parts = [friendlyMessage];
  const nodeParts = [nodeName, nodeType].filter(Boolean).join(" / ");

  if (nodeParts) {
    parts.push(`Node: ${nodeParts}`);
  }

  return parts.join(" ");
}

function extractExecutionError(execution: any) {
  const resultData = resultDataOf(execution);
  const error =
    resultData.error ||
    execution?.error ||
    execution?.data?.error ||
    null;

  const runDataError = extractRunDataError(resultData);
  const outputError = extractRunDataOutputError(resultData);
  const status = cleanString(execution?.status).toLowerCase();
  const shouldScanRawErrorText = Boolean(error || runDataError || outputError || ["error", "failed", "crashed"].includes(status));

  const node = asObject(asObject(error).node);
  const lastNodeExecuted = pickFirstUsefulString(
    resultData.lastNodeExecuted,
    execution?.lastNodeExecuted,
    node.name,
    asObject(error).nodeName,
    runDataError?.node,
    outputError?.node,
  );

  const nodeType = pickFirstUsefulString(
    node.type,
    asObject(error).nodeType,
    runDataError?.node_type,
    outputError?.node_type,
  );
  const knownMessage = shouldScanRawErrorText ? pickFirstUsefulString(
    extractKnownN8nErrorText(resultData),
    extractKnownN8nErrorText(execution),
  ) : "";
  const objectMessage = pickFirstUsefulString(
    errorMessageFromObject(error),
    runDataError?.message,
    outputError?.message,
  );
  const message =
    knownMessage && (!objectMessage || knownMessage.length > objectMessage.length)
      ? knownMessage
      : pickFirstUsefulString(objectMessage, knownMessage);

  return {
    message,
    display_message: formatExecutionErrorMessage(message, lastNodeExecuted, nodeType),
    node: lastNodeExecuted,
    node_type: nodeType,
    raw_error: error || runDataError?.raw_error || outputError?.raw_error || {},
  };
}

function hasExecutionError(execution: any) {
  const extracted = extractExecutionError(execution);
  const status = cleanString(execution?.status).toLowerCase();

  return Boolean(extracted.message || extracted.display_message) ||
    status === "error" ||
    status === "failed" ||
    status === "crashed";
}

function executionStatusOf(execution: any) {
  const status = cleanString(
    execution?.status ||
      execution?.finished ||
      execution?.mode ||
      execution?.data?.status,
  ).toLowerCase();

  if (hasExecutionError(execution)) return "error";
  if (status === "true") return "success";
  if (status === "false" && execution?.stoppedAt) return "error";
  if (status === "false") return "running";
  if (execution?.stoppedAt && !hasExecutionError(execution)) return "success";

  return status || "unknown";
}

function usedSavedTestProfile(testRun: any) {
  const webhookResponse = asObject(testRun?.webhook_response);
  return Boolean(
    webhookResponse.used_test_profile ||
      webhookResponse.test_profile_id ||
      testRun?.test_profile_id,
  );
}

function isCredentialAuthFailureText(value: string) {
  const combined = lower(value);
  return (
    combined.includes("missing required credential") ||
    combined.includes("credential with id") ||
    combined.includes("check your credentials") ||
    combined.includes("incorrect api key") ||
    combined.includes("invalid api key") ||
    combined.includes("missing authorization header") ||
    combined.includes("unauthorized") ||
    combined.includes("forbidden") ||
    combined.includes("401") ||
    combined.includes("403")
  );
}

function isExpectedGeneratedSetupDataError(message: string, nodeName: string, nodeType: string, testRun: any) {
  if (usedSavedTestProfile(testRun)) return false;

  const combined = lower(`${message} ${nodeName} ${nodeType}`);
  if (!combined || isCredentialAuthFailureText(combined)) return false;

  const isApifyNode =
    combined.includes("apify") ||
    combined.includes("api.apify.com") ||
    combined.includes("apify.com");

  const looksLikeGeneratedInputRejection =
    combined.includes("invalid-input") ||
    combined.includes("input is not valid") ||
    combined.includes("input.directurls") ||
    combined.includes("directurls") ||
    combined.includes("must match regular expression") ||
    combined.includes("invalid url") ||
    combined.includes("url is invalid") ||
    combined.includes("only absolute urls are supported");

  const isSocialUrlShapeRejection =
    looksLikeGeneratedInputRejection &&
    (
      combined.includes("instagram") ||
      combined.includes("tiktok") ||
      combined.includes("facebook") ||
      combined.includes("directurl")
    );

  return looksLikeGeneratedInputRejection && (isApifyNode || isSocialUrlShapeRejection);
}

function classifyExecution(execution: any, testRun: any = null) {
  const status = executionStatusOf(execution);
  const extractedError = extractExecutionError(execution);
  const rawMessage = extractedError.message || "";
  const message = extractedError.display_message || rawMessage || "";
  const lower = message.toLowerCase();

  /*
    If workflow reaches runtime-submit-output with fake customer ID,
    callback may reject the fake ID. That means the workflow reached
    Nexus output callback, so the technical route is working.
  */
  const reachedNexusCallback =
    lower.includes("customer automation not found") ||
    lower.includes("customer_automation") ||
    lower.includes("runtime-submit-output");

  if (lower.includes("missing authorization header") || lower.includes("unauthorized_no_auth_header")) {
    return {
      ok: false,
      status: "failed",
      message:
        "Nexus output callback was blocked by Supabase before runtime-submit-output could run. Deploy runtime-submit-output with verify_jwt=false.",
      error_node: extractedError.node || "Nexus Submit Output",
      error_node_type: extractedError.node_type,
      error_message: rawMessage || message || "Missing authorization header.",
      raw_error: extractedError.raw_error,
    };
  }

  if (reachedNexusCallback) {
    return {
      ok: true,
      status: "passed_with_expected_test_callback_error",
      message:
        "Workflow reached the Nexus output callback. The callback rejected the fake test customer automation ID, which is expected in a technical test.",
      error_node: extractedError.node,
      error_node_type: extractedError.node_type,
      error_message: rawMessage || message,
      raw_error: extractedError.raw_error,
    };
  }

  if (isExpectedGeneratedSetupDataError(rawMessage || message, extractedError.node, extractedError.node_type, testRun)) {
    return {
      ok: true,
      status: "passed_with_expected_test_input_error",
      message:
        "Structural technical check passed. Nexus confirmed the workflow started, credentials were mapped, and n8n reached the provider. The provider rejected generated placeholder test data, which is expected when no real technical test profile is saved.",
      error_node: extractedError.node,
      error_node_type: extractedError.node_type,
      error_message: rawMessage || message,
      raw_error: extractedError.raw_error,
    };
  }

  if (hasExecutionError(execution)) {
    return {
      ok: false,
      status: "failed",
      message: message || "n8n execution failed.",
      error_node: extractedError.node,
      error_node_type: extractedError.node_type,
      error_message: message || "n8n execution failed.",
      raw_error: extractedError.raw_error,
    };
  }

  if (status === "success" || status === "completed") {
    return {
      ok: true,
      status: "passed",
      message: "n8n execution completed successfully.",
      error_node: "",
      error_message: "",
      raw_error: {},
    };
  }

  return {
    ok: true,
    status: "running",
    message: `n8n execution is still ${status}.`,
    error_node: "",
    error_message: "",
    raw_error: {},
  };
}

async function triggerWorkflow(webhookUrl: string, automation: any, testRun: any, testProfile: any = null) {
  const testData = buildTestSetupAndSecrets(automation, testProfile);

  const setup = testData.setup;
  const secrets = testData.secrets;
  const runtimeSecret = env("NEXUS_RUNTIME_SECRET");

  const payload = {
    status: "test",
    test_mode: true,
    test_id: testRun.test_id,
    test_run_id: testRun.id,
    used_test_profile: testData.used_test_profile,
    test_profile_id: testData.test_profile_id,
    test_profile_name: testData.test_profile_name,

    customer_automation_id: `TEST_ADMIN_RUN_${testRun.test_id}`,
    automation_id: automation.id,
    order_id: `TEST_ORDER_${testRun.test_id}`,
    buyer_id: `TEST_BUYER_${testRun.test_id}`,

    setup,
    secrets,

    customer: {
      id: `TEST_BUYER_${testRun.test_id}`,
      email: "admin-test@nexus.local",
      name: "Nexus Admin Test",
      order_id: `TEST_ORDER_${testRun.test_id}`,
    },

    system: {
      test_mode: true,
      test_id: testRun.test_id,
      test_run_id: testRun.id,
      customer_automation_id: `TEST_ADMIN_RUN_${testRun.test_id}`,
      automation_id: automation.id,
      order_id: `TEST_ORDER_${testRun.test_id}`,
      buyer_id: `TEST_BUYER_${testRun.test_id}`,
      callback_url: buildCallbackUrl(),
      runtime_secret: runtimeSecret,
      runtime_type: automation.runtime_type || "n8n_managed",
      n8n_workflow_id: automation.n8n_workflow_id || "",
      used_test_profile: testData.used_test_profile,
      test_profile_id: testData.test_profile_id,
      test_profile_name: testData.test_profile_name,
    },
  };

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-nexus-runtime-secret": runtimeSecret,
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let data: any = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {
      raw: text,
    };
  }

  if (!response.ok) {
    throw new Error(
      data?.message ||
        data?.error ||
        data?.raw ||
        `n8n test webhook failed with status ${response.status}`,
    );
  }

  return {
    response: data,
    execution_id: pickFirstString(data?.executionId, data?.execution_id, data?.data?.executionId, data?.id),
  };
}

async function findExecutionForTestRun(testRun: any) {
  if (testRun.n8n_execution_id) {
    const byId = await getExecutionById(testRun.n8n_execution_id).catch(() => null);
    if (byId) return byId;
  }

  const workflowId = cleanString(testRun.n8n_workflow_id);
  if (!workflowId) return null;

  const startedAtMs = testRun.started_at
    ? new Date(testRun.started_at).getTime()
    : Date.now() - 60_000;

  const recent = await listRecentExecutions(workflowId);
  const candidates = recent
    .filter((execution: any) => {
      const ts = executionTimestamp(execution);
      return !ts || ts >= startedAtMs - 20_000;
    })
    .sort((a: any, b: any) => executionTimestamp(b) - executionTimestamp(a));

  if (!candidates.length) return null;

  /*
    Fetch details. Prefer executions whose full data includes this test_id.
    This is important when multiple tests/customers run the same workflow.
  */
  const detailed: any[] = [];

  for (const candidate of candidates.slice(0, 8)) {
    const id = executionIdOf(candidate);
    const full = id ? await getExecutionById(id).catch(() => candidate) : candidate;
    detailed.push(full);
  }

  const exactMatch = detailed.find((execution) => {
    const raw = stringifySafe(execution);
    return raw.includes(testRun.test_id) || raw.includes(testRun.id);
  });

  return exactMatch || detailed[0] || candidates[0];
}

function isPassingWorkflowTestStatus(status: unknown) {
  return ["passed", "passed_with_expected_test_callback_error", "passed_with_expected_test_input_error"].includes(lower(status));
}

async function validateReusableImportMappings(adminClient: any, automationId: string, result: any) {
  if (!isPassingWorkflowTestStatus(result?.status)) return;

  let automation: any = null;
  try {
    automation = await loadAutomation(adminClient, automationId);
  } catch (error) {
    console.warn("Could not load automation for reusable import mapping validation:", error);
    return;
  }

  const platform = sourcePlatform(automation.workflow_source_platform);
  if (!platform) return;

  const sessionId = cleanString(automation.make_import_session_id);
  if (!sessionId) return;

  const { data: session, error } = await adminClient
    .from("workflow_import_sessions")
    .select("id, source_platform, resolved_groups")
    .eq("id", sessionId)
    .maybeSingle();

  if (error || !session) {
    console.warn("Could not load import session for reusable mapping validation:", error?.message || "session not found");
    return;
  }

  const normalizedPlatform = sourcePlatform(session.source_platform || platform);
  if (!normalizedPlatform) return;

  const mappingIds = Array.from(new Set(
    asArray(session.resolved_groups)
      .filter((group) => cleanString(group.target_strategy) === "http_request")
      .map((group) => cleanString(group.mapping_id))
      .filter((id) => id && !id.startsWith("builtin:")),
  ));

  if (!mappingIds.length) return;

  const now = new Date().toISOString();
  const { data: promoted, error: updateError } = await adminClient
    .from("workflow_node_mappings")
    .update({
      status: "validated",
      scope: "global",
      confidence: "high",
      validated_by_automation_id: automation.id,
      last_validated_at: now,
      updated_at: now,
    })
    .eq("source_platform", normalizedPlatform)
    .in("id", mappingIds)
    .neq("status", "disabled")
    .select("id");

  if (updateError) {
    console.warn("Could not validate reusable import mappings:", updateError.message);
    return;
  }

  const promotedIds = new Set((promoted || []).map((row: any) => cleanString(row.id)).filter(Boolean));
  if (!promotedIds.size) return;

  const resolvedGroups = asArray(session.resolved_groups).map((group) => {
    const mappingId = cleanString(group.mapping_id);
    if (!promotedIds.has(mappingId)) return group;
    return {
      ...group,
      mapping_status: "validated",
      mapping_validated: true,
      needs_validation: false,
    };
  });

  const { error: sessionUpdateError } = await adminClient
    .from("workflow_import_sessions")
    .update({
      resolved_groups: resolvedGroups,
      updated_at: now,
    })
    .eq("id", session.id);

  if (sessionUpdateError) {
    console.warn("Reusable mappings were promoted, but the import session summary was not refreshed:", sessionUpdateError.message);
  }
}

async function updateAutomationTestResult(adminClient: any, automationId: string, result: any) {
  const storedResult = {
    ...result,
    raw_execution: undefined,
    webhook_response: undefined,
  };
  const now = new Date().toISOString();
  const status = cleanString(result.status || "");
  const terminal = isTerminalStatus(status);
  const passed = isPassingWorkflowTestStatus(status);
  const failed = terminal && !passed;
  let automation: any = null;

  try {
    automation = await loadAutomation(adminClient, automationId);
  } catch (error) {
    console.warn("Could not load automation before updating test health:", error instanceof Error ? error.message : error);
  }

  const healthPatch: Record<string, unknown> = terminal
    ? passed
      ? {
          health_status: "healthy",
          health_last_checked_at: now,
          health_last_passed_at: now,
          health_last_failed_at: null,
          health_failure_reason: null,
          health_failure_details: {},
          health_consecutive_failures: 0,
          health_next_check_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
        }
      : {
          health_status: lower(automation?.status) === "live" ? "paused_by_health_check" : "failed",
          health_last_checked_at: now,
          health_last_failed_at: now,
          health_failure_reason: result.error_message || result.message || "Technical workflow check failed.",
          health_failure_details: storedResult,
          health_consecutive_failures: Number(automation?.health_consecutive_failures || 0) + 1,
          health_next_check_at: null,
        }
    : {
        health_status: "needs_recheck",
        health_failure_reason: "Technical workflow check is running.",
        health_failure_details: storedResult,
        health_next_check_at: null,
      };

  if (failed && lower(automation?.status) === "live") {
    healthPatch.status = "paused";
    healthPatch.health_auto_paused_at = now;
    healthPatch.health_previous_status = "live";
    healthPatch.internal_notes = `${cleanString(automation?.internal_notes)}${automation?.internal_notes ? "\n\n" : ""}[${now}] Auto-paused after failed technical workflow check: ${healthPatch.health_failure_reason}`;
  }

  const { error } = await adminClient
    .from("automations")
    .update({
      n8n_last_test_status: result.status,
      n8n_last_test_error: result.ok ? null : result.error_message || result.message,
      n8n_last_test_result: storedResult,
      n8n_last_tested_at: now,
      ...healthPatch,
      updated_at: now,
    })
    .eq("id", automationId);

  if (error) {
    console.warn("Could not update automations test columns:", error.message);
  }

  await validateReusableImportMappings(adminClient, automationId, result);
}

async function updateTestRun(adminClient: any, testRunId: string, updates: Record<string, unknown>) {
  const { data, error } = await adminClient
    .from("automation_test_runs")
    .update({
      ...updates,
      updated_at: new Date().toISOString(),
    })
    .eq("id", testRunId)
    .select()
    .single();

  if (error) {
    /*
      Older MVP databases may have an automation_test_runs table that is missing
      newer audit columns or stricter status constraints. Do not let that break
      the dashboard poll after n8n already finished. Return a synthetic merged row
      so the caller can still update automations.n8n_last_test_status and respond.
    */
    console.warn("Could not update automation test run:", error.message);

    const { data: existing } = await adminClient
      .from("automation_test_runs")
      .select("*")
      .eq("id", testRunId)
      .maybeSingle();

    return {
      ...(existing || { id: testRunId }),
      ...updates,
      updated_at: new Date().toISOString(),
      _update_warning: error.message,
    };
  }

  return data;
}

async function loadAutomation(adminClient: any, automationId: string) {
  const { data, error } = await adminClient
    .from("automations")
    .select("*")
    .eq("id", automationId)
    .maybeSingle();

  if (error || !data) {
    throw new Error(error?.message || "Automation not found.");
  }

  return data;
}

async function loadTestRun(adminClient: any, body: any) {
  const testRunId = cleanString(body.test_run_id || body.testRunId);
  const automationId = cleanString(body.automation_id || body.automationId);

  let query = adminClient.from("automation_test_runs").select("*");

  if (testRunId) {
    query = query.eq("id", testRunId);
  } else if (automationId) {
    query = query.eq("automation_id", automationId).order("created_at", { ascending: false }).limit(1);
  } else {
    throw new Error("test_run_id or automation_id is required.");
  }

  const { data, error } = testRunId
    ? await query.maybeSingle()
    : await query.maybeSingle();

  if (error || !data) {
    throw new Error(error?.message || "No test run found.");
  }

  return data;
}

function publicRunPayload(testRun: any, extra: Record<string, unknown> = {}) {
  const elapsedSeconds = testRun.started_at
    ? Math.max(0, Math.round((Date.now() - new Date(testRun.started_at).getTime()) / 1000))
    : Number(testRun.elapsed_seconds || 0);
  const webhookResponse = asObject(testRun.webhook_response);
  const usedTestProfile = Boolean(
    webhookResponse.used_test_profile ||
      webhookResponse.test_profile_id ||
      testRun.test_profile_id,
  );

  return {
    ok: !["failed", "execution_not_found_after_timeout", "timeout"].includes(cleanString(testRun.status)),
    status: testRun.status,
    test_run_id: testRun.id,
    test_id: testRun.test_id,
    automation_id: testRun.automation_id,
    workflow_id: testRun.n8n_workflow_id,
    execution_id: testRun.n8n_execution_id,
    elapsed_seconds: Number(testRun.elapsed_seconds || elapsedSeconds),
    started_at: testRun.started_at,
    finished_at: testRun.finished_at,
    last_checked_at: testRun.last_checked_at,
    error_node: testRun.error_node,
    error_message: testRun.error_message,
    used_test_profile: usedTestProfile,
    test_profile_id: webhookResponse.test_profile_id || testRun.test_profile_id || null,
    test_profile_name: webhookResponse.test_profile_name || testRun.test_profile_name || null,
    message:
      testRun.error_message ||
      (testRun.status === "running"
        ? "Technical test is still running."
        : `Technical test status: ${testRun.status}`),
    raw_execution: testRun.raw_execution || {},
    webhook_response: testRun.webhook_response || {},
    ...extra,
  };
}

async function startTestRun(adminClient: any, automation: any, userId: string, options: Record<string, unknown> = {}) {
  const workflowId = cleanString(automation.n8n_workflow_id);
  const webhookUrl = pickFirstString(automation.runtime_webhook_url, automation.n8n_webhook_url);
  const forceNew = Boolean(options.force_new || options.forceNew);

  if (!workflowId) {
    throw new Error("This automation has no n8n_workflow_id. Import the workflow first.");
  }

  if (!webhookUrl) {
    throw new Error("This automation has no runtime webhook URL. Import the workflow first.");
  }

  if (!forceNew) {
    /*
      If a test is already running, return it instead of starting another.
      Credential updates pass force_new so every key change gets its own run.
    */
    const { data: existingRunning } = await adminClient
      .from("automation_test_runs")
      .select("*")
      .eq("automation_id", automation.id)
      .eq("status", "running")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existingRunning) {
      return publicRunPayload(existingRunning, {
        reused_existing_run: true,
        message: "A technical test is already running. Nexus resumed the existing run instead of starting a new one.",
      });
    }
  }

  const now = new Date().toISOString();
  const testId = crypto.randomUUID();

  const { data: testRun, error } = await adminClient
    .from("automation_test_runs")
    .insert({
      automation_id: automation.id,
      developer_id: automation.developer_id || null,
      test_id: testId,
      n8n_workflow_id: workflowId,
      status: "running",
      started_at: now,
      last_checked_at: now,
      elapsed_seconds: 0,
      created_by: userId || null,
      created_at: now,
      updated_at: now,
    })
    .select()
    .single();

  if (error || !testRun) {
    throw new Error(error?.message || "Could not create automation test run.");
  }

  const deactivateAfterTest = shouldDeactivateAfterTechnicalTest(automation);
  let activationResult: unknown = null;
  let deactivationResult: unknown = null;

  try {
    const workflowInput = automation.n8n_normalized_workflow_json || automation.n8n_workflow_json;
    const workflowJsonColumn = automation.n8n_normalized_workflow_json
      ? "n8n_normalized_workflow_json"
      : "n8n_workflow_json";
    const credentialBinding = await bindAutomationCredentials({
      adminClient,
      product: automation,
      n8nBaseUrl: cleanBaseUrl(env("N8N_BASE_URL")),
      n8nApiKey: env("N8N_API_KEY"),
      credentialSecret: env("NEXUS_CREDENTIAL_SECRET"),
      syncMissingN8nCredentials: true,
      workflowInput,
      workflowJsonColumn,
      updateHostedWorkflow: true,
      allowExistingNativeN8nCredentials: true,
    });

    if (!credentialBinding.ok) {
      const firstError = credentialBinding.errors?.[0]?.message;
      throw new Error(
        firstError ||
          "Add or sync the required developer credentials, then run the technical check again.",
      );
    }

    if (deactivateAfterTest) {
      activationResult = await activateWorkflow(workflowId);
    }

    const testProfile = await loadDefaultTestProfile(adminClient, automation.id);
    const trigger = await triggerWorkflow(webhookUrl, automation, testRun, testProfile);

    if (deactivateAfterTest) {
      try {
        deactivationResult = await deactivateWorkflow(workflowId);
      } catch (deactivationError) {
        deactivationResult = {
          warning: deactivationError instanceof Error ? deactivationError.message : String(deactivationError),
        };
      }
    }

    const updated = await updateTestRun(adminClient, testRun.id, {
      webhook_response: {
        ...(trigger.response || {}),
        used_test_profile: Boolean(testProfile?.id),
        test_profile_id: testProfile?.id || null,
        test_profile_name: testProfile?.name || null,
        temporary_activation: deactivateAfterTest,
        activation_result: activationResult,
        deactivation_result: deactivationResult,
      },
      n8n_execution_id: trigger.execution_id || null,
      last_checked_at: new Date().toISOString(),
    });

    const startResult = publicRunPayload(updated, {
      status: "running",
      used_test_profile: Boolean(testProfile?.id),
      test_profile_id: testProfile?.id || null,
      test_profile_name: testProfile?.name || null,
      message: testProfile?.id
        ? "Technical test started using the saved test profile. Nexus will keep checking the central n8n execution."
        : "Technical test started using generated placeholder values because no test profile is saved yet.",
    });

    await updateAutomationTestResult(adminClient, automation.id, startResult);

    return startResult;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (deactivateAfterTest) {
      try {
        deactivationResult = await deactivateWorkflow(workflowId);
      } catch (deactivationError) {
        deactivationResult = {
          warning: deactivationError instanceof Error ? deactivationError.message : String(deactivationError),
        };
      }
    }

    const failed = await updateTestRun(adminClient, testRun.id, {
      status: "failed",
      finished_at: new Date().toISOString(),
      last_checked_at: new Date().toISOString(),
      error_node: "n8n webhook trigger",
      error_message: message,
      error_details: {
        message,
        temporary_activation: deactivateAfterTest,
        activation_result: activationResult,
        deactivation_result: deactivationResult,
      },
    });

    const result = publicRunPayload(failed, {
      ok: false,
      status: "failed",
      message,
    });

    await updateAutomationTestResult(adminClient, automation.id, result);

    return result;
  }
}

async function checkTestRun(adminClient: any, testRun: any) {
  const now = new Date();
  const elapsedSeconds = testRun.started_at
    ? Math.max(0, Math.round((now.getTime() - new Date(testRun.started_at).getTime()) / 1000))
    : Number(testRun.elapsed_seconds || 0);

  if (isTerminalStatus(testRun.status)) {
    return publicRunPayload(testRun);
  }

  const execution = await findExecutionForTestRun(testRun);

  if (!execution) {
    /*
      Do not fail quickly. Keep it running. If it has been very long,
      make it a clear timeout so dev sees Nexus could not verify it.
    */
    const timeoutSeconds = 60 * 60; // 1 hour

    if (elapsedSeconds >= timeoutSeconds) {
      const timedOut = await updateTestRun(adminClient, testRun.id, {
        status: "execution_not_found_after_timeout",
        finished_at: now.toISOString(),
        last_checked_at: now.toISOString(),
        elapsed_seconds: elapsedSeconds,
        error_message:
          "Nexus triggered the webhook but could not find the matching n8n execution after 1 hour.",
      });

      const result = publicRunPayload(timedOut, {
        ok: false,
      });

      await updateAutomationTestResult(adminClient, testRun.automation_id, result);

      return result;
    }

    const stillRunning = await updateTestRun(adminClient, testRun.id, {
      status: "running",
      last_checked_at: now.toISOString(),
      elapsed_seconds: elapsedSeconds,
    });

    const result = publicRunPayload(stillRunning, {
      ok: true,
      status: "running",
      message:
        "Technical test is still running or waiting for n8n execution history. Nexus will keep checking.",
    });

    await updateAutomationTestResult(adminClient, testRun.automation_id, result);

    return result;
  }

  const executionId = executionIdOf(execution);
  const classified = classifyExecution(execution, testRun);

  if (classified.status === "running") {
    const running = await updateTestRun(adminClient, testRun.id, {
      status: "running",
      n8n_execution_id: executionId || testRun.n8n_execution_id || null,
      last_checked_at: now.toISOString(),
      elapsed_seconds: elapsedSeconds,
      raw_execution: execution,
    });

    const result = publicRunPayload(running, {
      ok: true,
      status: "running",
      message: classified.message,
    });

    await updateAutomationTestResult(adminClient, testRun.automation_id, result);

    return result;
  }

  const finished = await updateTestRun(adminClient, testRun.id, {
    status: classified.status,
    n8n_execution_id: executionId || testRun.n8n_execution_id || null,
    finished_at: now.toISOString(),
    last_checked_at: now.toISOString(),
    elapsed_seconds: elapsedSeconds,
    error_node: classified.error_node || null,
    error_message: classified.ok ? null : classified.error_message || classified.message,
    error_details: classified.raw_error || {},
    raw_execution: execution,
  });

  const result = publicRunPayload(finished, {
    ok: classified.ok,
    status: classified.status,
    message: classified.message,
    error_node: classified.error_node,
    error_node_type: classified.error_node_type,
    error_message: classified.error_message,
  });

  await updateAutomationTestResult(adminClient, testRun.automation_id, result);

  return result;
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
      message: "test-n8n-workflow is alive with persistent start/check/latest modes.",
      modes: ["start", "check", "latest"],
      env: {
        has_n8n_base_url: Boolean(env("N8N_BASE_URL")),
        has_n8n_api_key: Boolean(env("N8N_API_KEY")),
        has_runtime_secret: Boolean(env("NEXUS_RUNTIME_SECRET")),
      },
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed.", 405);
  }

  try {
    const supabaseUrl = env("SUPABASE_URL");
    const anonKey = env("SUPABASE_ANON_KEY");
    const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return errorResponse("Missing Supabase function secrets.", 500);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const runtimeContext = getRuntimeOperatorFromRequest(req);
    const user = runtimeContext ? null : await getUserFromRequest(req, supabaseUrl, anonKey);

    if (!runtimeContext && !user) {
      return errorResponse("Admin login required.", 401);
    }

    const operator = runtimeContext?.operator || await getOperatorContext(adminClient, user!.id);

    if (!operator) {
      return errorResponse("Admin or developer access required.", 403);
    }

    const body = await req.json().catch(() => ({}));
    const mode = cleanString(body.mode || "start").toLowerCase();
    const automationId = cleanString(body.automation_id || body.automationId);

    if (!automationId && mode === "start") {
      return errorResponse("automation_id is required.", 400);
    }

    if (mode === "start") {
      const automation = await loadAutomation(adminClient, automationId);
      if (!canAccessAutomation(operator, automation)) {
        return errorResponse("Developer can only test their own products.", 403);
      }
      const result = await startTestRun(adminClient, automation, runtimeContext ? "" : user!.id, body);
      return jsonResponse(result, 200);
    }

    if (mode === "check" || mode === "latest") {
      const testRun = await loadTestRun(adminClient, body);
      if (!canAccessTestRun(operator, testRun)) {
        return errorResponse("Developer can only check tests for their own products.", 403);
      }
      const result = await checkTestRun(adminClient, testRun);
      return jsonResponse(result, 200);
    }

    return errorResponse("Unsupported mode. Use start, check, or latest.", 400);
  } catch (error) {
    console.error("test-n8n-workflow failed:", error);

    return errorResponse(
      error instanceof Error ? error.message : "Could not test n8n workflow.",
      500,
    );
  }
});
