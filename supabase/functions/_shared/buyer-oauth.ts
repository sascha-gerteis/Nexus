function cleanString(value: unknown) {
  return String(value ?? "").trim();
}

export function buyerRuntimeCredentialOwner(slot: any) {
  const owner = cleanString(
    slot?.runtime_credential_owner ||
    slot?.runtimeCredentialOwner ||
    slot?.credential_owner ||
    slot?.owner,
  ).toLowerCase();
  if (slot?.buyer_owned === true || slot?.customer_owned === true || slot?.customer_connect === true) return "buyer";
  return ["buyer", "customer", "customer_oauth"].includes(owner) ? "buyer" : "developer";
}

export function supportedBuyerGoogleOAuthSlot(slot: any) {
  if (buyerRuntimeCredentialOwner(slot) !== "buyer") return false;
  const type = cleanString(slot?.n8n_credential_type || slot?.credential_key).toLowerCase();
  const provider = cleanString(slot?.provider || slot?.provider_label).toLowerCase();
  if (!type.includes("oauth")) return false;
  return type === "gmailoauth2" || type.startsWith("google") || type.includes("youtube") ||
    provider === "gmail" || provider.startsWith("google") || provider === "youtube";
}

export function automationRequiresBuyerOAuthClone(automation: any) {
  const slots = Array.isArray(automation?.developer_credential_requirements)
    ? automation.developer_credential_requirements
    : [];
  return slots.some(supportedBuyerGoogleOAuthSlot);
}
