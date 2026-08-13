import fs from "node:fs/promises";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const outputDir = "C:/Users/sascha.g/Desktop/nexus-phase1-final/outputs/buyer-webhook-acceptance-20260812";
const workbook = Workbook.create();
const dashboard = workbook.worksheets.add("Launch Dashboard");
const tests = workbook.worksheets.add("Acceptance Tests");
const setup = workbook.worksheets.add("Product Setup");
const requests = workbook.worksheets.add("Request Examples");
const log = workbook.worksheets.add("Run Log");

const navy = "#14263F";
const blue = "#2563EB";
const paleBlue = "#EAF2FF";
const green = "#138A5B";
const paleGreen = "#E8F7F0";
const red = "#C43A46";
const paleRed = "#FDECEE";
const amber = "#B56A00";
const paleAmber = "#FFF4D8";
const slate = "#64748B";
const paleSlate = "#F3F6FA";
const border = "#DCE5F0";
const white = "#FFFFFF";

function titleBand(sheet, range, title, subtitle) {
  sheet.getRange(range).merge();
  const anchor = range.split(":")[0];
  sheet.getRange(anchor).values = [[`${title}\n${subtitle}`]];
  sheet.getRange(range).format = {
    fill: navy,
    font: { color: white, bold: true, size: 17 },
    wrapText: true,
    verticalAlignment: "center",
  };
  sheet.getRange(range).format.rowHeight = 34;
}

function header(range) {
  range.format = {
    fill: blue,
    font: { color: white, bold: true },
    verticalAlignment: "center",
    wrapText: true,
    borders: { preset: "outside", style: "thin", color: blue },
  };
  range.format.rowHeight = 28;
}

function section(range) {
  range.format = {
    fill: paleBlue,
    font: { color: navy, bold: true },
    borders: { preset: "outside", style: "thin", color: border },
  };
}

for (const sheet of [dashboard, tests, setup, requests, log]) {
  sheet.showGridLines = false;
}

// Dashboard
titleBand(
  dashboard,
  "A1:H2",
  "Nexus Buyer Webhook Acceptance",
  "Complete the Core rows first. Launch is ready only when every Core test passes and there are no failures or blockers.",
);
dashboard.getRange("A4:B4").values = [["Overall progress", "Result"]];
header(dashboard.getRange("A4:B4"));
dashboard.getRange("A5:A10").values = [
  ["Total tests"],
  ["Passed"],
  ["Not tested"],
  ["Failed"],
  ["Blocked"],
  ["Completion"],
];
dashboard.getRange("B5:B10").formulas = [
  ["=COUNTA('Acceptance Tests'!$A$6:$A$80)"],
  ["=COUNTIF('Acceptance Tests'!$F$6:$F$80,\"Pass\")"],
  ["=COUNTIF('Acceptance Tests'!$F$6:$F$80,\"Not Tested\")"],
  ["=COUNTIF('Acceptance Tests'!$F$6:$F$80,\"Fail\")"],
  ["=COUNTIF('Acceptance Tests'!$F$6:$F$80,\"Blocked\")"],
  ["=IFERROR(B6/B5,0)"],
];
dashboard.getRange("B10").format.numberFormat = "0%";
dashboard.getRange("D4:E4").values = [["Core launch gate", "Result"]];
header(dashboard.getRange("D4:E4"));
dashboard.getRange("D5:D9").values = [
  ["Core tests"],
  ["Core passed"],
  ["Core failed"],
  ["Core blocked"],
  ["Launch decision"],
];
dashboard.getRange("E5:E9").formulas = [
  ["=COUNTIF('Acceptance Tests'!$B$6:$B$80,\"Core\")"],
  ["=COUNTIFS('Acceptance Tests'!$B$6:$B$80,\"Core\",'Acceptance Tests'!$F$6:$F$80,\"Pass\")"],
  ["=COUNTIFS('Acceptance Tests'!$B$6:$B$80,\"Core\",'Acceptance Tests'!$F$6:$F$80,\"Fail\")"],
  ["=COUNTIFS('Acceptance Tests'!$B$6:$B$80,\"Core\",'Acceptance Tests'!$F$6:$F$80,\"Blocked\")"],
  ["=IF(AND(E6=E5,E7=0,E8=0),\"READY\",\"NOT READY\")"],
];
dashboard.getRange("A5:B10").format.borders = { preset: "inside", style: "thin", color: border };
dashboard.getRange("D5:E9").format.borders = { preset: "inside", style: "thin", color: border };
dashboard.getRange("A12:H12").merge();
dashboard.getRange("A12").values = [["Recommended execution order"]];
section(dashboard.getRange("A12:H12"));
dashboard.getRange("A13:H18").values = [
  ["1", "Upload", "Upload the supplied workflow and use the exact product settings.", "", "", "", "", ""],
  ["2", "Technical test", "Run Nexus's real technical test and publish only after readiness is Good.", "", "", "", "", ""],
  ["3", "Buyer setup", "Purchase with a buyer test account, save baseline setup, create the endpoint and confirm the test event.", "", "", "", "", ""],
  ["4", "Mapping", "Map customer.message, customer.id and customer.priority, validate the preview and confirm.", "", "", "", "", ""],
  ["5", "Live usage", "Activate, send three unique events, verify duplicates, outputs, warnings and quota exhaustion.", "", "", "", "", ""],
  ["6", "Recovery", "Purchase the two-run pack, retry the blocked event and confirm correct usage and output delivery.", "", "", "", "", ""],
];
dashboard.getRange("A13:A18").format = { fill: paleBlue, font: { color: blue, bold: true }, horizontalAlignment: "center" };
dashboard.getRange("B13:B18").format.font = { bold: true, color: navy };
dashboard.getRange("A13:H18").format.wrapText = true;
dashboard.getRange("A13:H18").format.borders = { preset: "inside", style: "thin", color: border };
dashboard.getRange("A20:H23").merge();
dashboard.getRange("A20").values = [["Important boundary\nOnly the test product should use Runtime behavior = External buyer webhook request (usage metered). Existing products must remain on their current runtime mode and must not show webhook setup, usage or top-up controls."]];
dashboard.getRange("A20:H23").format = { fill: paleAmber, font: { color: "#754700", bold: true }, wrapText: true, verticalAlignment: "center", borders: { preset: "outside", style: "thin", color: "#E7C46C" } };
dashboard.getRange("A:A").format.columnWidth = 18;
dashboard.getRange("B:B").format.columnWidth = 19;
dashboard.getRange("C:C").format.columnWidth = 5;
dashboard.getRange("D:D").format.columnWidth = 22;
dashboard.getRange("E:E").format.columnWidth = 17;
dashboard.getRange("F:H").format.columnWidth = 16;

// Acceptance tests
titleBand(tests, "A1:J2", "Webhook acceptance matrix", "Change Status as you test and paste exact IDs, URLs or screenshots into Evidence. Core rows are the launch gate; Extended rows cover resilience and lifecycle behavior.");
tests.getRange("A4:J4").merge();
tests.getRange("A4").values = [["Status options: Not Tested · Pass · Fail · Blocked"]];
tests.getRange("A4:J4").format = { fill: paleSlate, font: { color: slate, italic: true }, wrapText: true };
const testHeaders = [["Test ID", "Tier", "Phase", "Exact action", "Expected result", "Status", "Actual result / evidence", "IDs / URLs", "Owner", "Notes"]];
tests.getRange("A5:J5").values = testHeaders;
header(tests.getRange("A5:J5"));

const testRows = [
  ["WEB-001", "Core", "Product import", "Upload nexus-buyer-webhook-request-processor-test.workflow.json as an n8n product.", "Import succeeds and Nexus adds its hosted trigger, Runtime Context and Submit Output nodes.", "Not Tested", "", "", "Admin/Developer", ""],
  ["WEB-002", "Core", "Product import", "Review detected credentials after import.", "No developer or buyer credential is requested; especially no Meta, AWS, Supabase or Google credential.", "Not Tested", "", "", "Admin/Developer", ""],
  ["WEB-003", "Core", "Product setup", "Set Runtime behavior to External buyer webhook request (usage metered).", "Saved product runtime_trigger_mode is buyer_webhook; no other product changes mode.", "Not Tested", "", "", "Admin/Developer", ""],
  ["WEB-004", "Core", "Product setup", "Set Monthly pricing, 3 included runs, 2 runs per top-up and a small test top-up price.", "Readiness accepts the usage configuration and rejects one-time pricing for this mode.", "Not Tested", "", "", "Admin/Developer", ""],
  ["WEB-005", "Core", "Technical test", "Run the real technical test using the sample values on Product Setup.", "Exactly one n8n execution succeeds and Nexus receives the formatted acceptance output.", "Not Tested", "", "", "Admin/Developer", ""],
  ["WEB-006", "Core", "Publishing", "Add an output preview and publish the product.", "Every readiness item is Good and the product publishes without asking for webhook customer setup yet.", "Not Tested", "", "", "Admin", ""],
  ["WEB-007", "Core", "Purchase", "Purchase the product with a buyer test account as a monthly subscription.", "Payment succeeds, developer sale is recorded and the buyer automation appears in the dashboard.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-008", "Core", "Purchase", "Open the buyer product immediately after purchase.", "Buyer sees normal baseline setup first; no workflow runs before an external event.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-009", "Core", "Buyer setup", "Save Business name, Reply prefix and Default priority; leave the three event-mapped fields blank.", "Setup saves successfully, no n8n execution starts and the buyer can continue to Webhook setup.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-010", "Core", "Buyer setup", "Compare this product with an existing normal product in the buyer dashboard.", "Webhook setup appears only on this buyer_webhook product; the normal product UI is unchanged.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-011", "Core", "Connection", "Open Webhook setup and generate/copy the inbound endpoint and secret.", "Endpoint is HTTPS and purchase-specific; the new secret can be copied and is hidden on later page loads.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-012", "Core", "Connection", "Send TEST-INVALID-SECRET with the wrong x-nexus-webhook-secret.", "Request returns 401, starts no run and consumes no usage.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-013", "Core", "Connection", "Send TEST-SETUP-001 with the correct secret while live mode is off.", "Request returns 202 with test_only=true; the page shows Test passed.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-014", "Core", "Connection", "Check n8n and the usage card after TEST-SETUP-001.", "No n8n execution starts and usage remains 0 of 3 because test events are free.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-015", "Core", "Connection", "Review the inbound history and confirm the inbound connection.", "History shows the test event and confirmation changes inbound status to Confirmed.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-016", "Core", "Mapping", "Before confirming mapping, attempt to activate live requests.", "Activation remains disabled; UI clearly says inbound connection and event mapping must be confirmed.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-017", "Core", "Mapping", "Open mapping after the test event.", "Source paths customer.message, customer.id and customer.priority are visible with samples.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-018", "Core", "Mapping", "Map customer.message → event_message, customer.id → external_customer_id and customer.priority → event_priority.", "All three target fields save without changing saved Business name, Reply prefix or Default priority.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-019", "Core", "Mapping", "Validate the latest event and inspect the exact runtime preview.", "Preview contains saved setup plus mapped values, canonical event identity, request payload and exact purchase identity.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-020", "Core", "Mapping", "Confirm the event mapping.", "Mapping status becomes Confirmed and Activate live requests becomes available.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-021", "Core", "Activation", "Leave outbound destination empty and activate live requests.", "Activation succeeds because outbound delivery is optional; status becomes Live and usage shows 3 left.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-022", "Core", "Live request", "Send LIVE-001 using the valid sample payload and correct secret.", "Response is 202 accepted/queued with a run_id and remaining_runs=2.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-023", "Core", "Live request", "Inspect n8n for LIVE-001.", "Exactly one execution runs and the Runtime Context contains event ID, raw request and mapped setup values.", "Not Tested", "", "", "Admin/Developer", ""],
  ["WEB-024", "Core", "Output", "Open the completed buyer output for LIVE-001.", "Output shows event ID, event type, external customer, priority and exact customer message.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-025", "Core", "Output", "Check dashboard, Outputs tab and refresh the page.", "The output appears everywhere, status is completed and the output remains after refresh.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-026", "Core", "Notification", "Check the buyer email after LIVE-001 completes.", "Buyer receives the output-ready email with a working link to the exact result.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-027", "Core", "Idempotency", "Send the exact LIVE-001 request again with the same x-nexus-event-id.", "Response is 200 with duplicate=true; no second execution or output is created and usage stays at 1 used.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-028", "Core", "Usage", "Send unique event LIVE-002.", "One execution runs, usage becomes 2 used / 1 left and the low-usage warning is created once.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-029", "Core", "Usage", "Send unique event LIVE-003.", "One execution runs, usage becomes 3 used / 0 left and the exhaustion notice is created once.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-030", "Core", "Quota", "Send unique event LIVE-004 after usage reaches zero.", "Response is 429 with Retry-After; no n8n execution starts and no output or extra usage is created.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-031", "Core", "Top-up", "Purchase the configured 2-run pack from Webhook setup.", "Stripe uses a separate one-time top-up checkout; the original monthly subscription and order financials remain unchanged.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-032", "Core", "Top-up", "Return from the paid top-up and refresh twice.", "Exactly 2 purchased runs are added once; repeated verification never adds them twice.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-033", "Core", "Recovery", "Retry LIVE-004 with the same event ID after the top-up.", "Previously blocked event is accepted, one execution starts and remaining usage becomes 1.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-034", "Core", "Validation", "Send INVALID-MAPPING-001 without customer.message.", "Response is 422, no run starts and usage does not change.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-035", "Core", "Validation", "Correct the payload and resend INVALID-MAPPING-001 with the same event ID while usage is available.", "Corrected failed event can be accepted once; it is not permanently poisoned by the earlier 422.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-036", "Core", "Secret rotation", "Rotate the secret, then test the old and new values.", "Old secret immediately returns 401; new secret is accepted and no duplicate usage is created.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-037", "Extended", "Outbound output", "Configure a buyer-controlled HTTPS test receiver, run the outbound test and confirm it.", "Test succeeds, status is Confirmed and private/local destinations are rejected.", "Not Tested", "", "", "Buyer", "Use only an endpoint you control."],
  ["WEB-038", "Extended", "Outbound output", "Send a new live event after outbound confirmation.", "Dashboard output is saved and the same completed result is delivered once to the confirmed destination.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-039", "Extended", "Pause/resume", "Pause live requests, send PAUSED-001, then review the page.", "No live run or usage is created; the request is treated as a test event and Nexus clearly guides revalidation before reactivation.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-040", "Extended", "Pause/resume", "Revalidate the latest event mapping and reactivate.", "Product returns to Live without repurchase or reprovisioning.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-041", "Extended", "Authorization", "Try opening another buyer's webhook setup URL from a different buyer account.", "Access is denied and no endpoint, secret hint, payload preview or usage data is exposed.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-042", "Extended", "Compatibility", "Open and run one existing setup_complete product.", "It has no webhook UI or usage meter and its setup/output behavior is exactly unchanged.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-043", "Extended", "Bundle", "Include the webhook product in a test bundle and purchase it.", "Webhook item has exact bundle attempt/item identity; its event does not rerun successful unrelated bundle items.", "Not Tested", "", "", "Buyer", ""],
  ["WEB-044", "Extended", "Backlog", "Temporarily make n8n unavailable, send one valid event, then restore n8n.", "Accepted request remains queued and later runs exactly once without buyer resubmission.", "Not Tested", "", "", "Admin", "Perform only in a controlled maintenance window."],
  ["WEB-045", "Extended", "Output durability", "Edit or reimport the product after outputs have been delivered.", "Past outputs remain visible and linked to their original purchase/run identity.", "Not Tested", "", "", "Admin", ""],
  ["WEB-046", "Extended", "Cancellation", "Request and approve cancellation of the monthly test subscription.", "New usage requests are not authorized after cancellation; previously delivered outputs remain visible.", "Not Tested", "", "", "Admin/Buyer", ""],
  ["WEB-047", "Extended", "Renewal", "Verify the next paid subscription period or a controlled renewal fixture.", "New period starts with 3 included, 0 purchased and 0 used runs; old usage ledger remains auditable.", "Not Tested", "", "", "Admin", ""],
  ["WEB-048", "Extended", "Customer UX", "Complete connection, mapping, activation and one request on a mobile-width browser.", "No clipped controls; copy, confirm, activate and usage actions remain understandable and usable.", "Not Tested", "", "", "Buyer", ""],
];
const endRow = 5 + testRows.length;
tests.getRange(`A6:J${endRow}`).values = testRows;
tests.getRange(`A6:J${endRow}`).format.wrapText = true;
tests.getRange(`A6:J${endRow}`).format.verticalAlignment = "top";
tests.getRange(`A6:J${endRow}`).format.borders = { insideHorizontal: { style: "thin", color: border } };
tests.getRange(`F6:F${endRow}`).dataValidation = { rule: { type: "list", values: ["Not Tested", "Pass", "Fail", "Blocked"] } };
tests.getRange(`I6:I${endRow}`).dataValidation = { rule: { type: "list", values: ["Admin", "Developer", "Buyer", "Admin/Developer", "Admin/Buyer"] } };
tests.getRange(`F6:F${endRow}`).conditionalFormats.add("containsText", { text: "Pass", format: { fill: paleGreen, font: { color: green, bold: true } } });
tests.getRange(`F6:F${endRow}`).conditionalFormats.add("containsText", { text: "Fail", format: { fill: paleRed, font: { color: red, bold: true } } });
tests.getRange(`F6:F${endRow}`).conditionalFormats.add("containsText", { text: "Blocked", format: { fill: paleAmber, font: { color: amber, bold: true } } });
tests.getRange(`F6:F${endRow}`).conditionalFormats.add("containsText", { text: "Not Tested", format: { fill: paleSlate, font: { color: slate } } });
tests.getRange(`B6:B${endRow}`).conditionalFormats.add("containsText", { text: "Core", format: { fill: paleBlue, font: { color: blue, bold: true } } });
const testsTable = tests.tables.add(`A5:J${endRow}`, true, "WebhookAcceptanceTests");
testsTable.style = "TableStyleMedium2";
tests.freezePanes.freezeRows(5);
tests.getRange("A:A").format.columnWidth = 12;
tests.getRange("B:B").format.columnWidth = 10;
tests.getRange("C:C").format.columnWidth = 19;
tests.getRange("D:D").format.columnWidth = 46;
tests.getRange("E:E").format.columnWidth = 48;
tests.getRange("F:F").format.columnWidth = 15;
tests.getRange("G:G").format.columnWidth = 34;
tests.getRange("H:H").format.columnWidth = 27;
tests.getRange("I:I").format.columnWidth = 17;
tests.getRange("J:J").format.columnWidth = 31;

// Product setup
titleBand(setup, "A1:H2", "Exact test-product configuration", "Use these values for the supplied workflow. The small allowance is intentional so quota behavior can be tested in minutes.");
setup.getRange("A4:B4").values = [["Product field", "Exact test value"]];
header(setup.getRange("A4:B4"));
const settingsRows = [
  ["Title", "DO NOT BUY — Buyer Webhook Acceptance Test"],
  ["Listing type", "Standard product"],
  ["Pricing", "Monthly subscription"],
  ["Currency", "USD"],
  ["Monthly price", "Use the smallest safe test price for your Stripe environment"],
  ["Runtime type", "n8n managed"],
  ["Runtime behavior", "External buyer webhook request (usage metered)"],
  ["Run cadence", "Only when triggered"],
  ["Response mode", "Dashboard output"],
  ["Included runs / month", 3],
  ["Runs per top-up", 2],
  ["Top-up price", "Use the smallest safe test price"],
  ["Credentials", "None"],
  ["After testing", "Unpublish the product and cancel the test subscription"],
];
setup.getRange("A5:B18").values = settingsRows;
setup.getRange("A5:A18").format = { fill: paleSlate, font: { color: navy, bold: true } };
setup.getRange("A5:B18").format.wrapText = true;
setup.getRange("A5:B18").format.borders = { insideHorizontal: { style: "thin", color: border } };

setup.getRange("D4:H4").merge();
setup.getRange("D4").values = [["Buyer setup schema"]];
header(setup.getRange("D4:H4"));
setup.getRange("D5:H5").values = [["name", "label", "type", "required", "purpose"]];
section(setup.getRange("D5:H5"));
const schemaRows = [
  ["business_name", "Business name", "text", true, "Saved once and reused for every request"],
  ["reply_prefix", "Output title prefix", "text", false, "Saved once; example: Customer request processed"],
  ["default_priority", "Default priority", "select", true, "Saved fallback: normal"],
  ["event_message", "Webhook message", "textarea", false, "Leave blank in setup; map customer.message"],
  ["external_customer_id", "External customer ID", "text", false, "Leave blank in setup; map customer.id"],
  ["event_priority", "Webhook priority", "text", false, "Leave blank in setup; map customer.priority"],
];
setup.getRange("D6:H11").values = schemaRows;
setup.getRange("D6:H11").format.wrapText = true;
setup.getRange("D6:H11").format.borders = { insideHorizontal: { style: "thin", color: border } };
setup.getRange("D13:H13").merge();
setup.getRange("D13").values = [["Technical test values"]];
header(setup.getRange("D13:H13"));
setup.getRange("D14:E19").values = [
  ["business_name", "Nexus Webhook Test Company"],
  ["reply_prefix", "Webhook request processed"],
  ["default_priority", "normal"],
  ["event_message", "Technical test message"],
  ["external_customer_id", "technical-customer-001"],
  ["event_priority", "high"],
];
setup.getRange("D14:D19").format = { fill: paleSlate, font: { bold: true, color: navy } };
setup.getRange("D14:E19").format.borders = { insideHorizontal: { style: "thin", color: border } };

const setupSchemaJson = JSON.stringify([
  { name: "business_name", type: "text", label: "Business name", options: [], required: true, description: "The business that owns this webhook connection.", placeholder: "e.g. Nexus Test Company" },
  { name: "reply_prefix", type: "text", label: "Output title prefix", options: [], required: false, description: "Optional prefix used in every completed output.", placeholder: "e.g. Customer request processed" },
  { name: "default_priority", type: "select", label: "Default priority", options: ["low", "normal", "high"], required: true, description: "Fallback priority when an event does not provide one.", placeholder: "normal" },
  { name: "event_message", type: "textarea", label: "Webhook message", options: [], required: false, description: "Leave blank during initial setup. Map customer.message from the webhook test event.", placeholder: "Provided by each webhook request" },
  { name: "external_customer_id", type: "text", label: "External customer ID", options: [], required: false, description: "Leave blank during initial setup. Map customer.id from the webhook test event.", placeholder: "Provided by each webhook request" },
  { name: "event_priority", type: "text", label: "Webhook priority", options: [], required: false, description: "Leave blank during initial setup. Map customer.priority from the webhook test event.", placeholder: "Provided by each webhook request" },
], null, 2);
setup.getRange("A21:H21").merge();
setup.getRange("A21").values = [["Copy-ready setup_schema JSON"]];
header(setup.getRange("A21:H21"));
setup.getRange("A22:H38").merge();
setup.getRange("A22").values = [[setupSchemaJson]];
setup.getRange("A22:H38").format = { fill: "#F8FAFC", font: { name: "Consolas", size: 9, color: "#27364A" }, wrapText: true, verticalAlignment: "top", borders: { preset: "outside", style: "thin", color: border } };
setup.getRange("A:A").format.columnWidth = 24;
setup.getRange("B:B").format.columnWidth = 49;
setup.getRange("C:C").format.columnWidth = 3;
setup.getRange("D:D").format.columnWidth = 23;
setup.getRange("E:E").format.columnWidth = 30;
setup.getRange("F:F").format.columnWidth = 16;
setup.getRange("G:G").format.columnWidth = 15;
setup.getRange("H:H").format.columnWidth = 38;

// Requests and mappings
titleBand(requests, "A1:H2", "Webhook request examples", "Replace WEBHOOK_URL and WEBHOOK_SECRET with the values shown to the buyer. Keep event IDs unique except in the duplicate and retry tests.");
requests.getRange("A4:H4").values = [["Scenario", "Event ID", "Secret", "Payload", "Expected HTTP", "Consumes run", "Starts n8n", "Expected note"]];
header(requests.getRange("A4:H4"));
const goodPayload = JSON.stringify({
  event: "customer.request.created",
  timestamp: "2026-08-12T12:00:00Z",
  customer: { id: "customer-001", message: "Please prepare my webhook acceptance report.", priority: "high" },
}, null, 2);
const secondPayload = JSON.stringify({
  event: "customer.request.created",
  timestamp: "2026-08-12T12:05:00Z",
  customer: { id: "customer-002", message: "Please process the second request.", priority: "normal" },
}, null, 2);
const missingPayload = JSON.stringify({
  event: "customer.request.created",
  timestamp: "2026-08-12T12:10:00Z",
  customer: { id: "customer-003", priority: "low" },
}, null, 2);
const requestRows = [
  ["Connection test", "TEST-SETUP-001", "Correct", goodPayload, 202, "No", "No", "test_only=true"],
  ["Wrong secret", "TEST-INVALID-SECRET", "Wrong", goodPayload, 401, "No", "No", "Rejected before processing"],
  ["First live request", "LIVE-001", "Correct", goodPayload, 202, "Yes", "Yes", "remaining_runs=2"],
  ["Duplicate", "LIVE-001", "Correct", goodPayload, 200, "No", "No", "duplicate=true"],
  ["Second live request", "LIVE-002", "Correct", secondPayload, 202, "Yes", "Yes", "remaining_runs=1 and low warning"],
  ["Third live request", "LIVE-003", "Correct", goodPayload.replace("customer-001", "customer-003"), 202, "Yes", "Yes", "remaining_runs=0 and exhausted notice"],
  ["Quota blocked", "LIVE-004", "Correct", secondPayload, 429, "No", "No", "Retry-After header"],
  ["Retry after top-up", "LIVE-004", "Correct", secondPayload, 202, "Yes", "Yes", "Same previously blocked ID can recover"],
  ["Missing mapped value", "INVALID-MAPPING-001", "Correct", missingPayload, 422, "No", "No", "customer.message missing"],
  ["Corrected retry", "INVALID-MAPPING-001", "Correct", goodPayload, 202, "Yes", "Yes", "Failed ID can be retried after correction"],
];
requests.getRange("A5:H14").values = requestRows;
requests.getRange("A5:H14").format.wrapText = true;
requests.getRange("A5:H14").format.verticalAlignment = "top";
requests.getRange("A5:H14").format.borders = { insideHorizontal: { style: "thin", color: border } };
requests.getRange("E5:E14").format.numberFormat = "0";
requests.getRange("E5:E14").conditionalFormats.add("cellIs", { operator: "greaterThanOrEqual", formula: 400, format: { fill: paleRed, font: { color: red, bold: true } } });
requests.getRange("E5:E14").conditionalFormats.add("cellIs", { operator: "lessThan", formula: 400, format: { fill: paleGreen, font: { color: green, bold: true } } });

requests.getRange("A16:H16").merge();
requests.getRange("A16").values = [["Exact event mapping"]];
header(requests.getRange("A16:H16"));
requests.getRange("A17:C20").values = [
  ["Nexus target", "Webhook source path", "Purpose"],
  ["event_message", "customer.message", "Per-request message"],
  ["external_customer_id", "customer.id", "Per-request customer identity"],
  ["event_priority", "customer.priority", "Per-request priority"],
];
section(requests.getRange("A17:C17"));
requests.getRange("A17:C20").format.borders = { insideHorizontal: { style: "thin", color: border } };

requests.getRange("A22:H22").merge();
requests.getRange("A22").values = [["cURL template"]];
header(requests.getRange("A22:H22"));
const curl = `curl -X POST "WEBHOOK_URL" \\\n+  -H "Content-Type: application/json" \\\n+  -H "x-nexus-webhook-secret: WEBHOOK_SECRET" \\\n+  -H "x-nexus-event-id: LIVE-001" \\\n+  -d '{"event":"customer.request.created","timestamp":"2026-08-12T12:00:00Z","customer":{"id":"customer-001","message":"Please prepare my webhook acceptance report.","priority":"high"}}'`;
requests.getRange("A23:H29").merge();
requests.getRange("A23").values = [[curl]];
requests.getRange("A23:H29").format = { fill: "#101827", font: { name: "Consolas", color: "#DDE8F5", size: 9 }, wrapText: true, verticalAlignment: "top", borders: { preset: "outside", style: "thin", color: "#26364C" } };
requests.getRange("A:A").format.columnWidth = 23;
requests.getRange("B:B").format.columnWidth = 24;
requests.getRange("C:C").format.columnWidth = 14;
requests.getRange("D:D").format.columnWidth = 55;
requests.getRange("E:E").format.columnWidth = 15;
requests.getRange("F:G").format.columnWidth = 16;
requests.getRange("H:H").format.columnWidth = 35;
requests.freezePanes.freezeRows(4);

// Run log
titleBand(log, "A1:J2", "Webhook run log", "Add one row per request. Reusing an event ID is intentional only for duplicate and corrected-retry scenarios.");
log.getRange("A4:J4").values = [["Timestamp", "Event ID", "Scenario", "Expected HTTP", "Actual HTTP", "Expected remaining", "Actual remaining", "n8n execution ID", "Nexus run/output ID", "Notes"]];
header(log.getRange("A4:J4"));
const logRows = Array.from({ length: 30 }, () => [null, "", "", null, null, null, null, "", "", ""]);
log.getRange("A5:J34").values = logRows;
log.getRange("A5:A34").format.numberFormat = "yyyy-mm-dd hh:mm:ss";
log.getRange("D5:G34").format.numberFormat = "0";
log.getRange("A5:J34").format.borders = { insideHorizontal: { style: "thin", color: border } };
log.getRange("A5:J34").format.wrapText = true;
const logTable = log.tables.add("A4:J34", true, "WebhookRunLog");
logTable.style = "TableStyleMedium2";
log.freezePanes.freezeRows(4);
log.getRange("A:A").format.columnWidth = 22;
log.getRange("B:B").format.columnWidth = 26;
log.getRange("C:C").format.columnWidth = 25;
log.getRange("D:G").format.columnWidth = 18;
log.getRange("H:I").format.columnWidth = 30;
log.getRange("J:J").format.columnWidth = 40;

await fs.mkdir(outputDir, { recursive: true });
const previews = [
  ["Launch Dashboard", "A1:H23", "dashboard.png", 1.2],
  ["Acceptance Tests", "A1:J29", "acceptance-tests-top.png", 0.8],
  ["Acceptance Tests", `A30:J${endRow}`, "acceptance-tests-bottom.png", 0.8],
  ["Product Setup", "A1:H38", "product-setup.png", 0.9],
  ["Request Examples", "A1:H29", "request-examples.png", 0.9],
  ["Run Log", "A1:J18", "run-log.png", 0.9],
];
for (const [sheetName, range, filename, scale] of previews) {
  const rendered = await workbook.render({ sheetName, range, scale, format: "png" });
  await fs.writeFile(`${outputDir}/${filename}`, new Uint8Array(await rendered.arrayBuffer()));
}

const inspection = await workbook.inspect({
  kind: "table",
  range: "Launch Dashboard!A1:H23",
  include: "values,formulas",
  tableMaxRows: 25,
  tableMaxCols: 10,
  maxChars: 7000,
});
console.log(inspection.ndjson);
const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 100 },
  summary: "final formula error scan",
});
console.log(errors.ndjson);

const exported = await SpreadsheetFile.exportXlsx(workbook);
await exported.save(`${outputDir}/Nexus-Buyer-Webhook-Acceptance-Test.xlsx`);
console.log(JSON.stringify({ output: `${outputDir}/Nexus-Buyer-Webhook-Acceptance-Test.xlsx`, tests: testRows.length, endRow }));
