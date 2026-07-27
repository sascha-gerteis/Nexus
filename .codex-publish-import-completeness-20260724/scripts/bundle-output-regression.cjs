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
const legacyHistoryOutputs = automations.map((item, index) => ({
  id: `legacy-history-output-${index + 1}`,
  customer_automation_id: item.id,
  order_id: "order-1",
  title: `Historical output ${index + 1}`,
  created_at: iso("2026-07-21T10:10:00Z")
}));
const legacySuccessfulRuns = automations.map((item, index) => ({
  id: `legacy-success-run-${index + 1}`,
  customer_automation_id: item.id,
  order_id: "order-1",
  status: "success",
  created_at: iso("2026-07-21T10:05:00Z"),
  started_at: iso("2026-07-21T10:05:00Z"),
  finished_at: iso("2026-07-21T10:06:00Z")
}));
const impossibleLaterRuns = automations.slice(0, 3).map((item, index) => ({
  id: `impossible-running-finished-${index + 1}`,
  customer_automation_id: item.id,
  order_id: "order-1",
  status: "running",
  created_at: iso("2026-07-21T11:00:00Z"),
  started_at: iso("2026-07-21T11:00:00Z"),
  finished_at: iso("2026-07-21T11:00:00Z"),
  updated_at: iso("2026-07-27T18:04:00Z")
}));
const legacyHistoryPreserved = context.buildBuyerBundleRows(
  [order],
  automations.map(item => ({ ...item, updated_at: iso("2026-07-27T18:04:00Z") })),
  legacyHistoryOutputs,
  [...legacySuccessfulRuns, ...impossibleLaterRuns],
  []
)[0];const freshPurchase = context.buildBuyerBundleRows(
  [order],
  automations.map(item => ({
    ...item,
    status: "pending_setup",
    setup_status: "setup_required",
    runtime_status: "not_started"
  })),
  [],
  [],
  [],
  [{ id: "bundle-1", title: "Social Media Report Bundle", icon: "SM", color: "purple" }]
)[0];
const legacyFreshPurchase = context.buildBuyerBundleRows(
  [order],
  automations.map(item => ({
    ...item,
    status: "pending_setup",
    setup_status: "not_started",
    runtime_status: "not_started"
  })),
  [],
  [],
  []
)[0];
const blankStatusFreshPurchase = context.buildBuyerBundleRows(
  [order],
  automations.map(item => ({
    ...item,
    status: "active",
    setup_status: "",
    runtime_status: "not_started"
  })),
  [],
  [],
  []
)[0];
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
const result = {
  allCancelled: cancelled.outputCount,
  oneSuccess: partial.outputCount,
  allSuccess: complete.outputCount,
  runningEarlyOutput: running.outputCount,
  staleLinkedOutput: staleLinked.outputCount,
  wrongOrderOutput: wrongOrder.outputCount,
  legacyCrossPurchaseOutput: legacyCrossPurchase.outputCount,
  legacyHistoryPreserved: legacyHistoryPreserved.outputCount,
  legacyHistoryState: legacyHistoryPreserved.state.label,
  newestAttempt: newestAttempt?.id || null,
  cancelledState: cancelled.state.label,
  partialState: partial.state.label,
  completeState: complete.state.label,
  freshPurchaseState: freshPurchase.state.label,
  freshPurchaseAction: freshPurchase.state.primaryAction,
  freshPurchaseIcon: freshPurchase.icon,
  freshPurchaseWorkflowLabels: freshPurchase.workflowSummaries.map(item => item.label).join(","),
  legacyFreshPurchaseState: legacyFreshPurchase.state.label,
  blankStatusFreshPurchaseState: blankStatusFreshPurchase.state.label,
  blankStatusFreshPurchaseAction: blankStatusFreshPurchase.state.primaryAction
};
const expected = {
  allCancelled: 0,
  oneSuccess: 1,
  allSuccess: 4,
  runningEarlyOutput: 0,
  staleLinkedOutput: 0,
  wrongOrderOutput: 0,
  legacyCrossPurchaseOutput: 0,
  legacyHistoryPreserved: 4,
  legacyHistoryState: "Ready",
  newestAttempt: "attempt-current",
  cancelledState: "Needs attention",
  partialState: "Needs attention",
  completeState: "Ready",
  freshPurchaseState: "Needs setup",
  freshPurchaseAction: "Complete bundle setup",
  freshPurchaseIcon: "SM",
  freshPurchaseWorkflowLabels: "Setup required,Setup required,Setup required,Setup required",
  legacyFreshPurchaseState: "Needs setup",
  blankStatusFreshPurchaseState: "Needs setup",
  blankStatusFreshPurchaseAction: "Complete bundle setup"
};
const failures = Object.entries(expected).filter(([key, value]) => result[key] !== value);
if (failures.length) {
  throw new Error(`Bundle output regression failed: ${JSON.stringify({ result, failures })}`);
}
process.stdout.write(JSON.stringify(result));

