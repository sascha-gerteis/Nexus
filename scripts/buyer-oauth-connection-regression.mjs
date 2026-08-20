import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), "utf8");

const migration = read("supabase", "migrations", "20260820000100_buyer_oauth_connections.sql");
const oauthFunction = read("supabase", "functions", "oauth-connections", "index.ts");
const credentialFunction = read("supabase", "functions", "developer-credentials", "index.ts");
const provisionFunction = read("supabase", "functions", "provision-customer-workflow", "index.ts");
const submitFunction = read("supabase", "functions", "submit-automation-setup", "index.ts");
const buyerSetup = read("pages", "buyer", "setup.html");
const developerDashboard = read("pages", "developer", "dashboard.html");
const nexusDb = read("assets", "js", "nexus-db.js");

assert.match(migration, /create table if not exists public\.buyer_oauth_connections/i);
assert.match(migration, /revoke all on public\.buyer_oauth_connections from anon, authenticated/i);
assert.match(migration, /code_verifier text/i, "OAuth state must retain a server-side PKCE verifier");
assert.doesNotMatch(migration, /for select\s+using\s*\([^)]*auth\.uid/i, "Buyers must not read encrypted OAuth rows directly");

for (const marker of [
  'action === "start_buyer_google"',
  'action === "list_buyer"',
  'nexus:buyer-google-oauth-complete',
  'forceSyncNativeCredential: true',
  'persistenceTable: "buyer_oauth_connections"',
]) {
  assert.ok(oauthFunction.includes(marker), `Missing OAuth broker marker: ${marker}`);
}

assert.ok(credentialFunction.includes('action === "set_runtime_credential_owner"'));
assert.ok(credentialFunction.includes("preserveRuntimeCredentialOwnership"), "Credential rescans must preserve buyer ownership");
assert.ok(developerDashboard.includes("Require buyer sign-in"), "Shared admin/developer upload must expose ownership");
assert.ok(nexusDb.includes("setAutomationCredentialRuntimeOwner"));

assert.ok(submitFunction.includes("missingRequiredBuyerOAuthConnections"), "Setup must verify OAuth server-side");
assert.ok(submitFunction.includes("missing_oauth_connections"), "Setup must return structured missing-account errors");
assert.ok(
  submitFunction.includes("(!customerRuntimeExists || hasBuyerOAuthRequirements)"),
  "OAuth products must refresh an existing customer clone after account changes",
);

assert.ok(provisionFunction.includes("bindBuyerOAuthCredentials"));
assert.ok(provisionFunction.includes("workflowNodeHasCredential"), "Provisioning must verify the exact node binding");
assert.ok(provisionFunction.includes("developer_credential_requirements,"), "Provisioning must load ownership metadata");

for (const marker of [
  "Secure account connection",
  "Connect Google",
  "buyerOAuthBlockingProblems",
  "nexus:buyer-google-oauth-complete",
]) {
  assert.ok(buyerSetup.includes(marker), `Missing buyer setup marker: ${marker}`);
}

const { applyCredentialToWorkflow, workflowNodeHasCredential } = await import(pathToFileURL(path.join(
  root,
  "supabase/functions/_shared/nexus-credentials.ts",
)).href);

const gmailSlot = {
  node_name: "Send buyer email",
  node_type: "n8n-nodes-base.gmail",
  credential_key: "gmailOAuth2",
  n8n_credential_type: "gmailOAuth2",
  provider: "gmail",
};
const workflow = {
  nodes: [
    {
      name: "Send buyer email",
      type: "n8n-nodes-base.gmail",
      parameters: { operation: "send" },
      credentials: { gmailOAuth2: { id: "developer-id", name: "Developer Gmail" } },
    },
    {
      name: "Unrelated Sheets node",
      type: "n8n-nodes-base.googleSheets",
      parameters: {},
      credentials: { googleSheetsOAuth2Api: { id: "sheets-id", name: "Developer Sheets" } },
    },
  ],
};
const bound = applyCredentialToWorkflow(workflow, gmailSlot, {
  n8n_credential_id: "buyer-gmail-id",
  n8n_credential_name: "Buyer Gmail",
  n8n_credential_type: "gmailOAuth2",
});

assert.equal(bound.nodes[0].credentials.gmailOAuth2.id, "buyer-gmail-id");
assert.equal(bound.nodes[1].credentials.googleSheetsOAuth2Api.id, "sheets-id", "Unrelated credentials must remain untouched");
assert.equal(workflow.nodes[0].credentials.gmailOAuth2.id, "developer-id", "Master workflow input must not be mutated");
assert.equal(workflowNodeHasCredential(bound, gmailSlot, "gmailOAuth2", "buyer-gmail-id"), true);

console.log(JSON.stringify({
  buyerOAuthTablesPrivate: true,
  explicitOwnershipOnly: true,
  serverSetupGate: true,
  exactCloneBinding: true,
  existingProductsUnaffectedByDefault: true,
  passed: true,
}));
