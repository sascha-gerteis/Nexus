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
const migration = read("supabase/migrations/20260819000100_admin_buyer_deliverables.sql");
const config = read("supabase/config.toml");
const adminPage = read("pages/admin/deliverables.html");
const buyerOutput = read("pages/buyer/output.html");
const buyerDashboard = read("pages/buyer/dashboard.html");
const nexusDb = read("assets/js/nexus-db.js");
const nexusUi = read("assets/js/nexus-ui.js");
const adminDashboard = read("pages/admin/dashboard.html");

includesAll(endpoint, [
  'const BUCKET = "buyer-deliverables"',
  "const MAX_FILE_SIZE = 50 * 1024 * 1024",
  'lowerString(profile?.role) === "admin"',
  'action === "sign_output_file"',
  'action === "create_upload"',
  'action === "publish"',
  "createSignedUploadUrl(path)",
  'public: false',
  'const expectedPrefix = `${customerAutomation.buyer_id}/${customerAutomation.id}/`',
  'source: "admin_manual"',
  'created_by: "admin"',
  'event_type: "admin_deliverable_published"',
  "safeEnqueueOutputReadyEmail",
  ".createSignedUrl(",
  '!isOwnerAdmin(actor.profile) && output.buyer_id !== actor.user.id',
], "managed-deliverables function");

assert(!/getPublicUrl|public:\s*true/.test(endpoint), "private files must never use public URLs or a public bucket");
assert(!/stripe|checkout|refund|subscription_id/i.test(endpoint), "admin delivery must not enter payment or Stripe logic");
assert(
  !/\.from\("(?:orders|customer_automations|automations|automation_runs|bundle_run_attempts|bundle_run_items)"\)\s*\.(?:insert|update|upsert|delete)\(/m.test(endpoint),
  "admin delivery must not mutate product, order, workflow, run, or bundle records",
);

includesAll(migration, [
  "'buyer-deliverables'",
  "public, file_size_limit",
  "false, 52428800",
  "set public = false",
], "private storage migration");
assert(config.includes("[functions.managed-deliverables]"), "function config entry is missing");

includesAll(nexusDb, [
  "async function listAdminManagedDeliverables()",
  "async function createAdminManagedDeliverableUpload(customerAutomationId, file)",
  ".uploadToSignedUrl(upload.path, upload.token, file",
  "async function publishAdminManagedDeliverable(payload = {})",
  "async function signManagedDeliverableOutput(outputId)",
  "listAdminManagedDeliverables,",
  "createAdminManagedDeliverableUpload,",
  "publishAdminManagedDeliverable,",
  "signManagedDeliverableOutput,",
], "browser database wrapper");

includesAll(adminPage, [
  'data-admin-page="deliverables"',
  "NexusDB.requireAdmin()",
  "NexusDB.listAdminManagedDeliverables()",
  "NexusDB.createAdminManagedDeliverableUpload(automation.id, file)",
  "NexusDB.publishAdminManagedDeliverable({",
  "Existing outputs remain unchanged.",
  "No payment changes",
  "private file",
], "admin delivery page");
assert(!/NexusDB\.(?:createStripeCheckoutSession|requestAutomationCancellation|runScheduledAutomation|submitAutomationSetup|provisionCustomerWorkflow)/.test(adminPage), "admin page must not call payment, setup, provisioning, or runtime APIs");

includesAll(buyerOutput, [
  "function adminDeliveryMeta(output)",
  'String(meta.source || "") === "admin_manual"',
  "NexusDB.signManagedDeliverableOutput(output.id)",
  "signedFile?.download_url",
  "Private Nexus delivery",
  "Open or download file",
  '${adminDelivered ? "Delivered by" : "Built by"}',
], "buyer output reader");
assert(!/getPublicUrl/.test(buyerOutput), "buyer output reader must not create a public storage URL");

includesAll(buyerDashboard, [
  "function outputIsAdminDelivered(output = {})",
  "if (outputIsAdminDelivered(output)) return true;",
  'developerName: outputIsAdminDelivered(output) ? "Nexus"',
  'context.category === "Bundle output" && output.customer_automation_id && !outputIsAdminDelivered(output)',
], "buyer dashboard");

includesAll(nexusUi, [
  '{ id: "deliverables", label: "Deliver Files", href: "/pages/admin/deliverables.html" }',
], "admin navigation");
assert(adminDashboard.includes("Deliver presentations and files"), "admin dashboard entry point is missing");

compileInlineScripts(adminPage, "admin-deliverables.html");
compileInlineScripts(buyerOutput, "buyer-output.html");
compileInlineScripts(buyerDashboard, "buyer-dashboard.html");
new vm.Script(nexusDb, { filename: "nexus-db.js" });
new vm.Script(nexusUi, { filename: "nexus-ui.js" });

console.log("Admin managed deliverables regression passed.");