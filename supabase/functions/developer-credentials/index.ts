import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import {
  bindAutomationCredentials,
  credentialFingerprint,
  detectWorkflowCredentialSlots,
  decryptCredentialPayload,
  encryptCredentialPayload,
  lastFourFromSecretPayload,
  providerOptions,
  providerPreset,
  redactCredential,
  sanitizeWorkflowCredentialReferences,
} from "../_shared/nexus-credentials.ts";
import { isLegacyNexusProduct } from "../_shared/legacy-nexus-products.ts";

function env(name: string) {
  return Deno.env.get(name) || "";
}

function cleanString(value: unknown) {
  return String(value ?? "").trim();
}

function lower(value: unknown) {
  return cleanString(value).toLowerCase();
}

function cleanBaseUrl(value: string) {
  return cleanString(value).replace(/\/+$/, "");
}

function asObject(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, any>;
}

function jsonObject(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, any>;
  if (typeof value !== "string") return {};

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function fetchLiveN8nWorkflow(workflowId: string) {
  const baseUrl = cleanBaseUrl(env("N8N_BASE_URL"));
  const apiKey = cleanString(env("N8N_API_KEY"));
  const id = cleanString(workflowId);

  if (!baseUrl || !apiKey || !id) return null;

  const response = await fetch(`${baseUrl}/api/v1/workflows/${encodeURIComponent(id)}`, {
    headers: {
      Accept: "application/json",
      "X-N8N-API-KEY": apiKey,
    },
  });

  const text = await response.text();
  let data: any = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    console.warn(
      "Could not fetch live n8n workflow for credential scan:",
      data?.message || data?.error || text || response.status,
    );
    return null;
  }

  return data?.data && typeof data.data === "object" ? data.data : data;
}

function isSchemaMissingError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /developer_credentials|automation_credential_requirements|credential_binding|schema cache|relation .* does not exist|could not find .* column/i.test(message);
}

function providerLabelFor(provider: string) {
  return providerPreset(provider)?.label || cleanString(provider || "Custom");
}

function normalizedProviderForCredential(body: any) {
  const explicitProvider = cleanString(body.provider);
  const explicitType = cleanString(body.n8n_credential_type);
  const typePreset = providerPreset(explicitType);
  const providerPresetValue = providerPreset(explicitProvider);
  const providerIsGeneric = !explicitProvider ||
    ["custom", "bearer_token", "webhook_api", "basic_auth"].includes(cleanString(providerPresetValue?.provider || explicitProvider));

  if (
    typePreset?.provider &&
    !isGenericHttpCredentialType(typePreset.n8nCredentialType) &&
    providerIsGeneric
  ) {
    return typePreset.provider;
  }

  return cleanString(providerPresetValue?.provider || explicitProvider || typePreset?.provider || "custom");
}

function n8nTypeFor(provider: string, explicitType = "") {
  const providerValue = cleanString(provider);
  const explicit = cleanString(explicitType);
  const presetType = cleanString(providerPreset(provider)?.n8nCredentialType);

  if (providerValue === "apify" && (!explicit || explicit === "apifyApi")) {
    return "httpBearerAuth";
  }

  if (presetType && explicit && isGenericHttpCredentialType(explicit) && !isGenericHttpCredentialType(presetType)) {
    return presetType;
  }

  return explicit || presetType || "";
}

function isGenericHttpCredentialType(value: unknown) {
  return [
    "httpBasicAuth",
    "httpBearerAuth",
    "httpDigestAuth",
    "httpHeaderAuth",
    "httpQueryAuth",
    "httpCustomAuth",
  ].some((type) => type.toLowerCase() === cleanString(value).toLowerCase());
}

function slotKey(slot: any) {
  const nodeName = cleanString(slot?.node_name);
  const credentialKey = cleanString(slot?.credential_key || slot?.n8n_credential_type);
  return `${nodeName}:${credentialKey}`;
}

function bindingMatchesSlot(binding: any, slot: any) {
  if (!binding || !slot) return false;

  const sameNode = cleanString(binding.node_name) === cleanString(slot.node_name);
  const bindingKey = cleanString(binding.credential_key || binding.n8n_credential_type);
  const slotCredentialKey = cleanString(slot.credential_key || slot.n8n_credential_type);
  const sameKey = Boolean(bindingKey && slotCredentialKey && bindingKey === slotCredentialKey);
  const sameN8nCredential = Boolean(
    cleanString(binding.n8n_credential_id) &&
    cleanString(slot.current_id) &&
    cleanString(binding.n8n_credential_id) === cleanString(slot.current_id),
  );

  return sameNode && (sameKey || sameN8nCredential);
}

function providerMatchesCredential(credential: any, slot: any) {
  const credentialProvider = lower(credential?.provider || credential?.provider_label);
  const slotProvider = lower(slot?.provider || slot?.provider_label);
  const credentialTypePreset = providerPreset(credential?.n8n_credential_type);
  const slotTypePreset = providerPreset(slot?.n8n_credential_type || slot?.credential_key);

  if (
    credentialTypePreset?.provider &&
    slotTypePreset?.provider &&
    credentialTypePreset.provider === slotTypePreset.provider
  ) {
    return true;
  }

  if (!credentialProvider || !slotProvider) return true;
  if (credentialProvider === slotProvider) return true;
  return Boolean(providerPreset(credentialProvider)?.provider === providerPreset(slotProvider)?.provider);
}

function credentialMatchesSlotReference(credential: any, slot: any) {
  const slotId = cleanString(slot?.current_id);
  const slotName = cleanString(slot?.current_name);
  const credentialId = cleanString(credential?.n8n_credential_id);
  const credentialName = cleanString(credential?.n8n_credential_name);
  const credentialLabel = cleanString(credential?.label);
  const typeMatches = !slot?.n8n_credential_type ||
    !credential?.n8n_credential_type ||
    cleanString(slot.n8n_credential_type) === cleanString(credential.n8n_credential_type);

  if (!typeMatches || !providerMatchesCredential(credential, slot)) return false;
  if (slotId && credentialId && slotId === credentialId) return true;
  if (slotName && (slotName === credentialName || slotName === credentialLabel)) return true;
  return false;
}

async function loadCredentialCandidatesForProduct(adminClient: any, product: any) {
  const { data, error } = await adminClient
    .from("developer_credentials")
    .select("id, label, provider, provider_label, developer_id, owner_role, n8n_credential_id, n8n_credential_name, n8n_credential_type, status")
    .in("status", ["active", "needs_attention"])
    .limit(250);

  if (error) {
    console.warn("Could not load credential candidates for scan:", error.message);
    return [];
  }

  const productDeveloperId = cleanString(product?.developer_id);

  return (data || []).filter((credential: any) => {
    const credentialDeveloperId = cleanString(credential.developer_id);
    if (!productDeveloperId) {
      return !credentialDeveloperId && cleanString(credential.owner_role) === "admin";
    }

    return credentialDeveloperId === productDeveloperId ||
      (!credentialDeveloperId && cleanString(credential.owner_role) === "admin");
  });
}

function inferredBindingFromCredential(slot: any, credential: any) {
  return {
    node_name: slot.node_name,
    node_type: slot.node_type,
    provider: slot.provider || credential.provider || null,
    provider_label: slot.provider_label || credential.provider_label || null,
    credential_key: slot.credential_key || slot.n8n_credential_type,
    n8n_credential_type: credential.n8n_credential_type || slot.n8n_credential_type,
    n8n_credential_id: credential.n8n_credential_id || slot.current_id || null,
    n8n_credential_name: credential.n8n_credential_name || credential.label || slot.current_name || null,
    developer_credential_id: credential.id,
    inferred_from_workflow_scan: true,
  };
}

function normalizeSecretFields(body: any) {
  const provider = normalizedProviderForCredential(body);
  const openAiApiKey = cleanString(
    body.openai_api_key ||
    body.openaiApiKey ||
    body.api_key ||
    body.apiKey ||
    body.token,
  );

  if (provider === "openai" && openAiApiKey) {
    const fields: Record<string, any> = {
      api_key: openAiApiKey,
    };
    const baseUrl = cleanString(
      body.openai_base_url ||
      body.openaiBaseUrl ||
      body.base_url ||
      body.baseURL,
    );

    if (baseUrl) fields.url = baseUrl;
    return fields;
  }

  const secretFields = jsonObject(body.secret_fields);
  const apiKey = cleanString(body.api_key || body.token || body.secret);
  const oauthFields: Record<string, any> = {};

  [
    ["client_id", body.oauth_client_id || body.client_id],
    ["client_secret", body.oauth_client_secret || body.client_secret],
    ["refresh_token", body.oauth_refresh_token || body.refresh_token],
    ["access_token", body.oauth_access_token || body.access_token],
    ["scope", body.oauth_scope || body.scope],
    ["token_url", body.token_url || body.access_token_url],
    ["auth_url", body.auth_url || body.authorization_url],
    ["redirect_uri", body.redirect_uri],
  ].forEach(([key, value]) => {
    const cleaned = cleanString(value);
    if (cleaned) oauthFields[key] = cleaned;
  });

  const serviceAccountFields: Record<string, any> = {};
  const serviceAccountJson = cleanString(body.service_account_json || body.serviceAccountJson);
  if (serviceAccountJson) {
    serviceAccountFields.service_account_json = serviceAccountJson;
  }
  [
    ["service_account_email", body.service_account_email || body.client_email],
    ["private_key", body.service_account_private_key || body.private_key],
    ["project_id", body.service_account_project_id || body.project_id],
    ["delegated_subject", body.google_delegated_subject || body.delegated_subject],
  ].forEach(([key, value]) => {
    const cleaned = cleanString(value);
    if (cleaned) serviceAccountFields[key] = cleaned;
  });
  const structuredFields: Record<string, any> = {};
  [
    ["access_token", body.access_token || body.oauth_access_token],
    ["api_token", body.api_token],
    ["client_id", body.client_id || body.oauth_client_id],
    ["client_secret", body.client_secret || body.oauth_client_secret],
    ["consumer_key", body.consumer_key],
    ["consumer_secret", body.consumer_secret],
    ["account_sid", body.account_sid],
    ["auth_token", body.auth_token],
    ["subdomain", body.subdomain || body.shop_subdomain],
    ["shop_subdomain", body.shop_subdomain],
    ["url", body.url],
    ["email", body.email],
    ["host", body.host],
    ["port", body.port],
    ["database", body.database],
    ["username", body.username || body.user],
    ["user", body.user || body.username],
    ["password", body.password],
    ["schema", body.schema],
    ["ssl", body.ssl],
    ["secure", body.secure],
    ["connection_string", body.connection_string || body.uri],
    ["access_key_id", body.access_key_id],
    ["secret_access_key", body.secret_access_key],
    ["session_token", body.session_token],
    ["region", body.region],
    ["header_name", body.header_name],
    ["header_value", body.header_value],
  ].forEach(([key, value]) => {
    const cleaned = cleanString(value);
    if (cleaned) structuredFields[key] = cleaned;
  });

  if (
    Object.keys(secretFields).length ||
    Object.keys(oauthFields).length ||
    Object.keys(serviceAccountFields).length ||
    Object.keys(structuredFields).length
  ) {
    return {
      ...secretFields,
      ...oauthFields,
      ...serviceAccountFields,
      ...structuredFields,
    };
  }
  if (apiKey) return { api_key: apiKey };
  return {};
}

async function getUserFromRequest(req: Request, supabaseUrl: string, anonKey: string) {
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return null;

  const token = authHeader.replace("Bearer ", "").trim();
  const userClient = createClient(supabaseUrl, anonKey, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
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

function canUseAutomation(operator: any, automation: any) {
  if (operator?.profile?.role === "admin") return true;
  return Boolean(operator?.developer?.id && automation?.developer_id === operator.developer.id);
}

function credentialOwnerPatch(operator: any, body: any) {
  if (operator.profile.role === "developer") {
    return {
      developer_id: operator.developer.id,
      owner_profile_id: operator.profile.id,
      owner_role: "developer",
    };
  }

  const targetDeveloperId = cleanString(body.developer_id);

  return {
    developer_id: targetDeveloperId || null,
    owner_profile_id: operator.profile.id,
    owner_role: targetDeveloperId ? "developer" : "admin",
  };
}

async function listCredentials(adminClient: any, operator: any, body: any) {
  let query = adminClient
    .from("developer_credentials")
    .select("*, developers(id, display_name, handle)")
    .order("updated_at", { ascending: false })
    .limit(100);

  if (body.include_revoked !== true) {
    query = query.neq("status", "revoked");
  }

  if (operator.profile.role === "developer") {
    query = query.eq("developer_id", operator.developer.id);
  } else {
    const developerId = cleanString(body.developer_id);
    if (developerId === "nexus" || developerId === "admin") {
      query = query.is("developer_id", null);
    } else if (developerId) {
      query = query.eq("developer_id", developerId);
    }
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return data || [];
}

async function findActiveCredentialByLabel(adminClient: any, ownerPatch: any, provider: string, label: string, excludeId = "") {
  const cleanLabel = cleanString(label).toLowerCase();
  if (!cleanLabel) return null;

  let query = adminClient
    .from("developer_credentials")
    .select("*")
    .eq("provider", provider)
    .ilike("label", cleanLabel)
    .neq("status", "revoked")
    .limit(1);

  if (ownerPatch.developer_id) {
    query = query.eq("developer_id", ownerPatch.developer_id);
  } else {
    query = query.is("developer_id", null);
  }

  if (excludeId) {
    query = query.neq("id", excludeId);
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  const match = data || null;

  return cleanString(match?.label).toLowerCase() === cleanLabel ? match : null;
}

async function saveCredential(adminClient: any, operator: any, body: any) {
  const credentialSecret = env("NEXUS_CREDENTIAL_SECRET");
  const id = cleanString(body.id);
  const provider = normalizedProviderForCredential(body);
  const secretFields = normalizeSecretFields(body);
  const ownerPatch = credentialOwnerPatch(operator, body);
  const n8nCredentialType = n8nTypeFor(provider, body.n8n_credential_type);
  const label = cleanString(body.label) || `${providerLabelFor(provider)} key`;
  const n8nCredentialName = cleanString(body.n8n_credential_name) || label;

  if (!provider) throw new Error("Provider is required.");
  if (!label) throw new Error("Credential label is required.");

  let existing: any = null;

  if (id) {
    const { data, error } = await adminClient
      .from("developer_credentials")
      .select("*")
      .eq("id", id)
      .maybeSingle();

    if (error || !data) throw new Error(error?.message || "Credential not found.");

    if (
      operator.profile.role === "developer" &&
      data.developer_id !== operator.developer.id
    ) {
      throw new Error("You can only edit your own credentials.");
    }

    existing = data;
  }

  let encryptedPayload = existing?.encrypted_payload || null;
  let fingerprint = existing?.fingerprint || null;
  let lastFour = existing?.last_four || null;
  const hasNewSecretFields = Object.keys(secretFields).length > 0;
  const suppliedN8nCredentialId = cleanString(body.n8n_credential_id);
  const suppliedN8nCredentialName = cleanString(body.n8n_credential_name);

  if (Object.keys(secretFields).length) {
    if (!credentialSecret) {
      throw new Error("Missing NEXUS_CREDENTIAL_SECRET. Add it in Supabase Function secrets first.");
    }

    encryptedPayload = await encryptCredentialPayload(secretFields, credentialSecret);
    fingerprint = await credentialFingerprint(secretFields);
    lastFour = lastFourFromSecretPayload(secretFields);
  } else if (!existing && !cleanString(body.n8n_credential_id)) {
    throw new Error("Add an API key/token or an existing n8n credential ID.");
  }

  const duplicateByLabel = await findActiveCredentialByLabel(
    adminClient,
    ownerPatch,
    provider,
    label,
    existing?.id || "",
  );

  if (duplicateByLabel) {
    throw new Error(
      `A ${providerLabelFor(provider)} credential named "${duplicateByLabel.label}" already exists. Use a different credential name.`,
    );
  }

  const providerChanged = Boolean(existing) && cleanString(existing?.provider).toLowerCase() !== provider.toLowerCase();
  const typeChanged = Boolean(existing) && cleanString(existing?.n8n_credential_type).toLowerCase() !== n8nCredentialType.toLowerCase();
  const canKeepExistingN8nCredential = Boolean(existing) &&
    !providerChanged &&
    !typeChanged &&
    !(hasNewSecretFields && isGenericHttpCredentialType(n8nCredentialType));

  const patch = {
    ...ownerPatch,
    provider,
    provider_label: cleanString(body.provider_label) || providerLabelFor(provider),
    credential_type: cleanString(body.credential_type || "api_key"),
    label,
    n8n_credential_type: n8nCredentialType,
    n8n_credential_id: canKeepExistingN8nCredential
      ? suppliedN8nCredentialId || existing?.n8n_credential_id || null
      : null,
    n8n_credential_name: canKeepExistingN8nCredential
      ? suppliedN8nCredentialName || n8nCredentialName
      : label,
    status: "active",
    test_status: existing?.test_status || "untested",
    last_four: lastFour,
    fingerprint,
    encrypted_payload: encryptedPayload,
    metadata: asObject(body.metadata),
    last_error: null,
    updated_by: operator.profile.id,
    updated_at: new Date().toISOString(),
    ...(existing ? {} : { created_by: operator.profile.id }),
  };

  const request = existing?.id
    ? adminClient.from("developer_credentials").update(patch).eq("id", existing.id)
    : adminClient.from("developer_credentials").insert(patch);

  const { data, error } = await request.select().single();
  if (error) {
    if (error.code === "23505" && String(error.message || "").includes("idx_developer_credentials_fingerprint")) {
      throw new Error(
        "Your database still has the old duplicate-key rule for credential secrets. Run supabase/developer_credentials_name_unique_patch.sql, then try saving again.",
      );
    }

    if (error.code === "23505") {
      throw new Error(`A ${providerLabelFor(provider)} credential with this name already exists. Use a different credential name.`);
    }

    throw new Error(error.message);
  }

  if (existing?.id) {
    await markCredentialAutomationsNeedFreshTest(
      adminClient,
      existing.id,
      "Credential updated. Apply credentials to the workflow and run a fresh technical test before this product can go live.",
    );
  }

  return data;
}

async function markCredentialAutomationsNeedFreshTest(adminClient: any, credentialId: string, message: string) {
  const safeCredentialId = cleanString(credentialId);
  if (!safeCredentialId) return;

  try {
    const { data: rows, error: loadError } = await adminClient
      .from("automation_credential_requirements")
      .select("automation_id")
      .eq("developer_credential_id", safeCredentialId);

    if (loadError) {
      console.warn("Could not load credential-dependent automations:", loadError.message);
      return;
    }

    const automationIds = [...new Set((rows || [])
      .map((row: any) => cleanString(row.automation_id))
      .filter(Boolean))];

    if (!automationIds.length) return;

    const now = new Date().toISOString();
    const { error: updateError } = await adminClient
      .from("automations")
      .update({
        credential_binding_status: "needs_credentials",
        n8n_last_test_status: "not_tested",
        n8n_last_test_error: message,
        n8n_last_test_result: {
          credential_changed: true,
          developer_credential_id: safeCredentialId,
          message,
          at: now,
        },
        n8n_last_tested_at: null,
        updated_at: now,
      })
      .in("id", automationIds);

    if (updateError) {
      console.warn("Could not mark credential-dependent automations stale:", updateError.message);
    }
  } catch (error) {
    console.warn("Could not mark credential-dependent automations stale:", error instanceof Error ? error.message : error);
  }
}

async function revokeCredential(adminClient: any, operator: any, body: any) {
  const id = cleanString(body.id);
  if (!id) throw new Error("Credential ID is required.");

  let query = adminClient.from("developer_credentials").update({
    status: "revoked",
    updated_by: operator.profile.id,
    updated_at: new Date().toISOString(),
  }).eq("id", id);

  if (operator.profile.role === "developer") {
    query = query.eq("developer_id", operator.developer.id);
  }

  const { data, error } = await query.select().maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Credential not found.");

  await markCredentialAutomationsNeedFreshTest(
    adminClient,
    data.id,
    "Credential revoked. Add or choose a replacement credential, apply it to the workflow, and run a fresh technical test.",
  );

  return data;
}

async function verifyDeveloperPassword(supabaseUrl: string, anonKey: string, email: string, password: string) {
  const cleanEmail = cleanString(email);
  const cleanPassword = cleanString(password);

  if (!cleanEmail || !cleanPassword) return false;

  const authClient = createClient(supabaseUrl, anonKey);
  const { data, error } = await authClient.auth.signInWithPassword({
    email: cleanEmail,
    password: cleanPassword,
  });

  return Boolean(!error && data?.user?.email === cleanEmail);
}

async function revealCredential(
  adminClient: any,
  operator: any,
  user: any,
  body: any,
  supabaseUrl: string,
  anonKey: string,
) {
  const id = cleanString(body.id);
  if (!id) throw new Error("Credential ID is required.");

  const { data: credential, error } = await adminClient
    .from("developer_credentials")
    .select("*, developers(id, display_name, handle)")
    .eq("id", id)
    .maybeSingle();

  if (error || !credential) throw new Error(error?.message || "Credential not found.");

  if (
    operator.profile.role === "developer" &&
    credential.developer_id !== operator.developer.id
  ) {
    throw new Error("You can only view your own credentials.");
  }

  if (operator.profile.role === "developer") {
    const passwordOk = await verifyDeveloperPassword(
      supabaseUrl,
      anonKey,
      user.email,
      body.password,
    );

    if (!passwordOk) {
      throw new Error("Enter your developer account password to view this credential.");
    }
  }

  const secretFields = await decryptCredentialPayload(
    credential.encrypted_payload,
    env("NEXUS_CREDENTIAL_SECRET"),
  );

  return {
    credential,
    secret_fields: secretFields,
  };
}

async function deleteCredential(adminClient: any, operator: any, body: any) {
  const id = cleanString(body.id);
  if (!id) throw new Error("Credential ID is required.");

  const { data: credential, error: loadError } = await adminClient
    .from("developer_credentials")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (loadError || !credential) {
    throw new Error(loadError?.message || "Credential not found.");
  }

  if (
    operator.profile.role === "developer" &&
    credential.developer_id !== operator.developer.id
  ) {
    throw new Error("You can only remove your own credentials.");
  }

  if (credential.status !== "revoked" && body.force !== true) {
    throw new Error("Revoke this credential before removing it.");
  }

  const { error } = await adminClient
    .from("developer_credentials")
    .delete()
    .eq("id", id);

  if (error) throw new Error(error.message);

  await markCredentialAutomationsNeedFreshTest(
    adminClient,
    credential.id,
    "Credential removed. Add or choose a replacement credential, apply it to the workflow, and run a fresh technical test.",
  );

  return credential;
}

async function getAutomation(adminClient: any, operator: any, automationId: string) {
  if (!automationId) throw new Error("automation_id is required.");

  const { data, error } = await adminClient
    .from("automations")
    .select("*")
    .eq("id", automationId)
    .maybeSingle();

  if (error || !data) throw new Error(error?.message || "Automation not found.");
  if (!canUseAutomation(operator, data)) throw new Error("You cannot manage this automation.");

  return data;
}

async function scanAutomation(adminClient: any, operator: any, body: any) {
  const product = await getAutomation(adminClient, operator, cleanString(body.automation_id));

  if (isLegacyNexusProduct(product)) {
    const updatedProduct = {
      ...product,
      developer_credential_requirements: [],
      n8n_credential_bindings: [],
      credential_binding_status: "bound",
      credential_binding_errors: [],
      n8n_last_credential_bound_at: product.n8n_last_credential_bound_at || new Date().toISOString(),
    };

    await adminClient
      .from("automations")
      .update({
        developer_credential_requirements: [],
        n8n_credential_bindings: [],
        credential_binding_status: "bound",
        credential_binding_errors: [],
        n8n_last_credential_bound_at: updatedProduct.n8n_last_credential_bound_at,
      })
      .eq("id", product.id);

    return {
      product: updatedProduct,
      slots: [],
      bindings: [],
      errors: [],
      legacy_nexus_direct_n8n_credentials: true,
    };
  }

  const sourceWorkflow = await fetchLiveN8nWorkflow(product.n8n_workflow_id)
    || product.n8n_normalized_workflow_json
    || product.n8n_workflow_json;
  const workflow = sanitizeWorkflowCredentialReferences(sourceWorkflow);
  const slots = detectWorkflowCredentialSlots(workflow);
  const slotKeys = new Set(
    slots.map((slot: any) => slotKey(slot)),
  );
  const bindings = Array.isArray(product.n8n_credential_bindings)
    ? product.n8n_credential_bindings.filter((binding: any) => (
      binding?.developer_credential_id &&
      slots.some((slot: any) => bindingMatchesSlot(binding, slot))
    ))
    : [];

  const credentialCandidates = await loadCredentialCandidatesForProduct(adminClient, product);
  for (const slot of slots) {
    if (bindings.some((binding: any) => bindingMatchesSlot(binding, slot))) continue;

    const credential = credentialCandidates.find((candidate: any) => credentialMatchesSlotReference(candidate, slot));
    if (credential) {
      bindings.push(inferredBindingFromCredential(slot, credential));
    }
  }

  const boundSlotKeys = new Set(
    bindings
      .filter((binding: any) => binding?.developer_credential_id)
      .map((binding: any) => slotKey(binding)),
  );

  const missingSlots = slots.filter((slot: any) => !boundSlotKeys.has(slotKey(slot)));
  const errors = missingSlots.map((slot: any) => ({
    node_name: slot.node_name,
    node_type: slot.node_type,
    credential_key: slot.credential_key,
    n8n_credential_type: slot.n8n_credential_type,
    provider: slot.provider,
    provider_label: slot.provider_label,
    imported_n8n_credential_id: slot.current_id || null,
    imported_n8n_credential_name: slot.current_name || null,
    message: `Add a ${slot.provider_label || slot.provider || "developer"} credential for ${slot.node_name} (${slot.n8n_credential_type || slot.credential_key || "n8n credential"}), then press Apply credentials & run check.`,
  }));
  const credentialStatus = !slots.length
    ? "not_required"
    : errors.length || missingSlots.length
      ? "needs_credentials"
      : "bound";

  const updatedProduct = {
    ...product,
    developer_credential_requirements: slots,
    n8n_credential_bindings: bindings,
    credential_binding_status: credentialStatus,
    credential_binding_errors: errors,
    n8n_last_credential_bound_at: !missingSlots.length ? new Date().toISOString() : product.n8n_last_credential_bound_at || null,
  };

  try {
    await adminClient
      .from("automations")
      .update({
        n8n_normalized_workflow_json: workflow,
        developer_credential_requirements: updatedProduct.developer_credential_requirements,
        n8n_credential_bindings: updatedProduct.n8n_credential_bindings,
        credential_binding_status: updatedProduct.credential_binding_status,
        credential_binding_errors: updatedProduct.credential_binding_errors,
        n8n_last_credential_bound_at: updatedProduct.n8n_last_credential_bound_at,
        updated_at: new Date().toISOString(),
      })
      .eq("id", product.id);
  } catch (error) {
    console.warn("Could not update automation credential scan:", error instanceof Error ? error.message : error);
  }

  return { product: updatedProduct, slots, bindings, errors };
}

function productRuntimeSummary(product: any) {
  return {
    id: product?.id || null,
    title: product?.title || "",
    developer_id: product?.developer_id || null,
    listing_type: product?.listing_type || "standard",
    status: product?.status || "",
    n8n_workflow_id: product?.n8n_workflow_id || "",
    n8n_import_status: product?.n8n_import_status || "",
    n8n_last_test_status: product?.n8n_last_test_status || "",
    n8n_last_test_error: product?.n8n_last_test_error || "",
    n8n_last_test_result: product?.n8n_last_test_result || null,
    n8n_last_tested_at: product?.n8n_last_tested_at || null,
    credential_binding_status: product?.credential_binding_status || "",
    n8n_last_credential_bound_at: product?.n8n_last_credential_bound_at || null,
  };
}

async function applyAutomation(adminClient: any, operator: any, body: any) {
  const product = await getAutomation(adminClient, operator, cleanString(body.automation_id));

  if (isLegacyNexusProduct(product)) {
    const result = await bindAutomationCredentials({
      adminClient,
      product,
      n8nBaseUrl: cleanBaseUrl(env("N8N_BASE_URL")),
      n8nApiKey: env("N8N_API_KEY"),
      credentialSecret: env("NEXUS_CREDENTIAL_SECRET"),
      syncMissingN8nCredentials: false,
    });

    return {
      ...result,
      product: {
        ...product,
        developer_credential_requirements: [],
        n8n_credential_bindings: [],
        credential_binding_status: "bound",
        credential_binding_errors: [],
      },
    };
  }

  const liveWorkflow = await fetchLiveN8nWorkflow(product.n8n_workflow_id);
  const workflowInput = liveWorkflow || product.n8n_normalized_workflow_json || product.n8n_workflow_json;
  const workflowJsonColumn = (liveWorkflow || product.n8n_normalized_workflow_json)
    ? "n8n_normalized_workflow_json"
    : "n8n_workflow_json";
  const result = await bindAutomationCredentials({
    adminClient,
    product,
    n8nBaseUrl: cleanBaseUrl(env("N8N_BASE_URL")),
    n8nApiKey: env("N8N_API_KEY"),
    credentialSecret: env("NEXUS_CREDENTIAL_SECRET"),
    syncMissingN8nCredentials: body.sync_n8n !== false,
    workflowInput,
    workflowJsonColumn,
    updateHostedWorkflow: true,
  });

  return {
    ...result,
    product,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: corsHeaders,
    });
  }

  if (req.method === "GET") {
    return jsonResponse({
      ok: true,
      message: "developer-credentials function is alive.",
      version: "credential-vault-v1",
      providers: providerOptions(),
      env: {
        has_supabase_url: Boolean(env("SUPABASE_URL")),
        has_anon_key: Boolean(env("SUPABASE_ANON_KEY")),
        has_service_role: Boolean(env("SUPABASE_SERVICE_ROLE_KEY")),
        has_n8n_base_url: Boolean(env("N8N_BASE_URL")),
        has_n8n_api_key: Boolean(env("N8N_API_KEY")),
        has_credential_secret: Boolean(env("NEXUS_CREDENTIAL_SECRET")),
      },
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    const supabaseUrl = env("SUPABASE_URL");
    const anonKey = env("SUPABASE_ANON_KEY");
    const serviceRoleKey = env("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !anonKey || !serviceRoleKey) {
      return errorResponse("Missing Supabase function secrets.", 500);
    }

    const user = await getUserFromRequest(req, supabaseUrl, anonKey);
    if (!user) return errorResponse("Login required.", 401);

    const adminClient = createClient(supabaseUrl, serviceRoleKey);
    const operator = await getOperatorContext(adminClient, user.id);

    if (!operator) return errorResponse("Admin or developer access required.", 403);

    const body = await req.json().catch(() => ({}));
    const action = cleanString(body.action || "list");

    if (action === "providers") {
      return jsonResponse({ ok: true, providers: providerOptions() });
    }

    if (action === "list") {
      const credentials = await listCredentials(adminClient, operator, body);
      return jsonResponse({ ok: true, credentials: credentials.map(redactCredential) });
    }

    if (action === "save") {
      const credential = await saveCredential(adminClient, operator, body);
      return jsonResponse({
        ok: true,
        credential: redactCredential(credential),
        message: credential.status === "needs_attention"
          ? "Credential saved, but n8n sync needs attention."
          : "Credential saved and ready.",
      });
    }

    if (action === "revoke") {
      const credential = await revokeCredential(adminClient, operator, body);
      return jsonResponse({
        ok: true,
        credential: redactCredential(credential),
        message: "Credential revoked.",
      });
    }

    if (action === "reveal") {
      const result = await revealCredential(adminClient, operator, user, body, supabaseUrl, anonKey);
      return jsonResponse({
        ok: true,
        credential: redactCredential(result.credential),
        secret_fields: result.secret_fields,
        message: "Credential revealed for this session.",
      });
    }

    if (action === "delete") {
      const credential = await deleteCredential(adminClient, operator, body);
      return jsonResponse({
        ok: true,
        credential: redactCredential(credential),
        message: "Credential removed.",
      });
    }

    if (action === "scan_automation") {
      const result = await scanAutomation(adminClient, operator, body);
      return jsonResponse({
        ok: true,
        product_id: result.product.id,
        product: productRuntimeSummary(result.product),
        slots: result.slots,
        bindings: result.bindings,
        errors: result.errors,
      });
    }

    if (action === "apply_to_automation") {
      const result = await applyAutomation(adminClient, operator, body);
      return jsonResponse({
        ok: result.ok,
        status: result.status,
        slots: result.slots,
        bindings: result.bindings,
        errors: result.errors,
        product: productRuntimeSummary(result.product),
        message: result.ok
          ? "Credentials applied to the workflow."
          : "Add or sync the missing credentials, then apply again.",
      });
    }

    return errorResponse(`Unknown action: ${action}`, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not manage credentials.";

    if (isSchemaMissingError(error)) {
      return errorResponse(
        `${message} Run supabase/developer_credentials_install_or_patch.sql in the Supabase SQL editor, then redeploy developer-credentials and import-n8n-workflow.`,
        500,
      );
    }

    console.error("developer-credentials failed:", error);
    return errorResponse(message, 500);
  }
});
