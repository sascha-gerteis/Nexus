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
    matches: ["gemini", "googlepalm", "google palm", "palm", "lmchatgooglegemini"],
    aliases: API_KEY_ALIASES,
    defaults: { host: "https://generativelanguage.googleapis.com" },
  },
  {
    provider: "openai",
    label: "OpenAI",
    n8nCredentialType: "openAiApi",
    matches: ["openai", "open ai", "openaichat", "lmchatopenai"],
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
    matches: ["custom", "other"],
    aliases: {},
  },
];

export function providerPreset(value: unknown) {
  const raw = lower(value);
  if (!raw) return null;

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
  return providerPreset(slot.provider)
    || providerPreset(slot.n8n_credential_type)
    || providerPreset(slot.node_type)
    || providerPreset(slot.credential_key);
}

function compactNodeType(value: unknown) {
  const raw = cleanString(value);
  if (!raw) return "";
  return raw
    .replace(/^n8n-nodes-base\./, "")
    .replace(/^@n8n\/n8n-nodes-langchain\./, "")
    .replace(/^n8n-nodes-langchain\./, "");
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
  const type = compactNodeType(node?.type);
  const method = pickFirstString(parameters.method, parameters.requestMethod).toUpperCase();
  const url = urlParts(pickFirstString(parameters.url, parameters.endpoint, parameters.webhookUrl));
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

function inferSlotFromNode(node: any) {
  const joined = `${node?.type || ""} ${node?.name || ""} ${JSON.stringify(node?.parameters || {})}`;
  const preset = providerPreset(joined);

  if (!preset) return null;

  return {
    provider: preset.provider,
    provider_label: preset.label,
    credential_type: "api_key",
    credential_key: preset.n8nCredentialType,
    n8n_credential_type: preset.n8nCredentialType,
    current_id: "",
    current_name: "",
    inferred: true,
    summary: nodeSummary(node),
  };
}

function normalizeWorkflowObject(workflow: any) {
  if (!workflow || typeof workflow !== "object") return { nodes: [], connections: {} };
  return JSON.parse(JSON.stringify(workflow));
}

export function detectWorkflowCredentialSlots(workflowInput: any) {
  const workflow = normalizeWorkflowObject(workflowInput);
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const slots: any[] = [];
  const seen = new Set<string>();

  for (const node of nodes) {
    const credentials = asObject(node?.credentials);
    const credentialEntries = Object.entries(credentials);

    for (const [credentialKey, credentialValue] of credentialEntries) {
      const value = asObject(credentialValue);
      const preset = providerPreset(credentialKey) || providerPreset(node?.type);
      const n8nCredentialType = credentialKey || preset?.n8nCredentialType || "";
      const key = `${node?.name || ""}:${credentialKey}:${n8nCredentialType}`;

      if (seen.has(key)) continue;
      seen.add(key);

      slots.push({
        provider: preset?.provider || lower(credentialKey || node?.type || "custom"),
        provider_label: preset?.label || cleanString(credentialKey || "Custom credential"),
        credential_type: "api_key",
        credential_key: credentialKey || n8nCredentialType,
        node_name: cleanString(node?.name || "Unnamed node"),
        node_type: cleanString(node?.type),
        n8n_credential_type: n8nCredentialType,
        current_id: cleanString(value.id),
        current_name: cleanString(value.name),
        inferred: false,
        summary: nodeSummary(node),
      });
    }

    if (!credentialEntries.length) {
      const inferred = inferSlotFromNode(node);
      if (!inferred) continue;

      const key = `${node?.name || ""}:${inferred.credential_key}:${inferred.n8n_credential_type}`;
      if (seen.has(key)) continue;
      seen.add(key);

      slots.push({
        ...inferred,
        node_name: cleanString(node?.name || "Unnamed node"),
        node_type: cleanString(node?.type),
      });
    }
  }

  return slots;
}

function secretFieldsForN8n(credential: any, rawFields: Record<string, any>) {
  const preset = providerPreset(credential?.provider) || providerPreset(credential?.n8n_credential_type);
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
    if (/type is not a known type/i.test(message)) {
      const type = cleanString(context.credential_type);
      const provider = cleanString(context.provider_label || context.provider);
      const node = cleanString(context.node_name);
      throw new Error(
        `Nexus n8n runtime does not recognize credential type "${type || "unknown"}"${provider ? ` for ${provider}` : ""}${node ? ` on ${node}` : ""}. Update/install the matching n8n node package once on the Nexus n8n runtime, then this credential will sync automatically for every developer.`,
      );
    }
    throw new Error(`n8n credential API failed (${response.status}): ${message}`);
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
  const rawFields = await decryptCredentialPayload(credential.encrypted_payload, credentialSecret);
  const credentialType =
    cleanString(explicitCredentialType)
    || cleanString(slot?.n8n_credential_type)
    || cleanString(slot?.credential_key)
    || cleanString(credential.n8n_credential_type)
    || providerPreset(credential.provider)?.n8nCredentialType;

  if (!credentialType) {
    throw new Error("Add an n8n credential type before syncing this credential.");
  }

  const data = secretFieldsForN8n(credential, rawFields);
  if (!Object.keys(data).length) {
    throw new Error("This credential has no saved secret fields to sync.");
  }

  const payload = {
    name: cleanString(explicitCredentialName || credential.n8n_credential_name || credential.label),
    type: credentialType,
    data,
  };

  const requestContext = {
    credential_type: credentialType,
    provider: credential.provider,
    provider_label: credential.provider_label || slot?.provider_label,
    node_name: slot?.node_name,
  };

  let synced: any = null;
  const existingCredentialMatchesType =
    Boolean(credential.n8n_credential_id) &&
    cleanString(credential.n8n_credential_type) === credentialType;

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
    } catch {
      synced = null;
    }
  }

  if (!synced) {
    synced = await n8nRequest(n8nBaseUrl, n8nApiKey, "/api/v1/credentials", {
      method: "POST",
      body: JSON.stringify(payload),
    }, requestContext);
  }

  const n8nId = cleanString(synced?.id || synced?.data?.id || credential.n8n_credential_id);
  const n8nName = cleanString(synced?.name || synced?.data?.name || payload.name);

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
  const preset = presetForSlot(slot);
  const credentialPreset = providerPreset(credential?.provider)
    || providerPreset(credential?.n8n_credential_type);

  if (slot.n8n_credential_type && credential.n8n_credential_type === slot.n8n_credential_type) {
    return true;
  }

  if (preset?.provider && credentialPreset?.provider === preset.provider) {
    return true;
  }

  if (slot.provider && lower(credential.provider) === lower(slot.provider)) {
    return true;
  }

  return false;
}

async function loadCredentialsForProduct(adminClient: SupabaseAdminClient, product: any) {
  const { data, error } = await adminClient
    .from("developer_credentials")
    .select("*")
    .eq("status", "active")
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
  const workflow = normalizeWorkflowObject(workflowInput);
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const n8nCredentialId = cleanString(credential.n8n_credential_id || slot.current_id);
  const n8nCredentialName = cleanString(credential.n8n_credential_name || credential.label || slot.current_name);
  const credentialKey = cleanString(slot.credential_key || slot.n8n_credential_type);
  const isHttpRequestNode = cleanString(slot.node_type).includes("httpRequest");
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
    if (cleanString(node?.name) !== cleanString(slot.node_name)) return node;

    const parameters = {
      ...asObject(node.parameters),
    };

    if (isHttpRequestNode && isGenericHttpCredential) {
      parameters.authentication = "genericCredentialType";
      parameters.genericAuthType = credentialKey;
    }

    return {
      ...node,
      parameters,
      credentials: {
        ...asObject(node.credentials),
        [credentialKey]: {
          id: n8nCredentialId,
          name: n8nCredentialName,
        },
      },
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

export async function bindAutomationCredentials(options: {
  adminClient: SupabaseAdminClient;
  product: any;
  n8nBaseUrl: string;
  n8nApiKey: string;
  credentialSecret: string;
  syncMissingN8nCredentials?: boolean;
}) {
  const {
    adminClient,
    product,
    n8nBaseUrl,
    n8nApiKey,
    credentialSecret,
    syncMissingN8nCredentials = true,
  } = options;

  const workflow = normalizeWorkflowObject(product?.n8n_workflow_json);
  const slots = detectWorkflowCredentialSlots(workflow);

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
  let boundWorkflow = workflow;
  const bindings: any[] = [];
  const errors: any[] = [];

  for (const slot of slots) {
    let credential = credentials.find((item: any) => canUseCredentialForSlot(item, slot));

    if (credential && syncMissingN8nCredentials) {
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

    if (credential?.n8n_credential_id) {
      boundWorkflow = applyCredentialToWorkflow(boundWorkflow, slot, credential);
      bindings.push({
        node_name: slot.node_name,
        node_type: slot.node_type,
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

    errors.push({
      node_name: slot.node_name,
      node_type: slot.node_type,
      credential_key: slot.credential_key,
      n8n_credential_type: slot.n8n_credential_type,
      provider: slot.provider,
      provider_label: slot.provider_label,
      imported_n8n_credential_id: slot.current_id || null,
      imported_n8n_credential_name: slot.current_name || null,
      message: `Add a ${slot.provider_label || slot.provider || "developer"} credential for ${slot.node_name}.${importedCredentialNote}`,
    });
  }

  const rows = requirementRows(product, slots, bindings, errors);
  await persistCredentialRequirements(adminClient, product, rows);

  const status = errors.length ? "needs_credentials" : "bound";

  const automationPatch: Record<string, any> = {
    developer_credential_requirements: slots,
    n8n_credential_bindings: bindings,
    credential_binding_status: status,
    credential_binding_errors: errors,
    n8n_last_credential_bound_at: new Date().toISOString(),
  };

  if (!errors.length) {
    automationPatch.n8n_workflow_json = boundWorkflow;
  }

  await updateAutomationCredentialStatus(adminClient, product.id, automationPatch);

  return {
    ok: !errors.length,
    workflow: boundWorkflow,
    slots,
    bindings,
    errors,
    status,
  };
}
