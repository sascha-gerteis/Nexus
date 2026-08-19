import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import { safeEnqueueOutputReadyEmail } from "../_shared/nexus-email.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const BUCKET = "buyer-deliverables";
const MAX_FILE_SIZE = 50 * 1024 * 1024;
const DOWNLOAD_TTL_SECONDS = 5 * 60;
const VIEW_TTL_SECONDS = 15 * 60;
const SAFE_EXTENSIONS = new Set([
  "pdf", "ppt", "pptx", "doc", "docx", "xls", "xlsx", "csv", "txt", "md",
  "png", "jpg", "jpeg", "gif", "webp", "mp4", "webm", "mov", "mp3", "wav", "m4a", "zip",
]);
const SAFE_OUTPUT_TYPES = new Set([
  "presentation", "document", "spreadsheet", "report", "image", "video", "audio", "file",
]);
const SAFE_COLORS = new Set([
  "blue", "cyan", "teal", "green", "yellow", "orange", "red", "pink", "purple", "violet", "indigo",
]);

function cleanString(value: unknown) {
  return String(value ?? "").trim();
}

function lowerString(value: unknown) {
  return cleanString(value).toLowerCase();
}

function one(value: any) {
  return Array.isArray(value) ? value[0] || {} : value || {};
}

function safeFileName(value: unknown) {
  const raw = cleanString(value) || "deliverable";
  return raw
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 140) || "deliverable";
}

function fileExtension(value: unknown) {
  const name = safeFileName(value).toLowerCase();
  return name.match(/\.([a-z0-9]+)$/)?.[1] || "";
}

function safeFileType(fileName: unknown, fileType: unknown) {
  const extension = fileExtension(fileName);
  const mime = lowerString(fileType) || "application/octet-stream";
  const blockedMime = /(?:text\/html|image\/svg|javascript|x-msdownload|x-dosexec|x-sh|x-bat)/i.test(mime);
  return SAFE_EXTENSIONS.has(extension) && !blockedMime;
}

function outputTypeForFile(fileName: unknown, requested: unknown) {
  const preferred = lowerString(requested).replace(/[\s-]+/g, "_");
  if (SAFE_OUTPUT_TYPES.has(preferred)) return preferred;
  const extension = fileExtension(fileName);
  if (["ppt", "pptx"].includes(extension)) return "presentation";
  if (["xls", "xlsx", "csv"].includes(extension)) return "spreadsheet";
  if (["pdf", "doc", "docx", "txt", "md"].includes(extension)) return "document";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(extension)) return "image";
  if (["mp4", "webm", "mov"].includes(extension)) return "video";
  if (["mp3", "wav", "m4a"].includes(extension)) return "audio";
  return "file";
}

function adminDeliveryMeta(output: any) {
  const content = output?.content_json && typeof output.content_json === "object" && !Array.isArray(output.content_json)
    ? output.content_json
    : {};
  const meta = content.nexus_admin_delivery;
  return meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {};
}

async function requireUser(req: Request) {
  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return { user: null, profile: null, error: "Missing auth token." };
  }
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
    return { user: null, profile: null, error: "Managed deliverables are not configured." };
  }

  const token = authHeader.replace("Bearer ", "").trim();
  if (!token || token === SUPABASE_ANON_KEY) {
    return { user: null, profile: null, error: "Login required." };
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data?.user) {
    return { user: null, profile: null, error: "Invalid auth token." };
  }

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("id, email, full_name, role")
    .eq("id", data.user.id)
    .maybeSingle();
  if (profileError) return { user: data.user, profile: null, error: profileError.message };
  return { user: data.user, profile: profile || null, error: null };
}

function isOwnerAdmin(profile: any) {
  return lowerString(profile?.role) === "admin";
}

async function ensureBucket(adminClient: any) {
  const { error } = await adminClient.storage.createBucket(BUCKET, {
    public: false,
    fileSizeLimit: MAX_FILE_SIZE,
  });
  if (error && !/already exists|duplicate/i.test(cleanString(error.message))) {
    throw new Error(error.message);
  }
}

async function loadBuyers(adminClient: any) {
  const { data: profiles, error: profilesError } = await adminClient
    .from("profiles")
    .select("id, email, full_name, role, created_at")
    .eq("role", "buyer")
    .order("created_at", { ascending: false })
    .limit(500);
  if (profilesError) throw new Error(profilesError.message);

  const buyerIds = (profiles || []).map((profile: any) => profile.id).filter(Boolean);
  let buyerProfiles: any[] = [];
  if (buyerIds.length) {
    const { data, error } = await adminClient
      .from("buyer_profiles")
      .select("user_id, name, email, company, website")
      .in("user_id", buyerIds);
    if (error) throw new Error(error.message);
    buyerProfiles = data || [];
  }

  const detailsById = new Map(buyerProfiles.map((profile: any) => [profile.user_id, profile]));
  return (profiles || []).map((profile: any) => {
    const details = detailsById.get(profile.id) || {};
    return {
      id: profile.id,
      email: cleanString(details.email || profile.email),
      name: cleanString(details.name || profile.full_name),
      company: cleanString(details.company),
      website: cleanString(details.website),
      created_at: profile.created_at,
    };
  });
}

async function loadCollections(adminClient: any) {
  const { data, error } = await adminClient
    .from("buyer_output_collections")
    .select("id, buyer_id, name, description, icon, color, created_at, updated_at")
    .is("archived_at", null)
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) throw new Error(error.message);
  return data || [];
}

async function loadCustomerAutomations(adminClient: any) {
  const { data, error } = await adminClient
    .from("customer_automations")
    .select("id, buyer_id, automation_id, order_id, name, status, automations(id, title, slug, icon, color, category), orders(id, automation_title, buyer_name, buyer_email, order_type, bundle_id, payment_status, order_status)")
    .order("created_at", { ascending: false })
    .limit(2000);
  if (error) throw new Error(error.message);
  return data || [];
}

async function loadRecentCollectionDeliveries(adminClient: any) {
  const { data, error } = await adminClient
    .from("buyer_managed_deliverables")
    .select("id, collection_id, buyer_id, output_type, title, summary, bucket, storage_path, file_name, file_type, file_size, created_at, buyer_output_collections(id, name, description, icon, color)")
    .eq("status", "published")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data || []).map((item: any) => ({ ...item, delivery_target: "collection" }));
}

async function loadRecentProductDeliveries(adminClient: any) {
  const { data, error } = await adminClient
    .from("automation_outputs")
    .select("id, buyer_id, customer_automation_id, automation_id, order_id, output_type, title, summary, content_json, storage_path, created_at")
    .eq("status", "published")
    .contains("content_json", { nexus_admin_delivery: { source: "admin_manual" } })
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data || []).map((item: any) => ({ ...item, delivery_target: "product" }));
}
async function loadCollection(adminClient: any, collectionId: string) {
  if (!collectionId) return null;
  const { data, error } = await adminClient
    .from("buyer_output_collections")
    .select("id, buyer_id, name, description, icon, color, archived_at")
    .eq("id", collectionId)
    .is("archived_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

async function loadCustomerAutomation(adminClient: any, customerAutomationId: string) {
  if (!customerAutomationId) return null;
  const { data, error } = await adminClient
    .from("customer_automations")
    .select("id, buyer_id, automation_id, order_id, name, status, automations(id, title, slug, icon, color, category), orders(id, automation_title, buyer_name, buyer_email, order_type, bundle_id, payment_status, order_status)")
    .eq("id", customerAutomationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

async function listAdminData(adminClient: any) {
  const [buyers, collections, customerAutomations, collectionDeliveries, productDeliveries] = await Promise.all([
    loadBuyers(adminClient),
    loadCollections(adminClient),
    loadCustomerAutomations(adminClient),
    loadRecentCollectionDeliveries(adminClient),
    loadRecentProductDeliveries(adminClient),
  ]);
  const deliveries = [...collectionDeliveries, ...productDeliveries]
    .sort((left: any, right: any) => String(right.created_at || "").localeCompare(String(left.created_at || "")))
    .slice(0, 50);
  return { data: { buyers, collections, customer_automations: customerAutomations, deliveries }, status: 200 };
}
async function createCollection(adminClient: any, actor: any, body: Record<string, unknown>) {
  const buyerId = cleanString(body.buyer_id || body.buyerId);
  const name = cleanString(body.name).slice(0, 120);
  const description = cleanString(body.description).slice(0, 1000);
  const icon = cleanString(body.icon).replace(/[^a-z0-9]/gi, "").slice(0, 3).toUpperCase() || "PR";
  const requestedColor = lowerString(body.color);
  const color = SAFE_COLORS.has(requestedColor) ? requestedColor : "purple";
  if (!buyerId || !name) return { error: "Select a buyer and add a collection name.", status: 400 };

  const { data: buyer, error: buyerError } = await adminClient
    .from("profiles")
    .select("id, role")
    .eq("id", buyerId)
    .maybeSingle();
  if (buyerError) throw new Error(buyerError.message);
  if (!buyer || lowerString(buyer.role) !== "buyer") {
    return { error: "Select a valid buyer account.", status: 404 };
  }

  const { data: existingRows, error: existingError } = await adminClient
    .from("buyer_output_collections")
    .select("id, buyer_id, name, description, icon, color, created_at, updated_at")
    .eq("buyer_id", buyerId)
    .is("archived_at", null);
  if (existingError) throw new Error(existingError.message);
  const existing = (existingRows || []).find((item: any) => lowerString(item.name) === lowerString(name));
  if (existing) return { data: { collection: existing, existing: true }, status: 200 };

  const { data: collection, error } = await adminClient
    .from("buyer_output_collections")
    .insert({ buyer_id: buyerId, name, description, icon, color, created_by: actor.user.id })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return { data: { collection, existing: false }, status: 200 };
}

async function createUpload(adminClient: any, body: Record<string, unknown>) {
  const collectionId = cleanString(body.collection_id || body.collectionId);
  const customerAutomationId = cleanString(body.customer_automation_id || body.customerAutomationId);
  if ((!collectionId && !customerAutomationId) || (collectionId && customerAutomationId)) {
    return { error: "Choose exactly one destination: an output collection or an existing buyer product.", status: 400 };
  }

  const collection = collectionId ? await loadCollection(adminClient, collectionId) : null;
  const customerAutomation = customerAutomationId ? await loadCustomerAutomation(adminClient, customerAutomationId) : null;
  if (collectionId && !collection) return { error: "Select a valid output collection.", status: 404 };
  if (customerAutomationId && !customerAutomation) return { error: "Select a valid buyer product.", status: 404 };

  const fileName = safeFileName(body.file_name || body.fileName);
  const fileType = lowerString(body.file_type || body.fileType) || "application/octet-stream";
  const fileSize = Number(body.file_size || body.fileSize || 0);
  if (!Number.isFinite(fileSize) || fileSize <= 0) return { error: "Choose a non-empty file.", status: 400 };
  if (fileSize > MAX_FILE_SIZE) return { error: "The file is larger than the 50 MB limit.", status: 400 };
  if (!safeFileType(fileName, fileType)) {
    return { error: "Use a common presentation, document, spreadsheet, image, media, text, or ZIP file.", status: 400 };
  }

  await ensureBucket(adminClient);
  const path = collection
    ? `${collection.buyer_id}/collections/${collection.id}/${crypto.randomUUID()}/${fileName}`
    : `${customerAutomation.buyer_id}/${customerAutomation.id}/${crypto.randomUUID()}/${fileName}`;
  const { data, error } = await adminClient.storage.from(BUCKET).createSignedUploadUrl(path);
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
    status: 200,
  };
}
async function storageObject(adminClient: any, storagePath: string) {
  const parts = storagePath.split("/").filter(Boolean);
  const fileName = parts.pop() || "";
  const folder = parts.join("/");
  if (!folder || !fileName) return null;
  const { data, error } = await adminClient.storage.from(BUCKET).list(folder, { limit: 20, search: fileName });
  if (error) throw new Error(error.message);
  return (data || []).find((item: any) => item.name === fileName) || null;
}

async function publishCollectionDelivery(adminClient: any, actor: any, body: Record<string, unknown>, collection: any) {
  const storagePath = cleanString(body.storage_path || body.storagePath);
  const expectedPrefix = `${collection.buyer_id}/collections/${collection.id}/`;
  if (!storagePath.startsWith(expectedPrefix) || storagePath.includes("..")) {
    return { error: "The uploaded file does not belong to this buyer and collection.", status: 409 };
  }

  const fileName = safeFileName(body.file_name || body.fileName || storagePath.split("/").pop());
  const fileType = lowerString(body.file_type || body.fileType) || "application/octet-stream";
  const fileSize = Number(body.file_size || body.fileSize || 0);
  if (!safeFileType(fileName, fileType) || !Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MAX_FILE_SIZE) {
    return { error: "The uploaded file metadata is invalid.", status: 400 };
  }
  if (!await storageObject(adminClient, storagePath)) {
    return { error: "The file upload did not finish. Upload it again before publishing.", status: 409 };
  }

  const title = cleanString(body.title).slice(0, 240);
  const summary = cleanString(body.summary).slice(0, 2000);
  if (!title) return { error: "Add a buyer-facing title.", status: 400 };
  const now = new Date().toISOString();
  const outputType = outputTypeForFile(fileName, body.output_type || body.outputType);

  const { data: delivery, error } = await adminClient
    .from("buyer_managed_deliverables")
    .insert({
      collection_id: collection.id,
      buyer_id: collection.buyer_id,
      output_type: outputType,
      status: "published",
      title,
      summary,
      bucket: BUCKET,
      storage_path: storagePath,
      file_name: fileName,
      file_type: fileType,
      file_size: fileSize,
      delivered_by: actor.user.id,
      created_at: now,
      updated_at: now,
    })
    .select()
    .single();
  if (error || !delivery) {
    await adminClient.storage.from(BUCKET).remove([storagePath]);
    throw new Error(error?.message || "Could not publish the file.");
  }

  if (body.notify_buyer !== false && body.notifyBuyer !== false) {
    await safeEnqueueOutputReadyEmail(adminClient, {
      outputId: delivery.id,
      buyerId: collection.buyer_id,
      productTitle: collection.name,
      outputTitle: title,
    });
  }
  return { data: { delivery, message: `${title} was added to ${collection.name} in the buyer's Outputs section.` }, status: 200 };
}

async function publishProductDelivery(adminClient: any, actor: any, body: Record<string, unknown>, customerAutomation: any) {
  const storagePath = cleanString(body.storage_path || body.storagePath);
  const expectedPrefix = `${customerAutomation.buyer_id}/${customerAutomation.id}/`;
  if (!storagePath.startsWith(expectedPrefix) || storagePath.includes("..")) {
    return { error: "The uploaded file does not belong to this buyer and product.", status: 409 };
  }

  const fileName = safeFileName(body.file_name || body.fileName || storagePath.split("/").pop());
  const fileType = lowerString(body.file_type || body.fileType) || "application/octet-stream";
  const fileSize = Number(body.file_size || body.fileSize || 0);
  if (!safeFileType(fileName, fileType) || !Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MAX_FILE_SIZE) {
    return { error: "The uploaded file metadata is invalid.", status: 400 };
  }
  if (!await storageObject(adminClient, storagePath)) {
    return { error: "The file upload did not finish. Upload it again before publishing.", status: 409 };
  }

  const title = cleanString(body.title).slice(0, 240);
  const summary = cleanString(body.summary).slice(0, 2000);
  if (!title) return { error: "Add a buyer-facing title.", status: 400 };

  const now = new Date().toISOString();
  const product = one(customerAutomation.automations);
  const order = one(customerAutomation.orders);
  const outputType = outputTypeForFile(fileName, body.output_type || body.outputType);
  const outputPayload = {
    customer_automation_id: customerAutomation.id,
    order_id: customerAutomation.order_id || order.id || null,
    buyer_id: customerAutomation.buyer_id,
    automation_id: customerAutomation.automation_id || product.id || null,
    automation_run_id: null,
    bundle_run_attempt_id: null,
    bundle_run_item_id: null,
    output_type: outputType,
    status: "published",
    title,
    summary,
    content_text: summary,
    content_html: "",
    content_json: {
      nexus_admin_delivery: {
        source: "admin_manual",
        bucket: BUCKET,
        storage_path: storagePath,
        file_name: fileName,
        file_type: fileType,
        file_size: fileSize,
        delivered_by: actor.user.id,
        delivered_at: now,
      },
    },
    file_url: "",
    storage_path: storagePath,
    created_by: "admin",
    created_at: now,
    updated_at: now,
  };

  const { data: output, error: outputError } = await adminClient
    .from("automation_outputs")
    .insert(outputPayload)
    .select()
    .single();
  if (outputError || !output) {
    await adminClient.storage.from(BUCKET).remove([storagePath]);
    throw new Error(outputError?.message || "Could not publish the file.");
  }

  const { error: eventError } = await adminClient.from("automation_events").insert({
    customer_automation_id: customerAutomation.id,
    buyer_id: customerAutomation.buyer_id,
    automation_id: customerAutomation.automation_id || product.id || null,
    order_id: customerAutomation.order_id || order.id || null,
    event_type: "admin_deliverable_published",
    title: "New file delivered by Nexus",
    message: JSON.stringify({ output_id: output.id, output_type: outputType, title, file_name: fileName }),
    created_by: "admin",
    created_at: now,
  });
  if (eventError) console.warn("Could not record admin delivery event:", eventError.message);

  if (body.notify_buyer !== false && body.notifyBuyer !== false) {
    await safeEnqueueOutputReadyEmail(adminClient, {
      outputId: output.id,
      buyerId: customerAutomation.buyer_id,
      orderId: customerAutomation.order_id || order.id || null,
      automationId: customerAutomation.automation_id || product.id || null,
      customerAutomationId: customerAutomation.id,
      productTitle: product.title || customerAutomation.name || order.automation_title,
      outputTitle: title,
    });
  }

  return { data: { output, message: `${title} was added to the buyer's ${product.title || customerAutomation.name || "product"} output history.` }, status: 200 };
}

async function publishDelivery(adminClient: any, actor: any, body: Record<string, unknown>) {
  const collectionId = cleanString(body.collection_id || body.collectionId);
  const customerAutomationId = cleanString(body.customer_automation_id || body.customerAutomationId);
  if ((!collectionId && !customerAutomationId) || (collectionId && customerAutomationId)) {
    return { error: "Choose exactly one destination: an output collection or an existing buyer product.", status: 400 };
  }
  if (collectionId) {
    const collection = await loadCollection(adminClient, collectionId);
    if (!collection) return { error: "Select a valid output collection.", status: 404 };
    return publishCollectionDelivery(adminClient, actor, body, collection);
  }
  const customerAutomation = await loadCustomerAutomation(adminClient, customerAutomationId);
  if (!customerAutomation) return { error: "Select a valid buyer product.", status: 404 };
  return publishProductDelivery(adminClient, actor, body, customerAutomation);
}
async function signedUrls(adminClient: any, storagePath: string, fileName: string) {
  const [viewResult, downloadResult] = await Promise.all([
    adminClient.storage.from(BUCKET).createSignedUrl(storagePath, VIEW_TTL_SECONDS),
    adminClient.storage.from(BUCKET).createSignedUrl(storagePath, DOWNLOAD_TTL_SECONDS, { download: fileName }),
  ]);
  if (viewResult.error) throw new Error(viewResult.error.message);
  if (downloadResult.error) throw new Error(downloadResult.error.message);
  return { viewUrl: viewResult.data.signedUrl, downloadUrl: downloadResult.data.signedUrl };
}

async function signOutputFile(adminClient: any, actor: any, body: Record<string, unknown>) {
  const outputId = cleanString(body.output_id || body.outputId);
  if (!outputId) return { error: "Output ID is required.", status: 400 };

  const { data: managed, error: managedError } = await adminClient
    .from("buyer_managed_deliverables")
    .select("id, collection_id, buyer_id, status, title, bucket, storage_path, file_name, file_type, file_size")
    .eq("id", outputId)
    .maybeSingle();
  if (managedError) throw new Error(managedError.message);
  if (managed) {
    if (!isOwnerAdmin(actor.profile) && (managed.buyer_id !== actor.user.id || lowerString(managed.status) !== "published")) {
      return { error: "File output not found.", status: 404 };
    }
    const expectedPrefix = `${managed.buyer_id}/collections/${managed.collection_id}/`;
    if (managed.bucket !== BUCKET || !cleanString(managed.storage_path).startsWith(expectedPrefix)) {
      return { error: "This output is not a managed buyer file.", status: 404 };
    }
    const fileName = safeFileName(managed.file_name || managed.storage_path.split("/").pop());
    const urls = await signedUrls(adminClient, managed.storage_path, fileName);
    return {
      data: {
        view_url: urls.viewUrl,
        download_url: urls.downloadUrl,
        view_expires_in: VIEW_TTL_SECONDS,
        download_expires_in: DOWNLOAD_TTL_SECONDS,
        file_name: fileName,
        file_type: cleanString(managed.file_type),
        file_size: Number(managed.file_size || 0),
      },
      status: 200,
    };
  }

  // Backward compatibility for files delivered before independent collections existed.
  const { data: legacy, error: legacyError } = await adminClient
    .from("automation_outputs")
    .select("id, buyer_id, customer_automation_id, status, storage_path, content_json")
    .eq("id", outputId)
    .maybeSingle();
  if (legacyError) throw new Error(legacyError.message);
  if (!legacy || (!isOwnerAdmin(actor.profile) && (legacy.buyer_id !== actor.user.id || lowerString(legacy.status) !== "published"))) {
    return { error: "File output not found.", status: 404 };
  }
  const meta = adminDeliveryMeta(legacy);
  const storagePath = cleanString(legacy.storage_path || meta.storage_path);
  const expectedPrefix = `${legacy.buyer_id}/${legacy.customer_automation_id}/`;
  if (cleanString(meta.source) !== "admin_manual" || cleanString(meta.bucket) !== BUCKET || !storagePath.startsWith(expectedPrefix)) {
    return { error: "This output is not a managed buyer file.", status: 404 };
  }
  const fileName = safeFileName(meta.file_name || storagePath.split("/").pop());
  const urls = await signedUrls(adminClient, storagePath, fileName);
  return {
    data: {
      view_url: urls.viewUrl,
      download_url: urls.downloadUrl,
      view_expires_in: VIEW_TTL_SECONDS,
      download_expires_in: DOWNLOAD_TTL_SECONDS,
      file_name: fileName,
      file_type: cleanString(meta.file_type),
      file_size: Number(meta.file_size || 0),
    },
    status: 200,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders });
  if (req.method === "GET") return jsonResponse({ ok: true, message: "managed-deliverables is available." });
  if (req.method !== "POST") return errorResponse("Method not allowed.", 405);

  try {
    const actor = await requireUser(req);
    if (actor.error || !actor.user) return errorResponse(actor.error || "Login required.", 401);
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const body = await req.json().catch(() => ({}));
    const action = lowerString(body.action);

    let result: any;
    if (action === "sign_output_file") {
      result = await signOutputFile(adminClient, actor, body);
    } else {
      if (!isOwnerAdmin(actor.profile)) return errorResponse("Owner admin access required.", 403);
      result = action === "list"
        ? await listAdminData(adminClient)
        : action === "create_collection"
          ? await createCollection(adminClient, actor, body)
          : action === "create_upload"
            ? await createUpload(adminClient, body)
            : action === "publish"
              ? await publishDelivery(adminClient, actor, body)
              : { error: "Unknown managed deliverable action.", status: 400 };
    }

    if (result.error) return errorResponse(result.error, result.status || 400);
    return jsonResponse({ ok: true, ...result.data });
  } catch (error) {
    console.error("managed-deliverables failed:", error);
    return errorResponse(error instanceof Error ? error.message : "Could not process the managed deliverable.", 500);
  }
});
