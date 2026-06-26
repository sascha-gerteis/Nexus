import { isLegacyNexusProduct } from "./legacy-nexus-products.ts";

type SupabaseAdminClient = any;

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

function cloneJson(value: unknown) {
  return JSON.parse(JSON.stringify(value || {}));
}

function b64FromBytes(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
}

function bytesFromB64(value: string) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function aesKey(secret: string) {
  if (!cleanString(secret)) {
    throw new Error("Missing NEXUS_CREDENTIAL_SECRET.");
  }

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(cleanString(secret)),
  );

  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function encryptCredentialPayload(payload: Record<string, any>, secret: string) {
  const key = await aesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(payload || {}));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);

  return {
    v: 1,
    alg: "AES-GCM",
    iv: b64FromBytes(iv),
    data: b64FromBytes(new Uint8Array(encrypted)),
  };
}

export async function decryptCredentialPayload(payload: any, secret: string) {
  const encrypted = asObject(payload);
  if (!encrypted.data || !encrypted.iv) return {};

  const key = await aesKey(secret);
  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytesFromB64(encrypted.iv) },
    key,
    bytesFromB64(encrypted.data),
  );

  try {
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch {
    return {};
  }
}

export async function credentialFingerprint(payload: Record<string, any>) {
  return sha256Hex(JSON.stringify(payload || {}));
}

export function lastFourFromSecretPayload(payload: Record<string, any>) {
  const firstValue = Object.values(payload || {})
    .map((value) => cleanString(value))
    .find(Boolean);

  return firstValue ? firstValue.slice(-4) : "";
}

const API_KEY_ALIASES = { api_key: "apiKey", apiKey: "apiKey", key: "apiKey", token: "apiKey" };
const TOKEN_ALIASES = { api_key: "token", apiKey: "token", token: "token", api_token: "token", access_token: "token" };
const ACCESS_TOKEN_ALIASES = { api_key: "accessToken", apiKey: "accessToken", token: "accessToken", access_token: "accessToken" };
const PASSWORD_ALIASES = { password: "password", pass: "password", token: "password", api_key: "password" };

const PROVIDER_PRESETS = [
  {
    provider: "google_gemini",
    label: "Google Gemini",
    n8nCredentialType: "googlePalmApi",
    matches: ["gemini", "generativelanguage", "googlepalm", "google palm", "palm", "lmchatgooglegemini"],
    aliases: API_KEY_ALIASES,
  },
  {
    provider: "openai",
    label: "OpenAI",
    n8nCredentialType: "openAiApi",
    matches: [
      "openai",
      "open ai",
      "openaiapi",
      "openai chat",
      "openai chat model",
      "openai account",
      "openaichat",
      "lmchatopenai",
      "lm chat openai",
      "chatopenai",
      "n8n-nodes-langchain.lmchatopenai",
    ],
    aliases: API_KEY_ALIASES,
  },
  {
    provider: "anthropic",
    label: "Anthropic",
    n8nCredentialType: "anthropicApi",
    matches: ["anthropic", "claude", "lmchatanthropic"],
    aliases: API_KEY_ALIASES,
  },
  {
    provider: "mistral",
    label: "Mistral AI",
    n8nCredentialType: "mistralCloudApi",
    matches: ["mistral", "lmchatmistral"],
    aliases: API_KEY_ALIASES,
  },
  {
    provider: "cohere",
    label: "Cohere",
    n8nCredentialType: "cohereApi",
    matches: ["cohere"],
    aliases: API_KEY_ALIASES,
  },
  {
    provider: "groq",
    label: "Groq",
    n8nCredentialType: "groqApi",
    matches: ["groq"],
    aliases: API_KEY_ALIASES,
  },
  {
    provider: "huggingface",
    label: "Hugging Face",
    n8nCredentialType: "huggingFaceApi",
    matches: ["huggingface", "hugging face"],
    aliases: API_KEY_ALIASES,
  },
  {
    provider: "openrouter",
    label: "OpenRouter",
    n8nCredentialType: "httpBearerAuth",
    matches: ["openrouter", "open router"],
    aliases: TOKEN_ALIASES,
  },
  {
    provider: "apify",
    label: "Apify",
    n8nCredentialType: "httpBearerAuth",
    matches: ["apify"],
    aliases: { api_key: "token", apiKey: "token", token: "token", api_token: "token" },
  },
  {
    provider: "serpapi",
    label: "SerpAPI",
    n8nCredentialType: "serpApi",
    matches: ["serpapi", "serp api"],
    aliases: API_KEY_ALIASES,
  },
  {
    provider: "serper",
    label: "Serper",
    n8nCredentialType: "httpHeaderAuth",
    matches: ["serper", "google serper"],
    aliases: { api_key: "value", apiKey: "value", key: "value", token: "value", name: "name" },
    defaults: { name: "X-API-KEY" },
  },
  {
    provider: "firecrawl",
    label: "Firecrawl",
    n8nCredentialType: "httpBearerAuth",
    matches: ["firecrawl"],
    aliases: TOKEN_ALIASES,
  },
  {
    provider: "browserless",
    label: "Browserless",
    n8nCredentialType: "browserlessApi",
    matches: ["browserless"],
    aliases: API_KEY_ALIASES,
  },
  {
    provider: "dataforseo",
    label: "DataForSEO",
    n8nCredentialType: "httpBasicAuth",
    matches: ["dataforseo", "data for seo"],
    aliases: { username: "user", user: "user", login: "user", password: "password", api_key: "password" },
  },
  {
    provider: "perplexity",
    label: "Perplexity",
    n8nCredentialType: "perplexityApi",
    matches: ["perplexity"],
    aliases: API_KEY_ALIASES,
  },
  {
    provider: "pinecone",
    label: "Pinecone",
    n8nCredentialType: "pineconeApi",
    matches: ["pinecone"],
    aliases: API_KEY_ALIASES,
  },
  {
    provider: "qdrant",
    label: "Qdrant",
    n8nCredentialType: "qdrantApi",
    matches: ["qdrant"],
    aliases: API_KEY_ALIASES,
  },
  {
    provider: "weaviate",
    label: "Weaviate",
    n8nCredentialType: "weaviateApi",
    matches: ["weaviate"],
    aliases: API_KEY_ALIASES,
  },
  {
    provider: "slack",
    label: "Slack",
    n8nCredentialType: "slackApi",
    matches: ["slack"],
    aliases: ACCESS_TOKEN_ALIASES,
  },
  {
    provider: "discord",
    label: "Discord",
    n8nCredentialType: "discordBotApi",
    matches: ["discord"],
    aliases: TOKEN_ALIASES,
  },
  {
    provider: "telegram",
    label: "Telegram",
    n8nCredentialType: "telegramApi",
    matches: ["telegram"],
    aliases: ACCESS_TOKEN_ALIASES,
  },
  {
    provider: "twilio",
    label: "Twilio",
    n8nCredentialType: "twilioApi",
    matches: ["twilio"],
    aliases: { account_sid: "accountSid", accountSid: "accountSid", auth_token: "authToken", token: "authToken", api_key: "authToken" },
  },
  {
    provider: "sendgrid",
    label: "SendGrid",
    n8nCredentialType: "sendGridApi",
    matches: ["sendgrid", "send grid"],
    aliases: API_KEY_ALIASES,
  },
  {
    provider: "mailgun",
    label: "Mailgun",
    n8nCredentialType: "mailgunApi",
    matches: ["mailgun"],
    aliases: API_KEY_ALIASES,
  },
  {
    provider: "smtp",
    label: "SMTP Email",
    n8nCredentialType: "smtp",
    matches: ["smtp"],
    aliases: { user: "user", username: "user", password: "password", host: "host", port: "port" },
  },
  {
    provider: "imap",
    label: "IMAP Email",
    n8nCredentialType: "imap",
    matches: ["imap"],
    aliases: { user: "user", username: "user", password: "password", host: "host", port: "port" },
  },
  {
    provider: "airtable",
    label: "Airtable",
    n8nCredentialType: "airtableTokenApi",
    matches: ["airtable"],
    aliases: ACCESS_TOKEN_ALIASES,
  },
  {
    provider: "hubspot",
    label: "HubSpot",
    n8nCredentialType: "hubspotApi",
    matches: ["hubspot"],
    aliases: API_KEY_ALIASES,
  },
  {
    provider: "notion",
    label: "Notion",
    n8nCredentialType: "notionApi",
    matches: ["notion"],
    aliases: ACCESS_TOKEN_ALIASES,
  },
  {
    provider: "google_sheets",
    label: "Google Sheets",
    n8nCredentialType: "googleSheetsOAuth2Api",
    matches: ["googlesheets", "google sheets"],
    aliases: {},
  },
  {
    provider: "google_drive",
    label: "Google Drive",
    n8nCredentialType: "googleDriveOAuth2Api",
    matches: ["googledrive", "google drive"],
    aliases: {},
  },
  {
    provider: "gmail",
    label: "Gmail",
    n8nCredentialType: "gmailOAuth2",
    matches: ["gmail"],
    aliases: {},
  },
  {
    provider: "microsoft",
    label: "Microsoft 365",
    n8nCredentialType: "",
    matches: ["microsoft", "outlook", "office365", "sharepoint", "onedrive"],
    aliases: {},
  },
  {
    provider: "salesforce",
    label: "Salesforce",
    n8nCredentialType: "salesforceOAuth2Api",
    matches: ["salesforce"],
    aliases: {},
  },
  {
    provider: "pipedrive",
    label: "Pipedrive",
    n8nCredentialType: "pipedriveApi",
    matches: ["pipedrive"],
    aliases: API_KEY_ALIASES,
  },
  {
    provider: "zendesk",
    label: "Zendesk",
    n8nCredentialType: "zendeskApi",
    matches: ["zendesk"],
    aliases: API_KEY_ALIASES,
  },
  {
    provider: "intercom",
    label: "Intercom",
    n8nCredentialType: "intercomApi",
    matches: ["intercom"],
    aliases: ACCESS_TOKEN_ALIASES,
  },
  {
    provider: "freshdesk",
    label: "Freshdesk",
    n8nCredentialType: "freshdeskApi",
    matches: ["freshdesk"],
    aliases: API_KEY_ALIASES,
  },
  {
    provider: "mailchimp",
    label: "Mailchimp",
    n8nCredentialType: "mailchimpApi",
    matches: ["mailchimp"],
    aliases: API_KEY_ALIASES,
  },
  {
    provider: "activecampaign",
    label: "ActiveCampaign",
    n8nCredentialType: "activeCampaignApi",
    matches: ["activecampaign", "active campaign"],
    aliases: API_KEY_ALIASES,
  },
  {
    provider: "klaviyo",
    label: "Klaviyo",
    n8nCredentialType: "klaviyoApi",
    matches: ["klaviyo"],
    aliases: API_KEY_ALIASES,
  },
  {
    provider: "stripe",
    label: "Stripe",
    n8nCredentialType: "stripeApi",
    matches: ["stripe"],
    aliases: { api_key: "secretKey", apiKey: "secretKey", key: "secretKey", token: "secretKey", secret_key: "secretKey" },
  },
  {
    provider: "shopify",
    label: "Shopify",
    n8nCredentialType: "shopifyApi",
    matches: ["shopify"],
    aliases: { api_key: "accessToken", token: "accessToken", access_token: "accessToken", shop_subdomain: "shopSubdomain", subdomain: "shopSubdomain" },
  },
  {
    provider: "woocommerce",
    label: "WooCommerce",
    n8nCredentialType: "wooCommerceApi",
    matches: ["woocommerce", "woo commerce"],
    aliases: { consumer_key: "consumerKey", consumer_secret: "consumerSecret", url: "url" },
  },
  {
    provider: "paypal",
    label: "PayPal",
    n8nCredentialType: "payPalApi",
    matches: ["paypal", "pay pal"],
    aliases: { client_id: "clientId", client_secret: "clientSecret", secret: "clientSecret" },
  },
  {
    provider: "postgres",
    label: "Postgres",
    n8nCredentialType: "postgres",
    matches: ["postgres", "postgresql"],
    aliases: { host: "host", database: "database", user: "user", username: "user", password: "password", port: "port" },
  },
  {
    provider: "mysql",
    label: "MySQL",
    n8nCredentialType: "mySql",
    matches: ["mysql", "mariadb", "maria db"],
    aliases: { host: "host", database: "database", user: "user", username: "user", password: "password", port: "port" },
  },
  {
    provider: "mongodb",
    label: "MongoDB",
    n8nCredentialType: "mongoDb",
    matches: ["mongodb", "mongo"],
    aliases: { connection_string: "connectionString", uri: "connectionString", url: "connectionString" },
  },
  {
    provider: "redis",
    label: "Redis",
    n8nCredentialType: "redis",
    matches: ["redis"],
    aliases: PASSWORD_ALIASES,
  },
  {
    provider: "supabase",
    label: "Supabase",
    n8nCredentialType: "supabaseApi",
    matches: ["supabase"],
    aliases: { api_key: "serviceRole", apiKey: "serviceRole", service_role: "serviceRole", url: "host" },
  },
  {
    provider: "aws",
    label: "AWS",
    n8nCredentialType: "aws",
    matches: ["aws", "s3", "ses", "lambda"],
    aliases: { access_key_id: "accessKeyId", accessKeyId: "accessKeyId", secret_access_key: "secretAccessKey", secretAccessKey: "secretAccessKey", region: "region" },
  },
  {
    provider: "github",
    label: "GitHub",
    n8nCredentialType: "githubApi",
    matches: ["github", "git hub"],
    aliases: ACCESS_TOKEN_ALIASES,
  },
  {
    provider: "gitlab",
    label: "GitLab",
    n8nCredentialType: "gitlabApi",
    matches: ["gitlab", "git lab"],
    aliases: ACCESS_TOKEN_ALIASES,
  },
  {
    provider: "jira",
    label: "Jira",
    n8nCredentialType: "jiraSoftwareCloudApi",
    matches: ["jira", "atlassian"],
    aliases: { email: "email", api_token: "apiToken", token: "apiToken", subdomain: "subdomain" },
  },
  {
    provider: "trello",
    label: "Trello",
    n8nCredentialType: "trelloApi",
    matches: ["trello"],
    aliases: { api_key: "apiKey", apiKey: "apiKey", token: "apiToken", api_token: "apiToken" },
  },
  {
    provider: "asana",
    label: "Asana",
    n8nCredentialType: "asanaApi",
    matches: ["asana"],
    aliases: ACCESS_TOKEN_ALIASES,
  },
  {
    provider: "clickup",
    label: "ClickUp",
    n8nCredentialType: "clickUpApi",
    matches: ["clickup", "click up"],
    aliases: API_KEY_ALIASES,
  },
  {
    provider: "linear",
    label: "Linear",
    n8nCredentialType: "linearApi",
    matches: ["linear"],
    aliases: API_KEY_ALIASES,
  },
  {
    provider: "make",
    label: "Make.com",
    n8nCredentialType: "httpHeaderAuth",
    matches: ["make.com", "make api", "integromat"],
    aliases: { api_key: "value", apiKey: "value", token: "value", name: "name" },
    defaults: { name: "Authorization" },
  },
  {
    provider: "zapier",
    label: "Zapier",
    n8nCredentialType: "httpBearerAuth",
    matches: ["zapier"],
    aliases: TOKEN_ALIASES,
  },
  {
    provider: "webhook_api",
    label: "Generic API / Webhook",
    n8nCredentialType: "httpHeaderAuth",
    matches: ["generic api", "webhook api", "httpheaderauth", "http header"],
    aliases: { api_key: "value", apiKey: "value", key: "value", token: "value", name: "name" },
  },
  {
    provider: "bearer_token",
    label: "Generic Bearer Token",
    n8nCredentialType: "httpBearerAuth",
    matches: ["bearer", "httpbearerauth", "http bearer"],
    aliases: TOKEN_ALIASES,
  },
  {
    provider: "basic_auth",
    label: "Generic Basic Auth",
    n8nCredentialType: "httpBasicAuth",
    matches: ["basic auth", "httpbasicauth", "http basic"],
    aliases: { username: "user", user: "user", password: "password", api_key: "password" },
  },
  {
    provider: "custom",
    label: "Custom / Other",
    n8nCredentialType: "",
    matches: [],
    aliases: {},
  },
];

const GENERIC_HTTP_CREDENTIAL_TYPES = new Set([
  "httpbasicauth",
  "httpbearerauth",
  "httpdigestauth",
  "httpheaderauth",
  "httpqueryauth",
  "httpcustomauth",
]);

const GENERIC_CREDENTIAL_PROVIDERS = new Set([
  "basic_auth",
  "bearer_token",
  "custom",
  "webhook_api",
]);

export function providerPreset(value: unknown) {
  const raw = lower(value);
  if (!raw) return null;

  /*
    n8n's generic HTTP credential types are shared by many providers. Do not
    let the first provider that happens to use httpBearerAuth/httpHeaderAuth
    claim those slots; keep them generic unless a URL or explicit provider says
    otherwise.
  */
  if (raw === "httpbearerauth") {
    return PROVIDER_PRESETS.find((preset) => preset.provider === "bearer_token") || null;
  }

  if (raw === "httpheaderauth" || raw === "httpqueryauth" || raw === "httpcustomauth") {
    return PROVIDER_PRESETS.find((preset) => preset.provider === "webhook_api") || null;
  }

  if (raw === "httpbasicauth" || raw === "httpdigestauth") {
    return PROVIDER_PRESETS.find((preset) => preset.provider === "basic_auth") || null;
  }

  return PROVIDER_PRESETS.find((preset) => (
    preset.provider === raw ||
    lower(preset.label) === raw ||
    lower(preset.n8nCredentialType) === raw ||
    preset.matches.some((match) => raw.includes(match))
  )) || null;
}

export function providerOptions() {
  return PROVIDER_PRESETS.map((preset) => ({
    provider: preset.provider,
    label: preset.label,
    n8n_credential_type: preset.n8nCredentialType,
  }));
}

function presetForSlot(slot: any) {
  /*
    Native model/tool nodes must win over stale generic credential metadata.
    Without this, an imported OpenAI Chat Model can keep an old httpHeaderAuth
    type and Nexus will try to create the wrong n8n credential family.
  */
  const nativePreset = nativePresetForNonHttpCredentialNode(slot);

  return nativePreset
    || providerPreset(slot.provider)
    || providerPreset(slot.n8n_credential_type)
    || providerPreset(slot.node_type)
    || providerPreset(slot.credential_key);
}

function isGenericHttpCredentialType(value: unknown) {
  return GENERIC_HTTP_CREDENTIAL_TYPES.has(lower(value));
}

function isGenericCredentialProvider(value: unknown) {
  return GENERIC_CREDENTIAL_PROVIDERS.has(lower(value));
}

function isHttpRequestNodeType(value: unknown) {
  return lower(value).includes("httprequest");
}

function nativeNodeText(value: any) {
  return lower([
    value?.node_type,
    value?.type,
    value?.node_name,
    value?.name,
    value?.provider,
    value?.provider_label,
    value?.credential_key,
    value?.n8n_credential_type,
  ].filter(Boolean).join(" "));
}

function isNativeOpenAiModelSlot(value: any) {
  const text = nativeNodeText(value);
  if (!text || isHttpRequestNodeType(text)) return false;

  return (
    text.includes("lmchatopenai") ||
    text.includes("openai chat model") ||
    text.includes("openai account") ||
    text.includes("openaiapi") ||
    (text.includes("openai") && (text.includes("chat") || text.includes("model") || text.includes("langchain")))
  );
}

function slotProvider(slot: any) {
  const preset = presetForSlot(slot);
  return lower(preset?.provider || slot?.provider);
}

function credentialProvider(credential: any) {
  const preset = providerPreset(credential?.provider)
    || providerPreset(credential?.n8n_credential_type);
  return lower(preset?.provider || credential?.provider);
}

function compactNodeType(value: unknown) {
  const raw = cleanString(value);
  if (!raw) return "";
  return raw
    .replace(/^n8n-nodes-base\./, "")
    .replace(/^@n8n\/n8n-nodes-langchain\./, "")
    .replace(/^n8n-nodes-langchain\./, "");
}

function nativePresetForNonHttpCredentialNode(value: any) {
  const text = nativeNodeText(value);
  if (isHttpRequestNodeType(text)) return null;

  if (isNativeOpenAiModelSlot(value)) {
    return providerPreset("openai");
  }

  const preset = providerPreset(text);
  if (!preset?.n8nCredentialType || isGenericHttpCredentialType(preset.n8nCredentialType)) {
    return null;
  }

  return preset;
}

function coerceNativeCredentialSlot(slot: any) {
  const preset = nativePresetForNonHttpCredentialNode(slot);
  if (!preset) return slot;

  return {
    ...slot,
    provider: preset.provider,
    provider_label: preset.label,
    credential_key: preset.n8nCredentialType,
    n8n_credential_type: preset.n8nCredentialType,
  };
}

function redactUrl(value: unknown) {
  const raw = cleanString(value);
  if (!raw) return "";

  return raw
    .replace(/([?&](?:token|api_key|apikey|key|access_token|secret)=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
}

function urlParts(value: unknown) {
  const raw = redactUrl(value);
  if (!raw) return { url: "", host: "", path: "" };

  try {
    const parsed = new URL(raw);
    return {
      url: `${parsed.origin}${parsed.pathname}`,
      host: parsed.host,
      path: parsed.pathname,
    };
  } catch {
    return {
      url: raw.length > 150 ? `${raw.slice(0, 147)}...` : raw,
      host: "",
      path: "",
    };
  }
}

function pickFirstString(...values: unknown[]) {
  for (const value of values) {
    const cleaned = cleanString(value);
    if (cleaned) return cleaned;
  }

  return "";
}

function nodeSummary(node: any) {
  const parameters = asObject(node?.parameters);
  const nexusCredential = asObject(parameters.nexusCredential);
  const type = compactNodeType(node?.type);
  const method = pickFirstString(parameters.method, parameters.requestMethod).toUpperCase();
  const url = urlParts(pickFirstString(
    parameters.url,
    parameters.endpoint,
    parameters.webhookUrl,
    nexusCredential.url,
    nexusCredential.allowed_host,
  ));
  const operation = pickFirstString(parameters.operation, parameters.resource, parameters.action);
  const model = pickFirstString(
    parameters.model,
    parameters.modelName,
    parameters.options?.model,
    parameters.text?.model,
  );
  const authMode = pickFirstString(
    parameters.authentication,
    parameters.genericAuthType,
    parameters.nodeCredentialType,
  );

  const titleParts = [];
  if (method) titleParts.push(method);
  if (url.host) titleParts.push(url.host);
  if (url.path) titleParts.push(url.path);
  if (!titleParts.length && model) titleParts.push(`Model: ${model}`);
  if (!titleParts.length && operation) titleParts.push(operation);

  return {
    node_name: cleanString(node?.name || "Unnamed node"),
    node_type: type,
    method,
    url: url.url,
    host: url.host,
    path: url.path,
    operation,
    model,
    auth_mode: authMode,
    title: titleParts.join(" "),
  };
}

function isCodeLikeNode(node: any) {
  const type = lower(node?.type);
  return (
    type.includes("n8n-nodes-base.code") ||
    type.includes("n8n-nodes-base.function") ||
    type.includes("n8n-nodes-base.functionitem")
  );
}

function isNonCredentialUtilityNode(node: any) {
  const type = lower(node?.type);
  return (
    type.includes("n8n-nodes-base.stickynote") ||
    type.includes("n8n-nodes-base.manualtrigger") ||
    type.includes("n8n-nodes-base.noop")
  );
}

function isHttpRequestNode(node: any) {
  return lower(node?.type).includes("httprequest");
}

function isNexusInternalRuntimeNode(node: any) {
  const name = lower(node?.name);
  return [
    "nexus webhook trigger",
    "nexus runtime context",
    "nexus runtime merge",
    "nexus submit output",
  ].includes(name);
}

function rawHttpTarget(node: any) {
  const parameters = asObject(node?.parameters);
  const nexusCredential = asObject(parameters.nexusCredential);
  return pickFirstString(
    parameters.url,
    parameters.endpoint,
    parameters.webhookUrl,
    nexusCredential.url,
    nexusCredential.allowed_host,
  );
}

function isDynamicHttpTarget(node: any) {
  const raw = lower(rawHttpTarget(node));
  return Boolean(
    raw.startsWith("=") ||
    raw.includes("{{") ||
    raw.includes("$json") ||
    raw.includes("nexus_setup") ||
    raw.includes("nexus_runtime") ||
    raw.includes("$("),
  );
}

function httpTargetPresetForNode(node: any) {
  const summary = nodeSummary(node);
  const urlText = [
    summary.url,
    summary.host,
    summary.path,
  ].filter(Boolean).join(" ");
  const nodeText = `${node?.type || ""} ${node?.name || ""}`;

  return providerPreset(urlText)
    || providerPreset(nodeText);
}

function isProviderSpecificPreset(preset: any) {
  return Boolean(preset?.provider && !isGenericCredentialProvider(preset.provider));
}

function httpNodeHasCredentialRequirement(node: any) {
  if (!isHttpRequestNode(node)) return false;

  const parameters = asObject(node?.parameters);
  const nexusCredential = asObject(parameters.nexusCredential);
  if (Object.keys(nexusCredential).length) return true;

  const authentication = lower(parameters.authentication);
  const genericAuthType = cleanString(parameters.genericAuthType);
  const nodeCredentialType = cleanString(parameters.nodeCredentialType);
  const credentialType = genericAuthType || nodeCredentialType;
  const targetPreset = httpTargetPresetForNode(node);

  /*
    n8n exports can keep a stale credentials object even after an HTTP Request
    node has been changed back to "No auth". Trust the explicit auth controls
    first so public website fetches do not become fake developer-key requirements.
  */
  if (!authentication || ["none", "noauth", "no auth"].includes(authentication)) {
    return false;
  }

  /*
    Dynamic customer URLs such as {{$json["Landing Page Url"]}} are setup data,
    not provider APIs. If an old import accidentally attached a generic bearer
    credential to that node, strip it instead of asking developers for a key.
  */
  if (isDynamicHttpTarget(node) && !isProviderSpecificPreset(targetPreset)) {
    return false;
  }

  /*
    Generic HTTP auth without a static host/provider is almost always a stale
    binding from a previous import attempt. Real API calls either have a static
    API host or explicit Nexus credential metadata.
  */
  if (isGenericHttpCredentialType(credentialType) && !isProviderSpecificPreset(targetPreset)) {
    return false;
  }

  return true;
}

function servicePresetForNode(node: any) {
  if (isNonCredentialUtilityNode(node) || isNexusInternalRuntimeNode(node)) return null;

  const nexusCredential = asObject(asObject(node?.parameters).nexusCredential);
  const explicitProvider = pickFirstString(
    nexusCredential.provider,
    nexusCredential.provider_label,
    nexusCredential.service,
  );
  const explicitPreset = providerPreset(explicitProvider);
  if (explicitPreset) return explicitPreset;

  if (isHttpRequestNode(node)) {
    if (!httpNodeHasCredentialRequirement(node)) return null;

    return httpTargetPresetForNode(node);
  }

  const nodeText = `${node?.type || ""} ${node?.name || ""}`;
  return providerPreset(nodeText);
}

function inferSlotFromNode(node: any) {
  /*
    Code nodes can contain Nexus setup/customer helpers such as
    NEXUS_CODE_SETUP("company_url"). Those are dynamic buyer fields,
    not developer credentials, so never infer provider credentials
    from Code-node source text.
  */
  const nexusCredential = asObject(asObject(node?.parameters).nexusCredential);
  if (Object.keys(nexusCredential).length) {
    const explicitPreset = providerPreset(
      nexusCredential.provider ||
      nexusCredential.provider_label ||
      nexusCredential.credential_key ||
      nexusCredential.n8n_credential_type,
    );
    const credentialType = cleanString(
      nexusCredential.credential_key ||
      nexusCredential.n8n_credential_type ||
      explicitPreset?.n8nCredentialType ||
      "httpBearerAuth",
    );

    return {
      provider: cleanString(nexusCredential.provider || explicitPreset?.provider || "custom"),
      provider_label: cleanString(nexusCredential.provider_label || explicitPreset?.label || "API credential"),
      credential_type: "api_key",
      credential_key: credentialType,
      n8n_credential_type: credentialType,
      current_id: "",
      current_name: "",
      inferred: true,
      uses_nexus_proxy: Boolean(nexusCredential.uses_nexus_proxy),
      allowed_host: cleanString(nexusCredential.allowed_host),
      summary: nodeSummary(node),
    };
  }

  if (isCodeLikeNode(node) || isNonCredentialUtilityNode(node) || isNexusInternalRuntimeNode(node)) return null;
  if (isHttpRequestNode(node) && !httpNodeHasCredentialRequirement(node)) return null;

  const parameters = asObject(node?.parameters);
  const summary = nodeSummary(node);
  const servicePreset = servicePresetForNode(node);
  const authCredentialType =
    isHttpRequestNode(node) && cleanString(parameters.authentication) === "genericCredentialType"
      ? cleanString(parameters.genericAuthType)
      : cleanString(parameters.nodeCredentialType);

  const credentialPreset = providerPreset(authCredentialType);
  const preset = servicePreset || credentialPreset;

  if (!preset) return null;

  const credentialType = authCredentialType || preset.n8nCredentialType;

  if (!credentialType) return null;

  return {
    provider: preset.provider,
    provider_label: preset.label,
    credential_type: "api_key",
    credential_key: credentialType,
    n8n_credential_type: credentialType,
    current_id: "",
    current_name: "",
    inferred: true,
    uses_nexus_proxy: false,
    allowed_host: "",
    summary,
  };
}

function normalizeWorkflowObject(workflow: any) {
  if (!workflow || typeof workflow !== "object") return { nodes: [], connections: {} };
  return JSON.parse(JSON.stringify(workflow));
}

export function sanitizeWorkflowCredentialReferences(workflowInput: any) {
  const workflow = normalizeWorkflowObject(workflowInput);
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];

  workflow.nodes = nodes.map((node: any) => {
    if (isHttpRequestNode(node) && !httpNodeHasCredentialRequirement(node)) {
      const parameters = { ...asObject(node.parameters) };
      delete parameters.authentication;
      delete parameters.genericAuthType;
      delete parameters.nodeCredentialType;

      const { credentials: _credentials, ...cleanNode } = node || {};
      return {
        ...cleanNode,
        parameters,
      };
    }

    if ((!isNonCredentialUtilityNode(node) && !isNexusInternalRuntimeNode(node)) || !node?.credentials) return node;
    const { credentials: _credentials, ...cleanNode } = node;
    return cleanNode;
  });

  return workflow;
}

export function detectWorkflowCredentialSlots(workflowInput: any) {
  const workflow = sanitizeWorkflowCredentialReferences(workflowInput);
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const slots: any[] = [];
  const seen = new Set<string>();

  for (const node of nodes) {
    if (isNonCredentialUtilityNode(node) || isNexusInternalRuntimeNode(node)) continue;
    if (isHttpRequestNode(node) && !httpNodeHasCredentialRequirement(node)) continue;

    const credentials = asObject(node?.credentials);
    const credentialEntries = Object.entries(credentials);

    for (const [credentialKey, credentialValue] of credentialEntries) {
      const value = asObject(credentialValue);
      const servicePreset = servicePresetForNode(node);
      const credentialPreset = providerPreset(credentialKey) || providerPreset(node?.type);
      const preset = servicePreset || credentialPreset;
      const serviceCredentialType = cleanString(servicePreset?.n8nCredentialType);
      const importedCredentialType = cleanString(credentialKey || preset?.n8nCredentialType || "");
      const shouldUseNativeServiceCredential = Boolean(
        !isHttpRequestNode(node) &&
        serviceCredentialType &&
        isProviderSpecificPreset(servicePreset) &&
        !isGenericHttpCredentialType(serviceCredentialType)
      );
      const n8nCredentialType = shouldUseNativeServiceCredential
        ? serviceCredentialType
        : importedCredentialType;
      const credentialSlotKey = shouldUseNativeServiceCredential
        ? serviceCredentialType
        : cleanString(credentialKey || n8nCredentialType);
      const key = `${node?.name || ""}:${credentialSlotKey}:${n8nCredentialType}`;

      if (seen.has(key)) continue;
      seen.add(key);

      slots.push(coerceNativeCredentialSlot({
        provider: preset?.provider || lower(credentialKey || node?.type || "custom"),
        provider_label: preset?.label || cleanString(credentialKey || "Custom credential"),
        credential_type: "api_key",
        credential_key: credentialSlotKey,
        node_name: cleanString(node?.name || "Unnamed node"),
        node_type: cleanString(node?.type),
        n8n_credential_type: n8nCredentialType,
        current_id: cleanString(value.id),
        current_name: cleanString(value.name),
        inferred: false,
        summary: nodeSummary(node),
      }));
    }

    if (!credentialEntries.length) {
      const inferred = inferSlotFromNode(node);
      if (!inferred) continue;

      const key = `${node?.name || ""}:${inferred.credential_key}:${inferred.n8n_credential_type}`;
      if (seen.has(key)) continue;
      seen.add(key);

      slots.push(coerceNativeCredentialSlot({
        ...inferred,
        node_name: cleanString(node?.name || "Unnamed node"),
        node_type: cleanString(node?.type),
      }));
    }
  }

  return slots;
}

function secretFieldsForN8n(
  credential: any,
  rawFields: Record<string, any>,
  targetCredentialType = "",
  slot: any = null,
) {
  const preset =
    providerPreset(targetCredentialType)
    || providerPreset(slot?.n8n_credential_type)
    || providerPreset(slot?.credential_key)
    || providerPreset(credential?.n8n_credential_type)
    || providerPreset(credential?.provider);
  const aliases = preset?.aliases || {};
  const defaults = asObject((preset as any)?.defaults);
  const output: Record<string, any> = {
    ...defaults,
  };

  for (const [key, value] of Object.entries(rawFields || {})) {
    const cleanedValue = typeof value === "string" ? value.trim() : value;
    if (cleanedValue === "" || cleanedValue === null || cleanedValue === undefined) continue;
    output[aliases[key] || key] = cleanedValue;
  }

  return output;
}

function firstSecretValue(rawFields: Record<string, any>) {
  const preferredKeys = [
    "api_key",
    "apiKey",
    "key",
    "token",
    "api_token",
    "access_token",
    "value",
    "headerValue",
    "header_value",
    "password",
    "secret",
  ];

  for (const key of preferredKeys) {
    const value = cleanString(rawFields?.[key]);
    if (value) return value;
  }

  return cleanString(Object.values(rawFields || {}).find((value) => cleanString(value)));
}

function defaultHeaderNameForProvider(credential: any, slot: any) {
  const provider = slotProvider(slot) || credentialProvider(credential);

  if (provider === "google_gemini") return "x-goog-api-key";
  if (provider === "anthropic") return "x-api-key";
  if (provider === "serper") return "X-API-KEY";

  return "Authorization";
}

function credentialDataCandidatesForN8n(
  credential: any,
  rawFields: Record<string, any>,
  targetCredentialType = "",
  slot: any = null,
) {
  const type = lower(targetCredentialType);
  const value = firstSecretValue(rawFields);
  const providerSpecificPreset = providerPreset(credential?.provider)
    || providerPreset(slot?.provider)
    || providerPreset(targetCredentialType);
  const defaults = asObject((providerSpecificPreset as any)?.defaults);
  const base = secretFieldsForN8n(credential, rawFields, targetCredentialType, slot);
  const candidates: Record<string, any>[] = [];

  if (type === "openaiapi" && value) {
    const openAiApiKey = value.replace(/^Bearer\s+/i, "").trim();
    const openAiData: Record<string, any> = {
      apiKey: openAiApiKey,
      organizationId: "",
      url: "https://api.openai.com/v1",
      header: false,
    };
    const baseUrl = cleanString(
      rawFields.baseURL ||
      rawFields.baseUrl ||
      rawFields.base_url ||
      rawFields.url,
    );

    if (baseUrl) openAiData.url = baseUrl;
    candidates.push(openAiData);
    return candidates;
  } else if (type === "httpbearerauth" && value) {
    candidates.push({ token: value });
  } else if (type === "httpheaderauth" && value) {
    const defaultHeaderName = defaultHeaderNameForProvider(credential, slot);
    const headerName = cleanString(
      rawFields.headerName ||
      rawFields.name ||
      defaults.headerName ||
      defaults.name ||
      defaultHeaderName,
    );
    const headerValue = cleanString(
      rawFields.headerValue ||
      rawFields.value ||
      (headerName.toLowerCase() === "authorization" ? `Bearer ${value}` : value),
    );

    candidates.push({ name: headerName, value: headerValue });
    candidates.push({ headerName, headerValue });
  } else if (type === "httpbasicauth") {
    const username = cleanString(rawFields.username || rawFields.user || rawFields.login);
    const password = cleanString(rawFields.password || rawFields.pass || rawFields.api_key || rawFields.token);
    if (username || password) {
      candidates.push({ user: username, password });
      candidates.push({ username, password });
    }
  }

  if (Object.keys(base).length && !["httpbearerauth", "httpheaderauth", "httpbasicauth"].includes(type)) {
    candidates.push(base);
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = JSON.stringify(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return Object.keys(candidate).length > 0;
  });
}

function isNativeN8nCredentialSlot(slot: any, credentialType = "") {
  const type = cleanString(credentialType || slot?.n8n_credential_type || slot?.credential_key);
  const nodeType = cleanString(slot?.node_type || slot?.type);

  return Boolean(
    type &&
    nodeType &&
    !isGenericHttpCredentialType(type) &&
    !isHttpRequestNodeType(nodeType),
  );
}

function n8nCredentialPayloadVariants(name: string, type: string, data: Record<string, any>, slot: any) {
  const base = { name, type, data };
  const nodeType = cleanString(slot?.node_type || slot?.type);

  if (isNativeN8nCredentialSlot(slot, type) && nodeType) {
    return [
      {
        ...base,
        nodesAccess: [{ nodeType }],
      },
      base,
    ];
  }

  return [base];
}

function nativeCredentialManualSetupMessage(slot: any, credentialType: string, error: Error | null) {
  const preset = providerPreset(credentialType) || providerPreset(slot?.provider);
  const provider = cleanString(slot?.provider_label || preset?.label || slot?.provider || credentialType || "provider");
  const node = cleanString(slot?.node_name || "the workflow node");
  const nodeType = cleanString(slot?.node_type);
  const rawError = cleanString(error?.message || "")
    .replace(/^n8n credential API failed \(\d+\):\s*/i, "")
    .replace(/^Nexus tried to sync .*?again\.$/i, "")
    .trim();

  return `${provider} uses n8n's native credential account setup on "${node}". Nexus tried to create the credential profile automatically, but n8n rejected the API setup${rawError ? `: ${rawError}` : "."} Fallback: click Edit workflow, open "${node}"${nodeType ? ` (${nodeType})` : ""}, use Set up credential / select ${provider} account, save the workflow, then click Sync changes and Run check.`;
}

function cleanBaseUrl(value: string) {
  return cleanString(value).replace(/\/+$/, "");
}

async function n8nRequest(
  n8nBaseUrl: string,
  n8nApiKey: string,
  path: string,
  options: RequestInit = {},
  context: Record<string, unknown> = {},
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
    if (
      /headerName|headerValue|header name|header value/i.test(message) &&
      lower(`${context.provider || ""} ${context.provider_label || ""} ${context.node_name || ""} ${context.node_type || ""}`).includes("openai")
    ) {
      throw new Error(
        "Nexus tried to sync an OpenAI model credential as a generic HTTP header credential. OpenAI Chat Model nodes must use n8n credential type openAiApi. Refresh credentials, then press Apply credentials & run check again.",
      );
    }

    if (/type is not a known type/i.test(message)) {
      const type = cleanString(context.credential_type);
      const provider = cleanString(context.provider_label || context.provider);
      const node = cleanString(context.node_name);
      throw new Error(
        `Nexus n8n runtime does not recognize credential type "${type || "unknown"}"${provider ? ` for ${provider}` : ""}${node ? ` on ${node}` : ""}. Update/install the matching n8n node package once on the Nexus n8n runtime, then this credential will sync automatically for every developer.`,
      );
    }
    const apiArea = cleanString(context.api_area)
      || (path.includes("/credentials") ? "credential" : "workflow");
    throw new Error(`n8n ${apiArea} API failed (${response.status}): ${message}`);
  }

  return data;
}

export async function syncCredentialToN8n(options: {
  adminClient: SupabaseAdminClient;
  credential: any;
  credentialSecret: string;
  n8nBaseUrl: string;
  n8nApiKey: string;
  credentialType?: string;
  credentialName?: string;
  slot?: any;
}) {
  const {
    adminClient,
    credential,
    credentialSecret,
    n8nBaseUrl,
    n8nApiKey,
    credentialType: explicitCredentialType,
    credentialName: explicitCredentialName,
    slot,
  } = options;
  const normalizedSlot = coerceNativeCredentialSlot(slot);
  const rawFields = await decryptCredentialPayload(credential.encrypted_payload, credentialSecret);
  const nativeSlotType = cleanString(normalizedSlot?.n8n_credential_type);
  let credentialType =
    (nativeSlotType && !isGenericHttpCredentialType(nativeSlotType) ? nativeSlotType : "")
    || cleanString(explicitCredentialType)
    || cleanString(normalizedSlot?.n8n_credential_type)
    || cleanString(normalizedSlot?.credential_key)
    || cleanString(credential.n8n_credential_type)
    || providerPreset(credential.provider)?.n8nCredentialType;

  if (
    isNativeOpenAiModelSlot(normalizedSlot) ||
    (
      credentialProvider(credential) === "openai" &&
      !isHttpRequestNodeType(normalizedSlot?.node_type || normalizedSlot?.type)
    )
  ) {
    credentialType = "openAiApi";
  }

  if (!credentialType) {
    throw new Error("Add an n8n credential type before syncing this credential.");
  }

  const dataCandidates = credentialDataCandidatesForN8n(credential, rawFields, credentialType, normalizedSlot);
  if (!dataCandidates.length) {
    throw new Error("This credential has no saved secret fields to sync.");
  }

  const requestContext = {
    credential_type: credentialType,
    provider: credential.provider,
    provider_label: credential.provider_label || normalizedSlot?.provider_label,
    node_name: normalizedSlot?.node_name,
    node_type: normalizedSlot?.node_type,
  };

  let synced: any = null;
  let lastSyncError: Error | null = null;
  const forceFreshCredential = Boolean(
    isGenericHttpCredentialType(credentialType) &&
    slotProvider(normalizedSlot) &&
    !isGenericCredentialProvider(slotProvider(normalizedSlot)),
  );
  const existingCredentialMatchesType =
    !forceFreshCredential &&
    Boolean(credential.n8n_credential_id) &&
    cleanString(credential.n8n_credential_type) === credentialType;

  const credentialName = cleanString(explicitCredentialName || credential.n8n_credential_name || credential.label);

  for (const data of dataCandidates) {
    const payloads = n8nCredentialPayloadVariants(credentialName, credentialType, data, normalizedSlot);

    for (const payload of payloads) {
      if (existingCredentialMatchesType) {
        try {
          synced = await n8nRequest(
            n8nBaseUrl,
            n8nApiKey,
            `/api/v1/credentials/${encodeURIComponent(credential.n8n_credential_id)}`,
            {
              method: "PATCH",
              body: JSON.stringify(payload),
            },
            requestContext,
          );
        } catch (error) {
          lastSyncError = error instanceof Error ? error : new Error(String(error));
          synced = null;
        }

        if (synced) break;
      }

      if (synced) break;

      try {
        synced = await n8nRequest(n8nBaseUrl, n8nApiKey, "/api/v1/credentials", {
          method: "POST",
          body: JSON.stringify(payload),
        }, requestContext);
        if (synced) break;
      } catch (error) {
        lastSyncError = error instanceof Error ? error : new Error(String(error));
        synced = null;
      }
    }

    if (synced) break;
  }

  if (!synced) {
    if (isNativeN8nCredentialSlot(normalizedSlot, credentialType)) {
      throw new Error(nativeCredentialManualSetupMessage(normalizedSlot, credentialType, lastSyncError));
    }

    throw lastSyncError || new Error("Could not create n8n credential.");
  }

  const n8nId = cleanString(synced?.id || synced?.data?.id || credential.n8n_credential_id);
  const n8nName = cleanString(synced?.name || synced?.data?.name || credentialName);

  if (!n8nId) {
    throw new Error("n8n did not return a credential ID.");
  }

  const { data: updated, error } = await adminClient
    .from("developer_credentials")
    .update({
      n8n_credential_id: n8nId,
      n8n_credential_name: n8nName,
      n8n_credential_type: credentialType,
      status: "active",
      last_synced_at: new Date().toISOString(),
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", credential.id)
    .select()
    .single();

  if (error) throw new Error(error.message);

  return updated || {
    ...credential,
    n8n_credential_id: n8nId,
    n8n_credential_name: n8nName,
    n8n_credential_type: credentialType,
  };
}

export function redactCredential(credential: any) {
  if (!credential) return null;

  const {
    encrypted_payload: _encryptedPayload,
    fingerprint: _fingerprint,
    ...safe
  } = credential;

  return {
    ...safe,
    has_secret: Boolean(credential.encrypted_payload),
    fingerprint: credential.fingerprint ? `${String(credential.fingerprint).slice(0, 10)}...` : null,
  };
}

function canUseCredentialForSlot(credential: any, slot: any) {
  return credentialMatchScore(credential, slot) > 0;
}

function credentialMatchScore(credential: any, slot: any) {
  const slotType = lower(slot?.n8n_credential_type || slot?.credential_key);
  const credentialType = lower(credential?.n8n_credential_type);
  const slotProviderName = slotProvider(slot);
  const credentialProviderName = credentialProvider(credential);
  const typeMatches = Boolean(slotType && credentialType && slotType === credentialType);
  const providerMatches = Boolean(
    slotProviderName &&
    credentialProviderName &&
    slotProviderName === credentialProviderName,
  );
  const slotHasSpecificProvider = Boolean(slotProviderName && !isGenericCredentialProvider(slotProviderName));
  const slotHasProviderSpecificCredentialType = Boolean(
    slotType &&
    !isGenericHttpCredentialType(slotType) &&
    slotHasSpecificProvider,
  );

  /*
    Several third-party APIs are represented in n8n with the same generic
    credential type, such as httpBearerAuth. Never let an Apify bearer token
    satisfy an OpenAI bearer-token slot just because the n8n type matches.
  */
  if (isGenericHttpCredentialType(slotType) && slotHasSpecificProvider) {
    if (!providerMatches) return 0;
    return typeMatches ? 100 : 80;
  }

  /*
    Native n8n credential-bearing nodes such as OpenAI Chat Model need their
    exact credential family inside n8n. If a Nexus key was saved earlier as a
    generic HTTP credential but the provider still matches, allow it so the
    sync step can recreate/upgrade it as the native n8n credential type.
  */
  if (slotHasProviderSpecificCredentialType) {
    if (!providerMatches) return 0;
    if (credentialType && credentialType !== slotType) {
      return isGenericHttpCredentialType(credentialType) ? 70 : 0;
    }
    return typeMatches ? 100 : 80;
  }

  if (providerMatches && typeMatches) return 100;
  if (providerMatches) return 80;
  if (typeMatches) return 40;
  return 0;
}

function previousCredentialIdForSlot(bindings: any[], slot: any) {
  return cleanString((bindings || []).find((binding) => (
    cleanString(binding?.node_name) === cleanString(slot?.node_name) &&
    cleanString(binding?.credential_key) === cleanString(slot?.credential_key)
  ))?.developer_credential_id);
}

function bestCredentialForSlot(credentials: any[], slot: any, previousBindings: any[] = []) {
  const previousCredentialId = previousCredentialIdForSlot(previousBindings, slot);

  return (credentials || [])
    .map((credential) => ({
      credential,
      score: credentialMatchScore(credential, slot)
        + (previousCredentialId && cleanString(credential?.id) === previousCredentialId ? 20 : 0),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score)[0]?.credential || null;
}

function manualNativeN8nBindingFromSlot(slot: any) {
  if (!isNativeN8nCredentialSlot(slot)) return null;

  const n8nCredentialId = cleanString(slot?.current_id);
  const n8nCredentialName = cleanString(slot?.current_name);
  if (!n8nCredentialId && !n8nCredentialName) return null;

  return {
    node_name: slot.node_name,
    node_type: slot.node_type,
    provider: slot.provider || null,
    provider_label: slot.provider_label || null,
    credential_key: slot.credential_key || slot.n8n_credential_type,
    n8n_credential_type: slot.n8n_credential_type || slot.credential_key,
    n8n_credential_id: n8nCredentialId || null,
    n8n_credential_name: n8nCredentialName || "Existing n8n credential",
    developer_credential_id: null,
    manual_n8n_credential: true,
    managed_in_n8n_editor: true,
  };
}

async function loadCredentialsForProduct(adminClient: SupabaseAdminClient, product: any) {
  const { data, error } = await adminClient
    .from("developer_credentials")
    .select("*")
    .in("status", ["active", "needs_attention"])
    .order("last_synced_at", { ascending: false, nullsFirst: false })
    .order("updated_at", { ascending: false })
    .limit(250);

  if (error) throw new Error(`Could not load developer credentials: ${error.message}`);

  const productDeveloperId = cleanString(product?.developer_id);

  return (data || []).filter((credential: any) => {
    const credentialDeveloperId = cleanString(credential.developer_id);

    if (!productDeveloperId) {
      return !credentialDeveloperId && cleanString(credential.owner_role) === "admin";
    }

    return (
      credentialDeveloperId === productDeveloperId ||
      (!credentialDeveloperId && cleanString(credential.owner_role) === "admin")
    );
  });
}

function applyCredentialToWorkflow(workflowInput: any, slot: any, credential: any) {
  const normalizedSlot = coerceNativeCredentialSlot(slot);
  const workflow = normalizeWorkflowObject(workflowInput);
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const n8nCredentialId = cleanString(credential.n8n_credential_id || normalizedSlot.current_id);
  const n8nCredentialName = cleanString(credential.n8n_credential_name || credential.label || normalizedSlot.current_name);
  const credentialKey = cleanString(normalizedSlot.credential_key || normalizedSlot.n8n_credential_type);
  const isHttpRequestNode = cleanString(normalizedSlot.node_type).includes("httpRequest");
  const isGenericHttpCredential = [
    "httpBasicAuth",
    "httpBearerAuth",
    "httpDigestAuth",
    "httpHeaderAuth",
    "httpQueryAuth",
    "httpCustomAuth",
  ].includes(credentialKey);

  if (!n8nCredentialId || !credentialKey) return workflow;

  workflow.nodes = nodes.map((node: any) => {
    if (cleanString(node?.name) !== cleanString(normalizedSlot.node_name)) return node;

    const parameters = {
      ...asObject(node.parameters),
    };

    if (isHttpRequestNode && isGenericHttpCredential) {
      parameters.authentication = "genericCredentialType";
      parameters.genericAuthType = credentialKey;
    }

    const nextCredentials = {
      ...asObject(node.credentials),
    };

    if (!isHttpRequestNode && !isGenericHttpCredentialType(credentialKey)) {
      for (const key of Object.keys(nextCredentials)) {
        if (isGenericHttpCredentialType(key)) {
          delete nextCredentials[key];
        }
      }
    }

    nextCredentials[credentialKey] = {
      id: n8nCredentialId,
      name: n8nCredentialName,
    };

    return {
      ...node,
      parameters,
      credentials: nextCredentials,
    };
  });

  return workflow;
}

function requirementRows(product: any, slots: any[], bindings: any[], errors: any[]) {
  return slots.map((slot) => {
    const binding = bindings.find((item) => item.node_name === slot.node_name && item.credential_key === slot.credential_key);
    const error = errors.find((item) => item.node_name === slot.node_name && item.credential_key === slot.credential_key);

    return {
      automation_id: product.id,
      developer_id: product.developer_id || null,
      source: product.developer_id ? "developer" : "admin",
      provider: slot.provider || "custom",
      provider_label: slot.provider_label || "Custom credential",
      credential_type: slot.credential_type || "api_key",
      credential_key: slot.credential_key || slot.n8n_credential_type || "credential",
      node_name: slot.node_name || "Unnamed node",
      node_type: slot.node_type || null,
      n8n_credential_type: slot.n8n_credential_type || null,
      n8n_credential_id: binding?.n8n_credential_id || null,
      n8n_credential_name: binding?.n8n_credential_name || null,
      developer_credential_id: binding?.developer_credential_id || null,
      required: true,
      status: error ? "missing" : "bound",
      last_error: error?.message || null,
      metadata: {
        inferred: Boolean(slot.inferred),
        uses_nexus_proxy: Boolean(slot.uses_nexus_proxy),
        allowed_host: slot.allowed_host || null,
        had_existing_n8n_credential: Boolean(slot.current_id || slot.current_name),
        imported_n8n_credential_id: slot.current_id || null,
        imported_n8n_credential_name: slot.current_name || null,
      },
      updated_at: new Date().toISOString(),
    };
  });
}

async function persistCredentialRequirements(adminClient: SupabaseAdminClient, product: any, rows: any[]) {
  try {
    await adminClient
      .from("automation_credential_requirements")
      .delete()
      .eq("automation_id", product.id);

    if (rows.length) {
      const { error } = await adminClient
        .from("automation_credential_requirements")
        .insert(rows);

      if (error) throw error;
    }
  } catch (error) {
    console.warn("Could not persist credential requirements:", error instanceof Error ? error.message : error);
  }
}

async function updateAutomationCredentialStatus(adminClient: SupabaseAdminClient, productId: string, patch: Record<string, any>) {
  try {
    await adminClient
      .from("automations")
      .update(patch)
      .eq("id", productId);
  } catch (error) {
    console.warn("Could not update automation credential status:", error instanceof Error ? error.message : error);
  }
}

function workflowForN8nApi(workflow: any, fallbackName: string) {
  const source = normalizeWorkflowObject(workflow);

  return {
    name: cleanString(source.name || fallbackName || "Nexus Workflow"),
    nodes: Array.isArray(source.nodes) ? source.nodes : [],
    connections: asObject(source.connections),
    settings: {
      executionOrder: cleanString(source.settings?.executionOrder) || "v1",
    },
    staticData: asObject(source.staticData),
  };
}

async function updateHostedN8nWorkflow(
  n8nBaseUrl: string,
  n8nApiKey: string,
  workflowId: string,
  workflow: any,
  fallbackName: string,
) {
  const id = cleanString(workflowId);
  if (!id) return null;

  return await n8nRequest(
    n8nBaseUrl,
    n8nApiKey,
    `/api/v1/workflows/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      body: JSON.stringify(workflowForN8nApi(workflow, fallbackName)),
    },
    {
      api_area: "workflow",
      node_name: "Hosted n8n workflow",
    },
  );
}

export async function bindAutomationCredentials(options: {
  adminClient: SupabaseAdminClient;
  product: any;
  n8nBaseUrl: string;
  n8nApiKey: string;
  credentialSecret: string;
  syncMissingN8nCredentials?: boolean;
  workflowInput?: any;
  workflowJsonColumn?: "n8n_workflow_json" | "n8n_normalized_workflow_json";
  updateHostedWorkflow?: boolean;
}) {
  const {
    adminClient,
    product,
    n8nBaseUrl,
    n8nApiKey,
    credentialSecret,
    syncMissingN8nCredentials = true,
    workflowInput,
    workflowJsonColumn = "n8n_workflow_json",
    updateHostedWorkflow = false,
  } = options;

  if (isLegacyNexusProduct(product)) {
    const workflow = cloneJson(product?.n8n_workflow_json);

    await updateAutomationCredentialStatus(adminClient, product.id, {
      developer_credential_requirements: [],
      n8n_credential_bindings: [],
      credential_binding_status: "bound",
      credential_binding_errors: [],
      n8n_last_credential_bound_at: new Date().toISOString(),
    });

    return {
      ok: true,
      workflow,
      slots: [],
      bindings: [],
      errors: [],
      status: "bound",
      legacy_nexus_direct_n8n_credentials: true,
    };
  }

  const workflow = sanitizeWorkflowCredentialReferences(workflowInput || product?.n8n_workflow_json);
  const slots = detectWorkflowCredentialSlots(workflow).map(coerceNativeCredentialSlot);

  if (!slots.length) {
    await updateAutomationCredentialStatus(adminClient, product.id, {
      developer_credential_requirements: [],
      n8n_credential_bindings: [],
      credential_binding_status: "not_required",
      credential_binding_errors: [],
      n8n_last_credential_bound_at: new Date().toISOString(),
    });

    return {
      ok: true,
      workflow,
      slots: [],
      bindings: [],
      errors: [],
      status: "not_required",
    };
  }

  const credentials = await loadCredentialsForProduct(adminClient, product);
  const previousBindings = Array.isArray(product?.n8n_credential_bindings)
    ? product.n8n_credential_bindings
    : [];
  let boundWorkflow = workflow;
  const bindings: any[] = [];
  const errors: any[] = [];

  for (const slot of slots) {
    const manualNativeBinding = manualNativeN8nBindingFromSlot(slot);
    if (manualNativeBinding) {
      bindings.push(manualNativeBinding);
      continue;
    }

    let credential = bestCredentialForSlot(credentials, slot, previousBindings);
    const usesNexusProxy = Boolean(slot.uses_nexus_proxy);

    if (credential && syncMissingN8nCredentials && !usesNexusProxy) {
      try {
        credential = await syncCredentialToN8n({
          adminClient,
          credential,
          credentialSecret,
          n8nBaseUrl,
          n8nApiKey,
          credentialType: slot.n8n_credential_type || slot.credential_key,
          credentialName: `${credential.label || slot.provider_label || "Nexus credential"} - ${slot.node_name || "workflow"}`,
          slot,
        });
      } catch (error) {
        await adminClient
          .from("developer_credentials")
          .update({
            status: "needs_attention",
            last_error: error instanceof Error ? error.message : String(error),
            updated_at: new Date().toISOString(),
          })
          .eq("id", credential.id);

        errors.push({
          node_name: slot.node_name,
          node_type: slot.node_type,
          credential_key: slot.credential_key,
          n8n_credential_type: slot.n8n_credential_type,
          provider: slot.provider,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }

    if (credential && usesNexusProxy) {
      bindings.push({
        node_name: slot.node_name,
        node_type: slot.node_type,
        provider: slot.provider || credential.provider || null,
        provider_label: slot.provider_label || credential.provider_label || null,
        credential_key: slot.credential_key,
        n8n_credential_type: credential.n8n_credential_type || slot.n8n_credential_type,
        n8n_credential_id: null,
        n8n_credential_name: credential.label,
        developer_credential_id: credential.id,
        uses_nexus_proxy: true,
        allowed_host: slot.allowed_host || null,
      });
      continue;
    }

    if (credential?.n8n_credential_id) {
      boundWorkflow = applyCredentialToWorkflow(boundWorkflow, slot, credential);
      bindings.push({
        node_name: slot.node_name,
        node_type: slot.node_type,
        provider: slot.provider || credential.provider || null,
        provider_label: slot.provider_label || credential.provider_label || null,
        credential_key: slot.credential_key,
        n8n_credential_type: credential.n8n_credential_type || slot.n8n_credential_type,
        n8n_credential_id: credential.n8n_credential_id,
        n8n_credential_name: credential.n8n_credential_name || credential.label,
        developer_credential_id: credential.id,
      });
      continue;
    }

    const importedCredential = cleanString(slot.current_id || slot.current_name);
    const importedCredentialNote = importedCredential
      ? ` The uploaded workflow references n8n credential "${importedCredential}", but Nexus cannot use imported credential IDs until the key is saved and synced from the Nexus credential manager.`
      : "";

    const nodeSummaryText = slot.summary?.title || slot.summary?.url || "";

    errors.push({
      node_name: slot.node_name,
      node_type: slot.node_type,
      credential_key: slot.credential_key,
      n8n_credential_type: slot.n8n_credential_type,
      provider: slot.provider,
      provider_label: slot.provider_label,
      imported_n8n_credential_id: slot.current_id || null,
      imported_n8n_credential_name: slot.current_name || null,
      message: `Next: add a ${slot.provider_label || slot.provider || "developer"} credential for ${slot.node_name} (${slot.n8n_credential_type || slot.credential_key || "n8n credential"})${nodeSummaryText ? ` using ${nodeSummaryText}` : ""}, then press Apply credentials & run check.${importedCredentialNote}`,
    });
  }

  const rows = requirementRows(product, slots, bindings, errors);
  await persistCredentialRequirements(adminClient, product, rows);

  const status = errors.length ? "needs_credentials" : "bound";
  let hostedUpdate: any = null;
  let hostedUpdateError = "";

  if (updateHostedWorkflow && cleanString(product?.n8n_workflow_id)) {
    try {
      hostedUpdate = await updateHostedN8nWorkflow(
        n8nBaseUrl,
        n8nApiKey,
        product.n8n_workflow_id,
        boundWorkflow,
        product.n8n_workflow_name || product.title || product.slug || "Nexus Workflow",
      );
    } catch (error) {
      hostedUpdateError = error instanceof Error ? error.message : String(error);
      errors.push({
        node_name: "Hosted n8n workflow",
        node_type: "n8n-workflow",
        credential_key: "workflow_update",
        n8n_credential_type: null,
        provider: "n8n",
        provider_label: "n8n",
        message: `Credentials were prepared, but Nexus could not update the hosted n8n workflow: ${hostedUpdateError}`,
      });
    }
  }

  const automationPatch: Record<string, any> = {
    developer_credential_requirements: slots,
    n8n_credential_bindings: bindings,
    credential_binding_status: errors.length ? "needs_credentials" : status,
    credential_binding_errors: errors,
    n8n_last_credential_bound_at: !errors.length ? new Date().toISOString() : product.n8n_last_credential_bound_at || null,
    n8n_last_test_status: "not_tested",
    n8n_last_test_error: errors.length
      ? "Credential binding is incomplete. Add or sync credentials, apply them, then run a fresh technical test."
      : null,
    n8n_last_test_result: null,
    n8n_last_tested_at: null,
  };

  if (!errors.length) {
    automationPatch[workflowJsonColumn] = boundWorkflow;
    if (hostedUpdate) {
      automationPatch.n8n_last_synced_at = new Date().toISOString();
    }
  } else if (hostedUpdate) {
    automationPatch[workflowJsonColumn] = boundWorkflow;
    automationPatch.n8n_last_synced_at = new Date().toISOString();
  }

  await updateAutomationCredentialStatus(adminClient, product.id, automationPatch);

  return {
    ok: !errors.length,
    workflow: boundWorkflow,
    slots,
    bindings,
    errors,
    status: errors.length ? "needs_credentials" : status,
    hosted_update: hostedUpdate,
    hosted_update_error: hostedUpdateError || null,
  };
}
