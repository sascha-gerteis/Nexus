import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import { safeEnqueueEmail } from "../_shared/nexus-email.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function cleanString(value: unknown) {
  return String(value || "").trim();
}

function comparableText(value: unknown) {
  return cleanString(value).replace(/\s+/g, " ").toLowerCase();
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function emailDedupeBucket(minutes = 15) {
  const windowMs = Math.max(1, minutes) * 60 * 1000;
  return Math.floor(Date.now() / windowMs);
}

async function findRecentDuplicateContact(
  adminClient: any,
  payload: {
    email: string;
    source: string;
    inquiryType: string;
    subject: string;
    message: string;
  },
) {
  if (!payload.email) return null;

  const since = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const { data, error } = await adminClient
    .from("contact_messages")
    .select("id,name,email,company,phone,subject,message,source,page_url,inquiry_type,status,created_at")
    .eq("email", payload.email)
    .eq("source", payload.source)
    .eq("inquiry_type", payload.inquiryType)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) {
    console.warn("Could not check duplicate contact message:", error.message);
    return null;
  }

  const subject = comparableText(payload.subject);
  const message = comparableText(payload.message);

  return (data || []).find((row: any) => {
    return comparableText(row.subject) === subject &&
      comparableText(row.message) === message;
  }) || null;
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
      message: "submit-contact-message is alive.",
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed.", 405);
  }

  try {
    const body = await req.json().catch(() => ({}));

    const name = cleanString(body.name);
    const email = cleanString(body.email).toLowerCase();
    const company = cleanString(body.company);
    const phone = cleanString(body.phone);
    const subject = cleanString(body.subject) || "Website inquiry";
    const message = cleanString(body.message);
    const source = cleanString(body.source) || "website_form";
    const pageUrl = cleanString(body.page_url);
    const inquiryType = cleanString(body.inquiry_type) || "general";

    if (!message || message.length < 5) {
      return errorResponse("Please enter a message.", 400);
    }

    if (email && !isValidEmail(email)) {
      return errorResponse("Please enter a valid email address.", 400);
    }

    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const duplicate = await findRecentDuplicateContact(adminClient, {
      email,
      source,
      inquiryType,
      subject,
      message,
    });

    if (duplicate) {
      return jsonResponse({
        ok: true,
        message: "Your message was sent successfully.",
        inquiry: duplicate,
        duplicate: true,
      });
    }

    const { data, error } = await adminClient
      .from("contact_messages")
      .insert({
        name,
        email,
        company,
        phone,
        subject,
        message,
        source,
        page_url: pageUrl,
        inquiry_type: inquiryType,
        status: "new",
        priority: "normal",
      })
      .select()
      .single();

    if (error) {
      return errorResponse(error.message, 500);
    }

    await adminClient.from("admin_notifications").insert({
      notification_type: "contact_message",
      title: "New website inquiry",
      message: `${name || email || "Someone"} submitted a contact message: ${subject}`,
      status: "unread",
      created_at: new Date().toISOString(),
    });

    if (email) {
      await safeEnqueueEmail(
        adminClient,
        "contact_auto_reply",
        { email, name },
        {
          contact_message_id: data.id,
          subject,
          inquiry_type: inquiryType,
          source,
        },
        {
          dedupeKey: `contact_auto_reply:${email.toLowerCase()}:${source}:${inquiryType}:${emailDedupeBucket(inquiryType === "custom_automation" ? 30 : 15)}`,
        },
      );
    }

    return jsonResponse({
      ok: true,
      message: "Your message was sent successfully.",
      inquiry: data,
    });
  } catch (error) {
    console.error(error);

    return errorResponse(
      error instanceof Error ? error.message : "Could not submit contact message.",
      500,
    );
  }
});
