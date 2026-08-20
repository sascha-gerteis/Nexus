import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import {
  credentialFingerprint,
  decryptCredentialPayload,
  encryptCredentialPayload,
  lastFourFromSecretPayload,
  providerPreset,
  syncCredentialToN8n,
} from "../_shared/nexus-credentials.ts";

function env(name: string) {
  return Deno.env.get(name) || "";
}

function cleanString(value: unknown, maxLength = 4000) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function lower(value: unknown) {
  return cleanString(value).toLowerCase();
}

function asObject(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, any>;
}

function cleanBaseUrl(value: string) {
  return cleanString(value).replace(/\/+$/, "");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64Url(bytes: Uint8Array) {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function pkceChallenge(verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

function googleRedirectUri() {
  return cleanString(env("GOOGLE_OAUTH_REDIRECT_URI")) ||
    `${cleanBaseUrl(env("SUPABASE_URL"))}/functions/v1/oauth-connections`;
}

function nexusSiteUrl() {
  return cleanBaseUrl(env("NEXUS_SITE_URL") || "https://nexus-ai.software");
}

function callbackHtml(payload: Record<string, unknown>) {
  const safePayload = JSON.stringify(payload)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e");
  const ok = payload.ok !== false;
  const title = ok ? "Google connected" : "Google connection failed";
  const message = cleanString(payload.message || payload.error || (ok ? "You can close this window." : "Please try again."));

  return new Response(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title}</title>
  <style>
    body{font-family:Inter,Arial,sans-serif;background:#f2f8ff;color:#082044;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}
    main{max-width:520px;background:#fff;border:1px solid #d7e8ff;border-radius:24px;padding:28px;box-shadow:0 18px 60px rgba(8,32,68,.12)}
    h1{margin:0 0 10px;font-size:28px;line-height:1.1}
    p{margin:0 0 18px;color:#61718b;font-size:17px;line-height:1.55}
    a,button{display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:14px;background:#1387ff;color:#fff;font-weight:900;font-size:16px;padding:12px 18px;text-decoration:none;cursor:pointer}
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${message}</p>
    <button type="button" onclick="window.close()">Close window</button>
  </main>
  <script>
    const payload = ${safePayload};
    try {
      if (window.opener && !window.opener.closed) {
        const eventType = payload.event_type || "nexus:google-oauth-complete";
        const targetOrigin = payload.target_origin || ${JSON.stringify(nexusSiteUrl())};
        window.opener.postMessage({ type: eventType, ...payload }, targetOrigin);
        setTimeout(() => window.close(), 900);
      }
    } catch (_error) {}
  </script>
</body>
</html>`, {
    status: ok ? 200 : 400,
    headers: {
      ...corsHeaders,
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

async function getUserFromRequest(req: Request, supabaseUrl: string, anonKey: string) {
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return null;

  const token = authHeader.replace("Bearer ", "").trim();
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

async function getOperatorContext(adminClient: any, userId: string) {
  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("id, role")
    .eq("id", userId)
    .maybeSingle();

  if (profileError || !profile || !["admin", "developer"].includes(profile.role)) {
    return null;
  }

  if (profile.role !== "developer") {
    return { profile, developer: null };
  }

  const { data: developer, error: developerError } = await adminClient
    .from("developers")
    .select("id, profile_id, display_name, handle")
    .eq("profile_id", userId)
    .maybeSingle();

  if (developerError || !developer) return null;
  return { profile, developer };
}

function scopesForGoogleCredential(provider: string, credentialType: string, requestedScope: string, includeDefaults = true) {
  const scopes = new Set<string>();
  const addMany = (value: string) => {
    cleanString(value)
      .split(/\s+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((scope) => scopes.add(scope));
  };

  addMany("openid email profile");
  addMany(requestedScope);

  const cleanProvider = lower(provider);
  const cleanType = lower(credentialType);

  if (!includeDefaults) {
    return Array.from(scopes).join(" ");
  }

  if (cleanProvider === "gmail" || cleanType === "gmailoauth2") {
    addMany("https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.modify");
  } else if (cleanProvider === "google_drive" || cleanType === "googledriveoauth2api") {
    addMany("https://www.googleapis.com/auth/drive");
  } else if (cleanProvider === "google_calendar" || cleanType === "googlecalendaroauth2api") {
    addMany("https://www.googleapis.com/auth/calendar");
  } else if (cleanProvider === "google_docs" || cleanType === "googledocsoauth2api") {
    addMany("https://www.googleapis.com/auth/documents https://www.googleapis.com/auth/drive.file");
  } else if (cleanProvider === "google_analytics" || cleanType === "googleanalyticsoauth2api") {
    addMany("https://www.googleapis.com/auth/analytics.readonly");
  } else if (cleanProvider === "google_ads" || cleanType === "googleadsoauth2api") {
    addMany("https://www.googleapis.com/auth/adwords");
  } else if (cleanProvider === "youtube" || cleanType.includes("youtube")) {
    addMany("https://www.googleapis.com/auth/youtube.readonly");
  } else {
    addMany("https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file");
  }

  return Array.from(scopes).join(" ");
}

function sanitizedReturnUrl(value: unknown) {
  const raw = cleanString(value, 1000);
  if (!raw) return `${nexusSiteUrl()}/pages/developer/dashboard.html#products`;
  if (raw.startsWith("/")) return `${nexusSiteUrl()}${raw}`;

  try {
    const url = new URL(raw);
    const site = new URL(nexusSiteUrl());
    if (
      url.hostname === site.hostname ||
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1"
    ) {
      return url.toString();
    }
  } catch {
    return `${nexusSiteUrl()}/pages/developer/dashboard.html#products`;
  }

  return `${nexusSiteUrl()}/pages/developer/dashboard.html#products`;
}

function friendlySetupError(message: string) {
  const lowerMessage = lower(message);
  if (
    lowerMessage.includes("oauth_connections") ||
    lowerMessage.includes("oauth_connection_states") ||
    lowerMessage.includes("buyer_oauth_connections") ||
    lowerMessage.includes("buyer_oauth_connection_states") ||
    lowerMessage.includes("schema cache")
  ) {
    const patchFile = lowerMessage.includes("buyer_oauth_")
      ? "supabase/buyer_oauth_connections_install_or_patch.sql"
      : "supabase/oauth_connections_install_or_patch.sql";
    return `${message} Run ${patchFile} in the Supabase SQL editor, then deploy oauth-connections.`;
  }
  return message;
}

function providerLabel(provider: string, credentialType: string) {
  return providerPreset(provider)?.label ||
    providerPreset(credentialType)?.label ||
    cleanString(provider || credentialType || "Google");
}

function normalizedProvider(provider: string, credentialType: string) {
  const preset = providerPreset(provider) || providerPreset(credentialType);
  return cleanString(preset?.provider || provider || "google");
}

function normalizedCredentialType(provider: string, credentialType: string) {
  return cleanString(credentialType || providerPreset(provider)?.n8nCredentialType || "gmailOAuth2");
}

function normalizedRequirementPart(value: unknown) {
  return lower(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function buyerRuntimeCredentialOwner(slot: any) {
  const owner = lower(
    slot?.runtime_credential_owner ||
    slot?.runtimeCredentialOwner ||
    slot?.credential_owner ||
    slot?.owner,
  );
  if (slot?.buyer_owned === true || slot?.customer_owned === true || slot?.customer_connect === true) return "buyer";
  return ["buyer", "customer", "customer_oauth"].includes(owner) ? "buyer" : "developer";
}

function supportedBuyerGoogleOAuthSlot(slot: any) {
  if (buyerRuntimeCredentialOwner(slot) !== "buyer") return false;
  const type = lower(slot?.n8n_credential_type || slot?.credential_key);
  const provider = lower(slot?.provider || slot?.provider_label);
  if (!type.includes("oauth")) return false;
  return (
    type === "gmailoauth2" ||
    type.startsWith("google") ||
    type.includes("youtube") ||
    provider === "gmail" ||
    provider.startsWith("google") ||
    provider === "youtube"
  );
}

function buyerOAuthRequirementKey(slot: any) {
  const provider = normalizedRequirementPart(slot?.provider || slot?.provider_label || "google");
  const credentialType = normalizedRequirementPart(slot?.n8n_credential_type || slot?.credential_key || "oauth");
  return `${provider || "google"}:${credentialType || "oauth"}`;
}

function explicitSlotScopes(slot: any) {
  const raw = slot?.runtime_oauth_scopes || slot?.oauth_scopes || slot?.scopes || slot?.scope || "";
  return (Array.isArray(raw) ? raw : cleanString(raw).split(/[\s,]+/))
    .map((value: unknown) => cleanString(value))
    .filter(Boolean);
}

function exactBuyerGoogleScopes(slots: any[]) {
  const scopes = new Set<string>(["openid", "email", "profile"]);
  const add = (value: string) => scopes.add(value);
  const types = slots.map((slot) => lower(slot?.n8n_credential_type || slot?.credential_key));

  slots.flatMap(explicitSlotScopes).forEach(add);

  if (types.some((type) => type === "gmailoauth2")) {
    const operationText = lower(slots.map((slot) => [slot?.node_name, slot?.summary?.operation, slot?.summary?.title].filter(Boolean).join(" ")).join(" "));
    if (/\b(send|draft|compose|reply)\b/.test(operationText) && !/\b(read|label|organize|search|get|list|watch|modify|delete|archive)\b/.test(operationText)) {
      add("https://www.googleapis.com/auth/gmail.send");
    } else {
      add("https://www.googleapis.com/auth/gmail.modify");
    }
  }
  if (types.some((type) => type === "googlesheetsoauth2api")) {
    add("https://www.googleapis.com/auth/spreadsheets");
    add("https://www.googleapis.com/auth/drive.file");
  }
  if (types.some((type) => type === "googledriveoauth2api")) add("https://www.googleapis.com/auth/drive");
  if (types.some((type) => type === "googlecalendaroauth2api")) add("https://www.googleapis.com/auth/calendar");
  if (types.some((type) => type === "googledocsoauth2api")) {
    add("https://www.googleapis.com/auth/documents");
    add("https://www.googleapis.com/auth/drive.file");
  }
  if (types.some((type) => type === "googleanalyticsoauth2api")) add("https://www.googleapis.com/auth/analytics.readonly");
  if (types.some((type) => type === "googleadsoauth2api")) add("https://www.googleapis.com/auth/adwords");
  if (types.some((type) => type.includes("youtube"))) add("https://www.googleapis.com/auth/youtube.readonly");

  return Array.from(scopes).join(" ");
}

function buyerOAuthRequirements(product: any) {
  const slots = Array.isArray(product?.developer_credential_requirements)
    ? product.developer_credential_requirements.map(asObject).filter(supportedBuyerGoogleOAuthSlot)
    : [];
  const groups = new Map<string, any[]>();

  for (const slot of slots) {
    const key = buyerOAuthRequirementKey(slot);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(slot);
  }

  return Array.from(groups.entries()).map(([requirementKey, groupedSlots]) => {
    const first = groupedSlots[0] || {};
    const credentialType = cleanString(first.n8n_credential_type || first.credential_key);
    const provider = normalizedProvider(cleanString(first.provider || "google"), credentialType);
    return {
      requirement_key: requirementKey,
      provider,
      provider_label: providerLabel(provider, credentialType),
      n8n_credential_type: credentialType,
      required: first.required !== false,
      scopes: exactBuyerGoogleScopes(groupedSlots),
      nodes: groupedSlots.map((slot) => ({
        node_name: cleanString(slot.node_name),
        node_type: cleanString(slot.node_type),
        credential_key: cleanString(slot.credential_key || slot.n8n_credential_type),
        n8n_credential_type: cleanString(slot.n8n_credential_type || slot.credential_key),
      })),
      slot: first,
    };
  });
}

async function loadBuyerOAuthTarget(adminClient: any, buyerId: string, customerAutomationId: string) {
  if (!customerAutomationId) throw new Error("customer_automation_id is required.");
  const { data: customerAutomation, error } = await adminClient
    .from("customer_automations")
    .select("id,buyer_id,automation_id,order_id")
    .eq("id", customerAutomationId)
    .maybeSingle();
  if (error || !customerAutomation) throw new Error(error?.message || "Customer automation not found.");
  if (cleanString(customerAutomation.buyer_id) !== cleanString(buyerId)) {
    throw new Error("You do not have access to this customer automation.");
  }

  const { data: product, error: productError } = await adminClient
    .from("automations")
    .select("id,title,developer_credential_requirements")
    .eq("id", customerAutomation.automation_id)
    .maybeSingle();
  if (productError || !product) throw new Error(productError?.message || "Product not found.");

  return { customerAutomation, product, requirements: buyerOAuthRequirements(product) };
}

async function createBuyerOAuthState(adminClient: any, buyerId: string, body: Record<string, any>) {
  const target = await loadBuyerOAuthTarget(adminClient, buyerId, cleanString(body.customer_automation_id));
  const requirementKey = cleanString(body.requirement_key);
  const requirement = target.requirements.find((item: any) => item.requirement_key === requirementKey);
  if (!requirement) {
    throw new Error("This product does not declare that account as buyer-connected. Ask Nexus to review the product credential ownership.");
  }

  const verifier = `${randomToken()}${randomToken()}`;
  const challenge = await pkceChallenge(verifier);
  const stateToken = `buyer-${crypto.randomUUID()}-${randomToken()}`;
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const label = `${requirement.provider_label} · ${cleanString(target.product.title) || "Nexus automation"}`;

  const { data, error } = await adminClient
    .from("buyer_oauth_connection_states")
    .insert({
      state_token: stateToken,
      buyer_id: buyerId,
      customer_automation_id: target.customerAutomation.id,
      automation_id: target.product.id,
      provider: requirement.provider,
      requirement_key: requirement.requirement_key,
      credential_type: requirement.n8n_credential_type,
      label,
      scope: scopesForGoogleCredential(requirement.provider, requirement.n8n_credential_type, requirement.scopes, false),
      slot: { ...requirement.slot, nodes: requirement.nodes },
      code_verifier: verifier,
      code_challenge: challenge,
      return_url: sanitizedReturnUrl(body.return_url),
      expires_at: expiresAt,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

async function upsertBuyerOAuthConnection(adminClient: any, state: any, tokenData: any, userInfo: any, encryptedPayload: any) {
  const { data: existing, error: existingError } = await adminClient
    .from("buyer_oauth_connections")
    .select("*")
    .eq("customer_automation_id", state.customer_automation_id)
    .eq("requirement_key", state.requirement_key)
    .neq("status", "revoked")
    .limit(1)
    .maybeSingle();
  if (existingError) throw new Error(existingError.message);

  const email = lower(userInfo.email || tokenData.email);
  const scopes = cleanString(tokenData.scope || state.scope).split(/\s+/).map((value) => value.trim()).filter(Boolean);
  const patch = {
    buyer_id: state.buyer_id,
    customer_automation_id: state.customer_automation_id,
    automation_id: state.automation_id,
    provider: state.provider,
    provider_label: providerLabel(state.provider, state.credential_type),
    requirement_key: state.requirement_key,
    label: state.label,
    provider_account_email: email || null,
    provider_account_id: cleanString(userInfo.sub || userInfo.id || email) || null,
    scopes,
    status: "active",
    encrypted_payload: encryptedPayload,
    token_expires_at: tokenData.expires_in ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString() : null,
    n8n_credential_type: state.credential_type,
    n8n_credential_id: existing?.n8n_credential_id || null,
    n8n_credential_name: existing?.n8n_credential_name || state.label,
    last_error: null,
    metadata: {
      google_scope: tokenData.scope || state.scope,
      redirect_uri: googleRedirectUri(),
      nodes: asObject(state.slot).nodes || [],
    },
    updated_at: new Date().toISOString(),
  };

  const request = existing?.id
    ? adminClient.from("buyer_oauth_connections").update(patch).eq("id", existing.id)
    : adminClient.from("buyer_oauth_connections").insert(patch);
  const { data, error } = await request.select().single();
  if (error) throw new Error(error.message);
  return data;
}

function safeBuyerConnection(connection: any) {
  return {
    id: connection?.id || null,
    customer_automation_id: connection?.customer_automation_id || null,
    requirement_key: connection?.requirement_key || "",
    provider: connection?.provider || "",
    provider_label: connection?.provider_label || "",
    label: connection?.label || "",
    provider_account_email: connection?.provider_account_email || "",
    scopes: Array.isArray(connection?.scopes) ? connection.scopes : [],
    status: connection?.status || "not_connected",
    n8n_credential_type: connection?.n8n_credential_type || "",
    last_error: connection?.last_error || "",
    created_at: connection?.created_at || null,
    updated_at: connection?.updated_at || null,
  };
}

async function listBuyerOAuthConnections(adminClient: any, buyerId: string, body: Record<string, any>) {
  const target = await loadBuyerOAuthTarget(adminClient, buyerId, cleanString(body.customer_automation_id));
  if (!target.requirements.length) {
    return { requirements: [], connections: [] };
  }
  const { data, error } = await adminClient
    .from("buyer_oauth_connections")
    .select("id,customer_automation_id,requirement_key,provider,provider_label,label,provider_account_email,scopes,status,n8n_credential_type,last_error,created_at,updated_at")
    .eq("buyer_id", buyerId)
    .eq("customer_automation_id", target.customerAutomation.id)
    .neq("status", "revoked")
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);

  return {
    requirements: target.requirements.map((requirement: any) => ({
      requirement_key: requirement.requirement_key,
      provider: requirement.provider,
      provider_label: requirement.provider_label,
      n8n_credential_type: requirement.n8n_credential_type,
      required: requirement.required,
      nodes: requirement.nodes,
    })),
    connections: (data || []).map(safeBuyerConnection),
  };
}

async function disconnectBuyerOAuthConnection(adminClient: any, buyerId: string, body: Record<string, any>) {
  const target = await loadBuyerOAuthTarget(adminClient, buyerId, cleanString(body.customer_automation_id));
  const requirementKey = cleanString(body.requirement_key);
  const { data: connection, error } = await adminClient
    .from("buyer_oauth_connections")
    .select("*")
    .eq("buyer_id", buyerId)
    .eq("customer_automation_id", target.customerAutomation.id)
    .eq("requirement_key", requirementKey)
    .neq("status", "revoked")
    .maybeSingle();
  if (error || !connection) throw new Error(error?.message || "Connected account not found.");

  try {
    const credentialSecret = cleanString(env("NEXUS_CREDENTIAL_SECRET"));
    if (credentialSecret && connection.encrypted_payload) {
      const tokenPayload = await decryptCredentialPayload(connection.encrypted_payload, credentialSecret);
      const revokeToken = cleanString(tokenPayload.refresh_token || tokenPayload.access_token);
      if (revokeToken) {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(revokeToken)}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });
      }
    }
  } catch (revokeError) {
    console.warn("Could not revoke Google token during buyer disconnect:", revokeError);
  }

  const { data: updated, error: updateError } = await adminClient
    .from("buyer_oauth_connections")
    .update({
      status: "revoked",
      encrypted_payload: null,
      last_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", connection.id)
    .select()
    .single();
  if (updateError) throw new Error(updateError.message);
  return safeBuyerConnection(updated);
}

async function createOAuthState(adminClient: any, operator: any, body: Record<string, any>) {
  const provider = normalizedProvider(cleanString(body.provider || "gmail"), cleanString(body.n8n_credential_type));
  const credentialType = normalizedCredentialType(provider, cleanString(body.n8n_credential_type));
  const scope = scopesForGoogleCredential(provider, credentialType, cleanString(body.scope || body.oauth_scope));
  const label = cleanString(body.label) ||
    `${providerLabel(provider, credentialType)} account`;
  const stateToken = `${crypto.randomUUID()}-${randomToken()}`;
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const { data, error } = await adminClient
    .from("oauth_connection_states")
    .insert({
      state_token: stateToken,
      provider,
      owner_profile_id: operator.profile.id,
      developer_id: operator.developer?.id || null,
      owner_role: operator.profile.role === "developer" ? "developer" : "admin",
      automation_id: cleanString(body.automation_id) || null,
      credential_type: credentialType,
      label,
      scope,
      slot: asObject(body.slot),
      return_url: sanitizedReturnUrl(body.return_url),
      expires_at: expiresAt,
    })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

function googleAuthUrl(state: any) {
  const clientId = cleanString(env("GOOGLE_OAUTH_CLIENT_ID"));
  if (!clientId) throw new Error("Missing GOOGLE_OAUTH_CLIENT_ID.");

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: cleanString(state.scope),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: cleanString(state.state_token),
  });

  if (cleanString(state.code_challenge)) {
    params.set("code_challenge", cleanString(state.code_challenge));
    params.set("code_challenge_method", "S256");
  }

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeGoogleCode(code: string, codeVerifier = "") {
  const clientId = cleanString(env("GOOGLE_OAUTH_CLIENT_ID"));
  const clientSecret = cleanString(env("GOOGLE_OAUTH_CLIENT_SECRET"));
  if (!clientId || !clientSecret) {
    throw new Error("Missing Google OAuth client secrets.");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code",
      ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.error_description || data?.error || "Google OAuth token exchange failed.");
  }
  return data;
}

async function fetchGoogleUserInfo(accessToken: string) {
  if (!accessToken) return {};

  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) return {};
  return response.json().catch(() => ({}));
}

async function upsertOAuthConnection(adminClient: any, state: any, tokenData: any, userInfo: any, encryptedPayload: any) {
  const email = lower(userInfo.email || tokenData.email);
  const providerAccountId = cleanString(userInfo.sub || userInfo.id || email);
  const scopes = cleanString(tokenData.scope || state.scope)
    .split(/\s+/)
    .map((scope) => scope.trim())
    .filter(Boolean);

  let query = adminClient
    .from("oauth_connections")
    .select("*")
    .eq("provider", state.provider)
    .eq("label", state.label)
    .neq("status", "revoked")
    .limit(1);

  if (state.developer_id) {
    query = query.eq("developer_id", state.developer_id);
  } else {
    query = query.is("developer_id", null).eq("owner_profile_id", state.owner_profile_id);
  }

  const { data: existing, error: existingError } = await query.maybeSingle();
  if (existingError) throw new Error(existingError.message);

  const patch = {
    provider: state.provider,
    provider_label: providerLabel(state.provider, state.credential_type),
    owner_profile_id: state.owner_profile_id,
    developer_id: state.developer_id || null,
    owner_role: state.owner_role,
    label: state.label,
    provider_account_email: email || null,
    provider_account_id: providerAccountId || null,
    scopes,
    status: "active",
    encrypted_token_payload: encryptedPayload,
    token_expires_at: tokenData.expires_in
      ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString()
      : null,
    n8n_credential_type: state.credential_type,
    last_error: null,
    metadata: {
      google_scope: tokenData.scope || state.scope,
      redirect_uri: googleRedirectUri(),
    },
    updated_by: state.owner_profile_id,
    updated_at: new Date().toISOString(),
    ...(existing?.id ? {} : { created_by: state.owner_profile_id }),
  };

  const request = existing?.id
    ? adminClient.from("oauth_connections").update(patch).eq("id", existing.id)
    : adminClient.from("oauth_connections").insert(patch);

  const { data, error } = await request.select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function upsertDeveloperCredential(adminClient: any, state: any, tokenPayload: Record<string, any>, encryptedPayload: any) {
  const provider = cleanString(state.provider);
  const credentialType = cleanString(state.credential_type);
  const label = cleanString(state.label);
  const fingerprint = await credentialFingerprint(tokenPayload);
  const lastFour = lastFourFromSecretPayload(tokenPayload);

  let query = adminClient
    .from("developer_credentials")
    .select("*")
    .eq("provider", provider)
    .ilike("label", label)
    .neq("status", "revoked")
    .limit(1);

  if (state.developer_id) {
    query = query.eq("developer_id", state.developer_id);
  } else {
    query = query.is("developer_id", null).eq("owner_profile_id", state.owner_profile_id);
  }

  const { data: existing, error: existingError } = await query.maybeSingle();
  if (existingError) throw new Error(existingError.message);

  const patch = {
    developer_id: state.developer_id || null,
    owner_profile_id: state.owner_profile_id,
    owner_role: state.owner_role,
    provider,
    provider_label: providerLabel(provider, credentialType),
    credential_type: "oauth_connection",
    label,
    n8n_credential_type: credentialType,
    n8n_credential_id: existing?.n8n_credential_id || null,
    n8n_credential_name: existing?.n8n_credential_name || label,
    status: "active",
    test_status: existing?.test_status || "untested",
    last_four: lastFour,
    fingerprint,
    encrypted_payload: encryptedPayload,
    metadata: {
      ...(existing?.metadata || {}),
      oauth_connection_provider: "google",
      provider_account_email: tokenPayload.connected_email || null,
    },
    last_error: null,
    updated_by: state.owner_profile_id,
    updated_at: new Date().toISOString(),
    ...(existing?.id ? {} : { created_by: state.owner_profile_id }),
  };

  const request = existing?.id
    ? adminClient.from("developer_credentials").update(patch).eq("id", existing.id)
    : adminClient.from("developer_credentials").insert(patch);

  const { data, error } = await request.select().single();
  if (error) throw new Error(error.message);
  return data;
}

async function syncCredentialIfPossible(adminClient: any, state: any, credential: any) {
  const n8nBaseUrl = cleanBaseUrl(env("N8N_BASE_URL"));
  const n8nApiKey = cleanString(env("N8N_API_KEY"));
  const credentialSecret = cleanString(env("NEXUS_CREDENTIAL_SECRET"));

  if (!n8nBaseUrl || !n8nApiKey || !credentialSecret) {
    return {
      credential,
      warning: "Google connected, but n8n sync is not configured. Press Apply credentials after deployment secrets are set.",
    };
  }

  try {
    const synced = await syncCredentialToN8n({
      adminClient,
      credential,
      credentialSecret,
      n8nBaseUrl,
      n8nApiKey,
      credentialType: state.credential_type,
      credentialName: credential.n8n_credential_name || credential.label,
      slot: state.slot,
    });
    return { credential: synced, warning: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not sync Google credential to n8n.";
    const { data } = await adminClient
      .from("developer_credentials")
      .update({
        status: "needs_attention",
        last_error: message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", credential.id)
      .select()
      .single();

    return {
      credential: data || credential,
      warning: `Google connected, but n8n credential sync needs attention: ${message}`,
    };
  }
}

function callbackTargetOrigin(returnUrl: unknown) {
  try {
    return new URL(cleanString(returnUrl)).origin;
  } catch {
    return nexusSiteUrl();
  }
}

async function handleBuyerCallback(adminClient: any, url: URL, stateToken: string) {
  const code = cleanString(url.searchParams.get("code"));
  const googleError = cleanString(url.searchParams.get("error"));
  const { data: state, error: stateError } = await adminClient
    .from("buyer_oauth_connection_states")
    .select("*")
    .eq("state_token", stateToken)
    .maybeSingle();

  const eventPayload = {
    event_type: "nexus:buyer-google-oauth-complete",
    target_origin: callbackTargetOrigin(state?.return_url),
    customer_automation_id: state?.customer_automation_id || "",
    requirement_key: state?.requirement_key || "",
  };

  if (stateError || !state) {
    return callbackHtml({ ...eventPayload, ok: false, error: "OAuth session was not found. Start the account connection again from Nexus." });
  }
  if (state.consumed_at || new Date(state.expires_at).getTime() < Date.now()) {
    return callbackHtml({ ...eventPayload, ok: false, error: "OAuth session expired. Start the account connection again from Nexus." });
  }
  if (googleError) {
    await adminClient.from("buyer_oauth_connection_states").update({ consumed_at: new Date().toISOString() }).eq("id", state.id);
    return callbackHtml({ ...eventPayload, ok: false, error: googleError });
  }
  if (!code) {
    return callbackHtml({ ...eventPayload, ok: false, error: "Google did not return an authorization code." });
  }

  try {
    const tokenData = await exchangeGoogleCode(code, cleanString(state.code_verifier));
    const accessToken = cleanString(tokenData.access_token);
    const refreshToken = cleanString(tokenData.refresh_token);
    if (!refreshToken) {
      throw new Error("Google did not return offline access. Choose the account again and approve the requested access.");
    }

    const userInfo = await fetchGoogleUserInfo(accessToken);
    const scope = cleanString(tokenData.scope || state.scope);
    const tokenPayload: Record<string, any> = {
      client_id: cleanString(env("GOOGLE_OAUTH_CLIENT_ID")),
      client_secret: cleanString(env("GOOGLE_OAUTH_CLIENT_SECRET")),
      refresh_token: refreshToken,
      access_token: accessToken,
      scope,
      token_url: "https://oauth2.googleapis.com/token",
      auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
      redirect_uri: googleRedirectUri(),
      connected_email: cleanString(userInfo.email),
    };
    const credentialSecret = cleanString(env("NEXUS_CREDENTIAL_SECRET"));
    if (!credentialSecret) throw new Error("Missing NEXUS_CREDENTIAL_SECRET.");

    const encryptedPayload = await encryptCredentialPayload(tokenPayload, credentialSecret);
    let connection = await upsertBuyerOAuthConnection(adminClient, state, tokenData, userInfo, encryptedPayload);

    try {
      connection = await syncCredentialToN8n({
        adminClient,
        credential: connection,
        credentialSecret,
        n8nBaseUrl: cleanBaseUrl(env("N8N_BASE_URL")),
        n8nApiKey: cleanString(env("N8N_API_KEY")),
        credentialType: state.credential_type,
        credentialName: state.label,
        slot: asObject(state.slot),
        persistenceTable: "buyer_oauth_connections",
        forceSyncNativeCredential: true,
      });
    } catch (syncError) {
      const syncMessage = syncError instanceof Error ? syncError.message : "Could not prepare the connected account in n8n.";
      await adminClient
        .from("buyer_oauth_connections")
        .update({ status: "needs_attention", last_error: syncMessage, updated_at: new Date().toISOString() })
        .eq("id", connection.id);
      throw new Error(`Google connected, but Nexus could not prepare the workflow account: ${syncMessage}`);
    }

    await adminClient.from("buyer_oauth_connection_states").update({ consumed_at: new Date().toISOString() }).eq("id", state.id);
    return callbackHtml({
      ...eventPayload,
      ok: true,
      connection: safeBuyerConnection(connection),
      message: `Connected ${cleanString(userInfo.email) || "Google account"}. Return to Nexus to finish setup.`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Google OAuth connection failed.";
    await adminClient.from("buyer_oauth_connection_states").update({ consumed_at: new Date().toISOString() }).eq("id", state.id);
    return callbackHtml({ ...eventPayload, ok: false, error: message });
  }
}

async function handleCallback(adminClient: any, url: URL) {
  const stateToken = cleanString(url.searchParams.get("state"));
  const code = cleanString(url.searchParams.get("code"));
  const googleError = cleanString(url.searchParams.get("error"));

  if (!stateToken) {
    return callbackHtml({ ok: false, error: "Missing OAuth state. Start the connection again from Nexus." });
  }

  if (stateToken.startsWith("buyer-")) {
    return handleBuyerCallback(adminClient, url, stateToken);
  }

  const { data: state, error: stateError } = await adminClient
    .from("oauth_connection_states")
    .select("*")
    .eq("state_token", stateToken)
    .maybeSingle();

  if (stateError || !state) {
    return callbackHtml({ ok: false, error: "OAuth session was not found. Start the connection again from Nexus." });
  }

  if (state.consumed_at || new Date(state.expires_at).getTime() < Date.now()) {
    return callbackHtml({ ok: false, error: "OAuth session expired. Start the connection again from Nexus." });
  }

  if (googleError) {
    await adminClient
      .from("oauth_connection_states")
      .update({ consumed_at: new Date().toISOString() })
      .eq("id", state.id);
    return callbackHtml({ ok: false, error: googleError });
  }

  if (!code) {
    return callbackHtml({ ok: false, error: "Google did not return an authorization code." });
  }

  try {
    const tokenData = await exchangeGoogleCode(code);
    const accessToken = cleanString(tokenData.access_token);
    const refreshToken = cleanString(tokenData.refresh_token);

    if (!refreshToken) {
      throw new Error("Google did not return a refresh token. Reconnect and approve offline access, or remove the old Google grant and try again.");
    }

    const userInfo = await fetchGoogleUserInfo(accessToken);
    const clientId = cleanString(env("GOOGLE_OAUTH_CLIENT_ID"));
    const clientSecret = cleanString(env("GOOGLE_OAUTH_CLIENT_SECRET"));
    const scope = cleanString(tokenData.scope || state.scope);
    const tokenPayload: Record<string, any> = {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      access_token: accessToken,
      scope,
      token_url: "https://oauth2.googleapis.com/token",
      auth_url: "https://accounts.google.com/o/oauth2/v2/auth",
      redirect_uri: googleRedirectUri(),
      connected_email: cleanString(userInfo.email),
    };

    const credentialSecret = cleanString(env("NEXUS_CREDENTIAL_SECRET"));
    if (!credentialSecret) throw new Error("Missing NEXUS_CREDENTIAL_SECRET.");

    const encryptedPayload = await encryptCredentialPayload(tokenPayload, credentialSecret);
    const connection = await upsertOAuthConnection(adminClient, state, tokenData, userInfo, encryptedPayload);
    let credential = await upsertDeveloperCredential(adminClient, state, tokenPayload, encryptedPayload);
    const syncResult = await syncCredentialIfPossible(adminClient, state, credential);
    credential = syncResult.credential;

    await adminClient
      .from("oauth_connections")
      .update({
        developer_credential_id: credential.id,
        n8n_credential_id: credential.n8n_credential_id || null,
        n8n_credential_name: credential.n8n_credential_name || null,
        status: credential.status || "active",
        last_error: syncResult.warning || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", connection.id);

    await adminClient
      .from("oauth_connection_states")
      .update({ consumed_at: new Date().toISOString() })
      .eq("id", state.id);

    return callbackHtml({
      ok: true,
      credential_id: credential.id,
      provider: state.provider,
      n8n_credential_id: credential.n8n_credential_id || "",
      warning: syncResult.warning || "",
      message: syncResult.warning ||
        "Google account connected. Return to Nexus and press Apply credentials & run check.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Google OAuth connection failed.";
    await adminClient
      .from("oauth_connection_states")
      .update({ consumed_at: new Date().toISOString() })
      .eq("id", state.id);
    return callbackHtml({ ok: false, error: message });
  }
}

async function listConnections(adminClient: any, operator: any) {
  let query = adminClient
    .from("oauth_connections")
    .select("id,provider,provider_label,label,provider_account_email,scopes,status,n8n_credential_type,n8n_credential_id,n8n_credential_name,developer_credential_id,last_error,created_at,updated_at")
    .neq("status", "revoked")
    .order("updated_at", { ascending: false })
    .limit(50);

  if (operator.profile.role === "developer") {
    query = query.eq("developer_id", operator.developer.id);
  } else {
    query = query.eq("owner_profile_id", operator.profile.id);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return data || [];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: corsHeaders });
  }

  const supabaseUrl = env("SUPABASE_URL");
  const anonKey = env("SUPABASE_ANON_KEY");
  const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return errorResponse("Missing Supabase function secrets.", 500);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  const url = new URL(req.url);

  if (req.method === "GET" && (url.searchParams.has("code") || url.searchParams.has("state") || url.searchParams.has("error"))) {
    return handleCallback(adminClient, url);
  }

  if (req.method === "GET") {
    return jsonResponse({
      ok: true,
      message: "oauth-connections function is alive.",
      env: {
        has_google_client_id: Boolean(env("GOOGLE_OAUTH_CLIENT_ID")),
        has_google_client_secret: Boolean(env("GOOGLE_OAUTH_CLIENT_SECRET")),
        has_google_redirect_uri: Boolean(googleRedirectUri()),
        has_credential_secret: Boolean(env("NEXUS_CREDENTIAL_SECRET")),
        has_n8n_base_url: Boolean(env("N8N_BASE_URL")),
        has_n8n_api_key: Boolean(env("N8N_API_KEY")),
      },
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    const user = await getUserFromRequest(req, supabaseUrl, anonKey);
    if (!user) return errorResponse("Login required.", 401);

    const body = await req.json().catch(() => ({}));
    const action = cleanString(body.action || "list");

    if (action === "start_buyer_google") {
      const state = await createBuyerOAuthState(adminClient, user.id, body);
      return jsonResponse({
        ok: true,
        auth_url: googleAuthUrl(state),
        state_token: state.state_token,
        redirect_uri: googleRedirectUri(),
        expires_at: state.expires_at,
      });
    }

    if (action === "list_buyer") {
      const result = await listBuyerOAuthConnections(adminClient, user.id, body);
      return jsonResponse({ ok: true, ...result });
    }

    if (action === "disconnect_buyer") {
      const connection = await disconnectBuyerOAuthConnection(adminClient, user.id, body);
      return jsonResponse({ ok: true, connection, message: "Account disconnected. Connect an account again before the automation can run." });
    }

    const operator = await getOperatorContext(adminClient, user.id);
    if (!operator) return errorResponse("Admin or developer access required.", 403);

    if (action === "start_google") {
      const state = await createOAuthState(adminClient, operator, body);
      return jsonResponse({
        ok: true,
        auth_url: googleAuthUrl(state),
        state_token: state.state_token,
        redirect_uri: googleRedirectUri(),
        expires_at: state.expires_at,
      });
    }

    if (action === "list") {
      const connections = await listConnections(adminClient, operator);
      return jsonResponse({ ok: true, connections });
    }

    return errorResponse(`Unknown action: ${action}`, 400);
  } catch (error) {
    const message = friendlySetupError(error instanceof Error ? error.message : "Could not manage OAuth connections.");
    console.error("oauth-connections failed:", error);
    return errorResponse(message, 500);
  }
});
