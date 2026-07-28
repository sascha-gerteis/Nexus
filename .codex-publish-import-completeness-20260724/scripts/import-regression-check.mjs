import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const failures = [];
const passes = [];

const outputSelectionModule = await import(pathToFileURL(path.join(
  root,
  "supabase/functions/_shared/nexus-output-selection.ts",
)).href);
const credentialModule = await import(pathToFileURL(path.join(
  root,
  "supabase/functions/_shared/nexus-credentials.ts",
)).href);
const {
  buildBuyerOutputBodyParameters,
  selectBuyerOutputNode,
} = outputSelectionModule;
const {
  credentialCarriersForWorkflow,
  detectWorkflowCredentialSlots,
  encryptCredentialPayload,
  httpCredentialReferenceHint,
  syncCredentialToN8n,
} = credentialModule;

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
async function asyncScenario(name, fn) {
  try {
    await fn();
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
const sheetAccessSql = read("supabase/sheet_access_modes_install_or_patch.sql");
const scheduledRunner = read("supabase/functions/run-scheduled-automations/index.ts");
const submitSetupFunction = read("supabase/functions/submit-automation-setup/index.ts");
const runtimeSubmitOutput = read("supabase/functions/runtime-submit-output/index.ts");
const provisionWorkflow = read("supabase/functions/provision-customer-workflow/index.ts");
const pythonRunner = read("python-runner/app/main.py");
const stripeWebhook = read("supabase/functions/stripe-webhook/index.ts");

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
  assert(developerCredentials.includes("const manualNativeBinding = liveWorkflow ? manualNativeBindingFromSlot(slot) : null;"), "Dashboard scan may only trust native n8n account IDs from the live hosted workflow.");
  assert(developerCredentials.includes("product.n8n_normalized_workflow_json"), "Dashboard scan must keep uploaded/normalized workflow JSON separate from live hosted workflow scans.");
  assert(credentialsShared.includes("until the key is saved and synced from the Nexus credential manager"), "Shared binder must warn that uploaded n8n credential IDs are not portable.");
  assert(importFunction.includes("allowExistingNativeN8nCredentials: false"), "Initial imports must never trust credential IDs embedded in uploaded JSON.");
  assert(credentialsShared.includes("nativeAccountSetupRequired &&"), "Only true native OAuth/account credentials may preserve an editor-selected n8n ID.");
  assert(credentialsShared.includes('type === "googleapi" || type === "openaiapi"'), "OpenAI API-key credentials must stay eligible for automatic resync and stale-ID recreation.");
  assert(credentialsShared.includes("return credentialDeveloperId === productDeveloperId;"), "Shared binding candidates must belong to the product developer.");
  assert(developerCredentials.includes("return credentialDeveloperId === productDeveloperId;"), "Developer scans must expose only the product developer's saved credentials.");
  assert(!credentialsShared.includes('credentialDeveloperId === productDeveloperId ||\n      (!credentialDeveloperId && cleanString(credential.owner_role) === "admin")'), "Developer products must not fall back to Nexus/admin credentials.");
});

scenario("Credential scanner traces Set/Edit Fields API key carriers into HTTP nodes", () => {
  assert(credentialsShared.includes("credentialCarriersForWorkflow"), "Shared scanner must collect credential-like fields from Set/Edit Fields/Code nodes.");
  assert(credentialsShared.includes("httpCredentialReferenceHint"), "Shared scanner must detect HTTP nodes that reference upstream credential fields.");
  assert(credentialsShared.includes("httpCompatibleCredentialPreset"), "HTTP API calls must use HTTP-compatible n8n credential families.");
  assert(credentialsShared.includes('n8nCredentialType: "httpBearerAuth"'), "HTTP OpenAI/Apify-style calls must be able to map to bearer credentials.");
  assert(credentialsShared.includes('n8nCredentialType: "httpQueryAuth"'), "HTTP Gemini-style query API keys must be able to map to query credentials.");
  assert(credentialsShared.includes('provider === "apify"'), "Apify URL-token workflows must be coerced to query-auth credentials.");
  assert(credentialsShared.includes("stripCredentialQueryParametersFromUrl"), "Credential apply must strip token query parameters from HTTP URLs.");
  assert(credentialsShared.includes('type === "httpqueryauth"'), "n8n credential sync must create HTTP query-auth credential payloads.");
  assert(credentialsShared.includes("inferred_from_parameter_reference"), "Detected slots must mark upstream parameter-reference credentials.");
  assert(credentialsShared.includes("credential_source_fields"), "Detected slots must keep the source field names that carried credentials.");
  assert(credentialsShared.includes("credential_source_nodes"), "Detected slots must keep the upstream source nodes that carried credentials.");
  assert(credentialsShared.includes("usesFieldCredentialBinding"), "Field-token workflows must have an explicit field credential binding mode.");
  assert(credentialsShared.includes('credential_binding_mode: "field"'), "Field-token workflows must bind in Nexus without rewriting node Authorization.");
  assert(credentialsShared.includes("!fieldCredentialBinding && sourceNodes"), "Field-token workflows must not scrub the source field that carries the token.");
  assert(credentialsShared.includes("scrubCredentialCarrierAssignments"), "Credential apply must scrub raw key values from upstream carrier nodes.");
  assert(credentialsShared.includes("removeCredentialLikeHttpParameters"), "Credential apply must remove raw credential headers/query params from HTTP nodes.");
});

scenario("Nexus dynamic placeholders always import as real n8n expressions", () => {
  assert(importFunction.includes('if (!output.includes("Nexus Runtime Context")) return output;'), "Expression guard must detect every injected Nexus runtime reference.");
  assert(importFunction.includes("if (isCodeParameterKey(childKey)) return output;"), "Code-node placeholders must remain valid direct JavaScript accessors.");
  assert(importFunction.includes('if (output.trimStart().startsWith("=")) return output;'), "Expression guard must avoid double-prefixing existing n8n expressions.");
  assert(importFunction.includes("return `=${output}`;"), "Every non-code runtime placeholder must be imported in n8n expression mode.");
  assert(importFunction.includes('requestedSource === "setup" && isLikelyCredentialPlaceholderKey(key)'), "Token-like setup aliases must route to the secrets bucket.");
  assert(importFunction.includes('type === "SETUP" && isLikelyCredentialPlaceholderKey(name)'), "Detected NEXUS_SETUP token aliases must generate credential fields instead of plain setup fields.");
});

scenario("Native OpenAI model credentials are treated as openAiApi, not generic HTTP", () => {
  assert(credentialsShared.includes('credentialType = "openAiApi"'), "Native OpenAI model slots must force openAiApi credential type.");
  assert(credentialsShared.includes('type === "openaiapi"'), "OpenAI credential sync must have an openAiApi payload branch.");
  assert(credentialsShared.includes("apiKey: openAiApiKey"), "OpenAI credential payload must send apiKey.");
  assert(credentialsShared.includes("https://api.openai.com/v1"), "OpenAI credential payload should include the default base URL.");
});

scenario("Credential scanner traces provider-specific dynamic Set fields", () => {
  const setNode = {
    name: "Inputs",
    type: "n8n-nodes-base.set",
    parameters: {
      assignments: {
        assignments: [{
          name: "apify_token",
          value: '={{ $("Nexus Runtime Context").first().json.secrets.apify_token }}',
        }],
      },
    },
  };
  const httpNode = {
    name: "Run Apify",
    type: "n8n-nodes-base.httpRequest",
    parameters: {
      method: "POST",
      url: "=https://api.apify.com/v2/acts/example/runs?token={{$json.apify_token}}",
    },
  };
  const workflow = {
    nodes: [setNode, httpNode],
    connections: {
      Inputs: { main: [[{ node: "Run Apify", type: "main", index: 0 }]] },
    },
  };

  const carriers = credentialCarriersForWorkflow(workflow.nodes);
  const hint = httpCredentialReferenceHint(httpNode, carriers);
  const slots = detectWorkflowCredentialSlots(workflow);

  assert(carriers.has("apify_token"), "Provider-specific <provider>_token fields must be recognized as credential carriers.");
  assert(hint?.detected_from === "upstream_credential_field", "HTTP credential references must trace to the upstream Set node.");
  assert(hint?.fields?.includes("apify_token"), "Credential reference must keep the exact source field.");
  assert(slots.length === 1 && slots[0].provider === "apify", "Dynamic Apify token must create exactly one Apify slot.");
  assert(slots[0].inferred_from_parameter_reference === true, "Dynamic token slot must use field binding instead of rewriting unrelated auth fields.");
});

await asyncScenario("Native API and OAuth accounts create valid n8n credential payloads", async () => {
  const secret = "nexus-regression-secret-credential-payload";
  const captures = [];
  const originalFetch = globalThis.fetch;
  const adminClient = {
    from() {
      return {
        update(patch) {
          return {
            eq() {
              return {
                select() {
                  return {
                    single: async () => ({ data: { id: "saved-credential", ...patch }, error: null }),
                  };
                },
              };
            },
          };
        },
      };
    },
  };

  globalThis.fetch = async (url, init = {}) => {
    captures.push({ url: String(url), body: JSON.parse(init.body || "{}") });
    return new Response(JSON.stringify({ id: `n8n-${captures.length}`, name: "Nexus test" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const fixtures = [
      {
        provider: "openai",
        type: "openAiApi",
        nodeType: "@n8n/n8n-nodes-langchain.lmChatOpenAi",
        fields: { api_key: "sk-regression" },
      },
      {
        provider: "gmail",
        type: "gmailOAuth2",
        nodeType: "n8n-nodes-base.gmail",
        fields: {
          client_id: "google-client",
          client_secret: "google-secret",
          refresh_token: "google-refresh",
        },
      },
    ];

    for (const fixture of fixtures) {
      const encryptedPayload = await encryptCredentialPayload(fixture.fields, secret);
      await syncCredentialToN8n({
        adminClient,
        credential: {
          id: `saved-${fixture.provider}`,
          provider: fixture.provider,
          label: `${fixture.provider} account`,
          encrypted_payload: encryptedPayload,
        },
        credentialSecret: secret,
        n8nBaseUrl: "https://n8n.invalid",
        n8nApiKey: "regression-key",
        slot: {
          provider: fixture.provider,
          provider_label: fixture.provider,
          node_name: "Credential node",
          node_type: fixture.nodeType,
          n8n_credential_type: fixture.type,
          credential_key: fixture.type,
        },
      });
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  const openAiPayload = captures.find((item) => item.body?.type === "openAiApi")?.body;
  const gmailPayload = captures.find((item) => item.body?.type === "gmailOAuth2")?.body;
  assert(openAiPayload?.data?.apiKey === "sk-regression", "Native OpenAI account must send apiKey in an openAiApi credential payload.");
  assert(openAiPayload?.nodesAccess?.[0]?.nodeType.includes("lmChatOpenAi"), "Native OpenAI account must be scoped to its model node type.");
  assert(gmailPayload?.data?.clientId === "google-client", "Gmail OAuth account must send clientId.");
  assert(gmailPayload?.data?.clientSecret === "google-secret", "Gmail OAuth account must send clientSecret.");
  assert(gmailPayload?.data?.oauthTokenData?.refresh_token === "google-refresh", "Gmail OAuth account must carry the refresh token in n8n's OAuth token data shape.");
});

scenario("Buyer output selection prefers HTML/files over plain text", () => {
  const workflow = {
    nodes: [
      { name: "Trigger", type: "n8n-nodes-base.webhook", parameters: {} },
      { name: "Plain text output", type: "n8n-nodes-base.set", position: [700, 0], parameters: { text: "Short text" } },
      { name: "HTML Preview", type: "n8n-nodes-base.html", position: [500, 100], parameters: { html: "<!doctype html><html><body><h1>Buyer report</h1></body></html>" } },
    ],
    connections: {
      Trigger: {
        main: [[
          { node: "Plain text output", type: "main", index: 0 },
          { node: "HTML Preview", type: "main", index: 0 },
        ]],
      },
    },
  };

  const selection = selectBuyerOutputNode(workflow);
  assert(selection.node?.name === "HTML Preview", `Expected HTML output, selected ${selection.node?.name || "nothing"}.`);

  const explicitWorkflow = {
    ...workflow,
    nodes: [...workflow.nodes, { name: "NEXUS_FINAL_OUTPUT", type: "n8n-nodes-base.set", parameters: { text: "Developer override" } }],
  };
  assert(selectBuyerOutputNode(explicitWorkflow).node?.name === "NEXUS_FINAL_OUTPUT", "Explicit final output marker must override scoring.");

  const ambiguous = selectBuyerOutputNode({
    nodes: [
      { name: "Transform A", type: "n8n-nodes-base.set", parameters: {} },
      { name: "Transform B", type: "n8n-nodes-base.set", parameters: {} },
    ],
    connections: {},
  });
  assert(ambiguous.node === null && ambiguous.ambiguous, "Ambiguous low-signal terminal branches must block import instead of guessing.");

  const bodyText = JSON.stringify(buildBuyerOutputBodyParameters());
  assert(bodyText.includes("$json.output?.html"), "Submit body must inspect nested output HTML.");
  assert(bodyText.includes("$json.result?.content_html"), "Submit body must inspect nested result HTML.");
  assert(bodyText.includes("$json.report?.file_url"), "Submit body must inspect nested report files.");
});

scenario("All supported import platforms use the rich-output contract", () => {
  assert(importFunction.includes("selectBuyerOutputNode"), "Direct n8n import must use the shared output selector.");
  assert(provisionWorkflow.includes("selectBuyerOutputNode"), "Customer workflow repair must use the same output selector.");
  assert(provisionWorkflow.includes("selectedSourceNode = findBestSubmitSourceNode"), "Existing customer workflow repairs must reselect and reconnect the rich output source.");
  assert(makeAssistant.includes('"NEXUS_FINAL_OUTPUT"'), "Make/Zapier conversion must emit an explicit final output node.");
  assert(makeAssistant.includes("candidates.sort((left, right) => score(right) - score(left))"), "Make/Zapier conversion must rank output candidates.");
  assert(makeAssistant.includes("value.content_html") && makeAssistant.includes("value.file_url"), "Make/Zapier conversion must prefer HTML and file outputs.");
  assert(pythonRunner.includes("def select_rich_output(value):"), "Python runner must select among multiple returned output candidates.");
  assert(pythonRunner.includes("def output_score(raw):"), "Python runner must score HTML/file/structured output richness.");
});
scenario("Developer credential reveal can safely refill edit forms", () => {
  const devDashboard = read("pages/developer/dashboard.html");

  assert(devDashboard.includes("revealedCredentials: {}"), "Dashboard state must keep short-lived revealed credential values.");
  assert(devDashboard.includes("function credentialSecretEditValues"), "Dashboard must map revealed backend secret fields back to editable form fields.");
  assert(devDashboard.includes("function fillCredentialSecretInputs"), "Dashboard must refill the credential form after a successful reveal.");
  assert(devDashboard.includes("Edit revealed credential"), "Reveal view must offer a direct edit action.");
  assert(devDashboard.includes("delete state.revealedCredentials"), "Saving credentials must clear stale revealed secret values from memory.");
});

scenario("Technical test data is explicit for external sheets/files/ranges", () => {
  const devDashboard = read("pages/developer/dashboard.html");
  const nexusDb = read("assets/js/nexus-db.js");
  const testWorkflow = read("supabase/functions/test-n8n-workflow/index.ts");

  assert(nexusDb.includes("getAutomationTestProfile"), "NexusDB must expose test profile reads.");
  assert(nexusDb.includes("saveAutomationTestProfile"), "NexusDB must expose test profile writes.");
  assert(devDashboard.includes("Technical test data"), "Developer dashboard must show the technical test data panel.");
  assert(devDashboard.includes("saveAutomationTestProfile"), "Developer dashboard must save product-specific technical test values.");
  assert(testWorkflow.includes("This workflow needs real technical test data"), "Technical test must fail early when real setup values are missing.");
  assert(testWorkflow.includes("spreadsheet"), "Technical test must recognize spreadsheet/sheet setup requirements.");
  assert(testWorkflow.includes("Google Sheets rejected the saved credential"), "Technical test must explain Google Sheets permission failures.");
});

scenario("Long n8n technical tests recover from frontend timeouts without weakening readiness", () => {
  const nexusDb = read("assets/js/nexus-db.js");
  const devDashboard = read("pages/developer/dashboard.html");
  const adminProductForm = read("pages/admin/product-form.html");
  const testWorkflow = read("supabase/functions/test-n8n-workflow/index.ts");

  assert(nexusDb.includes('code: timedOut ? "FUNCTION_TIMEOUT"'), "Function calls must expose a structured timeout code.");
  assert(nexusDb.includes("start_request_timed_out: true"), "Technical-test starts must recover after the browser request times out.");
  assert(nexusDb.includes("timeout_recovered_latest: true"), "Technical-test starts must read the latest persisted run after a timeout.");
  assert(nexusDb.includes('{ timeoutMs: 60000 }'), "Technical-test status checks must have a dedicated longer timeout.");
  assert(devDashboard.includes("!result.start_request_timed_out && !testResultUsedSavedProfile(result)"), "Developer UI may defer only the immediate profile assertion during explicit timeout recovery.");
  assert(adminProductForm.includes("!result.start_request_timed_out && !this.testResultUsesSavedProfile(result)"), "Admin UI may defer only the immediate profile assertion during explicit timeout recovery.");

  const startFunctionIndex = testWorkflow.indexOf("async function startTestRun");
  const profileIndex = testWorkflow.indexOf("const testProfile = await loadDefaultTestProfile", startFunctionIndex);
  const testRunInsertIndex = testWorkflow.indexOf(".insert({", profileIndex);
  const triggerIndex = testWorkflow.indexOf("triggerWorkflow(webhookUrl, automation, testRun, testProfile)", startFunctionIndex);
  const profileMetadataIndex = testWorkflow.indexOf("trigger_status: \"starting\"", startFunctionIndex);
  assert(startFunctionIndex >= 0 && profileIndex > startFunctionIndex, "n8n start path must load the saved test profile.");
  assert(profileIndex < testRunInsertIndex, "Saved test profile identity must be known before the test row is created.");
  assert(testRunInsertIndex < profileMetadataIndex && profileMetadataIndex < triggerIndex, "Saved profile proof must be persisted before the long n8n webhook request.");
  assert(testWorkflow.slice(triggerIndex - 120, triggerIndex).indexOf("loadDefaultTestProfile") === -1, "Saved test profile must not be loaded only after the test row is created.");
  assert(testWorkflow.includes('_stored_status_compatibility: "success"'), "Legacy test tables must persist successful terminal state instead of leaving a stale running row.");
  const compatibilityStart = testWorkflow.indexOf("if (existing && isPassingWorkflowTestStatus(requestedStatus))");
  const compatibilityEnd = testWorkflow.indexOf("if (!compatibilityError && compatible)", compatibilityStart);
  assert(compatibilityStart >= 0 && compatibilityEnd > compatibilityStart && !testWorkflow.slice(compatibilityStart, compatibilityEnd).includes("...updates"), "Legacy persistence fallback must use only confirmed core columns, not the full raw execution payload.");
  assert(testWorkflow.includes('const publicStatus = ["success", "completed"].includes(storedStatus) ? "passed" : testRun.status'), "Legacy success status must normalize back to the strict public passed state.");
});
scenario("Customer-owned HTTP credentials require real technical-test values", () => {
  const devDashboard = read("pages/developer/dashboard.html");
  const adminProductForm = read("pages/admin/product-form.html");
  const testWorkflow = read("supabase/functions/test-n8n-workflow/index.ts");

  assert(importFunction.includes('meta_token: "meta_access_token"'), "Importer must normalize Meta token aliases.");
  assert(importFunction.includes("customer_owned: true"), "Imported secret placeholders must be marked customer-owned.");
  assert(importFunction.includes("test_value_required: true"), "Imported customer credentials must require a technical-test value.");
  assert(devDashboard.includes("Customer credential test values"), "Developer test panel must render n8n customer credentials.");
  assert(devDashboard.includes('data-test-secret-saved="${hasSavedValue ? "true" : "false"}"'), "Developer test fields must record whether a secret is already saved.");
  assert(devDashboard.includes('${required && !hasSavedValue ? "required" : ""}'), "A saved test credential must not leave an empty required input that blocks product submission after reload.");
  assert(devDashboard.includes("The saved value will be reused. Enter a new value only to replace it."), "Developer test panel must explain that blank saved-secret fields preserve the existing value.");
  assert(adminProductForm.includes("Customer credential test values"), "Admin test panel must render n8n customer credentials.");
  assert(testWorkflow.includes("missingCredentialTestFields(credentialSchema, testProfile)"), "All workflow types must require saved real test credentials.");
});

scenario("Developer provider credentials stay out of buyer setup", () => {
  const buyerSetup = read("pages/buyer/setup.html");
  const nexusDb = read("assets/js/nexus-db.js");
  const developerProducts = read("supabase/functions/developer-products/index.ts");
  const submitSetup = read("supabase/functions/submit-automation-setup/index.ts");

  assert(developerProducts.includes('developer_owned: true'), "Python-inferred provider credentials must be marked developer-owned.");
  assert(developerProducts.includes('schema_source: "python_inference"'), "Python-inferred credentials must record their ownership source.");
  assert(buyerSetup.includes("if (devSlotMatches && !isKnownBuyerAccessCredential(field)) return false;"), "Buyer setup must hide credentials matched to detected developer slots.");
  assert(buyerSetup.includes("Scanned and unknown credentials remain internal until explicitly exposed."), "Unknown credential fields must default to internal, not buyer-owned.");
  assert(buyerSetup.includes("isKnownBuyerAccessCredential"), "Explicit buyer-owned Meta access must remain supported.");
  assert(nexusDb.includes("credential_schema, developer_credential_requirements, runtime_type"), "Buyer setup queries must include developer credential requirements.");
  assert(submitSetup.includes("buyerCredentialSchema("), "The setup API must filter credential fields server-side.");
  assert(submitSetup.includes("devSlotMatches && !isKnownBuyerAccessCredential(field)"), "The setup API must repair legacy provider fields marked customer-owned.");
});
scenario("Google Sheets access modes are only shown for sheet workflows and reach runtime payloads", () => {
  const devDashboard = read("pages/developer/dashboard.html");
  const devProducts = read("supabase/functions/developer-products/index.ts");
  const importWorkflow = read("supabase/functions/import-n8n-workflow/index.ts");
  const testWorkflow = read("supabase/functions/test-n8n-workflow/index.ts");
  const submitSetup = read("supabase/functions/submit-automation-setup/index.ts");
  const scheduledRunner = read("supabase/functions/run-scheduled-automations/index.ts");

  assert(devDashboard.includes("developerSheetAccessPanel"), "Developer dashboard must include the Google Sheets access panel.");
  assert(devDashboard.includes("workflowSheetNodes"), "Developer dashboard must detect Google Sheets nodes before showing sheet access options.");
  assert(devDashboard.includes("_nexus_sheet_access_config"), "Developer dashboard must persist sheet access config with product placeholders.");
  assert(devDashboard.includes("private_per_customer"), "Developer dashboard must expose private per-customer sheet mode.");
  assert(devProducts.includes("cleanSheetAccessConfig"), "Developer product API must normalize sheet access config.");
  assert(importWorkflow.includes("sheetAccessConfigForProduct"), "Importer must read sheet access config while normalizing workflows.");
  assert(importWorkflow.includes("nexus_dev_sheet_id"), "Importer must support developer-owned hidden sheet IDs.");
  assert(importWorkflow.includes("nexus_private_customer_sheet_id"), "Importer must support private per-customer sheet IDs.");
  assert(testWorkflow.includes("applySheetAccessSetup"), "Technical tests must inject hidden sheet setup values.");
  assert(submitSetup.includes("applySheetAccessSetup"), "Buyer setup submission must inject hidden sheet setup values.");
  assert(submitSetup.includes("copyGoogleSheetFromTemplate"), "Buyer setup submission must copy template sheets for private per-customer mode.");
  assert(submitSetup.includes("private_google_sheet_id"), "Buyer setup submission must store copied private sheet IDs.");
  assert(scheduledRunner.includes("applySheetAccessSetup"), "Scheduled monthly runs must inject hidden sheet setup values.");
  assert(sheetAccessSql.includes("private_google_sheet_id"), "Sheet access SQL must add copied private sheet storage.");
});

scenario("Importer uses full workflow replacement and keeps drafts inactive", () => {
  assert(importFunction.includes('method: "PUT"'), "Importer must use full PUT replacement for n8n workflows.");
  assert(importFunction.includes("replaceExistingWorkflow"), "Importer must replace stale existing workflows safely.");
  assert(importFunction.includes("deactivateDuplicateWorkflows"), "Importer must deactivate duplicates with matching names/webhook paths.");
  assert(importFunction.includes('workflow_state: shouldKeepActiveAfterImport ? "active" : "draft_inactive"'), "Importer must keep draft workflows inactive.");
  assert(importFunction.includes("n8n_last_test_status: \"not_tested\""), "Import must reset technical test status.");
});

scenario("Importer keeps Nexus runtime/output nodes wired with a JSON body", () => {
  assert(importFunction.includes("wrapWebhookWithRuntimeContext"), "Importer must preserve the original workflow path behind Nexus Runtime Context.");
  assert(importFunction.includes("collectMainTargets"), "Importer must collect existing webhook targets before rewiring.");
  assert(importFunction.includes("Nexus Submit Output"), "Importer must add the Nexus output callback node.");
  assert(importFunction.includes("buildBuyerOutputBodyParameters"), "Nexus output node must use the shared nested-output body mapper.");
  assert(importFunction.includes("sendBody: true"), "Nexus output node must send a body.");
  assert(importFunction.includes('bodyContentType: "json"'), "Nexus output node must send JSON.");
  assert(importFunction.includes('specifyBody: "keypair"'), "Nexus output node must use n8n keypair body parameters.");
  assert(importFunction.includes("customer_automation_id"), "Nexus output body must include customer_automation_id.");
  assert(importFunction.includes("runtime_secret"), "Nexus output headers must include runtime_secret.");
  assert(importFunction.includes("NEXUS_FINAL_OUTPUT"), "Importer must support a developer-marked final output node.");
  assert(importFunction.includes("removeMainConnectionTo(connections, attachToNodeName, \"Nexus Submit Output\")"), "Importer must avoid duplicate output-node connections.");
  assert(importFunction.includes("ensureMainConnection("), "Importer must connect final output into Nexus Submit Output.");
});

scenario("Setup schema is auto-generated before submission gates", () => {
  assert(importFunction.includes("autoAddMissingSchemaFieldsForWorkflow"), "Importer must auto-add missing setup schema fields.");
  assert(importFunction.includes("extractRuntimeSetupKeys"), "Importer must detect runtime setup references.");
  assert(importFunction.includes("inferMakeSetupKeysFromText"), "Importer must infer setup fields from Make/Zapier source text.");
  assert(developerProducts.includes("mergeMissingSetupFields"), "Developer submit gate must merge detected setup fields.");
});

scenario("Importer normalizes sloppy setup and credential placeholders", () => {
  assert(importFunction.includes("canonicalSecretKey"), "Importer must canonicalize typo-prone credential names.");
  assert(importFunction.includes("apify_toke"), "Importer must repair common Apify token typos.");
  assert(importFunction.includes("business_target_customer"), "Importer must normalize target customer setup aliases.");
  assert(importFunction.includes("extractLooseBarePlaceholders"), "Importer must infer schema fields from loose {{field}} placeholders.");
  assert(importFunction.includes("convertLooseBarePlaceholders"), "Importer must convert loose placeholders before n8n import.");
});

scenario("Make converter has broad mapping coverage and reusable substitute promotion", () => {
  const makeApps = extractArrayStrings(makeAssistant, "MAKE_COMMON_EXTERNAL_APPS");
  const makeActions = extractArrayStrings(makeAssistant, "MAKE_COMMON_EXTERNAL_ACTIONS");
  const makeOperationalCount = (makeAssistant.match(/operationalLocation\(\{\s*module:/g) || []).length;
  const estimatedMappings = makeOperationalCount + (makeApps.length * makeActions.length);

  assert(estimatedMappings >= 200, `Expected at least 200 Make mapping locations, found ${estimatedMappings}.`);
  assert(makeOperationalCount >= 50, `Expected at least 50 Make operational mappings, found ${makeOperationalCount}.`);
  assert(makeAssistant.includes('module: "flowcontrol:router"'), "Make mappings must include Router.");
  assert(makeAssistant.includes('target: "n8n-nodes-base.switch"'), "Make Router/Zapier Paths must point to n8n Switch.");
  assert(makeAssistant.includes('module: "flowcontrol:filter"'), "Make mappings must include Filter.");
  assert(makeAssistant.includes('target: "n8n-nodes-base.if"'), "Make/Zapier filters must point to n8n IF.");
  assert(makeAssistant.includes('module: "flowcontrol:iterator"'), "Make mappings must include Iterator.");
  assert(makeAssistant.includes('target: "n8n-nodes-base.splitOut"'), "Make/Zapier loops must point to Split Out/Loop equivalents.");
  assert(makeAssistant.includes('module: "flowcontrol:aggregator"'), "Make mappings must include Aggregator.");
  assert(makeAssistant.includes('target: "n8n-nodes-base.aggregate"'), "Make aggregators must point to n8n Aggregate.");
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
  assertContainsAll(zapierCore, ["webhooks by zapier", "formatter by zapier", "filter by zapier", "schedule by zapier", "paths by zapier", "looping by zapier", "delay by zapier", "sub-zap by zapier", "zapier interfaces"], "Zapier core mappings");
  assert(makeAssistant.includes("ZAPIER_OPERATIONAL_APP_MAPPINGS"), "Zapier operational mappings must be explicit.");
  assert(makeAssistant.includes('"paths by zapier"'), "Zapier mappings must include Paths.");
  assert(makeAssistant.includes('"delay by zapier"'), "Zapier mappings must include Delay.");
  assert(makeAssistant.includes('"looping by zapier"'), "Zapier mappings must include Looping.");
  assert(makeAssistant.includes('"formatter by zapier"'), "Zapier mappings must include Formatter.");
  assertContainsAll(zapierApps, ["openai", "google sheets", "slack", "hubspot", "salesforce", "airtable"], "Zapier app mappings");
  assertContainsAll(zapierActions, ["create record", "update record", "send message", "create chat completion", "api request"], "Zapier action mappings");
});

scenario("HTTP substitutes reject unsafe URLs and raw secrets", () => {
  assert(makeAssistant.includes("HTTP substitute URLs must use HTTPS."), "HTTP substitutes must require HTTPS.");
  assert(makeAssistant.includes("HTTP substitute URL cannot target localhost or private network addresses."), "HTTP substitutes must block private network URLs.");
  assert(makeAssistant.includes("Do not paste raw API keys into HTTP substitutes"), "HTTP substitutes must block literal API keys.");
  assert(makeAssistant.includes("credential vault"), "HTTP substitute errors should point developers to the credential vault.");
});

scenario("Credential system covers realistic launch provider families", () => {
  assertContainsAll(
    [
      "openAiApi",
      "httpBearerAuth",
      "httpQueryAuth",
      "apify",
      "googleApi",
      "googleSheetsOAuth2Api",
      "gmailOAuth2",
      "smtp",
      "telegramApi",
      "slackApi",
      "hubspotApi",
      "airtableTokenApi",
    ],
    [
      "openAiApi",
      "httpBearerAuth",
      "httpQueryAuth",
      "apify",
      "googleApi",
      "googleSheetsOAuth2Api",
      "gmailOAuth2",
      "smtp",
      "telegramApi",
      "slackApi",
      "hubspotApi",
      "airtableTokenApi",
    ],
    "Credential family fixture",
  );
  assert(credentialsShared.includes('n8nCredentialType: "openAiApi"'), "OpenAI native credentials must be detected.");
  assert(credentialsShared.includes('n8nCredentialType: "httpBearerAuth"'), "Bearer-token HTTP/API workflows must be detected.");
  assert(credentialsShared.includes('n8nCredentialType: "httpQueryAuth"'), "Query-token HTTP/API workflows must be detected.");
  assert(credentialsShared.includes('provider: "apify"'), "Apify workflows must be detected.");
  assert(credentialsShared.includes('n8nCredentialType: "googleApi"'), "Google service account workflows must be detected.");
  assert(credentialsShared.includes('n8nCredentialType: "googleSheetsOAuth2Api"'), "Google Sheets OAuth workflows must be detected.");
  assert(credentialsShared.includes('n8nCredentialType: "gmailOAuth2"'), "Gmail OAuth workflows must be detected.");
  assert(credentialsShared.includes('n8nCredentialType: "smtp"'), "SMTP email workflows must be detected.");
  assert(credentialsShared.includes('n8nCredentialType: "telegramApi"'), "Telegram alert workflows must be detected.");
  assert(credentialsShared.includes('n8nCredentialType: "slackApi"'), "Slack notification workflows must be detected.");
  assert(credentialsShared.includes('n8nCredentialType: "hubspotApi"'), "HubSpot workflows must be detected.");
  assert(credentialsShared.includes('n8nCredentialType: "airtableTokenApi"'), "Airtable workflows must be detected.");
  assert(credentialsShared.includes("credentialCarriersForWorkflow"), "Scanner must inspect Set/Edit Fields/Code credential carrier nodes.");
  assert(credentialsShared.includes("credential_source_fields"), "Scanner must remember upstream credential field names.");
  assert(credentialsShared.includes("scrubCredentialCarrierAssignments"), "Credential application must scrub raw keys from carrier nodes.");
});

scenario("Checkout and approval gates still require import/test for paid products", () => {
  assert(checkoutFunction.includes("isPassingWorkflowTest"), "Checkout must require a passing workflow test.");
  assert(checkoutFunction.includes("n8n_last_test_status"), "Checkout must check latest workflow test status.");
  assert(developerProducts.includes("Run a successful technical test before submitting"), "Developer submission must require successful technical test.");
  assert(developerProducts.includes("Import this workflow to Nexus n8n before submitting"), "Developer submission must require hosted n8n import.");
  assert(developerProducts.includes("Before submitting, use Save & run real test"), "Developer submission must require one saved real test for non-live products.");
  assert(developerProducts.includes("hasRealPassingWorkflowTest"), "Developer submission must distinguish real test profiles from placeholder tests.");
  assert(developerProducts.includes("used_test_profile"), "Developer submission must look for saved real test profile evidence.");
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

scenario("Runtime modes support one-time, recurring, and on-demand products end-to-end", () => {
  assert(developerProducts.includes("runtime_trigger_mode"), "Developer products must persist runtime trigger mode.");
  assert(developerProducts.includes("runtime_event_schema"), "Developer products must persist on-demand event schema.");
  assert(stripeWebhook.includes("normalizeRuntimeTriggerMode"), "Checkout webhook must copy runtime trigger mode to customer automations.");
  assert(stripeWebhook.includes("normalizeProductRunFrequency"), "Checkout webhook must copy runtime cadence to customer automations.");
  assert(submitSetupFunction.includes("runtimeScheduleUpdate"), "Self-serve setup must activate schedules by runtime mode.");
  assert(provisionWorkflow.includes("runtimeScheduleUpdate"), "Guided/admin provisioning must activate schedules by runtime mode.");
  assert(scheduledRunner.includes('frequency === "every_30_minutes"'), "Scheduler must support every-30-minute cadence.");
  assert(scheduledRunner.includes('.not("run_frequency", "in", "(manual,on_demand)")'), "Scheduler must not run manual/on-demand products as timed products.");
  assert(scheduledRunner.includes("buyerOwnsCandidate"), "On-demand runs must be scoped to the buyer's own automation.");
  assert(scheduledRunner.includes("body.event || body.request || body.input"), "On-demand runs must accept event/request payloads.");
});

scenario("Customer-facing runtime failures route to the right owner", () => {
  assert(submitSetupFunction.includes("credentialLike && !webhookRegistrationLike"), "Setup submission must classify credential webhook errors before generic n8n/webhook review.");
  assert(submitSetupFunction.includes("WORKFLOW_RUNTIME_REVIEW_REQUIRED"), "Setup submission must keep missing webhook/runtime errors as Nexus review items.");
  assert(runtimeSubmitOutput.includes('"forbidden"'), "Runtime callback must classify forbidden provider responses as credential/setup problems.");
  assert(runtimeSubmitOutput.includes('"invalid_grant"'), "Runtime callback must classify OAuth grant failures.");
  assert(runtimeSubmitOutput.includes('"token has expired"'), "Runtime callback must classify token expiry variants.");
  assert(runtimeSubmitOutput.includes("needs_customer_action: classification.needs_customer_action"), "Runtime callback must persist customer-action state.");
  assert(scheduledRunner.includes("classifyRuntimeStartError"), "Scheduled/manual runner must classify runtime start failures.");
  assert(scheduledRunner.includes("CUSTOMER_CREDENTIAL_INVALID"), "Scheduled/manual runner must mark customer credential failures.");
  assert(scheduledRunner.includes("CUSTOMER_SETUP_INVALID"), "Scheduled/manual runner must mark customer setup failures.");
  assert(scheduledRunner.includes("needs_customer_action: classification.needsCustomerAction"), "Scheduled/manual runner must persist customer-action state.");
});

console.log("");
console.log(`Import regression scenarios: ${passes.length} passed, ${failures.length} failed.`);

if (failures.length) {
  process.exitCode = 1;
}
