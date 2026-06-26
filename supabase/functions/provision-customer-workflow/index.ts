import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

function env(name: string) {
  return Deno.env.get(name) || "";
}

function cleanBaseUrl(url: string) {
  return String(url || "").replace(/\/$/, "");
}

function cleanString(value: unknown) {
  return String(value || "").trim();
}

function shortId(value: string) {
  return cleanString(value).split("-")[0] || crypto.randomUUID().split("-")[0];
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

function isMonthlyOrder(order: any) {
  return Boolean(
    order?.stripe_mode === "subscription" ||
      order?.stripe_subscription_id ||
      cleanString(order?.price_display).toLowerCase().includes("/mo"),
  );
}

function monthlyScheduleUpdate(order: any, current: any) {
  if (!isMonthlyOrder(order)) return {};

  if (!subscriptionIsActive(order)) {
    return {
      run_frequency: "monthly",
      schedule_status: "paused",
    };
  }

  return {
    run_frequency: "monthly",
    schedule_status: "active",
    schedule_anchor_at: current?.schedule_anchor_at || new Date().toISOString(),
    next_run_at: current?.next_run_at || new Date().toISOString(),
  };
}

function deepClone(value: any) {
  return JSON.parse(JSON.stringify(value || {}));
}

function asObject(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
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

  return output;
}

function escapeRegExp(value: string) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nodeType(node: any) {
  return String(node?.type || "").toLowerCase();
}

function isWebhookNode(node: any) {
  return nodeType(node).includes("n8n-nodes-base.webhook");
}

function normalizeMappings(value: unknown) {
  if (Array.isArray(value)) return value;

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return [];
}

function normalizeWorkflowForCreate(workflow: any) {
  const cloned = deepClone(workflow);

  const settings = cloned.settings && typeof cloned.settings === "object"
    ? cloned.settings
    : {};

  return {
    name: cleanString(cloned.name || "Nexus Customer Workflow"),
    nodes: Array.isArray(cloned.nodes) ? cloned.nodes : [],
    connections: cloned.connections || {},
    settings: {
      executionOrder: settings.executionOrder || "v1",
    },
    staticData: cloned.staticData || null,
  };
}

function getCustomerValueForMapping(mapping: any, customerValues: Record<string, any>) {
  const sourceRaw = cleanString(mapping?.source).toLowerCase();
  const key = cleanString(mapping?.key);

  if (!key) return "";

  let source = sourceRaw;

  if (
    source === "secret" ||
    source === "credential" ||
    source === "credentials"
  ) {
    source = "secrets";
  }

  const sourceObject = asObject(customerValues[source]);
  const value = sourceObject[key];

  if (value === null || value === undefined) return "";

  return String(value);
}

function replaceMappedPlaceholders(
  text: string,
  customerValues: Record<string, any>,
  mappings: any[],
) {
  let output = String(text || "");

  for (const mapping of mappings || []) {
    const placeholder = String(mapping?.placeholder || "");
    const replacement = getCustomerValueForMapping(mapping, customerValues);

    if (!placeholder || replacement === "") continue;

    output = output.split(placeholder).join(replacement);
  }

  return output;
}

function buildExpressionPatterns(source: string, key: string) {
  const sourceEscaped = escapeRegExp(source);
  const keyEscaped = escapeRegExp(key);

  return [
    /*
      Body-based expressions from current import system:
      {{ $json.body.setup.facebook_page_id }}
      {{ $json.body.secrets.meta_access_token }}
    */
    new RegExp(`=?\\{\\{\\s*\\$json\\.body\\.${sourceEscaped}\\.${keyEscaped}\\s*\\}\\}`, "g"),
    new RegExp(`=?\\{\\{\\s*\\$json\\.body\\?\\.${sourceEscaped}\\?\\.${keyEscaped}\\s*\\}\\}`, "g"),
    new RegExp(`=?\\{\\{\\s*\\$json\\["body"\\]\\["${sourceEscaped}"\\]\\["${keyEscaped}"\\]\\s*\\}\\}`, "g"),
    new RegExp(`=?\\{\\{\\s*\\$json\\['body'\\]\\['${sourceEscaped}'\\]\\['${keyEscaped}'\\]\\s*\\}\\}`, "g"),
    new RegExp(`=?\\{\\{\\s*\\$json\\.body\\["${sourceEscaped}"\\]\\["${keyEscaped}"\\]\\s*\\}\\}`, "g"),
    new RegExp(`=?\\{\\{\\s*\\$json\\.body\\['${sourceEscaped}'\\]\\['${keyEscaped}'\\]\\s*\\}\\}`, "g"),

    /*
      Bodyless expressions from older import versions:
      {{ $json.setup.facebook_page_id }}
      {{ $json.secrets.meta_access_token }}
    */
    new RegExp(`=?\\{\\{\\s*\\$json\\.${sourceEscaped}\\.${keyEscaped}\\s*\\}\\}`, "g"),
    new RegExp(`=?\\{\\{\\s*\\$json\\?\\.${sourceEscaped}\\?\\.${keyEscaped}\\s*\\}\\}`, "g"),
    new RegExp(`=?\\{\\{\\s*\\$json\\["${sourceEscaped}"\\]\\["${keyEscaped}"\\]\\s*\\}\\}`, "g"),
    new RegExp(`=?\\{\\{\\s*\\$json\\['${sourceEscaped}'\\]\\['${keyEscaped}'\\]\\s*\\}\\}`, "g"),

    /*
      Webhook node references:
      {{ $("Nexus Webhook Trigger").item.json.body.setup.facebook_page_id }}
    */
    new RegExp(`=?\\{\\{\\s*\\$\\(["']Nexus Webhook Trigger["']\\)\\.item\\.json\\.body\\.${sourceEscaped}\\.${keyEscaped}\\s*\\}\\}`, "g"),
    new RegExp(`=?\\{\\{\\s*\\$node\\["Nexus Webhook Trigger"\\]\\.json\\.body\\.${sourceEscaped}\\.${keyEscaped}\\s*\\}\\}`, "g"),
    new RegExp(`=?\\{\\{\\s*\\$node\\['Nexus Webhook Trigger'\\]\\.json\\.body\\.${sourceEscaped}\\.${keyEscaped}\\s*\\}\\}`, "g"),

    /*
      Official Nexus placeholders, in case the live master still has them:
      {{NEXUS_SETUP.facebook_page_id}}
      {{NEXUS_SECRET.meta_access_token}}
    */
    new RegExp(`\\{\\{\\s*NEXUS_${source.toUpperCase()}\\.${keyEscaped}\\s*\\}\\}`, "g"),
  ];
}

function replaceDynamicExpressions(
  text: string,
  customerValues: Record<string, any>,
) {
  let output = String(text || "");

  const sourceAliases: Record<string, string[]> = {
    setup: ["setup"],
    secrets: ["secrets", "secret", "credentials", "credential"],
    customer: ["customer"],
    order: ["order"],
    system: ["system"],
  };

  const officialPlaceholderSource: Record<string, string> = {
    setup: "SETUP",
    secrets: "SECRET",
    customer: "CUSTOMER",
    order: "ORDER",
    system: "SYSTEM",
  };

  for (const [canonicalSource, values] of Object.entries(customerValues || {})) {
    const sourceObject = asObject(values);
    const aliases = sourceAliases[canonicalSource] || [canonicalSource];

    for (const [rawKey, rawValue] of Object.entries(sourceObject)) {
      const key = cleanString(rawKey);
      const replacement = String(rawValue ?? "");

      if (!key || replacement === "") continue;

      for (const source of aliases) {
        const patterns = buildExpressionPatterns(source, key);

        for (const pattern of patterns) {
          output = output.replace(pattern, replacement);
        }

        /*
          Replace raw JavaScript references inside Code nodes.
          Example:
          const token = $json.body.secrets.meta_access_token;
          becomes:
          const token = "EAAB...";
        */
        const rawReferences = [
          `$json.body.${source}.${key}`,
          `$json.body?.${source}?.${key}`,
          `$json["body"]["${source}"]["${key}"]`,
          `$json['body']['${source}']['${key}']`,
          `$json.body["${source}"]["${key}"]`,
          `$json.body['${source}']['${key}']`,

          `$json.${source}.${key}`,
          `$json?.${source}?.${key}`,
          `$json["${source}"]["${key}"]`,
          `$json['${source}']['${key}']`,

          `$("Nexus Webhook Trigger").item.json.body.${source}.${key}`,
          `$('Nexus Webhook Trigger').item.json.body.${source}.${key}`,
          `$node["Nexus Webhook Trigger"].json.body.${source}.${key}`,
          `$node['Nexus Webhook Trigger'].json.body.${source}.${key}`,
        ];

        for (const rawReference of rawReferences) {
          output = output.split(rawReference).join(JSON.stringify(replacement));
        }
      }

      /*
        Also replace official Nexus placeholders directly.
      */
      const officialSource = officialPlaceholderSource[canonicalSource];

      if (officialSource) {
        const officialRegex = new RegExp(
          `\\{\\{\\s*NEXUS_${officialSource}\\.${escapeRegExp(key)}\\s*\\}\\}`,
          "g",
        );

        output = output.replace(officialRegex, replacement);
      }
    }
  }

  return output;
}

function hardcodeCustomerValuesIntoWorkflow(
  value: any,
  customerValues: Record<string, any>,
  mappings: any[],
): any {
  if (typeof value === "string") {
    let output = value;

    output = replaceMappedPlaceholders(output, customerValues, mappings);
    output = replaceDynamicExpressions(output, customerValues);

    return output;
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      hardcodeCustomerValuesIntoWorkflow(item, customerValues, mappings)
    );
  }

  if (value && typeof value === "object") {
    const result: Record<string, any> = {};

    for (const [key, child] of Object.entries(value)) {
      result[key] = hardcodeCustomerValuesIntoWorkflow(child, customerValues, mappings);
    }

    return result;
  }

  return value;
}

function updateCustomerWebhookPath(workflow: any, webhookPath: string) {
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];

  const webhookNode =
    nodes.find((node: any) => node?.name === "Nexus Webhook Trigger") ||
    nodes.find(isWebhookNode);

  if (!webhookNode) {
    throw new Error("Master workflow has no Webhook node. Re-import the product workflow first.");
  }

  webhookNode.name = "Nexus Webhook Trigger";

  webhookNode.parameters = {
    ...(webhookNode.parameters || {}),
    httpMethod: "POST",
    path: webhookPath,
    responseMode: "onReceived",
    options: webhookNode.parameters?.options || {},
  };

  return workflow;
}

function ensureSubmitOutputUsesRuntimePayload(workflow: any, callbackUrl: string) {
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const submitNode = nodes.find((node: any) => node?.name === "Nexus Submit Output");

  if (!submitNode) {
    throw new Error("Master workflow has no Nexus Submit Output node. Re-import the product workflow first.");
  }

  /*
    Keep only runtime system fields dynamic.
    Customer setup values and credentials are hardcoded into the customer clone.
  */
  submitNode.parameters = {
    ...(submitNode.parameters || {}),
    method: "POST",
    url: callbackUrl,
    sendHeaders: true,
    headerParameters: {
      parameters: [
        {
          name: "x-nexus-runtime-secret",
          value: "={{ $json.body.system.runtime_secret || $json.system.runtime_secret }}",
        },
      ],
    },
    sendBody: true,
    bodyContentType: "json",
    specifyBody: "json",
    jsonBody:
      "={{ JSON.stringify({ customer_automation_id: $json.body?.customer_automation_id || $json.body?.system?.customer_automation_id || $json.customer_automation_id || $json.system?.customer_automation_id, status: 'success', output_type: $json.output_type || 'report', title: $json.title || 'Automation output', summary: $json.summary || '', content_html: $json.content_html || $json.html || '', content_text: $json.content_text || '', file_url: $json.file_url || '', storage_path: $json.storage_path || '', content_json: $json.content_json || {} }) }}",
    options: submitNode.parameters?.options || {},
  };

  return workflow;
}

function validateCopiedWorkflow(workflow: any) {
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const nodeNames = nodes.map((node: any) => node?.name).filter(Boolean);

  const hasWebhook = Boolean(
    nodes.find((node: any) => node?.name === "Nexus Webhook Trigger") ||
      nodes.find(isWebhookNode),
  );

  const hasFinalOutput = Boolean(nodes.find((node: any) => node?.name === "NEXUS_FINAL_OUTPUT"));
  const hasRuntimeMerge = Boolean(nodes.find((node: any) => node?.name === "Nexus Runtime Merge"));
  const hasSubmitOutput = Boolean(nodes.find((node: any) => node?.name === "Nexus Submit Output"));

  if (!hasWebhook) {
    throw new Error("Copied workflow is missing Nexus Webhook Trigger.");
  }

  if (!hasFinalOutput) {
    throw new Error("Copied workflow is missing NEXUS_FINAL_OUTPUT.");
  }

  if (!hasRuntimeMerge) {
    throw new Error("Copied workflow is missing Nexus Runtime Merge. Re-import the product master workflow first.");
  }

  if (!hasSubmitOutput) {
    throw new Error("Copied workflow is missing Nexus Submit Output.");
  }

  return {
    nodeNames,
    hasWebhook,
    hasFinalOutput,
    hasRuntimeMerge,
    hasSubmitOutput,
  };
}

function inspectRemainingReferences(workflow: any) {
  const text = JSON.stringify(workflow || {});

  return {
    has_original_nexus_brackets: text.includes("[[Nexus_"),
    has_json_body_setup: text.includes("$json.body.setup"),
    has_json_body_secrets: text.includes("$json.body.secrets"),
    has_json_setup: text.includes("$json.setup"),
    has_json_secrets: text.includes("$json.secrets"),
    has_nexus_setup_placeholder: text.includes("NEXUS_SETUP"),
    has_nexus_secret_placeholder: text.includes("NEXUS_SECRET"),
  };
}

async function requireBuyer(req: Request, supabaseUrl: string, anonKey: string) {
  const authHeader = req.headers.get("Authorization") || "";

  if (!authHeader.startsWith("Bearer ")) {
    return { user: null, error: "Missing auth token." };
  }

  const token = authHeader.replace("Bearer ", "");

  const userClient = createClient(supabaseUrl, anonKey, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  });

  const { data, error } = await userClient.auth.getUser(token);

  if (error || !data?.user) {
    return { user: null, error: "Invalid auth token." };
  }

  return {
    user: data.user,
    error: null,
  };
}

async function n8nRequest(
  n8nBaseUrl: string,
  n8nApiKey: string,
  path: string,
  options: RequestInit = {},
) {
  const response = await fetch(`${cleanBaseUrl(n8nBaseUrl)}${path}`, {
    ...options,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "X-N8N-API-KEY": n8nApiKey,
      ...(options.headers || {}),
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

async function getWorkflow(n8nBaseUrl: string, n8nApiKey: string, workflowId: string) {
  return await n8nRequest(n8nBaseUrl, n8nApiKey, `/api/v1/workflows/${workflowId}`, {
    method: "GET",
  });
}

async function createWorkflow(n8nBaseUrl: string, n8nApiKey: string, workflow: any) {
  const cleanWorkflow = normalizeWorkflowForCreate(workflow);

  return await n8nRequest(n8nBaseUrl, n8nApiKey, "/api/v1/workflows", {
    method: "POST",
    body: JSON.stringify(cleanWorkflow),
  });
}

async function updateWorkflow(n8nBaseUrl: string, n8nApiKey: string, workflowId: string, workflow: any) {
  const cleanWorkflow = normalizeWorkflowForCreate(workflow);

  try {
    return await n8nRequest(n8nBaseUrl, n8nApiKey, `/api/v1/workflows/${workflowId}`, {
      method: "PATCH",
      body: JSON.stringify(cleanWorkflow),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error || "");

    if (
      message.includes("404") ||
      message.toLowerCase().includes("not found") ||
      message.toLowerCase().includes("could not find")
    ) {
      throw error;
    }

    return await n8nRequest(n8nBaseUrl, n8nApiKey, `/api/v1/workflows/${workflowId}`, {
      method: "PUT",
      body: JSON.stringify(cleanWorkflow),
    });
  }
}

async function activateWorkflow(n8nBaseUrl: string, n8nApiKey: string, workflowId: string) {
  try {
    return await n8nRequest(n8nBaseUrl, n8nApiKey, `/api/v1/workflows/${workflowId}/activate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";

    if (message.toLowerCase().includes("active")) {
      return {
        ok: true,
        already_active: true,
      };
    }

    throw error;
  }
}

async function loadLatestSetupValues(adminClient: any, customerAutomationId: string) {
  const { data: latestSubmission, error } = await adminClient
    .from("automation_setup_submissions")
    .select("answers")
    .eq("customer_automation_id", customerAutomationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not load latest setup submission: ${error.message}`);
  }

  return asObject(latestSubmission?.answers);
}

async function loadSecretValues(adminClient: any, customerAutomationId: string) {
  const { data: credentialRows, error } = await adminClient
    .from("customer_automation_credentials")
    .select("key, credential_key, value, credential_value, secret_value")
    .eq("customer_automation_id", customerAutomationId);

  if (error) {
    throw new Error(`Could not load customer credentials: ${error.message}`);
  }

  const secretValues: Record<string, string> = {};

  for (const row of credentialRows || []) {
    const key = cleanString(row.key || row.credential_key);
    const value = cleanString(row.value || row.credential_value || row.secret_value);

    if (key && value) {
      secretValues[key] = value;
    }
  }

  return secretValues;
}

function normalizeMatchKey(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .replace(/^nexus/i, "")
    .replace(/[^a-z0-9]/g, "");
}

function collectBracketPlaceholders(value: any, found = new Set<string>()) {
  if (typeof value === "string") {
    const pattern = /\[\[([^\]]+)\]\]/g;
    let match;

    while ((match = pattern.exec(value)) !== null) {
      found.add(`[[${match[1]}]]`);
    }

    return found;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectBracketPlaceholders(item, found));
    return found;
  }

  if (value && typeof value === "object") {
    Object.values(value).forEach((child) => collectBracketPlaceholders(child, found));
  }

  return found;
}

function buildAutoMappingsFromSchemas(workflow: any, product: any) {
  const placeholders = Array.from(collectBracketPlaceholders(workflow));

  const setupSchema = Array.isArray(product.setup_schema) ? product.setup_schema : [];
  const credentialSchema = Array.isArray(product.credential_schema) ? product.credential_schema : [];

  const mappings: any[] = [];

  const setupFields = setupSchema.map((field: any) => ({
    source: "setup",
    key: cleanString(field?.name),
    label: cleanString(field?.label),
    matchKeys: [
      normalizeMatchKey(field?.name),
      normalizeMatchKey(field?.label),
    ].filter(Boolean),
  }));

  const credentialFields = credentialSchema
    .filter((field: any) => cleanString(field?.type).toLowerCase() === "secret")
    .map((field: any) => ({
      source: "secret",
      key: cleanString(field?.name),
      label: cleanString(field?.label),
      matchKeys: [
        normalizeMatchKey(field?.name),
        normalizeMatchKey(field?.label),
      ].filter(Boolean),
    }));

  const allFields = [...setupFields, ...credentialFields];

  for (const placeholder of placeholders) {
    const inside = placeholder.replace(/^\[\[/, "").replace(/\]\]$/, "");
    const normalizedPlaceholder = normalizeMatchKey(inside);

    const matchedField = allFields.find((field) => {
      return field.key && field.matchKeys.some((matchKey) => {
        return normalizedPlaceholder === matchKey ||
          normalizedPlaceholder.endsWith(matchKey) ||
          matchKey.endsWith(normalizedPlaceholder);
      });
    });

    if (matchedField) {
      mappings.push({
        placeholder,
        source: matchedField.source,
        key: matchedField.key,
        auto_detected: true,
      });
    }
  }

  return mappings;
}

function mergeMappings(manualMappings: any[], autoMappings: any[]) {
  const seen = new Set<string>();
  const merged: any[] = [];

  for (const mapping of [...manualMappings, ...autoMappings]) {
    const placeholder = String(mapping?.placeholder || "");
    const source = String(mapping?.source || "");
    const key = String(mapping?.key || "");

    if (!placeholder || !source || !key) continue;

    const id = `${placeholder}::${source}::${key}`;

    if (seen.has(id)) continue;

    seen.add(id);
    merged.push(mapping);
  }

  return merged;
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
      message: "provision-customer-workflow is alive.",
      env: {
        has_supabase_url: Boolean(env("SUPABASE_URL")),
        has_anon_key: Boolean(env("SUPABASE_ANON_KEY")),
        has_service_role: Boolean(env("SUPABASE_SERVICE_ROLE_KEY")),
        has_n8n_base_url: Boolean(env("N8N_BASE_URL")),
        has_n8n_api_key: Boolean(env("N8N_API_KEY")),
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
    const n8nBaseUrl = cleanBaseUrl(env("N8N_BASE_URL"));
    const n8nApiKey = env("N8N_API_KEY");

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return errorResponse("Missing Supabase function secrets.", 500);
    }

    if (!n8nBaseUrl || !n8nApiKey) {
      return errorResponse("Missing N8N_BASE_URL or N8N_API_KEY.", 500);
    }

    const { user, error: authError } = await requireBuyer(req, supabaseUrl, anonKey);

    if (authError || !user) {
      return errorResponse(authError || "Login required.", 401);
    }

    const body = await req.json().catch(() => ({}));
    const customerAutomationId = cleanString(body.customer_automation_id);

    if (!customerAutomationId) {
      return errorResponse("customer_automation_id is required.", 400);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
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

      if (!developerData) {
        return errorResponse("Developer profile not found.", 403);
      }

      developerProfile = developerData;
    }

    let customerAutomationQuery = adminClient
      .from("customer_automations")
      .select(`
        *,
       automations(
  id,
  title,
  slug,
  developer_id,
  setup_schema,
  credential_schema,
  workflow_placeholder_mappings,
  n8n_workflow_id,
  n8n_workflow_name,
  runtime_webhook_url,
  runtime_webhook_path
),
        orders(
          id,
          buyer_name,
          buyer_email,
          buyer_company,
          payment_status,
          order_status,
          price_display,
          developer_id,
          stripe_mode,
          stripe_subscription_id,
          stripe_subscription_status,
          install_type
        )
      `)
      .eq("id", customerAutomationId);

    if (!isAdmin && !isDeveloper) {
      customerAutomationQuery = customerAutomationQuery.eq("buyer_id", user.id);
    }

    const { data: customerAutomation, error: customerAutomationError } =
      await customerAutomationQuery.maybeSingle();

    if (customerAutomationError || !customerAutomation) {
      return errorResponse(
        customerAutomationError?.message || "Customer automation not found.",
        404,
      );
    }

    const product = Array.isArray(customerAutomation.automations)
      ? customerAutomation.automations[0]
      : customerAutomation.automations;

    const order = Array.isArray(customerAutomation.orders)
      ? customerAutomation.orders[0]
      : customerAutomation.orders;

    if (!product) {
      return errorResponse("Product template not found.", 404);
    }

    if (isDeveloper) {
      const developerId = cleanString(developerProfile?.id);
      const ownsProduct = cleanString(product.developer_id) === developerId;
      const ownsOrder = cleanString(order?.developer_id) === developerId;

      if (!developerId || (!ownsProduct && !ownsOrder)) {
        return errorResponse("You do not have access to provision this customer workflow.", 403);
      }
    }

    const masterWorkflowId = cleanString(product.n8n_workflow_id);

    if (!masterWorkflowId) {
      return errorResponse("Product has no master n8n workflow ID. Import the product workflow first.", 400);
    }

    const webhookPath =
      cleanString(customerAutomation.runtime_webhook_path) ||
      `nexus-customer-${shortId(customerAutomation.id)}-${crypto.randomUUID().split("-")[0]}`;

    const webhookUrl =
      cleanString(customerAutomation.runtime_webhook_url) ||
      `${cleanBaseUrl(n8nBaseUrl)}/webhook/${webhookPath}`;

    const callbackUrl = `${cleanBaseUrl(supabaseUrl)}/functions/v1/runtime-submit-output`;

    const setupValues = await loadLatestSetupValues(adminClient, customerAutomation.id);
    const secretValues = await loadSecretValues(adminClient, customerAutomation.id);

    const customerValues = {
      setup: expandBuyerSetupAliases(setupValues),
      secrets: secretValues,
      customer: {
        id: customerAutomation.buyer_id || "",
        email: order?.buyer_email || user.email || "",
        name: order?.buyer_name || "",
        company: order?.buyer_company || "",
      },
      order: {
        id: order?.id || customerAutomation.order_id || "",
        install_type: customerAutomation.install_type || order?.install_type || "",
      },
      system: {
        customer_automation_id: customerAutomation.id,
        automation_id: customerAutomation.automation_id || product.id || "",
        order_id: customerAutomation.order_id || order?.id || "",
      },
    };


    function collectWorkflowStringMatches(value: any, terms: string[], path = "workflow", results: any[] = []) {
  if (typeof value === "string") {
    for (const term of terms) {
      if (value.includes(term)) {
        results.push({
          path,
          term,
          value: value.length > 800 ? value.slice(0, 800) + "..." : value,
        });
        break;
      }
    }

    return results;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectWorkflowStringMatches(item, terms, `${path}[${index}]`, results);
    });

    return results;
  }

  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      collectWorkflowStringMatches(child, terms, `${path}.${key}`, results);
    }
  }

  return results;
}

    const manualWorkflowPlaceholderMappings = normalizeMappings(product.workflow_placeholder_mappings);

    /*
      Fetch the live master workflow from n8n because it is the tested template.
    */
    const liveMasterWorkflow = await getWorkflow(n8nBaseUrl, n8nApiKey, masterWorkflowId);

    let workflow = normalizeWorkflowForCreate(liveMasterWorkflow);

    const autoWorkflowPlaceholderMappings = buildAutoMappingsFromSchemas(workflow, product);

const workflowPlaceholderMappings = mergeMappings(
  manualWorkflowPlaceholderMappings,
  autoWorkflowPlaceholderMappings
);

    workflow.name = `Nexus Customer - ${shortId(customerAutomation.id)} - ${
      product.title || customerAutomation.name || "Automation"
    }`;

    workflow = updateCustomerWebhookPath(workflow, webhookPath);
    workflow = ensureSubmitOutputUsesRuntimePayload(workflow, callbackUrl);

    /*
      Critical production behavior:
      Hardcode customer setup + secrets into this cloned workflow.

      After this runs, the cloned workflow should contain:
      - actual Facebook Page ID
      - actual Meta token
      - actual Instagram business ID
      etc.

      It should NOT contain:
      - [[Nexus_Meta_access-token]]
      - {{ $json.body.secrets.meta_access_token }}
      - $json.body.setup.facebook_page_id
    */
    workflow = hardcodeCustomerValuesIntoWorkflow(
      workflow,
      customerValues,
      workflowPlaceholderMappings,
    );

    const remainingCustomerValueReferences = collectWorkflowStringMatches(workflow, [
  "meta_access_token",
  "facebook_page_id",
  "Nexus_Meta",
  "Nexus_Facebook",
  "$json.body.secrets",
  "$json.body.setup",
  "$json.secrets",
  "$json.setup"
]);

    const remainingDynamicReferences = inspectRemainingReferences(workflow);
    const validation = validateCopiedWorkflow(workflow);

    let imported: any;
    let recreatedDeletedWorkflow = false;

    if (customerAutomation.n8n_workflow_id) {
      try {
        imported = await updateWorkflow(
          n8nBaseUrl,
          n8nApiKey,
          customerAutomation.n8n_workflow_id,
          workflow,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error || "");

        if (
          message.includes("404") ||
          message.toLowerCase().includes("not found") ||
          message.toLowerCase().includes("could not find")
        ) {
          recreatedDeletedWorkflow = true;

          imported = await createWorkflow(
            n8nBaseUrl,
            n8nApiKey,
            workflow,
          );
        } else {
          throw error;
        }
      }
    } else {
      imported = await createWorkflow(
        n8nBaseUrl,
        n8nApiKey,
        workflow,
      );
    }

    const workflowId = imported.id || imported.data?.id || customerAutomation.n8n_workflow_id;

    if (!workflowId) {
      throw new Error("n8n did not return a customer workflow ID.");
    }

    const activation = await activateWorkflow(n8nBaseUrl, n8nApiKey, workflowId);

    const now = new Date().toISOString();
    const updatePayload: Record<string, unknown> = {
      runtime_type: "n8n_managed",
      n8n_workflow_id: workflowId,
      n8n_workflow_name: workflow.name,
      runtime_webhook_path: webhookPath,
      runtime_webhook_url: webhookUrl,
      runtime_status: "not_started",
      health_status: "configured",
      status: "setup_submitted",
      setup_status: "submitted",
      ...monthlyScheduleUpdate(order, customerAutomation),
      last_error_message: null,
      updated_at: now,
    };

    let updateResult = await adminClient
      .from("customer_automations")
      .update(updatePayload)
      .eq("id", customerAutomation.id)
      .select()
      .single();

    if (updateResult.error) {
      const fallbackPayload = { ...updatePayload };
      delete fallbackPayload.run_frequency;
      delete fallbackPayload.schedule_status;
      delete fallbackPayload.schedule_anchor_at;
      delete fallbackPayload.next_run_at;
      delete fallbackPayload.last_run_at;
      delete fallbackPayload.last_run_requested_at;

      updateResult = await adminClient
        .from("customer_automations")
        .update(fallbackPayload)
        .eq("id", customerAutomation.id)
        .select()
        .single();
    }

    if (updateResult.error) {
      return errorResponse(updateResult.error.message, 500);
    }

    const updatedCustomerAutomation = updateResult.data;

    await adminClient.from("automation_events").insert({
      customer_automation_id: customerAutomation.id,
      buyer_id: customerAutomation.buyer_id,
      automation_id: customerAutomation.automation_id || product.id || null,
      order_id: customerAutomation.order_id || order?.id || null,
      event_type: customerAutomation.n8n_workflow_id
        ? "customer_workflow_updated"
        : "customer_workflow_provisioned",
      title: customerAutomation.n8n_workflow_id
        ? "Customer workflow updated"
        : "Customer workflow created",
      message: recreatedDeletedWorkflow
        ? `The previous customer workflow no longer existed in n8n, so Nexus created a new customer workflow for ${
            product.title || "this automation"
          }.`
        : `Nexus copied the live master n8n workflow for ${product.title || "this automation"} and inserted customer setup values and credentials.`,
      created_by: "system",
      created_at: now,
    });

    return jsonResponse({
      ok: true,
      customer_automation: updatedCustomerAutomation,
      workflow_id: workflowId,
      workflow_name: workflow.name,
      webhook_path: webhookPath,
      webhook_url: webhookUrl,
      activation,
      validation,
      copied_from_master_workflow_id: masterWorkflowId,
      inserted_setup_keys: Object.keys(setupValues),
      inserted_secret_keys: Object.keys(secretValues),
      mapping_count: workflowPlaceholderMappings.length,
      remaining_dynamic_references: remainingDynamicReferences,
      remaining_customer_value_references: remainingCustomerValueReferences,
    });
  } catch (error) {
    console.error(error);

    return errorResponse(
      error instanceof Error ? error.message : "Could not provision customer workflow.",
      500,
    );
  }
});
