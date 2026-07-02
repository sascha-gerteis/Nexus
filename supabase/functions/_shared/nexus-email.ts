export type EmailRecipient = {
  email?: string | null;
  name?: string | null;
};

export type EmailEnqueueOptions = {
  dedupeKey?: string;
  scheduledFor?: string;
  delayMinutes?: number;
  metadata?: Record<string, unknown>;
};

type TemplateResult = {
  subject: string;
  html: string;
  text: string;
};

function cleanString(value: unknown, maxLength = 4000) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function siteUrl() {
  return cleanString(
    Deno.env.get("NEXUS_SITE_URL") ||
      Deno.env.get("SITE_URL") ||
      "https://nexus-ai.software",
    240,
  ).replace(/\/+$/, "");
}

function absoluteUrl(path = "/") {
  if (/^https?:\/\//i.test(path)) return path;
  return `${siteUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

function escapeHtml(value: unknown) {
  return cleanString(value, 20000)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function textFromHtml(html: string) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function paragraph(value: unknown) {
  const text = cleanString(value, 4000);
  return text ? `<p>${escapeHtml(text)}</p>` : "";
}

function bullets(items: unknown[]) {
  const cleanItems = items.map((item) => cleanString(item, 400)).filter(Boolean);
  if (!cleanItems.length) return "";

  return `<ul>${cleanItems.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function emailLayout(input: {
  preheader?: string;
  title: string;
  body: string;
  ctaLabel?: string;
  ctaHref?: string;
}) {
  const title = escapeHtml(input.title);
  const ctaHref = cleanString(input.ctaHref, 1000);
  const cta = ctaHref && input.ctaLabel
    ? `
      <p style="margin:28px 0 0;">
        <a href="${escapeHtml(ctaHref)}" style="display:inline-block;background:#1377ff;color:#ffffff;text-decoration:none;font-weight:800;padding:14px 20px;border-radius:14px;">
          ${escapeHtml(input.ctaLabel)}
        </a>
      </p>
    `
    : "";

  return `
<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
  </head>
  <body style="margin:0;background:#f4f8ff;color:#071d3a;font-family:Inter,Arial,sans-serif;">
    <span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">
      ${escapeHtml(input.preheader || input.title)}
    </span>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f8ff;padding:28px 14px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #dcecff;border-radius:22px;overflow:hidden;">
            <tr>
              <td style="padding:26px 28px 18px;border-bottom:1px solid #e7f0ff;">
                <div style="font-size:26px;font-weight:900;color:#0b4fc5;letter-spacing:-.02em;">Nexus</div>
              </td>
            </tr>
            <tr>
              <td style="padding:30px 28px;">
                <h1 style="margin:0 0 16px;font-size:28px;line-height:1.15;color:#071d3a;">${title}</h1>
                <div style="font-size:16px;line-height:1.65;color:#4c617d;">
                  ${input.body}
                </div>
                ${cta}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 28px;background:#f8fbff;border-top:1px solid #e7f0ff;font-size:13px;line-height:1.5;color:#6a7b94;">
                Nexus sends transactional emails about your account, orders, setup, messages, and marketplace activity.
                Reply to this email to reach the Nexus team.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
  `.trim();
}

function makeTemplate(subject: string, title: string, body: string, ctaLabel?: string, ctaHref?: string): TemplateResult {
  const html = emailLayout({
    preheader: subject,
    title,
    body,
    ctaLabel,
    ctaHref: ctaHref ? absoluteUrl(ctaHref) : "",
  });

  return {
    subject,
    html,
    text: textFromHtml(html),
  };
}

export function buildEmailTemplate(type: string, context: Record<string, unknown> = {}): TemplateResult {
  const name = cleanString(context.name || context.buyer_name || context.developer_name, 160);
  const productTitle = cleanString(context.product_title || context.automation_title || "your automation", 240);
  const bundleTitle = cleanString(context.bundle_title || productTitle || "your bundle", 240);
  const messagePreview = cleanString(context.message_preview || "You have a new message in Nexus.", 500);
  const dashboardUrl = cleanString(context.dashboard_url || "/pages/buyer/dashboard.html", 500);
  const orderUrl = cleanString(context.order_url || dashboardUrl, 500);

  switch (type) {
    case "buyer_welcome":
      return makeTemplate(
        "Welcome to Nexus",
        `Welcome${name ? `, ${name}` : ""}.`,
        [
          paragraph("Nexus helps you buy practical business automations with clear output previews, connected setup, and a dashboard for orders, messages, and results."),
          bullets([
            "Browse products by the business outcome you need.",
            "Preview the output before buying.",
            "Choose self-serve setup or guided install when available.",
            "Track setup, outputs, and support from your buyer dashboard.",
          ]),
        ].join(""),
        "Open buyer dashboard",
        "/pages/buyer/dashboard.html",
      );

    case "buyer_choose_first":
      return makeTemplate(
        "Need help choosing your first automation?",
        "Find the workflow that fits your manual task.",
        [
          paragraph("If you are not sure whether you need reporting, competitor tracking, social listening, support automation, or a custom workflow, start with the recommendation flow."),
          paragraph("Tell Nexus what your team currently does manually and we will point you toward the closest product or a custom automation request."),
        ].join(""),
        "Get a workflow recommendation",
        "/pages/marketplace/index.html#workflow-recommendation",
      );

    case "buyer_output_preview":
      return makeTemplate(
        "Why Nexus shows outputs before checkout",
        "Buy the outcome, not a vague automation promise.",
        [
          paragraph("Every serious Nexus product should show a sample output structure before checkout. This helps you understand what you will receive and whether the automation fits the job."),
          paragraph("Use the preview to check if the report, alert, summary, or dashboard view is useful for your team before setup begins."),
        ].join(""),
        "Browse output previews",
        "/pages/marketplace/index.html",
      );

    case "buyer_guided_setup":
      return makeTemplate(
        "How guided setup works",
        "Choose guided install when you want Nexus to help configure the workflow.",
        [
          paragraph("Some products can be self-serve. Others offer guided install, where Nexus or the developer helps complete setup and checks the workflow before output delivery."),
          paragraph("Guided install is useful when your data sources, credentials, or process rules need extra care."),
        ].join(""),
        "View your automations",
        "/pages/buyer/dashboard.html#automations",
      );

    case "buyer_workflow_review":
      return makeTemplate(
        "Want Nexus to review a workflow for you?",
        "If the right product is not listed, request a custom automation.",
        [
          paragraph("Nexus can review a manual process and recommend whether you should buy an existing product, combine workflows, or request a custom setup."),
          paragraph("The best request includes what you do manually, which tools are involved, and what output you want each week or month."),
        ].join(""),
        "Request custom automation",
        "/pages/custom-request/index.html",
      );

    case "developer_waitlist_confirmation":
      return makeTemplate(
        "You are on the Nexus developer waitlist",
        `Thanks${name ? `, ${name}` : ""}.`,
        [
          paragraph("We received your developer application. Nexus reviews early developers manually so the marketplace stays focused on useful, tested workflows."),
          paragraph("Early developers get priority review, feedback on product packaging, and influence on the developer dashboard before wider launch."),
        ].join(""),
        "Read developer information",
        "/pages/developers/waitlist.html",
      );

    case "developer_account_pending":
      return makeTemplate(
        "Your Nexus developer account is pending review",
        "Your developer dashboard is ready, approval is next.",
        [
          paragraph("You can prepare your profile and product drafts now. Your public developer profile and products stay under review until Nexus approves your developer account."),
          paragraph("This helps us keep low-quality or incomplete workflows out of the marketplace."),
        ].join(""),
        "Open developer dashboard",
        "/pages/developer/dashboard.html",
      );

    case "contact_auto_reply":
      return makeTemplate(
        "Nexus received your message",
        "Thanks for contacting Nexus.",
        [
          paragraph("We received your message and routed it into the Nexus admin inbox."),
          paragraph("For product, setup, or custom automation questions, we usually reply within 1-2 business days."),
        ].join(""),
        "Browse marketplace",
        "/pages/marketplace/index.html",
      );

    case "order_payment_received":
      return makeTemplate(
        `Payment received for ${productTitle}`,
        "Your automation is ready for setup.",
        [
          paragraph(`We received your payment for ${productTitle}.`),
          paragraph("Open your buyer dashboard to complete setup, view outputs, send messages, and track the order."),
        ].join(""),
        "Open order dashboard",
        orderUrl,
      );

    case "bundle_payment_received":
      return makeTemplate(
        `Payment received for ${bundleTitle}`,
        "Your bundle workflows are ready for setup.",
        [
          paragraph(`We received your payment for ${bundleTitle}.`),
          paragraph("Each included workflow will appear in your buyer dashboard with its own setup and output history."),
        ].join(""),
        "Open buyer dashboard",
        orderUrl,
      );

    case "message_received":
      return makeTemplate(
        "New Nexus message",
        "You have a new message in Nexus.",
        [
          paragraph(messagePreview),
          paragraph("Open Nexus to reply in the same conversation so the order, setup, and support context stays connected."),
        ].join(""),
        "Open messages",
        dashboardUrl,
      );

    case "developer_order_received":
      return makeTemplate(
        `New Nexus order: ${productTitle}`,
        "A buyer purchased your product.",
        [
          paragraph(`A buyer purchased ${productTitle}.`),
          paragraph("Open your developer dashboard to view product activity, buyer messages, and earnings."),
        ].join(""),
        "Open developer dashboard",
        "/pages/developer/dashboard.html#wallet",
      );

    default:
      return makeTemplate(
        cleanString(context.subject || "Nexus update", 240),
        cleanString(context.title || "Nexus update", 240),
        paragraph(context.message || "You have an update from Nexus."),
        cleanString(context.cta_label, 120),
        cleanString(context.cta_href, 500),
      );
  }
}

function scheduledIso(options: EmailEnqueueOptions = {}) {
  if (options.scheduledFor) return options.scheduledFor;
  const delayMinutes = Number(options.delayMinutes || 0);
  return new Date(Date.now() + Math.max(0, delayMinutes) * 60 * 1000).toISOString();
}

function missingEmailSchema(error: unknown) {
  const typed = error as { message?: string; details?: string; hint?: string; code?: string };
  const message = [typed?.message, typed?.details, typed?.hint, typed?.code].filter(Boolean).join(" ");
  return /email_queue|email_preferences|schema cache|relation .* does not exist|could not find .* column/i.test(message);
}

export async function enqueueEmail(
  adminClient: any,
  type: string,
  recipient: EmailRecipient,
  context: Record<string, unknown> = {},
  options: EmailEnqueueOptions = {},
) {
  const email = cleanString(recipient.email, 240).toLowerCase();

  if (!email || !isValidEmail(email)) {
    return { data: null, error: null, skipped: true, reason: "invalid_recipient" };
  }

  const template = buildEmailTemplate(type, {
    ...context,
    name: context.name || recipient.name,
  });

  const dedupeKey = cleanString(options.dedupeKey, 500) ||
    `${type}:${email}:${crypto.randomUUID()}`;

  const row = {
    recipient_email: email,
    recipient_name: cleanString(recipient.name || context.name, 180),
    email_type: type,
    subject: template.subject,
    html_body: template.html,
    text_body: template.text,
    status: "pending",
    dedupe_key: dedupeKey,
    scheduled_for: scheduledIso(options),
    metadata: {
      ...context,
      ...(options.metadata || {}),
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await adminClient
    .from("email_queue")
    .insert(row)
    .select()
    .maybeSingle();

  if (!error) return { data, error: null, skipped: false };

  const code = String((error as { code?: string })?.code || "");
  const message = String((error as { message?: string })?.message || "");

  if (code === "23505" || /duplicate key/i.test(message)) {
    return { data: null, error: null, skipped: true, reason: "duplicate" };
  }

  if (missingEmailSchema(error)) {
    console.warn("Email queue schema is not installed yet:", message);
    return { data: null, error: null, skipped: true, reason: "schema_missing" };
  }

  return { data: null, error, skipped: false };
}

export async function safeEnqueueEmail(
  adminClient: any,
  type: string,
  recipient: EmailRecipient,
  context: Record<string, unknown> = {},
  options: EmailEnqueueOptions = {},
) {
  try {
    const result = await enqueueEmail(adminClient, type, recipient, context, options);
    if (result.error) {
      console.warn("Could not queue email:", type, result.error);
    }
    return result;
  } catch (error) {
    console.warn("Email queue failed:", type, error);
    return { data: null, error, skipped: true, reason: "exception" };
  }
}

export async function enqueueBuyerOnboarding(adminClient: any, buyer: {
  id?: string;
  email?: string;
  name?: string;
}) {
  const key = cleanString(buyer.id || buyer.email, 240).toLowerCase();
  if (!key || !buyer.email) return;

  const sequence = [
    { type: "buyer_welcome", delayMinutes: 0 },
    { type: "buyer_choose_first", delayMinutes: 24 * 60 },
    { type: "buyer_output_preview", delayMinutes: 3 * 24 * 60 },
    { type: "buyer_guided_setup", delayMinutes: 5 * 24 * 60 },
    { type: "buyer_workflow_review", delayMinutes: 7 * 24 * 60 },
  ];

  for (const step of sequence) {
    await safeEnqueueEmail(
      adminClient,
      step.type,
      { email: buyer.email, name: buyer.name },
      { buyer_id: buyer.id || "", name: buyer.name || "" },
      {
        delayMinutes: step.delayMinutes,
        dedupeKey: `buyer_onboarding:${key}:${step.type}`,
      },
    );
  }
}
