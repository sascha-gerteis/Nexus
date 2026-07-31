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
const lifecycleTemplates = read("supabase/functions/_shared/nexus-email.ts");
const emailSender = read("supabase/functions/send-platform-email/index.ts");

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

assert.doesNotMatch(lifecycleTemplates, /<script(?=[\\s>])|<link(?=[\\s>])|@import|<img(?=[\\s>])/i);
assert.doesNotMatch(lifecycleTemplates, /\?without|let\?s/);
assert.match(lifecycleTemplates, /Business automation marketplace/);
assert.match(lifecycleTemplates, /Most purchased on Nexus/);
assert.match(lifecycleTemplates, /Explore Nexus automations/);
assert.match(lifecycleTemplates, /View the Nexus bestseller/);
assert.match(lifecycleTemplates, /request a custom workflow/);
assert.match(lifecycleTemplates, /case "automation_output_ready"/);
assert.match(lifecycleTemplates, /View your result/);
assert.match(lifecycleTemplates, /safeEnqueueOutputReadyEmail/);
assert.match(lifecycleTemplates, /automation_output_ready:\$\{outputId\}/);
assert.match(lifecycleTemplates, /pages\/buyer\/output\.html\?id=/);
assert.match(emailSender, /loadBestSellingRecommendation/);
assert.match(emailSender, /\.eq\("payment_status", "paid"\)/);
assert.match(emailSender, /\.eq\("status", "live"\)/);
assert.match(emailSender, /\.eq\("status", "active"\)/);
assert.match(emailSender, /refreshOnboardingEmail\(adminClient, locked\)/);
assert.match(emailSender, /\["buyer_welcome", "buyer_choose_first"\]/);
assert.match(emailSender, /recommended_href: `\/pages\/marketplace\/index\.html\?\$\{parameter\}=/);

console.log("Buyer auth email regression checks passed.");
