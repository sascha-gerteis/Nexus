"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const ignoredDirectories = new Set([
  ".git",
  ".agents",
  ".codex",
  ".codex-backups",
  ".p29",
  "node_modules",
  "nexus-phase1-final",
]);

function walk(directory, filter) {
  const results = [];

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && (ignoredDirectories.has(entry.name) || entry.name.startsWith(".codex-publish"))) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) results.push(...walk(absolute, filter));
    if (entry.isFile() && filter(absolute)) results.push(absolute);
  }

  return results;
}

function relative(file) {
  return path.relative(root, file).replaceAll("\\", "/");
}

function read(file) {
  return fs.readFileSync(file, "utf8");
}

const htmlFiles = walk(root, (file) => file.endsWith(".html"));
const legacyLinkPattern = /href=["'](?:https:\/\/nexus-ai\.software)?\/[^"']*\/index\.html(?:[?#][^"']*)?["']/gi;
const canonicalIndexPattern = /<link\b[^>]*rel=["']canonical["'][^>]*href=["'][^"']*\/index\.html["'][^>]*>/gi;

for (const file of htmlFiles) {
  const source = read(file);
  assert.equal(
    (source.match(legacyLinkPattern) || []).length,
    0,
    `${relative(file)} still contains an internal /index.html link`,
  );
  assert.equal(
    (source.match(canonicalIndexPattern) || []).length,
    0,
    `${relative(file)} still contains an /index.html canonical URL`,
  );
}

const runtimeFiles = [
  ...walk(path.join(root, "assets", "js"), (file) => file.endsWith(".js")),
  ...walk(path.join(root, "supabase", "functions"), (file) => file.endsWith(".ts")),
  path.join(root, "sitemap.xml"),
  path.join(root, "llms.txt"),
];

for (const file of runtimeFiles) {
  const source = read(file);
  assert.ok(
    !/\/(?:[a-z0-9._~-]+\/)+index\.html(?:[?#"'`]|$)/i.test(source),
    `${relative(file)} still emits a nested /index.html URL`,
  );
}

const sitemap = read(path.join(root, "sitemap.xml"));
assert.ok(!sitemap.includes("/index.html"), "Sitemap URLs must use clean paths");

const sharedUi = read(path.join(root, "assets", "js", "nexus-ui.js"));
assert.ok(sharedUi.includes("function cleanInternalPathname"), "Shared clean-path compatibility helper is missing");
assert.ok(
  sharedUi.includes('const legacyIndexSuffix = "/" + "index.html";') &&
    sharedUi.includes("endsWith(legacyIndexSuffix)"),
  "Shared clean-path helper must still recognize legacy index.html URLs",
);
assert.ok(sharedUi.includes('href="/pages/marketplace"'), "Global Marketplace navigation must use a clean path");
assert.ok(sharedUi.includes('href="/"'), "Global home navigation must use the root URL");
assert.ok(!sharedUi.includes('href="/index.html"'), "Global navigation must not link to /index.html");

const missingRoutes = [];
for (const file of htmlFiles) {
  const source = read(file);
  for (const match of source.matchAll(/href=["'](\/[^"'#?]*)(?:[?#][^"']*)?["']/gi)) {
    const route = match[1];
    if (!route || route === "/" || path.posix.extname(route)) continue;
    if (route.includes("${") || route.includes("{{")) continue;

    const normalized = route.replace(/^\/+|\/+$/g, "");
    const target = path.join(root, ...normalized.split("/"), "index.html");
    if (!fs.existsSync(target)) missingRoutes.push(`${relative(file)} -> ${route}`);
  }
}

assert.deepEqual(missingRoutes, [], `Clean routes without a physical index page:\n${missingRoutes.join("\n")}`);

console.log(`Clean URL regression passed across ${htmlFiles.length} HTML files.`);
