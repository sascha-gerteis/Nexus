import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import { safeEnqueueEmail } from "../_shared/nexus-email.ts";

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

function normalizeHandle(value: unknown, fallback = "developer") {
  const base = cleanString(value || fallback)
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

  return base || "developer";
}

function avatarFromName(value: string) {
  const letters = value
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 2)
    .toUpperCase();

  return letters || "D";
}

function cleanSkills(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .map((item) => cleanString(item))
      .filter(Boolean)
      .slice(0, 20);
  }

  return cleanString(value)
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function hasDeveloperIntent(user: any, body: Record<string, unknown>) {
  const metadata = user?.user_metadata || {};

  return Boolean(
    metadata.account_type === "developer" ||
      cleanString(metadata.developer_display_name) ||
      cleanString(metadata.developer_handle) ||
      body.developer_login === true ||
      cleanString(body.display_name) ||
      cleanString(body.handle) ||
      cleanString(body.short_description) ||
      cleanString(body.type)
  );
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

async function findAvailableHandle(adminClient: any, requestedHandle: string, developerId = "") {
  const baseHandle = normalizeHandle(requestedHandle);

  for (let index = 0; index < 20; index++) {
    const candidate = index === 0 ? baseHandle : `${baseHandle}-${index + 1}`;
    const { data, error } = await adminClient
      .from("developers")
      .select("id")
      .eq("handle", candidate)
      .maybeSingle();

    if (error) throw new Error(error.message);
    if (!data || data.id === developerId) return candidate;
  }

  return `${baseHandle}-${crypto.randomUUID().slice(0, 8)}`;
}

async function loadDeveloperContext(adminClient: any, user: any) {
  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) throw new Error(profileError.message);

  const { data: developer, error: developerError } = await adminClient
    .from("developers")
    .select("*")
    .eq("profile_id", user.id)
    .maybeSingle();

  if (developerError) throw new Error(developerError.message);

  return { profile, developer };
}

async function createDeveloperApprovalNotification(adminClient: any, developer: any) {
  try {
    await adminClient.from("admin_notifications").insert({
      notification_type: "developer_account_review",
      title: "New developer account approval",
      message: `${developer.display_name || "A developer"} created a developer account and needs approval before going public.`,
      status: "unread",
      created_at: nowIso(),
    });
  } catch (error) {
    console.warn("Could not create developer account notification:", error);
  }
}

async function ensureDeveloperProfile(adminClient: any, user: any, body: Record<string, unknown>) {
  const { profile, developer } = await loadDeveloperContext(adminClient, user);
  const developerIntent = hasDeveloperIntent(user, body);

  if (profile && profile.role !== "developer" && !developer && !developerIntent) {
    return {
      data: null,
      error: `This account is currently a ${profile.role} account, not a developer account. Sign up through the developer signup page first or use the original developer email.`,
      status: 403,
    };
  }

  const metadata = user.user_metadata || {};
  const displayName =
    cleanString(body.display_name) ||
    cleanString(body.name) ||
    cleanString(metadata.developer_display_name) ||
    cleanString(metadata.full_name) ||
    cleanString(metadata.name) ||
    cleanString(user.email).split("@")[0] ||
    "Developer";

  const handle = developer?.handle ||
    await findAvailableHandle(
      adminClient,
      cleanString(body.handle) ||
        cleanString(metadata.developer_handle) ||
        displayName,
      developer?.id,
    );

  const email = cleanString(user.email);

  const { data: savedProfile, error: savedProfileError } = await adminClient
    .from("profiles")
    .upsert({
      id: user.id,
      email,
      full_name: profile?.full_name || displayName,
      role: "developer",
      updated_at: nowIso(),
    }, { onConflict: "id" })
    .select()
    .single();

  if (savedProfileError) throw new Error(savedProfileError.message);

  let savedDeveloper = developer;

  if (!developer) {
    const { data, error } = await adminClient
      .from("developers")
      .insert({
        profile_id: user.id,
        display_name: displayName,
        handle,
        type: cleanString(body.type) || "Developer",
        avatar_letter: avatarFromName(displayName),
        short_description: cleanString(body.short_description),
        bio: cleanString(body.bio),
        website: cleanUrl(body.website),
        skills: cleanSkills(body.skills),
        verified: false,
        rating: 0,
        review_count: 0,
        status: "pending",
        created_at: nowIso(),
        updated_at: nowIso(),
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    savedDeveloper = data;
    await createDeveloperApprovalNotification(adminClient, savedDeveloper);
    await safeEnqueueEmail(
      adminClient,
      "developer_account_pending",
      { email, name: displayName },
      {
        developer_id: savedDeveloper.id,
        developer_name: displayName,
      },
      {
        dedupeKey: `developer_account_pending:${user.id}`,
      },
    );
  }

  return {
    data: {
      profile: savedProfile,
      developer: savedDeveloper,
      public_url: `/pages/developers/profile.html?id=${savedDeveloper.id}`,
    },
    error: null,
    status: 200,
  };
}

async function updateDeveloperProfile(adminClient: any, user: any, body: Record<string, unknown>) {
  const ensured = await ensureDeveloperProfile(adminClient, user, body);

  if (ensured.error) return ensured;

  const developer = ensured.data.developer;
  const displayName = cleanString(body.display_name);

  if (!displayName) {
    return {
      data: null,
      error: "Display name is required.",
      status: 400,
    };
  }

  const requestedHandle = normalizeHandle(body.handle, developer.handle || displayName);
  const { data: handleOwner, error: handleError } = await adminClient
    .from("developers")
    .select("id")
    .eq("handle", requestedHandle)
    .maybeSingle();

  if (handleError) throw new Error(handleError.message);

  if (handleOwner && handleOwner.id !== developer.id) {
    return {
      data: null,
      error: "That developer handle is already taken.",
      status: 409,
    };
  }

  const avatarLetter = cleanString(body.avatar_letter)
    .replace(/[^a-z0-9]/gi, "")
    .slice(0, 2)
    .toUpperCase() || avatarFromName(displayName);

  const { data: savedDeveloper, error } = await adminClient
    .from("developers")
    .update({
      display_name: displayName,
      handle: requestedHandle,
      type: cleanString(body.type) || "Developer",
      avatar_letter: avatarLetter,
      short_description: cleanString(body.short_description),
      bio: cleanString(body.bio),
      website: cleanUrl(body.website),
      skills: cleanSkills(body.skills),
      banner_url: cleanUrl(body.banner_url),
      banner_base64: cleanString(body.banner_base64),
      banner_color: cleanString(body.banner_color) || "linear-gradient(135deg,#2563ff,#00c2ff)",
      updated_at: nowIso(),
    })
    .eq("id", developer.id)
    .eq("profile_id", user.id)
    .select()
    .single();

  if (error) throw new Error(error.message);

  await adminClient
    .from("profiles")
    .update({
      full_name: displayName,
      updated_at: nowIso(),
    })
    .eq("id", user.id)
    .eq("role", "developer");

  return {
    data: {
      profile: ensured.data.profile,
      developer: savedDeveloper,
      public_url: `/pages/developers/profile.html?id=${savedDeveloper.id}`,
    },
    error: null,
    status: 200,
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
      message: "developer-account is alive.",
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed.", 405);
  }

  try {
    const { user, error: authError } = await requireUser(req);

    if (authError || !user) {
      return errorResponse(authError || "Authentication required.", 401);
    }

    const body = await req.json().catch(() => ({}));
    const action = cleanString(body.action) || "get_profile";
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    let result;

    if (action === "ensure_profile") {
      result = await ensureDeveloperProfile(adminClient, user, body);
    } else if (action === "get_profile") {
      result = await ensureDeveloperProfile(adminClient, user, {});
    } else if (action === "update_profile") {
      result = await updateDeveloperProfile(adminClient, user, body);
    } else {
      return errorResponse("Unknown developer account action.", 400);
    }

    if (result.error) {
      return errorResponse(result.error, result.status || 400);
    }

    return jsonResponse({
      ok: true,
      ...result.data,
    });
  } catch (error) {
    console.error(error);

    return errorResponse(
      error instanceof Error ? error.message : "Could not manage developer account.",
      500,
    );
  }
});
