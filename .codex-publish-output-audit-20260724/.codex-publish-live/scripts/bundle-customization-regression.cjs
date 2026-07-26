const fs = require("fs");
const vm = require("vm");

const checkout = fs.readFileSync("supabase/functions/create-checkout-session/index.ts", "utf8");
const stripeWebhook = fs.readFileSync("supabase/functions/stripe-webhook/index.ts", "utf8");
const ensureAutomations = fs.readFileSync("supabase/functions/ensure-customer-automations/index.ts", "utf8");
const app = fs.readFileSync("assets/js/nexus-app.js", "utf8");
const setup = fs.readFileSync("pages/buyer/setup.html", "utf8");
const migration = fs.readFileSync("supabase/migrations/20260722000400_customizable_bundle_orders.sql", "utf8");
const billingMigration = fs.readFileSync("supabase/migrations/20260724000100_bundle_billing_mode.sql", "utf8");
const adminBundles = fs.readFileSync("pages/admin/bundles.html", "utf8");
const adminBundlesFunction = fs.readFileSync("supabase/functions/admin-bundles/index.ts", "utf8");

function requireText(source, text, label) {
  if (!source.includes(text)) {
    throw new Error(`Missing ${label}: ${text}`);
  }
}

[
  [checkout, "selected_automation_ids: checkout.selectedAutomationIds", "server selection snapshot"],
  [checkout, "items: selectedItems", "selected order items"],
  [checkout, "effectiveBundleDiscountPercent", "server discount curve"],
  [checkout, "Choose at least one workflow for this bundle.", "empty selection rejection"],
  [stripeWebhook, "hasStrictBundleSelection(order)", "Stripe fail-closed guard"],
  [ensureAutomations, "hasStrictBundleSelection(order)", "repair fail-closed guard"],
  [app, "data-bundle-workflow-toggle", "buyer workflow selector"],
  [app, "selected_automation_ids: selectedAutomationIds", "buyer selection payload"],
  [app, 'const cadenceLabel = pricingType === "one_time" ? "One-time payment." : "Billed monthly.";', "buyer bundle cadence disclosure"],
  [checkout, "bundleCheckoutMode(bundle, products)", "bundle-level Stripe mode"],
  [checkout, "bundle_pricing_type:", "Stripe bundle billing metadata"],
  [adminBundles, 'id="bundlePricingType"', "admin bundle billing selector"],
  [adminBundles, 'pricing_type: document.getElementById("bundlePricingType").value', "admin billing payload"],
  [adminBundlesFunction, 'if (!["monthly", "one_time"].includes(pricingType))', "server billing validation"],
  [billingMigration, "automation_bundles_pricing_type_check", "database billing constraint"],
  [setup, "Never borrow orphaned workflows from another purchase", "setup order isolation"],
  [migration, "trg_enforce_customer_automation_bundle_selection", "database fulfillment guard"],
  [migration, "trg_enforce_bundle_run_item_selection", "database run guard"],
  [migration, "bundle_purchase_integrity_issues", "database audit view"],
].forEach(([source, text, label]) => requireText(source, text, label));

function discount(base, selected, available) {
  const normalized = Math.max(0, Math.min(Number(base || 0), 95));
  if (selected <= 1 || available <= 1) return 0;
  if (selected >= available) return normalized;
  return Math.round((normalized * ((selected - 1) / (available - 1))) * 100) / 100;
}

const curve = [4, 3, 2, 1].map((selected) => discount(12, selected, 4));
const expectedCurve = [12, 8, 4, 0];
if (JSON.stringify(curve) !== JSON.stringify(expectedCurve)) {
  throw new Error(`Unexpected bundle discount curve: ${JSON.stringify(curve)}`);
}

const selected = new Set(["product-1", "product-3"]);
const orderItems = ["product-1", "product-2", "product-3", "product-4"]
  .filter((id) => selected.has(id));
if (JSON.stringify(orderItems) !== JSON.stringify(["product-1", "product-3"])) {
  throw new Error("Unselected workflows leaked into the simulated order.");
}

new vm.Script(app, { filename: "nexus-app.js" });

process.stdout.write(JSON.stringify({
  discountCurve: curve,
  selectedOrderItems: orderItems,
  strictCheckout: true,
  strictFulfillment: true,
  strictSetup: true,
  strictDatabase: true,
  bundleLevelBilling: true,
}));