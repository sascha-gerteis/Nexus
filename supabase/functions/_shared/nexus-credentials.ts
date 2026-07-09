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
  const secretPriority = [
    "api_key",
    "openai_api_key",
    "api_token",
    "token",
    "access_token",
    "refresh_token",
    "password",
    "client_secret",
    "consumer_secret",
    "auth_token",
    "private_key",
    "service_account_private_key",
    "secret_access_key",
    "session_token",
    "connection_string",
    "service_account_json",
  ];

  const firstValue = secretPriority
    .map((key) => cleanString(payload?.[key]))
    .find(Boolean) || Object.entries(payload || {})
      .filter(([key]) => !["secure", "ssl"].includes(cleanString(key).toLowerCase()))
      .map(([_key, value]) => cleanString(value))
      .find(Boolean);

  return firstValue ? firstValue.slice(-4) : "";
}

const API_KEY_ALIASES = { api_key: "apiKey", apiKey: "apiKey", key: "apiKey", token: "apiKey" };
const TOKEN_ALIASES = { api_key: "token", apiKey: "token", token: "token", api_token: "token", access_token: "token" };
const ACCESS_TOKEN_ALIASES = { api_key: "accessToken", apiKey: "accessToken", token: "accessToken", access_token: "accessToken" };
const PASSWORD_ALIASES = { password: "password", pass: "password", token: "password", api_key: "password" };
const GOOGLE_OAUTH_ALIASES = {
  client_id: "clientId",
  clientId: "clientId",
  client_secret: "clientSecret",
  clientSecret: "clientSecret",
  refresh_token: "refreshToken",
  refreshToken: "refreshToken",
  access_token: "accessToken",
  accessToken: "accessToken",
  scope: "scope",
  scopes: "scope",
};
const OAUTH_ACCOUNT_ALIASES = {
  ...GOOGLE_OAUTH_ALIASES,
  auth_url: "authUrl",
  authUrl: "authUrl",
  token_url: "accessTokenUrl",
  accessTokenUrl: "accessTokenUrl",
  authorization_url: "authUrl",
  redirect_uri: "redirectUri",
  redirectUri: "redirectUri",
};
const GOOGLE_SERVICE_ACCOUNT_ALIASES = {
  service_account_json: "serviceAccountJson",
  serviceAccountJson: "serviceAccountJson",
  project_id: "projectId",
  projectId: "projectId",
  client_email: "email",
  service_account_email: "email",
  email: "email",
  private_key: "privateKey",
  privateKey: "privateKey",
  delegated_subject: "delegatedSubject",
  delegatedSubject: "delegatedSubject",
  subject: "delegatedSubject",
};
const CONNECTION_ALIASES = {
  host: "host",
  hostname: "host",
  port: "port",
  database: "database",
  db: "database",
  username: "user",
  user: "user",
  password: "password",
  schema: "schema",
  ssl: "ssl",
  connection_string: "connectionString",
  connectionString: "connectionString",
  uri: "connectionString",
  url: "connectionString",
};
const EMAIL_SERVER_ALIASES = {
  host: "host",
  port: "port",
  user: "user",
  username: "user",
  email: "user",
  password: "password",
  secure: "secure",
  ssl: "secure",
};
const AWS_ALIASES = {
  access_key_id: "accessKeyId",
  accessKeyId: "accessKeyId",
  secret_access_key: "secretAccessKey",
  secretAccessKey: "secretAccessKey",
  session_token: "sessionToken",
  sessionToken: "sessionToken",
  region: "region",
};
const API_PAIR_ALIASES = {
  api_key: "apiKey",
  apiKey: "apiKey",
  key: "apiKey",
  api_token: "apiToken",
  token: "apiToken",
  access_token: "accessToken",
  client_id: "clientId",
  clientId: "clientId",
  client_secret: "clientSecret",
  clientSecret: "clientSecret",
  consumer_key: "consumerKey",
  consumer_secret: "consumerSecret",
  account_sid: "accountSid",
  accountSid: "accountSid",
  auth_token: "authToken",
  authToken: "authToken",
  email: "email",
  subdomain: "subdomain",
  shop_subdomain: "shopSubdomain",
  url: "url",
};

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
    n8nCredentialType: "httpQueryAuth",
    matches: ["apify"],
    aliases: { api_key: "value", apiKey: "value", token: "value", api_token: "value", name: "name" },
    defaults: { name: "token" },
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
    credentialProfile: "access_token",
  },
  {
    provider: "slack_oauth",
    label: "Slack OAuth",
    n8nCredentialType: "slackOAuth2Api",
    matches: ["slack oauth", "slackoauth2"],
    aliases: OAUTH_ACCOUNT_ALIASES,
    credentialProfile: "oauth_account",
    requiredSecretFields: ["client_id", "client_secret", "refresh_token"],
  },
  {
    provider: "discord",
    label: "Discord",
    n8nCredentialType: "discordBotApi",
    matches: ["discord"],
    aliases: TOKEN_ALIASES,
    credentialProfile: "access_token",
  },
  {
    provider: "telegram",
    label: "Telegram",
    n8nCredentialType: "telegramApi",
    matches: ["telegram"],
    aliases: ACCESS_TOKEN_ALIASES,
    credentialProfile: "access_token",
  },
  {
    provider: "twilio",
    label: "Twilio",
    n8nCredentialType: "twilioApi",
    matches: ["twilio"],
    aliases: API_PAIR_ALIASES,
    credentialProfile: "api_pair",
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
    matches: ["smtp", "emailsend", "email send", "send email", "email alert", "mail alert"],
    aliases: EMAIL_SERVER_ALIASES,
    credentialProfile: "email_server",
    requiredSecretFields: ["host", "port", "username", "password"],
  },
  {
    provider: "imap",
    label: "IMAP Email",
    n8nCredentialType: "imap",
    matches: ["imap"],
    aliases: EMAIL_SERVER_ALIASES,
    credentialProfile: "email_server",
    requiredSecretFields: ["host", "port", "username", "password"],
  },
  {
    provider: "airtable",
    label: "Airtable",
    n8nCredentialType: "airtableTokenApi",
    matches: ["airtable"],
    aliases: ACCESS_TOKEN_ALIASES,
    credentialProfile: "access_token",
  },
  {
    provider: "hubspot",
    label: "HubSpot",
    n8nCredentialType: "hubspotApi",
    matches: ["hubspot"],
    aliases: API_KEY_ALIASES,
  },
  {
    provider: "hubspot_oauth",
    label: "HubSpot OAuth",
    n8nCredentialType: "hubspotOAuth2Api",
    matches: ["hubspot oauth", "hubspotoauth2"],
    aliases: OAUTH_ACCOUNT_ALIASES,
    credentialProfile: "oauth_account",
    requiredSecretFields: ["client_id", "client_secret", "refresh_token"],
  },
  {
    provider: "notion",
    label: "Notion",
    n8nCredentialType: "notionApi",
    matches: ["notion"],
    aliases: ACCESS_TOKEN_ALIASES,
    credentialProfile: "access_token",
  },
  {
    provider: "google_sheets",
    label: "Google Sheets",
    n8nCredentialType: "googleSheetsOAuth2Api",
    matches: ["googlesheets", "google sheets", "google sheet", "sheetsoauth2"],
    aliases: GOOGLE_OAUTH_ALIASES,
    credentialProfile: "google_oauth",
    requiredSecretFields: ["client_id", "client_secret", "refresh_token"],
    setupHints: [
      "Google Sheets nodes also need a spreadsheet ID/URL and sheet/range in the node or Nexus setup fields.",
      "Use an OAuth refresh token for the Google account that can access the target spreadsheet.",
    ],
  },
  {
    provider: "google_drive",
    label: "Google Drive",
    n8nCredentialType: "googleDriveOAuth2Api",
    matches: ["googledrive", "google drive", "driveoauth2"],
    aliases: GOOGLE_OAUTH_ALIASES,
    credentialProfile: "google_oauth",
    requiredSecretFields: ["client_id", "client_secret", "refresh_token"],
    setupHints: [
      "Google Drive nodes also need a file/folder ID or URL in the node or Nexus setup fields.",
      "Use an OAuth refresh token for the Google account that owns or can access the file.",
    ],
  },
  {
    provider: "google_calendar",
    label: "Google Calendar",
    n8nCredentialType: "googleCalendarOAuth2Api",
    matches: ["googlecalendar", "google calendar", "calendaroauth2"],
    aliases: GOOGLE_OAUTH_ALIASES,
    credentialProfile: "google_oauth",
    requiredSecretFields: ["client_id", "client_secret", "refresh_token"],
    setupHints: [
      "Google Calendar nodes also need a calendar ID or target calendar selected in the node/setup fields.",
      "Use an OAuth refresh token for the Google account that can access the calendar.",
    ],
  },
  {
    provider: "google_docs",
    label: "Google Docs",
    n8nCredentialType: "googleDocsOAuth2Api",
    matches: ["googledocs", "google docs", "google doc", "docsoauth2"],
    aliases: GOOGLE_OAUTH_ALIASES,
    credentialProfile: "google_oauth",
    requiredSecretFields: ["client_id", "client_secret", "refresh_token"],
    setupHints: [
      "Google Docs nodes also need a document ID/URL in the node or Nexus setup fields.",
      "Use an OAuth refresh token for the Google account that can access the document.",
    ],
  },
  {
    provider: "google_analytics",
    label: "Google Analytics",
    n8nCredentialType: "googleAnalyticsOAuth2Api",
    matches: ["googleanalytics", "google analytics", "ga4"],
    aliases: GOOGLE_OAUTH_ALIASES,
    credentialProfile: "google_oauth",
    requiredSecretFields: ["client_id", "client_secret", "refresh_token"],
    setupHints: [
      "Google Analytics nodes also need the property/account ID in the node or Nexus setup fields.",
    ],
  },
  {
    provider: "google_ads",
    label: "Google Ads",
    n8nCredentialType: "googleAdsOAuth2Api",
    matches: ["googleads", "google ads", "adwords"],
    aliases: GOOGLE_OAUTH_ALIASES,
    credentialProfile: "google_oauth",
    requiredSecretFields: ["client_id", "client_secret", "refresh_token"],
    setupHints: [
      "Google Ads nodes also need customer/account IDs and any manager account details required by the workflow.",
    ],
  },
  {
    provider: "gmail",
    label: "Gmail",
    n8nCredentialType: "gmailOAuth2",
    matches: ["gmail", "google mail"],
    aliases: GOOGLE_OAUTH_ALIASES,
    credentialProfile: "google_oauth",
    requiredSecretFields: ["client_id", "client_secret", "refresh_token"],
    setupHints: [
      "Gmail nodes need OAuth access for the mailbox that sends or reads mail.",
      "Use scopes that match the action, such as gmail.send or gmail.modify.",
      "If Google shows redirect_uri_mismatch, add the Nexus n8n editor proxy callback URL to the Google OAuth client.",
    ],
  },
  {
    provider: "google_service_account",
    label: "Google Service Account",
    n8nCredentialType: "googleApi",
    matches: ["googleapi", "google api", "google service account", "service account"],
    aliases: GOOGLE_SERVICE_ACCOUNT_ALIASES,
    credentialProfile: "google_service_account",
    requiredSecretFields: ["service_account_json"],
    setupHints: [
      "Use this for Google APIs that can run with a service account instead of a user OAuth account.",
      "The target sheet/file must be shared with the service account email.",
    ],
  },
  {
    provider: "microsoft",
    label: "Microsoft 365",
    n8nCredentialType: "microsoftOAuth2Api",
    matches: ["microsoft", "outlook", "office365", "sharepoint", "onedrive"],
    aliases: OAUTH_ACCOUNT_ALIASES,
    credentialProfile: "oauth_account",
    requiredSecretFields: ["client_id", "client_secret", "refresh_token"],
  },
  {
    provider: "microsoft_outlook",
    label: "Microsoft Outlook",
    n8nCredentialType: "microsoftOutlookOAuth2Api",
    matches: ["outlook", "microsoft outlook"],
    aliases: OAUTH_ACCOUNT_ALIASES,
    credentialProfile: "oauth_account",
    requiredSecretFields: ["client_id", "client_secret", "refresh_token"],
  },
  {
    provider: "microsoft_excel",
    label: "Microsoft Excel",
    n8nCredentialType: "microsoftExcelOAuth2Api",
    matches: ["microsoft excel", "excel online", "excel"],
    aliases: OAUTH_ACCOUNT_ALIASES,
    credentialProfile: "oauth_account",
    requiredSecretFields: ["client_id", "client_secret", "refresh_token"],
  },
  {
    provider: "microsoft_onedrive",
    label: "Microsoft OneDrive",
    n8nCredentialType: "microsoftOneDriveOAuth2Api",
    matches: ["onedrive", "one drive"],
    aliases: OAUTH_ACCOUNT_ALIASES,
    credentialProfile: "oauth_account",
    requiredSecretFields: ["client_id", "client_secret", "refresh_token"],
  },
  {
    provider: "salesforce",
    label: "Salesforce",
    n8nCredentialType: "salesforceOAuth2Api",
    matches: ["salesforce"],
    aliases: OAUTH_ACCOUNT_ALIASES,
    credentialProfile: "oauth_account",
    requiredSecretFields: ["client_id", "client_secret", "refresh_token"],
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
    credentialProfile: "access_token",
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
    aliases: API_PAIR_ALIASES,
    credentialProfile: "api_pair",
    requiredSecretFields: ["access_token", "shop_subdomain"],
  },
  {
    provider: "woocommerce",
    label: "WooCommerce",
    n8nCredentialType: "wooCommerceApi",
    matches: ["woocommerce", "woo commerce"],
    aliases: API_PAIR_ALIASES,
    credentialProfile: "api_pair",
    requiredSecretFields: ["consumer_key", "consumer_secret", "url"],
  },
  {
    provider: "paypal",
    label: "PayPal",
    n8nCredentialType: "payPalApi",
    matches: ["paypal", "pay pal"],
    aliases: API_PAIR_ALIASES,
    credentialProfile: "oauth_account",
    requiredSecretFields: ["client_id", "client_secret"],
  },
  {
    provider: "postgres",
    label: "Postgres",
    n8nCredentialType: "postgres",
    matches: ["postgres", "postgresql"],
    aliases: CONNECTION_ALIASES,
    credentialProfile: "database",
    requiredSecretFields: ["host", "database", "username", "password"],
  },
  {
    provider: "mysql",
    label: "MySQL",
    n8nCredentialType: "mySql",
    matches: ["mysql", "mariadb", "maria db"],
    aliases: CONNECTION_ALIASES,
    credentialProfile: "database",
    requiredSecretFields: ["host", "database", "username", "password"],
  },
  {
    provider: "mongodb",
    label: "MongoDB",
    n8nCredentialType: "mongoDb",
    matches: ["mongodb", "mongo"],
    aliases: CONNECTION_ALIASES,
    credentialProfile: "database",
    requiredSecretFields: ["connection_string"],
  },
  {
    provider: "redis",
    label: "Redis",
    n8nCredentialType: "redis",
    matches: ["redis"],
    aliases: CONNECTION_ALIASES,
    credentialProfile: "database",
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
    aliases: AWS_ALIASES,
    credentialProfile: "aws",
    requiredSecretFields: ["access_key_id", "secret_access_key", "region"],
  },
  {
    provider: "github",
    label: "GitHub",
    n8nCredentialType: "githubApi",
    matches: ["github", "git hub"],
    aliases: ACCESS_TOKEN_ALIASES,
    credentialProfile: "access_token",
  },
  {
    provider: "gitlab",
    label: "GitLab",
    n8nCredentialType: "gitlabApi",
    matches: ["gitlab", "git lab"],
    aliases: ACCESS_TOKEN_ALIASES,
    credentialProfile: "access_token",
  },
  {
    provider: "jira",
    label: "Jira",
    n8nCredentialType: "jiraSoftwareCloudApi",
    matches: ["jira", "atlassian"],
    aliases: API_PAIR_ALIASES,
    credentialProfile: "api_pair",
    requiredSecretFields: ["email", "api_token", "subdomain"],
  },
  {
    provider: "trello",
    label: "Trello",
    n8nCredentialType: "trelloApi",
    matches: ["trello"],
    aliases: API_PAIR_ALIASES,
    credentialProfile: "api_pair",
    requiredSecretFields: ["api_key", "api_token"],
  },
  {
    provider: "asana",
    label: "Asana",
    n8nCredentialType: "asanaApi",
    matches: ["asana"],
    aliases: ACCESS_TOKEN_ALIASES,
    credentialProfile: "access_token",
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

const GOOGLE_ACCOUNT_PROVIDERS = new Set([
  "google_sheets",
  "google_drive",
  "google_calendar",
  "google_docs",
  "google_analytics",
  "google_ads",
  "gmail",
  "google_service_account",
]);

const GOOGLE_ACCOUNT_CREDENTIAL_TYPES = new Set([
  "googlesheetsoauth2api",
  "googledriveoauth2api",
  "googlecalendaroauth2api",
  "googledocsoauth2api",
  "googleanalyticsoauth2api",
  "googleadsoauth2api",
  "gmailoauth2",
  "googleapi",
]);

const GOOGLE_SERVICE_ACCOUNT_COMPATIBLE_PROVIDERS = new Set([
  "google_sheets",
  "google_drive",
  "google_docs",
]);

const GOOGLE_SERVICE_ACCOUNT_COMPATIBLE_CREDENTIAL_TYPES = new Set([
  "googlesheetsoauth2api",
  "googledriveoauth2api",
  "googledocsoauth2api",
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
    credential_profile: presetCredentialProfile(preset),
    required_secret_fields: presetRequiredSecretFields(preset),
    setup_hints: presetSetupHints(preset),
  }));
}

function inferredCredentialProfileFromPreset(preset: any) {
  const provider = lower(preset?.provider);
  const type = lower(preset?.n8nCredentialType);

  if (preset?.credentialProfile) return cleanString(preset.credentialProfile);
  if (type.includes("oauth2")) return "oauth_account";
  if (type === "smtp" || type === "imap") return "email_server";
  if (["postgres", "mysql", "mongodb", "redis"].includes(provider) || ["postgres", "mysql", "mongodb", "redis"].includes(type)) {
    return "database";
  }
  if (provider === "aws" || type === "aws") return "aws";
  if (type === "httpbasicauth" || provider === "basic_auth") return "basic_auth";
  if (type === "httpbearerauth" || provider === "bearer_token") return "access_token";
  if (type === "httpheaderauth" || provider === "webhook_api") return "header_auth";
  if (type.includes("token") || lower(JSON.stringify(preset?.aliases || {})).includes("accesstoken")) return "access_token";
  return "api_key";
}

function presetCredentialProfile(preset: any) {
  return inferredCredentialProfileFromPreset(preset);
}

function presetRequiredSecretFields(preset: any) {
  return Array.isArray(preset?.requiredSecretFields)
    ? preset.requiredSecretFields.map(cleanString).filter(Boolean)
    : [];
}

function presetSetupHints(preset: any) {
  return Array.isArray(preset?.setupHints)
    ? preset.setupHints.map(cleanString).filter(Boolean)
    : [];
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

function isGoogleAccountProvider(value: unknown) {
  return GOOGLE_ACCOUNT_PROVIDERS.has(lower(value));
}

function isGoogleAccountCredentialType(value: unknown) {
  return GOOGLE_ACCOUNT_CREDENTIAL_TYPES.has(lower(value));
}

function isGoogleAccountSlot(slot: any) {
  return Boolean(
    isGoogleAccountProvider(slotProvider(slot)) ||
    isGoogleAccountProvider(slot?.provider) ||
    isGoogleAccountCredentialType(slot?.n8n_credential_type || slot?.credential_key) ||
    (
      lower(`${slot?.node_type || ""} ${slot?.node_name || ""}`).includes("google") &&
      !lower(`${slot?.node_type || ""} ${slot?.node_name || ""}`).includes("gemini")
    ) ||
    lower(`${slot?.node_type || ""} ${slot?.node_name || ""}`).includes("gmail")
  );
}

function isGoogleAccountCredential(credential: any) {
  return Boolean(
    isGoogleAccountProvider(credentialProvider(credential)) ||
    isGoogleAccountProvider(credential?.provider) ||
    isGoogleAccountCredentialType(credential?.n8n_credential_type)
  );
}

function shouldUseGoogleServiceAccountForSlot(credential: any, slot: any) {
  return Boolean(
    isGoogleAccountSlot(slot) &&
    lower(credential?.provider) === "google_service_account" &&
    lower(credential?.n8n_credential_type || providerPreset(credential?.provider)?.n8nCredentialType) === "googleapi"
  );
}

function canPreferGoogleServiceAccountForSlot(slot: any) {
  const provider = slotProvider(slot) || lower(slot?.provider);
  const type = lower(slot?.n8n_credential_type || slot?.credential_key);
  const text = nativeNodeText(slot);

  return Boolean(
    GOOGLE_SERVICE_ACCOUNT_COMPATIBLE_PROVIDERS.has(provider) ||
    GOOGLE_SERVICE_ACCOUNT_COMPATIBLE_CREDENTIAL_TYPES.has(type) ||
    (
      text.includes("google") &&
      (text.includes("sheet") || text.includes("drive") || text.includes("doc")) &&
      !text.includes("gmail")
    )
  );
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
  const preferredServiceAccountPreset = canPreferGoogleServiceAccountForSlot({
    ...slot,
    provider: slot?.provider || preset?.provider,
    n8n_credential_type: slot?.n8n_credential_type || preset?.n8nCredentialType,
    credential_key: slot?.credential_key || preset?.n8nCredentialType,
  })
    ? providerPreset("google_service_account")
    : null;

  if (!preset && !preferredServiceAccountPreset) return slot;

  const finalPreset = preferredServiceAccountPreset || preset;
  if (!finalPreset) return slot;

  return {
    ...slot,
    original_provider: slot?.provider || preset?.provider || null,
    original_n8n_credential_type: slot?.n8n_credential_type || slot?.credential_key || preset?.n8nCredentialType || null,
    provider: finalPreset.provider,
    provider_label: finalPreset.label,
    credential_profile: presetCredentialProfile(finalPreset),
    required_secret_fields: presetRequiredSecretFields(finalPreset),
    setup_hints: presetSetupHints(finalPreset),
    credential_key: finalPreset.n8nCredentialType,
    n8n_credential_type: finalPreset.n8nCredentialType,
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

function isSetLikeNode(node: any) {
  const text = lower(`${node?.type || ""} ${node?.name || ""}`);
  return (
    text.includes("n8n-nodes-base.set") ||
    text.includes("edit fields") ||
    text.includes("editfields")
  );
}

function scanText(value: any) {
  try {
    return typeof value === "string" ? value : JSON.stringify(value || {});
  } catch {
    return String(value || "");
  }
}

function normalizedFieldName(value: unknown) {
  return cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isCredentialLikeFieldName(value: unknown) {
  const name = normalizedFieldName(value);
  if (!name) return false;

  const safeNonSecrets = [
    "sheet_id",
    "spreadsheet_id",
    "document_id",
    "file_id",
    "page_id",
    "channel_id",
    "account_id",
    "campaign_id",
    "customer_id",
    "workspace_id",
  ];

  if (safeNonSecrets.includes(name)) return false;

  return (
    name.includes("api_key") ||
    name.includes("apikey") ||
    name.includes("api_token") ||
    name.includes("access_token") ||
    name.includes("auth_token") ||
    name.includes("refresh_token") ||
    name.includes("client_secret") ||
    name.includes("secret_key") ||
    name.includes("private_key") ||
    name.includes("bearer") ||
    name.includes("credential") ||
    name === "token" ||
    name === "secret" ||
    name === "password"
  );
}

function isCredentialLikeText(value: unknown) {
  const text = lower(value);
  if (!text) return false;
  return (
    text.includes("authorization") ||
    text.includes("bearer ") ||
    text.includes("api_key") ||
    text.includes("apikey") ||
    text.includes("api-token") ||
    text.includes("api_token") ||
    text.includes("access_token") ||
    text.includes("auth_token") ||
    text.includes("client_secret") ||
    text.includes("private_key") ||
    text.includes("$env.")
  );
}

function extractJsonFieldReferences(value: unknown) {
  const text = scanText(value);
  const refs = new Set<string>();
  const patterns = [
    /\$json\.([a-zA-Z_$][a-zA-Z0-9_$.-]*)/g,
    /\$json\[['"]([^'"]+)['"]\]/g,
    /\.json\.([a-zA-Z_$][a-zA-Z0-9_$.-]*)/g,
    /\.json\[['"]([^'"]+)['"]\]/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text))) {
      const ref = normalizedFieldName(match[1]);
      if (ref) refs.add(ref);
    }
  }

  return Array.from(refs);
}

function collectNameValueAssignments(value: any, output: any[] = []) {
  if (!value || typeof value !== "object") return output;

  if (Array.isArray(value)) {
    for (const item of value) collectNameValueAssignments(item, output);
    return output;
  }

  const object = asObject(value);
  const name = cleanString(
    object.name ||
    object.key ||
    object.field ||
    object.fieldName ||
    object.parameterName,
  );

  if (name) {
    const assignedValue =
      object.value ??
      object.fieldValue ??
      object.stringValue ??
      object.defaultValue ??
      object.expression ??
      object.content;

    output.push({
      name,
      value: assignedValue,
    });
  }

  for (const child of Object.values(object)) {
    if (child && typeof child === "object") collectNameValueAssignments(child, output);
  }

  return output;
}

function credentialCarriersForWorkflow(nodes: any[]) {
  const carriers = new Map<string, any>();

  for (const node of nodes || []) {
    const nodeIsCarrier = isSetLikeNode(node) || isCodeLikeNode(node);
    if (!nodeIsCarrier) continue;

    const assignments = collectNameValueAssignments(node?.parameters);
    const nodeText = scanText(node);

    for (const assignment of assignments) {
      const fieldName = normalizedFieldName(assignment.name);
      if (!fieldName) continue;

      const valueText = scanText(assignment.value);
      const credentialLike = isCredentialLikeFieldName(fieldName) || isCredentialLikeText(valueText);
      if (!credentialLike) continue;

      const preset = providerPreset(`${assignment.name} ${valueText} ${node?.name || ""} ${node?.type || ""}`);
      carriers.set(fieldName, {
        field: assignment.name,
        normalized_field: fieldName,
        source_node: cleanString(node?.name || "Unnamed node"),
        source_node_type: cleanString(node?.type),
        provider: preset?.provider || "",
        provider_label: preset?.label || "",
        n8n_credential_type: preset?.n8nCredentialType || "",
      });
    }

    /*
      Code nodes often construct objects without the Set node's explicit
      assignment shape. If they mention env/API-key fields, keep a light hint
      so downstream HTTP nodes can still be flagged instead of silently passing.
    */
    if (isCodeLikeNode(node) && isCredentialLikeText(nodeText)) {
      const preset = providerPreset(nodeText);
      for (const ref of extractJsonFieldReferences(nodeText)) {
        if (!isCredentialLikeFieldName(ref)) continue;
        carriers.set(ref, {
          field: ref,
          normalized_field: ref,
          source_node: cleanString(node?.name || "Unnamed node"),
          source_node_type: cleanString(node?.type),
          provider: preset?.provider || "",
          provider_label: preset?.label || "",
          n8n_credential_type: preset?.n8nCredentialType || "",
        });
      }
    }
  }

  return carriers;
}

function httpCredentialReferenceHint(node: any, credentialCarriers: Map<string, any> | null = null) {
  if (!isHttpRequestNode(node)) return null;

  const parameters = asObject(node?.parameters);
  const text = scanText(parameters);
  const targetPreset = httpTargetPresetForNode(node);
  const refs = extractJsonFieldReferences(parameters);
  const matchingCarriers = refs
    .map((ref) => credentialCarriers?.get(ref))
    .filter(Boolean);
  const credentialFieldRefs = refs.filter(isCredentialLikeFieldName);
  const hasEnvSecret = /\$env\.[a-zA-Z0-9_]*(?:API|TOKEN|SECRET|KEY|PASSWORD)[a-zA-Z0-9_]*/i.test(text);
  const hasCredentialSignal = Boolean(
    matchingCarriers.length ||
    credentialFieldRefs.length ||
    hasEnvSecret ||
    isCredentialLikeText(text),
  );

  if (!hasCredentialSignal) return null;

  const carrierPreset = matchingCarriers
    .map((carrier) => providerPreset(carrier.provider || carrier.n8n_credential_type || carrier.provider_label || carrier.field))
    .find(Boolean);
  const textPreset = providerPreset(text);
  const preset =
    targetPreset ||
    httpCompatibleCredentialPreset(node, carrierPreset) ||
    httpCompatibleCredentialPreset(node, textPreset) ||
    providerPreset("bearer_token");

  return {
    preset,
    fields: Array.from(new Set([
      ...matchingCarriers.map((carrier) => cleanString(carrier.field || carrier.normalized_field)).filter(Boolean),
      ...credentialFieldRefs,
    ])),
    source_nodes: Array.from(new Set(matchingCarriers.map((carrier) => cleanString(carrier.source_node)).filter(Boolean))),
    detected_from: hasEnvSecret
      ? "env_secret_reference"
      : matchingCarriers.length
        ? "upstream_credential_field"
        : "http_parameter_secret_reference",
  };
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
  const preset = providerPreset(urlText) || providerPreset(nodeText);

  return httpCompatibleCredentialPreset(node, preset);
}

function httpCompatibleCredentialPreset(node: any, preset: any) {
  if (!preset) return null;
  if (!isHttpRequestNode(node)) return preset;

  const provider = cleanString(preset.provider);
  const text = lower(scanText(node?.parameters));
  if (provider === "apify") {
    return {
      ...preset,
      n8nCredentialType: "httpQueryAuth",
      aliases: { api_key: "value", apiKey: "value", token: "value", api_token: "value", name: "name" },
      defaults: { name: "token" },
    };
  }

  if (isGenericHttpCredentialType(preset.n8nCredentialType)) return preset;

  const bearerProviders = new Set([
    "openai",
    "anthropic",
    "mistral",
    "cohere",
    "groq",
    "huggingface",
    "perplexity",
    "openrouter",
    "firecrawl",
    "zapier",
  ]);

  if (provider === "google_gemini") {
    if (text.includes("key=") || text.includes("api_key") || text.includes("apikey")) {
      return {
        ...preset,
        n8nCredentialType: "httpQueryAuth",
        aliases: { api_key: "value", apiKey: "value", key: "value", token: "value", name: "name" },
        defaults: { name: "key" },
      };
    }

    return {
      ...preset,
      n8nCredentialType: "httpHeaderAuth",
      aliases: { api_key: "value", apiKey: "value", key: "value", token: "value", name: "name" },
      defaults: { name: "x-goog-api-key" },
    };
  }

  if (bearerProviders.has(provider)) {
    return {
      ...preset,
      n8nCredentialType: "httpBearerAuth",
    };
  }

  return preset;
}

function isProviderSpecificPreset(preset: any) {
  return Boolean(preset?.provider && !isGenericCredentialProvider(preset.provider));
}

function httpNodeHasCredentialRequirement(node: any, credentialCarriers: Map<string, any> | null = null) {
  if (!isHttpRequestNode(node)) return false;

  const parameters = asObject(node?.parameters);
  const nexusCredential = asObject(parameters.nexusCredential);
  if (Object.keys(nexusCredential).length) return true;

  const authentication = lower(parameters.authentication);
  const genericAuthType = cleanString(parameters.genericAuthType);
  const nodeCredentialType = cleanString(parameters.nodeCredentialType);
  const credentialType = genericAuthType || nodeCredentialType;
  const targetPreset = httpTargetPresetForNode(node);
  const referenceHint = httpCredentialReferenceHint(node, credentialCarriers);

  /*
    n8n exports can keep a stale credentials object even after an HTTP Request
    node has been changed back to "No auth". Trust the explicit auth controls
    first so public website fetches do not become fake developer-key requirements.
  */
  if (!authentication || ["none", "noauth", "no auth"].includes(authentication)) {
    return Boolean(
      isProviderSpecificPreset(targetPreset) ||
      (referenceHint && isProviderSpecificPreset(referenceHint.preset || targetPreset))
    );
  }

  /*
    Dynamic customer URLs such as {{$json["Landing Page Url"]}} are setup data,
    not provider APIs. If an old import accidentally attached a generic bearer
    credential to that node, strip it instead of asking developers for a key.
  */
  if (isDynamicHttpTarget(node) && !isProviderSpecificPreset(targetPreset)) {
    return Boolean(referenceHint && isProviderSpecificPreset(referenceHint.preset));
  }

  /*
    Generic HTTP auth without a static host/provider is almost always a stale
    binding from a previous import attempt. Real API calls either have a static
    API host or explicit Nexus credential metadata.
  */
  if (isGenericHttpCredentialType(credentialType) && !isProviderSpecificPreset(targetPreset)) {
    return Boolean(referenceHint && isProviderSpecificPreset(referenceHint.preset));
  }

  return true;
}

function servicePresetForNode(node: any, credentialCarriers: Map<string, any> | null = null) {
  if (isNonCredentialUtilityNode(node) || isNexusInternalRuntimeNode(node)) return null;

  const nexusCredential = asObject(asObject(node?.parameters).nexusCredential);
  const parameters = asObject(node?.parameters);
  const nodeText = `${node?.type || ""} ${node?.name || ""}`;
  if (
    lower(nodeText).includes("google") &&
    lower(parameters.authentication || parameters.authType || parameters.credentialType).includes("service")
  ) {
    const serviceAccountPreset = providerPreset("google_service_account");
    if (serviceAccountPreset) return serviceAccountPreset;
  }

  const explicitProvider = pickFirstString(
    nexusCredential.provider,
    nexusCredential.provider_label,
    nexusCredential.service,
  );
  const explicitPreset = providerPreset(explicitProvider);
  if (explicitPreset) return explicitPreset;

  if (isHttpRequestNode(node)) {
    if (!httpNodeHasCredentialRequirement(node, credentialCarriers)) return null;

    return httpTargetPresetForNode(node)
      || httpCredentialReferenceHint(node, credentialCarriers)?.preset;
  }

  return providerPreset(nodeText);
}

function inferSlotFromNode(node: any, credentialCarriers: Map<string, any> | null = null) {
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
  if (isHttpRequestNode(node) && !httpNodeHasCredentialRequirement(node, credentialCarriers)) return null;

  const parameters = asObject(node?.parameters);
  const summary = nodeSummary(node);
  const referenceHint = httpCredentialReferenceHint(node, credentialCarriers);
  const servicePreset = servicePresetForNode(node, credentialCarriers);
  const authCredentialType =
    isHttpRequestNode(node) && cleanString(parameters.authentication) === "genericCredentialType"
      ? cleanString(parameters.genericAuthType)
      : cleanString(parameters.nodeCredentialType);

  const credentialPreset = providerPreset(authCredentialType);
  const preset = servicePreset || credentialPreset || referenceHint?.preset;

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
    inferred_from_parameter_reference: Boolean(referenceHint),
    credential_source_fields: referenceHint?.fields || [],
    credential_source_nodes: referenceHint?.source_nodes || [],
    detected_from: referenceHint?.detected_from || "",
    uses_nexus_proxy: false,
    allowed_host: "",
    summary,
  };
}

function normalizeWorkflowObject(workflow: any) {
  if (!workflow || typeof workflow !== "object") return { nodes: [], connections: {} };
  return JSON.parse(JSON.stringify(workflow));
}

function isGoogleSheetsNode(node: any) {
  const text = lower(`${node?.type || ""} ${node?.name || ""}`);
  return text.includes("googlesheets") || text.includes("google sheets");
}

function resourceLocatorValue(value: any) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return cleanString(asObject(value).value || asObject(value).cachedResultName || asObject(value).name);
  }
  return cleanString(value);
}

function normalizeResourceLocatorMode(value: any, target: "document" | "sheet") {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;

  const locator = { ...asObject(value) };
  if (!locator.__rl && !locator.mode && !Object.prototype.hasOwnProperty.call(locator, "value")) return value;

  const originalMode = lower(locator.mode);
  const currentValue = resourceLocatorValue(locator);
  if (cleanString(locator.cachedResultName) && target === "sheet" && (!cleanString(locator.value) || originalMode === "list")) {
    locator.value = cleanString(locator.cachedResultName);
  }

  if (target === "sheet") {
    locator.mode = "name";
    return locator;
  }

  const lowerValue = lower(currentValue);
  const looksLikeUrl =
    lowerValue.includes("docs.google.com/spreadsheets") ||
    lowerValue.startsWith("http") ||
    lowerValue.includes("google_sheet_url") ||
    lowerValue.includes("sheet_url");

  locator.mode = looksLikeUrl ? "url" : "id";
  return locator;
}

export function normalizeWorkflowResourceLocators(workflowInput: any) {
  const workflow = normalizeWorkflowObject(workflowInput);
  const documentKeys = ["documentId", "spreadsheetId", "sheetId", "fileId", "documentUrl", "spreadsheetUrl"];
  const sheetKeys = ["sheetName", "sheet", "tabName", "worksheet"];

  workflow.nodes = Array.isArray(workflow.nodes)
    ? workflow.nodes.map((node: any) => {
      if (!isGoogleSheetsNode(node)) return node;

      const parameters = { ...asObject(node.parameters) };
      for (const key of documentKeys) {
        if (Object.prototype.hasOwnProperty.call(parameters, key)) {
          parameters[key] = normalizeResourceLocatorMode(parameters[key], "document");
        }
      }

      for (const key of sheetKeys) {
        if (Object.prototype.hasOwnProperty.call(parameters, key)) {
          parameters[key] = normalizeResourceLocatorMode(parameters[key], "sheet");
        }
      }

      return {
        ...node,
        parameters,
      };
    })
    : [];

  return workflow;
}

export function sanitizeWorkflowCredentialReferences(workflowInput: any) {
  const workflow = normalizeWorkflowResourceLocators(workflowInput);
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
  const credentialCarriers = credentialCarriersForWorkflow(nodes);
  const slots: any[] = [];
  const seen = new Set<string>();

  for (const node of nodes) {
    if (isNonCredentialUtilityNode(node) || isNexusInternalRuntimeNode(node)) continue;
    if (isHttpRequestNode(node) && !httpNodeHasCredentialRequirement(node, credentialCarriers)) continue;

    const credentials = asObject(node?.credentials);
    const credentialEntries = Object.entries(credentials);

    for (const [credentialKey, credentialValue] of credentialEntries) {
      const value = asObject(credentialValue);
      const servicePreset = servicePresetForNode(node, credentialCarriers);
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
      const inferred = inferSlotFromNode(node, credentialCarriers);
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

function normalizeCredentialFieldValue(key: string, value: any) {
  const lowerKey = lower(key);
  const cleaned = typeof value === "string" ? value.trim() : value;
  if (["ssl", "secure", "rejectUnauthorized", "allowUnauthorizedCerts"].map(lower).includes(lowerKey)) {
    if (typeof cleaned === "boolean") return cleaned;
    if (["true", "1", "yes", "on", "enabled"].includes(lower(cleaned))) return true;
    if (["false", "0", "no", "off", "disabled"].includes(lower(cleaned))) return false;
  }

  if (lowerKey === "port" && cleanString(cleaned) && !Number.isNaN(Number(cleaned))) {
    return Number(cleaned);
  }

  return cleaned;
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
    const outputKey = aliases[key] || key;
    output[outputKey] = normalizeCredentialFieldValue(outputKey, cleanedValue);
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

function jsonObjectFromField(value: unknown) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;

  const raw = cleanString(value);
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    return asObject(parsed);
  } catch {
    return {};
  }
}

function googleOAuthScopesForCredentialType(type: string) {
  const cleanType = lower(type);
  if (cleanType === "gmailoauth2") {
    return [
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/gmail.send",
    ].join(" ");
  }

  if (cleanType === "googledriveoauth2api") {
    return "https://www.googleapis.com/auth/drive";
  }

  return [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.file",
  ].join(" ");
}

function googleOAuthCredentialCandidates(rawFields: Record<string, any>, credentialType: string) {
  const clientId = cleanString(rawFields.clientId || rawFields.client_id);
  const clientSecret = cleanString(rawFields.clientSecret || rawFields.client_secret);
  const refreshToken = cleanString(rawFields.refreshToken || rawFields.refresh_token);
  const accessToken = cleanString(rawFields.accessToken || rawFields.access_token);
  const scope = cleanString(rawFields.scope || rawFields.scopes) || googleOAuthScopesForCredentialType(credentialType);

  if (!clientId || !clientSecret) return [];

  const baseData: Record<string, any> = {
    grantType: "authorizationCode",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    accessTokenUrl: "https://oauth2.googleapis.com/token",
    authQueryParameters: "access_type=offline&prompt=consent",
    authentication: "body",
    clientId,
    clientSecret,
    scope,
  };
  const candidates: Record<string, any>[] = [baseData];

  if (refreshToken || accessToken) {
    const oauthTokenData: Record<string, any> = {
      token_type: "Bearer",
      scope,
    };
    if (refreshToken) oauthTokenData.refresh_token = refreshToken;
    if (accessToken) oauthTokenData.access_token = accessToken;

    candidates.unshift({
      ...baseData,
      oauthTokenData,
    });

    candidates.push({
      ...baseData,
      oauthTokenData: {
        tokenType: "Bearer",
        scope,
        ...(refreshToken ? { refreshToken } : {}),
        ...(accessToken ? { accessToken } : {}),
      },
    });
  }

  return candidates;
}

function oauthCredentialCandidates(rawFields: Record<string, any>) {
  const clientId = cleanString(rawFields.clientId || rawFields.client_id);
  const clientSecret = cleanString(rawFields.clientSecret || rawFields.client_secret);
  const refreshToken = cleanString(rawFields.refreshToken || rawFields.refresh_token);
  const accessToken = cleanString(rawFields.accessToken || rawFields.access_token);
  const scope = cleanString(rawFields.scope || rawFields.scopes);
  const authUrl = cleanString(rawFields.authUrl || rawFields.auth_url || rawFields.authorization_url);
  const accessTokenUrl = cleanString(rawFields.accessTokenUrl || rawFields.token_url || rawFields.access_token_url);
  const redirectUri = cleanString(rawFields.redirectUri || rawFields.redirect_uri);

  if (!clientId && !clientSecret && !refreshToken && !accessToken) return [];

  const baseData: Record<string, any> = {};
  if (clientId) baseData.clientId = clientId;
  if (clientSecret) baseData.clientSecret = clientSecret;
  if (scope) baseData.scope = scope;
  if (authUrl) baseData.authUrl = authUrl;
  if (accessTokenUrl) baseData.accessTokenUrl = accessTokenUrl;
  if (redirectUri) baseData.redirectUri = redirectUri;

  const candidates: Record<string, any>[] = [baseData];
  if (refreshToken || accessToken) {
    const oauthTokenData: Record<string, any> = { token_type: "Bearer" };
    if (scope) oauthTokenData.scope = scope;
    if (refreshToken) oauthTokenData.refresh_token = refreshToken;
    if (accessToken) oauthTokenData.access_token = accessToken;
    candidates.unshift({ ...baseData, oauthTokenData });
    candidates.push({
      ...baseData,
      oauthTokenData: {
        tokenType: "Bearer",
        ...(scope ? { scope } : {}),
        ...(refreshToken ? { refreshToken } : {}),
        ...(accessToken ? { accessToken } : {}),
      },
    });
  }

  return candidates;
}

function googleServiceAccountCredentialCandidates(rawFields: Record<string, any>) {
  const serviceAccount = jsonObjectFromField(rawFields.serviceAccountJson || rawFields.service_account_json);
  const email = cleanString(
    rawFields.email ||
    rawFields.service_account_email ||
    rawFields.client_email ||
    serviceAccount.client_email,
  );
  const privateKey = cleanString(
    rawFields.privateKey ||
    rawFields.private_key ||
    serviceAccount.private_key,
  ).replace(/\\n/g, "\n");
  const delegatedEmail = cleanString(
    rawFields.delegatedEmail ||
    rawFields.delegated_email ||
    rawFields.delegatedSubject ||
    rawFields.delegated_subject ||
    rawFields.subject,
  );
  const scopes = cleanString(rawFields.scopes || rawFields.scope) ||
    "https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive";
  const candidates: Record<string, any>[] = [];

  if (email && privateKey) {
    /*
      n8n's googleApi credential does not accept the raw service-account JSON
      wrapper. Its API schema expects the flattened account fields.
    */
    candidates.push({
      email,
      privateKey,
      delegatedEmail,
      scopes,
      httpWarning: true,
    });
    candidates.push({
      email,
      privateKey,
      delegatedEmail: delegatedEmail || email,
      scopes,
      httpWarning: true,
    });
    candidates.push({
      email,
      privateKey,
      scopes,
      httpWarning: true,
    });
  }

  return candidates;
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
  } else if (["googlesheetsoauth2api", "googledriveoauth2api", "googlecalendaroauth2api", "googledocsoauth2api", "googleanalyticsoauth2api", "googleadsoauth2api", "gmailoauth2"].includes(type)) {
    candidates.push(...googleOAuthCredentialCandidates(rawFields, targetCredentialType));
  } else if (type === "googleapi") {
    candidates.push(...googleServiceAccountCredentialCandidates(rawFields));
  } else if (type.includes("oauth2")) {
    candidates.push(...oauthCredentialCandidates(rawFields));
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
  } else if (type === "httpqueryauth" && value) {
    const queryName = cleanString(
      rawFields.queryName ||
      rawFields.name ||
      defaults.queryName ||
      defaults.name ||
      "key",
    );
    const queryValue = cleanString(
      rawFields.queryValue ||
      rawFields.value ||
      value,
    );

    candidates.push({ name: queryName, value: queryValue });
    candidates.push({ queryName, queryValue });
  } else if (type === "httpbasicauth") {
    const username = cleanString(rawFields.username || rawFields.user || rawFields.login);
    const password = cleanString(rawFields.password || rawFields.pass || rawFields.api_key || rawFields.token);
    if (username || password) {
      candidates.push({ user: username, password });
      candidates.push({ username, password });
    }
  }

  if (Object.keys(base).length && !["httpbearerauth", "httpheaderauth", "httpbasicauth", "googleapi"].includes(type)) {
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

function requiresNativeAccountSetup(slot: any, credentialType = "") {
  const type = lower(credentialType || slot?.n8n_credential_type || slot?.credential_key);
  if (!type) return false;
  if (type === "googleapi" || type === "openaiapi") return false;
  return type.includes("oauth2") || type === "gmailoauth2";
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
  const hints = presetSetupHints(preset).join(" ");
  const rawError = cleanString(error?.message || "")
    .replace(/^n8n credential API failed \(\d+\):\s*/i, "")
    .replace(/^Nexus tried to sync .*?again\.$/i, "")
    .trim();
  const cleanReason = /refreshToken|accessToken|serverUrl|additionalBodyProperties|OAuth|oauth/i.test(rawError)
    ? "n8n requires this account to be completed through its native OAuth/account setup."
    : rawError;

  if (lower(credentialType).includes("google") || lower(credentialType) === "gmailoauth2" || lower(provider).includes("google") || lower(provider).includes("gmail")) {
    return `${provider} uses a native Google OAuth account on "${node}". Use the Nexus credential panel's Connect Google button for this node, then press Apply credentials & run check. ${cleanReason ? `Original n8n response: ${cleanReason} ` : ""}${hints ? `${hints} ` : ""}If Connect Google is unavailable, open "${node}"${nodeType ? ` (${nodeType})` : ""} in the locked editor only as a temporary fallback.`;
  }

  return `${provider} uses n8n's native credential account setup on "${node}". ${cleanReason ? `${cleanReason} ` : ""}${hints ? `${hints} ` : ""}Click Edit workflow, open "${node}"${nodeType ? ` (${nodeType})` : ""}, use Set up credential / select ${provider} account, save the workflow, then click Sync changes and Run check.`;
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

  if (shouldUseGoogleServiceAccountForSlot(credential, normalizedSlot)) {
    credentialType = "googleApi";
  }

  const existingCredentialMatchesType =
    Boolean(credential.n8n_credential_id) &&
    cleanString(credential.n8n_credential_type) === credentialType;

  if (
    existingCredentialMatchesType &&
    isNativeN8nCredentialSlot(normalizedSlot, credentialType) &&
    requiresNativeAccountSetup(normalizedSlot, credentialType)
  ) {
    return credential;
  }

  if (existingCredentialMatchesType && !credential.encrypted_payload) {
    return credential;
  }

  const dataCandidates = credentialDataCandidatesForN8n(credential, rawFields, credentialType, normalizedSlot);
  if (!dataCandidates.length) {
    if (existingCredentialMatchesType) return credential;
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
  const canPatchExistingCredential =
    !forceFreshCredential &&
    existingCredentialMatchesType;

  const credentialName = cleanString(explicitCredentialName || credential.n8n_credential_name || credential.label);

  for (const data of dataCandidates) {
    const payloads = n8nCredentialPayloadVariants(credentialName, credentialType, data, normalizedSlot);

    for (const payload of payloads) {
      if (canPatchExistingCredential) {
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
    if (isNativeN8nCredentialSlot(normalizedSlot, credentialType) && requiresNativeAccountSetup(normalizedSlot, credentialType)) {
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
  const googleAccountMatches = Boolean(
    isGoogleAccountSlot(slot) &&
    isGoogleAccountCredential(credential)
  );
  const slotHasSpecificProvider = Boolean(slotProviderName && !isGenericCredentialProvider(slotProviderName));
  const slotHasProviderSpecificCredentialType = Boolean(
    slotType &&
    !isGenericHttpCredentialType(slotType) &&
    slotHasSpecificProvider,
  );

  if (slotProviderName === "google_service_account" || slotType === "googleapi") {
    if (credentialProviderName !== "google_service_account" && credentialType !== "googleapi") return 0;
  }

  /*
    Several third-party APIs are represented in n8n with the same generic
    credential type, such as httpBearerAuth. Never let an Apify bearer token
    satisfy an OpenAI bearer-token slot just because the n8n type matches.
  */
  if (isGenericHttpCredentialType(slotType) && slotHasSpecificProvider) {
    if (!providerMatches && !googleAccountMatches) return 0;
    return typeMatches ? 100 : 80;
  }

  /*
    Native n8n credential-bearing nodes such as OpenAI Chat Model need their
    exact credential family inside n8n. If a Nexus key was saved earlier as a
    generic HTTP credential but the provider still matches, allow it so the
    sync step can recreate/upgrade it as the native n8n credential type.
  */
  if (slotHasProviderSpecificCredentialType) {
    if (!providerMatches && !googleAccountMatches) return 0;
    if (credentialType && credentialType !== slotType) {
      if (googleAccountMatches && credentialType === "googleapi") return 88;
      return isGenericHttpCredentialType(credentialType) ? 70 : 0;
    }
    return typeMatches ? 100 : 80;
  }

  if (googleAccountMatches && typeMatches) return 95;
  if (googleAccountMatches) return 75;
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

function credentialSourceFieldSet(slot: any) {
  return new Set(
    (Array.isArray(slot?.credential_source_fields) ? slot.credential_source_fields : [])
      .map(normalizedFieldName)
      .filter(Boolean)
  );
}

function textReferencesCredentialSource(value: unknown, fieldNames: Set<string>) {
  const text = scanText(value);
  const normalizedText = lower(text);
  if (isCredentialLikeText(text)) return true;

  for (const field of fieldNames) {
    if (!field) continue;
    if (normalizedText.includes(field)) return true;
  }

  return false;
}

function isCredentialHeaderName(value: unknown) {
  const name = normalizedFieldName(value);
  return Boolean(
    name === "authorization" ||
    name === "x_api_key" ||
    name === "api_key" ||
    name === "apikey" ||
    name === "api_token" ||
    name === "access_token" ||
    name === "token"
  );
}

function removeCredentialLikeHttpParameters(parameters: Record<string, any>, slot: any) {
  const fieldNames = credentialSourceFieldSet(slot);
  const stripCredentialQueryParametersFromUrl = (value: unknown) => {
    const raw = cleanString(value);
    if (!raw || !raw.includes("?")) return value;

    const expressionPrefix = raw.startsWith("=") ? "=" : "";
    const body = expressionPrefix ? raw.slice(1) : raw;
    const hashIndex = body.indexOf("#");
    const withoutHash = hashIndex >= 0 ? body.slice(0, hashIndex) : body;
    const hash = hashIndex >= 0 ? body.slice(hashIndex) : "";
    const queryIndex = withoutHash.indexOf("?");
    if (queryIndex < 0) return value;

    const base = withoutHash.slice(0, queryIndex);
    const query = withoutHash.slice(queryIndex + 1);
    const kept = query
      .split("&")
      .filter((part) => {
        const [rawName, ...rawValueParts] = part.split("=");
        const name = decodeURIComponent(cleanString(rawName).replace(/\+/g, " "));
        const queryValue = decodeURIComponent(rawValueParts.join("=").replace(/\+/g, " "));
        return !(isCredentialHeaderName(name) || textReferencesCredentialSource(queryValue, fieldNames));
      });

    const next = `${base}${kept.length ? `?${kept.join("&")}` : ""}${hash}`;
    return `${expressionPrefix}${next}`;
  };
  const removeCredentialRows = (rows: any) => {
    if (!Array.isArray(rows)) return rows;
    return rows.filter((row) => {
      const item = asObject(row);
      const name = item.name || item.key || item.parameterName;
      const value = item.value ?? item.fieldValue ?? item.expression;
      return !(isCredentialHeaderName(name) || textReferencesCredentialSource(value, fieldNames));
    });
  };
  const removeCredentialStringHeaders = (value: string) => {
    const raw = cleanString(value);
    if (!raw) return raw;

    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return JSON.stringify(removeCredentialRows(parsed), null, 2);
      }

      if (parsed && typeof parsed === "object") {
        const cleanHeaders: Record<string, any> = {};
        for (const [key, headerValue] of Object.entries(asObject(parsed))) {
          if (isCredentialHeaderName(key) || textReferencesCredentialSource(headerValue, fieldNames)) continue;
          cleanHeaders[key] = headerValue;
        }
        return JSON.stringify(cleanHeaders, null, 2);
      }
    } catch {
      // Plain string headers are handled line-by-line below.
    }

    return raw
      .split(/\r?\n/)
      .filter((line) => {
        const [headerName] = line.split(":");
        return !(isCredentialHeaderName(headerName) || textReferencesCredentialSource(line, fieldNames));
      })
      .join("\n");
  };

  const next = { ...parameters };
  const headerParameters = asObject(next.headerParameters);
  if (Array.isArray(headerParameters.parameters)) {
    next.headerParameters = {
      ...headerParameters,
      parameters: removeCredentialRows(headerParameters.parameters),
    };
  }

  const queryParameters = asObject(next.queryParameters);
  if (Array.isArray(queryParameters.parameters)) {
    next.queryParameters = {
      ...queryParameters,
      parameters: removeCredentialRows(queryParameters.parameters),
    };
  }

  if (Array.isArray(next.headers)) {
    next.headers = removeCredentialRows(next.headers);
  }

  if (typeof next.headers === "string" && textReferencesCredentialSource(next.headers, fieldNames)) {
    next.headers = removeCredentialStringHeaders(next.headers);
  }

  for (const urlKey of ["url", "endpoint", "webhookUrl"]) {
    if (typeof next[urlKey] === "string") {
      next[urlKey] = stripCredentialQueryParametersFromUrl(next[urlKey]);
    }
  }

  return next;
}

function scrubCredentialCarrierAssignments(parameters: any, slot: any) {
  const fieldNames = credentialSourceFieldSet(slot);
  if (!fieldNames.size) return parameters;

  const scrub = (value: any): any => {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(scrub);

    const object = { ...asObject(value) };
    const name = normalizedFieldName(
      object.name ||
      object.key ||
      object.field ||
      object.fieldName ||
      object.parameterName,
    );

    if (name && fieldNames.has(name)) {
      for (const key of ["value", "fieldValue", "stringValue", "defaultValue", "expression", "content"]) {
        if (Object.prototype.hasOwnProperty.call(object, key)) {
          object[key] = "";
        }
      }
    }

    for (const [key, child] of Object.entries(object)) {
      if (child && typeof child === "object") {
        object[key] = scrub(child);
      }
    }

    return object;
  };

  return scrub(parameters);
}

function applyCredentialToWorkflow(workflowInput: any, slot: any, credential: any) {
  const normalizedSlot = coerceNativeCredentialSlot(slot);
  const workflow = normalizeWorkflowObject(workflowInput);
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const n8nCredentialId = cleanString(credential.n8n_credential_id || normalizedSlot.current_id);
  const n8nCredentialName = cleanString(credential.n8n_credential_name || credential.label || normalizedSlot.current_name);
  const credentialKey = cleanString(
    normalizedSlot.credential_key ||
    normalizedSlot.n8n_credential_type ||
    credential.n8n_credential_type
  );
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

  const sourceNodes = new Set(
    (Array.isArray(normalizedSlot.credential_source_nodes) ? normalizedSlot.credential_source_nodes : [])
      .map(cleanString)
      .filter(Boolean)
  );

  workflow.nodes = nodes.map((node: any) => {
    if (sourceNodes.has(cleanString(node?.name))) {
      return {
        ...node,
        parameters: scrubCredentialCarrierAssignments(node.parameters, normalizedSlot),
      };
    }

    if (cleanString(node?.name) !== cleanString(normalizedSlot.node_name)) return node;

    let parameters = {
      ...asObject(node.parameters),
    };

    if (isHttpRequestNode && isGenericHttpCredential) {
      if (normalizedSlot.inferred_from_parameter_reference || normalizedSlot.credential_source_fields?.length) {
        parameters = removeCredentialLikeHttpParameters(parameters, normalizedSlot);
      }

      parameters.authentication = "genericCredentialType";
      parameters.genericAuthType = credentialKey;
    }

    if (!isHttpRequestNode && lower(`${normalizedSlot.provider || ""} ${credentialKey}`).includes("google")) {
      if (lower(credentialKey) === "googleapi") {
        parameters.authentication = "serviceAccount";
      } else if (lower(credentialKey).includes("oauth2") && !cleanString(parameters.authentication)) {
        parameters.authentication = "oAuth2";
      }
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

function workflowNodeHasCredential(workflowInput: any, slot: any, credentialKey: string, credentialId = "") {
  const normalizedSlot = coerceNativeCredentialSlot(slot);
  const workflow = normalizeWorkflowObject(workflowInput);
  const nodes = Array.isArray(workflow.nodes) ? workflow.nodes : [];
  const node = nodes.find((item: any) => cleanString(item?.name) === cleanString(normalizedSlot.node_name));
  const credentials = asObject(node?.credentials);
  const credentialRef = asObject(credentials[credentialKey]);

  if (!node || !credentialKey || !credentialRef.id) return false;
  if (credentialId && cleanString(credentialRef.id) !== cleanString(credentialId)) return false;
  return true;
}

function removeCredentialReferencesForErrors(workflowInput: any, errors: any[] = []) {
  if (!errors.length) return workflowInput;

  const workflow = normalizeWorkflowObject(workflowInput);
  const missingByNode = new Map<string, Set<string>>();

  for (const error of errors || []) {
    const nodeName = cleanString(error?.node_name);
    const credentialKey = cleanString(error?.credential_key || error?.n8n_credential_type);
    if (!nodeName || !credentialKey) continue;

    if (!missingByNode.has(nodeName)) {
      missingByNode.set(nodeName, new Set());
    }
    missingByNode.get(nodeName)?.add(credentialKey);
  }

  if (!missingByNode.size) return workflow;

  workflow.nodes = (Array.isArray(workflow.nodes) ? workflow.nodes : []).map((node: any) => {
    const keys = missingByNode.get(cleanString(node?.name));
    if (!keys?.size || !node?.credentials || typeof node.credentials !== "object") {
      return node;
    }

    const nextCredentials = { ...node.credentials };
    for (const key of keys) {
      delete nextCredentials[key];
    }

    if (Object.keys(nextCredentials).length) {
      return {
        ...node,
        credentials: nextCredentials,
      };
    }

    const { credentials: _removedCredentials, ...withoutCredentials } = node;
    return withoutCredentials;
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
  const source = normalizeWorkflowResourceLocators(workflow);

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

function normalizeN8nCredentialSummary(item: any) {
  const value = item?.data && typeof item.data === "object" ? item.data : item;

  return {
    id: cleanString(value?.id || value?.credentialId || value?.credential_id),
    name: cleanString(value?.name || value?.credentialName || value?.credential_name),
    type: cleanString(value?.type || value?.credentialType || value?.credential_type),
  };
}

function n8nCredentialSummaryRows(payload: any) {
  const rows = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.credentials)
        ? payload.credentials
        : [];

  return rows
    .map(normalizeN8nCredentialSummary)
    .filter((row) => row.id || row.name);
}

async function listN8nCredentialSummaries(n8nBaseUrl: string, n8nApiKey: string) {
  const payload = await n8nRequest(
    n8nBaseUrl,
    n8nApiKey,
    "/api/v1/credentials",
    { method: "GET" },
    { api_area: "credential" },
  );

  return n8nCredentialSummaryRows(payload);
}

function n8nCredentialTypeMatches(summary: any, credentialType: string) {
  const summaryType = cleanString(summary?.type);
  const wantedType = cleanString(credentialType);
  return !summaryType || !wantedType || summaryType === wantedType;
}

function findLiveN8nCredentialSummary(
  summaries: any[],
  credentialType: string,
  credentialId = "",
  credentialName = "",
) {
  const id = cleanString(credentialId);
  const name = cleanString(credentialName);

  if (id) {
    const byId = summaries.find((summary) => (
      cleanString(summary?.id) === id &&
      n8nCredentialTypeMatches(summary, credentialType)
    ));
    if (byId) return byId;
  }

  if (name) {
    const byName = summaries.find((summary) => (
      cleanString(summary?.name) === name &&
      n8nCredentialTypeMatches(summary, credentialType)
    ));
    if (byName) return byName;
  }

  return null;
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
  allowExistingNativeN8nCredentials?: boolean;
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
    allowExistingNativeN8nCredentials = false,
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
  let preserveHostedWorkflowForNativeCredentials = false;
  const reusableNativeCredentials = new Map<string, any>();
  const nativeReuseKey = (slot: any) => [
    slotProvider(slot) || slot?.provider || slot?.provider_label || "provider",
    slot?.n8n_credential_type || slot?.credential_key || "credential",
  ].map(cleanString).join(":");
  let liveN8nCredentialSummaries: any[] | null = null;
  let liveN8nCredentialLookupFailed = false;
  const getLiveN8nCredentialSummaries = async () => {
    if (liveN8nCredentialSummaries) return liveN8nCredentialSummaries;

    try {
      liveN8nCredentialSummaries = await listN8nCredentialSummaries(n8nBaseUrl, n8nApiKey);
    } catch (error) {
      liveN8nCredentialLookupFailed = true;
      console.warn("Could not list n8n credentials:", error instanceof Error ? error.message : error);
      liveN8nCredentialSummaries = [];
    }

    return liveN8nCredentialSummaries;
  };

  /*
    Native account credentials can be selected in n8n itself. Before binding,
    pre-resolve the live n8n credential IDs that actually exist so duplicate
    Gmail/Google/etc nodes can reuse the working account instead of preserving
    an old credential ID on one node.
  */
  if (allowExistingNativeN8nCredentials) {
    const summaries = await getLiveN8nCredentialSummaries();

    if (!liveN8nCredentialLookupFailed) {
      for (const slot of slots) {
        const credentialType = cleanString(slot.n8n_credential_type || slot.credential_key);
        if (!isNativeN8nCredentialSlot(slot, credentialType)) continue;

        const liveCredential = findLiveN8nCredentialSummary(
          summaries,
          credentialType,
          cleanString(slot.current_id),
          cleanString(slot.current_name),
        );

        if (!liveCredential) continue;

        const liveId = cleanString(liveCredential.id || slot.current_id);
        if (!liveId) continue;

        reusableNativeCredentials.set(nativeReuseKey(slot), {
          id: "",
          label: cleanString(liveCredential.name || slot.current_name || slot.provider_label || "n8n account credential"),
          provider: slot.provider,
          provider_label: slot.provider_label,
          n8n_credential_type: cleanString(liveCredential.type || credentialType),
          n8n_credential_id: liveId,
          n8n_credential_name: cleanString(liveCredential.name || slot.current_name || "n8n account credential"),
          manual_n8n_credential: true,
        });
      }
    }
  }

  for (const slot of slots) {
    let credential = bestCredentialForSlot(credentials, slot, previousBindings);
    const usesNexusProxy = Boolean(slot.uses_nexus_proxy);
    const existingNativeCredentialId = cleanString(slot.current_id);
    const existingNativeCredentialName = cleanString(slot.current_name);
    const nativeN8nSlot = isNativeN8nCredentialSlot(slot, slot.n8n_credential_type || slot.credential_key);
    const reusableNativeCredential = nativeN8nSlot
      ? reusableNativeCredentials.get(nativeReuseKey(slot))
      : null;
    const canUseExistingNativeCredential = Boolean(
      allowExistingNativeN8nCredentials &&
      nativeN8nSlot &&
      (existingNativeCredentialId || existingNativeCredentialName),
    );

    /*
      Native account credentials such as Gmail OAuth can be selected directly in
      the locked n8n editor. When the live workflow already has one attached,
      that live reference must win over any older Nexus binding; otherwise Nexus
      can accidentally PUT the workflow back with a stale credential ID.
    */
    if (
      canUseExistingNativeCredential &&
      reusableNativeCredential?.n8n_credential_id &&
      cleanString(reusableNativeCredential.n8n_credential_id) !== existingNativeCredentialId
    ) {
      credential = reusableNativeCredential;
    } else if (canUseExistingNativeCredential && existingNativeCredentialId) {
      /*
        Important: do not keep the saved Nexus credential row as the active
        object here, even if the IDs match. Native OAuth credentials are owned
        by n8n once the user selects them in the editor. Treat the live workflow
        reference as manual so the sync path never recreates or swaps it with a
        stale Nexus DB credential.
      */
      credential = {
        id: "",
        label: existingNativeCredentialName || slot.provider_label || "n8n account credential",
        provider: slot.provider,
        provider_label: slot.provider_label,
        n8n_credential_type: slot.n8n_credential_type || slot.credential_key,
        n8n_credential_id: existingNativeCredentialId,
        n8n_credential_name: existingNativeCredentialName || "n8n account credential",
        manual_n8n_credential: true,
      };
      reusableNativeCredentials.set(nativeReuseKey(slot), credential);
    } else if (canUseExistingNativeCredential && (!credential || !credential.n8n_credential_id)) {
      credential = {
        id: "",
        label: existingNativeCredentialName || slot.provider_label || "n8n account credential",
        provider: slot.provider,
        provider_label: slot.provider_label,
        n8n_credential_type: slot.n8n_credential_type || slot.credential_key,
        n8n_credential_id: existingNativeCredentialId || null,
        n8n_credential_name: existingNativeCredentialName || "n8n account credential",
        manual_n8n_credential: true,
      };
      reusableNativeCredentials.set(nativeReuseKey(slot), credential);
    }

    if (nativeN8nSlot && !credential?.n8n_credential_id) {
      const reusableCredential = reusableNativeCredentials.get(nativeReuseKey(slot));
      if (reusableCredential?.n8n_credential_id) {
        credential = reusableCredential;
      }
    }

    if (
      nativeN8nSlot &&
      allowExistingNativeN8nCredentials &&
      credential?.n8n_credential_id &&
      !credential.manual_n8n_credential &&
      !existingNativeCredentialId &&
      !reusableNativeCredentials.get(nativeReuseKey(slot))?.n8n_credential_id
    ) {
      /*
        A stored Nexus credential ID for Gmail/Google OAuth/etc can be stale
        after credentials are recreated inside n8n. If the live workflow does
        not currently point to that credential, do not push it back into n8n.
      */
      credential = null;
    }

    if (credential && syncMissingN8nCredentials && !usesNexusProxy && !credential.manual_n8n_credential) {
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

    if (
      credential?.n8n_credential_id &&
      nativeN8nSlot &&
      allowExistingNativeN8nCredentials &&
      requiresNativeAccountSetup(slot, slot.n8n_credential_type || slot.credential_key)
    ) {
      const credentialType = cleanString(slot.n8n_credential_type || slot.credential_key || credential.n8n_credential_type);
      const credentialId = cleanString(credential.n8n_credential_id);
      const credentialName = cleanString(credential.n8n_credential_name || credential.label || existingNativeCredentialName);
      const summaries = await getLiveN8nCredentialSummaries();
      const liveCredential = findLiveN8nCredentialSummary(summaries, credentialType, credentialId, credentialName);

      if (liveCredential) {
        const liveId = cleanString(liveCredential.id) || credentialId;
        const liveName = cleanString(liveCredential.name) || credentialName;
        const liveType = cleanString(liveCredential.type) || credentialType;
        credential = {
          ...credential,
          n8n_credential_id: liveId,
          n8n_credential_name: liveName,
          n8n_credential_type: liveType,
        };
        if (cleanString(credential.id) && liveId && liveId !== credentialId) {
          try {
            await adminClient
              .from("developer_credentials")
              .update({
                n8n_credential_id: liveId,
                n8n_credential_name: liveName,
                n8n_credential_type: liveType,
                status: "active",
                last_error: null,
                updated_at: new Date().toISOString(),
              })
              .eq("id", credential.id);
          } catch (error) {
            console.warn("Could not persist resolved n8n credential id:", error instanceof Error ? error.message : error);
          }
        }
        reusableNativeCredentials.set(nativeReuseKey(slot), credential);
      } else {
        // OAuth/native n8n credentials can be created through the embedded editor and
        // already be attached to the workflow even when the credential summary list
        // does not expose a matching row. Preserve the workflow reference and let
        // the real technical run be the source of truth.
        reusableNativeCredentials.set(nativeReuseKey(slot), credential);
      }
    }

    if (credential && usesNexusProxy) {
      bindings.push({
        node_name: slot.node_name,
        node_type: slot.node_type,
        provider: slot.provider || credential.provider || null,
        provider_label: slot.provider_label || credential.provider_label || null,
        credential_key: slot.credential_key,
        n8n_credential_type: slot.n8n_credential_type || slot.credential_key || credential.n8n_credential_type,
        n8n_credential_id: null,
        n8n_credential_name: credential.label,
        developer_credential_id: credential.id,
        uses_nexus_proxy: true,
        allowed_host: slot.allowed_host || null,
      });
      continue;
    }

    if (credential?.n8n_credential_id) {
      const appliedCredentialKey = cleanString(slot.credential_key || slot.n8n_credential_type || credential.n8n_credential_type);
      boundWorkflow = applyCredentialToWorkflow(boundWorkflow, slot, credential);

      if (!workflowNodeHasCredential(boundWorkflow, slot, appliedCredentialKey, credential.n8n_credential_id)) {
        errors.push({
          node_name: slot.node_name,
          node_type: slot.node_type,
          credential_key: slot.credential_key,
          n8n_credential_type: slot.n8n_credential_type,
          provider: slot.provider,
          provider_label: slot.provider_label,
          message: `Nexus prepared ${slot.provider_label || slot.provider || appliedCredentialKey || "the"} credential, but could not attach it to "${slot.node_name}" as ${appliedCredentialKey || "the required n8n credential type"}. Re-sync credentials, then run the technical check again.`,
        });
        continue;
      }

      if (nativeN8nSlot) {
        reusableNativeCredentials.set(nativeReuseKey(slot), credential);
      }
      bindings.push({
        node_name: slot.node_name,
        node_type: slot.node_type,
        provider: slot.provider || credential.provider || null,
        provider_label: slot.provider_label || credential.provider_label || null,
        credential_key: slot.credential_key,
        n8n_credential_type: slot.n8n_credential_type || slot.credential_key || credential.n8n_credential_type,
        n8n_credential_id: credential.n8n_credential_id,
        n8n_credential_name: credential.n8n_credential_name || credential.label,
        developer_credential_id: credential.id,
        manual_n8n_credential: Boolean(credential.manual_n8n_credential),
      });
      continue;
    }

    const importedCredential = cleanString(slot.current_id || slot.current_name);
    const importedCredentialNote = importedCredential
      ? ` The uploaded workflow references n8n credential "${importedCredential}", but Nexus cannot use imported credential IDs until the key is saved and synced from the Nexus credential manager.`
      : "";

    const nodeSummaryText = slot.summary?.title || slot.summary?.url || "";
    const slotCredentialType = slot.n8n_credential_type || slot.credential_key;
    if (
      allowExistingNativeN8nCredentials &&
      isNativeN8nCredentialSlot(slot, slotCredentialType) &&
      requiresNativeAccountSetup(slot, slotCredentialType)
    ) {
      /*
        n8n's public workflow API can hide native OAuth account credentials
        (Gmail, Google OAuth, etc.) even when the account is selected and works
        in the editor. If Nexus treats that hidden value as "missing", it can
        PUT the credential-less workflow back to n8n and break a manually fixed
        workflow. Preserve the hosted workflow and let the real technical run be
        the approval gate.
      */
      preserveHostedWorkflowForNativeCredentials = true;
      bindings.push({
        node_name: slot.node_name,
        node_type: slot.node_type,
        provider: slot.provider || null,
        provider_label: slot.provider_label || null,
        credential_key: slot.credential_key,
        n8n_credential_type: slot.n8n_credential_type || slot.credential_key,
        n8n_credential_id: null,
        n8n_credential_name: existingNativeCredentialName || "Native n8n account credential",
        developer_credential_id: null,
        manual_n8n_credential: true,
        native_credential_hidden_by_n8n_api: true,
      });
      continue;
    }

    const missingMessage = isNativeN8nCredentialSlot(slot, slotCredentialType) && requiresNativeAccountSetup(slot, slotCredentialType)
      ? nativeCredentialManualSetupMessage(slot, slot.n8n_credential_type || slot.credential_key, null)
      : `Next: add a ${slot.provider_label || slot.provider || "developer"} credential for ${slot.node_name} (${slot.n8n_credential_type || slot.credential_key || "n8n credential"})${nodeSummaryText ? ` using ${nodeSummaryText}` : ""}, then press Apply credentials & run check.${importedCredentialNote}`;

    errors.push({
      node_name: slot.node_name,
      node_type: slot.node_type,
      credential_key: slot.credential_key,
      n8n_credential_type: slot.n8n_credential_type,
      provider: slot.provider,
      provider_label: slot.provider_label,
      imported_n8n_credential_id: slot.current_id || null,
      imported_n8n_credential_name: slot.current_name || null,
      message: missingMessage,
    });
  }

  const rows = requirementRows(product, slots, bindings, errors);
  await persistCredentialRequirements(adminClient, product, rows);

  const status = errors.length ? "needs_credentials" : "bound";
  if (errors.length) {
    boundWorkflow = removeCredentialReferencesForErrors(boundWorkflow, errors);
  }

  let hostedUpdate: any = null;
  let hostedUpdateError = "";

  if (
    updateHostedWorkflow &&
    cleanString(product?.n8n_workflow_id) &&
    !preserveHostedWorkflowForNativeCredentials
  ) {
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

  if (preserveHostedWorkflowForNativeCredentials) {
    automationPatch.n8n_last_import_result = {
      ...(product.n8n_last_import_result || {}),
      native_oauth_credentials_preserved_in_hosted_n8n: true,
      native_oauth_preserved_at: new Date().toISOString(),
      message: "Nexus preserved the hosted n8n workflow because native OAuth credentials may be hidden by the n8n API.",
    };
  }

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
