import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const BUCKET = "message-attachments";
const MAX_FILE_SIZE = 15 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 10 * 60;

function cleanString(value: unknown) {
  return String(value || "").trim();
}

function safeFileName(value: unknown) {
  const raw = cleanString(value) || "attachment";
  return raw
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 120) || "attachment";
}

function isAdminAccessRole(role: unknown) {
  const value = cleanString(role).toLowerCase();
  return value === "admin" || value === "admin_staff";
}

function attachmentList(value: unknown) {
  return Array.isArray(value) ? value : [];
}

async function requireUser(req: Request) {
  const authHeader = req.headers.get("Authorization") || "";

  if (!authHeader.startsWith("Bearer ")) {
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
  if (!token || token === SUPABASE_ANON_KEY) {
    return { user: null, error: "Login required." };
  }

  const { data, error } = await userClient.auth.getUser(token);

  if (error || !data?.user) {
    return { user: null, error: "Invalid auth token." };
  }

  return { user: data.user, error: null };
}

async function getActor(adminClient: any, user: any) {
  const { data: profile } = await adminClient
    .from("profiles")
    .select("id, role")
    .eq("id", user.id)
    .maybeSingle();

  const { data: developer } = await adminClient
    .from("developers")
    .select("id, profile_id")
    .eq("profile_id", user.id)
    .maybeSingle();

  return {
    user,
    role: profile?.role || "buyer",
    developer: developer || null,
  };
}

async function loadThread(adminClient: any, threadId: string) {
  if (!threadId) return null;

  const { data, error } = await adminClient
    .from("message_threads")
    .select("id, buyer_id, developer_id")
    .eq("id", threadId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data || null;
}

function canAccessThread(actor: any, thread: any) {
  if (!actor?.user || !thread) return false;
  if (isAdminAccessRole(actor.role)) return true;
  if (thread.buyer_id === actor.user.id) return true;
  if (actor.developer?.id && thread.developer_id === actor.developer.id) return true;
  return false;
}

async function createUpload(adminClient: any, actor: any, body: Record<string, unknown>) {
  const threadId = cleanString(body.thread_id);
  const thread = await loadThread(adminClient, threadId);

  if (!canAccessThread(actor, thread)) {
    return { data: null, error: "Message thread not found.", status: 404 };
  }

  const fileName = safeFileName(body.file_name);
  const fileType = cleanString(body.file_type) || "application/octet-stream";
  const fileSize = Number(body.file_size || 0);

  if (!Number.isFinite(fileSize) || fileSize <= 0) {
    return { data: null, error: "File is empty.", status: 400 };
  }

  if (fileSize > MAX_FILE_SIZE) {
    return { data: null, error: "File is too large. Maximum size is 15 MB.", status: 400 };
  }

  const path = `${thread.id}/${crypto.randomUUID()}-${fileName}`;
  const { data, error } = await adminClient.storage
    .from(BUCKET)
    .createSignedUploadUrl(path);

  if (error) throw new Error(error.message);

  return {
    data: {
      upload: {
        bucket: BUCKET,
        path,
        token: data.token,
        signed_url: data.signedUrl,
        file_name: fileName,
        file_type: fileType,
        file_size: fileSize,
      },
    },
    error: null,
    status: 200,
  };
}

async function signUrls(adminClient: any, actor: any, body: Record<string, unknown>) {
  const threadId = cleanString(body.thread_id);
  const thread = await loadThread(adminClient, threadId);

  if (!canAccessThread(actor, thread)) {
    return { data: null, error: "Message thread not found.", status: 404 };
  }

  const attachments = attachmentList(body.attachments)
    .map((item) => item && typeof item === "object" ? item as Record<string, unknown> : {})
    .filter((item) => cleanString(item.bucket || BUCKET) === BUCKET)
    .filter((item) => cleanString(item.path).startsWith(`${thread.id}/`))
    .slice(0, 50);

  if (!attachments.length) {
    return { data: { attachments: [] }, error: null, status: 200 };
  }

  const paths = attachments.map((item) => cleanString(item.path));
  const { data, error } = await adminClient.storage
    .from(BUCKET)
    .createSignedUrls(paths, SIGNED_URL_TTL_SECONDS);

  if (error) throw new Error(error.message);

  const byPath = new Map((data || []).map((item: any) => [item.path, item.signedUrl]));

  return {
    data: {
      attachments: attachments.map((attachment) => ({
        ...attachment,
        bucket: BUCKET,
        download_url: byPath.get(cleanString(attachment.path)) || "",
      })),
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
      message: "message-attachments is alive.",
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed.", 405);
  }

  try {
    const { user, error: authError } = await requireUser(req);
    if (authError || !user) {
      return errorResponse(authError || "Login required.", 401);
    }

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const actor = await getActor(adminClient, user);
    const body = await req.json().catch(() => ({}));
    const action = cleanString(body.action);

    const result = action === "create_upload"
      ? await createUpload(adminClient, actor, body)
      : action === "sign_urls"
        ? await signUrls(adminClient, actor, body)
        : { data: null, error: "Unknown message attachment action.", status: 400 };

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
      error instanceof Error ? error.message : "Could not process attachment request.",
      500,
    );
  }
});
