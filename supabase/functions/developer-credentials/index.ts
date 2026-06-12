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
} from "../_shared/nexus-credentials.ts";

function env(name: string) {
  return Deno.env.get(name) || "";
}

function cleanString(value: unknown) {
  return String(value ?? "").trim();
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

function isSchemaMissingError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "");
  return /developer_credentials|automation_credential_requirements|credential_binding|schema cache|relation .* does not exist|could not find .* column/i.test(message);
}

function providerLabelFor(provider: string) {
  return providerPreset(provider)?.label || cleanString(provider || "Custom");
}

function n8nTypeFor(provider: string, explicitType = "") {
  const providerValue = cleanString(provider);
  const explicit = cleanString(explicitType);

  if (providerValue === "apify" && (!explicit || explicit === "apifyApi")) {
    return "httpBearerAuth";
  }

  return explicit || providerPreset(provider)?.n8nCredentialType || "";
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

function normalizeSecretFields(body: any) {
  const secretFields = jsonObject(body.secret_fields);
  const apiKey = cleanString(body.api_key || body.token || body.secret);

  if (Object.keys(secretFields).length) return secretFields;
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

async function saveCredential(adminClient: any, operator: any, body: any) {
  const credentialSecret = env("NEXUS_CREDENTIAL_SECRET");
  const id = cleanString(body.id);
  const provider = cleanString(body.provider || body.n8n_credential_type || "custom");
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
  const providerChanged = Boolean(existing) && cleanString(existing?.provider).toLowerCase() !== provider.toLowerCase();
  const typeChanged = Boolean(existing) && cleanString(existing?.n8n_credential_type).toLowerCase() !== n8nCredentialType.toLowerCase();
  const hasNewSecretFields = Object.keys(secretFields).length > 0;
  const canKeepExistingN8nCredential = Boolean(existing) &&
    !providerChanged &&
    !typeChanged &&
    !(hasNewSecretFields && isGenericHttpCredentialType(n8nCredentialType));
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

  const request = id
    ? adminClient.from("developer_credentials").update(patch).eq("id", id)
    : adminClient.from("developer_credentials").insert(patch);

  const { data, error } = await request.select().single();
  if (error) throw new Error(error.message);

  return data;
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
  const slots = detectWorkflowCredentialSlots(product.n8n_workflow_json);
  const slotKeys = new Set(
    slots.map((slot: any) => {
      const nodeName = cleanString(slot.node_name);
      const credentialKey = cleanString(slot.credential_key || slot.n8n_credential_type);
      return `${nodeName}:${credentialKey}`;
    }),
  );
  const bindings = Array.isArray(product.n8n_credential_bindings)
    ? product.n8n_credential_bindings.filter((binding: any) => binding?.developer_credential_id)
    : [];
  const errors = Array.isArray(product.credential_binding_errors)
    ? product.credential_binding_errors.filter((error: any) => {
      if (cleanString(error?.message).toLowerCase().startsWith("scan only")) return false;
      const errorKey = `${cleanString(error?.node_name)}:${cleanString(error?.credential_key || error?.n8n_credential_type)}`;
      return slotKeys.has(errorKey);
    })
    : [];

  try {
    await adminClient
      .from("automations")
      .update({
        developer_credential_requirements: slots,
        updated_at: new Date().toISOString(),
      })
      .eq("id", product.id);
  } catch (error) {
    console.warn("Could not update automation credential scan:", error instanceof Error ? error.message : error);
  }

  return { product, slots, bindings, errors };
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
    n8n_last_tested_at: product?.n8n_last_tested_at || null,
    credential_binding_status: product?.credential_binding_status || "",
    n8n_last_credential_bound_at: product?.n8n_last_credential_bound_at || null,
  };
}

async function applyAutomation(adminClient: any, operator: any, body: any) {
  const product = await getAutomation(adminClient, operator, cleanString(body.automation_id));

  const result = await bindAutomationCredentials({
    adminClient,
    product,
    n8nBaseUrl: cleanBaseUrl(env("N8N_BASE_URL")),
    n8nApiKey: env("N8N_API_KEY"),
    credentialSecret: env("NEXUS_CREDENTIAL_SECRET"),
    syncMissingN8nCredentials: body.sync_n8n !== false,
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
