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

function isAdminAccessRole(role: unknown) {
  const value = cleanString(role).toLowerCase();
  return value === "admin" || value === "admin_staff";
}

function previewText(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

function attachmentList(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function sanitizeAttachments(value: unknown) {
  return attachmentList(value)
    .slice(0, 5)
    .map((item) => {
      const attachment = item && typeof item === "object" ? item as Record<string, unknown> : {};
      return {
        bucket: cleanString(attachment.bucket) || "message-attachments",
        path: cleanString(attachment.path),
        file_name: cleanString(attachment.file_name || attachment.name).slice(0, 180) || "attachment",
        file_type: cleanString(attachment.file_type || attachment.type).slice(0, 120) || "application/octet-stream",
        file_size: Number(attachment.file_size || attachment.size || 0) || 0,
      };
    })
    .filter((attachment) => attachment.path && attachment.file_size <= 15 * 1024 * 1024);
}

async function loadProfileRecipient(adminClient: any, profileId: string) {
  if (!profileId) return null;

  const { data, error } = await adminClient
    .from("profiles")
    .select("email, full_name")
    .eq("id", profileId)
    .maybeSingle();

  if (error || !data?.email) {
    if (error) console.warn("Could not load message email recipient:", error.message);
    return null;
  }

  return {
    email: data.email,
    name: data.full_name || "",
  };
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
  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("id, email, role, full_name")
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) throw new Error(profileError.message);

  const { data: developer, error: developerError } = await adminClient
    .from("developers")
    .select("id, profile_id, display_name, handle, avatar_letter")
    .eq("profile_id", user.id)
    .maybeSingle();

  if (developerError) throw new Error(developerError.message);

  const role = isAdminAccessRole(profile?.role)
    ? "admin"
    : developer && profile?.role === "developer"
      ? "developer"
      : "buyer";

  return { user, profile, developer, role };
}

function canAccessThread(actor: any, thread: any) {
  if (!thread) return false;
  if (actor.role === "admin") return true;
  if (thread.buyer_id === actor.user.id) return true;
  if (actor.developer?.id && thread.developer_id === actor.developer.id) return true;
  return false;
}

async function queueMessageNotification(adminClient: any, actor: any, thread: any, message: any, body: string) {
  const senderRole = cleanString(message?.sender_role).toLowerCase();
  const senderName = senderRole === "developer"
    ? actor.developer?.display_name || actor.profile?.full_name || "A developer"
    : senderRole === "admin"
      ? "Nexus"
      : actor.profile?.full_name || "A buyer";

  let recipient = null;
  let dashboardUrl = "";

  if (senderRole === "buyer") {
    const developerProfileId = cleanString(thread?.developers?.profile_id);
    recipient = await loadProfileRecipient(adminClient, developerProfileId);
    dashboardUrl = "/pages/developer/dashboard.html#messages";
  } else if (thread?.buyer_id) {
    recipient = await loadProfileRecipient(adminClient, cleanString(thread.buyer_id));
    dashboardUrl = "/pages/buyer/dashboard.html#messages";
  }

  if (!recipient?.email) return;

  await safeEnqueueEmail(
    adminClient,
    "message_received",
    recipient,
    {
      sender_name: senderName,
      thread_subject: thread?.subject || thread?.automations?.title || "Nexus message",
      message_preview: previewText(body),
      dashboard_url: dashboardUrl,
    },
    {
      dedupeKey: `message_received:${message.id}:${recipient.email}`,
    },
  );
}

async function loadThread(adminClient: any, threadId: string) {
  const { data, error } = await adminClient
    .from("message_threads")
    .select("*, developers(display_name, handle, avatar_letter, profile_id), automations(title, slug, icon, color)")
    .eq("id", threadId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

async function addParticipants(adminClient: any, thread: any) {
  const participants = [];

  if (thread.buyer_id) {
    participants.push({
      thread_id: thread.id,
      user_id: thread.buyer_id,
      participant_role: "buyer",
      created_at: nowIso(),
    });
  }

  const developerProfileId = thread.developers?.profile_id || null;

  if (developerProfileId) {
    participants.push({
      thread_id: thread.id,
      user_id: developerProfileId,
      participant_role: "developer",
      created_at: nowIso(),
    });
  }

  if (!participants.length) return;

  await adminClient
    .from("message_thread_participants")
    .upsert(participants, { onConflict: "thread_id,user_id" });
}

async function markRead(adminClient: any, actor: any, thread: any) {
  if (!canAccessThread(actor, thread)) {
    return { error: "Message thread not found.", status: 404 };
  }

  const update: Record<string, unknown> = {
    updated_at: nowIso(),
  };

  if (actor.role === "admin") update.admin_unread_count = 0;
  if (thread.buyer_id === actor.user.id) update.buyer_unread_count = 0;
  if (actor.developer?.id && thread.developer_id === actor.developer.id) {
    update.developer_unread_count = 0;
  }

  await adminClient
    .from("message_threads")
    .update(update)
    .eq("id", thread.id);

  await adminClient
    .from("message_thread_participants")
    .upsert({
      thread_id: thread.id,
      user_id: actor.user.id,
      participant_role: actor.role,
      last_read_at: nowIso(),
      created_at: nowIso(),
    }, { onConflict: "thread_id,user_id" });

  return { error: null, status: 200 };
}

async function insertMessage(adminClient: any, actor: any, thread: any, body: string, attachmentsInput: unknown = []) {
  const text = cleanString(body);
  const attachments = sanitizeAttachments(attachmentsInput);

  if (text.length < 1 && !attachments.length) {
    return { data: null, error: "Write a message or attach a file first.", status: 400 };
  }

  if (text.length > 4000) {
    return { data: null, error: "Message is too long.", status: 400 };
  }

  const senderRole = actor.role === "admin"
    ? "admin"
    : actor.developer?.id && thread.developer_id === actor.developer.id
      ? "developer"
      : "buyer";

  const { data: message, error: messageError } = await adminClient
    .from("messages")
    .insert({
      thread_id: thread.id,
      sender_id: actor.user.id,
      sender_role: senderRole,
      body: text,
      attachments,
      created_at: nowIso(),
    })
    .select()
    .single();

  if (messageError) throw new Error(messageError.message);

  const update: Record<string, unknown> = {
    last_message_at: nowIso(),
    last_message_preview: previewText(text || `${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`),
    last_sender_role: senderRole,
    updated_at: nowIso(),
  };

  if (senderRole === "buyer") {
    update.buyer_unread_count = 0;
    update.developer_unread_count = Number(thread.developer_unread_count || 0) + 1;
    update.admin_unread_count = Number(thread.admin_unread_count || 0) + 1;
  } else if (senderRole === "developer") {
    update.developer_unread_count = 0;
    update.buyer_unread_count = Number(thread.buyer_unread_count || 0) + 1;
    update.admin_unread_count = Number(thread.admin_unread_count || 0) + 1;
  } else {
    update.admin_unread_count = 0;
    update.buyer_unread_count = Number(thread.buyer_unread_count || 0) + 1;
    update.developer_unread_count = Number(thread.developer_unread_count || 0) + 1;
  }

  const { data: updatedThread, error: threadError } = await adminClient
    .from("message_threads")
    .update(update)
    .eq("id", thread.id)
    .select("*, developers(display_name, handle, avatar_letter, profile_id), automations(title, slug, icon, color)")
    .single();

  if (threadError) throw new Error(threadError.message);

  await markRead(adminClient, actor, updatedThread);
  await queueMessageNotification(adminClient, actor, updatedThread, message, text || `${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`);

  return {
    data: {
      message,
      thread: updatedThread,
    },
    error: null,
    status: 200,
  };
}

async function listThreads(adminClient: any, actor: any) {
  let query = adminClient
    .from("message_threads")
    .select("*, developers(display_name, handle, avatar_letter), automations(title, slug, icon, color)")
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  if (actor.role === "developer") {
    query = query.eq("developer_id", actor.developer?.id || "00000000-0000-0000-0000-000000000000");
  } else if (actor.role !== "admin") {
    query = query.eq("buyer_id", actor.user.id);
  }

  const { data, error } = await query;

  if (error) throw new Error(error.message);

  return { data: { threads: data || [] }, error: null, status: 200 };
}

async function getThread(adminClient: any, actor: any, threadId: string) {
  const thread = await loadThread(adminClient, threadId);

  if (!canAccessThread(actor, thread)) {
    return { data: null, error: "Message thread not found.", status: 404 };
  }

  const { data: messages, error } = await adminClient
    .from("messages")
    .select("*")
    .eq("thread_id", thread.id)
    .order("created_at", { ascending: true });

  if (error) throw new Error(error.message);

  await markRead(adminClient, actor, thread);

  return {
    data: {
      thread,
      messages: messages || [],
    },
    error: null,
    status: 200,
  };
}

async function createThread(adminClient: any, payload: Record<string, unknown>) {
  const { data: thread, error } = await adminClient
    .from("message_threads")
    .insert({
      thread_type: payload.thread_type || "product_inquiry",
      subject: payload.subject || "New message",
      buyer_id: payload.buyer_id || null,
      developer_id: payload.developer_id || null,
      automation_id: payload.automation_id || null,
      order_id: payload.order_id || null,
      status: "open",
      source: payload.source || "platform",
      last_message_at: nowIso(),
      metadata: payload.metadata || {},
      created_at: nowIso(),
      updated_at: nowIso(),
    })
    .select("*, developers(display_name, handle, avatar_letter, profile_id), automations(title, slug, icon, color)")
    .single();

  if (error) throw new Error(error.message);

  await addParticipants(adminClient, thread);
  return thread;
}

async function findOpenDeveloperThread(adminClient: any, buyerId: string, developerId: string) {
  const { data, error } = await adminClient
    .from("message_threads")
    .select("*, developers(display_name, handle, avatar_letter, profile_id), automations(title, slug, icon, color)")
    .eq("buyer_id", buyerId)
    .eq("developer_id", developerId)
    .eq("status", "open")
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) throw new Error(error.message);
  return data?.[0] || null;
}

async function startProductThread(adminClient: any, actor: any, body: Record<string, unknown>) {
  if (actor.role !== "buyer") {
    return { data: null, error: "Use a buyer account to message a developer from the marketplace.", status: 403 };
  }

  const automationId = cleanString(body.automation_id);

  if (!automationId) {
    return { data: null, error: "Product is missing.", status: 400 };
  }

  const { data: product, error: productError } = await adminClient
    .from("automations")
    .select("id, title, slug, developer_id, developers(id, display_name, profile_id)")
    .eq("id", automationId)
    .maybeSingle();

  if (productError) throw new Error(productError.message);

  if (!product?.developer_id) {
    return { data: null, error: "This product does not have a developer yet.", status: 400 };
  }

  const existing = await findOpenDeveloperThread(adminClient, actor.user.id, product.developer_id);

  const thread = existing || await createThread(adminClient, {
    thread_type: "product_inquiry",
    subject: cleanString(body.subject) || `Question about ${product.title || "this product"}`,
    buyer_id: actor.user.id,
    developer_id: product.developer_id,
    automation_id: product.id,
    source: "product_modal",
    metadata: {
      product_title: product.title || "",
      product_slug: product.slug || "",
    },
  });

  const initialMessage = cleanString(body.message);

  if (initialMessage) {
    return insertMessage(adminClient, actor, thread, initialMessage);
  }

  return { data: { thread }, error: null, status: 200 };
}

async function startDeveloperThread(adminClient: any, actor: any, body: Record<string, unknown>) {
  if (actor.role !== "buyer") {
    return { data: null, error: "Use a buyer account to message a developer.", status: 403 };
  }

  const developerId = cleanString(body.developer_id);

  if (!developerId) {
    return { data: null, error: "Developer is missing.", status: 400 };
  }

  const { data: developer, error: developerError } = await adminClient
    .from("developers")
    .select("id, display_name, profile_id")
    .eq("id", developerId)
    .maybeSingle();

  if (developerError) throw new Error(developerError.message);
  if (!developer) return { data: null, error: "Developer not found.", status: 404 };

  const existing = await findOpenDeveloperThread(adminClient, actor.user.id, developer.id);

  const thread = existing || await createThread(adminClient, {
    thread_type: "developer_inquiry",
    subject: cleanString(body.subject) || `Message for ${developer.display_name || "developer"}`,
    buyer_id: actor.user.id,
    developer_id: developer.id,
    source: "developer_profile",
  });

  const initialMessage = cleanString(body.message);

  if (initialMessage) {
    return insertMessage(adminClient, actor, thread, initialMessage);
  }

  return { data: { thread }, error: null, status: 200 };
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
      message: "messages is alive.",
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

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const actor = await getActor(adminClient, user);
    const body = await req.json().catch(() => ({}));
    const action = cleanString(body.action) || "list_threads";

    let result;

    if (action === "list_threads") {
      result = await listThreads(adminClient, actor);
    } else if (action === "get_thread") {
      result = await getThread(adminClient, actor, cleanString(body.thread_id));
    } else if (action === "send_message") {
      const thread = await loadThread(adminClient, cleanString(body.thread_id));
      if (!canAccessThread(actor, thread)) {
        return errorResponse("Message thread not found.", 404);
      }
      result = await insertMessage(adminClient, actor, thread, cleanString(body.message), body.attachments);
    } else if (action === "mark_read") {
      const thread = await loadThread(adminClient, cleanString(body.thread_id));
      const readResult = await markRead(adminClient, actor, thread);
      result = {
        ...readResult,
        data: { thread },
      };
    } else if (action === "start_product_thread") {
      result = await startProductThread(adminClient, actor, body);
    } else if (action === "start_developer_thread") {
      result = await startDeveloperThread(adminClient, actor, body);
    } else {
      return errorResponse("Unknown messages action.", 400);
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
      error instanceof Error ? error.message : "Could not process message request.",
      500,
    );
  }
});
