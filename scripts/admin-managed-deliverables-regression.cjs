const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(`Admin managed deliverables regression failed: ${message}`);
}

function includesAll(source, markers, label) {
  for (const marker of markers) assert(source.includes(marker), `${label} is missing: ${marker}`);
}

function compileInlineScripts(source, filename) {
  const scripts = [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((script) => script.trim());
  for (const script of scripts) new vm.Script(script, { filename });
}

const endpoint = read("supabase/functions/managed-deliverables/index.ts");
const bucketMigration = read("supabase/migrations/20260819000100_admin_buyer_deliverables.sql");
const collectionMigration = read("supabase/migrations/20260819000200_buyer_output_collections.sql");
const config = read("supabase/config.toml");
const adminPage = read("pages/admin/deliverables.html");
const buyerOutput = read("pages/buyer/output.html");
const buyerDashboard = read("pages/buyer/dashboard.html");
const nexusDb = read("assets/js/nexus-db.js");
const nexusUi = read("assets/js/nexus-ui.js");
const adminDashboard = read("pages/admin/dashboard.html");
const headers = read("_headers");

includesAll(endpoint, [
  'const BUCKET = "buyer-deliverables"',
  "const MAX_FILE_SIZE = 50 * 1024 * 1024",
  "const VIEW_TTL_SECONDS = 15 * 60",
  'lowerString(profile?.role) === "admin"',
  'action === "create_collection"',
  'action === "sign_output_file"',
  'action === "create_upload"',
  'action === "publish"',
  '.from("buyer_output_collections")',
  '.from("buyer_managed_deliverables")',
  '.from("customer_automations")',
  'async function publishCollectionDelivery(',
  'async function publishProductDelivery(',
  'const expectedPrefix = `${customerAutomation.buyer_id}/${customerAutomation.id}/`',
  '.from("automation_outputs")',
  '.from("automation_events")',  'const expectedPrefix = `${collection.buyer_id}/collections/${collection.id}/`',
  "createSignedUploadUrl(path)",
  "safeEnqueueOutputReadyEmail",
  "view_url: urls.viewUrl",
  "download_url: urls.downloadUrl",
  "Backward compatibility for files delivered before independent collections existed.",
], "managed-deliverables function");

assert(!/getPublicUrl|public:s*true/.test(endpoint), "private files must never use public URLs or a public bucket");
assert(!/stripe|checkout|refund|subscription_id/i.test(endpoint), "admin delivery must not enter payment or Stripe logic");
const collectionPublish = endpoint.slice(endpoint.indexOf("async function publishCollectionDelivery"), endpoint.indexOf("async function publishProductDelivery"));
const productPublish = endpoint.slice(endpoint.indexOf("async function publishProductDelivery"), endpoint.indexOf("async function publishDelivery"));
assert(!collectionPublish.includes('.from("automation_outputs")'), "standalone collection delivery must stay isolated from product outputs");
assert(productPublish.includes('.from("automation_outputs")') && productPublish.includes(".insert(outputPayload)"), "existing-product delivery must append a real product output");
assert(productPublish.includes('.from("automation_events")'), "existing-product delivery must add a buyer-visible product event");
for (const table of ["customer_automations", "orders", "automations"]) {
  const marker = `.from("${table}")`;
  let cursor = endpoint.indexOf(marker);
  while (cursor >= 0) {
    const accessWindow = endpoint.slice(cursor, cursor + 240);
    assert(![".insert(", ".update(", ".upsert(", ".delete("].some((mutation) => accessWindow.includes(mutation)), `${table} must stay read-only in file delivery`);
    cursor = endpoint.indexOf(marker, cursor + marker.length);
  }
}
assert(!/automation_runs|bundle_run_attempts|bundle_run_items/.test(endpoint), "file delivery must not enter workflow or bundle runtime records");
includesAll(bucketMigration, ["'buyer-deliverables'", "false, 52428800", "set public = false"], "private storage migration");
includesAll(collectionMigration, [
  "create table if not exists public.buyer_output_collections",
  "create table if not exists public.buyer_managed_deliverables",
  "buyer_id = auth.uid() and archived_at is null",
  "buyer_id = auth.uid() and status = 'published'",
  "revoke insert, update, delete on public.buyer_output_collections from anon, authenticated",
  "revoke insert, update, delete on public.buyer_managed_deliverables from anon, authenticated",
  "grant select on public.buyer_output_collections to authenticated",
  "grant select on public.buyer_managed_deliverables to authenticated",
], "independent collection migration");
assert(config.includes("[functions.managed-deliverables]"), "function config entry is missing");

includesAll(nexusDb, [
  "function normalizeManagedDeliverableRow(row = {})",
  "async function listBuyerManagedDeliverables()",
  "async function listBuyerManagedDeliverablesForCollection(collectionId)",
  "async function getBuyerManagedDeliverable(outputId)",
  "return getBuyerManagedDeliverable(outputId);",
  "async function createAdminManagedDeliverableCollection(payload = {})",
  "async function createAdminManagedDeliverableUpload(target = {}, file)",
  'collection_id: target?.collection_id || ""',
  'customer_automation_id: target?.customer_automation_id || ""',
  "Choose exactly one output destination.",
  ".uploadToSignedUrl(upload.path, upload.token, file",
  "createAdminManagedDeliverableCollection,",
  "listBuyerManagedDeliverables,",
], "browser database wrapper");

includesAll(adminPage, [
  'data-admin-page="deliverables"',
  "NexusDB.requireAdmin()",
  "NexusDB.createAdminManagedDeliverableCollection",
  "NexusDB.createAdminManagedDeliverableUpload(target,file)",
  "customer_automation_id:automation.id",
  "collection_id:collection.id",
  'value="product" checked',
  'value="collection"',
  "Existing product",
  "Standalone collection",
  "+ Create a new output collection",
  "No runtime side effects",], "admin delivery page");
assert(!/NexusDB\.(?:createStripeCheckoutSession|requestAutomationCancellation|runScheduledAutomation|submitAutomationSetup|provisionCustomerWorkflow)/.test(adminPage), "admin page must not call payment, setup, provisioning, or runtime APIs");
assert(adminPage.includes("deliverableAutomation") && adminPage.includes("deliverableCollection"), "admin page must expose both product and collection destinations");

includesAll(buyerOutput, [
  "function renderManagedFilePreview(output, viewUrl = \"\")",
  "managed-file-preview-image",
  "PDF preview",
  "Your browser cannot preview this video.",
  "Your browser cannot preview this audio.",
  "function enableOfficePreview()",
  "window.confirm(\"PowerPoint, Word, and Excel previews are provided by Microsoft Office.",
  "managedOfficePreviewFrame",
  "NexusDB.listBuyerManagedDeliverablesForCollection(collectionId)",
  "signedFile?.view_url",
  "Download original",
], "buyer output reader");
const previewRenderer = buyerOutput.slice(buyerOutput.indexOf("function renderManagedFilePreview"), buyerOutput.indexOf("function developerName"));
assert(!previewRenderer.includes("view.officeapps.live.com"), "Office preview must not contact Microsoft before explicit buyer confirmation");
assert(!/src="https:\/\/view\.officeapps\.live\.com/.test(buyerOutput), "Office iframe must not have an automatic external src");
assert(!/getPublicUrl/.test(buyerOutput), "buyer output reader must not create a public storage URL");
assert(headers.includes("frame-src 'self' https://view.officeapps.live.com"), "CSP must allow only the consent-gated Office viewer frame");

includesAll(buyerDashboard, [
  "NexusDB.listBuyerManagedDeliverables()",
  "...(managedOutputs || [])",
  "function outputManagedCollection(output = {})",
  "managed-collection:${managedCollection.id}",
  'category: "Nexus collection"',
  "if (outputIsAdminDelivered(output) && outputManagedCollection(output).id) return true;",
  "Output groups",
], "buyer dashboard");

includesAll(nexusUi, ['{ id: "deliverables", label: "Deliver Files", href: "/pages/admin/deliverables.html" }'], "admin navigation");
assert(adminDashboard.includes("Deliver presentations and files"), "admin dashboard entry point is missing");

compileInlineScripts(adminPage, "admin-deliverables.html");
compileInlineScripts(buyerOutput, "buyer-output.html");
compileInlineScripts(buyerDashboard, "buyer-dashboard.html");
new vm.Script(nexusDb, { filename: "nexus-db.js" });
new vm.Script(nexusUi, { filename: "nexus-ui.js" });

console.log("Admin managed deliverables regression passed.");
