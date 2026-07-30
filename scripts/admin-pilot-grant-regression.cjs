const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`Pilot grant regression failed: ${message}`);
  }
}

function includesAll(source, markers, label) {
  for (const marker of markers) {
    assert(source.includes(marker), `${label} is missing: ${marker}`);
  }
}

const endpoint = read("supabase/functions/admin-pilot-grants/index.ts");
const setupEndpoint = read("supabase/functions/submit-automation-setup/index.ts");
const dashboard = read("pages/buyer/dashboard.html");
const adminPage = read("pages/admin/pilot-grants.html");
const adminOrders = read("pages/admin/orders.html");
const nexusDb = read("assets/js/nexus-db.js");
const nexusUi = read("assets/js/nexus-ui.js");

includesAll(endpoint, [
  'const PILOT_PRICE_SOURCE = "admin_pilot"',
  'const PILOT_MODES = new Set(["buyer_setup", "output_only"])',
  'lowerString(profile?.role) !== "admin"',
  '.eq("role", "buyer")',
  'lowerString(product.status) !== "live"',
  'pilotReadinessIssue(product)',
  '.eq("price_source", PILOT_PRICE_SOURCE)',
  '.eq("payment_status", "paid")',
  'install_type: outputOnly ? "admin_managed_pilot" : "self_serve"',
  'setup_status: outputOnly ? "admin_managed" : "setup_required"',
  "const setupNotes = note;",
  "const compatiblePayload = { ...payload }",
  '"runtime_no_change_policy"',
  "delete compatiblePayload[key]",
  ".insert(compatiblePayload)",
  'price_display: "Complimentary pilot"',
  'stripe_mode: "payment"',
  'stripe_amount_total: 0',
  'stripe_unit_amount: 0',
  'price_source: PILOT_PRICE_SOURCE',
  'event_type: "pilot_product_granted"',
  '.delete()',
  '.eq("id", order.id)',
  '.eq("buyer_id", buyerId)',
  '.eq("automation_id", automationId)',
], "admin pilot endpoint");

const customerAutomationPayloadBlock = endpoint.slice(
  endpoint.indexOf("function customerAutomationPayload"),
  endpoint.indexOf("async function createCustomerAutomation"),
);

for (const optionalColumn of [
  "runtime_type:",
  "runtime_trigger_mode:",
  "runtime_webhook_url:",
  "runtime_webhook_path:",
  "runtime_output_mode:",
  "runtime_no_change_policy:",
  "runtime_response_mode:",
  "n8n_workflow_id:",
  "n8n_workflow_name:",
  "run_frequency:",
  "schedule_status:",
]) {
  assert(!customerAutomationPayloadBlock.includes(optionalColumn), `core pilot insert must omit optional column ${optionalColumn}`);
}

assert(
  !endpoint.includes('stripe_mode: "subscription"'),
  "pilot endpoint must never create a Stripe subscription",
);
assert(
  !endpoint.includes("stripe_subscription_id:"),
  "pilot endpoint must never assign a Stripe subscription id",
);
assert(
  !endpoint.includes('payment_environment: "pilot"'),
  "pilot endpoint must use only established database values",
);

includesAll(setupEndpoint, [
  'lowerString(value) === "admin_managed_pilot"',
  "if (adminManagedPilot && !isAdmin)",
  "This pilot is managed by Nexus. Your output will appear in the dashboard when it is ready.",
], "setup privacy guard");

includesAll(dashboard, [
  "function isNexusPilot(item)",
  "function pilotBuyerNote(item)",
  "Note from Nexus",
  "nexusPilot && latestOutput",
  "Review your pilot",
  "function isAdminManagedPilot(item)",
  'if (isAdminManagedPilot(item)) return "";',
  'if (isAdminManagedPilot(item)) return "none";',
  'label: "Pilot being prepared"',
  'primaryAction: "No action needed"',
  'if (actionKind === "none")',
  'setupUrl && !["setup", "none"].includes(primaryActionKind)',
  'if (isAdminManagedPilot(item)) return "Managed by Nexus";',
], "buyer dashboard");

assert(
  (dashboard.match(/setupUrl && !\["setup", "none"\]\.includes\(primaryActionKind\)/g) || []).length === 2,
  "both buyer card and detail setup links must be suppressed for output-only pilots",
);

includesAll(adminPage, [
  'data-admin-page="pilot-grants"',
  'value="buyer_setup"',
  'value="output_only"',
  "NexusDB.requireAdmin()",
  "NexusDB.listAdminPilotGrants()",
  "NexusDB.createAdminPilotGrant",
  "No Stripe charge, subscription, renewal, invoice, developer payout, or cancellation request is created.",
  "Open setup & run",
], "admin pilot page");

includesAll(adminOrders, [
  "let requestedOrderOpened = false;",
  'new URLSearchParams(location.search).get("order_id")',
  'safeLower(value) === "admin_managed_pilot"',
  '"Pilot setup on behalf"',
  "openRequestedOrder();",
], "admin orders deep link");

includesAll(nexusDb, [
  "price_source,",
  "setup_notes,",
  "async function listAdminPilotGrants()",
  "async function createAdminPilotGrant(payload = {})",
  '"admin-pilot-grants"',
  "listAdminPilotGrants,",
  "createAdminPilotGrant,",
], "frontend database wrapper");

includesAll(nexusUi, [
  '{ id: "pilot-grants", label: "Pilot Grants", href: "/pages/admin/pilot-grants.html" }',
], "admin navigation");

const staffAllowedBlock = nexusUi.slice(
  nexusUi.indexOf("const staffAllowedIds"),
  nexusUi.indexOf("const sections =", nexusUi.indexOf("const staffAllowedIds")),
);
assert(
  !staffAllowedBlock.includes('"pilot-grants"'),
  "pilot grants must remain owner-admin only",
);

console.log("Admin pilot grant regression passed.");
