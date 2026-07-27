import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const failures = [];
const expectedAssetVersion = "20260726-production-hardening";
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const deployedRoots = [
  "pages/",
  "assets/",
  "docs/",
  "custom-business-automation/",
  "customer-support-automation/",
  "lead-automation/",
  "reporting-automation/",
  "social-listening-automation/",
];
const deployedRootFiles = new Set([
  "index.html",
  "llms.txt",
  "robots.txt",
  "sitemap.xml",
  "site.webmanifest",
  "favicon.ico",
  "favicon.PNG",
  "_headers",
]);
const textExtensions = new Set([
  ".cjs", ".css", ".html", ".js", ".json", ".jsx", ".md", ".mjs", ".sql", ".svg", ".ts", ".tsx", ".txt", ".webmanifest", ".xml", ".yaml", ".yml",
]);

function fail(message) {
  failures.push(message);
}

function readText(relativePath) {
  const buffer = fs.readFileSync(path.join(root, relativePath));
  try {
    return strictUtf8.decode(buffer);
  } catch {
    fail(`${relativePath}: invalid UTF-8`);
    return buffer.toString("utf8");
  }
}

function isGeneratedDuplicate(relativePath) {
  return relativePath.startsWith("nexus-phase1-final/") ||
    relativePath.startsWith(".codex-publish-") ||
    relativePath.includes("/.codex-publish-");
}

function isDeployed(relativePath) {
  return deployedRootFiles.has(relativePath) || deployedRoots.some((prefix) => relativePath.startsWith(prefix));
}

function internalTargetExists(sourceFile, rawReference) {
  if (!rawReference || /^(?:[a-z]+:|#|\/\/)/i.test(rawReference) || rawReference.includes("${") || rawReference.includes("{{")) return true;

  const cleanReference = rawReference.split("#")[0].split("?")[0];
  if (!cleanReference) return true;

  let decoded = cleanReference;
  try {
    decoded = decodeURIComponent(cleanReference);
  } catch {
    fail(`${sourceFile}: malformed internal URL ${rawReference}`);
    return true;
  }

  const base = decoded.startsWith("/")
    ? decoded.slice(1)
    : path.posix.normalize(path.posix.join(path.posix.dirname(sourceFile), decoded));
  if (!base || base === ".") return fs.existsSync(path.join(root, "index.html"));

  const candidates = [base];
  if (base.endsWith("/")) candidates.push(`${base}index.html`);
  if (!path.posix.extname(base)) candidates.push(`${base}/index.html`, `${base}.html`);
  return candidates.some((candidate) => fs.existsSync(path.join(root, candidate)));
}

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root })
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .filter((relativePath) => !isGeneratedDuplicate(relativePath));

for (const relativePath of tracked) {
  const extension = path.extname(relativePath).toLowerCase();
  if (!textExtensions.has(extension) && path.basename(relativePath) !== "_headers") continue;

  const text = readText(relativePath);
  if (text.includes("\ufffd")) fail(`${relativePath}: contains Unicode replacement characters`);
}

const htmlFiles = tracked.filter((relativePath) => relativePath.endsWith(".html") && isDeployed(relativePath));
for (const relativePath of htmlFiles) {
  const html = readText(relativePath);

  if (!/<html\b[^>]*\blang=["'][^"']+["']/i.test(html)) fail(`${relativePath}: missing html lang`);
  if (!/<meta\b[^>]*name=["']viewport["']/i.test(html)) fail(`${relativePath}: missing viewport meta`);
  if (!/<title>[^<]+<\/title>/i.test(html)) fail(`${relativePath}: missing non-empty title`);

  const attributes = html.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi);
  for (const match of attributes) {
    if (!internalTargetExists(relativePath, match[1])) fail(`${relativePath}: missing internal target ${match[1]}`);
  }

  for (const match of html.matchAll(/<a\b[^>]*\btarget=["']_blank["'][^>]*>/gi)) {
    if (!/\brel=["'][^"']*\bnoopener\b[^"']*["']/i.test(match[0])) {
      fail(`${relativePath}: target=_blank link missing rel=noopener`);
    }
  }

  for (const match of html.matchAll(/["'](\/assets\/js\/(?:nexus-ui|nexus-db|nexus-app)\.js)([^"']*)["']/gi)) {
    if (match[2] !== `?v=${expectedAssetVersion}`) fail(`${relativePath}: stale shared asset ${match[1]}${match[2]}`);
  }
}

const ui = readText("assets/js/nexus-ui.js");
if (/\?{3,}/.test(ui)) fail("assets/js/nexus-ui.js: contains corrupted question-mark runs");
if (/(?:\u00c3.|\u00c2.|\u00e0\u00b8|\u00e0\u00a4|\u00d8.|\u00d9.)/.test(ui)) fail("assets/js/nexus-ui.js: contains mojibake markers");
for (const label of ["\u0e44\u0e17\u0e22", "\u4e2d\u6587", "Espa\u00f1ol", "\u0939\u093f\u0928\u094d\u0926\u0940", "\u0627\u0644\u0639\u0631\u0628\u064a\u0629", "Fran\u00e7ais"]) {
  if (!ui.includes(label)) fail(`assets/js/nexus-ui.js: missing restored language label ${JSON.stringify(label)}`);
}
if (!ui.includes("associateFormLabels") || !ui.includes("startAccessibilityObserver")) {
  fail("assets/js/nexus-ui.js: dynamic form-label accessibility guard missing");
}
if (!ui.includes("\u00b7 Approved developer")) fail("assets/js/nexus-ui.js: developer maintainer separator is not repaired");

const app = readText("assets/js/nexus-app.js");
if (app.includes('if (grid.querySelector(".product-card")) return;')) fail("assets/js/nexus-app.js: stale purchasable product cards still survive API failures");
for (const required of ["publicProductsUnavailableMarkup", "Purchasing is paused", "Custom Business Automation", "publicProductPresentation"]) {
  if (!app.includes(required)) fail(`assets/js/nexus-app.js: missing ${required}`);
}

const outputPage = readText("pages/buyer/output.html");
for (const required of ["socialReportBundleUpsell", "social-media-report-bundle", "customerAutomation?.bundle_id"]) {
  if (!outputPage.includes(required)) fail(`pages/buyer/output.html: missing ${required}`);
}

const grantFunction = readText("supabase/functions/nexus-install-request/index.ts");
for (const required of ["admin_grant_options", "admin_grant_product", "grantComplimentaryProduct", "This buyer already has active access", "restorePayload", ".update(restorePayload)", "payment_status: \"paid\""]) {
  if (!grantFunction.includes(required)) fail(`nexus-install-request: missing grant invariant ${required}`);
}
const grantStart = grantFunction.indexOf("async function grantComplimentaryProduct");
const grantEnd = grantFunction.indexOf("async function listDeveloperOrders", grantStart);
const grantBody = grantFunction.slice(grantStart, grantEnd);
if (/stripe\.checkout|create-checkout-session|stripe_payment_intent/i.test(grantBody)) fail("nexus-install-request: complimentary grant unexpectedly invokes Stripe");

const n8nTest = readText("supabase/functions/test-n8n-connection/index.ts");
for (const required of ["requireAdminOrRuntime", "x-nexus-runtime-secret", "Admin access required", "req.method !== \"POST\""]) {
  if (!n8nTest.includes(required)) fail(`test-n8n-connection: missing auth invariant ${required}`);
}
if (n8nTest.includes("n8n_base_url:") || n8nTest.includes("response: data")) fail("test-n8n-connection: still exposes upstream internals");

if (failures.length) {
  console.error(`Production static regression failed (${failures.length} issue${failures.length === 1 ? "" : "s"}):`);
  failures.forEach((message) => console.error(`- ${message}`));
  process.exit(1);
}

console.log(`Production static regression passed (${htmlFiles.length} deployed HTML files, ${tracked.length} tracked source files checked).`);
