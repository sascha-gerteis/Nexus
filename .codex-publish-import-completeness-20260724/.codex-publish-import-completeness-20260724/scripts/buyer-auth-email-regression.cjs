const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

const template = read("supabase/templates/confirmation.html");
const config = read("supabase/config.toml");
const databaseClient = read("assets/js/nexus-db.js");
const registerPage = read("pages/buyer/register.html");
const loginPage = read("pages/buyer/login.html");

assert.equal(
  (template.match(/\{\{\s*\.ConfirmationURL\s*\}\}/g) || []).length,
  3,
  "Confirmation email must keep a button, linked fallback, and visible fallback URL.",
);
assert.match(template, /Confirm my account/);
assert.match(template, /support@nexus-ai\.software/);
assert.doesNotMatch(template, /<script|<link|@import|<img/i);

assert.match(config, /\[auth\.email\.template\.confirmation\]/);
assert.match(config, /subject = "Confirm your Nexus account"/);
assert.match(config, /content_path = "\.\/supabase\/templates\/confirmation\.html"/);

assert.match(
  databaseClient,
  /buyerSignUp\(email, password, metadata = \{\}, nextUrl = "", reason = ""\)/,
);
assert.match(databaseClient, /emailRedirectTo: confirmationRedirect\.toString\(\)/);
assert.match(databaseClient, /confirmationRedirect\.searchParams\.set\("confirmed", "1"\)/);

assert.match(registerPage, /NexusDB\.buyerSignUp\([\s\S]*?next,[\s\S]*?reason[\s\S]*?\);/);
assert.match(registerPage, /<strong>Check your inbox\.<\/strong>/);
assert.doesNotMatch(registerPage, /If Supabase email confirmation is enabled/);

assert.match(loginPage, /params\.get\("confirmed"\) === "1"/);
assert.match(loginPage, /<strong>Email confirmed\.<\/strong>/);

console.log("Buyer auth email regression checks passed.");
