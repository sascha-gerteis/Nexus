import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import { bindAutomationCredentials, normalizeWorkflowResourceLocators } from "../_shared/nexus-credentials.ts";

function env(name: string) {
  return Deno.env.get(name) || "";
}

function cleanBaseUrl(url: string) {
  return String(url || "").replace(/\/$/, "");
}

function cleanString(value: unknown) {
  return String(value || "").trim();
}

function lower(value: unknown) {
  return cleanString(value).toLowerCase();
}

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
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

function runtimeContextPath(section: string, key: string) {
  const cleanSection = cleanString(section);
  const cleanKey = cleanString(key);
  if (!cleanSection || !cleanKey) return "";

  const keyPath = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(cleanKey)
    ? `.${cleanKey}`
    : `[${JSON.stringify(cleanKey)}]`;

  return `$("Nexus Runtime Context").first().json.${cleanSection}${keyPath}`;
}

function contextPathForMapping(source: string, key: string) {
  const requestedSource = cleanString(source).toLowerCase();
  const cleanSource =
    requestedSource === "setup" && isLikelyCredentialPlaceholderKey(key)
      ? "secret"
      : requestedSource;
  const cleanKey = cleanSource === "setup"
    ? canonicalSetupKey(key)
    : isSecretSource(cleanSource)
      ? canonicalSecretKey(key)
      : cleanString(key);

  if (!cleanKey) return "";

  if (cleanSource === "setup") {
    return runtimeContextPath("setup", cleanKey);
  }

  if (
    cleanSource === "secret" ||
    cleanSource === "secrets" ||
    cleanSource === "credential" ||
    cleanSource === "credentials"
  ) {
    return runtimeContextPath("secrets", cleanKey);
  }

  if (cleanSource === "customer") {
    return runtimeContextPath("customer", cleanKey);
  }

  if (cleanSource === "system") {
    return runtimeContextPath("system", cleanKey);
  }

  if (cleanSource === "order") {
    return runtimeContextPath("order", cleanKey);
  }

  return "";
}

function contextExpressionForMapping(source: string, key: string, expressionMode = false) {
  const path = contextPathForMapping(source, key);
  if (!path) return "";

  // Build neutral interpolation first. The recursive field normalizer adds n8n's
  // leading expression marker to every non-code value that contains this path.
  return `{{ ${path} }}`;
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
  if (!output.includes("Nexus Runtime Context")) return output;
  if (isCodeParameterKey(childKey)) return output;
  if (output.trimStart().startsWith("=")) return output;
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
      return '{{ $("Nexus Runtime Context").first().json.secrets.meta_access_token }}';
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
  const quotedFlags = placeholderRegex.flags.includes("i") ? "gi" : "g";

  /*
    Replace placeholders that are wrapped in quotes, for example:
      "{{NEXUS_SETUP.facebook_page_id}}"
      '{{NEXUS_SETUP.facebook_page_id}}'
      `{{NEXUS_SETUP.facebook_page_id}}`

    with valid JavaScript:
      String($("Nexus Runtime Context").first().json.setup.facebook_page_id ?? "")
  */
  output = output.replace(
    new RegExp("([\"\'`])\\s*" + placeholderRegex.source + "\\s*\\1", quotedFlags),
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
    nexusPlaceholderRegex("SETUP"),
    "setup",
  );

  output = replaceQuotedCodePlaceholder(
    output,
    nexusPlaceholderRegex("SECRET"),
    "secret",
  );

  output = replaceQuotedCodePlaceholder(
    output,
    nexusPlaceholderRegex("CUSTOMER"),
    "customer",
  );

  output = replaceQuotedCodePlaceholder(
    output,
    nexusPlaceholderRegex("SYSTEM"),
    "system",
  );

  output = replaceQuotedCodePlaceholder(
    output,
    nexusPlaceholderRegex("ORDER"),
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

  const bracketSetupPatterns = [
    /\{\{\s*\$json\[['"]([^'"]+)['"]\]\s*\}\}/g,
    /\{\{\s*\$json\.body\[['"]([^'"]+)['"]\]\s*\}\}/g,
  ];

  for (const pattern of bracketSetupPatterns) {
    output = output.replace(
      new RegExp("([\"'`])\\s*" + pattern.source + "\\s*\\1", "g"),
      (_full: string, _quote: string, key: string) => {
        return jsStringAccessorForMapping("setup", canonicalSetupKey(key)) || "\"\"";
      },
    );

    output = output.replace(pattern, (_full: string, key: string) => {
      return jsStringAccessorForMapping("setup", canonicalSetupKey(key)) || "\"\"";
    });
  }

  return output;
}

function convertCodeNodeDynamicReferences(sourceCode: string, mappings: any[] = []) {
  let output = String(sourceCode || "");

  output = convertNexusCodeHelpers(output);
  output = replaceMappedPlaceholdersInCode(output, mappings);
  output = convertOfficialPlaceholdersInCode(output);
  output = convertLegacyPlaceholdersInCode(output);
  output = convertLooseBarePlaceholders(output);
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

  const pattern = /\{\{\s*(?:(?:NEXUS|NX)[\s_-]*([A-Z]+)|([A-Z]+)[\s_-]*(?:NEXUS|NX))\s*(?:[|:.=_\-\[\(]|\s+)\s*([a-zA-Z0-9_. -]+?)\s*(?:[\]\)])?\s*\}\}/gi;
  let match;

  while ((match = pattern.exec(text)) !== null) {
    const type = String(match[1] || match[2] || "").toUpperCase();
    const name = match[3];

    if (type === "SETUP" && isLikelyCredentialPlaceholderKey(name)) {
      found.secret.push(canonicalSecretKey(name));
    }
    else if (type === "SETUP") found.setup.push(canonicalSetupKey(name));
    else if (type === "SECRET") found.secret.push(canonicalSecretKey(name));
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

  const setupNames = setupSchema.map((item: any) => canonicalSetupKey(item.name)).filter(Boolean);
  const credentialNames = credentialSchema.map((item: any) => canonicalSecretKey(item.name)).filter(Boolean);

  const errors: string[] = [];
  const warnings: string[] = [];

  for (const name of detected.setup) {
    if (!setupNames.includes(name)) {
      warnings.push(`NEXUS_SETUP.${name} was detected but setup_schema did not contain it. Nexus will still import, but the buyer form may need this field.`);
    }
  }

  for (const name of detected.secret) {
    const key = canonicalSecretKey(name);
    if (!credentialNames.includes(key)) {
      warnings.push(`NEXUS_SECRET.${name} was detected but credential_schema did not contain it. Nexus will still import, but the buyer form may need this secret field.`);
    }
  }

  for (const name of detected.unknown) {
    errors.push(`Unknown Nexus placeholder: ${name}`);
  }

  return { detected, errors, warnings };
}

function nexusPlaceholderRegex(type: string) {
  return new RegExp(
    `\\{\\{\\s*(?:(?:NEXUS|NX)[\\s_-]*${type}|${type}[\\s_-]*(?:NEXUS|NX))\\s*(?:[|:.=_\\-\\[\\(]|\\s+)\\s*([a-zA-Z0-9_. -]+?)\\s*(?:[\\]\\)])?\\s*\\}\\}`,
    "gi",
  );
}

function convertNexusPlaceholders(value: any, childKey = ""): any {
  if (typeof value === "string") {
    let output = value;

    const replacements = [
      {
        regex: nexusPlaceholderRegex("SETUP"),
        source: "setup",
      },
      {
        regex: nexusPlaceholderRegex("SECRET"),
        source: "secret",
      },
      {
        regex: nexusPlaceholderRegex("CUSTOMER"),
        source: "customer",
      },
      {
        regex: nexusPlaceholderRegex("SYSTEM"),
        source: "system",
      },
      {
        regex: nexusPlaceholderRegex("ORDER"),
        source: "order",
      },
    ];

    for (const item of replacements) {
      output = output.replace(item.regex, (fullMatch: string, key: string) => {
        const whole = isWholeString(value, fullMatch);
        const expressionMode = whole && isLikelyExpressionField(childKey);
        const source =
          item.source === "setup" && isLikelyCredentialPlaceholderKey(key)
            ? "secret"
            : item.source;
        const canonicalKey =
          source === "secret"
            ? canonicalSecretKey(key)
            : source === "setup"
              ? canonicalSetupKey(key)
              : key;
        return contextExpressionForMapping(source, canonicalKey, expressionMode);
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
  if (
    key.includes("notes") ||
    key.includes("description") ||
    key.includes("instructions") ||
    key.includes("competitor") ||
    key.includes("areas") ||
    key.includes("requirements")
  ) return "textarea";

  return "text";
}

function makeSetupField(name: string) {
  return {
    name,
    label: inferFieldLabel(name),
    type: inferSetupFieldType(name),
    required: true,
    description: "Auto-added by Nexus because the uploaded workflow uses this setup placeholder.",
  };
}

function setupField(
  name: string,
  label: string,
  type: string,
  description: string,
  placeholder = "",
  required = true,
) {
  return {
    name,
    label,
    type,
    required,
    ...(placeholder ? { placeholder } : {}),
    description,
  };
}

function makeCredentialField(name: string) {
  return {
    name,
    label: inferFieldLabel(name),
    type: "secret",
    required: true,
    customer_owned: true,
    test_value_required: true,
    description: "Buyer-owned access required by this workflow. Add a real test value in Technical test data; buyers provide their own value during setup.",
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

function normalizedSetupKey(value: unknown) {
  return cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function stripDerivedSetupSuffix(key: string) {
  const suffixes = [
    "_join",
    "_joined",
    "_csv",
    "_lines",
    "_text",
    "_string",
  ];

  for (const suffix of suffixes) {
    if (key.endsWith(suffix) && key.length > suffix.length + 2) {
      return key.slice(0, -suffix.length);
    }
  }

  return key;
}

function canonicalSetupKey(value: unknown) {
  const key = stripDerivedSetupSuffix(normalizedSetupKey(value));
  const aliases: Record<string, string> = {
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
  };

  return aliases[key] || key;
}

function canonicalSecretKey(value: unknown) {
  const key = normalizedSetupKey(value);
  const aliases: Record<string, string> = {
    apify_toke: "apify_token",
    apify_tokn: "apify_token",
    apify_api: "apify_token",
    apify_api_key: "apify_token",
    apify_key: "apify_token",
    apify_access_token: "apify_token",
    open_ai_key: "openai_api_key",
    openai_key: "openai_api_key",
    openai_token: "openai_api_key",
    open_ai_api_key: "openai_api_key",
    chatgpt_key: "openai_api_key",
    chatgpt_api_key: "openai_api_key",
    gpt_key: "openai_api_key",
    gpt_api_key: "openai_api_key",
    meta_token: "meta_access_token",
    meta_api_token: "meta_access_token",
    meta_api_key: "meta_access_token",
    facebook_token: "meta_access_token",
    facebook_access_token: "meta_access_token",
    fb_token: "meta_access_token",
    fb_access_token: "meta_access_token",
  };

  if (aliases[key]) return aliases[key];
  if (key.includes("apify") && (key.includes("tok") || key.includes("key"))) return "apify_token";
  if ((key.includes("openai") || key.includes("chatgpt") || key === "gpt_key") && (key.includes("key") || key.includes("token"))) {
    return "openai_api_key";
  }
  if (
    (key.includes("meta") || key.includes("facebook") || key.startsWith("fb_")) &&
    (key.includes("key") || key.includes("token"))
  ) {
    return "meta_access_token";
  }

  return key;
}

function isLikelyCredentialPlaceholderKey(value: unknown) {
  const key = normalizedSetupKey(value);
  if (!key) return false;

  return (
    key.includes("api_key") ||
    key.includes("apikey") ||
    key.includes("api_token") ||
    key.includes("access_token") ||
    key.includes("auth_token") ||
    key.includes("refresh_token") ||
    key.includes("secret_key") ||
    key.includes("client_secret") ||
    key.includes("private_key") ||
    key.includes("credential") ||
    key.includes("bearer") ||
    key.includes("password") ||
    key === "token" ||
    key === "secret" ||
    key.includes("apify_toke") ||
    key.includes("apify_tok") ||
    ((key.includes("openai") || key.includes("chatgpt") || key.startsWith("gpt_")) && (key.includes("key") || key.includes("token")))
  );
}

function isLikelySetupPlaceholderKey(value: unknown) {
  const key = normalizedSetupKey(value);
  if (!key || isLikelyCredentialPlaceholderKey(key)) return false;
  if (["item", "data", "json", "body", "result", "response", "output"].includes(key)) return false;
  return /^[a-z][a-z0-9_]{1,79}$/.test(key);
}

function addSetupName(target: Set<string>, value: unknown) {
  if (isLikelyCredentialPlaceholderKey(value)) return;
  const key = canonicalSetupKey(value);
  if (key) target.add(key);
}

function extractRuntimeSetupKeys(text: string) {
  const setupNames = new Set<string>();
  const source = String(text || "");
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
      addSetupName(setupNames, match[1]);
    }
  }

  return [...setupNames].sort();
}

function extractLooseBarePlaceholders(text: string) {
  const setupNames = new Set<string>();
  const secretNames = new Set<string>();
  const source = String(text || "");
  const pattern = /\{\{\s*([a-zA-Z][a-zA-Z0-9_ -]{1,80})\s*\}\}/g;
  let match;

  while ((match = pattern.exec(source)) !== null) {
    const rawKey = cleanString(match[1]);
    if (!rawKey) continue;

    if (isLikelyCredentialPlaceholderKey(rawKey)) {
      const key = canonicalSecretKey(rawKey);
      if (key) secretNames.add(key);
      continue;
    }

    if (isLikelySetupPlaceholderKey(rawKey)) {
      const key = canonicalSetupKey(rawKey);
      if (key) setupNames.add(key);
    }
  }

  return {
    setup: [...setupNames].sort(),
    secret: [...secretNames].sort(),
  };
}

function convertLooseBarePlaceholders(value: any, childKey = ""): any {
  if (typeof value === "string") {
    let output = value;
    const pattern = /\{\{\s*([a-zA-Z][a-zA-Z0-9_ -]{1,80})\s*\}\}/g;

    output = output.replace(pattern, (fullMatch: string, rawKey: string) => {
      if (isLikelyCredentialPlaceholderKey(rawKey)) {
        const key = canonicalSecretKey(rawKey);
        const whole = isWholeString(value, fullMatch);
        const expressionMode = whole && isLikelyExpressionField(childKey);
        return contextExpressionForMapping("secret", key, expressionMode) || fullMatch;
      }

      if (isLikelySetupPlaceholderKey(rawKey)) {
        const key = canonicalSetupKey(rawKey);
        const whole = isWholeString(value, fullMatch);
        const expressionMode = whole && isLikelyExpressionField(childKey);
        return contextExpressionForMapping("setup", key, expressionMode) || fullMatch;
      }

      return fullMatch;
    });

    output = repairBadMixedCredentialValue(output);
    output = forceN8nExpressionModeIfNeeded(output, childKey);
    return output;
  }

  if (Array.isArray(value)) {
    return value.map((item) => convertLooseBarePlaceholders(item, childKey));
  }

  if (value && typeof value === "object") {
    const result: Record<string, any> = {};

    for (const [key, child] of Object.entries(value)) {
      result[key] = convertLooseBarePlaceholders(child, key);
    }

    return result;
  }

  return value;
}

function isEmptyNodeValue(value: any) {
  if (value == null) return true;
  if (typeof value === "string") return !cleanString(value);
  if (typeof value === "number" || typeof value === "boolean") return false;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") {
    const object = asObject(value);
    if (cleanString(object.value) || cleanString(object.cachedResultName) || cleanString(object.name)) {
      return false;
    }
    return Object.keys(object).length === 0 || Object.values(object).every(isEmptyNodeValue);
  }
  return false;
}

function firstParameterValue(parameters: Record<string, any>, keys: string[]) {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(parameters, key)) {
      return parameters[key];
    }
  }
  return undefined;
}

function setupExpression(key: string) {
  return contextExpressionForMapping("setup", key, true);
}

function setupResourceLocator(key: string, mode = "url") {
  return {
    __rl: true,
    value: setupExpression(key),
    mode,
  };
}

function literalResourceLocator(value: unknown, fallbackMode = "id") {
  const raw = cleanString(value);
  if (!raw) return null;

  return {
    __rl: true,
    value: raw,
    mode: /^https?:\/\//i.test(raw) ? "url" : fallbackMode,
  };
}

function writeEmptyParameter(parameters: Record<string, any>, keys: string[], value: any) {
  const key = keys.find((item) => Object.prototype.hasOwnProperty.call(parameters, item)) || keys[0];
  if (!key || !isEmptyNodeValue(parameters[key])) return false;
  parameters[key] = value;
  return true;
}

function addSpecificSetupField(
  setupSchema: any[],
  setupNames: Set<string>,
  warnings: string[],
  addedSetupFields: any[],
  field: any,
  reason: string,
) {
  const key = canonicalSetupKey(field?.name);
  if (!key || setupNames.has(key)) return;

  const normalizedField = {
    ...field,
    name: key,
  };
  setupSchema.push(normalizedField);
  setupNames.add(key);
  addedSetupFields.push(normalizedField);
  warnings.push(`Auto-added setup field ${key} ${reason}.`);
}

function sheetAccessConfigForProduct(product: any) {
  const detected = asObject(product?.detected_placeholders);
  const config = asObject(detected._nexus_sheet_access_config || product?.sheet_access_config);
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

function autoAddNativeAppSetupFieldsForWorkflow(
  workflow: any,
  setupSchema: any[],
  setupNames: Set<string>,
  warnings: string[],
  addedSetupFields: any[],
  product: any = {},
) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  const sheetConfig = sheetAccessConfigForProduct(product);

  for (const node of nodes) {
    const nodeText = cleanString(`${node?.type || ""} ${node?.name || ""}`).toLowerCase();
    const parameters = asObject(node?.parameters);

    if (nodeText.includes("googlesheets") || nodeText.includes("google sheets")) {
      const spreadsheetTarget = firstParameterValue(parameters, [
        "documentId",
        "spreadsheetId",
        "sheetId",
        "fileId",
        "documentUrl",
        "spreadsheetUrl",
      ]);
      const sheetTarget = firstParameterValue(parameters, [
        "sheetName",
        "sheet",
        "tabName",
        "worksheet",
      ]);
      const rangeTarget = firstParameterValue(parameters, [
        "range",
        "dataRange",
      ]);

      if (isEmptyNodeValue(spreadsheetTarget)) {
        if (sheetConfig.mode === "developer_owned") {
          const locator = literalResourceLocator(sheetConfig.developer_sheet_id, "id") || setupResourceLocator("nexus_dev_sheet_id", "id");
          writeEmptyParameter(parameters, ["documentId", "spreadsheetId", "sheetId", "fileId", "documentUrl", "spreadsheetUrl"], locator);
          warnings.push(`Google Sheets node "${node?.name || "Google Sheets"}" uses a developer-owned hidden sheet. Nexus will not ask the buyer for this sheet.`);
        } else if (sheetConfig.mode === "private_per_customer") {
          writeEmptyParameter(parameters, ["documentId", "spreadsheetId", "sheetId", "fileId", "documentUrl", "spreadsheetUrl"], setupResourceLocator("nexus_private_customer_sheet_id", "id"));
          warnings.push(`Google Sheets node "${node?.name || "Google Sheets"}" uses a private per-customer sheet. Nexus stores the template/customer sheet intent outside the buyer form.`);
        } else {
          addSpecificSetupField(
            setupSchema,
            setupNames,
            warnings,
            addedSetupFields,
            setupField(
              "google_sheet_url",
              "Google Sheet URL",
              "url",
              "Auto-added because a Google Sheets node needs the target spreadsheet. The buyer can paste the sheet URL during setup, or the developer can choose a hidden sheet mode in the product builder.",
              "https://docs.google.com/spreadsheets/d/...",
            ),
            `because "${node?.name || "Google Sheets"}" needs a spreadsheet target`,
          );
          writeEmptyParameter(parameters, ["documentId", "spreadsheetId", "sheetId", "fileId", "documentUrl", "spreadsheetUrl"], setupResourceLocator("google_sheet_url", "url"));
        }
      }

      if (isEmptyNodeValue(sheetTarget)) {
        if (sheetConfig.mode === "customer_owned") {
          addSpecificSetupField(
            setupSchema,
            setupNames,
            warnings,
            addedSetupFields,
            setupField(
              "google_sheet_name",
              "Google Sheet tab",
              "text",
              "Auto-added because a Google Sheets node needs the worksheet/tab name.",
              "Sheet1",
            ),
            `because "${node?.name || "Google Sheets"}" needs a sheet/tab name`,
          );
          writeEmptyParameter(parameters, ["sheetName", "sheet", "tabName", "worksheet"], setupResourceLocator("google_sheet_name", "name"));
        } else if (sheetConfig.sheet_tab) {
          writeEmptyParameter(parameters, ["sheetName", "sheet", "tabName", "worksheet"], sheetConfig.sheet_tab);
        } else {
          writeEmptyParameter(parameters, ["sheetName", "sheet", "tabName", "worksheet"], setupResourceLocator("nexus_sheet_tab", "name"));
          warnings.push(`Google Sheets node "${node?.name || "Google Sheets"}" needs a sheet tab. Nexus will use the hidden sheet tab from the product sheet access settings.`);
        }
      }

      if (isEmptyNodeValue(rangeTarget)) {
        if (sheetConfig.mode === "customer_owned") {
          addSpecificSetupField(
            setupSchema,
            setupNames,
            warnings,
            addedSetupFields,
            setupField(
              "google_sheet_range",
              "Google Sheet range",
              "text",
              "Auto-added because a Google Sheets node may need a read/write range. Leave the field editable if the exact range depends on the buyer's sheet.",
              "A:Z",
              false,
            ),
            `because "${node?.name || "Google Sheets"}" may need a sheet range`,
          );
          writeEmptyParameter(parameters, ["range", "dataRange"], setupExpression("google_sheet_range"));
        } else if (sheetConfig.sheet_range) {
          writeEmptyParameter(parameters, ["range", "dataRange"], sheetConfig.sheet_range);
        } else {
          writeEmptyParameter(parameters, ["range", "dataRange"], setupExpression("nexus_sheet_range"));
        }
      }
    }

    if (nodeText.includes("googledrive") || nodeText.includes("google drive")) {
      const fileTarget = firstParameterValue(parameters, ["fileId", "folderId", "documentId", "fileUrl", "folderUrl"]);
      if (isEmptyNodeValue(fileTarget)) {
        addSpecificSetupField(
          setupSchema,
          setupNames,
          warnings,
          addedSetupFields,
          setupField(
            "google_drive_file_url",
            "Google Drive file or folder URL",
            "url",
            "Auto-added because a Google Drive node needs the target file or folder.",
            "https://drive.google.com/...",
          ),
          `because "${node?.name || "Google Drive"}" needs a file or folder target`,
        );
        writeEmptyParameter(parameters, ["fileId", "folderId", "documentId", "fileUrl", "folderUrl"], setupResourceLocator("google_drive_file_url", "url"));
      }
    }

    if (nodeText.includes("gmail")) {
      const toTarget = firstParameterValue(parameters, ["to", "sendTo", "recipient", "email"]);
      if (isEmptyNodeValue(toTarget)) {
        addSpecificSetupField(
          setupSchema,
          setupNames,
          warnings,
          addedSetupFields,
          setupField(
            "recipient_email",
            "Recipient email",
            "email",
            "Auto-added because a Gmail node needs the email address it should send to or process for this buyer.",
            "team@example.com",
            false,
          ),
          `because "${node?.name || "Gmail"}" may need a recipient email`,
        );
        writeEmptyParameter(parameters, ["to", "sendTo", "recipient", "email"], setupExpression("recipient_email"));
      }
    }

    node.parameters = parameters;
  }
}

function inferMakeSetupKeysFromText(text: string) {
  const setupNames = new Set<string>();
  const source = String(text || "").toLowerCase();

  const rules = [
    {
      key: "company_url",
      pattern: /\b(company|business|buyer|client|customer)(?:'s)?\s+(?:main\s+)?(?:website|site|url)\b|\bmain\s+website\b/,
    },
    {
      key: "competitor_urls",
      pattern: /\bcompetitor(?:s)?\s+(?:websites?|sites?|urls?)\b|\bcompetitor\s+list\b/,
    },
    {
      key: "focus_areas",
      pattern: /\bfocus\s+areas?\b|\bfocus\s+topics?\b|\bpricing,\s*offers,\s*messaging\b|\bpricing\s+offers\s+messaging\b/,
    },
    {
      key: "market_region",
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

function addGeneratedSetupFields(
  setupSchema: any[],
  setupNames: Set<string>,
  detectedNames: string[],
  warnings: string[],
  addedSetupFields: any[],
  reason: string,
) {
  for (const name of detectedNames || []) {
    const key = canonicalSetupKey(name);
    if (!key || setupNames.has(key)) continue;

    const field = makeSetupField(key);
    setupSchema.push(field);
    setupNames.add(key);
    addedSetupFields.push(field);
    warnings.push(`Auto-added setup field ${key} ${reason}.`);
  }
}

function autoAddMissingSchemaFieldsForWorkflow(product: any, workflow: any, mappings: any[]) {
  const workflowForImport = deepClone(workflow || {});
  const workflowText = JSON.stringify(workflowForImport || {});
  const setupSchema = normalizeJsonArray(product.setup_schema);
  const credentialSchema = normalizeJsonArray(product.credential_schema);

  const setupNames = new Set(
    setupSchema
      .map((item: any) => canonicalSetupKey(item?.name))
      .filter(Boolean),
  );
  const credentialNames = new Set(credentialSchema.map((item: any) => canonicalSecretKey(item?.name)).filter(Boolean));

  const addedSetupFields: any[] = [];
  const addedCredentialFields: any[] = [];
  const warnings: string[] = [];

  /*
    Official placeholders: {{NEXUS_SETUP.field}} and {{NEXUS_SECRET.field}}
    These should never block launch. If a dev uses them, Nexus creates the missing schema field.
  */
  const detected = extractPlaceholders(workflowText);

  for (const name of detected.setup || []) {
    const key = canonicalSetupKey(name);
    if (!key || setupNames.has(key)) continue;

    const field = makeSetupField(key);
    setupSchema.push(field);
    setupNames.add(key);
    addedSetupFields.push(field);
    warnings.push(`Auto-added setup field ${key} from NEXUS_SETUP.${key}.`);
  }

  for (const name of detected.secret || []) {
    const key = canonicalSecretKey(name);
    if (!key || credentialNames.has(key)) continue;

    const field = makeCredentialField(key);
    credentialSchema.push(field);
    credentialNames.add(key);
    addedCredentialFields.push(field);
    warnings.push(`Auto-added credential field ${key} from NEXUS_SECRET.${key}.`);
  }

  const loosePlaceholders = extractLooseBarePlaceholders(workflowText);

  addGeneratedSetupFields(
    setupSchema,
    setupNames,
    loosePlaceholders.setup,
    warnings,
    addedSetupFields,
    "from loose buyer setup placeholders",
  );

  for (const name of loosePlaceholders.secret || []) {
    const key = canonicalSecretKey(name);
    if (!key || credentialNames.has(key)) continue;

    const field = makeCredentialField(key);
    credentialSchema.push(field);
    credentialNames.add(key);
    addedCredentialFields.push(field);
    warnings.push(`Auto-added credential field ${key} from loose credential placeholder ${name}.`);
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
      const canonicalKey = canonicalSetupKey(key);
      if (!setupNames.has(canonicalKey)) {
        const field = makeSetupField(canonicalKey);
        setupSchema.push(field);
        setupNames.add(canonicalKey);
        addedSetupFields.push(field);
        warnings.push(`Auto-added setup field ${canonicalKey} because workflow uses ${placeholder}.`);
      }
      continue;
    }

    if (isSecretSource(source)) {
      const canonicalKey = canonicalSecretKey(key);
      if (!credentialNames.has(canonicalKey)) {
        const field = makeCredentialField(canonicalKey);
        credentialSchema.push(field);
        credentialNames.add(canonicalKey);
        addedCredentialFields.push(field);
        warnings.push(`Auto-added credential field ${canonicalKey} because workflow uses ${placeholder}.`);
      }
      continue;
    }
  }

  addGeneratedSetupFields(
    setupSchema,
    setupNames,
    extractRuntimeSetupKeys(workflowText),
    warnings,
    addedSetupFields,
    "from runtime setup references",
  );

  autoAddNativeAppSetupFieldsForWorkflow(
    workflowForImport,
    setupSchema,
    setupNames,
    warnings,
    addedSetupFields,
    product,
  );

  if (["make", "zapier"].includes(cleanString(product.workflow_source_platform).toLowerCase()) || product.make_blueprint) {
    addGeneratedSetupFields(
      setupSchema,
      setupNames,
      inferMakeSetupKeysFromText(JSON.stringify(product.make_blueprint || {}) + "\n" + workflowText),
      warnings,
      addedSetupFields,
      "from source workflow buyer input hints",
    );
  }

  return {
    product: {
      ...product,
      setup_schema: setupSchema,
      credential_schema: credentialSchema,
      n8n_workflow_json: workflowForImport,
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
  const credentialNames = credentialSchema.map((item: any) => canonicalSecretKey(item.name)).filter(Boolean);

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

    if (isSecretSource(source) && !credentialNames.includes(canonicalSecretKey(key))) {
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
        regex: /\{\{\s*\$json\[['"]([^'"]+)['"]\]\s*\}\}/g,
        source: "setup",
      },
      {
        regex: /\{\{\s*\$json\.body\[['"]([^'"]+)['"]\]\s*\}\}/g,
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
        const mappedKey = item.source === "setup" ? canonicalSetupKey(key) : key;
        return contextExpressionForMapping(item.source, mappedKey, expressionMode);
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
      jsCode: `const incoming = $("Nexus Webhook Trigger").first().json || {};
const body = incoming.body || {};

return [
  {
    json: {
      ...incoming,
      body,
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

function buildNexusSubmitOutputBodyExpression() {
  return `={{ (() => {
  const context = $("Nexus Runtime Context").first().json || {};
  const source = $json || {};
  const outputKeys = [
    "NEXUS_FINAL_OUTPUT",
    "Nexus_final_output",
    "nexus_final_output",
    "nexusFinalOutput",
    "final_output",
    "finalOutput",
    "automation_output",
    "automationOutput",
    "output",
    "result",
    "report",
    "payload",
    "data",
    "body"
  ];
  const isPlainObject = (value) => value && typeof value === "object" && !Array.isArray(value);
  const maybeParse = (value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (!((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]")))) {
      return value;
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  };
  const unwrap = (value) => {
    let current = maybeParse(value);
    for (let index = 0; index < 4; index += 1) {
      if (Array.isArray(current)) {
        current = current.length === 1 ? maybeParse(current[0]) : current;
        continue;
      }
      if (!isPlainObject(current)) return current;
      const key = outputKeys.find((candidate) => {
        const candidateValue = current[candidate];
        return candidateValue !== undefined && candidateValue !== null && candidateValue !== "";
      });
      if (!key) return current;
      current = maybeParse(current[key]);
    }
    return current;
  };
  const finalValue = unwrap(source);
  const objectOutput = isPlainObject(finalValue) ? finalValue : {};
  const textOutput = typeof finalValue === "string" ? finalValue : "";
  const looksLikeHtml = /<[a-z][\\s\\S]*>/i.test(textOutput);
  const contentHtml =
    objectOutput.content_html ||
    objectOutput.contentHtml ||
    objectOutput.html ||
    objectOutput.HTML ||
    objectOutput.report_html ||
    objectOutput.reportHtml ||
    (looksLikeHtml ? textOutput : "");
  const contentText =
    objectOutput.content_text ||
    objectOutput.contentText ||
    objectOutput.text ||
    objectOutput.markdown ||
    objectOutput.output_text ||
    objectOutput.outputText ||
    (!contentHtml ? textOutput : "");
  const contentJson =
    objectOutput.content_json ||
    objectOutput.contentJson ||
    objectOutput.json ||
    (isPlainObject(finalValue) || Array.isArray(finalValue)
      ? finalValue
      : (textOutput ? { value: textOutput } : source));

  return JSON.stringify({
    customer_automation_id:
      context.system?.customer_automation_id ||
      source.customer_automation_id ||
      source.system?.customer_automation_id ||
      source.body?.customer_automation_id ||
      source.body?.system?.customer_automation_id ||
      "",
    run_id:
      context.system?.run_id ||
      source.run_id ||
      source.system?.run_id ||
      source.body?.run_id ||
      source.body?.system?.run_id ||
      "",
    run_key:
      context.system?.run_key ||
      source.run_key ||
      source.system?.run_key ||
      source.body?.run_key ||
      source.body?.system?.run_key ||
      "",
    status: objectOutput.status || "success",
    output_type: objectOutput.output_type || objectOutput.outputType || "report",
    title:
      objectOutput.title ||
      objectOutput.report_title ||
      objectOutput.reportTitle ||
      objectOutput.name ||
      "Automation output",
    summary: objectOutput.summary || objectOutput.description || "",
    content_html: contentHtml,
    content_text: contentText,
    file_url: objectOutput.file_url || objectOutput.fileUrl || "",
    storage_path: objectOutput.storage_path || objectOutput.storagePath || "",
    content_json: contentJson
  });
})() }}`;
}

function buildNexusSubmitOutputBodyParameters() {
  return {
    parameters: [
      {
        name: "customer_automation_id",
        value: '={{ $("Nexus Runtime Context").first().json.system.customer_automation_id }}',
      },
      {
        name: "run_id",
        value: '={{ $("Nexus Runtime Context").first().json.system.run_id || "" }}',
      },
      {
        name: "run_key",
        value: '={{ $("Nexus Runtime Context").first().json.system.run_key || "" }}',
      },
      {
        name: "status",
        value: "success",
      },
      {
        name: "output_type",
        value: '={{ $json.output_type || $json.outputType || "report" }}',
      },
      {
        name: "title",
        value:
          '={{ $json.title || $json.report_title || $json.reportTitle || $json.name || "Automation output" }}',
      },
      {
        name: "summary",
        value: '={{ $json.summary || $json.description || "" }}',
      },
      {
        name: "content_html",
        value:
          '={{ $json.content_html || $json.contentHtml || $json.html || $json.HTML || $json.report_html || $json.reportHtml || "" }}',
      },
      {
        name: "content_text",
        value:
          '={{ $json.content_text || $json.contentText || $json.text || $json.markdown || $json.output_text || $json.outputText || "" }}',
      },
      {
        name: "file_url",
        value: '={{ $json.file_url || $json.fileUrl || "" }}',
      },
      {
        name: "storage_path",
        value: '={{ $json.storage_path || $json.storagePath || "" }}',
      },
      {
        name: "content_json",
        value:
          '={{ JSON.stringify($json.content_json || $json.contentJson || $json.json || $json.data || $json) }}',
      },
    ],
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
          {
            name: "x-nexus-customer-automation-id",
            value: '={{ $("Nexus Runtime Context").first().json.system.customer_automation_id }}',
          },
          {
            name: "Content-Type",
            value: "application/json",
          },
        ],
      },
      sendBody: true,
      bodyContentType: "json",
      specifyBody: "keypair",
      bodyParameters: buildNexusSubmitOutputBodyParameters(),
      options: {},
    },
    id: existingNode?.id || crypto.randomUUID(),
    name: "Nexus Submit Output",
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 4.2,
    position: existingNode?.position || position,
  };
}

function providerFromUrlOrName(value: string) {
  const text = cleanString(value).toLowerCase();
  if (text.includes("generativelanguage") || text.includes("gemini") || text.includes("googleapis")) {
    return { provider: "google_gemini", label: "Google Gemini" };
  }
  if (text.includes("openai")) return { provider: "openai", label: "OpenAI" };
  if (text.includes("anthropic") || text.includes("claude")) return { provider: "anthropic", label: "Anthropic" };
  if (text.includes("openrouter")) return { provider: "openrouter", label: "OpenRouter" };
  if (text.includes("groq")) return { provider: "groq", label: "Groq" };
  if (text.includes("mistral")) return { provider: "mistral", label: "Mistral AI" };
  if (text.includes("perplexity")) return { provider: "perplexity", label: "Perplexity" };
  if (text.includes("slack")) return { provider: "slack", label: "Slack" };
  if (text.includes("hubspot")) return { provider: "hubspot", label: "HubSpot" };
  if (text.includes("airtable")) return { provider: "airtable", label: "Airtable" };
  if (text.includes("notion")) return { provider: "notion", label: "Notion" };
  if (text.includes("stripe")) return { provider: "stripe", label: "Stripe" };
  if (text.includes("github")) return { provider: "github", label: "GitHub" };
  if (text.includes("apify")) return { provider: "apify", label: "Apify" };
  if (text.includes("serper")) return { provider: "serper", label: "Serper" };
  if (text.includes("firecrawl")) return { provider: "firecrawl", label: "Firecrawl" };
  return { provider: "webhook_api", label: "Generic API / Webhook" };
}

function keyValueCollectionToObject(value: any) {
  const input = asObject(value);
  const rows = Array.isArray(input.parameters)
    ? input.parameters
    : Array.isArray(input.parameter)
      ? input.parameter
      : [];

  return rows.reduce((accumulator: Record<string, any>, item: any) => {
    const name = cleanString(item?.name || item?.key);
    if (name) accumulator[name] = item?.value ?? "";
    return accumulator;
  }, {});
}

function parseJsonObjectString(value: any) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function makeRuntimeProxyCode(nodeName: string, proxyUrl: string, anonKey: string, template: any) {
  return [
    "const context = $('Nexus Runtime Context').first().json || {};",
    `const template = ${JSON.stringify(template, null, 2)};`,
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
    `    'authorization': 'Bearer ${anonKey}',`,
    `    'apikey': '${anonKey}',`,
    "    'x-nexus-runtime-secret': context.system?.runtime_secret || ''",
    "  };",
    "  if (typeof fetch === 'function') {",
    `    const response = await fetch(${JSON.stringify(proxyUrl)}, { method: 'POST', headers, body: JSON.stringify(payload) });`,
    "    const text = await response.text();",
    "    let data;",
    "    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }",
    "    if (!response.ok) throw new Error(data.message || data.error || data.raw || `Nexus proxy request failed with status ${response.status}`);",
    "    return data;",
    "  }",
    "  if (nexusHelpers?.request) {",
    `    return await nexusHelpers.request({ method: 'POST', uri: ${JSON.stringify(proxyUrl)}, headers, body: payload, json: true });`,
    "  }",
    "  if (nexusHelpers?.httpRequest) {",
    `    return await nexusHelpers.httpRequest({ method: 'POST', url: ${JSON.stringify(proxyUrl)}, headers, body: payload, json: true });`,
    "  }",
    "  throw new Error('This n8n Code node cannot make HTTP requests because fetch and n8n HTTP helpers are unavailable. Update n8n or run this product through the Nexus Make proxy runner.');",
    "}",
    "const query = renderValue(template.query || {});",
    "const url = appendQuery(renderString(template.url), query);",
    "const data = await callNexusProxy({",
    "    automation_id: context.automation_id || context.system?.automation_id || '',",
    `    node_name: ${JSON.stringify(nodeName)},`,
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

function runtimeContextExpressionForHttpTemplate(source: string, key: string) {
  const sourceKey = cleanString(source).toLowerCase();
  const bucket =
    ["secret", "secrets", "credential", "credentials"].includes(sourceKey)
      ? "secrets"
      : sourceKey === "customer"
        ? "customer"
        : sourceKey === "order"
          ? "order"
          : sourceKey === "system"
            ? "system"
            : "setup";

  return `{{ $('Nexus Runtime Context').first().json.${bucket}.${cleanString(key)} }}`;
}

function renderNexusRuntimeTemplatesForHttp(value: any, prefixExpression = true): any {
  if (Array.isArray(value)) return value.map((item) => renderNexusRuntimeTemplatesForHttp(item, prefixExpression));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, renderNexusRuntimeTemplatesForHttp(inner, prefixExpression)]));
  }
  if (typeof value !== "string") return value;

  const rendered = value.replace(
    /\{\{\s*NEXUS_(SETUP|SECRET|SECRETS|CUSTOMER|ORDER|SYSTEM)\.([a-zA-Z0-9_.-]+)\s*\}\}/g,
    (_match, source, key) => runtimeContextExpressionForHttpTemplate(source, key),
  );

  return prefixExpression && rendered.includes("$('Nexus Runtime Context').first().json") && !rendered.trim().startsWith("=")
    ? `=${rendered}`
    : rendered;
}

function objectToHttpParameterRows(value: Record<string, any>) {
  return Object.entries(value || {})
    .filter(([key]) => cleanString(key))
    .map(([name, inner]) => ({
      name,
      value: renderNexusRuntimeTemplatesForHttp(inner),
    }));
}

function hasHttpPayload(value: any) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return value !== undefined && value !== null && value !== "";
}

function stripContentTypeHeaderForHttp(headers: Record<string, any>) {
  return Object.entries(headers || {}).reduce((accumulator: Record<string, any>, [key, value]) => {
    if (cleanString(key).toLowerCase() === "content-type") return accumulator;
    accumulator[key] = value;
    return accumulator;
  }, {});
}

function httpTemplateBody(template: Record<string, any>) {
  if (template.body_json !== undefined && template.body_json !== null) return template.body_json;
  if (template.body !== undefined && template.body !== null) return template.body;
  if (template.jsonBody !== undefined && template.jsonBody !== null) return parseJsonObjectString(template.jsonBody);
  if (template.bodyParametersJson !== undefined && template.bodyParametersJson !== null) {
    return parseJsonObjectString(template.bodyParametersJson);
  }
  return {};
}

function makeLegacyHttpParametersFromTemplate(input: {
  method: string;
  url: string;
  credentialKey: string;
  headers: Record<string, any>;
  query: Record<string, any>;
  body: any;
}) {
  const body = renderNexusRuntimeTemplatesForHttp(input.body || {}, false);
  const methodFromInput = cleanString(input.method || "GET").toUpperCase();
  const method = methodFromInput === "GET" && hasHttpPayload(body) ? "POST" : methodFromInput;
  const parameters: Record<string, any> = {
    authentication: input.credentialKey ? "genericCredentialType" : "none",
    requestMethod: method,
    url: renderNexusRuntimeTemplatesForHttp(input.url),
    responseFormat: "json",
    jsonParameters: true,
    options: {},
  };

  if (input.credentialKey) {
    parameters.genericAuthType = input.credentialKey;
  }

  const headers = stripContentTypeHeaderForHttp(renderNexusRuntimeTemplatesForHttp(input.headers || {}, false));
  if (Object.keys(headers).length) {
    parameters.headerParametersJson = JSON.stringify(headers, null, 2);
  }

  const query = renderNexusRuntimeTemplatesForHttp(input.query || {}, false);
  if (Object.keys(query).length) {
    parameters.queryParametersJson = JSON.stringify(query, null, 2);
  }

  if (method !== "GET" && hasHttpPayload(body)) {
    parameters.bodyParametersJson = JSON.stringify(body, null, 2);
    parameters.options.bodyContentType = "raw";
    parameters.options.bodyContentCustomMimeType = "application/json";
  }

  return parameters;
}

function httpRequestNodeFromTemplate(node: any, template: any, credentialMetadata: any) {
  const credentialKey = cleanString(
    template.credential_key ||
    credentialMetadata.credential_key ||
    credentialMetadata.n8n_credential_type,
  ) || (cleanString(template.auth_type).toLowerCase() === "none" ? "" : "httpBearerAuth");
  const url = cleanString(template.url || credentialMetadata.url);
  const providerInfo = providerFromUrlOrName(
    `${url} ${credentialMetadata.provider_label || credentialMetadata.provider || node?.name || ""}`,
  );
  const provider = cleanString(template.provider || credentialMetadata.provider || providerInfo.provider);
  const providerLabel = cleanString(template.provider_label || credentialMetadata.provider_label || providerInfo.label);
  const body = httpTemplateBody(template);
  const methodFromTemplate = cleanString(template.method || "GET").toUpperCase();
  const method = methodFromTemplate === "GET" && hasHttpPayload(body) ? "POST" : methodFromTemplate;
  const allowedHost = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return cleanString(credentialMetadata.allowed_host);
    }
  })();

  return {
    ...node,
    credentials: undefined,
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 2,
    parameters: {
      ...makeLegacyHttpParametersFromTemplate({
        method,
        url,
        credentialKey,
        headers: asObject(template.headers),
        query: asObject(template.query),
        body,
      }),
      nexusProxyTemplate: {
        method,
        url,
        headers: asObject(template.headers),
        query: asObject(template.query),
        body,
        body_json: body,
        auth_type: cleanString(template.auth_type || (credentialKey ? "bearer" : "none")),
        provider,
        provider_label: providerLabel,
        credential_key: credentialKey,
      },
      ...(credentialKey
        ? {
            nexusCredential: {
              uses_nexus_proxy: false,
              provider,
              provider_label: providerLabel,
              credential_key: credentialKey,
              n8n_credential_type: credentialKey,
              url,
              allowed_host: allowedHost,
            },
          }
        : {}),
    },
  };
}

function httpRequestNodeToProxyCodeNode(node: any, supabaseUrl: string) {
  const parameters = asObject(node.parameters);
  const method = cleanString(parameters.requestMethod || parameters.method || "GET").toUpperCase();
  const url = cleanString(parameters.url);
  const existingCredentialKey = cleanString(
    parameters.genericAuthType ||
    Object.keys(asObject(node.credentials))[0] ||
    "httpBearerAuth",
  );
  const headers = {
    ...parseJsonObjectString(parameters.headerParametersJson),
    ...keyValueCollectionToObject(parameters.headerParameters),
    ...keyValueCollectionToObject(parameters.headerParametersUi),
  };
  const query = {
    ...parseJsonObjectString(parameters.queryParametersJson),
    ...keyValueCollectionToObject(parameters.queryParameters),
    ...keyValueCollectionToObject(parameters.queryParametersUi),
  };
  const body = parameters.bodyParametersJson
    ? parseJsonObjectString(parameters.bodyParametersJson)
    : parameters.jsonBody
      ? parseJsonObjectString(parameters.jsonBody)
      : parameters.body || {};
  const providerInfo = providerFromUrlOrName(`${url} ${node.name}`);
  const allowedHost = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();
  const proxyTemplate = {
    method,
    url,
    headers,
    query,
    body,
    auth_type: existingCredentialKey ? "bearer" : "none",
    provider: providerInfo.provider,
    provider_label: providerInfo.label,
    credential_key: existingCredentialKey,
  };

  return httpRequestNodeFromTemplate(node, proxyTemplate, {
    provider: providerInfo.provider,
    provider_label: providerInfo.label,
    credential_key: existingCredentialKey,
    n8n_credential_type: existingCredentialKey,
    url,
    allowed_host: allowedHost,
  });
}

function isNexusProxyCodeNode(node: any) {
  const parameters = asObject(node?.parameters);
  const credential = asObject(parameters.nexusCredential);
  return (
    String(node?.type || "").toLowerCase().includes("n8n-nodes-base.code") &&
    credential.uses_nexus_proxy
  );
}

function extractNexusProxyTemplateFromCode(node: any) {
  const explicitTemplate = asObject(asObject(node?.parameters).nexusProxyTemplate);
  if (Object.keys(explicitTemplate).length) return explicitTemplate;

  const jsCode = cleanString(asObject(node?.parameters).jsCode);
  const marker = "const template = ";
  const start = jsCode.indexOf(marker);
  if (start < 0) return {};

  const afterMarker = jsCode.slice(start + marker.length);
  const end = afterMarker.indexOf(";\nfunction valueAt");
  if (end < 0) return {};

  return parseJsonObjectString(afterMarker.slice(0, end).trim());
}

function refreshNexusProxyCodeNode(node: any, supabaseUrl: string) {
  if (!isNexusProxyCodeNode(node)) return node;

  const parameters = asObject(node.parameters);
  const credential = asObject(parameters.nexusCredential);
  const template = extractNexusProxyTemplateFromCode(node);
  const templateUrl = cleanString(template.url || credential.url);

  if (!templateUrl) return node;

  const providerInfo = providerFromUrlOrName(
    `${templateUrl} ${credential.provider_label || credential.provider || node.name}`,
  );
  const credentialKey = cleanString(
    template.credential_key ||
    credential.credential_key ||
    credential.n8n_credential_type,
  ) || (cleanString(template.auth_type).toLowerCase() === "none" ? "" : "httpBearerAuth");
  const allowedHost = (() => {
    try {
      return new URL(templateUrl).hostname;
    } catch {
      return cleanString(credential.allowed_host);
    }
  })();
  const templateBody = httpTemplateBody(template);
  const rawMethod = cleanString(template.method || "GET").toUpperCase();
  const method = rawMethod === "GET" && hasHttpPayload(templateBody) ? "POST" : rawMethod;
  const proxyTemplate = {
    method,
    url: templateUrl,
    headers: asObject(template.headers),
    query: asObject(template.query),
    body: templateBody,
    body_json: templateBody,
    auth_type: cleanString(template.auth_type || (credentialKey ? "bearer" : "none")),
    provider: cleanString(template.provider || credential.provider || providerInfo.provider),
    provider_label: cleanString(template.provider_label || credential.provider_label || providerInfo.label),
    credential_key: credentialKey,
  };

  return httpRequestNodeFromTemplate(
    {
      ...node,
      parameters,
    },
    proxyTemplate,
    {
      ...credential,
      uses_nexus_proxy: false,
      provider: proxyTemplate.provider,
      provider_label: proxyTemplate.provider_label,
      credential_key: proxyTemplate.credential_key,
      n8n_credential_type: proxyTemplate.credential_key,
      url: templateUrl,
      allowed_host: allowedHost,
    },
  );
}

function convertMakeHttpRequestNodesToProxy(workflowInput: any, product: any, supabaseUrl: string) {
  const workflow = deepClone(workflowInput);
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const sourcePlatform = cleanString(product?.workflow_source_platform).toLowerCase();
  const looksLikeMake =
    sourcePlatform === "make" ||
    sourcePlatform === "zapier" ||
    Boolean(product?.make_import_session_id || product?.make_blueprint) ||
    nodes.some((node: any) => ["NEXUS_INPUT", "NEXUS_FINAL_OUTPUT"].includes(cleanString(node?.name)));

  if (!looksLikeMake) return workflow;

  workflow.nodes = nodes.map((node: any) => {
    if (isNexusProxyCodeNode(node)) return refreshNexusProxyCodeNode(node, supabaseUrl);
    if (!isHttpRequestNode(node) || cleanString(node?.name) === "Nexus Submit Output") return node;
    return httpRequestNodeToProxyCodeNode(node, supabaseUrl);
  });

  return workflow;
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

function wrapWebhookWithRuntimeContext(connections: any, nodes: any[] = []) {
  const webhookName = "Nexus Webhook Trigger";
  const contextName = "Nexus Runtime Context";

  const currentWebhookMain = connections?.[webhookName]?.main;
  const currentContextMain = connections?.[contextName]?.main;

  const collectMainTargets = (mainConnections: any, excludeNode = "") => {
    if (!Array.isArray(mainConnections)) return [];

    const targets: any[] = [];

    for (const group of mainConnections) {
      if (!Array.isArray(group)) continue;

      for (const connection of group) {
        const targetName = cleanString(connection?.node);
        if (!targetName || (excludeNode && targetName === excludeNode)) continue;

        targets.push({
          node: targetName,
          type: cleanString(connection?.type) || "main",
          index: Number(connection?.index || 0),
        });
      }
    }

    return targets;
  };

  const uniqueTargets = (targets: any[]) => {
    const seen = new Set<string>();
    const output: any[] = [];

    for (const target of targets || []) {
      const key = `${target.node}::${target.type || "main"}::${Number(target.index || 0)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({
        node: target.node,
        type: target.type || "main",
        index: Number(target.index || 0),
      });
    }

    return output;
  };

  const directWebhookTargets = collectMainTargets(currentWebhookMain, contextName);
  const existingContextTargets = collectMainTargets(currentContextMain);
  let originalTargets = uniqueTargets([
    ...directWebhookTargets,
    ...existingContextTargets,
  ]);

  if (!originalTargets.length && Array.isArray(nodes) && nodes.length) {
    const webhookNode = nodes.find((node: any) => node?.name === webhookName);
    const targetNames = getConnectedTargetNames(connections);
    const webhookX = Number(webhookNode?.position?.[0] || 0);
    const webhookY = Number(webhookNode?.position?.[1] || 0);

    const possibleStarts = nodes
      .filter((node: any) => {
        const name = cleanString(node?.name);
        if (!name) return false;
        if ([webhookName, contextName, "Nexus Submit Output", "Nexus Runtime Merge"].includes(name)) return false;
        if (targetNames.has(name)) return false;
        if (isIgnoredTerminalNode(node)) return false;
        if (isWebhookNode(node) || isSupportedReplaceableTrigger(node)) return false;
        return true;
      })
      .sort((a: any, b: any) => {
        const ax = Number(a?.position?.[0] || 0);
        const bx = Number(b?.position?.[0] || 0);
        const ay = Number(a?.position?.[1] || 0);
        const by = Number(b?.position?.[1] || 0);
        const aScore = Math.abs(ax - (webhookX + 300)) + Math.abs(ay - webhookY);
        const bScore = Math.abs(bx - (webhookX + 300)) + Math.abs(by - webhookY);
        return aScore - bScore;
      });

    if (possibleStarts[0]?.name) {
      originalTargets = [{
        node: possibleStarts[0].name,
        type: "main",
        index: 0,
      }];
    }
  }

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

  connections[contextName].main = [originalTargets];

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

function keyValueParametersToObject(value: any) {
  const input = asObject(value);
  const rows = Array.isArray(input.parameters)
    ? input.parameters
    : Array.isArray(input.parameter)
      ? input.parameter
      : [];

  return rows.reduce((accumulator: Record<string, any>, item: any) => {
    const name = cleanString(item?.name || item?.key);
    if (!name) return accumulator;
    accumulator[name] = item?.value ?? "";
    return accumulator;
  }, {});
}

function jsonStringOrEmpty(value: any) {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function stripContentTypeHeaderJson(value: any) {
  const parsed = parseJsonObjectString(value);
  const stripped = stripContentTypeHeaderForHttp(parsed);
  return Object.keys(stripped).length ? JSON.stringify(stripped, null, 2) : "";
}

function isHtmlFetchHttpNode(node: any, parameters: Record<string, any>) {
  const haystack = lower([
    node?.name,
    parameters.url,
    parameters.nexusProxyTemplate?.url,
    parameters.nexusCredential?.url,
  ].filter(Boolean).join(" "));

  if (
    haystack.includes("fetch website") ||
    haystack.includes("website html") ||
    haystack.includes("fetch html") ||
    haystack.includes("scrape website") ||
    haystack.includes("landing page") ||
    haystack.includes("page html") ||
    haystack.includes("webpage") ||
    haystack.includes("extract page")
  ) {
    return true;
  }

  const method = cleanString(parameters.requestMethod || parameters.method || "GET").toUpperCase();
  const hasBody = hasHttpPayload(parameters.bodyParametersJson || parameters.jsonBody || parameters.body);
  const url = cleanString(parameters.url || parameters.nexusProxyTemplate?.url || parameters.nexusCredential?.url);

  return method === "GET" &&
    !hasBody &&
    (
      url.includes("Nexus Runtime Context") ||
      url.includes("$json.url") ||
      url.includes("$json[") ||
      url.includes("landing_page_url") ||
      url.includes("company_url") ||
      url.includes("website")
    );
}

function normalizeLegacyHttpRequestNodeForN8n(node: any) {
  if (!isHttpRequestNode(node) || !node || typeof node !== "object") return node;

  const parameters = {
    ...(node.parameters || {}),
  };

  const method = cleanString(parameters.requestMethod || parameters.method || "GET").toUpperCase();
  const legacyOptions = {
    ...asObject(parameters.options),
  };

  const legacyParameters: Record<string, any> = {
    authentication: parameters.authentication || "none",
    requestMethod: method || "GET",
    url: cleanString(parameters.url),
    allowUnauthorizedCerts: Boolean(parameters.allowUnauthorizedCerts),
    responseFormat: isHtmlFetchHttpNode(node, parameters)
      ? "string"
      : (parameters.responseFormat || "json"),
    jsonParameters: true,
    options: legacyOptions,
  };

  if (parameters.genericAuthType) {
    legacyParameters.genericAuthType = parameters.genericAuthType;
  }

  if (parameters.nodeCredentialType) {
    legacyParameters.nodeCredentialType = parameters.nodeCredentialType;
  }

  const headerJson = stripContentTypeHeaderJson(
    parameters.headerParametersJson ||
    jsonStringOrEmpty(keyValueParametersToObject(parameters.headerParameters)) ||
    jsonStringOrEmpty(keyValueParametersToObject(parameters.headerParametersUi)),
  );

  if (headerJson && headerJson !== "{}") {
    legacyParameters.headerParametersJson = headerJson;
  }

  const queryJson =
    parameters.queryParametersJson ||
    jsonStringOrEmpty(keyValueParametersToObject(parameters.queryParameters)) ||
    jsonStringOrEmpty(keyValueParametersToObject(parameters.queryParametersUi));

  if (queryJson && queryJson !== "{}") {
    legacyParameters.queryParametersJson = queryJson;
  }

  const rawBody =
    parameters.bodyParametersJson ||
    parameters.jsonBody ||
    parameters.body ||
    "";

  if (rawBody !== "" && rawBody !== null && rawBody !== undefined && method !== "GET") {
    legacyParameters.bodyParametersJson = jsonStringOrEmpty(rawBody);

    legacyOptions.bodyContentType = "raw";
    legacyOptions.bodyContentCustomMimeType = parameters.rawContentType || "application/json";
  }

  return {
    ...node,
    typeVersion: 2,
    parameters: legacyParameters,
  };
}

function normalizeModernHttpRequestNodeForN8n(node: any) {
  if (!isHttpRequestNode(node) || !node || typeof node !== "object") return node;

  const parameters = {
    ...(node.parameters || {}),
  };

  if (isHtmlFetchHttpNode(node, parameters)) {
    parameters.responseFormat = "text";
    parameters.options = {
      ...asObject(parameters.options),
      response: {
        ...asObject(asObject(parameters.options).response),
        responseFormat: "text",
      },
    };
  }

  /*
    n8n HTTP Request v4 expects `contentType`, not the older/wrong
    `bodyContentType` key. Leaving the old key can make n8n skip JSON bodies
    or fail internally with `config.headers.setContentType is not a function`.
  */
  if (parameters.bodyContentType && !parameters.contentType) {
    parameters.contentType = parameters.bodyContentType;
  }

  delete parameters.bodyContentType;

  if (parameters.sendBody && parameters.jsonBody) {
    parameters.contentType = "json";
    parameters.specifyBody = "json";
    delete parameters.body;
    delete parameters.rawContentType;
  }

  if (parameters.sendBody && parameters.body && !parameters.contentType) {
    parameters.contentType = "raw";
    parameters.rawContentType = parameters.rawContentType || "application/json";
  }

  if (parameters.contentType === "raw") {
    delete parameters.jsonBody;
    delete parameters.specifyBody;
    delete parameters.bodyParameters;
  }

  return {
    ...node,
    typeVersion: Number(node.typeVersion || 0) >= 3 ? node.typeVersion : 4.2,
    parameters,
  };
}

function normalizeHttpRequestNodeForN8n(node: any, options: { useLegacyHttpRequest?: boolean } = {}) {
  if (options.useLegacyHttpRequest) {
    return normalizeLegacyHttpRequestNodeForN8n(node);
  }

  return normalizeModernHttpRequestNodeForN8n(node);
}

function normalizeHttpRequestNodesForN8n(nodes: any[], product: any) {
  const workflowLooksMakeConverted = nodes.some((node: any) => {
    const name = cleanString(node?.name);
    return name === "NEXUS_INPUT" || name === "NEXUS_FINAL_OUTPUT";
  });
  const sourcePlatform = cleanString(product?.workflow_source_platform).toLowerCase();

  const forceLegacyForMake =
    sourcePlatform === "make" ||
    sourcePlatform === "zapier" ||
    Boolean(product?.make_import_session_id || product?.make_blueprint || workflowLooksMakeConverted);

  return nodes.map((node: any) => {
    const nonNexusHttpRequest =
      isHttpRequestNode(node) &&
      cleanString(node?.name) !== "Nexus Submit Output";
    const useLegacyHttpRequest =
      nonNexusHttpRequest &&
      (
        forceLegacyForMake ||
        (Number(node?.typeVersion || 0) > 0 && Number(node?.typeVersion || 0) < 3)
      );

    return normalizeHttpRequestNodeForN8n(node, { useLegacyHttpRequest });
  });
}

function httpNodeDiagnostics(workflow: any) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];

  return nodes
    .filter((node: any) => isHttpRequestNode(node))
    .map((node: any) => {
      const parameters = asObject(node.parameters);
      return {
        name: cleanString(node.name),
        type_version: node.typeVersion,
        method: parameters.method || parameters.requestMethod || "",
        url: parameters.url || "",
        send_body: Boolean(parameters.sendBody || parameters.body || parameters.jsonBody || parameters.bodyParametersJson),
        content_type: parameters.contentType || null,
        raw_content_type: parameters.rawContentType || null,
        legacy_body_content_type: asObject(parameters.options).bodyContentType || null,
        legacy_body_mime_type: asObject(parameters.options).bodyContentCustomMimeType || null,
        has_body: Object.prototype.hasOwnProperty.call(parameters, "body") ||
          Object.prototype.hasOwnProperty.call(parameters, "bodyParametersJson"),
        has_json_body: Object.prototype.hasOwnProperty.call(parameters, "jsonBody"),
        has_body_content_type: Object.prototype.hasOwnProperty.call(parameters, "bodyContentType"),
        has_body_parameters_json: Object.prototype.hasOwnProperty.call(parameters, "bodyParametersJson"),
        specify_body: parameters.specifyBody || null,
        auth: parameters.authentication || "none",
        generic_auth_type: parameters.genericAuthType || "",
      };
    });
}

function proxyNodeDiagnostics(workflow: any) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];

  return nodes
    .filter((node: any) => asObject(asObject(node?.parameters).nexusCredential).uses_nexus_proxy)
    .map((node: any) => {
      const nexusCredential = asObject(asObject(node?.parameters).nexusCredential);
      return {
        name: cleanString(node.name),
        type: cleanString(node.type),
        type_version: node.typeVersion,
        provider: nexusCredential.provider || "",
        provider_label: nexusCredential.provider_label || "",
        credential_key: nexusCredential.credential_key || nexusCredential.n8n_credential_type || "",
        url: nexusCredential.url || "",
        allowed_host: nexusCredential.allowed_host || "",
      };
    });
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
  workflow = convertLooseBarePlaceholders(workflow);

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

  connections = wrapWebhookWithRuntimeContext(connections, nodes);

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
      return group.filter((connection: any) =>
        connection.node !== "Nexus Runtime Merge" &&
        connection.node !== "Nexus Prepare Output Payload"
      );
    });
  }

  nodes = nodes.filter((node: any) => node.name !== "Nexus Prepare Output Payload");
  if (connections["Nexus Prepare Output Payload"]) {
    delete connections["Nexus Prepare Output Payload"];
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
      .filter((name) => name !== "Nexus Runtime Context")
      .filter((name) => name !== "Nexus Prepare Output Payload");

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
    Make the final result node feed Nexus Submit Output directly.
    The submit node reads the previous node's $json, so a developer-owned Nexus Output
    node remains the source of truth.
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
  nodes = normalizeHttpRequestNodesForN8n(nodes, product);
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
  const normalized = normalizeWorkflowResourceLocators(workflow);

  return {
    name: cleanString(normalized.name || "Nexus Workflow"),
    nodes: Array.isArray(normalized.nodes) ? normalized.nodes : [],
    connections: normalized.connections || {},
    settings: {
      executionOrder: normalized.settings?.executionOrder || "v1",
    },
    staticData: normalized.staticData || {},
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

async function listN8nWorkflows(n8nBaseUrl: string, n8nApiKey: string) {
  const response = await n8nRequest(n8nBaseUrl, n8nApiKey, "/api/v1/workflows?limit=100", {
    method: "GET",
  });

  return (
    Array.isArray(response?.data)
      ? response.data
      : Array.isArray(response)
        ? response
        : []
  );
}

async function findExistingN8nWorkflowByName(n8nBaseUrl: string, n8nApiKey: string, workflowName: string) {
  const workflows = await listN8nWorkflows(n8nBaseUrl, n8nApiKey);

  return workflows.find((workflow: any) => workflow.name === workflowName) || null;
}

function workflowWebhookPaths(workflow: any) {
  const nodes = Array.isArray(workflow?.nodes) ? workflow.nodes : [];
  return nodes
    .filter((node: any) => isWebhookNode(node))
    .map((node: any) => cleanString(node?.parameters?.path))
    .filter(Boolean);
}

async function getN8nWorkflowById(n8nBaseUrl: string, n8nApiKey: string, workflowId: string) {
  return await n8nRequest(n8nBaseUrl, n8nApiKey, `/api/v1/workflows/${workflowId}`, {
    method: "GET",
  });
}

async function deactivateDuplicateWorkflows(
  n8nBaseUrl: string,
  n8nApiKey: string,
  workflowName: string,
  webhookPath = "",
  keepWorkflowId = "",
) {
  const workflows = await listN8nWorkflows(n8nBaseUrl, n8nApiKey);
  const duplicates = [];

  for (const workflow of workflows) {
    const id = cleanString(workflow?.id);
    if (!id || id === keepWorkflowId) continue;

    if (workflow?.name === workflowName) {
      duplicates.push(workflow);
      continue;
    }

    if (webhookPath) {
      try {
        const fullWorkflow = await getN8nWorkflowById(n8nBaseUrl, n8nApiKey, id);
        if (workflowWebhookPaths(fullWorkflow).includes(webhookPath)) {
          duplicates.push(workflow);
        }
      } catch {
        /*
          Best-effort cleanup only. If one old workflow cannot be inspected,
          do not block the current product import.
        */
      }
    }
  }

  const results = [];
  for (const workflow of duplicates) {
    results.push({
      id: workflow.id,
      name: workflow.name,
      result: await deactivateWorkflow(n8nBaseUrl, n8nApiKey, workflow.id),
    });
  }

  return results;
}

async function updateWorkflow(n8nBaseUrl: string, n8nApiKey: string, workflowId: string, workflow: any) {
  const cleanWorkflow = normalizeWorkflowForN8nApi(workflow);

  /*
    Use full PUT replacement only. PATCH can merge nested node parameters in n8n.
    For HTTP Request nodes, stale fields like jsonBody/bodyContentType can survive
    a PATCH and keep throwing setContentType errors at runtime.
  */
  return await n8nRequest(n8nBaseUrl, n8nApiKey, `/api/v1/workflows/${workflowId}`, {
    method: "PUT",
    body: JSON.stringify(cleanWorkflow),
  });
}

async function deactivateWorkflow(n8nBaseUrl: string, n8nApiKey: string, workflowId: string) {
  try {
    return await n8nRequest(n8nBaseUrl, n8nApiKey, `/api/v1/workflows/${workflowId}/deactivate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
  } catch (error) {
    return {
      deactivate_warning: error instanceof Error ? error.message : String(error),
    };
  }
}

async function replaceExistingWorkflow(
  n8nBaseUrl: string,
  n8nApiKey: string,
  workflowId: string,
  workflow: any,
) {
  /*
    n8n keeps active webhook executions in memory. Updating an already-active
    workflow can leave the webhook using the old node version until the workflow
    is deactivated/reactivated. That is exactly how a Make import can still run
    HTTP Request V3 after Nexus saved a V2-safe workflow.
  */
  const deactivation = await deactivateWorkflow(n8nBaseUrl, n8nApiKey, workflowId);
  const updated = await updateWorkflow(n8nBaseUrl, n8nApiKey, workflowId, workflow);

  return {
    ...updated,
    deactivation,
  };
}

async function importWorkflowToN8n(n8nBaseUrl: string, n8nApiKey: string, product: any, normalizedWorkflow: any) {
  const cleanWorkflow = normalizeWorkflowForN8nApi(normalizedWorkflow);
  const webhookPath = workflowWebhookPaths(cleanWorkflow)[0] || "";
  let duplicateDeactivations: any[] = [];

  if (product.n8n_workflow_id) {
    try {
      duplicateDeactivations = await deactivateDuplicateWorkflows(
        n8nBaseUrl,
        n8nApiKey,
        cleanWorkflow.name,
        webhookPath,
        product.n8n_workflow_id,
      );
      const updated = await replaceExistingWorkflow(
        n8nBaseUrl,
        n8nApiKey,
        product.n8n_workflow_id,
        cleanWorkflow,
      );

      return {
        ...updated,
        id: product.n8n_workflow_id,
        updated_existing_workflow: true,
        duplicate_deactivations: duplicateDeactivations,
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
    duplicateDeactivations = await deactivateDuplicateWorkflows(
      n8nBaseUrl,
      n8nApiKey,
      cleanWorkflow.name,
      webhookPath,
      existingWorkflow.id,
    );
    const updated = await replaceExistingWorkflow(
      n8nBaseUrl,
      n8nApiKey,
      existingWorkflow.id,
      cleanWorkflow,
    );

    return {
      ...updated,
      id: existingWorkflow.id,
      reused_existing_workflow: true,
      duplicate_deactivations: duplicateDeactivations,
    };
  }

  duplicateDeactivations = await deactivateDuplicateWorkflows(
    n8nBaseUrl,
    n8nApiKey,
    cleanWorkflow.name,
    webhookPath,
    "",
  );
  const created = await n8nRequest(n8nBaseUrl, n8nApiKey, "/api/v1/workflows", {
    method: "POST",
    body: JSON.stringify(cleanWorkflow),
  });

  return {
    ...created,
    duplicate_deactivations: duplicateDeactivations,
  };
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
    productForImport.n8n_workflow_json = convertMakeHttpRequestNodesToProxy(
      productForImport.n8n_workflow_json,
      productForImport,
      supabaseUrl,
    );

    const credentialBinding = await bindAutomationCredentials({
      adminClient,
      product: productForImport,
      n8nBaseUrl,
      n8nApiKey,
      credentialSecret: env("NEXUS_CREDENTIAL_SECRET"),
      syncMissingN8nCredentials: true,
      // Uploaded n8n credential IDs are never proof of ownership. Initial
      // imports may bind only credentials owned by this product's developer.
      allowExistingNativeN8nCredentials: false,
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
    normalized.workflow = normalizeWorkflowResourceLocators(normalized.workflow);

    const imported = await importWorkflowToN8n(
      n8nBaseUrl,
      n8nApiKey,
      productForImport,
      normalized.workflow,
    );
    const httpDiagnostics = httpNodeDiagnostics(normalized.workflow);
    const proxyDiagnostics = proxyNodeDiagnostics(normalized.workflow);

    const workflowId = imported.id || imported.data?.id || product.n8n_workflow_id;

    if (!workflowId) {
      throw new Error("n8n did not return a workflow ID.");
    }

    const shouldKeepActiveAfterImport = ["active", "published"].includes(cleanString(product.status).toLowerCase());
    const postImportWorkflowState = shouldKeepActiveAfterImport
      ? await activateWorkflow(n8nBaseUrl, n8nApiKey, workflowId)
      : await deactivateWorkflow(n8nBaseUrl, n8nApiKey, workflowId);

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
        n8n_workflow_json: productForImport.n8n_workflow_json,
        n8n_last_test_status: "not_tested",
        n8n_last_test_error: null,
        n8n_last_test_result: null,
        n8n_last_tested_at: null,
        health_status: "needs_recheck",
        health_failure_reason: "Workflow imported. Run a fresh technical check before publishing.",
        health_failure_details: {
          imported_workflow: true,
          workflow_id: workflowId,
          at: new Date().toISOString(),
        },
        health_next_check_at: null,
        detected_placeholders: validation.detected,
        placeholder_validation_status: "valid",
        placeholder_validation_errors: [],
        developer_credential_requirements: credentialBinding.slots,
        n8n_credential_bindings: credentialBinding.bindings,
        credential_binding_status: credentialBinding.status,
        credential_binding_errors: credentialBinding.errors,
        n8n_last_credential_bound_at: credentialBinding.ok ? new Date().toISOString() : product.n8n_last_credential_bound_at || null,
        n8n_last_import_result: {
          workflow_id: workflowId,
          webhook_url: normalized.webhookUrl,
          callback_url: normalized.callbackUrl,
          http_nodes: httpDiagnostics,
          proxy_nodes: proxyDiagnostics,
          credential_binding_status: credentialBinding.status,
          credential_bindings: credentialBinding.bindings,
          deactivation: imported.deactivation || null,
          duplicate_deactivations: imported.duplicate_deactivations || [],
          custom_mapping_warnings: [
            ...autoSchema.warnings,
            ...mappingValidation.warnings,
            ...(validation.warnings || []),
          ],
          auto_added_setup_fields: autoSchema.addedSetupFields,
          auto_added_credential_fields: autoSchema.addedCredentialFields,
          workflow_state: shouldKeepActiveAfterImport ? "active" : "draft_inactive",
          activation: shouldKeepActiveAfterImport ? postImportWorkflowState : null,
          deactivation_after_import: shouldKeepActiveAfterImport ? null : postImportWorkflowState,
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
      workflow_state: shouldKeepActiveAfterImport ? "active" : "draft_inactive",
      webhook_url: normalized.webhookUrl,
      callback_url: normalized.callbackUrl,
      http_nodes: httpDiagnostics,
      proxy_nodes: proxyDiagnostics,
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
