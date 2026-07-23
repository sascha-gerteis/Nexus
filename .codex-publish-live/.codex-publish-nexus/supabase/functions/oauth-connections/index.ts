import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import {
  credentialFingerprint,
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
        window.opener.postMessage({ type: "nexus:google-oauth-complete", ...payload }, "*");
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

function scopesForGoogleCredential(provider: string, credentialType: string, requestedScope: string) {
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
    lowerMessage.includes("schema cache")
  ) {
    return `${message} Run supabase/oauth_connections_install_or_patch.sql in the Supabase SQL editor, then deploy oauth-connections.`;
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

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeGoogleCode(code: string) {
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

async function handleCallback(adminClient: any, url: URL) {
  const stateToken = cleanString(url.searchParams.get("state"));
  const code = cleanString(url.searchParams.get("code"));
  const googleError = cleanString(url.searchParams.get("error"));

  if (!stateToken) {
    return callbackHtml({ ok: false, error: "Missing OAuth state. Start the connection again from Nexus." });
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

    const operator = await getOperatorContext(adminClient, user.id);
    if (!operator) return errorResponse("Admin or developer access required.", 403);

    const body = await req.json().catch(() => ({}));
    const action = cleanString(body.action || "list");

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
