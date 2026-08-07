const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = __dirname;
const OUTPUT = path.join(ROOT, "raw-live");
fs.mkdirSync(OUTPUT, { recursive: true });

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = "https://nexus-ai.software";

async function ready(page) {
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForTimeout(1800);
}

async function screenshot(page, filename, options = {}) {
  const outputPath = path.join(OUTPUT, filename);
  await page.screenshot({ path: outputPath, animations: "disabled", ...options });
  return outputPath;
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    executablePath: CHROME,
    args: ["--force-device-scale-factor=1"],
  });

  const desktop = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    colorScheme: "light",
  });
  const page = await desktop.newPage();

  await page.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await ready(page);
  await screenshot(page, "01-home-hero-desktop.png");

  await page.goto(`${BASE}/pages/marketplace/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await ready(page);
  await page.locator("#marketplaceGrid article.product-card").first().waitFor({ state: "visible", timeout: 20_000 });
  await page.locator("#marketplace-products").scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await screenshot(page, "02-marketplace-live-desktop.png");

  const socialCard = page.locator("article.product-card").filter({ hasText: "AI Social Media Reports" }).first();
  await socialCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(350);
  await socialCard.screenshot({ path: path.join(OUTPUT, "03-social-report-product-card.png"), animations: "disabled" });

  const bundleCard = page.locator("article.product-card").filter({ hasText: "Online Visibility Reporting Bundle" }).first();
  await bundleCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(350);
  await bundleCard.screenshot({ path: path.join(OUTPUT, "04-visibility-bundle-product-card.png"), animations: "disabled" });

  await socialCard.getByRole("button", { name: "View output" }).click();
  await page.waitForTimeout(900);
  await screenshot(page, "05-social-report-output-preview.png");
  await page.keyboard.press("Escape").catch(() => {});

  const marketplaceText = await page.locator("body").innerText();
  const liveSummary = {
    captured_at: new Date().toISOString(),
    base_url: BASE,
    marketplace_title: await page.title(),
    social_report_visible: marketplaceText.includes("AI Social Media Reports"),
    visibility_bundle_visible: marketplaceText.includes("Online Visibility Reporting Bundle"),
  };
  fs.writeFileSync(path.join(OUTPUT, "capture-summary.json"), JSON.stringify(liveSummary, null, 2));

  await desktop.close();

  const mobile = await browser.newContext({
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: "light",
  });
  const mobilePage = await mobile.newPage();
  await mobilePage.goto(`${BASE}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await ready(mobilePage);
  await screenshot(mobilePage, "06-home-live-mobile.png");

  await mobilePage.goto(`${BASE}/pages/marketplace/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await ready(mobilePage);
  const mobileGrid = mobilePage.locator("#marketplaceGrid article.product-card");
  await mobileGrid.first().waitFor({ state: "visible", timeout: 20_000 });
  await mobileGrid.first().scrollIntoViewIfNeeded();
  await mobilePage.waitForTimeout(500);
  await screenshot(mobilePage, "07-marketplace-live-mobile.png");

  await mobile.close();
  await browser.close();

  const files = fs.readdirSync(OUTPUT).sort();
  console.log(JSON.stringify({ output: OUTPUT, files }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
