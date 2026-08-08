const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const page = read("pages/automation-finder/index.html");
const script = read("assets/js/nexus-automation-finder.js");
const css = read("assets/css/automation-finder.css");
const marketplace = read("pages/marketplace/index.html");
const calculator = read("pages/calculator/index.html");
const sitemap = read("sitemap.xml");
const homepage = read("index.html");
const sharedUi = read("assets/js/nexus-ui.js");
const businessSolutions = read("pages/business-solutions/index.html");
const contextualPages = {
  "custom business automation": read("custom-business-automation/index.html"),
  "customer support automation": read("customer-support-automation/index.html"),
  "lead automation": read("lead-automation/index.html"),
  "reporting automation": read("reporting-automation/index.html"),
  "social listening automation": read("social-listening-automation/index.html"),
};
const footerPages = {
  homepage,
  marketplace,
  calculator,
  "business solutions": businessSolutions,
  ...contextualPages,
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(page.includes('id="automationFinderForm"'), "Finder assessment form is missing");
assert(page.includes('id="finderRequestForm"'), "Finder custom request form is missing");
assert(page.includes('name="task_problem"') && page.includes('name="desired_output"'), "Core assessment fields are missing");
assert(page.includes('name="human_review"') && page.includes('name="sensitive_data"'), "Control assessment fields are missing");
assert(page.includes("nexus-automation-finder.js?v=20260806-finder-v1"), "Finder script cache marker is missing");
assert(page.includes("automation-finder.css?v=20260806-finder-v1"), "Finder stylesheet cache marker is missing");
assert(script.includes("listLiveAutomations") && script.includes("listLiveBundles"), "Finder must use the live catalogue");
assert(script.includes('listing_type || "").toLowerCase() !== "custom_request"'), "Custom quote placeholder products must be excluded");
assert(script.includes("accepted") && script.includes("score >= 22"), "Confidence threshold is missing");
assert(script.includes('inquiry_type: "custom_automation"') && script.includes('source: "automation_finder"'), "Custom request inbox contract is missing");
assert(script.includes("automation_finder_assessment") && script.includes("automation_finder_custom_request_submit"), "Finder analytics are missing");
assert(!script.includes("createStripeCheckoutSession") && !script.includes("submitAutomationSetup"), "Finder must not mutate checkout or automation runtime");
assert(css.includes(".finder-match-grid") && css.includes("@media (max-width: 680px)"), "Finder responsive styles are missing");
assert(marketplace.includes('/pages/automation-finder'), "Marketplace Finder entry is missing");
assert(calculator.includes('/pages/automation-finder'), "Calculator Finder entry is missing");
assert(sitemap.includes('https://nexus-ai.software/pages/automation-finder'), "Finder sitemap entry is missing");
assert(homepage.includes('href="/pages/automation-finder">Use Automation Finder</a>'), "Homepage Finder CTA is missing");
assert(!sharedUi.includes('data-i18n="nav_finder"'), "Finder must not be placed in the global header navigation");
assert(page.includes('data-active="marketplace"'), "Finder should retain the Marketplace navigation context");
assert(businessSolutions.includes('href="/pages/automation-finder">Use Automation Finder</a>'), "Business Solutions Finder CTA is missing");
for (const [name, content] of Object.entries(contextualPages)) {
  assert(content.includes('href="/pages/automation-finder">Use Automation Finder</a>'), `${name} Finder CTA is missing`);
}
for (const [name, content] of Object.entries(footerPages)) {
  const footer = content.match(/<footer\b[\s\S]*?<\/footer>/i)?.[0] || "";
  assert(footer.includes('href="/pages/automation-finder">Automation Finder</a>'), `${name} Finder footer link is missing`);
}

console.log("Automation Finder regression checks passed.");
