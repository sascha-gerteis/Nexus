import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import { enqueueBuyerOnboarding } from "../_shared/nexus-email.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function nowIso() {
  return new Date().toISOString();
}

function cleanString(value: unknown) {
  return String(value || "").trim();
}

function cleanUrl(value: unknown) {
  const raw = cleanString(value);
  if (!raw) return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

function missingSchemaColumn(error: any) {
  const message = [
    error?.message,
    error?.details,
    error?.hint,
    error?.code,
  ].filter(Boolean).join(" ");

  const match = message.match(/Could not find the '([^']+)' column/i);
  return match?.[1] || "";
}

function isMissingTable(error: any, tableName: string) {
  const message = [
    error?.message,
    error?.details,
    error?.hint,
    error?.code,
  ].filter(Boolean).join(" ");

  return message.includes(tableName) && /Could not find the table|relation .* does not exist/i.test(message);
}

function hasOwn(body: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(body, key);
}

async function loadBuyerProfile(adminClient: any, userId: string) {
  const { data, error } = await adminClient
    .from("buyer_profiles")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    if (isMissingTable(error, "buyer_profiles")) {
      return null;
    }

    throw new Error(error.message);
  }

  return data || null;
}

async function upsertBuyerProfileWithSchemaFallback(adminClient: any, payload: Record<string, unknown>) {
  let safePayload = { ...payload };

  for (let attempt = 0; attempt < 10; attempt++) {
    const { data, error } = await adminClient
      .from("buyer_profiles")
      .upsert(safePayload, { onConflict: "user_id" })
      .select()
      .single();

    if (!error) {
      return data;
    }

    if (isMissingTable(error, "buyer_profiles")) {
      console.warn("buyer_profiles table is not available; saved profiles row only.");
      return null;
    }

    const column = missingSchemaColumn(error);

    if (column && Object.prototype.hasOwnProperty.call(safePayload, column)) {
      const nextPayload = { ...safePayload };
      delete nextPayload[column];
      safePayload = nextPayload;
      continue;
    }

    throw new Error(error.message);
  }

  throw new Error("Could not save buyer profile because too many database columns are missing.");
}

function getAuthHeader(req: Request) {
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return "";
  return authHeader;
}

async function requireUser(req: Request) {
  const authHeader = getAuthHeader(req);

  if (!authHeader) {
    return { user: null, error: "Missing auth token." };
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  });

  const token = authHeader.replace("Bearer ", "").trim();
  const { data, error } = await userClient.auth.getUser(token);

  if (error || !data?.user) {
    return { user: null, error: "Invalid auth token." };
  }

  return { user: data.user, error: null };
}

async function ensureBuyerProfile(adminClient: any, user: any, body: Record<string, unknown>) {
  const metadata = user.user_metadata || {};
  const email = cleanString(user.email || body.email);
  const fullName =
    cleanString(body.full_name) ||
    cleanString(body.name) ||
    cleanString(metadata.full_name) ||
    cleanString(metadata.name) ||
    cleanString(metadata.user_name) ||
    cleanString(email).split("@")[0] ||
    "Buyer";

  const company = cleanString(body.company || metadata.company);
  const website = cleanUrl(body.website || metadata.website);
  const phone = cleanString(body.phone || metadata.phone);
  const avatarUrl =
    cleanString(metadata.avatar_url) ||
    cleanString(metadata.picture) ||
    cleanString(body.avatar_url);

  const { data: existingProfile, error: existingProfileError } = await adminClient
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  if (existingProfileError) throw new Error(existingProfileError.message);

  if (existingProfile?.role && existingProfile.role !== "buyer") {
    return {
      data: null,
      error: `This account is currently a ${existingProfile.role} account, not a buyer account.`,
      status: 403,
    };
  }

  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .upsert(
      {
        id: user.id,
        email,
        full_name: existingProfile?.full_name || fullName,
        role: "buyer",
        updated_at: nowIso(),
      },
      { onConflict: "id" },
    )
    .select()
    .single();

  if (profileError) throw new Error(profileError.message);

  const existingBuyerProfile = await loadBuyerProfile(adminClient, user.id);

  const buyerProfilePayload: Record<string, unknown> = {
    user_id: user.id,
    email,
    name: cleanString(existingBuyerProfile?.name) || fullName,
    company: company || cleanString(existingBuyerProfile?.company),
    website: website || cleanString(existingBuyerProfile?.website),
    phone: phone || cleanString(existingBuyerProfile?.phone),
    updated_at: nowIso(),
  };

  if (avatarUrl) {
    buyerProfilePayload.avatar_url = avatarUrl;
  }

  const buyerProfile = await upsertBuyerProfileWithSchemaFallback(adminClient, buyerProfilePayload);

  await enqueueBuyerOnboarding(adminClient, {
    id: user.id,
    email,
    name: fullName,
  }).catch((error) => console.warn("Could not queue buyer onboarding emails:", error));

  return {
    data: {
      profile,
      buyer_profile: buyerProfile || null,
    },
    error: null,
    status: 200,
  };
}

async function updateBuyerProfile(adminClient: any, user: any, body: Record<string, unknown>) {
  const ensured = await ensureBuyerProfile(adminClient, user, {});

  if (ensured.error) return ensured;

  const existingBuyerProfile = ensured.data.buyer_profile || {};
  const existingProfile = ensured.data.profile || {};
  const fullName = hasOwn(body, "full_name") || hasOwn(body, "name")
    ? cleanString(body.full_name || body.name)
    : cleanString(existingProfile.full_name || existingBuyerProfile.name);
  const company = hasOwn(body, "company")
    ? cleanString(body.company)
    : cleanString(existingBuyerProfile.company);
  const website = hasOwn(body, "website")
    ? cleanUrl(body.website)
    : cleanString(existingBuyerProfile.website);
  const phone = hasOwn(body, "phone")
    ? cleanString(body.phone)
    : cleanString(existingBuyerProfile.phone);

  if (!fullName) {
    return {
      data: null,
      error: "Name is required.",
      status: 400,
    };
  }

  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .upsert(
      {
        id: user.id,
        email: cleanString(user.email),
        full_name: fullName,
        role: "buyer",
        updated_at: nowIso(),
      },
      { onConflict: "id" },
    )
    .select()
    .single();

  if (profileError) throw new Error(profileError.message);

  const buyerProfile = await upsertBuyerProfileWithSchemaFallback(adminClient, {
    user_id: user.id,
    email: cleanString(user.email),
    name: fullName,
    company,
    website,
    phone,
    updated_at: nowIso(),
  });

  return {
    data: {
      profile,
      buyer_profile: buyerProfile || null,
    },
    error: null,
    status: 200,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
      return errorResponse("Buyer account function is missing Supabase environment variables.", 500);
    }

    const body = await req.json().catch(() => ({}));
    const action = cleanString(body.action || "ensure_profile");

    const { user, error: authError } = await requireUser(req);

    if (authError || !user) {
      return errorResponse(authError || "Login required.", 401);
    }

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });

    if (action === "ensure_profile") {
      const result = await ensureBuyerProfile(adminClient, user, body);

      if (result.error) {
        return errorResponse(result.error, result.status || 400);
      }

      return jsonResponse({
        ok: true,
        ...result.data,
      });
    }

    if (action === "get_profile") {
      const result = await ensureBuyerProfile(adminClient, user, {});

      if (result.error) {
        return errorResponse(result.error, result.status || 400);
      }

      return jsonResponse({
        ok: true,
        ...result.data,
      });
    }

    if (action === "update_profile") {
      const result = await updateBuyerProfile(adminClient, user, body);

      if (result.error) {
        return errorResponse(result.error, result.status || 400);
      }

      return jsonResponse({
        ok: true,
        ...result.data,
      });
    }

    return errorResponse("Unknown buyer account action.", 400);
  } catch (error) {
    console.error("buyer-account error:", error);
    return errorResponse(error?.message || "Buyer account request failed.", 500);
  }
});
