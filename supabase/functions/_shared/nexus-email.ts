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

function eyebrow(value: unknown) {
  const text = cleanString(value, 160);
  return text
    ? `<div style="margin:0 0 12px;color:#1377ff;font-size:12px;line-height:1.3;font-weight:900;letter-spacing:.12em;text-transform:uppercase;">${escapeHtml(text)}</div>`
    : "";
}

function inlineLink(label: unknown, href: string) {
  const text = cleanString(label, 240);
  if (!text || !href) return "";
  return `<a href="${escapeHtml(absoluteUrl(href))}" style="color:#0b5dd7;font-weight:800;text-decoration:underline;text-decoration-color:#a9cfff;text-underline-offset:3px;">${escapeHtml(text)}</a>`;
}

function journeySteps() {
  const steps = [
    ["1", "Choose an outcome", "Start with the report, alert, insight, or workflow your team needs."],
    ["2", "Complete guided setup", "Add only the business details and credentials required for that product."],
    ["3", "Receive the finished result", "Track progress and open every delivered output from your buyer dashboard."],
  ];

  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:24px 0;border-collapse:separate;border-spacing:0 10px;">
      ${steps.map(([number, title, copy]) => `
        <tr>
          <td width="46" valign="top" style="padding:0 12px 0 0;">
            <div style="width:36px;height:36px;border-radius:12px;background:#eaf3ff;color:#0b5dd7;font-size:15px;line-height:36px;font-weight:900;text-align:center;">${number}</div>
          </td>
          <td style="padding:0 0 13px;border-bottom:1px solid #edf3fb;">
            <div style="margin:0 0 3px;color:#071d3a;font-size:15px;font-weight:900;">${title}</div>
            <div style="color:#61748f;font-size:14px;line-height:1.55;">${copy}</div>
          </td>
        </tr>
      `).join("")}
    </table>
  `;
}

function recommendationCard(context: Record<string, unknown>) {
  const title = cleanString(context.recommended_title || "A popular Nexus automation", 240);
  const description = cleanString(
    context.recommended_description || "A practical starting point for turning recurring business work into a clear, delivered result.",
    800,
  );
  const bestFor = cleanString(context.recommended_best_for, 500);
  const price = cleanString(context.recommended_price_display, 120);
  const href = cleanString(context.recommended_href || "/pages/marketplace/index.html", 800);

  return `
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:22px 0 18px;background:#f6faff;border:1px solid #cfe3ff;border-radius:18px;overflow:hidden;">
      <tr>
        <td style="padding:22px;">
          <div style="display:inline-block;margin:0 0 12px;padding:6px 10px;border-radius:999px;background:#dcecff;color:#0b5dd7;font-size:11px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;">Most purchased on Nexus</div>
          <div style="margin:0 0 8px;color:#071d3a;font-size:21px;line-height:1.25;font-weight:900;">${escapeHtml(title)}</div>
          <div style="margin:0 0 14px;color:#526985;font-size:14px;line-height:1.65;">${escapeHtml(description)}</div>
          ${bestFor ? `<div style="margin:0 0 12px;padding:12px 14px;background:#ffffff;border-radius:12px;color:#526985;font-size:13px;line-height:1.55;"><strong style="color:#173b68;">Best for:</strong> ${escapeHtml(bestFor)}</div>` : ""}
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
            <tr>
              <td style="color:#173b68;font-size:14px;font-weight:800;">${price ? escapeHtml(price) : "View product details"}</td>
              <td align="right" style="font-size:14px;">${inlineLink("View product", href)}</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  `;
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
      <p style="margin:30px 0 4px;">
        <a href="${escapeHtml(ctaHref)}" style="display:inline-block;background:#1377ff;color:#ffffff;text-decoration:none;font-size:15px;line-height:1;font-weight:900;padding:16px 22px;border-radius:13px;box-shadow:0 8px 20px rgba(19,119,255,.22);">
          ${escapeHtml(input.ctaLabel)} &rarr;
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
  <body style="margin:0;background:#eef4fc;color:#071d3a;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
    <span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;">
      ${escapeHtml(input.preheader || input.title)}
    </span>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eef4fc;padding:34px 14px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:640px;background:#ffffff;border:1px solid #d8e6f7;border-radius:24px;overflow:hidden;box-shadow:0 18px 48px rgba(27,61,104,.10);">
            <tr>
              <td style="padding:24px 28px;background:#071d3a;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td width="52" valign="middle">
                      <div style="width:42px;height:42px;border-radius:13px;background:#1377ff;color:#ffffff;font-size:19px;line-height:42px;font-weight:900;text-align:center;">N</div>
                    </td>
                    <td valign="middle">
                      <div style="font-size:23px;line-height:1.1;font-weight:900;color:#ffffff;letter-spacing:-.02em;">Nexus</div>
                      <div style="margin-top:4px;font-size:11px;line-height:1.3;font-weight:700;color:#9fb6d5;letter-spacing:.08em;text-transform:uppercase;">Business automation marketplace</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:34px 30px 32px;">
                <h1 style="margin:0 0 18px;font-size:30px;line-height:1.16;letter-spacing:-.025em;color:#071d3a;">${title}</h1>
                <div style="font-size:16px;line-height:1.7;color:#4c617d;">
                  ${input.body}
                </div>
                ${cta}
              </td>
            </tr>
            <tr>
              <td style="padding:22px 30px;background:#f7faff;border-top:1px solid #e4edf8;font-size:13px;line-height:1.65;color:#6a7b94;">
                <strong style="color:#173b68;">Need a hand?</strong> Reply to this email and the Nexus team will help.<br>
                <a href="${escapeHtml(absoluteUrl("/"))}" style="color:#0b5dd7;text-decoration:none;font-weight:800;">nexus-ai.software</a>
                &nbsp;&middot;&nbsp; Your orders, setup progress, messages, and outputs stay in your buyer dashboard.
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
  const outputTitle = cleanString(context.output_title, 240);
  const outputUrl = cleanString(context.output_url || dashboardUrl, 500);
  const orderUrl = cleanString(context.order_url || dashboardUrl, 500);
  const adminNotes = cleanString(context.admin_notes, 1000);
  const refundDisplay = cleanString(context.refund_display || "your latest monthly payment", 120);
  const refundStatus = cleanString(context.refund_status || "submitted", 80);
  const monitorSummary = cleanString(context.monitor_summary || "A monitored Nexus service needs attention.", 1200);
  const monitorDetails = cleanString(context.monitor_details, 4000)
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
  const checkedAt = cleanString(context.checked_at, 120);

  switch (type) {
    case "buyer_welcome":
      return makeTemplate(
        "Welcome to Nexus - let's automate the busywork",
        `${name ? `${name}, your` : "Your"} automation workspace is ready.`,
        [
          eyebrow("Welcome to Nexus"),
          paragraph("Nexus turns repetitive business work into finished reports, alerts, insights, and workflows without asking you to build the automation yourself."),
          journeySteps(),
          `<div style="margin:20px 0 0;padding:16px 18px;background:#f6faff;border-left:4px solid #1377ff;border-radius:0 12px 12px 0;color:#405b7c;font-size:14px;line-height:1.6;"><strong style="color:#173b68;">Everything stays organized.</strong> Purchases, setup progress, delivered outputs, and support are available from your Nexus dashboard.</div>`,
        ].join(""),
        "Explore Nexus automations",
        "/pages/marketplace/index.html",
      );

    case "buyer_choose_first": {
      const recommendationHref = cleanString(context.recommended_href || "/pages/marketplace/index.html", 800);
      return makeTemplate(
        "A strong first automation: the Nexus bestseller",
        "Start with a proven business outcome.",
        [
          eyebrow("Recommended first pick"),
          paragraph("Not sure where to begin? We looked at what Nexus customers purchase most often and highlighted the current bestseller below."),
          recommendationCard(context),
          paragraph("It is a strong starting point when you want visible value quickly: complete the setup once, then receive clear outputs through your Nexus dashboard."),
          `<div style="margin-top:18px;color:#61748f;font-size:14px;line-height:1.6;">Need something different? ${inlineLink("Browse every automation", "/pages/marketplace/index.html")} or ${inlineLink("request a custom workflow", "/pages/custom-request/index.html")}.</div>`,
        ].join(""),
        "View the Nexus bestseller",
        recommendationHref,
      );
    }
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

    case "automation_output_ready":
      return makeTemplate(
        `Your ${productTitle} output is ready`,
        `${name ? `${name}, your` : "Your"} result is ready.`,
        [
          eyebrow("Output ready"),
          paragraph(`${productTitle} has finished processing and your result is available in Nexus.`),
          outputTitle ? bullets([`Result: ${outputTitle}`]) : "",
          bundleTitle && bundleTitle !== productTitle
            ? paragraph(`This result is part of ${bundleTitle}.`)
            : "",
          paragraph("Open the finished output using the button below. It will also remain available in your buyer dashboard."),
        ].join(""),
        "View your result",
        outputUrl,
      );

    case "subscription_cancellation_approved":
      return makeTemplate(
        `Subscription cancelled: ${productTitle}`,
        "Your subscription was cancelled and refunded.",
        [
          paragraph(`A Nexus admin approved your cancellation for ${productTitle}. Stripe will not charge this subscription again.`),
          bullets([
            `Refund: ${refundDisplay}`,
            `Stripe refund status: ${refundStatus}`,
            "All outputs delivered before cancellation remain available in your buyer dashboard.",
          ]),
          paragraph("Your bank may take several business days to display a completed Stripe refund."),
        ].join(""),
        "View saved outputs",
        dashboardUrl,
      );

    case "subscription_cancellation_rejected":
      return makeTemplate(
        `Cancellation update: ${productTitle}`,
        "Your subscription remains active.",
        [
          paragraph(`Nexus reviewed the cancellation request for ${productTitle} and did not approve it.`),
          adminNotes ? paragraph(`Admin note: ${adminNotes}`) : "",
          paragraph("Contact Nexus support if you believe this decision needs another review."),
        ].join(""),
        "Open buyer dashboard",
        dashboardUrl,
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

    case "system_outage_alert":
      return makeTemplate(
        "Action needed: Nexus production outage detected",
        "Nexus production needs attention.",
        [
          paragraph(monitorSummary),
          bullets(monitorDetails),
          paragraph(`The monitor confirmed this across ${2} consecutive checks before alerting.${checkedAt ? ` Last checked: ${checkedAt}.` : ""}`),
        ].join(""),
        "Open system health",
        dashboardUrl,
      );

    case "system_outage_recovered":
      return makeTemplate(
        "Nexus production services recovered",
        "Monitored services are healthy again.",
        [
          paragraph(monitorSummary),
          bullets(monitorDetails),
          checkedAt ? paragraph(`Recovered check: ${checkedAt}.`) : "",
        ].join(""),
        "Open system health",
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

export async function safeEnqueueOutputReadyEmail(
  adminClient: any,
  input: {
    outputId?: string | null;
    buyerId?: string | null;
    orderId?: string | null;
    automationId?: string | null;
    customerAutomationId?: string | null;
    productTitle?: string | null;
    bundleTitle?: string | null;
    outputTitle?: string | null;
  },
) {
  try {
    const outputId = cleanString(input.outputId, 120);
    if (!outputId) {
      return { data: null, error: null, skipped: true, reason: "missing_output_id" };
    }

    const orderId = cleanString(input.orderId, 120);
    const buyerId = cleanString(input.buyerId, 120);
    let order: Record<string, any> = {};

    if (orderId) {
      const { data, error } = await adminClient
        .from("orders")
        .select("*")
        .eq("id", orderId)
        .maybeSingle();

      if (error) console.warn("Could not load output email order:", error.message);
      if (data) order = data;
    }

    let recipientEmail = cleanString(order.buyer_email, 240).toLowerCase();
    let recipientName = cleanString(order.buyer_name, 180);

    if (!recipientEmail && buyerId) {
      const { data } = await adminClient.auth.admin.getUserById(buyerId);
      const buyer = data?.user;
      recipientEmail = cleanString(buyer?.email, 240).toLowerCase();
      recipientName = recipientName || cleanString(
        buyer?.user_metadata?.full_name || buyer?.user_metadata?.name,
        180,
      );
    }

    const productTitle = cleanString(
      input.productTitle || order.automation_title || "your automation",
      240,
    );
    const orderIsBundle = cleanString(order.order_type, 40).toLowerCase() === "bundle";
    const bundleTitle = cleanString(
      input.bundleTitle || (orderIsBundle ? order.automation_title : ""),
      240,
    );
    const outputUrl = `/pages/buyer/output.html?id=${encodeURIComponent(outputId)}`;

    return await safeEnqueueEmail(
      adminClient,
      "automation_output_ready",
      { email: recipientEmail, name: recipientName },
      {
        buyer_id: buyerId,
        order_id: orderId,
        automation_id: cleanString(input.automationId, 120),
        customer_automation_id: cleanString(input.customerAutomationId, 120),
        output_id: outputId,
        product_title: productTitle,
        bundle_title: bundleTitle,
        output_title: cleanString(input.outputTitle, 240),
        output_url: outputUrl,
        dashboard_url: "/pages/buyer/dashboard.html#outputs",
      },
      { dedupeKey: `automation_output_ready:${outputId}` },
    );
  } catch (error) {
    console.warn("Output-ready email queue failed:", error);
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
