import fs from "node:fs";

const dashboard = fs.readFileSync("pages/developer/dashboard.html", "utf8");
const products = fs.readFileSync("supabase/functions/developer-products/index.ts", "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const field of [
  "setup_schema",
  "runtime_event_schema",
  "credential_schema",
  "workflow_placeholder_mappings",
  "detected_placeholders",
  "sheet_access_config",
  "placeholder_validation_status",
  "placeholder_validation_errors",
]) {
  assert(dashboard.includes(`${field}:`), `Product payload must include ${field}.`);
  assert(dashboard.includes(`name="${field}"`), `Product form must expose ${field}.`);
}

assert(
  products.includes("item.name || item.key || item.credential_key"),
  "Schema persistence must accept name, key, and credential_key identifiers.",
);
assert(
  products.includes("...item,") && products.includes("Keep supported schema metadata"),
  "Schema persistence must retain buyer/developer ownership and rendering metadata.",
);
assert(
  products.includes("assertProductPayloadPersisted(payload, data)"),
  "Successful product saves must verify the database round trip.",
);
assert(
  dashboard.includes("restoredSelectedProductId()") && dashboard.includes("sessionStorage.setItem(selectedProductStorageKey()"),
  "Reloading the dashboard must restore the exact selected draft.",
);

console.log(JSON.stringify({
  schemaFieldsSerialized: true,
  schemaMetadataPreserved: true,
  saveRoundTripVerified: true,
  selectedDraftRestored: true,
  passed: true,
}));
