import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders, errorResponse, jsonResponse } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") || "";
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const SQL_HINT = "Run supabase/demo_marketplace_install_or_patch.sql in the Supabase SQL editor, then redeploy the demo-marketplace Edge Function.";

function nowIso() {
  return new Date().toISOString();
}

function cleanString(value: unknown) {
  return String(value || "").trim();
}

function userFacingError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "Unknown error.");

  if (/is_demo|demo_seed_key|listing_type|review_type|reviewer_role|reviewer_company|updated_at|schema cache|could not find|column .* does not exist/i.test(message)) {
    return `${message} ${SQL_HINT}`;
  }

  return message;
}

async function requireAdmin(req: Request) {
  const authHeader = req.headers.get("Authorization") || "";

  if (!authHeader.startsWith("Bearer ")) {
    return { user: null, profile: null, adminClient: null, error: "Missing auth token." };
  }

  const token = authHeader.replace("Bearer ", "").trim();
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: {
      headers: {
        Authorization: authHeader,
      },
    },
  });

  const { data: userData, error: userError } = await userClient.auth.getUser(token);

  if (userError || !userData?.user) {
    return { user: null, profile: null, adminClient: null, error: "Invalid auth token." };
  }

  const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: profile, error: profileError } = await adminClient
    .from("profiles")
    .select("id, email, role, full_name")
    .eq("id", userData.user.id)
    .maybeSingle();

  if (profileError || !profile) {
    return { user: userData.user, profile: null, adminClient, error: "Profile not found." };
  }

  if (profile.role !== "admin") {
    return { user: userData.user, profile, adminClient, error: "Admin access required." };
  }

  return { user: userData.user, profile, adminClient, error: null };
}

const DEMO_CONTENT = [
  {
    key: "demo-dev-maya-chen",
    developer: {
      display_name: "Maya Chen",
      handle: "demo-maya-chen",
      type: "Revenue Automation Architect",
      avatar_letter: "M",
      short_description: "Builds revenue workflows that keep inbound leads from slipping between forms, inboxes, and CRM tasks.",
      bio: "Maya specializes in practical sales operations automations for small teams that need fast response times, clean handoffs, and clear next steps without hiring extra coordinators.",
      website: "https://nexus-ai.software",
      skills: ["Lead routing", "CRM automation", "Sales operations", "Follow-up systems"],
      verified: true,
      rating: 4.9,
      review_count: 12,
      banner_color: "linear-gradient(135deg,#2563eb,#06b6d4)",
    },
    product: {
      key: "demo-product-lead-response-crm-handoff",
      title: "Lead Response & CRM Handoff",
      slug: "demo-lead-response-crm-handoff",
      category: "Sales",
      badge: "Lead Ops",
      icon: "LR",
      color: "blue",
      delivery_time: "2-5 business days",
      setup_type: "Nexus guided discovery",
      best_for: "Sales teams, agencies, service businesses",
      rating: 4.9,
      review_count: 2,
      sales_count: 34,
      preview_type: "reports",
      preview_mode: "code",
      preview_title: "Lead handoff summary",
      preview_description: "Example of the clean lead package your team receives after a new inquiry.",
      preview_code: "New qualified lead\nScore: High urgency\nSource: Website form\nNext step: Book discovery call\nCRM task: Created for sales owner\nFollow-up email: Drafted and ready",
      short_description: "Capture inbound leads, score urgency, create CRM tasks, and send follow-up summaries before momentum is lost.",
      long_description: "A guided lead response automation for teams that receive inquiries from forms, email, ads, or landing pages and need a clear handoff into sales without manual copying.",
      problem: "New leads often sit in inboxes, forms, or spreadsheets before anyone responds. That delay lowers close rates and makes ownership unclear.",
      outcome: "Every lead is summarized, scored, routed, and handed to the right owner with a next-step task and follow-up context.",
      who_it_is_for: ["Small sales teams", "B2B service businesses", "Agencies handling inbound leads", "Founders managing sales themselves"],
      outputs: ["Lead summary", "Urgency score", "CRM task", "Owner assignment", "Follow-up draft"],
      required_inputs: ["Lead source", "CRM fields", "Sales owner rules", "Follow-up style", "Notification channel"],
      required_tools: ["CRM access", "Lead form or inbox", "Email account", "Slack or email notifications"],
      setup_steps: ["Map lead sources", "Define routing rules", "Connect CRM fields", "Review follow-up copy", "Test with sample leads"],
      trust_points: ["Nexus-guided setup", "No buyer workflow hosting required", "Clear audit trail", "Can be paused or adjusted anytime"],
      customizations: [
        {
          name: "High-intent lead path",
          description: "Adds fast-track routing for leads matching urgent criteria.",
          price_note: "Custom quote",
          preview_mode: "code",
          preview_code: "High-intent lead detected\nReason: Budget and timeline provided\nAction: Alert sales owner immediately",
        },
      ],
    },
    reviews: [
      {
        reviewer_name: "Olivia Hart",
        reviewer_role: "Founder",
        reviewer_company: "Brightline Studio",
        rating: 5,
        review_text: "The handoff summary made our lead response much cleaner. We finally know who owns each inquiry and what to do next.",
      },
      {
        reviewer_name: "Daniel Reed",
        reviewer_role: "Sales Manager",
        reviewer_company: "Northbay Services",
        rating: 4.8,
        review_text: "Useful demo of how inbound leads can move into CRM without another person manually checking forms all day.",
      },
    ],
  },
  {
    key: "demo-dev-arun-patel",
    developer: {
      display_name: "Arun Patel",
      handle: "demo-arun-patel",
      type: "Reporting Systems Builder",
      avatar_letter: "A",
      short_description: "Turns scattered business data into recurring reports leaders can actually read and use.",
      bio: "Arun builds reporting automations for teams that rely on spreadsheets, dashboards, and manual exports but need a monthly operating rhythm that is easier to trust.",
      website: "https://nexus-ai.software",
      skills: ["Executive reporting", "Spreadsheet automation", "KPI summaries", "Data cleanup"],
      verified: true,
      rating: 4.8,
      review_count: 9,
      banner_color: "linear-gradient(135deg,#0f766e,#22c55e)",
    },
    product: {
      key: "demo-product-monthly-kpi-digest",
      title: "Monthly KPI Digest",
      slug: "demo-monthly-kpi-digest",
      category: "Reporting",
      badge: "Executive Report",
      icon: "KP",
      color: "teal",
      delivery_time: "3-6 business days",
      setup_type: "Guided setup",
      best_for: "Operators, founders, managers",
      rating: 4.8,
      review_count: 2,
      sales_count: 27,
      preview_type: "reports",
      preview_mode: "code",
      preview_title: "Monthly KPI digest",
      preview_description: "A leadership-ready monthly summary generated from your business inputs.",
      preview_code: "Monthly KPI Digest\nRevenue: +12% month over month\nSupport tickets: -8%\nTop issue: Delayed onboarding docs\nRecommended focus: Improve first-week customer flow",
      short_description: "Turn spreadsheet and tool data into a monthly executive-ready report with trends, risks, and recommended actions.",
      long_description: "A recurring reporting automation for teams that already have useful data but spend too much time turning exports and spreadsheets into management updates.",
      problem: "Teams collect data in many places, but monthly reporting still depends on manual exports, formatting, and interpretation.",
      outcome: "A consistent monthly digest that highlights performance, risks, trends, and next actions in a format leaders can scan quickly.",
      who_it_is_for: ["Founders", "Operations leads", "Agency account managers", "Finance and reporting teams"],
      outputs: ["Executive summary", "KPI movement", "Risk notes", "Action recommendations", "Source data notes"],
      required_inputs: ["KPI list", "Data sources", "Reporting cadence", "Preferred format", "Recipient list"],
      required_tools: ["Google Sheets or Excel", "Optional analytics exports", "Email or Slack"],
      setup_steps: ["Choose KPIs", "Map source fields", "Define report sections", "Run sample report", "Approve monthly cadence"],
      trust_points: ["Readable report format", "Source assumptions documented", "Simple monthly cadence", "Designed for business owners"],
      customizations: [
        {
          name: "Board-ready version",
          description: "Adds sharper executive language and a one-page summary.",
          price_note: "Custom quote",
          preview_mode: "code",
          preview_code: "Board Summary\n- Growth remains positive\n- Churn risk is concentrated in onboarding\n- Next decision: approve onboarding cleanup sprint",
        },
      ],
    },
    reviews: [
      {
        reviewer_name: "Hannah Miles",
        reviewer_role: "Operations Lead",
        reviewer_company: "Fieldstone Co.",
        rating: 5,
        review_text: "The report format is simple and useful. It removes the blank-page problem from monthly leadership updates.",
      },
      {
        reviewer_name: "Marco Silva",
        reviewer_role: "Agency Director",
        reviewer_company: "Signal North",
        rating: 4.7,
        review_text: "A strong reporting workflow for teams that already have data but need the summary to arrive consistently.",
      },
    ],
  },
  {
    key: "demo-dev-sofia-marin",
    developer: {
      display_name: "Sofia Marin",
      handle: "demo-sofia-marin",
      type: "Support Workflow Specialist",
      avatar_letter: "S",
      short_description: "Designs support triage automations that reduce repetitive sorting and keep urgent tickets visible.",
      bio: "Sofia focuses on customer support workflows for lean teams that need faster routing, cleaner first drafts, and fewer missed escalation signals.",
      website: "https://nexus-ai.software",
      skills: ["Ticket triage", "Support routing", "Draft replies", "Escalation rules"],
      verified: true,
      rating: 4.9,
      review_count: 15,
      banner_color: "linear-gradient(135deg,#7c3aed,#ec4899)",
    },
    product: {
      key: "demo-product-support-ticket-triage-router",
      title: "Support Ticket Triage Router",
      slug: "demo-support-ticket-triage-router",
      category: "Customer Support",
      badge: "Support Triage",
      icon: "ST",
      color: "purple",
      delivery_time: "2-4 business days",
      setup_type: "Guided setup",
      best_for: "Support teams, SaaS teams, service teams",
      rating: 4.9,
      review_count: 2,
      sales_count: 41,
      preview_type: "chatbot",
      preview_mode: "code",
      preview_title: "Ticket triage output",
      preview_description: "Example of how support tickets are classified and routed.",
      preview_code: "Ticket: Customer cannot access billing page\nCategory: Billing access\nPriority: High\nSuggested owner: Support tier 2\nDraft reply: We are checking your billing access and will update you shortly.",
      short_description: "Classify tickets, draft first replies, flag urgent issues, and route work to the right owner.",
      long_description: "A support operations automation for teams handling repetitive tickets and needing faster classification, escalation, and first-response prep.",
      problem: "Support teams lose time reading every ticket from scratch, deciding urgency, and manually assigning ownership.",
      outcome: "Tickets arrive with category, priority, owner suggestion, and a first-response draft so the team can move faster.",
      who_it_is_for: ["Customer support teams", "SaaS teams", "Service businesses", "Teams with shared inboxes"],
      outputs: ["Ticket category", "Priority label", "Suggested owner", "Draft reply", "Escalation flag"],
      required_inputs: ["Support inbox or ticket export", "Categories", "Priority rules", "Team ownership rules", "Tone guidance"],
      required_tools: ["Helpdesk or shared inbox", "Email", "Optional Slack alerts"],
      setup_steps: ["Define support categories", "Map escalation rules", "Connect ticket source", "Review reply style", "Test on sample tickets"],
      trust_points: ["Human team stays in control", "Drafts are reviewable", "Urgent issues stay visible", "Built for practical support queues"],
      customizations: [
        {
          name: "Escalation monitor",
          description: "Adds alerts for billing, refund, outage, and angry-customer signals.",
          price_note: "Custom quote",
          preview_mode: "code",
          preview_code: "Escalation detected\nSignal: Refund request + negative tone\nAction: Alert support lead",
        },
      ],
    },
    reviews: [
      {
        reviewer_name: "Priya Moore",
        reviewer_role: "Support Lead",
        reviewer_company: "Cloud Harbor",
        rating: 5,
        review_text: "The triage flow is realistic and easy to understand. It shows exactly how a small support team could save time.",
      },
      {
        reviewer_name: "Ethan Brooks",
        reviewer_role: "Customer Success Manager",
        reviewer_company: "Launchstack",
        rating: 4.8,
        review_text: "The escalation logic is the best part. It makes the product feel useful for real support operations.",
      },
    ],
  },
  {
    key: "demo-dev-niran-wattanakul",
    developer: {
      display_name: "Niran Wattanakul",
      handle: "demo-niran-wattanakul",
      type: "Operations Automation Builder",
      avatar_letter: "N",
      short_description: "Builds simple operations systems for approvals, reminders, internal handoffs, and audit trails.",
      bio: "Niran helps operations teams replace scattered follow-ups with reliable workflows that show what is waiting, who owns it, and where the delay is.",
      website: "https://nexus-ai.software",
      skills: ["Approvals", "Internal operations", "Audit logs", "Reminder workflows"],
      verified: true,
      rating: 4.7,
      review_count: 8,
      banner_color: "linear-gradient(135deg,#ea580c,#f59e0b)",
    },
    product: {
      key: "demo-product-invoice-approval-tracker",
      title: "Invoice Approval Tracker",
      slug: "demo-invoice-approval-tracker",
      category: "Operations",
      badge: "Approval Flow",
      icon: "IA",
      color: "orange",
      delivery_time: "3-5 business days",
      setup_type: "Guided setup",
      best_for: "Operations, finance, admin teams",
      rating: 4.7,
      review_count: 2,
      sales_count: 19,
      preview_type: "reports",
      preview_mode: "code",
      preview_title: "Approval tracker update",
      preview_description: "Example of invoice approvals, delays, and reminders.",
      preview_code: "Invoice Approval Tracker\nPending: 6 invoices\nOverdue: 2 approvals\nNext reminder: Sent to department owner\nAudit note: Finance approval pending since Tuesday",
      short_description: "Track invoice approvals, send reminders, escalate delays, and keep a clean audit trail.",
      long_description: "An operations automation for teams that manage invoice approvals through email, spreadsheets, and manual follow-up.",
      problem: "Invoices get stuck when approvals depend on manual reminders and no one has a clear view of what is overdue.",
      outcome: "A simple approval tracker that shows pending items, sends reminders, escalates delays, and records the approval history.",
      who_it_is_for: ["Finance admins", "Operations managers", "Founder-led teams", "Agencies managing vendor invoices"],
      outputs: ["Approval status", "Overdue list", "Reminder log", "Escalation notes", "Weekly approval summary"],
      required_inputs: ["Approval stages", "Approver list", "Invoice source", "Reminder timing", "Escalation rules"],
      required_tools: ["Email", "Spreadsheet or finance export", "Optional Slack"],
      setup_steps: ["Map approval stages", "Add approvers", "Define reminder timing", "Connect invoice source", "Run approval test"],
      trust_points: ["Clear status history", "No financial access required for demo setup", "Designed for manual process cleanup", "Easy to review before launch"],
      customizations: [
        {
          name: "Weekly finance summary",
          description: "Adds a weekly digest for pending, approved, and overdue invoices.",
          price_note: "Custom quote",
          preview_mode: "code",
          preview_code: "Weekly Finance Summary\nApproved: 18 invoices\nPending: 6 invoices\nOverdue: 2 approvals\nAction: Follow up with operations owner",
        },
      ],
    },
    reviews: [
      {
        reviewer_name: "Kara Jensen",
        reviewer_role: "Finance Coordinator",
        reviewer_company: "Oakline Partners",
        rating: 4.7,
        review_text: "This is exactly the kind of small operations workflow that removes a lot of messy follow-up.",
      },
      {
        reviewer_name: "Ben Walker",
        reviewer_role: "Operations Manager",
        reviewer_company: "Metro Field Ops",
        rating: 4.8,
        review_text: "The overdue reminder and audit trail make the product easy to explain to non-technical teams.",
      },
    ],
  },
  {
    key: "demo-dev-elena-novak",
    developer: {
      display_name: "Elena Novak",
      handle: "demo-elena-novak",
      type: "Market Intelligence Operator",
      avatar_letter: "E",
      short_description: "Creates monitoring workflows that turn competitor activity into practical business signals.",
      bio: "Elena builds market intelligence automations for teams that want to keep track of competitor pages, pricing, launches, and positioning without checking everything by hand.",
      website: "https://nexus-ai.software",
      skills: ["Competitor monitoring", "Market research", "Signal briefs", "Content tracking"],
      verified: true,
      rating: 4.8,
      review_count: 11,
      banner_color: "linear-gradient(135deg,#1d4ed8,#7c3aed)",
    },
    product: {
      key: "demo-product-competitor-signal-monitor",
      title: "Competitor Signal Monitor",
      slug: "demo-competitor-signal-monitor",
      category: "Marketing",
      badge: "Market Signals",
      icon: "CS",
      color: "indigo",
      delivery_time: "4-7 business days",
      setup_type: "Guided setup",
      best_for: "Founders, marketers, agencies",
      rating: 4.8,
      review_count: 2,
      sales_count: 23,
      preview_type: "listening",
      preview_mode: "code",
      preview_title: "Competitor signal brief",
      preview_description: "Example of a weekly competitor update.",
      preview_code: "Competitor Signal Brief\nNew pricing page detected\nContent launch: AI operations guide\nPositioning shift: More emphasis on managed service\nRecommended action: Update comparison talking points",
      short_description: "Monitor competitor updates, pricing moves, content launches, and positioning changes in a weekly brief.",
      long_description: "A market intelligence automation for businesses that need a practical way to watch competitor movement without assigning someone to manually check websites every week.",
      problem: "Competitor changes are easy to miss, and manual checking turns into inconsistent notes that rarely become action.",
      outcome: "A weekly signal brief that highlights meaningful competitor changes and suggests what your team should review.",
      who_it_is_for: ["Founders tracking competitors", "Marketing teams", "Agencies reporting market changes", "Sales teams needing positioning notes"],
      outputs: ["Competitor update summary", "Pricing change notes", "Content launch alerts", "Positioning signals", "Suggested response"],
      required_inputs: ["Competitor list", "Web pages to monitor", "Topics of interest", "Reporting cadence", "Recipient list"],
      required_tools: ["Competitor URLs", "Email or Slack", "Optional spreadsheet"],
      setup_steps: ["Choose competitors", "Define monitored pages", "Set signal categories", "Approve brief format", "Run first monitoring pass"],
      trust_points: ["Focuses on business signals, not noise", "Easy weekly cadence", "Works with public sources", "Briefs are readable by non-technical teams"],
      customizations: [
        {
          name: "Sales battlecard notes",
          description: "Adds short talking points for sales teams when competitor positioning changes.",
          price_note: "Custom quote",
          preview_mode: "code",
          preview_code: "Battlecard Update\nCompetitor now emphasizes managed setup\nSuggested response: Highlight Nexus marketplace choice and guided install flexibility",
        },
      ],
    },
    reviews: [
      {
        reviewer_name: "Lena Carter",
        reviewer_role: "Marketing Lead",
        reviewer_company: "Framewell",
        rating: 4.8,
        review_text: "The signal brief feels useful because it explains what changed and why the business should care.",
      },
      {
        reviewer_name: "Samir Khan",
        reviewer_role: "Founder",
        reviewer_company: "Atlas CRM Labs",
        rating: 4.9,
        review_text: "Good demo product. It makes competitor monitoring feel like an outcome instead of another research chore.",
      },
    ],
  },
];

async function upsertByDemoKey(adminClient: any, table: string, seedKey: string, payload: Record<string, unknown>) {
  const { data: existing, error: loadError } = await adminClient
    .from(table)
    .select("id")
    .eq("demo_seed_key", seedKey)
    .maybeSingle();

  if (loadError) throw new Error(loadError.message);

  if (existing?.id) {
    const { data, error } = await adminClient
      .from(table)
      .update({
        ...payload,
        is_demo: true,
        demo_seed_key: seedKey,
        updated_at: nowIso(),
      })
      .eq("id", existing.id)
      .select("*")
      .single();

    if (error) throw new Error(error.message);
    return data;
  }

  const { data, error } = await adminClient
    .from(table)
    .insert({
      ...payload,
      is_demo: true,
      demo_seed_key: seedKey,
      created_at: nowIso(),
      updated_at: nowIso(),
    })
    .select("*")
    .single();

  if (error) throw new Error(error.message);
  return data;
}

function productPayload(product: any, developerId: string, enabled: boolean) {
  return {
    developer_id: developerId,
    title: product.title,
    slug: product.slug,
    category: product.category,
    badge: product.badge,
    icon: product.icon,
    color: product.color,
    status: enabled ? "live" : "archived",
    featured: false,
    listing_type: "custom_request",
    pricing_type: "custom_quote",
    currency: "THB",
    price: 0,
    price_usd: 0,
    price_thb: 0,
    setup_fee: 0,
    setup_fee_usd: 0,
    setup_fee_thb: 0,
    delivery_time: product.delivery_time,
    setup_type: product.setup_type,
    best_for: product.best_for,
    rating: product.rating,
    review_count: product.review_count,
    sales_count: product.sales_count,
    preview_type: product.preview_type,
    preview_mode: product.preview_mode,
    preview_title: product.preview_title,
    preview_description: product.preview_description,
    preview_code: product.preview_code,
    short_description: product.short_description,
    long_description: product.long_description,
    problem: product.problem,
    outcome: product.outcome,
    who_it_is_for: product.who_it_is_for,
    outputs: product.outputs,
    required_inputs: product.required_inputs,
    required_tools: product.required_tools,
    setup_steps: product.setup_steps,
    trust_points: product.trust_points,
    customizations: product.customizations,
    internal_notes: "Synthetic Nexus demo marketplace product. Safe to hide with demo mode.",
  };
}

async function seedDemoMarketplace(adminClient: any, enabled: boolean) {
  const developers = [];
  const products = [];
  const reviews = [];

  for (const entry of DEMO_CONTENT) {
    const developer = await upsertByDemoKey(adminClient, "developers", entry.key, {
      ...entry.developer,
      profile_id: null,
      status: enabled ? "active" : "hidden",
      is_demo: true,
    });

    developers.push(developer);

    const product = await upsertByDemoKey(
      adminClient,
      "automations",
      entry.product.key,
      productPayload(entry.product, developer.id, enabled),
    );

    products.push(product);

    for (let index = 0; index < entry.reviews.length; index++) {
      const review = entry.reviews[index];
      const seededReview = await upsertByDemoKey(
        adminClient,
        "reviews",
        `${entry.product.key}-review-${index + 1}`,
        {
          automation_id: product.id,
          developer_id: developer.id,
          review_type: "product",
          reviewer_name: review.reviewer_name,
          reviewer_role: review.reviewer_role,
          reviewer_company: review.reviewer_company,
          rating: review.rating,
          review_text: review.review_text,
          status: enabled ? "approved" : "hidden",
          verified_purchase: false,
          source: "demo",
        },
      );

      reviews.push(seededReview);
    }
  }

  return {
    developers,
    products,
    reviews,
  };
}

async function loadStatus(adminClient: any) {
  const [developersResult, productsResult, reviewsResult] = await Promise.all([
    adminClient.from("developers").select("id,status").eq("is_demo", true),
    adminClient.from("automations").select("id,status").eq("is_demo", true),
    adminClient.from("reviews").select("id,status").eq("is_demo", true),
  ]);

  if (developersResult.error) throw new Error(developersResult.error.message);
  if (productsResult.error) throw new Error(productsResult.error.message);
  if (reviewsResult.error) throw new Error(reviewsResult.error.message);

  const developers = developersResult.data || [];
  const products = productsResult.data || [];
  const reviews = reviewsResult.data || [];

  const activeDevelopers = developers.filter((item: any) => item.status === "active").length;
  const liveProducts = products.filter((item: any) => item.status === "live").length;
  const approvedReviews = reviews.filter((item: any) => item.status === "approved").length;

  return {
    enabled: activeDevelopers > 0 || liveProducts > 0 || approvedReviews > 0,
    counts: {
      developers: developers.length,
      products: products.length,
      reviews: reviews.length,
      active_developers: activeDevelopers,
      live_products: liveProducts,
      approved_reviews: approvedReviews,
    },
  };
}

async function disableDemoMarketplace(adminClient: any) {
  const [developerResult, productResult, reviewResult] = await Promise.all([
    adminClient.from("developers").update({ status: "hidden", updated_at: nowIso() }).eq("is_demo", true),
    adminClient.from("automations").update({ status: "archived", updated_at: nowIso() }).eq("is_demo", true),
    adminClient.from("reviews").update({ status: "hidden", updated_at: nowIso() }).eq("is_demo", true),
  ]);

  if (developerResult.error) throw new Error(developerResult.error.message);
  if (productResult.error) throw new Error(productResult.error.message);
  if (reviewResult.error) throw new Error(reviewResult.error.message);

  return await loadStatus(adminClient);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: corsHeaders,
    });
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed.", 405);
  }

  try {
    const { adminClient, error: authError } = await requireAdmin(req);

    if (authError || !adminClient) {
      return errorResponse(authError || "Admin access required.", authError === "Admin access required." ? 403 : 401);
    }

    const body = await req.json().catch(() => ({}));
    const action = cleanString(body.action || "get_status");

    if (action === "get_status") {
      return jsonResponse({
        ok: true,
        ...(await loadStatus(adminClient)),
      });
    }

    if (action === "enable") {
      await seedDemoMarketplace(adminClient, true);

      return jsonResponse({
        ok: true,
        message: "Demo marketplace mode is on.",
        ...(await loadStatus(adminClient)),
      });
    }

    if (action === "disable") {
      const status = await disableDemoMarketplace(adminClient);

      return jsonResponse({
        ok: true,
        message: "Demo marketplace mode is off.",
        ...status,
      });
    }

    if (action === "reset") {
      const current = await loadStatus(adminClient).catch(() => ({ enabled: false }));
      await seedDemoMarketplace(adminClient, Boolean(current.enabled));

      return jsonResponse({
        ok: true,
        message: "Demo marketplace content was reset.",
        ...(await loadStatus(adminClient)),
      });
    }

    return errorResponse("Unknown demo marketplace action.", 400);
  } catch (error) {
    console.error("demo-marketplace failed:", error);
    return errorResponse(userFacingError(error), 500);
  }
});
