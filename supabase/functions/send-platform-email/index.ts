import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";
import { buildEmailTemplate, safeEnqueueEmail } from "../_shared/nexus-email.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const EMAIL_PROVIDER = (Deno.env.get("EMAIL_PROVIDER") || "resend").toLowerCase();
const EMAIL_FROM_EMAIL = Deno.env.get("EMAIL_FROM_EMAIL") || "support@nexus-ai.software";
const EMAIL_FROM_NAME = Deno.env.get("EMAIL_FROM_NAME") || "Nexus";
const EMAIL_REPLY_TO = Deno.env.get("EMAIL_REPLY_TO") || EMAIL_FROM_EMAIL;
const EMAIL_CRON_SECRET = Deno.env.get("EMAIL_CRON_SECRET") || Deno.env.get("NEXUS_RUNTIME_SECRET") || "";

function cleanString(value: unknown, maxLength = 4000) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function nowIso() {
  return new Date().toISOString();
}

function fromAddressForResend() {
  return `${EMAIL_FROM_NAME} <${EMAIL_FROM_EMAIL}>`;
}

function providerMissingError() {
  if (EMAIL_PROVIDER === "resend" && !Deno.env.get("RESEND_API_KEY")) {
    return "RESEND_API_KEY is not set.";
  }

  if (EMAIL_PROVIDER === "postmark" && !Deno.env.get("POSTMARK_SERVER_TOKEN")) {
    return "POSTMARK_SERVER_TOKEN is not set.";
  }

  if (EMAIL_PROVIDER === "brevo" && !Deno.env.get("BREVO_API_KEY")) {
    return "BREVO_API_KEY is not set.";
  }

  if (EMAIL_PROVIDER === "mailersend" && !Deno.env.get("MAILERSEND_API_KEY")) {
    return "MAILERSEND_API_KEY is not set.";
  }

  return "";
}

function providerErrorMessage(provider: string, response: Response, data: unknown) {
  const payload = typeof data === "object" && data !== null ? data as Record<string, unknown> : {};
  const message = cleanString(payload.message || payload.error || payload.name || response.statusText, 1000);
  const body = cleanString(JSON.stringify(data || {}), 2000);
  return `${provider} failed with ${response.status}: ${message}${body && body !== "{}" ? ` ${body}` : ""}`;
}

async function requireAdminOrSecret(req: Request, adminClient: any) {
  const workerToken = req.headers.get("x-nexus-email-worker") || "";
  const secret = req.headers.get("x-nexus-email-secret") || req.headers.get("x-nexus-runtime-secret") || "";

  if (workerToken) {
    const { data: authorized, error } = await adminClient.rpc("authorize_email_queue_worker", {
      p_token: workerToken,
    });
    if (!error && authorized === true) {
      return { ok: true, user: null, error: "" };
    }
  }

  if (EMAIL_CRON_SECRET && secret && secret === EMAIL_CRON_SECRET) {
    return { ok: true, user: null, error: "" };
  }

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ") || !SUPABASE_ANON_KEY) {
    return { ok: false, user: null, error: "Admin login or email cron secret required." };
  }

  const token = authHeader.replace("Bearer ", "").trim();
  if (!token || token === SUPABASE_ANON_KEY) {
    return { ok: false, user: null, error: "Admin login required." };
  }

  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data, error } = await userClient.auth.getUser(token);
  if (error || !data?.user) {
    return { ok: false, user: null, error: "Invalid admin session." };
  }

  const { data: profile } = await adminClient
    .from("profiles")
    .select("role")
    .eq("id", data.user.id)
    .maybeSingle();

  if (profile?.role !== "admin") {
    return { ok: false, user: data.user, error: "Admin access required." };
  }

  return { ok: true, user: data.user, error: "" };
}

async function sendWithResend(row: any) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${Deno.env.get("RESEND_API_KEY") || ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddressForResend(),
      to: [row.recipient_email],
      reply_to: EMAIL_REPLY_TO,
      subject: row.subject,
      html: row.html_body,
      text: row.text_body,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(providerErrorMessage("Resend", response, data));
  }

  return data?.id || data?.data?.id || "";
}

async function sendWithPostmark(row: any) {
  const response = await fetch("https://api.postmarkapp.com/email", {
    method: "POST",
    headers: {
      "X-Postmark-Server-Token": Deno.env.get("POSTMARK_SERVER_TOKEN") || "",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      From: fromAddressForResend(),
      To: row.recipient_email,
      ReplyTo: EMAIL_REPLY_TO,
      Subject: row.subject,
      HtmlBody: row.html_body,
      TextBody: row.text_body,
      MessageStream: Deno.env.get("POSTMARK_MESSAGE_STREAM") || "outbound",
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ErrorCode) {
    throw new Error(providerErrorMessage("Postmark", response, data));
  }

  return data?.MessageID || "";
}

async function sendWithBrevo(row: any) {
  const response = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": Deno.env.get("BREVO_API_KEY") || "",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sender: { email: EMAIL_FROM_EMAIL, name: EMAIL_FROM_NAME },
      to: [{ email: row.recipient_email, name: row.recipient_name || undefined }],
      replyTo: { email: EMAIL_REPLY_TO, name: EMAIL_FROM_NAME },
      subject: row.subject,
      htmlContent: row.html_body,
      textContent: row.text_body,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(providerErrorMessage("Brevo", response, data));
  }

  return data?.messageId || data?.messageIds?.[0] || "";
}

async function sendWithMailerSend(row: any) {
  const response = await fetch("https://api.mailersend.com/v1/email", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${Deno.env.get("MAILERSEND_API_KEY") || ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: { email: EMAIL_FROM_EMAIL, name: EMAIL_FROM_NAME },
      to: [{ email: row.recipient_email, name: row.recipient_name || undefined }],
      reply_to: { email: EMAIL_REPLY_TO, name: EMAIL_FROM_NAME },
      subject: row.subject,
      html: row.html_body,
      text: row.text_body,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(providerErrorMessage("MailerSend", response, data));
  }

  return response.headers.get("x-message-id") || data?.message_id || "";
}

async function deliverEmail(row: any) {
  const missing = providerMissingError();
  if (missing) throw new Error(missing);

  if (EMAIL_PROVIDER === "postmark") return await sendWithPostmark(row);
  if (EMAIL_PROVIDER === "brevo") return await sendWithBrevo(row);
  if (EMAIL_PROVIDER === "mailersend") return await sendWithMailerSend(row);
  return await sendWithResend(row);
}

function recommendationPriceDisplay(value: unknown, pricingType: unknown) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount <= 0) return "View pricing";
  const formatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: amount % 1 ? 2 : 0,
    maximumFractionDigits: 2,
  }).format(amount);
  const type = cleanString(pricingType, 80).toLowerCase();
  if (type === "monthly" || type === "subscription") return `${formatted}/month`;
  if (type === "one_time" || type === "one-time") return `${formatted} one-time`;
  return formatted;
}

async function loadBestSellingRecommendation(adminClient: any) {
  try {
    const [automationsResult, bundlesResult, ordersResult] = await Promise.all([
      adminClient
        .from("automations")
        .select("id,title,slug,short_description,best_for,price_usd,pricing_type,sales_count")
        .eq("status", "live"),
      adminClient
        .from("automation_bundles")
        .select("id,title,slug,short_description,outcome,price_usd,pricing_type")
        .eq("status", "active"),
      adminClient
        .from("orders")
        .select("automation_id,bundle_id,parent_order_id")
        .eq("payment_status", "paid")
        .limit(5000),
    ]);

    if (automationsResult.error || bundlesResult.error || ordersResult.error) {
      console.warn("Could not load onboarding bestseller:", automationsResult.error || bundlesResult.error || ordersResult.error);
      return {};
    }

    const sales = new Map<string, number>();
    for (const order of ordersResult.data || []) {
      let key = "";
      if (order.bundle_id && !order.parent_order_id) key = `bundle:${order.bundle_id}`;
      else if (order.automation_id && !order.bundle_id) key = `automation:${order.automation_id}`;
      if (key) sales.set(key, (sales.get(key) || 0) + 1);
    }

    const candidates = [
      ...(automationsResult.data || []).map((item: any) => ({
        ...item,
        kind: "automation",
        best_for: item.best_for || "",
        paid_sales: sales.get(`automation:${item.id}`) || 0,
      })),
      ...(bundlesResult.data || []).map((item: any) => ({
        ...item,
        kind: "bundle",
        best_for: item.outcome || "",
        paid_sales: sales.get(`bundle:${item.id}`) || 0,
      })),
    ].filter((item) => item.slug);

    candidates.sort((left, right) => {
      const paidDifference = Number(right.paid_sales || 0) - Number(left.paid_sales || 0);
      if (paidDifference) return paidDifference;
      const recordedDifference = Number(right.sales_count || 0) - Number(left.sales_count || 0);
      if (recordedDifference) return recordedDifference;
      return String(left.title || "").localeCompare(String(right.title || ""));
    });

    const top = candidates[0];
    if (!top) return {};
    const parameter = top.kind === "bundle" ? "bundle" : "product";

    return {
      recommended_title: cleanString(top.title, 240),
      recommended_description: cleanString(top.short_description, 800),
      recommended_best_for: cleanString(top.best_for, 500),
      recommended_price_display: recommendationPriceDisplay(top.price_usd, top.pricing_type),
      recommended_href: `/pages/marketplace?${parameter}=${encodeURIComponent(cleanString(top.slug, 240))}`,
      recommended_kind: top.kind,
      recommended_product_id: cleanString(top.id, 80),
      recommended_paid_sales: Number(top.paid_sales || 0),
    };
  } catch (error) {
    console.warn("Could not prepare onboarding bestseller:", error);
    return {};
  }
}

async function refreshOnboardingEmail(adminClient: any, row: any) {
  if (!["buyer_welcome", "buyer_choose_first"].includes(cleanString(row.email_type, 120))) return row;

  const recommendation = row.email_type === "buyer_choose_first"
    ? await loadBestSellingRecommendation(adminClient)
    : {};
  const context = {
    ...(row.metadata && typeof row.metadata === "object" ? row.metadata : {}),
    name: row.recipient_name || "",
    ...recommendation,
  };
  const template = buildEmailTemplate(row.email_type, context);
  const prepared = {
    ...row,
    subject: template.subject,
    html_body: template.html,
    text_body: template.text,
    metadata: { ...(row.metadata || {}), ...recommendation },
  };

  const { error } = await adminClient
    .from("email_queue")
    .update({
      subject: prepared.subject,
      html_body: prepared.html_body,
      text_body: prepared.text_body,
      metadata: prepared.metadata,
      updated_at: nowIso(),
    })
    .eq("id", row.id)
    .eq("status", "sending");
  if (error) console.warn("Could not persist refreshed onboarding email:", error);

  return prepared;
}
async function sendQueuedEmail(adminClient: any, row: any) {
  const { data: locked, error: lockError } = await adminClient
    .from("email_queue")
    .update({
      status: "sending",
      sending_started_at: nowIso(),
      attempt_count: Number(row.attempt_count || 0) + 1,
      updated_at: nowIso(),
    })
    .eq("id", row.id)
    .eq("status", "pending")
    .select()
    .maybeSingle();

  if (lockError) throw new Error(lockError.message);
  if (!locked) return { id: row.id, status: "skipped", reason: "already_locked" };

  try {
    const prepared = await refreshOnboardingEmail(adminClient, locked);
    const providerMessageId = await deliverEmail(prepared);

    await adminClient
      .from("email_queue")
      .update({
        status: "sent",
        subject: prepared.subject,
        html_body: prepared.html_body,
        text_body: prepared.text_body,
        metadata: prepared.metadata,
        provider: EMAIL_PROVIDER,
        provider_message_id: providerMessageId,
        sent_at: nowIso(),
        last_error: null,
        updated_at: nowIso(),
      })
      .eq("id", row.id);

    return { id: row.id, status: "sent", provider_message_id: providerMessageId };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Email delivery failed.";
    const attempts = Number(locked.attempt_count || 1);
    const finalStatus = attempts >= 5 ? "failed" : "pending";
    const nextDelayMinutes = Math.min(60, Math.max(5, attempts * 10));

    await adminClient
      .from("email_queue")
      .update({
        status: finalStatus,
        failed_at: finalStatus === "failed" ? nowIso() : null,
        last_error: errorMessage,
        scheduled_for: finalStatus === "pending"
          ? new Date(Date.now() + nextDelayMinutes * 60 * 1000).toISOString()
          : locked.scheduled_for,
        updated_at: nowIso(),
      })
      .eq("id", row.id);

    return { id: row.id, status: finalStatus, error: errorMessage };
  }
}

async function sendDue(adminClient: any, limit: number) {
  const staleSendingCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { error: recoveryError } = await adminClient
    .from("email_queue")
    .update({
      status: "pending",
      sending_started_at: null,
      scheduled_for: nowIso(),
      last_error: "Recovered after an interrupted email worker attempt.",
      updated_at: nowIso(),
    })
    .eq("status", "sending")
    .lt("sending_started_at", staleSendingCutoff);
  if (recoveryError) throw new Error(recoveryError.message);

  const { data, error } = await adminClient
    .from("email_queue")
    .select("*")
    .eq("status", "pending")
    .lte("scheduled_for", nowIso())
    .order("scheduled_for", { ascending: true })
    .limit(Math.min(Math.max(limit || 25, 1), 100));

  if (error) throw new Error(error.message);

  const results = [];
  for (const row of data || []) {
    results.push(await sendQueuedEmail(adminClient, row));
  }

  return results;
}

async function sendOne(adminClient: any, id: string) {
  const { data, error } = await adminClient
    .from("email_queue")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw new Error("Email not found.");
  if (data.status === "sent") return { id, status: "sent", reason: "already_sent" };
  if (data.status !== "pending") {
    const { data: reset, error: resetError } = await adminClient
      .from("email_queue")
      .update({
        status: "pending",
        last_error: null,
        failed_at: null,
        scheduled_for: nowIso(),
        updated_at: nowIso(),
      })
      .eq("id", id)
      .select()
      .maybeSingle();

    if (resetError) throw new Error(resetError.message);
    data.status = reset?.status || "pending";
  }

  return await sendQueuedEmail(adminClient, {
    ...data,
    status: "pending",
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
      message: "send-platform-email is alive.",
      provider: EMAIL_PROVIDER,
      from: EMAIL_FROM_EMAIL,
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed.", 405);
  }

  try {
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const auth = await requireAdminOrSecret(req, adminClient);
    if (!auth.ok) return errorResponse(auth.error, 401);

    const body = await req.json().catch(() => ({}));
    const action = cleanString(body.action || "send_due", 80);

    if (action === "send_due") {
      const results = await sendDue(adminClient, Number(body.limit || 25));
      const sentCount = results.filter((item) => item.status === "sent").length;
      const failedCount = results.filter((item) => item.status === "failed" || item.status === "pending").length;
      const { error: workerStateError } = await adminClient
        .from("email_queue_worker_states")
        .upsert({
          singleton: true,
          last_checked_at: nowIso(),
          last_sent_count: sentCount,
          last_failed_count: failedCount,
          last_error: failedCount ? "One or more due emails could not be delivered." : null,
          updated_at: nowIso(),
        }, { onConflict: "singleton" });
      if (workerStateError) throw new Error(workerStateError.message);
      return jsonResponse({ ok: true, results, count: results.length });
    }

    if (action === "send_one") {
      const result = await sendOne(adminClient, cleanString(body.id, 80));
      return jsonResponse({ ok: true, result });
    }

    if (action === "test") {
      const recipient = cleanString(body.email || body.recipient_email, 240);
      const template = buildEmailTemplate("default", {
        subject: "Nexus email test",
        title: "Nexus email test",
        message: "This confirms the Nexus transactional email flow can queue and send through your configured provider.",
        cta_label: "Open Nexus",
        cta_href: "/",
      });

      const queued = await safeEnqueueEmail(
        adminClient,
        "default",
        { email: recipient, name: cleanString(body.name, 120) || "Nexus test" },
        {
          subject: template.subject,
          title: "Nexus email test",
          message: "This confirms the Nexus transactional email flow can queue and send through your configured provider.",
          cta_label: "Open Nexus",
          cta_href: "/",
        },
        {
          dedupeKey: `email_test:${recipient}:${crypto.randomUUID()}`,
        },
      );

      if (queued.error || !queued.data?.id) {
        return errorResponse("Could not queue test email.", 500, { details: queued });
      }

      const result = await sendOne(adminClient, queued.data.id);
      return jsonResponse({ ok: true, result });
    }

    return errorResponse("Unknown email action.", 400);
  } catch (error) {
    console.error("send-platform-email failed:", error);
    return errorResponse(error instanceof Error ? error.message : "Could not process emails.", 500);
  }
});
