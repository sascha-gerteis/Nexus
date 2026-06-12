import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import { bindAutomationCredentials } from "../_shared/nexus-credentials.ts";

function env(name: string) {
  return Deno.env.get(name) || "";
}

function cleanBaseUrl(url: string) {
  return String(url || "").replace(/\/$/, "");
}

function cleanString(value: unknown) {
  return String(value || "").trim();
}

function slugify(value: string) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "")
    .slice(0, 70);
}

function shortId() {
  return crypto.randomUUID().split("-")[0];
}

function deepClone(value: any) {
  return JSON.parse(JSON.stringify(value || {}));
}

function normalizeJsonArray(value: unknown) {
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

function escapeRegExp(value: string) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isCredentialSchemaError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /developer_credentials|automation_credential_requirements|credential_binding|schema cache|relation .* does not exist|could not find .* column/i.test(message);
}

/* =========================================================
   NEXUS RUNTIME CONTEXT EXPRESSIONS
   ========================================================= */

function contextPathForMapping(source: string, key: string) {
  const cleanSource = cleanString(source).toLowerCase();
  const cleanKey = cleanString(key);

  if (!cleanKey) return "";

  if (cleanSource === "setup") {
    return `$("Nexus Runtime Context").first().json.setup.${cleanKey}`;
  }

  if (
    cleanSource === "secret" ||
    cleanSource === "secrets" ||
    cleanSource === "credential" ||
    cleanSource === "credentials"
  ) {
    return `$("Nexus Runtime Context").first().json.secrets.${cleanKey}`;
  }

  if (cleanSource === "customer") {
    return `$("Nexus Runtime Context").first().json.customer.${cleanKey}`;
  }

  if (cleanSource === "system") {
    return `$("Nexus Runtime Context").first().json.system.${cleanKey}`;
  }

  if (cleanSource === "order") {
    return `$("Nexus Runtime Context").first().json.order.${cleanKey}`;
  }

  return "";
}

function contextExpressionForMapping(source: string, key: string, expressionMode = false) {
  const path = contextPathForMapping(source, key);
  if (!path) return "";

  return expressionMode ? `={{ ${path} }}` : `{{ ${path} }}`;
}

function isWholeString(value: string, placeholder: string) {
  return String(value || "").trim() === String(placeholder || "").trim();
}

function isLikelyExpressionField(childKey: string) {
  const key = String(childKey || "").toLowerCase();

  return (
    key === "url" ||
    key === "value" ||
    key === "jsonbody" ||
    key === "body" ||
    key === "text" ||
    key.includes("token") ||
    key.includes("access") ||
    key.includes("authorization") ||
    key.includes("apikey") ||
    key.includes("api_key") ||
    key.includes("secret") ||
    key.includes("credential") ||
    key.includes("id")
  );
}

function normalizeKnownNexusPlaceholderMapping(mapping: any) {
  const placeholder = String(mapping?.placeholder || "");

  /*
    Safety override:
    These common placeholders are easy to accidentally map wrong in the product editor.
    The importer should always force them to the correct source/key.
  */
  const normalized = placeholder.toLowerCase();

  if (normalized === "[[nexus_meta_access-token]]" || normalized === "[[nexus_meta_access_token]]") {
    return {
      ...mapping,
      source: "secret",
      key: "meta_access_token",
    };
  }

  if (normalized === "[[nexus_facebook_page_id]]" || normalized === "[[nexus_facebook_id]]") {
    return {
      ...mapping,
      source: "setup",
      key: "facebook_page_id",
    };
  }

  if (normalized === "[[nexus_instagram_page_id]]") {
    return {
      ...mapping,
      source: "setup",
      key: "instagram_business_account_id",
    };
  }

  if (normalized === "[[nexus_youtube_channel-id]]" || normalized === "[[nexus_youtube_channel_id]]") {
    return {
      ...mapping,
      source: "setup",
      key: "youtube_channel_id",
    };
  }

  if (normalized === "[[nexus_tiktok_username]]") {
    return {
      ...mapping,
      source: "setup",
      key: "tiktok_username",
    };
  }

  return mapping;
}


function forceN8nExpressionModeIfNeeded(value: string, childKey = "") {
  const output = String(value || "");
  const key = String(childKey || "").toLowerCase();

  /*
    Do not turn actual code blocks into n8n expression fields.
    Code node jsCode must remain plain JavaScript.
  */
  if (
    key === "jscode" ||
    key === "code" ||
    key === "functioncode" ||
    key === "script"
  ) {
    return output;
  }

  const hasRuntimeContextReference =
    output.includes('$(\"Nexus Runtime Context\").first().json') ||
    output.includes("$('Nexus Runtime Context').first().json") ||
    output.includes('$("Nexus Runtime Context").first().json');

  if (!hasRuntimeContextReference) {
    return output;
  }

  /*
    n8n only evaluates expressions when the parameter value starts with =.
    This fixes URL fields like:
    https://graph.facebook.com/v20.0/{{ $("Nexus Runtime Context").first().json.setup.facebook_page_id }}

    into:
    =https://graph.facebook.com/v20.0/{{ $("Nexus Runtime Context").first().json.setup.facebook_page_id }}
  */
  if (output.trim().startsWith("=")) {
    return output;
  }

  return `=${output}`;
}

function repairBadMixedCredentialValue(output: string) {
  /*
    If a credential/access-token field was previously imported as a bad mixed string like:
      {{ $("Nexus Runtime Context").first().json.secrets.meta_access_token }} {{ $json.setup.brand_notes }}
    or:
      {{ $json.setup.brand_notes }}
    force it back to the correct dynamic expression.
  */
  const value = String(output || "");

  const containsMetaTokenReference =
    value.includes("meta_access_token") ||
    value.includes("Nexus_Meta_access-token") ||
    value.includes("Nexus_Meta_access_token");

  const containsBrandNotesReference =
    value.includes("$json.setup.brand_notes") ||
    value.includes("$json.body.setup.brand_notes") ||
    value.includes("json.setup.brand_notes") ||
    value.includes("json.body.setup.brand_notes");

  if (containsMetaTokenReference || containsBrandNotesReference) {
    const hasAccessTokenContext =
      value.includes("secrets.meta_access_token") ||
      value.includes("Nexus_Meta_access-token") ||
      value.includes("Nexus_Meta_access_token") ||
      containsBrandNotesReference;

    if (hasAccessTokenContext && value.toLowerCase().includes("brand_notes")) {
      return '={{ $("Nexus Runtime Context").first().json.secrets.meta_access_token }}';
    }
  }

  return output;
}


/* =========================================================
   CODE NODE SAFE DYNAMIC REFERENCES
   ========================================================= */

function isCodeParameterKey(key: string) {
  const cleanKey = String(key || "").toLowerCase();
  return (
    cleanKey === "jscode" ||
    cleanKey === "code" ||
    cleanKey === "functioncode" ||
    cleanKey === "script"
  );
}

function jsAccessorForMapping(source: string, key: string) {
  return contextPathForMapping(source, key);
}

function jsStringAccessorForMapping(source: string, key: string) {
  const accessor = jsAccessorForMapping(source, key);
  if (!accessor) return "";
  return `String(${accessor} ?? "")`;
}

function replaceQuotedCodePlaceholder(sourceCode: string, placeholderRegex: RegExp, source: string) {
  let output = String(sourceCode || "");

  /*
    Replace placeholders that are wrapped in quotes, for example:
      "{{NEXUS_SETUP.facebook_page_id}}"
      '{{NEXUS_SETUP.facebook_page_id}}'
      `{{NEXUS_SETUP.facebook_page_id}}`

    with valid JavaScript:
      String($("Nexus Runtime Context").first().json.setup.facebook_page_id ?? "")
  */
  output = output.replace(
    new RegExp("([\"\'`])\\s*" + placeholderRegex.source + "\\s*\\1", "g"),
    (_full: string, _quote: string, key: string) => {
      return jsStringAccessorForMapping(source, key) || "\"\"";
    },
  );

  /*
    Replace unquoted placeholders too. This is less common, but keeps imports safe:
      {{NEXUS_SETUP.facebook_page_id}}
    becomes:
      String($("Nexus Runtime Context").first().json.setup.facebook_page_id ?? "")
  */
  output = output.replace(placeholderRegex, (_full: string, key: string) => {
    return jsStringAccessorForMapping(source, key) || "\"\"";
  });

  return output;
}

function replaceQuotedRuntimeContextExpressionInCode(sourceCode: string) {
  let output = String(sourceCode || "");

  /*
    Repair bad code-node imports like:
      "{{ $("Nexus Runtime Context").first().json.setup.name }}"

    That is invalid JS because the inner double quotes close the outer string.
    Convert it to:
      String($("Nexus Runtime Context").first().json.setup.name ?? "")
  */
  const quotedRuntimePattern = /(["'`])\s*\{\{\s*(\$\(["']Nexus Runtime Context["']\)\.first\(\)\.json\.(?:setup|secrets|customer|system|order)\.[a-zA-Z0-9_.-]+)\s*\}\}\s*\1/g;

  output = output.replace(quotedRuntimePattern, (_full: string, _quote: string, accessor: string) => {
    return `String(${accessor} ?? "")`;
  });

  const unquotedRuntimePattern = /\{\{\s*(\$\(["']Nexus Runtime Context["']\)\.first\(\)\.json\.(?:setup|secrets|customer|system|order)\.[a-zA-Z0-9_.-]+)\s*\}\}/g;

  output = output.replace(unquotedRuntimePattern, (_full: string, accessor: string) => {
    return `String(${accessor} ?? "")`;
  });

  return output;
}

function replaceMappedPlaceholdersInCode(sourceCode: string, mappings: any[]) {
  let output = String(sourceCode || "");

  for (const rawMapping of mappings || []) {
    const mapping = normalizeKnownNexusPlaceholderMapping(rawMapping);
    const placeholder = String(mapping?.placeholder || "");
    const source = String(mapping?.source || "");
    const key = String(mapping?.key || "");

    if (!placeholder || !source || !key) continue;

    const replacement = jsStringAccessorForMapping(source, key);
    if (!replacement) continue;

    const escaped = escapeRegExp(placeholder);

    output = output.replace(
      new RegExp("([\"\'`])\\s*" + escaped + "\\s*\\1", "g"),
      replacement,
    );

    output = output.split(placeholder).join(replacement);
  }

  return output;
}

function convertNexusCodeHelpers(sourceCode: string) {
  let output = String(sourceCode || "");

  /*
    Preferred developer syntax inside Code nodes:
      const pageId = NEXUS_CODE_SETUP("facebook_page_id");
      const token = NEXUS_CODE_SECRET("meta_access_token");
  */
  const helpers = [
    { regex: /NEXUS_CODE_SETUP\(["']([a-zA-Z0-9_.-]+)["']\)/g, source: "setup" },
    { regex: /NEXUS_CODE_SECRET\(["']([a-zA-Z0-9_.-]+)["']\)/g, source: "secret" },
    { regex: /NEXUS_CODE_CUSTOMER\(["']([a-zA-Z0-9_.-]+)["']\)/g, source: "customer" },
    { regex: /NEXUS_CODE_SYSTEM\(["']([a-zA-Z0-9_.-]+)["']\)/g, source: "system" },
    { regex: /NEXUS_CODE_ORDER\(["']([a-zA-Z0-9_.-]+)["']\)/g, source: "order" },
  ];

  for (const helper of helpers) {
    output = output.replace(helper.regex, (_full: string, key: string) => {
      return jsAccessorForMapping(helper.source, key) || "undefined";
    });
  }

  return output;
}

function convertOfficialPlaceholdersInCode(sourceCode: string) {
  let output = String(sourceCode || "");

  output = replaceQuotedCodePlaceholder(
    output,
    /\{\{\s*NEXUS_SETUP\.([a-zA-Z0-9_.-]+)\s*\}\}/g,
    "setup",
  );

  output = replaceQuotedCodePlaceholder(
    output,
    /\{\{\s*NEXUS_SECRET\.([a-zA-Z0-9_.-]+)\s*\}\}/g,
    "secret",
  );

  output = replaceQuotedCodePlaceholder(
    output,
    /\{\{\s*NEXUS_CUSTOMER\.([a-zA-Z0-9_.-]+)\s*\}\}/g,
    "customer",
  );

  output = replaceQuotedCodePlaceholder(
    output,
    /\{\{\s*NEXUS_SYSTEM\.([a-zA-Z0-9_.-]+)\s*\}\}/g,
    "system",
  );

  output = replaceQuotedCodePlaceholder(
    output,
    /\{\{\s*NEXUS_ORDER\.([a-zA-Z0-9_.-]+)\s*\}\}/g,
    "order",
  );

  return output;
}

function convertLegacyPlaceholdersInCode(sourceCode: string) {
  let output = String(sourceCode || "");

  const legacy = [
    { regex: /\{\{\s*\$json\.body\.setup\.([a-zA-Z0-9_.-]+)\s*\}\}/g, source: "setup" },
    { regex: /\{\{\s*\$json\.setup\.([a-zA-Z0-9_.-]+)\s*\}\}/g, source: "setup" },
    { regex: /\{\{\s*\$json\.body\.secrets\.([a-zA-Z0-9_.-]+)\s*\}\}/g, source: "secret" },
    { regex: /\{\{\s*\$json\.secrets\.([a-zA-Z0-9_.-]+)\s*\}\}/g, source: "secret" },
    { regex: /\{\{\s*\$json\.body\.customer\.([a-zA-Z0-9_.-]+)\s*\}\}/g, source: "customer" },
    { regex: /\{\{\s*\$json\.customer\.([a-zA-Z0-9_.-]+)\s*\}\}/g, source: "customer" },
    { regex: /\{\{\s*\$json\.body\.system\.([a-zA-Z0-9_.-]+)\s*\}\}/g, source: "system" },
    { regex: /\{\{\s*\$json\.system\.([a-zA-Z0-9_.-]+)\s*\}\}/g, source: "system" },
    { regex: /\{\{\s*\$json\.body\.order\.([a-zA-Z0-9_.-]+)\s*\}\}/g, source: "order" },
    { regex: /\{\{\s*\$json\.order\.([a-zA-Z0-9_.-]+)\s*\}\}/g, source: "order" },
  ];

  for (const item of legacy) {
    output = replaceQuotedCodePlaceholder(output, item.regex, item.source);
  }

  return output;
}

function convertCodeNodeDynamicReferences(sourceCode: string, mappings: any[] = []) {
  let output = String(sourceCode || "");

  output = convertNexusCodeHelpers(output);
  output = replaceMappedPlaceholdersInCode(output, mappings);
  output = convertOfficialPlaceholdersInCode(output);
  output = convertLegacyPlaceholdersInCode(output);
  output = replaceQuotedRuntimeContextExpressionInCode(output);

  return output;
}

function repairCodeNodeDynamicReferencesInWorkflow(workflow: any, mappings: any[] = []) {
  if (!workflow || typeof workflow !== "object" || !Array.isArray(workflow.nodes)) {
    return workflow;
  }

  workflow.nodes = workflow.nodes.map((node: any) => {
    if (!node || typeof node !== "object") return node;

    const type = String(node.type || "").toLowerCase();
    const isCodeNode =
      type.includes("n8n-nodes-base.code") ||
      type.includes("n8n-nodes-base.function") ||
      type.includes("n8n-nodes-base.functionitem");

    if (!isCodeNode || !node.parameters || typeof node.parameters !== "object") {
      return node;
    }

    const params = { ...node.parameters };

    for (const key of Object.keys(params)) {
      if (isCodeParameterKey(key) && typeof params[key] === "string") {
        params[key] = convertCodeNodeDynamicReferences(params[key], mappings);
      }
    }

    return {
      ...node,
      parameters: params,
    };
  });

  return workflow;
}

/* =========================================================
   OFFICIAL NEXUS PLACEHOLDERS
   ========================================================= */

function extractPlaceholders(text: string) {
  const found = {
    setup: [] as string[],
    secret: [] as string[],
    customer: [] as string[],
    system: [] as string[],
    order: [] as string[],
    unknown: [] as string[],
  };

  const pattern = /\{\{\s*NEXUS_([A-Z]+)\.([a-zA-Z0-9_.-]+)\s*\}\}/g;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const type = match[1];
    const name = match[2];

    if (type === "SETUP") found.setup.push(name);
    else if (type === "SECRET") found.secret.push(name);
    else if (type === "CUSTOMER") found.customer.push(name);
    else if (type === "SYSTEM") found.system.push(name);
    else if (type === "ORDER") found.order.push(name);
    else found.unknown.push(`NEXUS_${type}.${name}`);
  }

  for (const key of Object.keys(found) as Array<keyof typeof found>) {
    found[key] = [...new Set(found[key])].sort();
  }

  return found;
}

function validatePlaceholders(product: any, workflow: any) {
  const text = JSON.stringify(workflow || {});
  const detected = extractPlaceholders(text);

  const setupSchema = normalizeJsonArray(product.setup_schema);
  const credentialSchema = normalizeJsonArray(product.credential_schema);

  const setupNames = setupSchema.map((item: any) => item.name).filter(Boolean);
  const credentialNames = credentialSchema.map((item: any) => item.name).filter(Boolean);

  const errors: string[] = [];
  const warnings: string[] = [];

  for (const name of detected.setup) {
    if (!setupNames.includes(name)) {
      warnings.push(`NEXUS_SETUP.${name} was detected but setup_schema did not contain it. Nexus will still import, but the buyer form may need this field.`);
    }
  }

  for (const name of detected.secret) {
    if (!credentialNames.includes(name)) {
      warnings.push(`NEXUS_SECRET.${name} was detected but credential_schema did not contain it. Nexus will still import, but the buyer form may need this secret field.`);
    }
  }

  for (const name of detected.unknown) {
    errors.push(`Unknown Nexus placeholder: ${name}`);
  }

  return { detected, errors, warnings };
}

function convertNexusPlaceholders(value: any, childKey = ""): any {
  if (typeof value === "string") {
    let output = value;

    const replacements = [
      {
        regex: /\{\{\s*NEXUS_SETUP\.([a-zA-Z0-9_.-]+)\s*\}\}/g,
        source: "setup",
      },
      {
        regex: /\{\{\s*NEXUS_SECRET\.([a-zA-Z0-9_.-]+)\s*\}\}/g,
        source: "secret",
      },
      {
        regex: /\{\{\s*NEXUS_CUSTOMER\.([a-zA-Z0-9_.-]+)\s*\}\}/g,
        source: "customer",
      },
      {
        regex: /\{\{\s*NEXUS_SYSTEM\.([a-zA-Z0-9_.-]+)\s*\}\}/g,
        source: "system",
      },
      {
        regex: /\{\{\s*NEXUS_ORDER\.([a-zA-Z0-9_.-]+)\s*\}\}/g,
        source: "order",
      },
    ];

    for (const item of replacements) {
      output = output.replace(item.regex, (fullMatch: string, key: string) => {
        const whole = isWholeString(value, fullMatch);
        const expressionMode = whole && isLikelyExpressionField(childKey);
        return contextExpressionForMapping(item.source, key, expressionMode);
      });
    }

    output = repairBadMixedCredentialValue(output);
    output = forceN8nExpressionModeIfNeeded(output, childKey);
    return output;
  }

  if (Array.isArray(value)) {
    return value.map((child) => convertNexusPlaceholders(child, childKey));
  }

  if (value && typeof value === "object") {
    const output: Record<string, any> = {};

    for (const [key, child] of Object.entries(value)) {
      output[key] = convertNexusPlaceholders(child, key);
    }

    return output;
  }

  return value;
}

/* =========================================================
   CUSTOM DEVELOPER PLACEHOLDER MAPPINGS
   ========================================================= */

function normalizeMappings(value: unknown) {
  return normalizeJsonArray(value).map(normalizeKnownNexusPlaceholderMapping);
}

function inferFieldLabel(name: string) {
  return String(name || "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase())
    .trim() || "Field";
}

function inferSetupFieldType(name: string) {
  const key = String(name || "").toLowerCase();

  if (key.includes("email")) return "email";
  if (key.includes("url") || key.includes("website") || key.includes("link")) return "url";
  if (key.includes("notes") || key.includes("description") || key.includes("instructions")) return "textarea";

  return "text";
}

function makeSetupField(name: string) {
  return {
    name,
    label: inferFieldLabel(name),
    type: inferSetupFieldType(name),
    required: false,
    description: "Auto-added by Nexus because the uploaded workflow uses this setup placeholder.",
  };
}

function makeCredentialField(name: string) {
  return {
    name,
    label: inferFieldLabel(name),
    type: "secret",
    required: false,
    description: "Auto-added by Nexus because the uploaded workflow uses this credential placeholder.",
  };
}

function isSecretSource(source: string) {
  const cleanSource = cleanString(source).toLowerCase();
  return (
    cleanSource === "secret" ||
    cleanSource === "secrets" ||
    cleanSource === "credential" ||
    cleanSource === "credentials"
  );
}

function autoAddMissingSchemaFieldsForWorkflow(product: any, workflow: any, mappings: any[]) {
  const workflowText = JSON.stringify(workflow || {});
  const setupSchema = normalizeJsonArray(product.setup_schema);
  const credentialSchema = normalizeJsonArray(product.credential_schema);

  const setupNames = new Set(setupSchema.map((item: any) => cleanString(item?.name)).filter(Boolean));
  const credentialNames = new Set(credentialSchema.map((item: any) => cleanString(item?.name)).filter(Boolean));

  const addedSetupFields: any[] = [];
  const addedCredentialFields: any[] = [];
  const warnings: string[] = [];

  /*
    Official placeholders: {{NEXUS_SETUP.field}} and {{NEXUS_SECRET.field}}
    These should never block launch. If a dev uses them, Nexus creates the missing schema field.
  */
  const detected = extractPlaceholders(workflowText);

  for (const name of detected.setup || []) {
    const key = cleanString(name);
    if (!key || setupNames.has(key)) continue;

    const field = makeSetupField(key);
    setupSchema.push(field);
    setupNames.add(key);
    addedSetupFields.push(field);
    warnings.push(`Auto-added setup field ${key} from NEXUS_SETUP.${key}.`);
  }

  for (const name of detected.secret || []) {
    const key = cleanString(name);
    if (!key || credentialNames.has(key)) continue;

    const field = makeCredentialField(key);
    credentialSchema.push(field);
    credentialNames.add(key);
    addedCredentialFields.push(field);
    warnings.push(`Auto-added credential field ${key} from NEXUS_SECRET.${key}.`);
  }

  /*
    Custom marketplace mappings: [[Nexus_Facebook_Page_Id]] -> setup.facebook_page_id.
    If the placeholder exists in the workflow and the schema field is missing, auto-add it.
    If the mapping is stale/unused, it stays a warning only.
  */
  for (const rawMapping of mappings || []) {
    const mapping = normalizeKnownNexusPlaceholderMapping(rawMapping);
    const placeholder = cleanString(mapping?.placeholder);
    const source = cleanString(mapping?.source).toLowerCase();
    const key = cleanString(mapping?.key);

    if (!placeholder || !source || !key) continue;
    if (!workflowText.includes(placeholder)) continue;

    if (source === "setup") {
      if (!setupNames.has(key)) {
        const field = makeSetupField(key);
        setupSchema.push(field);
        setupNames.add(key);
        addedSetupFields.push(field);
        warnings.push(`Auto-added setup field ${key} because workflow uses ${placeholder}.`);
      }
      continue;
    }

    if (isSecretSource(source)) {
      if (!credentialNames.has(key)) {
        const field = makeCredentialField(key);
        credentialSchema.push(field);
        credentialNames.add(key);
        addedCredentialFields.push(field);
        warnings.push(`Auto-added credential field ${key} because workflow uses ${placeholder}.`);
      }
      continue;
    }
  }

  return {
    product: {
      ...product,
      setup_schema: setupSchema,
      credential_schema: credentialSchema,
    },
    setup_schema: setupSchema,
    credential_schema: credentialSchema,
    addedSetupFields,
    addedCredentialFields,
    warnings,
  };
}

function applyWorkflowPlaceholderMappings(value: any, mappings: any[], childKey = ""): any {
  if (typeof value === "string") {
    let output = value;

    for (const rawMapping of mappings || []) {
      const mapping = normalizeKnownNexusPlaceholderMapping(rawMapping);
      const placeholder = String(mapping?.placeholder || "");
      const source = String(mapping?.source || "");
      const key = String(mapping?.key || "");

      if (!placeholder || !source || !key) continue;

      const whole = isWholeString(output, placeholder);
      const expressionMode = whole && isLikelyExpressionField(childKey);
      const replacement = contextExpressionForMapping(source, key, expressionMode);

      if (!replacement) continue;

      output = output.split(placeholder).join(replacement);
    }

    output = repairBadMixedCredentialValue(output);
    output = forceN8nExpressionModeIfNeeded(output, childKey);
    return output;
  }

  if (Array.isArray(value)) {
    return value.map((item) => applyWorkflowPlaceholderMappings(item, mappings, childKey));
  }

  if (value && typeof value === "object") {
    const result: Record<string, any> = {};

    for (const [key, child] of Object.entries(value)) {
      result[key] = applyWorkflowPlaceholderMappings(child, mappings, key);
    }

    return result;
  }

  return value;
}

function validateWorkflowPlaceholderMappings(product: any, workflow: any, mappings: any[]) {
  const workflowText = JSON.stringify(workflow || {});
  const setupSchema = normalizeJsonArray(product.setup_schema);
  const credentialSchema = normalizeJsonArray(product.credential_schema);

  const setupNames = setupSchema.map((item: any) => item.name).filter(Boolean);
  const credentialNames = credentialSchema.map((item: any) => item.name).filter(Boolean);

  const errors: string[] = [];
  const warnings: string[] = [];

  for (const rawMapping of mappings || []) {
    const mapping = normalizeKnownNexusPlaceholderMapping(rawMapping);
    const placeholder = cleanString(mapping?.placeholder);
    const source = cleanString(mapping?.source).toLowerCase();
    const key = cleanString(mapping?.key);

    if (!placeholder && !source && !key) continue;

    /*
      Production rule:
      Mappings are optional replacement instructions, not strict requirements.
      A stale mapping should never block marketplace product import.
    */
    if (!placeholder) {
      warnings.push("Ignored a workflow placeholder mapping because it is missing `placeholder`.");
      continue;
    }

    const placeholderIsUsed = workflowText.includes(placeholder);

    if (!placeholderIsUsed) {
      warnings.push(`Mapping ${placeholder} was not found in the uploaded workflow JSON, so it was skipped.`);
      continue;
    }

    if (!source) {
      warnings.push(`Mapping for ${placeholder} is missing source, so it was skipped.`);
      continue;
    }

    if (!key) {
      warnings.push(`Mapping for ${placeholder} is missing key, so it was skipped.`);
      continue;
    }

    const replacement = contextExpressionForMapping(source, key);

    if (!replacement) {
      errors.push(`Mapping for ${placeholder} has unsupported source: ${source}`);
      continue;
    }

    if (source === "setup" && !setupNames.includes(key)) {
      warnings.push(`Mapping ${placeholder} points to setup.${key}, but setup_schema did not contain it. Nexus auto-adds missing fields during import when possible.`);
      continue;
    }

    if (isSecretSource(source) && !credentialNames.includes(key)) {
      warnings.push(`Mapping ${placeholder} points to secret.${key}, but credential_schema did not contain it. Nexus auto-adds missing fields during import when possible.`);
      continue;
    }
  }

  return { errors, warnings };
}

/* =========================================================
   CLEAN LEGACY DYNAMIC REFERENCES
   ========================================================= */

function convertLegacyDynamicReferences(value: any, childKey = ""): any {
  if (typeof value === "string") {
    let output = value;

    const conversions = [
      {
        regex: /\{\{\s*\$json\.body\.setup\.([a-zA-Z0-9_.-]+)\s*\}\}/g,
        source: "setup",
      },
      {
        regex: /\{\{\s*\$json\.setup\.([a-zA-Z0-9_.-]+)\s*\}\}/g,
        source: "setup",
      },
      {
        regex: /\{\{\s*\$json\.body\.secrets\.([a-zA-Z0-9_.-]+)\s*\}\}/g,
        source: "secret",
      },
      {
        regex: /\{\{\s*\$json\.secrets\.([a-zA-Z0-9_.-]+)\s*\}\}/g,
        source: "secret",
      },
      {
        regex: /\{\{\s*\$json\.body\.customer\.([a-zA-Z0-9_.-]+)\s*\}\}/g,
        source: "customer",
      },
      {
        regex: /\{\{\s*\$json\.customer\.([a-zA-Z0-9_.-]+)\s*\}\}/g,
        source: "customer",
      },
      {
        regex: /\{\{\s*\$json\.body\.system\.([a-zA-Z0-9_.-]+)\s*\}\}/g,
        source: "system",
      },
      {
        regex: /\{\{\s*\$json\.system\.([a-zA-Z0-9_.-]+)\s*\}\}/g,
        source: "system",
      },
      {
        regex: /\{\{\s*\$json\.body\.order\.([a-zA-Z0-9_.-]+)\s*\}\}/g,
        source: "order",
      },
      {
        regex: /\{\{\s*\$json\.order\.([a-zA-Z0-9_.-]+)\s*\}\}/g,
        source: "order",
      },
    ];

    for (const item of conversions) {
      output = output.replace(item.regex, (fullMatch: string, key: string) => {
        const whole = isWholeString(value, fullMatch);
        const expressionMode = whole && isLikelyExpressionField(childKey);
        return contextExpressionForMapping(item.source, key, expressionMode);
      });
    }

    output = repairBadMixedCredentialValue(output);
    output = forceN8nExpressionModeIfNeeded(output, childKey);
    return output;
  }

  if (Array.isArray(value)) {
    return value.map((item) => convertLegacyDynamicReferences(item, childKey));
  }

  if (value && typeof value === "object") {
    const result: Record<string, any> = {};

    for (const [key, child] of Object.entries(value)) {
      result[key] = convertLegacyDynamicReferences(child, key);
    }

    return result;
  }

  return value;
}

/* =========================================================
   WORKFLOW STRUCTURE HELPERS
   ========================================================= */

function nodeType(node: any) {
  return String(node?.type || "").toLowerCase();
}

function isWebhookNode(node: any) {
  return nodeType(node).includes("n8n-nodes-base.webhook");
}

function isManualTriggerNode(node: any) {
  const type = nodeType(node);
  return type.includes("manualtrigger") || type.includes("manualworkflowtrigger");
}

function isScheduleTriggerNode(node: any) {
  const type = nodeType(node);
  return type.includes("scheduletrigger") || type.includes("cron");
}

function isSupportedReplaceableTrigger(node: any) {
  return isManualTriggerNode(node) || isScheduleTriggerNode(node);
}

function findTriggerNodes(nodes: any[]) {
  return nodes.filter((node) => {
    const type = nodeType(node);

    return (
      type.includes("trigger") ||
      type.includes("webhook") ||
      type.includes("cron")
    );
  });
}

function renameConnectionNode(connections: any, oldName: string, newName: string) {
  const updated = deepClone(connections || {});

  if (updated[oldName]) {
    updated[newName] = updated[oldName];
    delete updated[oldName];
  }

  for (const sourceName of Object.keys(updated)) {
    const source = updated[sourceName];

    for (const outputType of Object.keys(source || {})) {
      const outputGroups = source[outputType];

      if (!Array.isArray(outputGroups)) continue;

      for (const group of outputGroups) {
        if (!Array.isArray(group)) continue;

        for (const connection of group) {
          if (connection.node === oldName) {
            connection.node = newName;
          }
        }
      }
    }
  }

  return updated;
}

function getConnectedTargetNames(connections: any) {
  const targets = new Set<string>();

  for (const sourceName of Object.keys(connections || {})) {
    const source = connections[sourceName];

    for (const outputType of Object.keys(source || {})) {
      const outputGroups = source[outputType];

      if (!Array.isArray(outputGroups)) continue;

      for (const group of outputGroups) {
        if (!Array.isArray(group)) continue;

        for (const connection of group) {
          if (connection.node) targets.add(connection.node);
        }
      }
    }
  }

  return targets;
}

function getTerminalNodeNames(nodes: any[], connections: any) {
  const terminals: string[] = [];

  for (const node of nodes) {
    const outgoing = connections?.[node.name]?.main;

    const hasOutgoing =
      Array.isArray(outgoing) &&
      outgoing.some((group: any) => Array.isArray(group) && group.length > 0);

    if (
      !hasOutgoing &&
      node.name !== "Nexus Submit Output" &&
      node.name !== "Nexus Runtime Merge" &&
      node.name !== "Nexus Runtime Context" &&
      !isWebhookNode(node)
    ) {
      terminals.push(node.name);
    }
  }

  return terminals;
}

function findSourceNodeConnectedToTargetInput(
  connections: any,
  targetNodeName: string,
  targetInputIndex: number,
) {
  for (const sourceName of Object.keys(connections || {})) {
    const source = connections[sourceName];

    if (!source?.main || !Array.isArray(source.main)) {
      continue;
    }

    for (const outputGroup of source.main) {
      if (!Array.isArray(outputGroup)) continue;

      for (const connection of outputGroup) {
        if (
          connection?.node === targetNodeName &&
          Number(connection?.index || 0) === targetInputIndex
        ) {
          return sourceName;
        }
      }
    }
  }

  return "";
}

function buildWebhookNode(webhookPath: string, position = [0, 0]) {
  return {
    parameters: {
      httpMethod: "POST",
      path: webhookPath,
      responseMode: "onReceived",
      options: {},
    },
    id: crypto.randomUUID(),
    name: "Nexus Webhook Trigger",
    type: "n8n-nodes-base.webhook",
    typeVersion: 2,
    position,
  };
}

function buildNexusRuntimeContextNode(position = [300, 0], existingNode: any = null) {
  return {
    parameters: {
      jsCode: `const body = $("Nexus Webhook Trigger").first().json.body || {};

return [
  {
    json: {
      customer_automation_id: body.customer_automation_id || body.system?.customer_automation_id || "",
      automation_id: body.automation_id || body.system?.automation_id || "",
      order_id: body.order_id || body.system?.order_id || "",
      setup_submission_id: body.setup_submission_id || body.system?.setup_submission_id || "",

      setup: body.setup || {},
      secrets: body.secrets || {},
      customer: body.customer || {},
      order: body.order || {},
      system: body.system || {}
    }
  }
];`,
    },
    id: existingNode?.id || crypto.randomUUID(),
    name: "Nexus Runtime Context",
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: existingNode?.position || position,
  };
}

function buildNexusRuntimeMergeNode(position = [850, 0], existingNode: any = null) {
  return {
    parameters: {
      mode: "combine",
      combineBy: "combineByPosition",
      options: {},
    },
    id: existingNode?.id || crypto.randomUUID(),
    name: "Nexus Runtime Merge",
    type: "n8n-nodes-base.merge",
    typeVersion: 3.2,
    position: existingNode?.position || position,
  };
}

function buildNexusOutputNode(callbackUrl: string, position = [1100, 0], existingNode: any = null) {
  return {
    parameters: {
      method: "POST",
      url: callbackUrl,
      sendHeaders: true,
      headerParameters: {
        parameters: [
          {
            name: "x-nexus-runtime-secret",
            value: '={{ $("Nexus Runtime Context").first().json.system.runtime_secret }}',
          },
        ],
      },
      sendBody: true,
      bodyContentType: "json",
      specifyBody: "json",
      jsonBody:
        `={{ JSON.stringify({
          customer_automation_id: $("Nexus Runtime Context").first().json.system.customer_automation_id,
          status: "success",
          output_type: $json.output_type || "report",
          title: $json.title || "Automation output",
          summary: $json.summary || "",
          content_html: $json.content_html || $json.html || "",
          content_text: $json.content_text || "",
          file_url: $json.file_url || "",
          storage_path: $json.storage_path || "",
          content_json: $json.content_json || {}
        }) }}`,
      options: {},
    },
    id: existingNode?.id || crypto.randomUUID(),
    name: "Nexus Submit Output",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: existingNode?.position || position,
  };
}

function ensureMainConnection(
  connections: any,
  sourceName: string,
  targetName: string,
  inputIndex = 0,
) {
  if (!connections[sourceName]) {
    connections[sourceName] = {};
  }

  if (!connections[sourceName].main) {
    connections[sourceName].main = [[]];
  }

  if (!Array.isArray(connections[sourceName].main[0])) {
    connections[sourceName].main[0] = [];
  }

  const alreadyConnected = connections[sourceName].main[0].some((connection: any) => {
    return connection.node === targetName && connection.index === inputIndex;
  });

  if (!alreadyConnected) {
    connections[sourceName].main[0].push({
      node: targetName,
      type: "main",
      index: inputIndex,
    });
  }

  return connections;
}

function removeMainConnectionTo(connections: any, sourceName: string, targetName: string) {
  const source = connections[sourceName];

  if (!source?.main || !Array.isArray(source.main)) {
    return connections;
  }

  source.main = source.main.map((group: any) => {
    if (!Array.isArray(group)) return group;

    return group.filter((connection: any) => {
      return connection.node !== targetName;
    });
  });

  return connections;
}

function wrapWebhookWithRuntimeContext(connections: any) {
  const webhookName = "Nexus Webhook Trigger";
  const contextName = "Nexus Runtime Context";

  const currentWebhookMain = connections?.[webhookName]?.main;
  const originalTargets =
    Array.isArray(currentWebhookMain) && Array.isArray(currentWebhookMain[0])
      ? currentWebhookMain[0].filter((connection: any) => connection.node !== contextName)
      : [];

  if (!connections[webhookName]) {
    connections[webhookName] = {};
  }

  connections[webhookName].main = [[
    {
      node: contextName,
      type: "main",
      index: 0,
    },
  ]];

  if (!connections[contextName]) {
    connections[contextName] = {};
  }

  connections[contextName].main = [
    originalTargets.map((connection: any) => ({
      node: connection.node,
      type: "main",
      index: Number(connection.index || 0),
    })),
  ];

  return connections;
}

function isIgnoredTerminalNode(node: any) {
  const name = String(node?.name || "").toLowerCase();
  const type = String(node?.type || "").toLowerCase();

  return (
    name.includes("sticky note") ||
    type.includes("stickynote") ||
    type.includes("n8n-nodes-base.stickynote") ||
    name === "html" ||
    /^html\d*$/i.test(String(node?.name || "")) ||
    name.includes("preview") ||
    name.includes("note")
  );
}


function isHttpRequestNode(node: any) {
  const type = String(node?.type || "").toLowerCase();
  return type.includes("n8n-nodes-base.httprequest");
}

function applyRetrySettingsToWorkflowNodes(nodes: any[]) {
  return nodes.map((node: any) => {
    if (!node || typeof node !== "object") return node;

    /*
      Launch-safe retry policy:
      - Apply to HTTP Request nodes only.
      - Retry 4 times.
      - Wait 5 seconds between retries.
      - Keep continueOnFail as-is if the developer already set it.
    */
    if (isHttpRequestNode(node)) {
      return {
        ...node,
        retryOnFail: true,
        maxTries: 4,
        waitBetweenTries: 5000,
      };
    }

    return node;
  });
}

function isPreferredOutputNode(node: any) {
  const name = String(node?.name || "").toLowerCase();
  const type = String(node?.type || "").toLowerCase();

  return (
    name.includes("final") ||
    name.includes("output") ||
    name.includes("report") ||
    name.includes("result") ||
    type.includes("code") ||
    type.includes("function")
  );
}

function normalizeFinalOutputName(value: unknown) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isMarkedFinalOutputNode(node: any) {
  const normalized = normalizeFinalOutputName(node?.name);
  return normalized === "nexus_final_output";
}

function nodeParametersText(node: any) {
  try {
    return JSON.stringify(node?.parameters || {});
  } catch {
    return "";
  }
}

function scoreOutputCandidate(node: any) {
  const name = String(node?.name || "").toLowerCase();
  const type = String(node?.type || "").toLowerCase();
  const params = nodeParametersText(node).toLowerCase();

  let score = 0;

  if (isMarkedFinalOutputNode(node)) score += 1000;
  if (name.includes("final")) score += 120;
  if (name.includes("output")) score += 100;
  if (name.includes("report")) score += 80;
  if (name.includes("result")) score += 70;

  if (type.includes("n8n-nodes-base.code")) score += 45;
  if (type.includes("n8n-nodes-base.html")) score += 35;

  if (params.includes("content_html")) score += 80;
  if (params.includes("$json.html")) score += 70;
  if (params.includes("return [{ json: { html")) score += 70;
  if (params.includes("html")) score += 20;
  if (params.includes("output_type")) score += 30;
  if (params.includes("summary")) score += 15;

  if (type.includes("gmail")) score -= 80;
  if (type.includes("telegram")) score -= 60;
  if (type.includes("slack")) score -= 60;
  if (type.includes("httprequest") && !name.includes("output") && !name.includes("callback")) score -= 30;
  if (isIgnoredTerminalNode(node)) score -= 500;

  return score;
}

function pickBestOutputNode(nodes: any[], terminalNames: string[]) {
  const terminalNodes = terminalNames
    .map((name) => nodes.find((node: any) => node.name === name))
    .filter(Boolean);

  const realTerminalNodes = terminalNodes.filter((node: any) => !isIgnoredTerminalNode(node));

  if (realTerminalNodes.length === 1) {
    return realTerminalNodes[0];
  }

  const scored = realTerminalNodes
    .map((node: any) => ({ node, score: scoreOutputCandidate(node) }))
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return null;

  /*
    Production rule:
    If one candidate is clearly best, use it. This avoids blocking imports for common workflows
    that end with an HTML preview, email notification, and one final report/code node.
    If it is still ambiguous, fail with a helpful message instead of guessing.
  */
  const first = scored[0];
  const second = scored[1];

  if (first.score >= 100 && (!second || first.score - second.score >= 20)) {
    return first.node;
  }

  const preferred = realTerminalNodes.filter(isPreferredOutputNode);
  if (preferred.length === 1) return preferred[0];

  return null;
}

/* =========================================================
   MAIN WORKFLOW NORMALIZATION
   ========================================================= */

function normalizeWorkflow(product: any, rawWorkflow: any, supabaseUrl: string, n8nBaseUrl: string) {
  if (!rawWorkflow || typeof rawWorkflow !== "object") {
    throw new Error("n8n workflow JSON must be an object.");
  }

  const customMappings = normalizeMappings(product.workflow_placeholder_mappings);

  let workflow = deepClone(rawWorkflow);

  /*
    Important order:
    1. Developer custom placeholders -> Nexus Runtime Context refs.
    2. Official Nexus placeholders -> Nexus Runtime Context refs.
    3. Legacy dynamic references -> Nexus Runtime Context refs.
  */
  workflow = applyWorkflowPlaceholderMappings(workflow, customMappings);
  workflow = convertNexusPlaceholders(workflow);
  workflow = convertLegacyDynamicReferences(workflow);

  /*
    Code node fix:
    n8n does not evaluate {{ ... }} expressions inside JavaScript code strings.
    After normal placeholder conversion, repair Code node jsCode so values become valid JS.
  */
  workflow = repairCodeNodeDynamicReferencesInWorkflow(workflow, customMappings);

  if (!Array.isArray(workflow.nodes)) {
    throw new Error("n8n workflow JSON is missing nodes array.");
  }

  if (!workflow.connections || typeof workflow.connections !== "object") {
    workflow.connections = {};
  }

  let nodes = workflow.nodes;
  let connections = workflow.connections || {};

  const webhookPath =
    product.runtime_webhook_path ||
    `nexus-${slugify(product.slug || product.title || "automation")}-${shortId()}`;

  const callbackUrl = `${cleanBaseUrl(supabaseUrl)}/functions/v1/runtime-submit-output`;

  const triggerNodes = findTriggerNodes(nodes);
  const webhookNodes = nodes.filter(isWebhookNode);

  if (webhookNodes.length > 1) {
    throw new Error("Multiple Webhook Trigger nodes found. Keep only one webhook trigger for Nexus MVP.");
  }

  if (webhookNodes.length === 1) {
    const webhookNode = webhookNodes[0];
    const oldName = webhookNode.name;

    webhookNode.name = "Nexus Webhook Trigger";
    webhookNode.type = "n8n-nodes-base.webhook";
    webhookNode.parameters = {
      ...(webhookNode.parameters || {}),
      httpMethod: "POST",
      path: webhookPath,
      responseMode: "onReceived",
      options: webhookNode.parameters?.options || {},
    };

    if (oldName !== webhookNode.name) {
      connections = renameConnectionNode(connections, oldName, webhookNode.name);
    }
  } else {
    const supportedTriggers = triggerNodes.filter(isSupportedReplaceableTrigger);

    if (supportedTriggers.length > 1) {
      throw new Error("Multiple replaceable trigger nodes found. Keep one Manual/Schedule trigger before import.");
    }

    if (supportedTriggers.length === 1) {
      const oldTrigger = supportedTriggers[0];
      const oldName = oldTrigger.name;
      const oldPosition = oldTrigger.position || [0, 0];

      const newWebhook = buildWebhookNode(webhookPath, oldPosition);

      nodes = nodes.map((node: any) => {
        if (node.name === oldName) return newWebhook;
        return node;
      });

      connections = renameConnectionNode(connections, oldName, newWebhook.name);
    } else {
      const connectedTargets = getConnectedTargetNames(connections);
      const possibleStarts = nodes.filter((node: any) => !connectedTargets.has(node.name));

      if (possibleStarts.length !== 1) {
        throw new Error(
          "No supported trigger found. Add a Manual Trigger/Webhook Trigger, or make sure there is one clear starting node.",
        );
      }

      const startNode = possibleStarts[0];

      const webhook = buildWebhookNode(webhookPath, [
        (startNode.position?.[0] || 0) - 300,
        startNode.position?.[1] || 0,
      ]);

      nodes.unshift(webhook);

      connections[webhook.name] = {
        main: [
          [
            {
              node: startNode.name,
              type: "main",
              index: 0,
            },
          ],
        ],
      };
    }
  }

  const webhookNode = nodes.find((node: any) => node.name === "Nexus Webhook Trigger");

  if (!webhookNode) {
    throw new Error("Nexus Webhook Trigger was not found after normalization.");
  }

  const existingContextNode = nodes.find((node: any) => node.name === "Nexus Runtime Context");

  const contextNode = buildNexusRuntimeContextNode(
    [
      (webhookNode.position?.[0] || 0) + 300,
      webhookNode.position?.[1] || 0,
    ],
    existingContextNode,
  );

  if (existingContextNode) {
    nodes = nodes.map((node: any) => {
      if (node.name === "Nexus Runtime Context") return contextNode;
      return node;
    });
  } else {
    nodes.push(contextNode);
  }

  connections = wrapWebhookWithRuntimeContext(connections);

  /*
    We no longer need Nexus Runtime Merge.
    Every node can read customer setup/secrets from Nexus Runtime Context, and Nexus Submit Output
    can read customer_automation_id/runtime_secret from Nexus Runtime Context too.

    If an older import already added Nexus Runtime Merge, remove it and its connections.
  */
  nodes = nodes.filter((node: any) => node.name !== "Nexus Runtime Merge");

  if (connections["Nexus Runtime Merge"]) {
    delete connections["Nexus Runtime Merge"];
  }

  for (const sourceName of Object.keys(connections || {})) {
    const source = connections[sourceName];

    if (!source?.main || !Array.isArray(source.main)) continue;

    source.main = source.main.map((group: any) => {
      if (!Array.isArray(group)) return group;
      return group.filter((connection: any) => connection.node !== "Nexus Runtime Merge");
    });
  }

  const existingOutputNode = nodes.find((node: any) => node.name === "Nexus Submit Output");
  const markedFinalNode = nodes.find(isMarkedFinalOutputNode);

  let attachToNodeName = "";

  if (markedFinalNode) {
    attachToNodeName = markedFinalNode.name;
  }

  if (!attachToNodeName) {
    const terminalNames = getTerminalNodeNames(nodes, connections)
      .filter((name) => name !== "Nexus Submit Output")
      .filter((name) => name !== "Nexus Webhook Trigger")
      .filter((name) => name !== "Nexus Runtime Context");

    const bestOutputNode = pickBestOutputNode(nodes, terminalNames);

    if (bestOutputNode) {
      attachToNodeName = bestOutputNode.name;
    } else {
      throw new Error(
        `Could not safely detect the final output node. Found ${terminalNames.length} possible final nodes: ${terminalNames.join(", ")}. Rename the node that produces the buyer result to NEXUS_FINAL_OUTPUT or nexus-final-output.`,
      );
    }
  }

  const attachToNode = nodes.find((node: any) => node.name === attachToNodeName);

  if (!attachToNode) {
    throw new Error(`Final output node ${attachToNodeName} was selected but could not be found.`);
  }

  const outputNode = buildNexusOutputNode(
    callbackUrl,
    [
      (attachToNode?.position?.[0] || 600) + 300,
      attachToNode?.position?.[1] || 0,
    ],
    existingOutputNode,
  );

  if (existingOutputNode) {
    nodes = nodes.map((node: any) => {
      if (node.name === "Nexus Submit Output") return outputNode;
      return node;
    });
  } else {
    nodes.push(outputNode);
  }

  /*
    Make final result node go directly to Nexus Submit Output.
    This guarantees the dashboard callback executes without needing a merge node.
  */
  connections = removeMainConnectionTo(connections, attachToNodeName, "Nexus Submit Output");
  connections = ensureMainConnection(
    connections,
    attachToNodeName,
    "Nexus Submit Output",
    0,
  );

  const workflowName = `Nexus - ${product.id} - ${product.title || product.slug || "Automation"}`;

  /*
    Add retries to all HTTP Request nodes at import time.
    This protects customer-triggered runs from transient API failures,
    especially Facebook Graph OAuthException code 2 / temporary 500 errors.
  */
  nodes = applyRetrySettingsToWorkflowNodes(nodes);

  return {
    workflow: {
      name: workflowName,
      nodes,
      connections,
      settings: {
        executionOrder: workflow.settings?.executionOrder || "v1",
      },
      staticData: workflow.staticData || {},
    },
    webhookPath,
    webhookUrl: `${cleanBaseUrl(n8nBaseUrl)}/webhook/${webhookPath}`,
    callbackUrl,
  };
}

/* =========================================================
   N8N API HELPERS
   ========================================================= */

async function n8nRequest(n8nBaseUrl: string, n8nApiKey: string, path: string, options: RequestInit = {}) {
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

function normalizeWorkflowForN8nApi(workflow: any) {
  return {
    name: cleanString(workflow.name || "Nexus Workflow"),
    nodes: Array.isArray(workflow.nodes) ? workflow.nodes : [],
    connections: workflow.connections || {},
    settings: {
      executionOrder: workflow.settings?.executionOrder || "v1",
    },
    staticData: workflow.staticData || {},
  };
}

function removeUnboundCredentialReferences(workflow: any, errors: any[] = []) {
  if (!errors.length || !workflow || typeof workflow !== "object") {
    return workflow;
  }

  const missingByNode = new Map<string, Set<string>>();

  for (const error of errors || []) {
    const nodeName = cleanString(error?.node_name);
    const credentialKey = cleanString(error?.credential_key);
    if (!nodeName || !credentialKey) continue;

    if (!missingByNode.has(nodeName)) {
      missingByNode.set(nodeName, new Set());
    }
    missingByNode.get(nodeName)?.add(credentialKey);
  }

  if (!missingByNode.size) {
    return workflow;
  }

  const output = deepClone(workflow);
  output.nodes = Array.isArray(output.nodes)
    ? output.nodes.map((node: any) => {
      const keys = missingByNode.get(cleanString(node?.name));
      if (!keys?.size || !node?.credentials || typeof node.credentials !== "object") {
        return node;
      }

      const credentials = { ...node.credentials };
      for (const key of keys) {
        delete credentials[key];
      }

      if (Object.keys(credentials).length) {
        return {
          ...node,
          credentials,
        };
      }

      const { credentials: _removedCredentials, ...withoutCredentials } = node;
      return withoutCredentials;
    })
    : [];

  return output;
}

async function findExistingN8nWorkflowByName(n8nBaseUrl: string, n8nApiKey: string, workflowName: string) {
  const response = await n8nRequest(n8nBaseUrl, n8nApiKey, "/api/v1/workflows?limit=100", {
    method: "GET",
  });

  const workflows =
    Array.isArray(response?.data)
      ? response.data
      : Array.isArray(response)
        ? response
        : [];

  return workflows.find((workflow: any) => workflow.name === workflowName) || null;
}

async function updateWorkflow(n8nBaseUrl: string, n8nApiKey: string, workflowId: string, workflow: any) {
  const cleanWorkflow = normalizeWorkflowForN8nApi(workflow);

  try {
    return await n8nRequest(n8nBaseUrl, n8nApiKey, `/api/v1/workflows/${workflowId}`, {
      method: "PATCH",
      body: JSON.stringify(cleanWorkflow),
    });
  } catch (patchError) {
    return await n8nRequest(n8nBaseUrl, n8nApiKey, `/api/v1/workflows/${workflowId}`, {
      method: "PUT",
      body: JSON.stringify(cleanWorkflow),
    });
  }
}

async function importWorkflowToN8n(n8nBaseUrl: string, n8nApiKey: string, product: any, normalizedWorkflow: any) {
  const cleanWorkflow = normalizeWorkflowForN8nApi(normalizedWorkflow);

  if (product.n8n_workflow_id) {
    try {
      const updated = await updateWorkflow(n8nBaseUrl, n8nApiKey, product.n8n_workflow_id, cleanWorkflow);

      return {
        ...updated,
        id: product.n8n_workflow_id,
        updated_existing_workflow: true,
      };
    } catch {
      /*
        Saved n8n workflow ID may be stale/deleted.
        Fall through to name search/create.
      */
    }
  }

  const existingWorkflow = await findExistingN8nWorkflowByName(
    n8nBaseUrl,
    n8nApiKey,
    cleanWorkflow.name,
  );

  if (existingWorkflow?.id) {
    const updated = await updateWorkflow(n8nBaseUrl, n8nApiKey, existingWorkflow.id, cleanWorkflow);

    return {
      ...updated,
      id: existingWorkflow.id,
      reused_existing_workflow: true,
    };
  }

  const created = await n8nRequest(n8nBaseUrl, n8nApiKey, "/api/v1/workflows", {
    method: "POST",
    body: JSON.stringify(cleanWorkflow),
  });

  return created;
}

async function activateWorkflow(n8nBaseUrl: string, n8nApiKey: string, workflowId: string) {
  try {
    return await n8nRequest(n8nBaseUrl, n8nApiKey, `/api/v1/workflows/${workflowId}/activate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  } catch (error) {
    return {
      activation_warning: error instanceof Error ? error.message : String(error),
    };
  }
}

/* =========================================================
   AUTH
   ========================================================= */

async function requireMarketplaceOperator(req: Request, supabaseUrl: string, anonKey: string, serviceRoleKey: string) {
  const authHeader = req.headers.get("Authorization") || "";

  if (!authHeader.startsWith("Bearer ")) {
    return { user: null, profile: null, developer: null, error: "Missing auth token" };
  }

  const token = authHeader.replace("Bearer ", "");

  const userClient = createClient(supabaseUrl, anonKey, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  });

  const adminClient = createClient(supabaseUrl, serviceRoleKey);

  const { data: userData, error: userError } = await userClient.auth.getUser(token);

  if (userError || !userData?.user) {
    return { user: null, profile: null, developer: null, error: "Invalid auth token" };
  }

  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("id, role")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (profileError || !["admin", "developer"].includes(profile?.role)) {
    return { user: null, profile: null, developer: null, error: "Admin or developer access required" };
  }

  let developer = null;

  if (profile.role === "developer") {
    const { data: developerRow, error: developerError } = await adminClient
      .from("developers")
      .select("id, profile_id")
      .eq("profile_id", userData.user.id)
      .maybeSingle();

    if (developerError || !developerRow) {
      return { user: userData.user, profile, developer: null, error: "Developer account not found" };
    }

    developer = developerRow;
  }

  return { user: userData.user, profile, developer, error: null };
}

/* =========================================================
   EDGE FUNCTION
   ========================================================= */

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
      message: "import-n8n-workflow function is alive.",
      version: "runtime-context-production-ready-v2",
      env: {
        has_supabase_url: Boolean(env("SUPABASE_URL")),
        has_anon_key: Boolean(env("SUPABASE_ANON_KEY")),
        has_service_role: Boolean(env("SUPABASE_SERVICE_ROLE_KEY")),
        has_n8n_base_url: Boolean(env("N8N_BASE_URL")),
        has_n8n_api_key: Boolean(env("N8N_API_KEY")),
        has_runtime_secret: Boolean(env("NEXUS_RUNTIME_SECRET")),
        has_credential_secret: Boolean(env("NEXUS_CREDENTIAL_SECRET")),
      },
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    const supabaseUrl = env("SUPABASE_URL");
    const anonKey = env("SUPABASE_ANON_KEY");
    const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");
    const n8nBaseUrl = cleanBaseUrl(env("N8N_BASE_URL"));
    const n8nApiKey = env("N8N_API_KEY");
    const runtimeSecret = env("NEXUS_RUNTIME_SECRET");

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return errorResponse("Missing Supabase function secrets.", 500);
    }

    if (!n8nBaseUrl || !n8nApiKey) {
      return errorResponse("Missing N8N_BASE_URL or N8N_API_KEY.", 500);
    }

    if (!runtimeSecret) {
      return errorResponse("Missing NEXUS_RUNTIME_SECRET.", 500);
    }

    const { profile, developer, error: authError } = await requireMarketplaceOperator(req, supabaseUrl, anonKey, serviceRoleKey);

    if (authError) {
      return errorResponse(authError, 401);
    }

    const body = await req.json().catch(() => ({}));
    const automationId = body.automation_id;

    if (!automationId) {
      return errorResponse("automation_id is required.", 400);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey);

    const { data: product, error: productError } = await adminClient
      .from("automations")
      .select("*")
      .eq("id", automationId)
      .maybeSingle();

    if (productError || !product) {
      return errorResponse(productError?.message || "Automation product not found.", 404);
    }

    if (profile?.role === "developer" && product.developer_id !== developer?.id) {
      return errorResponse("Developer can only import their own products.", 403);
    }

    if (!product.n8n_workflow_json) {
      return errorResponse("No n8n workflow JSON found on this product.", 400);
    }

    const customMappings = normalizeMappings(product.workflow_placeholder_mappings);

    /*
      Launch-safe production behavior:
      If the uploaded workflow uses a mapped placeholder but the product schema is missing
      the target field, Nexus auto-adds the setup/credential field instead of failing.
      This lets admins upload many marketplace products without fighting schema drift.
    */
    const autoSchema = autoAddMissingSchemaFieldsForWorkflow(
      product,
      product.n8n_workflow_json,
      customMappings,
    );

    const productForImport = autoSchema.product;

    const credentialBinding = await bindAutomationCredentials({
      adminClient,
      product: productForImport,
      n8nBaseUrl,
      n8nApiKey,
      credentialSecret: env("NEXUS_CREDENTIAL_SECRET"),
      syncMissingN8nCredentials: true,
    });

    productForImport.n8n_workflow_json = credentialBinding.ok
      ? credentialBinding.workflow
      : removeUnboundCredentialReferences(credentialBinding.workflow, credentialBinding.errors);

    const mappingValidation = validateWorkflowPlaceholderMappings(
      productForImport,
      productForImport.n8n_workflow_json,
      customMappings,
    );

    if (mappingValidation.errors.length) {
      await adminClient
        .from("automations")
        .update({
          setup_schema: productForImport.setup_schema,
          credential_schema: productForImport.credential_schema,
          placeholder_validation_status: "needs_fix",
          placeholder_validation_errors: mappingValidation.errors,
          n8n_import_status: "failed",
          n8n_import_error: "Workflow placeholder mapping validation failed.",
          n8n_last_import_result: {
            errors: mappingValidation.errors,
            warnings: [
              ...autoSchema.warnings,
              ...mappingValidation.warnings,
            ],
            auto_added_setup_fields: autoSchema.addedSetupFields,
            auto_added_credential_fields: autoSchema.addedCredentialFields,
          },
        })
        .eq("id", automationId);

      return errorResponse("Workflow placeholder mapping validation failed.", 400, {
        errors: mappingValidation.errors,
        warnings: [
          ...autoSchema.warnings,
          ...mappingValidation.warnings,
        ],
        auto_added_setup_fields: autoSchema.addedSetupFields,
        auto_added_credential_fields: autoSchema.addedCredentialFields,
      });
    }

    const workflowForValidation = applyWorkflowPlaceholderMappings(
      productForImport.n8n_workflow_json,
      customMappings,
    );

    const validation = validatePlaceholders(productForImport, workflowForValidation);

    if (validation.errors.length) {
      await adminClient
        .from("automations")
        .update({
          detected_placeholders: validation.detected,
          placeholder_validation_status: "needs_fix",
          placeholder_validation_errors: validation.errors,
          n8n_import_status: "failed",
          n8n_import_error: "Placeholder validation failed.",
          n8n_last_import_result: {
            errors: validation.errors,
            warnings: mappingValidation.warnings,
          },
        })
        .eq("id", automationId);

      return errorResponse("Placeholder validation failed.", 400, {
        errors: validation.errors,
        warnings: mappingValidation.warnings,
        detected: validation.detected,
      });
    }

    const normalized = normalizeWorkflow(productForImport, productForImport.n8n_workflow_json, supabaseUrl, n8nBaseUrl);

    const imported = await importWorkflowToN8n(
      n8nBaseUrl,
      n8nApiKey,
      productForImport,
      normalized.workflow,
    );

    const workflowId = imported.id || imported.data?.id || product.n8n_workflow_id;

    if (!workflowId) {
      throw new Error("n8n did not return a workflow ID.");
    }

    const activation = await activateWorkflow(n8nBaseUrl, n8nApiKey, workflowId);

    const { data: updatedProduct, error: updateError } = await adminClient
      .from("automations")
      .update({
        runtime_type: "n8n_managed",
        runtime_webhook_path: normalized.webhookPath,
        runtime_webhook_url: normalized.webhookUrl,
        n8n_webhook_url: normalized.webhookUrl,
        n8n_workflow_id: workflowId,
        n8n_workflow_name: normalized.workflow.name,
        n8n_normalized_workflow_json: normalized.workflow,
        n8n_import_status: "imported",
        n8n_import_error: null,
        n8n_imported_at: new Date().toISOString(),
        n8n_last_synced_at: new Date().toISOString(),
        setup_schema: productForImport.setup_schema,
        credential_schema: productForImport.credential_schema,
        detected_placeholders: validation.detected,
        placeholder_validation_status: "valid",
        placeholder_validation_errors: [],
        developer_credential_requirements: credentialBinding.slots,
        n8n_credential_bindings: credentialBinding.bindings,
        credential_binding_status: credentialBinding.status,
        credential_binding_errors: credentialBinding.errors,
        n8n_last_credential_bound_at: new Date().toISOString(),
        n8n_last_import_result: {
          workflow_id: workflowId,
          webhook_url: normalized.webhookUrl,
          callback_url: normalized.callbackUrl,
          credential_binding_status: credentialBinding.status,
          credential_bindings: credentialBinding.bindings,
          custom_mapping_warnings: [
            ...autoSchema.warnings,
            ...mappingValidation.warnings,
            ...(validation.warnings || []),
          ],
          auto_added_setup_fields: autoSchema.addedSetupFields,
          auto_added_credential_fields: autoSchema.addedCredentialFields,
          activation,
        },
      })
      .eq("id", automationId)
      .select()
      .single();

    if (updateError) {
      return errorResponse(updateError.message, 500);
    }

    return jsonResponse({
      ok: true,
      product_id: updatedProduct.id,
      workflow_id: workflowId,
      webhook_url: normalized.webhookUrl,
      callback_url: normalized.callbackUrl,
      credential_binding_status: credentialBinding.status,
      credential_bindings: credentialBinding.bindings,
      custom_mapping_warnings: [
        ...autoSchema.warnings,
        ...mappingValidation.warnings,
        ...(validation.warnings || []),
      ],
      auto_added_setup_fields: autoSchema.addedSetupFields,
      auto_added_credential_fields: autoSchema.addedCredentialFields,
    });
  } catch (error) {
    console.error(error);

    if (isCredentialSchemaError(error)) {
      return errorResponse(
        `${error instanceof Error ? error.message : "Credential vault schema is missing."} Run supabase/developer_credentials_install_or_patch.sql in the Supabase SQL editor, then redeploy developer-credentials and import-n8n-workflow.`,
        500,
      );
    }

    return errorResponse(
      error instanceof Error ? error.message : "Could not import n8n workflow.",
      500,
    );
  }
});
