const fs = require("fs");
const vm = require("vm");

const html = fs.readFileSync("pages/buyer/dashboard.html", "utf8");
const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)];
const source = scripts[scripts.length - 1][1];
const documentStub = {
  addEventListener() {},
  getElementById() { return null; },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  body: { dataset: {}, classList: { add() {}, remove() {}, toggle() {} } }
};
const context = {
  console: Object.fromEntries(["log", "warn", "error", "info", "debug"].map(key => [key, () => {}])),
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

const output = {
  id: "output-1",
  order_id: "order-1",
  customer_automation_id: "ca-1",
  automation_run_id: "run-1",
  created_at: "2026-07-24T10:01:00.000Z"
};
const baseRun = {
  id: "run-1",
  run_key: "key-1",
  order_id: "order-1",
  customer_automation_id: "ca-1",
  created_at: "2026-07-24T10:00:00.000Z",
  started_at: "2026-07-24T10:00:00.000Z"
};
const item = { id: "ca-1", order_id: "order-1", last_run_requested_at: baseRun.started_at };
const check = (run, candidate = output) => context.outputIsFreshForAutomation(candidate, item, run);
const result = {
  exactSuccess: check({ ...baseRun, status: "success", finished_at: "2026-07-24T10:02:00.000Z" }),
  exactRunning: check({ ...baseRun, status: "running", finished_at: null }),
  exactCancelled: check({ ...baseRun, status: "cancelled", finished_at: "2026-07-24T10:02:00.000Z" }),
  exactFailed: check({ ...baseRun, status: "failed", finished_at: "2026-07-24T10:02:00.000Z" }),
  unknownFinished: check({ ...baseRun, status: "mystery", finished_at: "2026-07-24T10:02:00.000Z" }),
  wrongRun: check({ ...baseRun, id: "run-2", status: "success", finished_at: "2026-07-24T10:02:00.000Z" }),
  missingRun: check(null),
  legacyAfterSuccess: check(
    { ...baseRun, status: "success", finished_at: "2026-07-24T10:02:00.000Z" },
    { ...output, automation_run_id: null }
  ),
  legacyWhileRunning: check(
    { ...baseRun, status: "running", finished_at: null },
    { ...output, automation_run_id: null }
  )
};
const expected = {
  exactSuccess: true,
  exactRunning: false,
  exactCancelled: false,
  exactFailed: false,
  unknownFinished: false,
  wrongRun: false,
  missingRun: false,
  legacyAfterSuccess: true,
  legacyWhileRunning: false
};
const failures = Object.entries(expected).filter(([key, value]) => result[key] !== value);
if (failures.length) {
  throw new Error(`Output identity regression failed: ${JSON.stringify({ result, failures })}`);
}
process.stdout.write(JSON.stringify(result));