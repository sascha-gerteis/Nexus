import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

type OperatorContext = {
  profile: any;
  developer: any | null;
};

function nowIso() {
  return new Date().toISOString();
}

function cleanString(value: unknown) {
  return String(value ?? "").trim();
}

function lower(value: unknown) {
  return cleanString(value).toLowerCase();
}

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

function safeJson(value: unknown, fallback: any) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string") return value;

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeModuleKey(value: unknown) {
  return cleanString(value || "unknown")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9:_./-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 180) || "unknown";
}

function normalizeName(value: unknown, fallback = "value") {
  return cleanString(value || fallback)
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || fallback;
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
  const key = stripDerivedSetupSuffix(normalizeName(value, ""));
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

function inferFieldLabel(name: string) {
  return cleanString(name)
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase())
    .trim() || "Field";
}

function inferSetupFieldType(name: string) {
  const key = lower(name);
  if (key.includes("email")) return "email";
  if (key.includes("website") || key.includes("url") || key.includes("link")) return "url";
  if (key.includes("competitor") || key.includes("areas") || key.includes("notes") || key.includes("requirements")) return "textarea";
  return "text";
}

function makeSetupField(name: string, description = "Auto-generated from the uploaded workflow source.") {
  const key = normalizeName(name, "");
  return {
    name: key,
    label: inferFieldLabel(key),
    type: inferSetupFieldType(key),
    required: true,
    placeholder: "",
    description,
    options: [],
  };
}

function displayLabel(value: unknown) {
  return cleanString(value)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitModule(rawModule: string) {
  const raw = cleanString(rawModule);
  const [app = "", ...rest] = raw.split(":");
  const action = rest.join(":");
  return {
    source_app: app || raw,
    source_action: action,
    source_module: raw,
    source_module_key: normalizeModuleKey(raw),
  };
}

const MAKE_COMMON_EXTERNAL_APPS = [
  "airtable",
  "asana",
  "activecampaign",
  "apollo",
  "apify",
  "aws",
  "brevo",
  "calendly",
  "clickup",
  "discord",
  "dropbox",
  "facebook",
  "facebook-ads",
  "facebook-pages",
  "figma",
  "freshdesk",
  "github",
  "gitlab",
  "gmail",
  "google-analytics",
  "google-calendar",
  "google-docs",
  "google-drive",
  "google-forms",
  "google-sheets",
  "google-slides",
  "google-tasks",
  "hubspot",
  "instagram",
  "intercom",
  "jira",
  "klaviyo",
  "linear",
  "linkedin",
  "mailchimp",
  "mailgun",
  "microsoft-365",
  "microsoft-excel",
  "microsoft-outlook",
  "microsoft-teams",
  "monday",
  "mongodb",
  "mysql",
  "notion",
  "openai",
  "openai-gpt-3",
  "pipedrive",
  "postgres",
  "quickbooks",
  "reddit",
  "salesforce",
  "sendgrid",
  "shopify",
  "slack",
  "stripe",
  "supabase",
  "telegram",
  "trello",
  "twilio",
  "typeform",
  "webflow",
  "woocommerce",
  "wordpress",
  "x",
  "xero",
  "youtube",
  "zendesk",
  "zoho-crm",
  "acuity-scheduling",
  "adobe-acrobat",
  "adobe-commerce",
  "adobe-creative-cloud",
  "ahrefs",
  "aircall",
  "airtable-webhooks",
  "amazon-s3",
  "amplitude",
  "azure-devops",
  "basecamp",
  "bigcommerce",
  "bitbucket",
  "box",
  "buffer",
  "campaign-monitor",
  "canva",
  "capsule-crm",
  "chargebee",
  "clearbit",
  "close",
  "convertkit",
  "copper",
  "datadog",
  "docusign",
  "elastic-email",
  "email",
  "eventbrite",
  "facebook-conversions",
  "facebook-lead-ads",
  "firebase",
  "ftp",
  "google-ads",
  "google-cloud-storage",
  "google-search-console",
  "google-workspace",
  "harvest",
  "helpscout",
  "highlevel",
  "hunter",
  "keap",
  "lemlist",
  "mailerlite",
  "manychat",
  "mattermost",
  "medium",
  "mixpanel",
  "ms-sql-server",
  "openrouter",
  "outlook",
  "paypal",
  "pdf",
  "pinterest",
  "plivo",
  "productboard",
  "rss",
  "semrush",
  "sharepoint",
  "snowflake",
  "square",
  "todoist",
  "tiktok",
  "tiktok-ads",
  "twitter",
  "webhooks",
  "whatsapp-business",
  "wise",
  "yahoo-mail",
  "zoom",
  "adobe-analytics",
  "adobe-sign",
  "algolia",
  "anthropic",
  "azure-blob-storage",
  "bamboohr",
  "beehiiv",
  "braze",
  "cloudflare",
  "coda",
  "confluence",
  "constant-contact",
  "customer-io",
  "deel",
  "discord-bot",
  "dynamics-365-crm",
  "eversign",
  "firebase-cloud-messaging",
  "front",
  "google-bigquery",
  "google-chat",
  "google-cloud-firestore",
  "google-cloud-functions",
  "google-cloud-pubsub",
  "google-maps",
  "google-meet",
  "google-my-business",
  "gorgias",
  "graphql",
  "http",
  "instagram-for-business",
  "mailjet",
  "microsoft-azure",
  "microsoft-dynamics",
  "microsoft-onedrive",
  "microsoft-sharepoint",
  "mistral-ai",
  "netsuite",
  "openweather",
  "oracle",
  "pandadoc",
  "pdf-co",
  "phantombuster",
  "pipedream",
  "plaid",
  "power-bi",
  "qualtrics",
  "redis",
  "ringcentral",
  "rocket-chat",
  "sage",
  "segment",
  "servicenow",
  "shipstation",
  "smartsheet",
  "stripe-connect",
  "surveymonkey",
  "tally",
  "tavily",
  "teamwork",
  "text-parser",
  "toggl",
  "vercel",
  "vimeo",
  "whatsapp",
  "workday",
  "yelp",
  "accelo",
  "adalo",
  "adroll",
  "aftership",
  "aircall-v2",
  "amazon-seller-central",
  "appsheet",
  "attio",
  "bigin-by-zoho-crm",
  "callrail",
  "cargo",
  "chartmogul",
  "cognito-forms",
  "contentful",
  "databox",
  "delighted",
  "demio",
  "drip",
  "easyship",
  "e-goi",
  "facebook-groups",
  "freshbooks",
  "freshsales-suite",
  "getresponse",
  "gitbook",
  "google-gemini",
  "google-vertex-ai",
  "gpt-zero",
  "hacker-news",
  "hellosign",
  "hive",
  "html-css-to-image",
  "intercom-v2",
  "involve-me",
  "jotform",
  "kajabi",
  "kintone",
  "launchdarkly",
  "linkedin-ads",
  "mailersend",
  "mandrill",
  "microsoft-power-bi",
  "microsoft-powerpoint",
  "microsoft-to-do",
  "microsoft-word",
  "miro",
  "mixmax",
  "moosend",
  "neon",
  "openai-assistants",
  "pagerduty",
  "paperform",
  "parsehub",
  "pipedrive-v2",
  "podio",
  "postmark",
  "profitwell",
  "recurly",
  "reply",
  "scrapingbee",
  "sendinblue",
  "shortcut",
  "simpletexting",
  "streak",
  "synthesia",
  "tableau",
  "teachable",
  "thinkific",
  "tinyemail",
  "transistor",
  "trustpilot",
  "unbounce",
  "userback",
  "userpilot",
  "vk",
  "wave",
  "webinarjam",
  "wistia",
  "youcanbookme",
  "zapier",
];

const MAKE_COMMON_EXTERNAL_ACTIONS = [
  "watch-records",
  "search-records",
  "list-records",
  "get-record",
  "create-record",
  "update-record",
  "delete-record",
  "upsert-record",
  "create-row",
  "add-row",
  "update-row",
  "delete-row",
  "get-row",
  "search-rows",
  "create-item",
  "update-item",
  "delete-item",
  "get-item",
  "list-items",
  "create-message",
  "send-message",
  "post-message",
  "create-email",
  "send-email",
  "upload-file",
  "download-file",
  "make-an-api-call",
  "custom-api-call",
  "create-task",
  "update-task",
  "create-contact",
  "update-contact",
  "create-lead",
  "update-lead",
  "create-deal",
  "update-deal",
  "watch-events",
  "watch-new-events",
  "watch-messages",
  "watch-emails",
  "watch-files",
  "watch-orders",
  "watch-payments",
  "watch-invoices",
  "watch-leads",
  "watch-deals",
  "watch-tasks",
  "watch-users",
  "watch-subscribers",
  "list-users",
  "list-contacts",
  "list-deals",
  "list-orders",
  "list-products",
  "list-files",
  "list-messages",
  "list-events",
  "get-user",
  "get-contact",
  "get-customer",
  "get-order",
  "get-product",
  "get-file",
  "get-message",
  "create-user",
  "update-user",
  "create-customer",
  "update-customer",
  "create-order",
  "update-order",
  "create-product",
  "update-product",
  "create-invoice",
  "update-invoice",
  "create-payment",
  "create-event",
  "update-event",
  "create-folder",
  "copy-file",
  "move-file",
  "send-sms",
  "send-notification",
  "post-comment",
  "create-comment",
  "add-tag",
  "remove-tag",
  "add-subscriber",
  "update-subscriber",
  "create-campaign",
  "send-campaign",
  "create-ticket",
  "update-ticket",
  "create-issue",
  "update-issue",
  "run-query",
  "execute-query",
  "insert-row",
  "update-rows",
  "delete-rows",
  "call-api",
  "api-call",
  "make-a-request",
  "send-request",
  "get-request",
  "post-request",
  "put-request",
  "patch-request",
  "delete-request",
  "create-webhook",
  "delete-webhook",
  "watch-new-records",
  "watch-updated-records",
  "watch-new-rows",
  "watch-updated-rows",
  "watch-new-items",
  "watch-updated-items",
  "watch-new-files",
  "watch-updated-files",
  "watch-new-orders",
  "watch-updated-orders",
  "watch-new-customers",
  "watch-updated-customers",
  "watch-new-subscribers",
  "watch-updated-subscribers",
  "search-items",
  "search-users",
  "search-contacts",
  "search-customers",
  "search-orders",
  "search-products",
  "search-files",
  "retrieve-record",
  "retrieve-row",
  "retrieve-item",
  "retrieve-user",
  "retrieve-customer",
  "retrieve-order",
  "find-record",
  "find-row",
  "find-item",
  "find-user",
  "find-contact",
  "find-customer",
  "find-order",
  "find-product",
  "find-file",
  "create-note",
  "update-note",
  "create-project",
  "update-project",
  "create-page",
  "update-page",
  "create-document",
  "update-document",
  "create-meeting",
  "update-meeting",
  "create-channel",
  "update-channel",
  "create-list",
  "update-list",
  "create-card",
  "update-card",
  "create-comment",
  "update-comment",
  "create-subscriber",
  "unsubscribe-subscriber",
  "create-conversation",
  "reply-conversation",
  "create-thread",
  "reply-thread",
  "send-channel-message",
  "send-direct-message",
  "create-chat-completion",
  "generate-text",
  "generate-image",
  "classify-text",
  "extract-data",
  "summarize-text",
  "translate-text",
  "parse-document",
  "create-lead-event",
  "create-conversion-event",
  "track-event",
  "track-page-view",
  "create-report",
  "get-report",
  "export-report",
  "sync-record",
  "bulk-create",
  "bulk-update",
  "bulk-delete",
  "raw-request",
  "http-request",
  "rest-api-call",
  "graphql-query",
  "graphql-mutation",
  "create-database-item",
  "update-database-item",
  "query-database",
  "append-block",
  "create-spreadsheet-row",
  "update-spreadsheet-row",
  "lookup-spreadsheet-row",
  "create-calendar-event",
  "update-calendar-event",
  "create-board",
  "update-board",
  "create-work-item",
  "update-work-item",
  "create-opportunity",
  "update-opportunity",
  "create-company",
  "update-company",
  "create-organization",
  "update-organization",
  "create-person",
  "update-person",
  "create-page-post",
  "create-social-post",
  "publish-post",
  "schedule-post",
  "create-file",
  "update-file",
  "create-object",
  "update-object",
  "delete-object",
  "create-entry",
  "update-entry",
  "delete-entry",
  "create-row-in-table",
  "update-row-in-table",
  "create-form",
  "get-form-response",
  "send-transactional-email",
  "send-template-email",
  "create-template",
  "render-template",
  "create-draft",
  "send-draft",
  "create-booking",
  "update-booking",
  "cancel-booking",
  "create-shipment",
  "update-shipment",
  "track-shipment",
  "create-refund",
  "create-charge",
  "create-subscription",
  "update-subscription",
  "create-payment-link",
  "create-session",
  "create-vector",
  "embed-text",
  "moderate-text",
  "answer-question",
  "create-embedding",
  "transcribe-audio",
  "extract-text-from-file",
  "scrape-url",
  "crawl-url",
  "parse-rss-feed",
  "send-whatsapp-message",
  "send-telegram-message",
  "send-slack-message",
  "send-teams-message",
  "create-zendesk-ticket",
  "update-zendesk-ticket",
  "create-hubspot-contact",
  "update-hubspot-contact",
  "create-salesforce-record",
  "update-salesforce-record",
];

const ZAPIER_CORE_APP_MAPPINGS = [
  "code by zapier",
  "delay by zapier",
  "filter by zapier",
  "formatter by zapier",
  "looping by zapier",
  "paths by zapier",
  "schedule by zapier",
  "storage by zapier",
  "webhooks by zapier",
  "zapier tables",
];

const ZAPIER_COMMON_EXTERNAL_APPS = [
  "activecampaign",
  "airtable",
  "asana",
  "calendly",
  "clickup",
  "discord",
  "dropbox",
  "facebook lead ads",
  "facebook pages",
  "github",
  "gmail",
  "google analytics",
  "google calendar",
  "google docs",
  "google drive",
  "google forms",
  "google sheets",
  "google slides",
  "hubspot",
  "instagram for business",
  "intercom",
  "jira software cloud",
  "klaviyo",
  "linear",
  "linkedin ads",
  "mailchimp",
  "microsoft excel",
  "microsoft outlook",
  "microsoft teams",
  "monday.com",
  "notion",
  "openai",
  "pipedrive",
  "quickbooks online",
  "salesforce",
  "sendgrid",
  "shopify",
  "slack",
  "stripe",
  "trello",
  "twilio",
  "typeform",
  "webflow",
  "woocommerce",
  "wordpress",
  "xero",
  "youtube",
  "zendesk",
  "zoho crm",
  "acuity scheduling",
  "adobe acrobat",
  "ahrefs",
  "aircall",
  "amazon s3",
  "amplitude",
  "azure devops",
  "basecamp 3",
  "bigcommerce",
  "bitbucket",
  "box",
  "buffer",
  "campaign monitor",
  "canva",
  "capsule crm",
  "chargebee",
  "clearbit",
  "close",
  "convertkit",
  "copper",
  "datadog",
  "docusign",
  "eventbrite",
  "facebook conversions",
  "firebase",
  "freshdesk",
  "freshsales",
  "google ads",
  "google cloud storage",
  "google search console",
  "harvest",
  "help scout",
  "highlevel",
  "hunter",
  "keap",
  "lemlist",
  "mailerlite",
  "manychat",
  "mattermost",
  "microsoft office 365",
  "mixpanel",
  "mysql",
  "openrouter",
  "paypal",
  "pinterest",
  "postgresql",
  "rss by zapier",
  "semrush",
  "sharepoint",
  "snowflake",
  "square",
  "todoist",
  "tiktok lead generation",
  "twitter",
  "webflow forms",
  "whatsapp notifications",
  "wise",
  "zoom",
  "adobe analytics",
  "adobe sign",
  "algolia",
  "anthropic",
  "azure blob storage",
  "bamboohr",
  "beehiiv",
  "braze",
  "cloudflare",
  "coda",
  "confluence cloud",
  "constant contact",
  "customer.io",
  "deel",
  "discord bot",
  "dynamics 365 crm",
  "eversign",
  "facebook lead ads for business admins",
  "firebase cloud messaging",
  "front",
  "google bigquery",
  "google chat",
  "google cloud firestore",
  "google cloud functions",
  "google cloud pubsub",
  "google maps",
  "google meet",
  "google my business",
  "gorgias",
  "graphql",
  "instagram",
  "mailgun",
  "mailjet",
  "microsoft azure",
  "microsoft dynamics 365 crm",
  "microsoft onedrive",
  "microsoft sharepoint",
  "mistral ai",
  "netsuite",
  "openweather",
  "oracle database",
  "pandadoc",
  "pdf.co",
  "phantombuster",
  "pipedream",
  "plaid",
  "power bi",
  "qualtrics",
  "reddit",
  "redis",
  "ringcentral",
  "rocket.chat",
  "sage accounting",
  "segment",
  "servicenow",
  "shipstation",
  "smartsheet",
  "stripe connect",
  "surveymonkey",
  "tally",
  "tavily",
  "teamwork",
  "toggl",
  "vercel",
  "vimeo",
  "whatsapp business",
  "workday",
  "yelp",
  "accelo",
  "adalo",
  "adroll",
  "aftership",
  "amazon seller central",
  "appsheet",
  "attio",
  "bigin by zoho crm",
  "callrail",
  "chartmogul",
  "cognito forms",
  "contentful",
  "databox",
  "delighted",
  "drip",
  "easyship",
  "facebook groups",
  "freshbooks",
  "freshsales suite",
  "getresponse",
  "gitbook",
  "google gemini",
  "google vertex ai",
  "hacker news",
  "hive",
  "html css to image",
  "involve.me",
  "jotform",
  "kajabi",
  "kintone",
  "launchdarkly",
  "mailersend",
  "mandrill",
  "microsoft power bi",
  "microsoft powerpoint",
  "microsoft to do",
  "microsoft word",
  "miro",
  "mixmax",
  "moosend",
  "neon",
  "openai assistants",
  "pagerduty",
  "paperform",
  "parsehub",
  "podio",
  "postmark",
  "profitwell",
  "recurly",
  "reply.io",
  "scrapingbee",
  "shortcut",
  "simpletexting",
  "streak",
  "synthesia",
  "tableau",
  "teachable",
  "thinkific",
  "tinyemail",
  "transistor",
  "trustpilot",
  "unbounce",
  "userback",
  "userpilot",
  "wave",
  "webinarjam",
  "wistia",
  "youcanbook.me",
];

const ZAPIER_COMMON_EXTERNAL_ACTIONS = [
  "new record",
  "updated record",
  "find record",
  "create record",
  "update record",
  "new row",
  "updated row",
  "find row",
  "create row",
  "update row",
  "new contact",
  "find contact",
  "create contact",
  "update contact",
  "new lead",
  "create lead",
  "update lead",
  "new deal",
  "create deal",
  "update deal",
  "send email",
  "send message",
  "send channel message",
  "create task",
  "update task",
  "upload file",
  "create event",
  "update event",
  "custom request",
  "api request",
  "create chat completion",
  "create completion",
  "conversation",
  "analyze sentiment",
  "new order",
  "new payment",
  "new invoice",
  "new subscriber",
  "new ticket",
  "new issue",
  "new file",
  "new message",
  "new event",
  "new form submission",
  "find customer",
  "create customer",
  "update customer",
  "find order",
  "create order",
  "update order",
  "find product",
  "create product",
  "update product",
  "find file",
  "copy file",
  "move file",
  "send sms",
  "send notification",
  "post comment",
  "create comment",
  "add tag",
  "remove tag",
  "add subscriber",
  "update subscriber",
  "create campaign",
  "send campaign",
  "create ticket",
  "update ticket",
  "create issue",
  "update issue",
  "run query",
  "execute query",
  "insert row",
  "delete row",
  "webhook request",
  "custom api call",
  "raw request",
  "get request",
  "post request",
  "put request",
  "patch request",
  "delete request",
  "new spreadsheet row",
  "updated spreadsheet row",
  "new database item",
  "updated database item",
  "new item",
  "updated item",
  "find item",
  "create item",
  "update item",
  "delete item",
  "new user",
  "updated user",
  "find user",
  "create user",
  "update user",
  "new customer",
  "updated customer",
  "new product",
  "updated product",
  "new deal",
  "updated deal",
  "find deal",
  "new task",
  "updated task",
  "find task",
  "new project",
  "updated project",
  "find project",
  "create project",
  "update project",
  "new page",
  "updated page",
  "find page",
  "create page",
  "update page",
  "new document",
  "updated document",
  "find document",
  "create document",
  "update document",
  "new folder",
  "create folder",
  "new meeting",
  "create meeting",
  "update meeting",
  "new channel",
  "create channel",
  "new list",
  "create list",
  "update list",
  "new card",
  "create card",
  "update card",
  "new comment",
  "updated comment",
  "update comment",
  "unsubscribe subscriber",
  "new conversation",
  "create conversation",
  "reply to conversation",
  "new thread",
  "create thread",
  "reply to thread",
  "send direct message",
  "generate text",
  "generate image",
  "classify text",
  "extract data",
  "summarize text",
  "translate text",
  "parse document",
  "create lead event",
  "create conversion event",
  "track event",
  "track page view",
  "create report",
  "get report",
  "export report",
  "sync record",
  "bulk create",
  "bulk update",
  "bulk delete",
  "rest api call",
  "graphql query",
  "graphql mutation",
  "create database item",
  "update database item",
  "query database",
  "append block",
  "create spreadsheet row",
  "update spreadsheet row",
  "lookup spreadsheet row",
  "create calendar event",
  "update calendar event",
  "create board",
  "update board",
  "create work item",
  "update work item",
  "create opportunity",
  "update opportunity",
  "create company",
  "update company",
  "create organization",
  "update organization",
  "create person",
  "update person",
  "create page post",
  "create social post",
  "publish post",
  "schedule post",
  "create file",
  "update file",
  "create object",
  "update object",
  "delete object",
  "create entry",
  "update entry",
  "delete entry",
  "create row in table",
  "update row in table",
  "create form",
  "get form response",
  "send transactional email",
  "send template email",
  "create template",
  "render template",
  "create draft",
  "send draft",
  "create booking",
  "update booking",
  "cancel booking",
  "create shipment",
  "update shipment",
  "track shipment",
  "create refund",
  "create charge",
  "create subscription",
  "update subscription",
  "create payment link",
  "create session",
  "create vector",
  "embed text",
  "moderate text",
  "answer question",
  "create embedding",
  "transcribe audio",
  "extract text from file",
  "scrape url",
  "crawl url",
  "parse rss feed",
  "send whatsapp message",
  "send telegram message",
  "send slack message",
  "send teams message",
  "create zendesk ticket",
  "update zendesk ticket",
  "create hubspot contact",
  "update hubspot contact",
  "create salesforce record",
  "update salesforce record",
];

function sourcePlatform(value: unknown) {
  const platform = lower(value || "make");
  return platform === "zapier" ? "zapier" : "make";
}

function platformLabel(value: unknown) {
  return sourcePlatform(value) === "zapier" ? "Zapier" : "Make";
}

const MAKE_INTERNAL_LOGIC_MODULE_KEYS = [
  "builtin:basicfeeder",
  "builtin:break",
  "builtin:composeastring",
  "builtin:continue",
  "builtin:incrementfunction",
  "builtin:setvariable",
  "flowcontrol:aggregator",
  "flowcontrol:break",
  "flowcontrol:filter",
  "flowcontrol:iterator",
  "flowcontrol:repeater",
  "flowcontrol:router",
  "gateway:customwebhook",
  "json:aggregatejson",
  "json:createjson",
  "json:parsejson",
  "math:average",
  "math:ceil",
  "math:floor",
  "math:max",
  "math:min",
  "math:round",
  "text:composeastring",
  "text:matchpattern",
  "text:parsehtml",
  "text:replace",
  "text:split",
  "tools:composeastring",
  "tools:getmultiplevariables",
  "tools:getvariable",
  "tools:incrementfunction",
  "tools:setmultiplevariables",
  "tools:setvariable",
  "util:arrayaggregator",
  "util:iterator",
  "util:setvariable",
];

const MAKE_KNOWN_CONVERTER_LOCATIONS = [
  ...MAKE_INTERNAL_LOGIC_MODULE_KEYS.map((module) => ({
    source_module_key: normalizeModuleKey(module),
    strategy: "code_node",
    confidence: "medium",
  })),
  ...MAKE_COMMON_EXTERNAL_APPS.flatMap((app) =>
    MAKE_COMMON_EXTERNAL_ACTIONS.map((action) => ({
      source_module_key: normalizeModuleKey(`${app}:${action}`),
      app,
      action,
      strategy: "http_request",
      confidence: "low",
    }))
  ),
];

const MAKE_COMMON_EXTERNAL_APP_SET = new Set(
  MAKE_COMMON_EXTERNAL_APPS.map((app) => normalizeModuleKey(app)),
);

const MAKE_KNOWN_CONVERTER_LOCATION_MAP = new Map(
  MAKE_KNOWN_CONVERTER_LOCATIONS.map((location) => [location.source_module_key, location]),
);

const ZAPIER_KNOWN_CONVERTER_LOCATIONS = [
  ...ZAPIER_CORE_APP_MAPPINGS.flatMap((app) => {
    const appKey = normalizeModuleKey(app);
    const strategies: Record<string, { strategy: string; confidence: string }> = {
      "webhooks by zapier": { strategy: "code_node", confidence: "high" },
      "schedule by zapier": { strategy: "code_node", confidence: "high" },
      "filter by zapier": { strategy: "code_node", confidence: "medium" },
      "formatter by zapier": { strategy: "code_node", confidence: "medium" },
      "paths by zapier": { strategy: "code_node", confidence: "medium" },
      "delay by zapier": { strategy: "code_node", confidence: "medium" },
      "looping by zapier": { strategy: "code_node", confidence: "medium" },
      "code by zapier": { strategy: "code_node", confidence: "medium" },
      "storage by zapier": { strategy: "http_request", confidence: "low" },
      "zapier tables": { strategy: "http_request", confidence: "low" },
    };
    const strategy = strategies[app] || { strategy: "code_node", confidence: "medium" };
    return [
      {
        source_module_key: appKey,
        app,
        action: "",
        ...strategy,
      },
      {
        source_module_key: normalizeModuleKey(`${app}:*`),
        app,
        action: "*",
        ...strategy,
      },
    ];
  }),
  ...ZAPIER_COMMON_EXTERNAL_APPS.flatMap((app) =>
    ZAPIER_COMMON_EXTERNAL_ACTIONS.map((action) => ({
      source_module_key: normalizeModuleKey(`${app}:${action}`),
      app,
      action,
      strategy: "http_request",
      confidence: "low",
    }))
  ),
];

const ZAPIER_COMMON_EXTERNAL_APP_SET = new Set(
  ZAPIER_COMMON_EXTERNAL_APPS.map((app) => normalizeModuleKey(app)),
);

const ZAPIER_KNOWN_CONVERTER_LOCATION_MAP = new Map(
  ZAPIER_KNOWN_CONVERTER_LOCATIONS.map((location) => [location.source_module_key, location]),
);

function moduleActionText(group: any) {
  return `${group.source_module || ""} ${group.source_app || ""} ${group.source_action || ""} ${group.source_module_label || ""}`.toLowerCase();
}

function sampleMapper(group: any) {
  const sample = asObject(group.sample);
  return {
    sample,
    mapper: asObject(sample.mapper),
    parameters: asObject(sample.parameters),
  };
}

function firstTextValue(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const text = cleanString(value);
      if (text) return text;
    }
  }
  return "";
}

function firstNumberValue(...values: unknown[]) {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function promptFromMapper(mapper: Record<string, any>, fallback = "{{NEXUS_SETUP.prompt}}") {
  return firstTextValue(
    mapper.prompt,
    mapper.Prompt,
    mapper.message,
    mapper.text,
    mapper.input,
    mapper.content,
    mapper.user_prompt,
    mapper.userPrompt,
    mapper.instructions,
    mapper.query,
  ) || fallback;
}

function systemPromptFromMapper(mapper: Record<string, any>) {
  return firstTextValue(
    mapper.system,
    mapper.system_prompt,
    mapper.systemPrompt,
    mapper.developer_message,
    mapper.instructions,
  ) || "You are a helpful business automation assistant. Return concise, useful output.";
}

function chatMessagesFromMapper(mapper: Record<string, any>) {
  const rawMessages = Array.isArray(mapper.messages)
    ? mapper.messages
    : Array.isArray(mapper.Messages)
      ? mapper.Messages
      : null;

  if (rawMessages?.length) {
    return rawMessages
      .map((item) => asObject(item))
      .map((item) => ({
        role: cleanString(item.role || item.Role || "user") || "user",
        content: cleanString(item.content || item.Content || item.text || item.Text),
      }))
      .filter((item) => item.content)
      .slice(0, 20);
  }

  return [
    {
      role: "system",
      content: systemPromptFromMapper(mapper),
    },
    {
      role: "user",
      content: promptFromMapper(mapper),
    },
  ];
}

function httpMapping(
  group: any,
  httpTemplate: Record<string, any>,
  confidence = "high",
  operation = "request",
) {
  return {
    id: `builtin:${group.source_module_key}`,
    source_platform: sourcePlatform(group.source_platform),
    source_module_key: group.source_module_key,
    target_strategy: "http_request",
    target_n8n_node_type: "n8n-nodes-base.httpRequest",
    target_operation: operation,
    confidence,
    status: "global",
    scope: "global",
    http_template: httpTemplate,
    built_in: true,
  };
}

function makeOpenAiChatTemplate(group: any, endpoint: string, provider = "openai", providerLabel = "OpenAI", defaultModel = "gpt-4o-mini") {
  const label = platformLabel(group.source_platform);
  const { mapper, parameters } = sampleMapper(group);
  const model = firstTextValue(mapper.model, mapper.Model, parameters.model, defaultModel) || defaultModel;
  const body: Record<string, any> = {
    model,
    messages: chatMessagesFromMapper(mapper),
  };
  const temperature = firstNumberValue(mapper.temperature, mapper.Temperature, parameters.temperature);
  const maxTokens = firstNumberValue(mapper.max_tokens, mapper.maxTokens, mapper.max_completion_tokens, parameters.max_tokens);
  if (temperature !== null) body.temperature = temperature;
  if (maxTokens !== null) body.max_tokens = maxTokens;

  return httpMapping(group, {
    method: "POST",
    url: endpoint,
    auth_type: "bearer",
    credential_provider: provider,
    credential_label: providerLabel,
    n8n_credential_type: "httpBearerAuth",
    headers: {},
    query: {},
    body_json: body,
    notes: `${providerLabel} chat/completions HTTP substitute generated from the ${label} step mapper.`,
  });
}

function makeOpenAiEmbeddingTemplate(group: any) {
  const label = platformLabel(group.source_platform);
  const { mapper, parameters } = sampleMapper(group);
  const model = firstTextValue(mapper.model, parameters.model, "text-embedding-3-small");
  const input = firstTextValue(mapper.input, mapper.text, mapper.content, "{{NEXUS_SETUP.text}}");

  return httpMapping(group, {
    method: "POST",
    url: "https://api.openai.com/v1/embeddings",
    auth_type: "bearer",
    credential_provider: "openai",
    credential_label: "OpenAI",
    n8n_credential_type: "httpBearerAuth",
    headers: {},
    query: {},
    body_json: { model, input },
    notes: `OpenAI embeddings HTTP substitute generated from the ${label} step mapper.`,
  });
}

function makeOpenAiImageTemplate(group: any) {
  const label = platformLabel(group.source_platform);
  const { mapper, parameters } = sampleMapper(group);
  const model = firstTextValue(mapper.model, parameters.model, "gpt-image-1");
  const prompt = promptFromMapper(mapper);

  return httpMapping(group, {
    method: "POST",
    url: "https://api.openai.com/v1/images/generations",
    auth_type: "bearer",
    credential_provider: "openai",
    credential_label: "OpenAI",
    n8n_credential_type: "httpBearerAuth",
    headers: {},
    query: {},
    body_json: { model, prompt },
    notes: `OpenAI image-generation HTTP substitute generated from the ${label} step mapper.`,
  });
}

function makeGeminiTemplate(group: any) {
  const label = platformLabel(group.source_platform);
  const { mapper, parameters } = sampleMapper(group);
  const model = firstTextValue(mapper.model, mapper.Model, parameters.model, "gemini-2.0-flash")
    .replace(/^models\//i, "");
  const prompt = promptFromMapper(mapper);

  return httpMapping(group, {
    method: "POST",
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    auth_type: "header",
    credential_provider: "google_gemini",
    credential_label: "Google Gemini",
    n8n_credential_type: "httpHeaderAuth",
    headers: {},
    query: {},
    body_json: {
      contents: [
        {
          parts: [
            { text: prompt },
          ],
        },
      ],
    },
    notes: `Google Gemini generateContent HTTP substitute generated from the ${label} step mapper.`,
  });
}

function makeAnthropicTemplate(group: any) {
  const label = platformLabel(group.source_platform);
  const { mapper, parameters } = sampleMapper(group);
  const model = firstTextValue(mapper.model, mapper.Model, parameters.model, "claude-3-5-sonnet-latest");
  const maxTokens = firstNumberValue(mapper.max_tokens, mapper.maxTokens, parameters.max_tokens) || 1024;

  return httpMapping(group, {
    method: "POST",
    url: "https://api.anthropic.com/v1/messages",
    auth_type: "header",
    credential_provider: "anthropic",
    credential_label: "Anthropic",
    n8n_credential_type: "httpHeaderAuth",
    headers: {
      "anthropic-version": "2023-06-01",
    },
    query: {},
    body_json: {
      model,
      max_tokens: maxTokens,
      messages: [
        {
          role: "user",
          content: promptFromMapper(mapper),
        },
      ],
    },
    notes: `Anthropic Messages API HTTP substitute generated from the ${label} step mapper.`,
  });
}

function makeSlackPostMessageTemplate(group: any) {
  const label = platformLabel(group.source_platform);
  const { mapper, parameters } = sampleMapper(group);
  const channel = firstTextValue(mapper.channel, mapper.channelId, parameters.channel, "{{NEXUS_SETUP.slack_channel}}");
  const text = firstTextValue(mapper.text, mapper.message, mapper.content, parameters.text, "{{NEXUS_SETUP.message_text}}");

  return httpMapping(group, {
    method: "POST",
    url: "https://slack.com/api/chat.postMessage",
    auth_type: "bearer",
    credential_provider: "slack",
    credential_label: "Slack",
    n8n_credential_type: "httpBearerAuth",
    headers: {},
    query: {},
    body_json: { channel, text },
    notes: `Slack chat.postMessage HTTP substitute generated from the ${label} step mapper.`,
  }, "medium", "chat.postMessage");
}

function aiProviderMappingFor(group: any) {
  const moduleKey = lower(group.source_module_key);
  const text = moduleActionText(group);
  const isChatLike = /(chat|completion|message|response|prompt|assistant|generate|create)/i.test(text);

  if (text.includes("openai") || moduleKey.includes("openai-gpt")) {
    if (/(embedding|embeddings)/i.test(text)) return makeOpenAiEmbeddingTemplate(group);
    if (/(image|images|picture|dall)/i.test(text)) return makeOpenAiImageTemplate(group);
    if (isChatLike) return makeOpenAiChatTemplate(group, "https://api.openai.com/v1/chat/completions");
  }

  if (text.includes("openrouter")) {
    return makeOpenAiChatTemplate(group, "https://openrouter.ai/api/v1/chat/completions", "openrouter", "OpenRouter", "openai/gpt-4o-mini");
  }

  if (text.includes("groq")) {
    return makeOpenAiChatTemplate(group, "https://api.groq.com/openai/v1/chat/completions", "groq", "Groq", "llama-3.1-8b-instant");
  }

  if (text.includes("mistral")) {
    return makeOpenAiChatTemplate(group, "https://api.mistral.ai/v1/chat/completions", "mistral", "Mistral AI", "mistral-small-latest");
  }

  if (text.includes("perplexity")) {
    return makeOpenAiChatTemplate(group, "https://api.perplexity.ai/chat/completions", "perplexity", "Perplexity", "sonar");
  }

  if (text.includes("gemini") || text.includes("google-ai") || text.includes("google ai") || text.includes("palm")) {
    return makeGeminiTemplate(group);
  }

  if (text.includes("anthropic") || text.includes("claude")) {
    return makeAnthropicTemplate(group);
  }

  if (text.includes("slack") && /(post|send|create).*(message)|chat\.postmessage/i.test(text)) {
    return makeSlackPostMessageTemplate(group);
  }

  return null;
}

function knownConverterLocationFor(group: any) {
  const platform = sourcePlatform(group.source_platform);
  const locationMap = platform === "zapier" ? ZAPIER_KNOWN_CONVERTER_LOCATION_MAP : MAKE_KNOWN_CONVERTER_LOCATION_MAP;
  const externalAppSet = platform === "zapier" ? ZAPIER_COMMON_EXTERNAL_APP_SET : MAKE_COMMON_EXTERNAL_APP_SET;

  return locationMap.get(group.source_module_key)
    || locationMap.get(normalizeModuleKey(`${group.source_app}:${group.source_action}`))
    || locationMap.get(normalizeModuleKey(`${group.source_app}:*`))
    || (
      externalAppSet.has(normalizeModuleKey(group.source_app))
        ? {
            source_module_key: group.source_module_key,
            app: normalizeModuleKey(group.source_app),
            action: normalizeModuleKey(group.source_action || group.source_module_label || (platform === "zapier" ? "api request" : "make-an-api-call")),
            strategy: "http_request",
            confidence: "low",
          }
        : null
    );
}

function knownExternalSupportMappingFor(group: any) {
  const location = knownConverterLocationFor(group);
  if (!location || location.strategy !== "http_request") return null;

  return {
    id: `builtin-known:${group.source_module_key}`,
    source_platform: sourcePlatform(group.source_platform),
    source_module_key: group.source_module_key,
    target_strategy: "manual_support",
    suggested_strategy: "http_request",
    confidence: location.confidence || "low",
    status: "known",
    scope: "global",
    built_in: true,
    known_converter_location: true,
    known_app: location.app || group.source_app,
    known_action: location.action || group.source_action,
    reason: `Nexus recognizes this ${platformLabel(group.source_platform)} app/action. Add one HTTP substitute for this module type; after the workflow passes, Nexus can reuse it for future imports.`,
  };
}

function getAuthHeader(req: Request) {
  const authHeader = req.headers.get("Authorization") || "";
  return authHeader.startsWith("Bearer ") ? authHeader : "";
}

async function getUserFromRequest(req: Request) {
  const authHeader = getAuthHeader(req);
  if (!authHeader) return null;

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  });

  const token = authHeader.replace("Bearer ", "").trim();
  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

async function requireOperator(req: Request, adminClient: any): Promise<{ operator: OperatorContext | null; error: string | null }> {
  const user = await getUserFromRequest(req);
  if (!user) return { operator: null, error: "Login required." };

  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("id, role, email, full_name")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError || !profile || !["admin", "developer"].includes(profile.role)) {
    return { operator: null, error: "Admin or developer access required." };
  }

  if (profile.role === "admin") {
    return { operator: { profile, developer: null }, error: null };
  }

  const { data: developer, error: developerError } = await adminClient
    .from("developers")
    .select("id, profile_id, display_name, handle, status")
    .eq("profile_id", user.id)
    .maybeSingle();

  if (developerError || !developer) {
    return { operator: null, error: "Developer profile not found." };
  }

  return { operator: { profile, developer }, error: null };
}

function canAccessAutomation(operator: OperatorContext, product: any) {
  if (operator.profile.role === "admin") return true;
  return Boolean(operator.developer?.id && product?.developer_id === operator.developer.id);
}

async function loadAutomation(adminClient: any, operator: OperatorContext, automationId: string) {
  if (!automationId) return null;

  const { data, error } = await adminClient
    .from("automations")
    .select("*")
    .eq("id", automationId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data || !canAccessAutomation(operator, data)) return null;
  return data;
}

function extractModuleObject(candidate: any) {
  const record = asObject(candidate);
  const rawModule = cleanString(
    record.module ||
      record.name ||
      record.type ||
      record.app ||
      record.appName ||
      record.moduleName ||
      "",
  );

  if (!rawModule) return null;

  const split = splitModule(rawModule);
  const label = cleanString(
    record.metadata?.designer?.name ||
      record.metadata?.name ||
      record.label ||
      record.name ||
      rawModule,
  );

  return {
    id: cleanString(record.id || record.uid || crypto.randomUUID()),
    label: label || rawModule,
    raw_module: rawModule,
    ...split,
    parameters: asObject(record.parameters),
    mapper: asObject(record.mapper),
    metadata: asObject(record.metadata),
    raw: record,
  };
}

function collectMakeModules(blueprint: any) {
  const modules: any[] = [];
  const seen = new Set<any>();

  function walk(value: any, path: string[] = []) {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    const maybeModule = extractModuleObject(value);
    if (maybeModule && (value.module || path[path.length - 1] === "flow" || path[path.length - 1] === "modules")) {
      modules.push(maybeModule);
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, [...path, String(index)]));
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (["metadata", "mapper", "parameters"].includes(key) && maybeModule) continue;
      walk(child, [...path, key]);
    }
  }

  walk(blueprint);

  const unique: any[] = [];
  const uniqueSeen = new Set<string>();
  for (const item of modules) {
    const key = `${item.id}:${item.source_module_key}`;
    if (uniqueSeen.has(key)) continue;
    uniqueSeen.add(key);
    unique.push(item);
  }

  return unique;
}

function extractZapierStepObject(candidate: any) {
  const record = asObject(candidate);
  const app = cleanString(
    record.app ||
      record.app_name ||
      record.appName ||
      record.application ||
      record.service ||
      record.service_name ||
      record.provider ||
      record.selected_api ||
      record.selectedApi ||
      record.module ||
      "",
  );
  const action = cleanString(
    record.event ||
      record.action ||
      record.operation ||
      record.action_name ||
      record.actionName ||
      record.event_name ||
      record.eventName ||
      record.type ||
      record.trigger ||
      "",
  );

  if (!app && !action) return null;

  const rawModule = app && action ? `${app}:${action}` : app || action;
  const split = splitModule(rawModule);
  const label = cleanString(
    record.label ||
      record.name ||
      record.title ||
      record.step_name ||
      record.stepName ||
      record.description ||
      rawModule,
  );

  return {
    id: cleanString(record.id || record.uid || record.step_id || record.stepId || crypto.randomUUID()),
    label: label || rawModule,
    raw_module: rawModule,
    ...split,
    parameters: asObject(record.parameters || record.params || record.config),
    mapper: asObject(record.mapper || record.fields || record.input || record.inputs || record.values),
    metadata: asObject(record.metadata || record.meta),
    raw: record,
  };
}

function collectZapierModules(blueprint: any) {
  const modules: any[] = [];
  const seen = new Set<any>();

  function addCandidate(value: any) {
    const maybeStep = extractZapierStepObject(value);
    if (maybeStep) modules.push(maybeStep);
  }

  const root = asObject(blueprint);
  addCandidate(root.trigger);
  asArray(root.steps).forEach(addCandidate);
  asArray(root.actions).forEach(addCandidate);
  asArray(root.nodes).forEach(addCandidate);
  asArray(root.flow).forEach(addCandidate);

  function walk(value: any, path: string[] = []) {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);

    const last = path[path.length - 1] || "";
    const maybeStep = extractZapierStepObject(value);
    if (maybeStep && (
      Boolean(value.app || value.appName || value.app_name || value.service || value.provider || value.selected_api) ||
      ["trigger", "steps", "actions", "nodes", "flow", "zap"].includes(last)
    )) {
      modules.push(maybeStep);
    }

    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, [...path, String(index)]));
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      if (["metadata", "meta", "mapper", "fields", "input", "inputs", "parameters", "params", "config"].includes(key) && maybeStep) continue;
      walk(child, [...path, key]);
    }
  }

  walk(blueprint);

  const unique: any[] = [];
  const uniqueSeen = new Set<string>();
  for (const item of modules) {
    const key = `${item.id}:${item.source_module_key}`;
    if (uniqueSeen.has(key)) continue;
    uniqueSeen.add(key);
    unique.push(item);
  }

  return unique;
}

function collectSourceModules(blueprint: any, platform: string) {
  return sourcePlatform(platform) === "zapier"
    ? collectZapierModules(blueprint)
    : collectMakeModules(blueprint);
}

function groupModules(modules: any[], platform = "make") {
  const normalizedPlatform = sourcePlatform(platform);
  const groups = new Map<string, any>();

  for (const module of modules) {
    const key = module.source_module_key;
    if (!groups.has(key)) {
      groups.set(key, {
        source_platform: normalizedPlatform,
        source_app: module.source_app,
        source_action: module.source_action,
        source_module: module.source_module,
        source_module_key: key,
        source_module_label: module.label || module.source_module,
        usage_count: 0,
        node_ids: [],
        node_labels: [],
        sample: module.raw,
      });
    }

    const group = groups.get(key);
    group.usage_count += 1;
    group.node_ids.push(module.id);
    group.node_labels.push(module.label || module.source_module);
  }

  return Array.from(groups.values());
}

function builtInMappingFor(group: any) {
  const moduleKey = lower(group.source_module_key);
  const moduleText = `${group.source_module} ${group.source_app} ${group.source_action}`.toLowerCase();
  const aiMapping = aiProviderMappingFor(group);
  if (aiMapping) return aiMapping;

  const knownLocation = knownConverterLocationFor(group);

  if (knownLocation?.strategy === "code_node") {
    return {
      id: `builtin:${group.source_module_key}`,
      target_strategy: "code_node",
      target_n8n_node_type: "n8n-nodes-base.code",
      target_operation: "logic_passthrough",
      confidence: knownLocation.confidence || "medium",
      status: "global",
      scope: "global",
      built_in: true,
    };
  }

  if (moduleText.includes("httprequest") || moduleText.includes("http:") || moduleKey.includes("http")) {
    const sample = asObject(group.sample);
    const mapper = asObject(sample.mapper);
    const parameters = asObject(sample.parameters);
    const url = cleanString(mapper.url || mapper.URL || parameters.url || parameters.URL);
    const method = cleanString(mapper.method || parameters.method || "GET").toUpperCase();

    if (!url || (!url.includes("{{") && !/^https:\/\//i.test(url))) return null;

    return {
      id: `builtin:${group.source_module_key}`,
      source_platform: sourcePlatform(group.source_platform),
      source_module_key: group.source_module_key,
      target_strategy: "http_request",
      target_n8n_node_type: "n8n-nodes-base.httpRequest",
      target_operation: "request",
      confidence: "medium",
      status: "global",
      scope: "global",
      http_template: {
        method,
        url,
        auth_type: "none",
      },
      built_in: true,
    };
  }

  if (moduleText.includes("webhook") || moduleText.includes("gateway:")) {
    return {
      id: `builtin:${group.source_module_key}`,
      target_strategy: "code_node",
      target_n8n_node_type: "n8n-nodes-base.code",
      target_operation: "input_passthrough",
      confidence: "high",
      status: "global",
      scope: "global",
      built_in: true,
    };
  }

  if (
    moduleText.includes("router") ||
    moduleText.includes("paths by zapier") ||
    moduleText.includes("filter") ||
    moduleText.includes("formatter") ||
    moduleText.includes("delay by zapier") ||
    moduleText.includes("looping by zapier") ||
    moduleText.includes("code by zapier") ||
    moduleText.includes("schedule by zapier") ||
    moduleText.includes("tools:") ||
    moduleText.includes("json") ||
    moduleText.includes("text") ||
    moduleText.includes("array")
  ) {
    return {
      id: `builtin:${group.source_module_key}`,
      target_strategy: "code_node",
      target_n8n_node_type: "n8n-nodes-base.code",
      target_operation: "logic_passthrough",
      confidence: "medium",
      status: "global",
      scope: "global",
      built_in: true,
    };
  }

  const knownExternal = knownExternalSupportMappingFor(group);
  if (knownExternal) return knownExternal;

  return null;
}

async function loadMappings(adminClient: any, operator: OperatorContext, platform = "make") {
  const normalizedPlatform = sourcePlatform(platform);
  const { data, error } = await adminClient
    .from("workflow_node_mappings")
    .select("*")
    .eq("source_platform", normalizedPlatform)
    .neq("status", "disabled")
    .order("last_validated_at", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(5000);

  if (error) throw new Error(error.message);

  const developerId = operator.developer?.id || "";
  const profileId = operator.profile.id || "";

  const allowed = (data || []).filter((mapping: any) => {
    if (["validated", "global"].includes(mapping.status)) return true;
    if (mapping.developer_id && mapping.developer_id === developerId) return true;
    if (mapping.created_by && mapping.created_by === profileId) return true;
    if (operator.profile.role === "admin") return true;
    return false;
  });

  return allowed.sort((a: any, b: any) => {
    const score = (mapping: any) => {
      let value = 0;
      if (mapping.created_by === profileId) value += 100;
      if (developerId && mapping.developer_id === developerId) value += 80;
      if (mapping.status === "validated" || mapping.status === "global") value += 40;
      if (mapping.scope === "global") value += 10;
      return value;
    };

    return score(b) - score(a);
  });
}

function chooseMapping(group: any, mappings: any[]) {
  const exact = mappings.find((mapping) => mapping.source_module_key === group.source_module_key);
  return exact || builtInMappingFor(group);
}

function summarizeGroups(groups: any[], mappings: any[]) {
  const resolved: any[] = [];
  const unresolved: any[] = [];

  for (const group of groups) {
    const mapping = chooseMapping(group, mappings);

    if (mapping && mapping.target_strategy !== "manual_support") {
      const mappingStatus = mapping.status || "draft";
      const mappingIsValidated = ["validated", "global"].includes(mappingStatus) || Boolean(mapping.built_in);
      resolved.push({
        ...group,
        mapping_id: mapping.id,
        target_strategy: mapping.target_strategy,
        target_n8n_node_type: mapping.target_n8n_node_type,
        confidence: mapping.confidence || "low",
        mapping_status: mappingStatus,
        mapping_validated: mappingIsValidated,
        needs_validation: mapping.target_strategy === "http_request" && !mappingIsValidated,
        http_template: mapping.target_strategy === "http_request" ? mapping.http_template || null : null,
        built_in: Boolean(mapping.built_in),
      });
    } else {
      const manualMapping = mapping && mapping.target_strategy === "manual_support" ? mapping : null;
      unresolved.push({
        ...group,
        suggested_strategy: manualMapping?.suggested_strategy || "http_request",
        reason: manualMapping?.reason || "No safe reusable n8n mapping exists yet. Add one HTTP substitute for this module group or request Nexus support.",
        known_converter_location: Boolean(manualMapping?.known_converter_location),
        known_app: manualMapping?.known_app || "",
        known_action: manualMapping?.known_action || "",
        confidence: manualMapping?.confidence || group.confidence || "low",
      });
    }
  }

  return { resolved, unresolved };
}

function safeBlueprint(value: unknown, platform = "make") {
  const label = platformLabel(platform);
  const parsed = safeJson(value, null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Upload or paste a ${label} workflow JSON object.`);
  }

  const serialized = JSON.stringify(parsed);
  if (serialized.length > 2000000) {
    throw new Error(`${label} workflow JSON is too large for the MVP importer. Keep the file under about 2 MB.`);
  }

  return parsed;
}

function headersObjectToArray(value: any) {
  const input = safeJson(value, {});
  if (Array.isArray(input)) {
    return input
      .map((item) => asObject(item))
      .map((item) => ({
        name: cleanString(item.name || item.key),
        value: cleanString(item.value),
      }))
      .filter((item) => item.name);
  }

  return Object.entries(asObject(input))
    .map(([name, value]) => ({
      name,
      value: cleanString(value),
    }))
    .filter((item) => item.name);
}

function containsLiteralSecret(value: unknown) {
  const text = JSON.stringify(value || "");
  return /(sk-[a-z0-9_-]{12,}|api[_-]?key["']?\s*[:=]\s*["'][a-z0-9_-]{16,}|bearer\s+[a-z0-9._-]{16,})/i.test(text);
}

function validatePublicHttpsUrl(rawUrl: string) {
  if (!rawUrl || rawUrl.includes("{{")) return;

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("HTTP substitute URL must be a valid HTTPS URL or a template using {{...}} placeholders.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("HTTP substitute URLs must use HTTPS.");
  }

  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(host)
  ) {
    throw new Error("HTTP substitute URL cannot target localhost or private network addresses.");
  }
}

function normalizeHttpTemplate(body: any) {
  let method = cleanString(body.method || body.http_method || "GET").toUpperCase();
  const url = cleanString(body.url || body.endpoint);
  const authType = cleanString(body.auth_type || "bearer").toLowerCase();
  const credentialProvider = normalizeName(body.credential_provider || body.provider || body.source_app || "custom", "custom");
  const credentialLabel = cleanString(body.credential_label || body.provider_label || displayLabel(credentialProvider) || "API credential");
  const n8nCredentialType = cleanString(body.n8n_credential_type || (authType === "bearer" ? "httpBearerAuth" : ""));
  const headers = headersObjectToArray(body.headers || body.headers_json);
  const query = asObject(safeJson(body.query || body.query_json, {}));
  const bodyJson = safeJson(body.body_json || body.body || {}, {});

  if (method === "GET" && hasPayload(bodyJson)) {
    method = "POST";
  }

  if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    throw new Error("HTTP substitute method must be GET, POST, PUT, PATCH, or DELETE.");
  }

  if (!url) throw new Error("HTTP substitute URL is required.");
  validatePublicHttpsUrl(url);

  const template = {
    method,
    url,
    auth_type: authType,
    credential_provider: credentialProvider,
    credential_label: credentialLabel,
    n8n_credential_type: n8nCredentialType,
    headers,
    query,
    body_json: bodyJson,
    response_path: cleanString(body.response_path),
    notes: cleanString(body.notes),
  };

  if (containsLiteralSecret(template)) {
    throw new Error("Do not paste raw API keys into HTTP substitutes. Use credential placeholders or the credential vault.");
  }

  return template;
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
      const key = canonicalSetupKey(match[1]);
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

function mergeGeneratedSetupSchema(existingSchema: unknown, generatedFields: any[]) {
  const schema = asArray(existingSchema)
    .filter((field) => field && typeof field === "object")
    .map((field) => ({ ...field }));
  const names = new Set(schema.map((field) => canonicalSetupKey(field.name)).filter(Boolean));
  const added: any[] = [];

  for (const field of generatedFields || []) {
    const name = canonicalSetupKey(field?.name);
    if (!name || names.has(name)) continue;
    const cleanField = {
      ...makeSetupField(name),
      ...field,
      name,
      label: cleanString(field.label || inferFieldLabel(name)),
      type: cleanString(field.type || inferSetupFieldType(name)),
      required: field.required !== false,
    };
    schema.push(cleanField);
    names.add(name);
    added.push(cleanField);
  }

  return { schema, added };
}

function generatedSetupFieldsForSource(blueprint: any, generatedWorkflow: any, platform = "make") {
  const label = platformLabel(platform);
  const sourceText = `${JSON.stringify(blueprint || {})}\n${JSON.stringify(generatedWorkflow || {})}`;
  const names = new Set<string>([
    ...extractRuntimeSetupKeys(sourceText),
    ...inferMakeSetupKeysFromText(sourceText),
  ]);

  return [...names].sort().map((name) => makeSetupField(
    name,
    `Auto-generated by Nexus from the ${label} workflow and setup references. You can edit this before launch.`,
  ));
}

function credentialRequirementsFromTemplate(template: any) {
  if (template.auth_type === "none") return [];

  return [{
    provider: template.credential_provider || "custom",
    provider_label: template.credential_label || "API credential",
    credential_type: "api_key",
    credential_key: template.n8n_credential_type || "httpBearerAuth",
    n8n_credential_type: template.n8n_credential_type || "httpBearerAuth",
    required: true,
  }];
}

function n8nNodeId() {
  return crypto.randomUUID();
}

function makeCodeNode(name: string, index: number, code: string) {
  return {
    id: n8nNodeId(),
    name,
    type: "n8n-nodes-base.code",
    typeVersion: 2,
    position: [420 + index * 280, 0],
    parameters: {
      jsCode: code,
    },
  };
}

function makeProxyFetchCode(name: string, template: any, headersJson: Record<string, string>, query: Record<string, any>, bodyJson: any) {
  const proxyUrl = `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/runtime-http-proxy`;
  const body = bodyJson || {};
  const rawMethod = cleanString(template.method || "GET").toUpperCase();
  const method = rawMethod === "GET" && hasPayload(body) ? "POST" : rawMethod;
  const payloadTemplate = {
    method,
    url: cleanString(template.url),
    headers: headersJson || {},
    query: query || {},
    body,
    auth_type: cleanString(template.auth_type || "bearer"),
    provider: cleanString(template.credential_provider || "custom"),
    provider_label: cleanString(template.credential_label || "API credential"),
    credential_key: cleanString(template.n8n_credential_type || "httpBearerAuth"),
  };

  return [
    "const context = $('Nexus Runtime Context').first().json || {};",
    `const template = ${JSON.stringify(payloadTemplate, null, 2)};`,
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
    `    'authorization': 'Bearer ${SUPABASE_ANON_KEY}',`,
    `    'apikey': '${SUPABASE_ANON_KEY}',`,
    "    'x-nexus-runtime-secret': context.system?.runtime_secret || ''",
    "  };",
    "  if (typeof fetch === 'function') {",
    "    const response = await fetch(" + JSON.stringify(proxyUrl) + ", { method: 'POST', headers, body: JSON.stringify(payload) });",
    "    const text = await response.text();",
    "    let data;",
    "    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }",
    "    if (!response.ok) throw new Error(data.message || data.error || data.raw || `Nexus proxy request failed with status ${response.status}`);",
    "    return data;",
    "  }",
    "  if (nexusHelpers?.request) {",
    "    return await nexusHelpers.request({ method: 'POST', uri: " + JSON.stringify(proxyUrl) + ", headers, body: payload, json: true });",
    "  }",
    "  if (nexusHelpers?.httpRequest) {",
    "    return await nexusHelpers.httpRequest({ method: 'POST', url: " + JSON.stringify(proxyUrl) + ", headers, body: payload, json: true });",
    "  }",
    "  throw new Error('This n8n Code node cannot make HTTP requests because fetch and n8n HTTP helpers are unavailable. Update n8n or run this product through the Nexus Make proxy runner.');",
    "}",
    "const query = renderValue(template.query || {});",
    "const url = appendQuery(renderString(template.url), query);",
    "const data = await callNexusProxy({",
    "    automation_id: context.automation_id || context.system?.automation_id || '',",
    `    node_name: ${JSON.stringify(name)},`,
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

function runtimeContextExpression(source: string, key: string) {
  const sourceKey = cleanString(source).toLowerCase();
  const cleanKey = cleanString(key);
  const bucket =
    sourceKey === "secret" || sourceKey === "secrets" || sourceKey === "credential" || sourceKey === "credentials"
      ? "secrets"
      : sourceKey === "customer"
        ? "customer"
        : sourceKey === "order"
          ? "order"
          : sourceKey === "system"
            ? "system"
            : "setup";

  return `{{ $('Nexus Runtime Context').first().json.${bucket}.${cleanKey} }}`;
}

function renderNexusRuntimeTemplates(value: any, prefixExpression = true): any {
  if (Array.isArray(value)) return value.map((item) => renderNexusRuntimeTemplates(item, prefixExpression));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, renderNexusRuntimeTemplates(inner, prefixExpression)]));
  }
  if (typeof value !== "string") return value;

  const rendered = value.replace(
    /\{\{\s*NEXUS_(SETUP|SECRET|SECRETS|CUSTOMER|ORDER|SYSTEM)\.([a-zA-Z0-9_.-]+)\s*\}\}/g,
    (_match, source, key) => runtimeContextExpression(source, key),
  );

  return prefixExpression && rendered.includes("$('Nexus Runtime Context').first().json") && !rendered.trim().startsWith("=")
    ? `=${rendered}`
    : rendered;
}

function objectToParameterRows(value: Record<string, any>) {
  return Object.entries(value || {})
    .filter(([key]) => cleanString(key))
    .map(([name, inner]) => ({
      name,
      value: renderNexusRuntimeTemplates(inner),
    }));
}

function hasPayload(value: any) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return value !== undefined && value !== null && value !== "";
}

function stripContentTypeHeader(headers: Record<string, any>) {
  return Object.entries(headers || {}).reduce((accumulator: Record<string, any>, [key, value]) => {
    if (cleanString(key).toLowerCase() === "content-type") return accumulator;
    accumulator[key] = value;
    return accumulator;
  }, {});
}

function templateBody(template: Record<string, any>) {
  if (template.body_json !== undefined && template.body_json !== null) return template.body_json;
  if (template.body !== undefined && template.body !== null) return template.body;
  if (template.jsonBody !== undefined && template.jsonBody !== null) return safeJson(template.jsonBody, {});
  if (template.bodyParametersJson !== undefined && template.bodyParametersJson !== null) {
    return safeJson(template.bodyParametersJson, {});
  }
  return {};
}

function makeLegacyHttpParameters(input: {
  method: string;
  url: string;
  authType: string;
  credentialKey: string;
  headers: Record<string, any>;
  query: Record<string, any>;
  body: any;
}) {
  const body = renderNexusRuntimeTemplates(input.body || {}, false);
  const methodFromInput = cleanString(input.method || "GET").toUpperCase();
  const method = methodFromInput === "GET" && hasPayload(body) ? "POST" : methodFromInput;
  const parameters: Record<string, any> = {
    authentication: input.credentialKey ? "genericCredentialType" : "none",
    requestMethod: method,
    url: renderNexusRuntimeTemplates(input.url),
    responseFormat: "json",
    jsonParameters: true,
    options: {},
  };

  if (input.credentialKey) {
    parameters.genericAuthType = input.credentialKey;
  }

  const headers = stripContentTypeHeader(renderNexusRuntimeTemplates(input.headers || {}, false));
  if (Object.keys(headers).length) {
    parameters.headerParametersJson = JSON.stringify(headers, null, 2);
  }

  const query = renderNexusRuntimeTemplates(input.query || {}, false);
  if (Object.keys(query).length) {
    parameters.queryParametersJson = JSON.stringify(query, null, 2);
  }

  if (method !== "GET" && hasPayload(body)) {
    parameters.bodyParametersJson = JSON.stringify(body, null, 2);
    parameters.options.bodyContentType = "raw";
    parameters.options.bodyContentCustomMimeType = "application/json";
  }

  return parameters;
}

function makeHttpNode(name: string, index: number, mapping: any) {
  const template = asObject(mapping.http_template);
  let method = cleanString(template.method || "GET").toUpperCase();
  const headers = headersObjectToArray(template.headers);
  const query = asObject(template.query);
  const bodyJson = templateBody(template);
  if (method === "GET" && hasPayload(bodyJson)) method = "POST";
  const n8nCredentialType = cleanString(template.n8n_credential_type || "httpBearerAuth");
  const authType = cleanString(template.auth_type || "bearer").toLowerCase();
  const credentialKey = authType === "none" ? "" : n8nCredentialType;

  const headersJson = headers.reduce((accumulator: Record<string, string>, item: any) => {
    if (item.name) accumulator[item.name] = cleanString(item.value);
    return accumulator;
  }, {});

  const node: Record<string, any> = {
    id: n8nNodeId(),
    name,
    type: "n8n-nodes-base.httpRequest",
    typeVersion: 2,
    position: [420 + index * 280, 0],
    parameters: {
      ...makeLegacyHttpParameters({
        method,
        url: cleanString(template.url),
        authType,
        credentialKey,
        headers: headersJson,
        query,
        body: bodyJson,
      }),
      nexusProxyTemplate: {
        method,
        url: cleanString(template.url),
        headers: headersJson || {},
        query: query || {},
        body: bodyJson || {},
        body_json: bodyJson || {},
        auth_type: cleanString(template.auth_type || "bearer"),
        provider: cleanString(template.credential_provider || "custom"),
        provider_label: cleanString(template.credential_label || "API credential"),
        credential_key: credentialKey,
      },
      ...(credentialKey
        ? {
            nexusCredential: {
              uses_nexus_proxy: false,
              provider: cleanString(template.credential_provider || "custom"),
              provider_label: cleanString(template.credential_label || "API credential"),
              credential_key: credentialKey,
              n8n_credential_type: credentialKey,
              url: cleanString(template.url),
              allowed_host: (() => {
                try {
                  return new URL(cleanString(template.url)).hostname;
                } catch {
                  return "";
                }
              })(),
            },
          }
        : {}),
    },
  };

  return node;
}

function buildN8nWorkflow(product: any, groups: any[], mappings: any[], platform = "make") {
  const normalizedPlatform = sourcePlatform(platform);
  const label = platformLabel(normalizedPlatform);
  const nodes: any[] = [];
  const connections: Record<string, any> = {};
  const workflowName = `${cleanString(product?.title || `${label} import`)} - converted from ${label}`;

  const inputNode = {
    id: n8nNodeId(),
    name: "NEXUS_INPUT",
    type: "n8n-nodes-base.webhook",
    typeVersion: 2,
    position: [0, 0],
    parameters: {
      httpMethod: "POST",
      path: `nexus-${normalizedPlatform}-${crypto.randomUUID().slice(0, 8)}`,
      responseMode: "lastNode",
      options: {},
    },
  };
  nodes.push(inputNode);

  let previous = inputNode.name;

  groups.forEach((group, index) => {
    const mapping = chooseMapping(group, mappings);
    if (!mapping || mapping.target_strategy === "manual_support") return;

    const safeName = `${String(index + 1).padStart(2, "0")} ${displayLabel(group.source_module_label || group.source_module).slice(0, 60)}`;
    let node: any;

    if (mapping.target_strategy === "http_request") {
      node = makeHttpNode(safeName, index + 1, mapping);
    } else {
      node = makeCodeNode(
        safeName,
        index + 1,
        [
          `// Converted from ${label} step: ${group.source_module}`,
          `// This logic node preserves workflow order. Replace with exact n8n logic if the imported ${label} step used custom filters/routes.`,
          "return items;",
        ].join("\n"),
      );
    }

    nodes.push(node);
    connections[previous] = { main: [[{ node: node.name, type: "main", index: 0 }]] };
    previous = node.name;
  });

  const outputNode = makeCodeNode(
    "NEXUS_FINAL_OUTPUT",
    groups.length + 2,
    [
      "const first = items[0]?.json || {};",
      "return [{",
      "  json: {",
      "    status: 'success',",
      "    output_type: 'report',",
      "    title: first.title || 'Automation output',",
      `    summary: first.summary || 'Converted ${label} workflow completed successfully.',`,
      `    content_html: first.content_html || '<h1>Automation output</h1><p>The converted ${label} workflow ran successfully.</p>',`,
      "    raw_result: first",
      "  }",
      "}];",
    ].join("\n"),
  );
  nodes.push(outputNode);
  connections[previous] = { main: [[{ node: outputNode.name, type: "main", index: 0 }]] };

  return {
    name: workflowName,
    nodes,
    connections,
    settings: {
      executionOrder: "v1",
    },
  };
}

function makeSummary(modules: any[], groups: any[], resolved: any[], unresolved: any[]) {
  return {
    module_count: modules.length,
    group_count: groups.length,
    resolved_count: resolved.length,
    unresolved_count: unresolved.length,
    confidence_percent: groups.length ? Math.round((resolved.length / groups.length) * 100) : 0,
  };
}

async function upsertImportSession(adminClient: any, operator: OperatorContext, product: any, blueprint: any, result: any, platform = "make") {
  const normalizedPlatform = sourcePlatform(platform);
  const patch = {
    automation_id: product?.id || null,
    developer_id: product?.developer_id || operator.developer?.id || null,
    source_platform: normalizedPlatform,
    source_blueprint: blueprint,
    module_summary: result.summary,
    resolved_groups: result.resolved,
    unresolved_groups: result.unresolved,
    generated_workflow_json: result.generated_workflow_json || null,
    status: result.status,
    created_by: operator.profile.id,
    updated_by: operator.profile.id,
    updated_at: nowIso(),
  };

  const existingId = cleanString(product?.make_import_session_id);

  if (existingId) {
    const { data, error } = await adminClient
      .from("workflow_import_sessions")
      .update(patch)
      .eq("id", existingId)
      .select()
      .maybeSingle();

    if (!error && data) return data;
  }

  const { data, error } = await adminClient
    .from("workflow_import_sessions")
    .insert({
      ...patch,
      created_at: nowIso(),
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

async function updateAutomationAfterScan(adminClient: any, product: any, session: any, result: any, blueprint: any, platform = "make") {
  if (!product?.id) return;
  const normalizedPlatform = sourcePlatform(platform);
  const label = platformLabel(normalizedPlatform);
  const generatedSetupFields = generatedSetupFieldsForSource(blueprint, result.generated_workflow_json, normalizedPlatform);
  const mergedSetup = mergeGeneratedSetupSchema(product.setup_schema, generatedSetupFields);

  const patch: Record<string, any> = {
    workflow_source_platform: normalizedPlatform,
    make_blueprint: blueprint,
    make_import_status: result.status,
    make_import_session_id: session.id,
    make_conversion_summary: result.summary,
    make_unresolved_modules: result.unresolved,
    updated_at: nowIso(),
  };

  if (mergedSetup.added.length) {
    patch.setup_schema = mergedSetup.schema;
    patch.n8n_last_import_result = {
      ...(asObject(product.n8n_last_import_result)),
      generated_setup_fields: mergedSetup.added,
      generated_setup_source: `${normalizedPlatform}_workflow`,
    };
  }

  if (result.generated_workflow_json && result.status === "converted") {
    patch.n8n_workflow_json = result.generated_workflow_json;
    patch.runtime_type = "n8n_managed";
    patch.n8n_import_status = "not_imported";
    patch.n8n_import_error = null;
    patch.n8n_last_test_status = "not_tested";
    patch.n8n_last_test_error = null;
    patch.n8n_last_test_result = null;
    patch.n8n_last_tested_at = null;
    patch.health_status = "needs_recheck";
    patch.health_failure_reason = `${label} workflow converted. Import it and run a fresh technical check before publishing.`;
    patch.health_failure_details = {
      workflow_converted: true,
      source_platform: normalizedPlatform,
      at: nowIso(),
    };
    patch.health_next_check_at = null;
  }

  const { error } = await adminClient
    .from("automations")
    .update(patch)
    .eq("id", product.id);

  if (error) throw new Error(error.message);

  return {
    setup_schema: patch.setup_schema || product.setup_schema || [],
    generated_setup_fields: mergedSetup.added,
  };
}

async function runScan(adminClient: any, operator: OperatorContext, body: any) {
  const automationId = cleanString(body.automation_id);
  const product = await loadAutomation(adminClient, operator, automationId);
  if (automationId && !product) throw new Error("Product not found or access denied.");

  const normalizedPlatform = sourcePlatform(body.source_platform || body.platform || product?.workflow_source_platform || "make");
  const label = platformLabel(normalizedPlatform);
  const blueprint = safeBlueprint(body.blueprint || product?.make_blueprint, normalizedPlatform);
  const modules = collectSourceModules(blueprint, normalizedPlatform);
  if (!modules.length) {
    throw new Error(`Nexus could not find ${label} steps in this JSON. Use a JSON object with a trigger/steps array or app/action step objects.`);
  }
  const groups = groupModules(modules, normalizedPlatform);
  const mappings = await loadMappings(adminClient, operator, normalizedPlatform);
  const { resolved, unresolved } = summarizeGroups(groups, mappings);
  const status = unresolved.length ? "needs_substitutes" : "converted";
  const generatedWorkflow = status === "converted" && product
    ? buildN8nWorkflow(product, groups, mappings, normalizedPlatform)
    : null;
  const summary = makeSummary(modules, groups, resolved, unresolved);
  const result = {
    source_platform: normalizedPlatform,
    status,
    summary,
    modules,
    groups,
    resolved,
    unresolved,
    generated_workflow_json: generatedWorkflow,
  };

  let session = null;
  let productPatchResult: any = null;
  if (product?.id) {
    session = await upsertImportSession(adminClient, operator, product, blueprint, result, normalizedPlatform);
    productPatchResult = await updateAutomationAfterScan(adminClient, product, session, result, blueprint, normalizedPlatform);
  }

  return {
    session,
    source_platform: normalizedPlatform,
    ...result,
    setup_schema: productPatchResult?.setup_schema || product?.setup_schema || [],
    generated_setup_fields: productPatchResult?.generated_setup_fields || [],
    message: unresolved.length
      ? `${label} workflow scanned. Add HTTP substitutes or request Nexus support for unresolved step groups.`
      : `${label} workflow converted into n8n workflow JSON. Import and run the technical test next.`,
  };
}

async function loadSession(adminClient: any, operator: OperatorContext, sessionId: string) {
  const { data, error } = await adminClient
    .from("workflow_import_sessions")
    .select("*, automations(*)")
    .eq("id", sessionId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("Import session not found.");
  if (data.automation_id && !canAccessAutomation(operator, data.automations)) {
    throw new Error("You cannot access this import session.");
  }
  return data;
}

async function getImportSession(adminClient: any, operator: OperatorContext, body: any) {
  const automationId = cleanString(body.automation_id);
  const product = automationId ? await loadAutomation(adminClient, operator, automationId) : null;
  const sessionId = cleanString(body.session_id || product?.make_import_session_id);
  const productPlatform = sourcePlatform(body.source_platform || body.platform || product?.workflow_source_platform || "make");
  const productLabel = platformLabel(productPlatform);

  if (!sessionId) {
    return {
      session: null,
      status: product?.make_import_status || "not_started",
      summary: product?.make_conversion_summary || {},
      resolved: [],
      unresolved: product?.make_unresolved_modules || [],
      message: `No ${productLabel} import session is linked to this product yet.`,
    };
  }

  const session = await loadSession(adminClient, operator, sessionId);
  const unresolved = asArray(session.unresolved_groups);
  const label = platformLabel(session.source_platform || productPlatform);

  return {
    session: { id: session.id },
    source_platform: sourcePlatform(session.source_platform || productPlatform),
    status: session.status,
    summary: session.module_summary || {},
    resolved: asArray(session.resolved_groups),
    unresolved,
    generated_workflow_json: session.generated_workflow_json || null,
    message: unresolved.length
      ? `${label} workflow scanned. Add or edit HTTP substitutes for unresolved step groups.`
      : `${label} workflow converted. Draft HTTP substitutes remain editable until the workflow test passes.`,
  };
}

async function saveHttpSubstitute(adminClient: any, operator: OperatorContext, body: any) {
  const session = await loadSession(adminClient, operator, cleanString(body.session_id));
  const normalizedPlatform = sourcePlatform(session.source_platform || body.source_platform || "make");
  const label = platformLabel(normalizedPlatform);
  const sourceModuleKey = normalizeModuleKey(body.source_module_key);
  const unresolved = asArray(session.unresolved_groups);
  const group = unresolved.find((item) => item.source_module_key === sourceModuleKey)
    || asArray(session.resolved_groups).find((item) => item.source_module_key === sourceModuleKey);

  if (!group) throw new Error(`Unsupported ${label} step group was not found in this import session.`);

  const httpTemplate = normalizeHttpTemplate({
    ...body.http_template,
    source_app: group.source_app,
  });
  const credentialRequirements = credentialRequirementsFromTemplate(httpTemplate);
  const developerId = operator.profile.role === "developer" ? operator.developer?.id : session.developer_id;
  const scope = operator.profile.role === "admin" ? "admin" : "developer";

  const mappingPatch = {
    source_platform: normalizedPlatform,
    source_app: group.source_app,
    source_module: group.source_module,
    source_action: group.source_action,
    source_module_key: sourceModuleKey,
    target_strategy: "http_request",
    target_n8n_node_type: "n8n-nodes-base.httpRequest",
    target_operation: "request",
    http_template: httpTemplate,
    credential_requirements: credentialRequirements,
    confidence: "medium",
    status: "draft",
    scope,
    developer_id: developerId || null,
    created_by: operator.profile.id,
    updated_by: operator.profile.id,
    notes: cleanString(body.notes),
    updated_at: nowIso(),
  };

  const { data: existing } = await adminClient
    .from("workflow_node_mappings")
    .select("*")
    .eq("source_platform", normalizedPlatform)
    .eq("source_module_key", sourceModuleKey)
    .eq("created_by", operator.profile.id)
    .neq("status", "disabled")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let mapping;
  if (existing?.id) {
    const { data, error } = await adminClient
      .from("workflow_node_mappings")
      .update(mappingPatch)
      .eq("id", existing.id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    mapping = data;
  } else {
    const { data, error } = await adminClient
      .from("workflow_node_mappings")
      .insert({
        ...mappingPatch,
        created_at: nowIso(),
      })
      .select()
      .single();
    if (error) throw new Error(error.message);
    mapping = data;
  }

  const { error: supportUpdateError } = await adminClient
    .from("workflow_import_support_requests")
    .update({
      status: "resolved",
      resolution_mapping_id: mapping.id,
      updated_by: operator.profile.id,
      updated_at: nowIso(),
    })
    .eq("import_session_id", session.id)
    .eq("source_module_key", sourceModuleKey)
    .in("status", ["open", "in_review"]);

  if (supportUpdateError) {
    console.warn(`Could not resolve ${label} import support request:`, supportUpdateError.message);
  }

  const product = session.automations;
  const rerun = await runScan(adminClient, operator, {
    automation_id: product?.id,
    blueprint: session.source_blueprint,
    source_platform: normalizedPlatform,
  });

  return {
    mapping,
    ...rerun,
    message: rerun.unresolved?.length
      ? `HTTP substitute saved. Resolve the remaining ${label} step groups before importing.`
      : `HTTP substitute saved and ${label} workflow converted. Import and run the technical test next.`,
  };
}

async function requestSupport(adminClient: any, operator: OperatorContext, body: any) {
  const session = await loadSession(adminClient, operator, cleanString(body.session_id));
  const normalizedPlatform = sourcePlatform(session.source_platform || body.source_platform || "make");
  const label = platformLabel(normalizedPlatform);
  const sourceModuleKey = normalizeModuleKey(body.source_module_key);
  const group = asArray(session.unresolved_groups).find((item) => item.source_module_key === sourceModuleKey);
  if (!group) throw new Error(`Unsupported ${label} step group was not found in this import session.`);

  const row = {
    import_session_id: session.id,
    automation_id: session.automation_id,
    developer_id: session.developer_id,
    source_platform: normalizedPlatform,
    source_module_key: sourceModuleKey,
    source_app: group.source_app,
    source_module: group.source_module,
    source_action: group.source_action,
    source_module_label: group.source_module_label,
    usage_count: group.usage_count || 1,
    dev_notes: cleanString(body.notes),
    status: "open",
    created_by: operator.profile.id,
    updated_by: operator.profile.id,
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  const { data, error } = await adminClient
    .from("workflow_import_support_requests")
    .insert(row)
    .select()
    .single();

  if (error) throw new Error(error.message);

  await adminClient
    .from("workflow_import_sessions")
    .update({
      status: "support_requested",
      updated_by: operator.profile.id,
      updated_at: nowIso(),
    })
    .eq("id", session.id);

  await adminClient
    .from("automations")
    .update({
      make_import_status: "support_requested",
      updated_at: nowIso(),
    })
    .eq("id", session.automation_id);

  try {
    await adminClient.from("admin_notifications").insert({
      notification_type: "make_import_support",
      title: `${label} import support requested`,
      message: `${session.automations?.title || "A product"} needs a ${label} step mapping for ${group.source_module_label || group.source_module}.`,
      status: "unread",
      metadata: {
        support_request_id: data.id,
        import_session_id: session.id,
        automation_id: session.automation_id,
        source_module_key: sourceModuleKey,
      },
      created_at: nowIso(),
    });
  } catch (error) {
    console.warn(`Could not create ${label} import notification:`, error);
  }

  return {
    request: data,
    message: "Nexus support request sent. Admin can create the reusable mapping from the request.",
  };
}

async function validateSuccessfulMappings(adminClient: any, operator: OperatorContext, body: any) {
  const product = await loadAutomation(adminClient, operator, cleanString(body.automation_id));
  if (!product) throw new Error("Product not found or access denied.");
  const normalizedPlatform = sourcePlatform(body.source_platform || body.platform || product.workflow_source_platform || "make");
  const label = platformLabel(normalizedPlatform);

  const passed = ["passed", "passed_with_expected_test_callback_error"].includes(lower(product.n8n_last_test_status));
  if (!passed) {
    return {
      promoted_count: 0,
      message: `Workflow test has not passed yet, so ${label} HTTP substitutes were not made reusable.`,
    };
  }

  const sessionId = cleanString(product.make_import_session_id);
  if (!sessionId) {
    return {
      promoted_count: 0,
      message: `No ${label} import session is linked to this product.`,
    };
  }

  const session = await loadSession(adminClient, operator, sessionId);
  const mappingIds = asArray(session.resolved_groups)
    .filter((group) => cleanString(group.target_strategy) === "http_request")
    .map((group) => cleanString(group.mapping_id))
    .filter((id) => id && !id.startsWith("builtin:"));

  if (!mappingIds.length) {
    return {
      promoted_count: 0,
      message: `No reusable HTTP substitutes needed validation for this ${label} import.`,
    };
  }

  const { data, error } = await adminClient
    .from("workflow_node_mappings")
    .update({
      status: "validated",
      scope: "global",
      confidence: "high",
      validated_by_automation_id: product.id,
      last_validated_at: nowIso(),
      updated_by: operator.profile.id,
      updated_at: nowIso(),
    })
    .eq("source_platform", normalizedPlatform)
    .in("id", mappingIds)
    .select("id");

  if (error) throw new Error(error.message);

  return {
    promoted_count: data?.length || 0,
    message: `${data?.length || 0} ${label} substitute mapping${data?.length === 1 ? "" : "s"} validated for reuse.`,
  };
}

async function listSupportRequests(adminClient: any, operator: OperatorContext, body: any) {
  if (operator.profile.role !== "admin") throw new Error("Admin access required.");

  const platformFilter = cleanString(body.source_platform || body.platform);
  let query = adminClient
    .from("workflow_import_support_requests")
    .select("*, automations(id, title, slug), developers(id, display_name, handle)")
    .order("created_at", { ascending: false })
    .limit(200);

  if (body.status) {
    query = query.eq("status", cleanString(body.status));
  }
  if (platformFilter) {
    query = query.eq("source_platform", sourcePlatform(platformFilter));
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return {
    requests: data || [],
  };
}

async function listMappings(adminClient: any, operator: OperatorContext, body: any = {}) {
  if (operator.profile.role !== "admin") throw new Error("Admin access required.");
  const rawPlatformFilter = cleanString(body.source_platform || body.platform);

  let query = adminClient
    .from("workflow_node_mappings")
    .select("*, developers(id, display_name, handle)")
    .order("updated_at", { ascending: false })
    .limit(500);

  if (rawPlatformFilter && rawPlatformFilter !== "all") {
    query = query.eq("source_platform", sourcePlatform(rawPlatformFilter));
  }

  const { data, error } = await query;

  if (error) throw new Error(error.message);
  return { mappings: data || [] };
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
      message: "make-import-assistant is alive.",
      converter_locations: MAKE_KNOWN_CONVERTER_LOCATIONS.length,
      zapier_converter_locations: ZAPIER_KNOWN_CONVERTER_LOCATIONS.length,
      common_external_apps: MAKE_COMMON_EXTERNAL_APPS.length,
      zapier_common_external_apps: ZAPIER_COMMON_EXTERNAL_APPS.length,
      common_external_actions: MAKE_COMMON_EXTERNAL_ACTIONS.length,
      zapier_common_external_actions: ZAPIER_COMMON_EXTERNAL_ACTIONS.length,
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed.", 405);
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
      return errorResponse("Missing Supabase function secrets.", 500);
    }

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { operator, error: authError } = await requireOperator(req, adminClient);

    if (authError || !operator) {
      return errorResponse(authError || "Access required.", 401);
    }

    const body = await req.json().catch(() => ({}));
    const action = cleanString(body.action || "scan");

    let result;
    if (action === "scan") {
      result = await runScan(adminClient, operator, body);
    } else if (action === "get_session") {
      result = await getImportSession(adminClient, operator, body);
    } else if (action === "save_http_substitute") {
      result = await saveHttpSubstitute(adminClient, operator, body);
    } else if (action === "request_support") {
      result = await requestSupport(adminClient, operator, body);
    } else if (action === "validate_successful_mappings") {
      result = await validateSuccessfulMappings(adminClient, operator, body);
    } else if (action === "list_support_requests") {
      result = await listSupportRequests(adminClient, operator, body);
    } else if (action === "list_mappings") {
      result = await listMappings(adminClient, operator, body);
    } else {
      return errorResponse("Unknown import assistant action.", 400);
    }

    return jsonResponse({
      ok: true,
      ...result,
    });
  } catch (error) {
    console.error(error);

    const message = error instanceof Error ? error.message : "Could not run import assistant.";
    const schemaMissing = /workflow_node_mappings|workflow_import_sessions|workflow_import_support_requests|schema cache|relation .* does not exist|could not find/i.test(message);

    return errorResponse(
      schemaMissing
        ? `${message} Run supabase/make_import_assistant_install_or_patch.sql in the Supabase SQL editor, then redeploy make-import-assistant.`
        : message,
      schemaMissing ? 500 : 400,
    );
  }
});
