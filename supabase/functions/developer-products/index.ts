import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function nowIso() {
  return new Date().toISOString();
}

function cleanString(value: unknown) {
  return String(value || "").trim();
}

function numberValue(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function productCurrency(value: unknown) {
  const currency = cleanString(value).toUpperCase();
  return ["THB", "USD", "EUR", "GBP", "JPY"].includes(currency) ? currency : "USD";
}

function runtimeTriggerMode(value: unknown) {
  const mode = cleanString(value).toLowerCase();
  return [
    "setup_complete",
    "on_demand",
    "scheduled_interval",
    "subscription_monthly",
    "manual",
  ].includes(mode) ? mode : "setup_complete";
}

function runtimeRunFrequency(value: unknown, triggerMode = "setup_complete") {
  const frequency = cleanString(value).toLowerCase();
  if ([
    "manual",
    "on_demand",
    "every_30_minutes",
    "hourly",
    "daily",
    "weekly",
    "monthly",
  ].includes(frequency)) return frequency;

  if (triggerMode === "on_demand") return "on_demand";
  if (triggerMode === "scheduled_interval") return "daily";
  if (triggerMode === "subscription_monthly") return "monthly";
  return "manual";
}

function runtimeNoChangePolicy(value: unknown) {
  const policy = cleanString(value).toLowerCase();
  return ["no_output", "status_event", "empty_output"].includes(policy) ? policy : "no_output";
}

function runtimeResponseMode(value: unknown) {
  const mode = cleanString(value).toLowerCase();
  return ["dashboard_output", "instant_message", "alert_only", "webhook_ack"].includes(mode)
    ? mode
    : "dashboard_output";
}

function boolValue(value: unknown) {
  const raw = cleanString(value).toLowerCase();
  return value === true || value === 1 || ["true", "1", "yes", "on"].includes(raw);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cleanLines(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanString(item)).filter(Boolean).slice(0, 30);
  }

  return cleanString(value)
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 30);
}

function parseJsonValue(value: unknown, fallback: unknown) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return fallback;

    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("One of the workflow JSON fields is invalid JSON.");
    }
  }

  return value;
}

function cleanOptions(value: unknown) {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (typeof item === "string") return cleanString(item);
      if (isRecord(item)) {
        return {
          label: cleanString(item.label || item.value || item.name),
          value: cleanString(item.value || item.label || item.name),
        };
      }
      return "";
    })
    .filter(Boolean)
    .slice(0, 30);
}

function cleanSchema(value: unknown) {
  const parsed = parseJsonValue(value, []);
  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((item) => {
      if (!isRecord(item)) return null;

      const name = cleanString(item.name)
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 80);

      if (!name) return null;

      return {
        name,
        label: cleanString(item.label || item.name).slice(0, 120),
        type: cleanString(item.type || "text").slice(0, 40),
        required: boolValue(item.required),
        placeholder: cleanString(item.placeholder).slice(0, 240),
        description: cleanString(item.description).slice(0, 500),
        options: cleanOptions(item.options),
      };
    })
    .filter(Boolean)
    .slice(0, 50);
}

function cleanWorkflowMappings(value: unknown) {
  const parsed = parseJsonValue(value, []);
  if (!Array.isArray(parsed)) return [];

  return parsed
    .map((item) => {
      if (!isRecord(item)) return null;

      const placeholder = cleanString(item.placeholder).slice(0, 160);
      const source = cleanString(item.source || item.kind || item.type).toLowerCase();
      const key = cleanString(item.key || item.name)
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 80);

      if (!placeholder || !source || !key) return null;

      return {
        placeholder,
        source,
        key,
        description: cleanString(item.description).slice(0, 300),
      };
    })
    .filter(Boolean)
    .slice(0, 80);
}

function cleanJsonObject(value: unknown) {
  const parsed = parseJsonValue(value, {});
  return isRecord(parsed) ? parsed : {};
}

function cleanSheetAccessConfig(value: unknown) {
  const parsed = cleanJsonObject(value);
  const mode = cleanString(parsed.mode);
  if (!["customer_owned", "developer_owned", "private_per_customer"].includes(mode)) {
    return {};
  }

  return {
    mode,
    developer_sheet_id: cleanString(parsed.developer_sheet_id).slice(0, 500),
    template_sheet_id: cleanString(parsed.template_sheet_id).slice(0, 500),
    sheet_tab: cleanString(parsed.sheet_tab).slice(0, 120),
    sheet_range: cleanString(parsed.sheet_range).slice(0, 120),
  };
}

function cleanJsonArray(value: unknown) {
  const parsed = parseJsonValue(value, []);
  return Array.isArray(parsed) ? parsed.slice(0, 100) : [];
}

function cleanWorkflowJson(value: unknown) {
  const parsed = parseJsonValue(value, null);
  if (parsed === null) return null;
  if (!isRecord(parsed)) {
    throw new Error("n8n workflow JSON must be a JSON object exported from n8n.");
  }

  const serialized = JSON.stringify(parsed);
  if (serialized.length > 1500000) {
    throw new Error("n8n workflow JSON is too large. Keep the export under about 1.5 MB for this MVP.");
  }

  return parsed;
}

function normalizeSlug(value: unknown, fallback: string) {
  const base = cleanString(value || fallback)
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);

  return base || `product-${crypto.randomUUID().slice(0, 8)}`;
}

function cleanCustomizations(value: unknown) {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      const record = item && typeof item === "object" && !Array.isArray(item)
        ? item as Record<string, unknown>
        : {};

      return {
        name: cleanString(record.name),
        description: cleanString(record.description),
        price_note: cleanString(record.price_note),
      };
    })
    .filter((item) => item.name)
    .slice(0, 5);
}

function stableJson(value: unknown) {
  return JSON.stringify(value || null);
}

function isPassingWorkflowTest(status: unknown) {
  return ["passed", "passed_with_expected_test_callback_error", "passed_with_expected_test_input_error"].includes(cleanString(status).toLowerCase());
}

function isLiveProductStatus(status: unknown) {
  return ["live", "active", "published"].includes(cleanString(status).toLowerCase());
}

function hasRealPassingWorkflowTest(product: any) {
  if (!isPassingWorkflowTest(product?.n8n_last_test_status)) return false;

  const result = isRecord(product?.n8n_last_test_result)
    ? product.n8n_last_test_result
    : {};
  const webhookResponse = isRecord(result.webhook_response)
    ? result.webhook_response
    : {};

  return Boolean(
    result.used_test_profile ||
      cleanString(result.test_profile_id) ||
      webhookResponse.used_test_profile ||
      cleanString(webhookResponse.test_profile_id),
  );
}

function inferFieldLabel(name: string) {
  return cleanString(name)
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase())
    .trim() || "Field";
}

function inferSetupFieldType(name: string) {
  const key = cleanString(name).toLowerCase();
  if (key.includes("email")) return "email";
  if (key.includes("url") || key.includes("website") || key.includes("link")) return "url";
  if (key.includes("notes") || key.includes("description") || key.includes("instructions") || key.includes("competitor") || key.includes("areas")) return "textarea";
  return "text";
}

function makeInferredSetupField(name: string) {
  return {
    name,
    label: inferFieldLabel(name),
    type: inferSetupFieldType(name),
    required: true,
    placeholder: "",
    description: "Required because Nexus detected this buyer setup value in the workflow.",
    options: [],
  };
}

function normalizeSetupKey(value: unknown) {
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

function canonicalBuyerSetupKey(value: unknown) {
  const key = stripDerivedSetupSuffix(normalizeSetupKey(value));
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
  };

  return aliases[key] || key;
}

function setupNameSet(setupSchema: any[]) {
  const names = new Set<string>();

  for (const field of setupSchema || []) {
    const raw = normalizeSetupKey(field?.name);
    const canonical = canonicalBuyerSetupKey(field?.name);
    if (raw) names.add(raw);
    if (canonical) names.add(canonical);
  }

  return names;
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
      const key = canonicalBuyerSetupKey(match[1]);
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

function requiredSetupFieldsForProduct(product: any) {
  const workflowText = JSON.stringify(product?.n8n_workflow_json || product?.n8n_normalized_workflow_json || {});
  const mappingText = JSON.stringify(product?.workflow_placeholder_mappings || []);
  const blueprintText = JSON.stringify(product?.make_blueprint || {});
  const names = new Set<string>([
    ...extractRuntimeSetupKeys(`${workflowText}\n${mappingText}`),
  ]);

  if (["make", "zapier"].includes(cleanString(product?.workflow_source_platform).toLowerCase()) || product?.make_blueprint) {
    for (const key of inferMakeSetupKeysFromText(`${blueprintText}\n${workflowText}\n${mappingText}`)) {
      names.add(key);
    }
  }

  return [...names].sort().map(makeInferredSetupField);
}

function setupSchemaReadiness(product: any) {
  const requiredFields = requiredSetupFieldsForProduct(product);
  const setupSchema = cleanSchema(product?.setup_schema);
  const existingNames = setupNameSet(setupSchema);
  const missingFields = requiredFields.filter((field) => !existingNames.has(canonicalBuyerSetupKey(field.name)));

  return {
    requiredFields,
    missingFields,
  };
}

function mergeMissingSetupFields(setupSchema: any[], missingFields: any[]) {
  const output = cleanSchema(setupSchema);
  const existingNames = setupNameSet(output);

  for (const field of missingFields || []) {
    const key = canonicalBuyerSetupKey(field?.name);
    if (!key || existingNames.has(key)) continue;

    output.push(makeInferredSetupField(key));
    existingNames.add(key);
  }

  return output;
}

function hasAttachedWorkflowFlow(product: any) {
  if (cleanString(product?.listing_type) === "custom_request") return true;

  return Boolean(
    product?.n8n_workflow_json ||
      cleanString(product?.n8n_workflow_id) ||
      cleanString(product?.runtime_webhook_url || product?.n8n_webhook_url)
  );
}

async function autoPauseInvalidLiveProducts(adminClient: any, products: any[], reason = "Missing workflow attachment") {
  const invalidLiveProducts = (products || []).filter((product) => {
    return cleanString(product.status).toLowerCase() === "live" && !hasAttachedWorkflowFlow(product);
  });

  if (!invalidLiveProducts.length) {
    return { products, paused_count: 0 };
  }

  const now = nowIso();
  const ids = invalidLiveProducts.map((product) => product.id).filter(Boolean);

  const { error } = await adminClient
    .from("automations")
    .update({
      status: "paused",
      health_status: "paused_by_health_check",
      health_last_failed_at: now,
      health_failure_reason: reason,
      health_failure_details: {
        reason,
        auto_pause_source: "developer_products_list",
      },
      health_auto_paused_at: now,
      health_previous_status: "live",
      health_next_check_at: null,
      updated_at: now,
    })
    .in("id", ids);

  if (error) throw new Error(error.message);

  const pausedSet = new Set(ids);
  const patched = products.map((product) => {
    if (!pausedSet.has(product.id)) return product;

    return {
      ...product,
      status: "paused",
      auto_pause_reason: reason,
      updated_at: now,
    };
  });

  return {
    products: patched,
    paused_count: ids.length,
  };
}

async function requireDeveloper(req: Request) {
  const authHeader = req.headers.get("Authorization") || "";

  if (!authHeader.startsWith("Bearer ")) {
    return { user: null, profile: null, developer: null, error: "Missing auth token." };
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  });

  const token = authHeader.replace("Bearer ", "").trim();
  const { data: userData, error: userError } = await userClient.auth.getUser(token);

  if (userError || !userData?.user) {
    return { user: null, profile: null, developer: null, error: "Invalid auth token." };
  }

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("id, email, role, full_name")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (profileError || !profile) {
    return { user: userData.user, profile: null, developer: null, error: "Developer profile not found." };
  }

  if (profile.role !== "developer") {
    return { user: userData.user, profile, developer: null, error: "Developer access required." };
  }

  const { data: developer, error: developerError } = await adminClient
    .from("developers")
    .select("id, profile_id, display_name, handle, status")
    .eq("profile_id", userData.user.id)
    .maybeSingle();

  if (developerError || !developer) {
    return { user: userData.user, profile, developer: null, error: "Developer account not found." };
  }

  return { user: userData.user, profile, developer, error: null };
}

function developerCanSubmitProducts(developer: any) {
  return cleanString(developer?.status).toLowerCase() === "active";
}

async function findAvailableSlug(adminClient: any, requestedSlug: string, productId = "") {
  const baseSlug = normalizeSlug(requestedSlug, "developer-product");

  for (let index = 0; index < 20; index++) {
    const candidate = index === 0 ? baseSlug : `${baseSlug}-${index + 1}`;
    const { data, error } = await adminClient
      .from("automations")
      .select("id")
      .eq("slug", candidate)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data || data.id === productId) return candidate;
  }

  return `${baseSlug}-${crypto.randomUUID().slice(0, 8)}`;
}

function buildProductPayload(body: Record<string, unknown>, developerId: string, status: "draft" | "pending_review", slug: string) {
  const listingType = cleanString(body.listing_type) === "custom_request"
    ? "custom_request"
    : "standard";

  const pricingType = listingType === "custom_request"
    ? "custom_quote"
    : cleanString(body.pricing_type) || "custom_quote";

  const currency = productCurrency(body.currency);
  const title = cleanString(body.title);
  const price = numberValue(body.price);
  const priceUsd = numberValue(body.price_usd);
  const priceThb = numberValue(body.price_thb);
  const setupFee = numberValue(body.setup_fee);
  const setupFeeUsd = numberValue(body.setup_fee_usd);
  const setupFeeThb = numberValue(body.setup_fee_thb);
  const workflowJson = listingType === "custom_request"
    ? null
    : cleanWorkflowJson(body.n8n_workflow_json);
  const requestedRuntimeType = cleanString(body.runtime_type);
  const workflowSourcePlatform = ["make", "zapier", "manual"].includes(cleanString(body.workflow_source_platform))
    ? cleanString(body.workflow_source_platform)
    : "n8n";
  const runtimeType = listingType === "custom_request"
    ? "manual"
    : workflowJson
      ? "n8n_managed"
      : requestedRuntimeType === "n8n_managed"
        ? "n8n_managed"
        : "manual";
  const requestedTriggerMode = runtimeTriggerMode(body.runtime_trigger_mode);
  const triggerMode = listingType === "custom_request" || runtimeType === "manual"
    ? "manual"
    : requestedTriggerMode;
  const runFrequency = runtimeRunFrequency(body.runtime_run_frequency, triggerMode);
  const detectedPlaceholders = cleanJsonObject(body.detected_placeholders);
  const sheetAccessConfig = cleanSheetAccessConfig(body.sheet_access_config);
  if (Object.keys(sheetAccessConfig).length) {
    detectedPlaceholders._nexus_sheet_access_config = sheetAccessConfig;
  }
  const placeholderValidationErrors = cleanJsonArray(body.placeholder_validation_errors);
  const placeholderValidationStatus = ["valid", "needs_fix", "not_checked"].includes(cleanString(body.placeholder_validation_status))
    ? cleanString(body.placeholder_validation_status)
    : workflowJson
      ? "not_checked"
      : "not_checked";

  return {
    developer_id: developerId,
    title,
    slug,
    category: cleanString(body.category),
    badge: cleanString(body.badge),
    icon: (cleanString(body.icon) || "AI").slice(0, 3).toUpperCase(),
    color: cleanString(body.color) || "blue",
    status,
    listing_type: listingType,
    guided_install_enabled: listingType === "standard" ? boolValue(body.guided_install_enabled) : false,
    featured: false,

    pricing_type: pricingType,
    currency,
    price: currency === "THB" ? priceThb : currency === "USD" ? priceUsd : price,
    price_usd: priceUsd,
    price_thb: priceThb,
    setup_fee: currency === "THB" ? setupFeeThb : currency === "USD" ? setupFeeUsd : setupFee,
    setup_fee_usd: setupFeeUsd,
    setup_fee_thb: setupFeeThb,

    delivery_time: cleanString(body.delivery_time),
    setup_type: cleanString(body.setup_type),
    best_for: cleanString(body.best_for),

    rating: 0,
    review_count: 0,
    sales_count: 0,

    preview_type: "custom",
    preview_mode: cleanString(body.preview_mode) || "template",
    preview_title: cleanString(body.preview_title),
    preview_description: cleanString(body.preview_description),
    preview_code: cleanString(body.preview_code),
    preview_image_url: cleanString(body.preview_image_url),
    preview_base64: cleanString(body.preview_base64),

    short_description: cleanString(body.short_description),
    long_description: cleanString(body.long_description),
    problem: cleanString(body.problem),
    outcome: cleanString(body.outcome),

    who_it_is_for: cleanLines(body.who_it_is_for),
    outputs: cleanLines(body.outputs),
    required_inputs: cleanLines(body.required_inputs),
    required_tools: cleanLines(body.required_tools),
    setup_steps: cleanLines(body.setup_steps),
    trust_points: cleanLines(body.trust_points),
    customizations: cleanCustomizations(body.customizations),

    runtime_type: runtimeType,
    runtime_trigger_mode: triggerMode,
    runtime_run_frequency: runFrequency,
    runtime_interval_count: 1,
    runtime_interval_unit: runFrequency === "every_30_minutes"
      ? "minute"
      : runFrequency === "hourly"
        ? "hour"
        : runFrequency === "daily"
          ? "day"
          : runFrequency === "weekly"
            ? "week"
            : runFrequency === "monthly"
              ? "month"
              : "month",
    runtime_no_change_policy: runtimeNoChangePolicy(body.runtime_no_change_policy),
    runtime_response_mode: runtimeResponseMode(body.runtime_response_mode),
    workflow_source_platform: listingType === "custom_request" ? "manual" : workflowSourcePlatform,
    runtime_output_mode: "standard",
    setup_schema: cleanSchema(body.setup_schema),
    runtime_event_schema: cleanSchema(body.runtime_event_schema),
    credential_schema: cleanSchema(body.credential_schema),
    workflow_placeholder_mappings: cleanWorkflowMappings(body.workflow_placeholder_mappings),
    detected_placeholders: detectedPlaceholders,
    placeholder_validation_status: placeholderValidationStatus,
    placeholder_validation_errors: placeholderValidationErrors,
    n8n_workflow_json: workflowJson,

    admin_run_instructions: cleanString(body.admin_run_instructions),
    internal_notes: cleanString(body.internal_notes),

    updated_at: nowIso(),
  };
}

async function createProductReviewNotification(adminClient: any, developer: any, product: any) {
  try {
    await adminClient.from("admin_notifications").insert({
      notification_type: "developer_product_review",
      title: "New developer product review",
      message: `${developer.display_name || "A developer"} submitted ${product.title || "a product"} for review.`,
      related_automation_id: product.id,
      status: "unread",
      created_at: nowIso(),
    });
  } catch (error) {
    console.warn("Could not create developer product review notification:", error);
  }
}

async function listProducts(adminClient: any, developer: any) {
  const { data, error } = await adminClient
    .from("automations")
    .select("*, developers(display_name, handle, avatar_letter)")
    .eq("developer_id", developer.id)
    .order("updated_at", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);

  const checked = await autoPauseInvalidLiveProducts(adminClient, data || []);

  return {
    products: checked.products || [],
    auto_paused_count: checked.paused_count || 0,
  };
}

async function getProduct(adminClient: any, developer: any, productId: string) {
  const { data, error } = await adminClient
    .from("automations")
    .select("*, developers(display_name, handle, avatar_letter)")
    .eq("id", productId)
    .eq("developer_id", developer.id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) return { error: "Product not found.", status: 404 };

  return {
    product: data,
  };
}

async function saveProduct(adminClient: any, developer: any, body: Record<string, unknown>, submitForReview = false) {
  const productId = cleanString(body.id);
  const title = cleanString(body.title);

  if (!title) {
    return { error: "Product title is required.", status: 400 };
  }

  if (!cleanString(body.short_description)) {
    return { error: "Short description is required.", status: 400 };
  }

  let existingProduct = null;

  if (productId) {
    const loaded = await getProduct(adminClient, developer, productId);

    if (loaded.error) return loaded;

    existingProduct = loaded.product;

    if (existingProduct.status === "archived") {
      return {
        error: "Archived products cannot be edited. Create a new product instead.",
        status: 403,
      };
    }
  }

  const status = submitForReview ? "pending_review" : "draft";
  const slug = await findAvailableSlug(
    adminClient,
    cleanString(body.slug) || title,
    productId,
  );
  let payload;

  try {
    payload = buildProductPayload(body, developer.id, status, slug);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Product workflow fields are invalid.",
      status: 400,
    };
  }

  const workflowJsonChanged = existingProduct
    ? stableJson(existingProduct.n8n_workflow_json) !== stableJson(payload.n8n_workflow_json)
    : Boolean(payload.n8n_workflow_json);

  if (submitForReview && payload.listing_type === "standard" && !payload.n8n_workflow_json) {
    return {
      error: "Upload or paste the n8n workflow JSON before submitting this workflow product for review.",
      status: 400,
    };
  }

  if (submitForReview && payload.listing_type === "standard" && !productId) {
    return {
      error: "Save the product as a draft first, then import and test the workflow before submitting for review.",
      status: 400,
    };
  }

  if (submitForReview && payload.listing_type === "standard" && workflowJsonChanged) {
    return {
      error: "Save the latest workflow draft, import it to n8n, and run a successful technical test before submitting for review.",
      status: 400,
    };
  }

  if (submitForReview && payload.listing_type === "standard" && existingProduct) {
    const imported = existingProduct.n8n_import_status === "imported" &&
      cleanString(existingProduct.n8n_workflow_id) &&
      cleanString(existingProduct.runtime_webhook_url || existingProduct.n8n_webhook_url);

    if (!imported) {
      return {
        error: "Import this workflow to Nexus n8n before submitting it for review.",
        status: 400,
      };
    }

    if (!isPassingWorkflowTest(existingProduct.n8n_last_test_status)) {
      return {
        error: "Run a successful technical test before submitting this workflow product for review.",
        status: 400,
      };
    }

    if (!isLiveProductStatus(existingProduct.status) && !hasRealPassingWorkflowTest(existingProduct)) {
      return {
        error: "Before submitting, use Save & run real test in the Technical test data section. Generated placeholder test runs are useful for debugging, but they are not enough for review.",
        status: 400,
      };
    }

    if (!payload.setup_schema.length && cleanSchema(existingProduct.setup_schema).length) {
      payload.setup_schema = cleanSchema(existingProduct.setup_schema);
    }

    const schemaCheck = setupSchemaReadiness({
      ...existingProduct,
      ...payload,
    });

    if (schemaCheck.missingFields.length) {
      payload.setup_schema = mergeMissingSetupFields(payload.setup_schema, schemaCheck.missingFields);
    }
  }

  if (
    submitForReview &&
    payload.runtime_type === "n8n_managed" &&
    payload.placeholder_validation_status === "needs_fix"
  ) {
    return {
      error: "Fix workflow placeholder issues before submitting for review.",
      status: 400,
    };
  }

  if (workflowJsonChanged) {
    Object.assign(payload, {
      runtime_webhook_url: null,
      runtime_webhook_path: null,
      n8n_webhook_url: null,
      n8n_workflow_id: null,
      n8n_workflow_name: null,
      n8n_normalized_workflow_json: null,
      n8n_import_status: payload.n8n_workflow_json ? "not_imported" : "not_imported",
      n8n_import_error: null,
      n8n_last_synced_at: null,
      n8n_imported_at: null,
      n8n_last_import_result: {},
      n8n_last_test_status: "not_tested",
      n8n_last_test_error: null,
      n8n_last_test_result: null,
      n8n_last_tested_at: null,
      health_status: payload.n8n_workflow_json ? "needs_recheck" : "unknown",
      health_failure_reason: payload.n8n_workflow_json
        ? "Workflow changed. Import and run a fresh technical check before this product can go live."
        : null,
      health_failure_details: payload.n8n_workflow_json
        ? { workflow_changed: true, at: nowIso() }
        : {},
      health_next_check_at: null,
    });
  }

  if (!productId) {
    const { data, error } = await adminClient
      .from("automations")
      .insert({
        ...payload,
        created_at: nowIso(),
      })
      .select("*, developers(display_name, handle, avatar_letter)")
      .single();

    if (error) throw new Error(error.message);

    if (submitForReview) {
      await createProductReviewNotification(adminClient, developer, data);
    }

    return {
      product: data,
      message: submitForReview ? "Product submitted for review." : "Draft saved.",
    };
  }

  const { data, error } = await adminClient
    .from("automations")
    .update(payload)
    .eq("id", productId)
    .eq("developer_id", developer.id)
    .select("*, developers(display_name, handle, avatar_letter)")
    .single();

  if (error) throw new Error(error.message);

  if (submitForReview) {
    await createProductReviewNotification(adminClient, developer, data);
  }

  return {
    product: data,
    message: submitForReview ? "Product submitted for review." : "Draft saved.",
  };
}

async function removeProduct(adminClient: any, developer: any, productId: string) {
  if (!productId) {
    return {
      error: "Product id is required.",
      status: 400,
    };
  }

  const loaded = await getProduct(adminClient, developer, productId);

  if (loaded.error) return loaded;

  const product = loaded.product;

  if (["draft", "pending_review"].includes(product.status)) {
    const { error } = await adminClient
      .from("automations")
      .delete()
      .eq("id", product.id)
      .eq("developer_id", developer.id);

    if (error) throw new Error(error.message);

    return {
      product: null,
      message: "Product removed.",
    };
  }

  if (product.status === "archived") {
    return {
      product,
      message: "Product is already archived.",
    };
  }

  const { data, error } = await adminClient
    .from("automations")
    .update({
      status: "archived",
      updated_at: nowIso(),
      internal_notes: `${cleanString(product.internal_notes)}${product.internal_notes ? "\n\n" : ""}[${nowIso()}] Archived by developer ${developer.display_name || developer.id}.`,
    })
    .eq("id", product.id)
    .eq("developer_id", developer.id)
    .select("*, developers(display_name, handle, avatar_letter)")
    .single();

  if (error) throw new Error(error.message);

  return {
    product: data,
    message: "Product removed from the marketplace.",
  };
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
      message: "developer-products is alive.",
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed.", 405);
  }

  try {
    const { developer, error: authError } = await requireDeveloper(req);

    if (authError || !developer) {
      return errorResponse(authError || "Developer access required.", 401);
    }

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = await req.json().catch(() => ({}));
    const action = cleanString(body.action) || "list";

    let result;

    if (action === "list") {
      result = await listProducts(adminClient, developer);
    } else if (action === "get") {
      result = await getProduct(adminClient, developer, cleanString(body.id));
    } else if (action === "save_draft") {
      result = await saveProduct(adminClient, developer, body, false);
    } else if (action === "submit_for_review") {
      if (!developerCanSubmitProducts(developer)) {
        return errorResponse("Nexus must approve your developer account before you can submit products for review.", 403);
      }
      result = await saveProduct(adminClient, developer, body, true);
    } else if (action === "remove") {
      result = await removeProduct(adminClient, developer, cleanString(body.id));
    } else {
      return errorResponse("Unknown developer products action.", 400);
    }

    if (result.error) {
      return errorResponse(result.error, result.status || 400);
    }

    return jsonResponse({
      ok: true,
      ...result,
    });
  } catch (error) {
    console.error(error);

    return errorResponse(
      error instanceof Error ? error.message : "Could not manage developer product.",
      500,
    );
  }
});
