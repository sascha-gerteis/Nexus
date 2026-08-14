import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const credentials = await import(pathToFileURL(path.join(
  root,
  "supabase/functions/_shared/nexus-credentials.ts",
)).href);

const workflow = {
  nodes: [
    {
      name: "Read Existing Leads",
      type: "n8n-nodes-base.googleSheets",
      parameters: { authentication: "serviceAccount" },
      credentials: { googleApi: { id: "service-account", name: "Google Service Account" } },
    },
    {
      name: "Google Places Text Search",
      type: "n8n-nodes-base.httpRequest",
      parameters: {
        url: "https://maps.googleapis.com/maps/api/place/textsearch/json",
        sendQuery: true,
        queryParameters: { parameters: [{ name: "key", value: "={{ $json.google_places_api_key }}" }] },
      },
    },
    {
      name: "Place Details",
      type: "n8n-nodes-base.httpRequest",
      parameters: {
        url: "https://maps.googleapis.com/maps/api/place/details/json",
        sendQuery: true,
        queryParameters: { parameters: [{ name: "key", value: "={{ $json.google_places_api_key }}" }] },
      },
    },
  ],
  connections: {},
};

const slots = credentials.detectWorkflowCredentialSlots(workflow);
const sheets = slots.filter((slot) => slot.node_name === "Read Existing Leads");
const places = slots.filter((slot) => ["Google Places Text Search", "Place Details"].includes(slot.node_name));

if (sheets.length !== 1 || sheets[0].n8n_credential_type !== "googleApi") {
  throw new Error("Google Sheets service-account detection changed unexpectedly.");
}
if (places.length !== 2) throw new Error(`Expected two Google Places query-key slots, found ${places.length}.`);
for (const slot of places) {
  if (slot.provider !== "google_maps_api_key" || slot.n8n_credential_type !== "httpQueryAuth") {
    throw new Error(`${slot.node_name} was not classified as a Google Maps query API key.`);
  }
  if (credentials.credentialMatchScore({ provider: "google_service_account", n8n_credential_type: "googleApi" }, slot) !== 0) {
    throw new Error("Google Service Account incorrectly satisfies a Google Places query-key slot.");
  }
  if (credentials.credentialMatchScore({ provider: "google_maps_api_key", n8n_credential_type: "httpQueryAuth" }, slot) <= 0) {
    throw new Error("Google Maps query key does not satisfy its detected Places slot.");
  }
}
if (credentials.credentialMatchScore({ provider: "google_maps_api_key", n8n_credential_type: "httpQueryAuth" }, sheets[0]) !== 0) {
  throw new Error("Google Maps query key incorrectly satisfies the Sheets service-account slot.");
}
if (credentials.providerPreset("httpQueryAuth")?.provider !== "query_api_key") {
  throw new Error("Generic httpQueryAuth no longer resolves to the generic query API key provider.");
}
if (credentials.providerPreset("maps.googleapis.com")?.provider !== "google_maps_api_key") {
  throw new Error("Google Maps host no longer resolves to the Google Maps API-key provider.");
}

const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const worker = read("supabase/functions/process-runtime-dispatch-backlog/index.ts");
const ingress = read("supabase/functions/buyer-webhook-ingress/index.ts");
const buyerPage = read("pages/buyer/webhook-setup.html");
const developerPage = read("pages/developer/dashboard.html");
const adminPage = read("pages/admin/credentials.html");

for (const [source, marker, label] of [
  [worker, 'cleanString(queue.dispatch_origin).toLowerCase() === "buyer_webhook"', "webhook setup-less dispatch fallback"],
  [ingress, 'existingEvent?.status === "succeeded" && config.live_enabled !== true', "pre-live duplicate boundary"],
  [buyerPage, "Live workflow tester", "live workflow tester label"],
  [buyerPage, "Uses 1 run", "live run allowance disclosure"],
  [buyerPage, "Live workflow run queued", "live run confirmation"],
  [developerPage, '["query_api_key", "Generic Query API Key", "httpQueryAuth"]', "developer query-key option"],
  [adminPage, '["query_api_key", "Generic Query API Key", "httpQueryAuth"]', "admin query-key option"],
]) {
  if (!source.includes(marker)) throw new Error(`Missing ${label}.`);
}

console.log(JSON.stringify({
  google_sheets_service_account_slots: sheets.length,
  google_places_query_key_slots: places.length,
  setup_less_webhook_dispatch: true,
  pre_live_test_does_not_block_live_run: true,
  buyer_live_test_discloses_usage: true,
  passed: true,
}));
