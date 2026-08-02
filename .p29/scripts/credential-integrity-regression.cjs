const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const assert = (condition, message) => {
  if (!condition) throw new Error(`Credential integrity regression failed: ${message}`);
};
const includesAll = (source, markers, label) => {
  for (const marker of markers) assert(source.includes(marker), `${label} is missing: ${marker}`);
};

const credentials = read("supabase/functions/_shared/nexus-credentials.ts");
const technicalTest = read("supabase/functions/test-n8n-workflow/index.ts");
const developerCredentials = read("supabase/functions/developer-credentials/index.ts");
const developerDashboard = read("pages/developer/dashboard.html");

includesAll(credentials, [
  "export function credentialMatchScore",
  "const gmailSlot =",
  "credentialProviderName && credentialProviderName !== \"gmail\"",
  "!credentialProviderName && credentialType !== \"gmailoauth2\"",
  "credentialType !== \"gmailoauth2\"",
  "googleServiceAccountCredential && !canPreferGoogleServiceAccountForSlot(slot)",
  "function credentialSelectionForSlot",
  "credentialSelection.ambiguous",
  "More than one saved",
  "n8n-nodes-base.stickynote",
  "if (isNonCredentialUtilityNode(node) || isNexusInternalRuntimeNode(node)) continue;",
  "getLiveN8nCredentialSummaries(credentialSyncAttempted)",
  "liveN8nCredentialLookupFailed",
  "requiresNativeAccountSetup(slot, slotCredentialType) &&\n      liveN8nCredentialLookupFailed",
  "no longer exists in hosted n8n",
  "Reconnect Gmail with Connect Google",
], "shared credential safety");

includesAll(technicalTest, [
  "const credentialFailure = failed && isCredentialAuthFailureText(credentialFailureText)",
  ".map((value) => cleanString(value))",
  "credential_binding_status: \"needs_credentials\"",
  "credential_binding_errors: [...retainedErrors, ...failureErrors]",
  "n8n_last_credential_bound_at: null",
  ".from(\"developer_credentials\")",
  "status: \"needs_attention\"",
  "detected_by_technical_test: true",
], "technical-test credential downgrade");

includesAll(developerCredentials, [
  "const retainedTechnicalTestErrors =",
  "Boolean(error?.detected_by_technical_test)",
  "const errors = [...missingErrors, ...retainedTechnicalTestErrors]",
  "n8n_last_credential_bound_at: !errors.length",
], "credential scan failure retention");

includesAll(developerDashboard, [
  'lowerText.includes("credential with id")',
  "The saved Gmail account no longer exists in hosted n8n.",
  "await scanCurrentProductCredentials();",
  "Set up in n8n instead",
  "Open n8n editor",
  'provider === "gmail" || slotType === "gmailoauth2"',
], "developer credential guidance");

console.log("Credential integrity regression passed.");
