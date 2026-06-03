import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

function cleanString(value: unknown) {
  return String(value || "").trim();
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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
    const email = cleanString(body.email);
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