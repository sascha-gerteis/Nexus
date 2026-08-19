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
  'const expectedPrefix = `${collection.buyer_id}/collections/${collection.id}/`',
  "createSignedUploadUrl(path)",
  "safeEnqueueOutputReadyEmail",
  "view_url: urls.viewUrl",
  "download_url: urls.downloadUrl",
  "Backward compatibility for files delivered before independent collections existed.",
], "managed-deliverables function");

assert(!/getPublicUrl|public:\s*true/.test(endpoint), "private files must never use public URLs or a public bucket");
assert(!/stripe|checkout|refund|subscription_id/i.test(endpoint), "admin delivery must not enter payment or Stripe logic");
assert(!/\.from\("(?:orders|customer_automations|automations|automation_runs|bundle_run_attempts|bundle_run_items)"\)/.test(endpoint), "collection delivery must not read or mutate product, order, workflow, run, or bundle records");
assert(!/\.from\("automation_outputs"\)[\s\S]{0,200}\.(?:insert|update|upsert|delete)\(/.test(endpoint), "legacy automation outputs must be read-only compatibility data");

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
  "async function createAdminManagedDeliverableUpload(collectionId, file)",
  "collection_id: collectionId",
  ".uploadToSignedUrl(upload.path, upload.token, file",
  "createAdminManagedDeliverableCollection,",
  "listBuyerManagedDeliverables,",
], "browser database wrapper");

includesAll(adminPage, [
  'data-admin-page="deliverables"',
  "NexusDB.requireAdmin()",
  "NexusDB.createAdminManagedDeliverableCollection",
  "NexusDB.createAdminManagedDeliverableUpload(collection.id,file)",
  "collection_id:collection.id",
  "+ Create a new output collection",
  "It is not a marketplace product, purchase, automation, or workflow.",
  "No platform side effects",
], "admin delivery page");
assert(!/NexusDB\.(?:createStripeCheckoutSession|requestAutomationCancellation|runScheduledAutomation|submitAutomationSetup|provisionCustomerWorkflow)/.test(adminPage), "admin page must not call payment, setup, provisioning, or runtime APIs");
assert(!/deliverableAutomation|customer_automation_id/.test(adminPage), "admin page must not require or submit a customer automation");

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
