const LEGACY_NEXUS_PRODUCT_SLUGS = new Set([
  "inquiry-report",
  "competitor-report",
  "ai-social-media-reports",
  "social-listening-intelligence",
  "ai-customer-support-chatbot",
]);

function cleanString(value: unknown) {
  return String(value || "").trim();
}

export function isLegacyNexusProduct(product: any) {
  const slug = cleanString(product?.slug).toLowerCase();
  if (!LEGACY_NEXUS_PRODUCT_SLUGS.has(slug)) return false;

  const developer = product?.developers || product?.developer || {};
  const developerHandle = cleanString(developer?.handle || product?.developer_handle).toLowerCase();
  const developerName = cleanString(developer?.display_name || product?.developer_name).toLowerCase();

  /*
    These first Nexus-owned marketplace products were launched before the
    credential vault. Their n8n workflows intentionally keep credentials inside
    the hosted n8n instance. Future Nexus and developer products still use the
    stricter import/test/credential pipeline.
  */
  if (!developerHandle && !developerName) return true;

  return (
    developerHandle === "nexus" ||
    developerHandle === "nexus-internal" ||
    developerName === "nexus" ||
    developerName === "nexus internal" ||
    developerName.includes("nexus operator")
  );
}

export function legacyNexusProductSlugs() {
  return Array.from(LEGACY_NEXUS_PRODUCT_SLUGS);
}
