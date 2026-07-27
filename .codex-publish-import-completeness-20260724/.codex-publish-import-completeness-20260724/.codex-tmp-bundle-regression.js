const fs = require("fs");
const vm = require("vm");

const html = fs.readFileSync("pages/buyer/dashboard.html", "utf8");
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
const source = scripts[scripts.length - 1][1];
const mutedConsole = Object.fromEntries(["log", "warn", "error", "info", "debug"].map(key => [key, () => {}]));
const documentStub = {
  addEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  body: { dataset: {}, classList: { add() {}, remove() {}, toggle() {} } }
};
const context = {
  console: mutedConsole,
  document: documentStub,
  location: { search: "", hash: "", pathname: "/pages/buyer/dashboard.html", href: "" },
  history: { replaceState() {} },
  localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
  URL,
  URLSearchParams,
  Date,
  Math,
  JSON,
  Set,
  Map,
  Promise,
  setTimeout() { return 1; },
  clearTimeout() {},
  NexusUI: {},
  NexusDB: {},
  NexusNotice: {},
  fetch: async () => ({ ok: true, json: async () => ({}) })
};
context.window = context;
context.globalThis = context;
vm.createContext(context);
vm.runInContext(source, context, { filename: "buyer-dashboard-inline.js" });

const iso = value => new Date(value).toISOString();
const order = {
  id: "order-1",
  order_type: "bundle",
  bundle_id: "bundle-1",
  created_at: iso("2026-07-21T10:00:00Z"),
  bundle_snapshot: { bundle_id: "bundle-1", title: "Fixture bundle" }
};
const automations = Array.from({ length: 4 }, (_, index) => ({
  id: `ca-${index + 1}`,
  name: `Workflow ${index + 1}`,
  order_id: "order-1",
  bundle_id: "bundle-1",
  status: "active",
  created_at: iso("2026-07-21T10:00:00Z")
}));

function scenario(statuses, withExactOutputs = true, staleLinkedOutputs = false, outputOrderId = "order-1") {
  const attempt = {
    id: "attempt-current",
    order_id: "order-1",
    bundle_id: "bundle-1",
    buyer_id: "buyer-1",
    status: statuses.every(status => status === "success") ? "success" : statuses.some(status => status === "running") ? "running" : "partial_failed",
    created_at: iso("2026-07-21T10:05:00Z"),
    updated_at: iso("2026-07-21T10:06:00Z"),
    bundle_run_items: statuses.map((status, index) => ({
      id: `item-${index + 1}`,
      bundle_run_attempt_id: "attempt-current",
      order_id: "order-1",
      bundle_id: "bundle-1",
      buyer_id: "buyer-1",
      customer_automation_id: `ca-${index + 1}`,
      automation_id: `product-${index + 1}`,
      automation_run_id: `run-${index + 1}`,
      output_id: withExactOutputs ? `${staleLinkedOutputs ? "old-" : ""}output-${index + 1}` : null,
      status,
      created_at: iso("2026-07-21T10:05:00Z"),
      updated_at: iso("2026-07-21T10:06:00Z")
    }))
  };
  const runs = statuses.map((status, index) => ({
    id: `run-${index + 1}`,
    customer_automation_id: `ca-${index + 1}`,
    order_id: "order-1",
    bundle_run_attempt_id: "attempt-current",
    bundle_run_item_id: `item-${index + 1}`,
    status,
    created_at: iso("2026-07-21T10:05:00Z"),
    started_at: iso("2026-07-21T10:05:00Z"),
    finished_at: status === "running" ? null : iso("2026-07-21T10:06:00Z")
  }));
  const exactOutputs = statuses.map((_, index) => ({
    id: `output-${index + 1}`,
    customer_automation_id: `ca-${index + 1}`,
    order_id: outputOrderId,
    automation_run_id: `run-${index + 1}`,
    bundle_run_attempt_id: "attempt-current",
    bundle_run_item_id: `item-${index + 1}`,
    title: `Current output ${index + 1}`,
    created_at: iso("2026-07-21T10:05:30Z")
  }));
  const historicalOutputs = automations.map((item, index) => ({
    id: `old-output-${index + 1}`,
    customer_automation_id: item.id,
    order_id: "order-old",
    automation_run_id: `old-run-${index + 1}`,
    bundle_run_attempt_id: "attempt-old",
    bundle_run_item_id: `old-item-${index + 1}`,
    title: `Historical output ${index + 1}`,
    created_at: iso("2026-07-20T10:00:00Z")
  }));
  return context.buildBuyerBundleRows([order], automations, [...exactOutputs, ...historicalOutputs], runs, [attempt])[0];
}

const cancelled = scenario(["cancelled", "cancelled", "cancelled", "cancelled"]);
const partial = scenario(["success", "cancelled", "cancelled", "cancelled"]);
const complete = scenario(["success", "success", "success", "success"]);
const running = scenario(["running", "running", "running", "running"]);
const staleLinked = scenario(["success", "cancelled", "cancelled", "cancelled"], true, true);
const wrongOrder = scenario(["success", "success", "success", "success"], true, false, "order-old");
const legacyCrossPurchase = context.buildBuyerBundleRows([order], automations, automations.map((item, index) => ({
  id: `legacy-output-${index + 1}`,
  customer_automation_id: item.id,
  order_id: "order-old",
  title: `Old purchase output ${index + 1}`,
  created_at: iso("2026-07-20T10:00:00Z")
})), [], [])[0];
function legacyScenario(statuses, outputs) {
  const legacyRuns = statuses.map((status, index) => ({
    id: "legacy-run-" + (index + 1),
    customer_automation_id: "ca-" + (index + 1),
    order_id: "order-1",
    status,
    created_at: iso("2026-07-21T10:05:00Z"),
    started_at: iso("2026-07-21T10:05:00Z"),
    finished_at: status === "running" ? null : iso("2026-07-21T10:06:00Z")
  }));
  return context.buildBuyerBundleRows([order], automations, outputs, legacyRuns, [])[0];
}

const unscopedLegacy = legacyScenario(
  ["success", "cancelled", "cancelled", "cancelled"],
  automations.map((item, index) => ({
    id: "unscoped-output-" + (index + 1),
    customer_automation_id: item.id,
    order_id: "order-1",
    automation_run_id: null,
    title: "Unscoped output " + (index + 1),
    created_at: iso("2026-07-21T10:05:30Z")
  }))
);
const allCancelledUnscoped = legacyScenario(
  ["cancelled", "cancelled", "cancelled", "cancelled"],
  automations.map((item, index) => ({
    id: "cancelled-unscoped-output-" + (index + 1),
    customer_automation_id: item.id,
    order_id: "order-1",
    automation_run_id: null,
    title: "Cancelled unscoped output " + (index + 1),
    created_at: iso("2026-07-21T10:05:30Z")
  }))
);
const staleUnscoped = legacyScenario(
  ["success", "cancelled", "cancelled", "cancelled"],
  automations.map((item, index) => ({
    id: "stale-unscoped-output-" + (index + 1),
    customer_automation_id: item.id,
    order_id: "order-1",
    automation_run_id: null,
    title: "Stale unscoped output " + (index + 1),
    created_at: iso("2026-07-21T09:00:00Z")
  }))
);
const exactLegacyPartial = legacyScenario(
  ["success", "cancelled", "cancelled", "cancelled"],
  automations.map((item, index) => ({
    id: "exact-legacy-output-" + (index + 1),
    customer_automation_id: item.id,
    order_id: "order-1",
    automation_run_id: "legacy-run-" + (index + 1),
    title: "Exact legacy output " + (index + 1),
    created_at: iso("2026-07-21T10:05:30Z")
  }))
);
const exactLegacyLabels = exactLegacyPartial.workflowSummaries.map(item => item.label);
const exactLegacyReadyCount = exactLegacyLabels.filter(label => label === "Ready").length;
const newestAttempt = context.latestBundleAttemptForOrder([
  {
    id: "attempt-old",
    order_id: "order-1",
    bundle_id: "bundle-1",
    created_at: iso("2026-07-21T09:00:00Z"),
    updated_at: iso("2026-07-22T12:00:00Z")
  },
  {
    id: "attempt-current",
    order_id: "order-1",
    bundle_id: "bundle-1",
    created_at: iso("2026-07-21T10:05:00Z"),
    updated_at: iso("2026-07-21T10:06:00Z")
  }
], "order-1", "bundle-1");
const zeroOutputLegacyBundle = context.buildBuyerBundleRows([order], automations, [], [], [])[0];
const threeOutputLegacyBundle = context.buildBuyerBundleRows([order], automations, automations.slice(0, 3).map((item, index) => ({
  id: `three-output-${index + 1}`,
  customer_automation_id: item.id,
  order_id: "order-1",
  title: `Order output ${index + 1}`,
  created_at: iso("2026-07-21T10:05:30Z")
})), [], [])[0];
const zeroOutputReadyBadges = zeroOutputLegacyBundle.workflowSummaries.filter(item => item.label === "Ready").length;
const threeOutputReadyBadges = threeOutputLegacyBundle.workflowSummaries.filter(item => item.label === "Ready").length;
const threeOutputStaleErrors = context.buildBuyerBundleRows(
  [order],
  automations.map(item => ({ ...item, last_error_message: "Old credential error" })),
  automations.slice(0, 3).map((item, index) => ({
    id: "three-output-stale-" + (index + 1),
    customer_automation_id: item.id,
    order_id: "order-1",
    title: "Order output " + (index + 1),
    created_at: iso("2026-07-21T10:05:30Z")
  })),
  [],
  []
)[0];
const badgeWithoutOrderOutput = context.orderScopedBundleWorkflowState({ status: "active" }, null, null, false, false);
const badgeWithOrderOutput = context.orderScopedBundleWorkflowState({ status: "active" }, null, { id: "order-output" }, true, false);
const badgeFailedRun = context.orderScopedBundleWorkflowState({}, { id: "failed-run", status: "failed", error_message: "Invalid credential" }, null, true, false);
const badgeSuccessWithoutOutput = context.orderScopedBundleWorkflowState({}, { id: "success-run", status: "success", finished_at: iso("2026-07-21T10:06:00Z") }, null, true, false);
const canonicalDuplicateAutomations = automations.map((item, index) => ({
  ...item,
  automation_id: `product-${index + 1}`,
  updated_at: iso("2026-07-21T10:05:00Z")
}));
const duplicateSocialAutomations = [
  ...canonicalDuplicateAutomations,
  {
    ...canonicalDuplicateAutomations[0],
    id: "ca-1-duplicate",
    runtime_status: "not_started",
    updated_at: iso("2026-07-21T10:10:00Z")
  }
];
const duplicateSocialAttempt = {
  id: "attempt-duplicate-social",
  order_id: "order-1",
  bundle_id: "bundle-1",
  status: "cancelled",
  created_at: iso("2026-07-21T10:05:00Z"),
  bundle_run_items: canonicalDuplicateAutomations.map((item, index) => ({
    id: `duplicate-item-${index + 1}`,
    bundle_run_attempt_id: "attempt-duplicate-social",
    order_id: "order-1",
    bundle_id: "bundle-1",
    customer_automation_id: item.id,
    automation_id: item.automation_id,
    automation_run_id: `duplicate-run-${index + 1}`,
    status: "cancelled",
    created_at: iso("2026-07-21T10:05:00Z")
  }))
};
const duplicateSocialRuns = canonicalDuplicateAutomations.map((item, index) => ({
  id: `duplicate-run-${index + 1}`,
  customer_automation_id: item.id,
  order_id: "order-1",
  bundle_run_attempt_id: "attempt-duplicate-social",
  bundle_run_item_id: `duplicate-item-${index + 1}`,
  status: "cancelled",
  created_at: iso("2026-07-21T10:05:00Z"),
  started_at: iso("2026-07-21T10:05:00Z"),
  finished_at: iso("2026-07-21T10:06:00Z")
}));
const duplicateSocialBundle = context.buildBuyerBundleRows(
  [order],
  duplicateSocialAutomations,
  [],
  duplicateSocialRuns,
  [duplicateSocialAttempt]
)[0];
const duplicateSocialLabels = duplicateSocialBundle.workflowSummaries.map(item => item.label);
const result = {
  allCancelled: cancelled.outputCount,
  duplicateSocialIncluded: duplicateSocialBundle.included.length,
  duplicateSocialOutputCount: duplicateSocialBundle.outputCount,
  duplicateSocialCancelledCount: duplicateSocialLabels.filter(label => label === "Cancelled").length,
  cancelledRuntimeIsArchived: context.isArchivedAutomationRow({ runtime_status: "cancelled" }),
  oneSuccess: partial.outputCount,
  allSuccess: complete.outputCount,
  runningEarlyOutput: running.outputCount,
  staleLinkedOutput: staleLinked.outputCount,
  wrongOrderOutput: wrongOrder.outputCount,
  legacyCrossPurchaseOutput: legacyCrossPurchase.outputCount,
  newestAttempt: newestAttempt?.id || null,
  badgeWithoutOrderOutput: badgeWithoutOrderOutput.label,
  badgeWithOrderOutput: badgeWithOrderOutput.label,
  badgeFailedRun: badgeFailedRun.label,
  badgeSuccessWithoutOutput: badgeSuccessWithoutOutput.label,
  zeroOutputCount: zeroOutputLegacyBundle.outputCount,
  zeroOutputReadyBadges,
  threeOutputCount: threeOutputLegacyBundle.outputCount,
  threeOutputReadyBadges,
  threeOutputIssueCount: threeOutputStaleErrors.issueDetails.length,
  threeOutputIssueTitle: threeOutputStaleErrors.issueDetails[0]?.title || ""
};
const expectations = {
  allCancelled: 0,
  duplicateSocialIncluded: 4,
  duplicateSocialOutputCount: 0,
  duplicateSocialCancelledCount: 4,
  cancelledRuntimeIsArchived: false,
  oneSuccess: 1,
  allSuccess: 4,
  runningEarlyOutput: 0,
  staleLinkedOutput: 0,
  wrongOrderOutput: 0,
  legacyCrossPurchaseOutput: 0,
  newestAttempt: "attempt-current",
  badgeWithoutOrderOutput: "Not started",
  badgeWithOrderOutput: "Ready",
  badgeFailedRun: "Issue detected",
  badgeSuccessWithoutOutput: "Needs attention",
  zeroOutputCount: 0,
  zeroOutputReadyBadges: 0,
  threeOutputCount: 3,
  threeOutputReadyBadges: 3,
  threeOutputIssueCount: 1,
  threeOutputIssueTitle: "Workflow 4"
};
for (const [key, expected] of Object.entries(expectations)) {
  if (result[key] !== expected) {
    throw new Error(`${key}: expected ${expected}, received ${result[key]}`);
  }
}
process.stdout.write(JSON.stringify(result));


