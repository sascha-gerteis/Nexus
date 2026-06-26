import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const failures = [];
const passes = [];

function read(relPath) {
  return fs.readFileSync(path.join(root, relPath), "utf8");
}

function readJson(relPath) {
  return JSON.parse(read(relPath));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function scenario(name, fn) {
  try {
    fn();
    passes.push(name);
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL ${name}`);
    console.error(`  ${error.message}`);
  }
}

function clean(value) {
  return String(value || "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function allNodes(workflow) {
  assert(workflow && typeof workflow === "object", "Workflow must be an object.");
  assert(Array.isArray(workflow.nodes), "Workflow must have a nodes array.");
  return workflow.nodes;
}

function nodeType(node) {
  return lower(node?.type);
}

function isHttpNode(node) {
  return nodeType(node).includes("httprequest");
}

function isWebhookNode(node) {
  return nodeType(node).includes("webhook");
}

function credentialRefs(workflow) {
  const refs = [];
  for (const node of allNodes(workflow)) {
    const credentials = node.credentials && typeof node.credentials === "object"
      ? node.credentials
      : {};

    for (const [key, value] of Object.entries(credentials)) {
      refs.push({
        node: node.name || "Unnamed node",
        nodeType: node.type || "",
        key,
        id: clean(value?.id),
        name: clean(value?.name),
      });
    }
  }
  return refs;
}

function responseFormatValue(node) {
  const parameters = node.parameters || {};
  return lower(
    parameters.responseFormat ||
      parameters.options?.response?.responseFormat ||
      parameters.options?.responseFormat,
  );
}

function assertWebsiteFetchIsText(workflow) {
  const fetchNodes = allNodes(workflow).filter((node) => (
    isHttpNode(node) &&
    /fetch|website|html|page/i.test(`${node.name || ""} ${JSON.stringify(node.parameters || {})}`)
  ));

  assert(fetchNodes.length > 0, "Expected at least one HTTP website/page fetch node.");

  for (const node of fetchNodes) {
    if (/api\.openai|generativelanguage|anthropic|slack|hubspot|salesforce/i.test(JSON.stringify(node.parameters || {}))) {
      continue;
    }

    const value = responseFormatValue(node);
    assert(
      ["string", "text"].includes(value),
      `${node.name || "HTTP node"} should use text/string response format for HTML fetches, found "${value || "default"}".`,
    );
  }
}

function assertNoPortableCredentialIds(workflow) {
  const bad = credentialRefs(workflow).filter((ref) => ref.id && !["", "test", "placeholder"].includes(lower(ref.id)));
  assert(
    bad.length === 0,
    `Template should not carry portable n8n credential IDs: ${bad.map((ref) => `${ref.node}:${ref.key}:${ref.id}`).join(", ")}`,
  );
}

function extractArrayStrings(source, constantName) {
  const start = source.indexOf(`const ${constantName} = [`);
  assert(start >= 0, `Could not find ${constantName}.`);

  const openIndex = source.indexOf("[", start);
  let depth = 0;
  let endIndex = -1;

  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i];
    if (char === "[") depth += 1;
    if (char === "]") depth -= 1;
    if (depth === 0) {
      endIndex = i;
      break;
    }
  }

  assert(endIndex > openIndex, `Could not parse ${constantName}.`);
  const body = source.slice(openIndex + 1, endIndex);
  return [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

function assertContainsAll(collection, required, label) {
  const set = new Set(collection.map(lower));
  const missing = required.filter((item) => !set.has(lower(item)));
  assert(!missing.length, `${label} missing: ${missing.join(", ")}`);
}

const importFunction = read("supabase/functions/import-n8n-workflow/index.ts");
const credentialsShared = read("supabase/functions/_shared/nexus-credentials.ts");
const developerCredentials = read("supabase/functions/developer-credentials/index.ts");
const makeAssistant = read("supabase/functions/make-import-assistant/index.ts");
const developerProducts = read("supabase/functions/developer-products/index.ts");
const checkoutFunction = read("supabase/functions/create-checkout-session/index.ts");

scenario("Direct n8n OpenAI HTTP workflow template is import-safe", () => {
  const workflow = readJson("workflow-templates/monthly-competitor-website-brief-nexus.workflow.json");
  const nodes = allNodes(workflow);

  assert(nodes.some((node) => nodeType(node).includes("manualtrigger")), "Expected raw template to include a replaceable manual trigger.");
  assert(nodes.filter(isWebhookNode).length === 0, "Raw template should let Nexus add the webhook trigger.");
  assert(JSON.stringify(workflow).includes("NEXUS_CODE_SETUP"), "Expected Nexus setup placeholders.");
  assertWebsiteFetchIsText(workflow);
  assertNoPortableCredentialIds(workflow);
});

scenario("Direct n8n Gemini HTTP workflow template is import-safe", () => {
  const workflow = readJson("workflow-templates/monthly-competitor-website-brief-gemini-nexus.workflow.json");
  const nodes = allNodes(workflow);

  assert(nodes.some((node) => nodeType(node).includes("manualtrigger")), "Expected raw template to include a replaceable manual trigger.");
  assert(nodes.filter(isWebhookNode).length === 0, "Raw template should let Nexus add the webhook trigger.");
  assert(JSON.stringify(workflow).includes("NEXUS_CODE_SETUP"), "Expected Nexus setup placeholders.");
  assertWebsiteFetchIsText(workflow);
  assertNoPortableCredentialIds(workflow);
});

scenario("Stale imported n8n credential IDs cannot mark a product ready", () => {
  assert(credentialsShared.includes("removeCredentialReferencesForErrors"), "Shared binder must strip dead credential references on errors.");
  assert(!credentialsShared.includes("manualNativeN8nBindingFromSlot"), "Shared binder must not trust imported native n8n credential IDs.");
  assert(!developerCredentials.includes("manualNativeBindingFromSlot"), "Dashboard scan must not mark manual imported native IDs as bound.");
  assert(!developerCredentials.includes("manual_n8n_credential: true"), "Dashboard scan must not create manual native bindings from uploaded JSON.");
});

scenario("Native OpenAI model credentials are treated as openAiApi, not generic HTTP", () => {
  assert(credentialsShared.includes('credentialType = "openAiApi"'), "Native OpenAI model slots must force openAiApi credential type.");
  assert(credentialsShared.includes('type === "openaiapi"'), "OpenAI credential sync must have an openAiApi payload branch.");
  assert(credentialsShared.includes("apiKey: openAiApiKey"), "OpenAI credential payload must send apiKey.");
  assert(credentialsShared.includes("https://api.openai.com/v1"), "OpenAI credential payload should include the default base URL.");
});

scenario("Importer uses full workflow replacement and keeps drafts inactive", () => {
  assert(importFunction.includes('method: "PUT"'), "Importer must use full PUT replacement for n8n workflows.");
  assert(importFunction.includes("replaceExistingWorkflow"), "Importer must replace stale existing workflows safely.");
  assert(importFunction.includes("deactivateDuplicateWorkflows"), "Importer must deactivate duplicates with matching names/webhook paths.");
  assert(importFunction.includes('workflow_state: shouldKeepActiveAfterImport ? "active" : "draft_inactive"'), "Importer must keep draft workflows inactive.");
  assert(importFunction.includes("n8n_last_test_status: \"not_tested\""), "Import must reset technical test status.");
});

scenario("Setup schema is auto-generated before submission gates", () => {
  assert(importFunction.includes("autoAddMissingSchemaFieldsForWorkflow"), "Importer must auto-add missing setup schema fields.");
  assert(importFunction.includes("extractRuntimeSetupKeys"), "Importer must detect runtime setup references.");
  assert(importFunction.includes("inferMakeSetupKeysFromText"), "Importer must infer setup fields from Make/Zapier source text.");
  assert(developerProducts.includes("mergeMissingSetupFields"), "Developer submit gate must merge detected setup fields.");
});

scenario("Make converter has broad mapping coverage and reusable substitute promotion", () => {
  const makeApps = extractArrayStrings(makeAssistant, "MAKE_COMMON_EXTERNAL_APPS");
  const makeActions = extractArrayStrings(makeAssistant, "MAKE_COMMON_EXTERNAL_ACTIONS");
  const makeInternal = extractArrayStrings(makeAssistant, "MAKE_INTERNAL_LOGIC_MODULE_KEYS");
  const estimatedMappings = makeInternal.length + (makeApps.length * makeActions.length);

  assert(estimatedMappings >= 200, `Expected at least 200 Make mapping locations, found ${estimatedMappings}.`);
  assertContainsAll(makeApps, ["openai", "google-gemini", "anthropic", "slack", "hubspot", "salesforce", "airtable"], "Make app mappings");
  assertContainsAll(makeActions, ["create-record", "update-record", "send-message", "create-chat-completion", "make-an-api-call"], "Make action mappings");
  assert(makeAssistant.includes("Workflow test has not passed yet"), "Make reusable mappings must wait for successful technical test.");
});

scenario("Zapier converter has core and external mapping coverage", () => {
  const zapierCore = extractArrayStrings(makeAssistant, "ZAPIER_CORE_APP_MAPPINGS");
  const zapierApps = extractArrayStrings(makeAssistant, "ZAPIER_COMMON_EXTERNAL_APPS");
  const zapierActions = extractArrayStrings(makeAssistant, "ZAPIER_COMMON_EXTERNAL_ACTIONS");
  const estimatedMappings = (zapierCore.length * 2) + (zapierApps.length * zapierActions.length);

  assert(estimatedMappings >= 200, `Expected at least 200 Zapier mapping locations, found ${estimatedMappings}.`);
  assertContainsAll(zapierCore, ["webhooks by zapier", "formatter by zapier", "filter by zapier", "schedule by zapier"], "Zapier core mappings");
  assertContainsAll(zapierApps, ["openai", "google sheets", "slack", "hubspot", "salesforce", "airtable"], "Zapier app mappings");
  assertContainsAll(zapierActions, ["create record", "update record", "send message", "create chat completion", "api request"], "Zapier action mappings");
});

scenario("HTTP substitutes reject unsafe URLs and raw secrets", () => {
  assert(makeAssistant.includes("HTTP substitute URLs must use HTTPS."), "HTTP substitutes must require HTTPS.");
  assert(makeAssistant.includes("HTTP substitute URL cannot target localhost or private network addresses."), "HTTP substitutes must block private network URLs.");
  assert(makeAssistant.includes("Do not paste raw API keys into HTTP substitutes"), "HTTP substitutes must block literal API keys.");
  assert(makeAssistant.includes("credential vault"), "HTTP substitute errors should point developers to the credential vault.");
});

scenario("Checkout and approval gates still require import/test for paid products", () => {
  assert(checkoutFunction.includes("isPassingWorkflowTest"), "Checkout must require a passing workflow test.");
  assert(checkoutFunction.includes("n8n_last_test_status"), "Checkout must check latest workflow test status.");
  assert(developerProducts.includes("Run a successful technical test before submitting"), "Developer submission must require successful technical test.");
  assert(developerProducts.includes("Import this workflow to Nexus n8n before submitting"), "Developer submission must require hosted n8n import.");
});

scenario("Make and Zapier source selections do not show plain n8n upload as the only path", () => {
  const devDashboard = read("pages/developer/dashboard.html");
  const adminForm = read("pages/admin/product-form.html");

  assert(devDashboard.includes('option value="make"'), "Developer dashboard must expose Make import mode.");
  assert(devDashboard.includes('option value="zapier"'), "Developer dashboard must expose Zapier import mode.");
  assert(adminForm.includes('option value="make"'), "Admin form must expose Make import mode.");
  assert(adminForm.includes('option value="zapier"'), "Admin form must expose Zapier import mode.");
  assert(devDashboard.includes("Upload a Zapier-style workflow JSON"), "Developer dashboard must explain Zapier import.");
  assert(devDashboard.includes("Upload a Make blueprint"), "Developer dashboard must explain Make import.");
});

console.log("");
console.log(`Import regression scenarios: ${passes.length} passed, ${failures.length} failed.`);

if (failures.length) {
  process.exitCode = 1;
}
