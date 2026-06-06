import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function cleanString(value: unknown, maxLength = 1000) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeArray(value: unknown) {
  const rawValues = Array.isArray(value)
    ? value
    : String(value ?? "")
      .split(",")
      .map((item) => item.trim());

  return Array.from(
    new Set(
      rawValues
        .map((item) => cleanString(item, 120))
        .filter(Boolean),
    ),
  ).slice(0, 30);
}

function hasStructuredColumnError(error: unknown) {
  const message = String((error as { message?: string })?.message || "");

  return /automation_categories|build_stack|build_stack_other|schema cache/i.test(message);
}

function hasDuplicateWaitlistError(error: unknown) {
  const typedError = error as { code?: string; message?: string; details?: string };
  const message = `${typedError?.message || ""} ${typedError?.details || ""}`;
  return typedError?.code === "23505" || /duplicate key|already exists|conflict/i.test(message);
}

function buildLegacyAutomationType(categories: string[], buildStack: string[], otherStack: string) {
  return [
    categories.length ? `Types: ${categories.join(", ")}` : "",
    buildStack.length || otherStack ? `Stack: ${[...buildStack, otherStack].filter(Boolean).join(", ")}` : "",
  ].filter(Boolean).join("\n");
}

async function saveWaitlistPayload(adminClient: any, payload: Record<string, unknown>) {
  const email = cleanString(payload.email, 240).toLowerCase();

  if (!email) {
    return { error: { message: "Please enter a valid email address." } };
  }

  const { data: existing, error: findError } = await adminClient
    .from("developer_waitlist")
    .select("id")
    .eq("email", email)
    .limit(1)
    .maybeSingle();

  if (findError && !hasStructuredColumnError(findError)) {
    return { error: findError };
  }

  if (existing?.id) {
    const updateResult = await adminClient
      .from("developer_waitlist")
      .update(payload)
      .eq("id", existing.id);

    if (!updateResult.error || hasDuplicateWaitlistError(updateResult.error)) {
      return { error: null };
    }

    return { error: updateResult.error };
  }

  const insertResult = await adminClient
    .from("developer_waitlist")
    .insert(payload);

  if (!insertResult.error) {
    return { error: null };
  }

  if (hasDuplicateWaitlistError(insertResult.error)) {
    const updateResult = await adminClient
      .from("developer_waitlist")
      .update(payload)
      .eq("email", email);

    if (!updateResult.error) {
      return { error: null };
    }

    return { error: updateResult.error };
  }

  return { error: insertResult.error };
}

function dedupeWaitlistRows(rows: Record<string, unknown>[]) {
  const byEmail = new Map<string, Record<string, unknown>>();

  for (const row of rows) {
    const email = cleanString(row.email, 240).toLowerCase();
    const key = email || cleanString(row.id, 120);
    const existing = byEmail.get(key);

    if (!existing) {
      byEmail.set(key, row);
      continue;
    }

    const existingIsFallback = cleanString(existing.source) === "contact_messages";
    const rowIsPrimary = cleanString(row.source) !== "contact_messages";
    const rowIsNewer = new Date(cleanString(row.created_at) || 0).getTime() >
      new Date(cleanString(existing.created_at) || 0).getTime();

    if ((existingIsFallback && rowIsPrimary) || (!rowIsPrimary && rowIsNewer)) {
      byEmail.set(key, row);
    }
  }

  return Array.from(byEmail.values()).sort((a, b) => {
    return new Date(cleanString(b.created_at) || 0).getTime() -
      new Date(cleanString(a.created_at) || 0).getTime();
  });
}

function splitList(value: string) {
  return value
    .split(",")
    .map((item) => cleanString(item, 120))
    .filter(Boolean);
}

function parseFallbackWaitlistMessage(message: string) {
  const lines = message
    .split(/\r?\n/)
    .map((line) => cleanString(line, 1000))
    .filter(Boolean);

  const parsed = {
    automationType: "",
    automationCategories: [] as string[],
    buildStack: [] as string[],
    buildStackOther: "",
    experience: "",
  };

  const experienceLines: string[] = [];

  for (const line of lines) {
    if (/^developer waitlist signup fallback\.?$/i.test(line)) {
      continue;
    }

    if (/^types:/i.test(line)) {
      parsed.automationCategories = splitList(line.replace(/^types:\s*/i, ""));
      continue;
    }

    if (/^stack:/i.test(line)) {
      const stackItems = splitList(line.replace(/^stack:\s*/i, ""));
      parsed.buildStack = stackItems.filter((item) => item.toLowerCase() !== "other");
      continue;
    }

    if (/^experience:/i.test(line)) {
      experienceLines.push(cleanString(line.replace(/^experience:\s*/i, ""), 1000));
      continue;
    }

    experienceLines.push(line);
  }

  parsed.experience = experienceLines.filter(Boolean).join("\n");
  parsed.automationType = [
    parsed.automationCategories.length ? `Types: ${parsed.automationCategories.join(", ")}` : "",
    parsed.buildStack.length ? `Stack: ${parsed.buildStack.join(", ")}` : "",
  ].filter(Boolean).join("\n");

  return parsed;
}

function contactToWaitlistRow(row: Record<string, unknown>) {
  const parsed = parseFallbackWaitlistMessage(cleanString(row.message, 4000));

  return {
    id: `contact-${cleanString(row.id)}`,
    name: cleanString(row.name, 160),
    email: cleanString(row.email, 240),
    automation_type: parsed.automationType,
    automation_categories: parsed.automationCategories,
    build_stack: parsed.buildStack,
    build_stack_other: parsed.buildStackOther,
    experience: parsed.experience,
    status: cleanString(row.status, 80) || "new",
    created_at: cleanString(row.created_at, 80) || new Date().toISOString(),
    source: "contact_messages",
  };
}

async function saveWaitlistFallbackContact(
  adminClient: any,
  payload: {
    name: string;
    email: string;
    automationType: string;
    experience: string;
  },
) {
  const message = [
    "Developer waitlist signup fallback.",
    payload.automationType ? `\n${payload.automationType}` : "",
    payload.experience ? `\nExperience: ${payload.experience}` : "",
  ].join("").trim();

  const result = await adminClient
    .from("contact_messages")
    .insert({
      name: payload.name,
      email: payload.email,
      company: "",
      inquiry_type: "developer_waitlist",
      message,
      status: "new",
    });

  return result;
}

async function requireAdmin(req: Request, adminClient: any) {
  const authHeader = req.headers.get("Authorization") || "";

  if (!SUPABASE_ANON_KEY || !authHeader.startsWith("Bearer ")) {
    return { user: null, error: "Admin login required." };
  }

  const token = authHeader.replace("Bearer ", "");
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data, error } = await userClient.auth.getUser(token);

  if (error || !data?.user) {
    return { user: null, error: "Invalid admin session." };
  }

  const { data: profile } = await adminClient
    .from("profiles")
    .select("role")
    .eq("id", data.user.id)
    .maybeSingle();

  if (profile?.role !== "admin") {
    return { user: data.user, error: "Admin access required." };
  }

  return { user: data.user, error: null };
}

async function listWaitlistForAdmin(req: Request, adminClient: any) {
  const auth = await requireAdmin(req, adminClient);

  if (auth.error) {
    return errorResponse(auth.error, 401);
  }

  const { data, error } = await adminClient
    .from("developer_waitlist")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    return errorResponse(error.message || "Could not load developer waitlist.", 500);
  }

  const { data: fallbackContacts } = await adminClient
    .from("contact_messages")
    .select("id,name,email,message,status,created_at,inquiry_type")
    .eq("inquiry_type", "developer_waitlist")
    .order("created_at", { ascending: false });

  const rows = dedupeWaitlistRows([
    ...(data || []),
    ...((fallbackContacts || []) as Record<string, unknown>[]).map(contactToWaitlistRow),
  ]);

  return jsonResponse({
    ok: true,
    waitlist: rows,
    count: rows.length,
  });
}

async function countWaitlistForAdmin(req: Request, adminClient: any) {
  const auth = await requireAdmin(req, adminClient);

  if (auth.error) {
    return errorResponse(auth.error, 401);
  }

  const { data, error } = await adminClient
    .from("developer_waitlist")
    .select("id,email,created_at");

  if (error) {
    return errorResponse(error.message || "Could not count developer waitlist.", 500);
  }

  const { data: fallbackContacts } = await adminClient
    .from("contact_messages")
    .select("id,email,created_at,inquiry_type")
    .eq("inquiry_type", "developer_waitlist");

  const rows = dedupeWaitlistRows([
    ...((data || []) as Record<string, unknown>[]),
    ...((fallbackContacts || []) as Record<string, unknown>[]).map(contactToWaitlistRow),
  ]);

  return jsonResponse({
    ok: true,
    count: rows.length,
  });
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
      message: "submit-developer-waitlist is alive.",
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed.", 405);
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return errorResponse("Waitlist function is missing Supabase environment variables.", 500);
    }

    const body = await req.json().catch(() => ({}));
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const action = cleanString(body.action, 80);

    if (action === "admin_list") {
      return await listWaitlistForAdmin(req, adminClient);
    }

    if (action === "admin_count") {
      return await countWaitlistForAdmin(req, adminClient);
    }

    const name = cleanString(body.name, 160);
    const email = cleanString(body.email, 240).toLowerCase();
    const automationCategories = normalizeArray(body.automation_categories);
    const buildStack = normalizeArray(body.build_stack);
    const buildStackOther = cleanString(body.build_stack_other, 500);
    const experience = cleanString(body.experience, 4000);
    const automationType = buildLegacyAutomationType(automationCategories, buildStack, buildStackOther);

    if (!name) {
      return errorResponse("Please enter your name.", 400);
    }

    if (!email || !isValidEmail(email)) {
      return errorResponse("Please enter a valid email address.", 400);
    }

    const insertPayload = {
      name,
      email,
      automation_type: automationType,
      automation_categories: automationCategories,
      build_stack: buildStack,
      build_stack_other: buildStackOther,
      experience,
      status: "new",
    };

    const { error } = await saveWaitlistPayload(adminClient, insertPayload);

    if (!error) {
      await saveWaitlistFallbackContact(adminClient, {
        name,
        email,
        automationType,
        experience,
      });

      return jsonResponse({
        ok: true,
        message: "You're on the waitlist.",
        waitlist: {
          name,
          email,
          automation_categories: automationCategories,
          build_stack: buildStack,
          build_stack_other: buildStackOther,
          status: "new",
        },
      });
    }

    if (!hasStructuredColumnError(error)) {
      const { error: fallbackError } = await saveWaitlistFallbackContact(adminClient, {
        name,
        email,
        automationType,
        experience,
      });

      if (fallbackError) {
        return errorResponse(error.message || fallbackError.message || "Could not join the waitlist.", 500);
      }

      return jsonResponse({
        ok: true,
        message: "You're on the waitlist.",
        waitlist: {
          name,
          email,
          status: "new",
          source: "contact_messages",
        },
        warning: "Saved as a developer waitlist contact fallback.",
      });
    }

    const legacyPayload = {
      name,
      email,
      automation_type: automationType,
      experience,
      status: "new",
    };

    const { error: legacyError } = await saveWaitlistPayload(adminClient, legacyPayload);

    if (legacyError) {
      const { error: fallbackError } = await saveWaitlistFallbackContact(adminClient, {
        name,
        email,
        automationType,
        experience,
      });

      if (fallbackError) {
        return errorResponse(legacyError.message || fallbackError.message || "Could not join the waitlist.", 500);
      }

      return jsonResponse({
        ok: true,
        message: "You're on the waitlist.",
        waitlist: {
          name,
          email,
          status: "new",
          source: "contact_messages",
        },
        warning: "Saved as a developer waitlist contact fallback.",
      });
    }

    await saveWaitlistFallbackContact(adminClient, {
      name,
      email,
      automationType,
      experience,
    });

    return jsonResponse({
      ok: true,
      message: "You're on the waitlist.",
      waitlist: {
        name,
        email,
        status: "new",
      },
      warning: "Structured waitlist columns are not available yet.",
    });
  } catch (error) {
    console.error("submit-developer-waitlist failed:", error);

    return errorResponse(
      error instanceof Error ? error.message : "Could not join the waitlist.",
      500,
    );
  }
});
