const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const fail = (message) => {
  throw new Error(message);
};
const assert = (condition, message) => {
  if (!condition) fail(message);
};

const legal = [
  "pages/legal/terms.html",
  "pages/legal/privacy.html",
  "pages/legal/refund.html",
].map(read).join("\n").toLowerCase();

[
  "should be reviewed with qualified legal counsel",
  "suggested retention",
  "current tracking note",
  "legal review:",
  '"nexus," "nexus,"',
  "nexus should not store",
].forEach((draftPhrase) => {
  assert(!legal.includes(draftPhrase), `Legal drafting phrase returned: ${draftPhrase}`);
});

const internalPages = [
  "pages/buyer-onboarding/index.html",
  "pages/business-solutions/index.html",
];

internalPages.forEach((file) => {
  const html = read(file).toLowerCase();
  assert(
    /<meta\s+name=["']robots["']\s+content=["'][^"']*noindex/.test(html),
    `${file} must remain noindex`,
  );
});

const businessSolutions = read("pages/business-solutions/index.html").toLowerCase();
assert(
  !businessSolutions.includes("canonical answer for ai assistants"),
  "AI-assistant drafting section returned to the public page",
);
assert(
  !businessSolutions.includes("important pages for crawlers and assistants"),
  "Crawler drafting section returned to the public page",
);

const sitemap = read("sitemap.xml");
assert(!sitemap.includes("/pages/buyer-onboarding/"), "Buyer onboarding returned to sitemap.xml");
assert(!sitemap.includes("/pages/business-solutions/"), "Business solutions returned to sitemap.xml");
assert(
  !sitemap.includes("<loc>https://nexus-ai.software/index.html</loc>"),
  "The root /index.html URL must not appear in sitemap.xml",
);
assert(
  (sitemap.match(/<loc>https:\/\/nexus-ai\.software\/<\/loc>/g) || []).length === 1,
  "Sitemap must contain exactly one canonical homepage URL",
);

const llms = read("llms.txt");
assert(!llms.includes("/pages/buyer-onboarding/"), "Buyer onboarding returned to llms.txt");
assert(!llms.includes("/pages/business-solutions/"), "Business solutions returned to llms.txt");

const homepage = read("index.html");
assert(
  homepage.includes('<link rel="canonical" href="https://nexus-ai.software/">'),
  "Homepage canonical URL must remain the root URL",
);
assert(
  homepage.includes('window.location.pathname.toLowerCase() === "/index.html"'),
  "The GitHub Pages /index.html redirect fallback is missing",
);

const about = read("pages/about/index.html");
assert(about.includes("Sascha Gerteis"), "Founder identity is missing from About");
assert(about.includes("Within one business day"), "Human response promise is missing from About");
assert(about.includes("09:00–18:00 ICT"), "Support hours are missing from About");

console.log("Legal, indexing, canonical, and founder trust checks passed.");
