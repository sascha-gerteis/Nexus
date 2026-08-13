import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const file = "C:/Users/sascha.g/Desktop/nexus-phase1-final/outputs/buyer-webhook-acceptance-20260812/Nexus-Buyer-Webhook-Acceptance-Test.xlsx";
const blob = await FileBlob.load(file);
const workbook = await SpreadsheetFile.importXlsx(blob);

const dashboard = await workbook.inspect({
  kind: "table",
  range: "Launch Dashboard!A1:H23",
  include: "values,formulas",
  tableMaxRows: 25,
  tableMaxCols: 10,
  maxChars: 12000,
});

const tests = await workbook.inspect({
  kind: "table",
  range: "Acceptance Tests!A1:J53",
  include: "values,formulas",
  tableMaxRows: 60,
  tableMaxCols: 10,
  maxChars: 40000,
});

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 100 },
  summary: "reopened workbook formula error scan",
});

const dashboardText = dashboard.ndjson ?? "";
const testsText = tests.ndjson ?? "";
const errorsText = errors.ndjson ?? "";
const checks = {
  sheetCount: workbook.worksheets.items.length,
  sheets: workbook.worksheets.items.map((sheet) => sheet.name),
  hasLaunchDecision: dashboardText.includes("Launch decision"),
  hasCoreGate: dashboardText.includes("Core launch gate"),
  has48Tests: testsText.includes("SEC-02") && testsText.includes("COMP-03"),
  formulaErrors: (errorsText.match(/#REF!|#DIV\/0!|#VALUE!|#NAME\?|#N\/A/g) || []).length,
};

console.log(JSON.stringify(checks));
if (
  checks.sheetCount !== 5 ||
  !checks.hasLaunchDecision ||
  !checks.hasCoreGate ||
  !checks.has48Tests ||
  checks.formulaErrors !== 0
) {
  throw new Error("Workbook verification failed");
}
