const fs = require("fs");

function read(path) {
  return fs.readFileSync(path, "utf8").replace(/\r\n/g, "\n");
}
function requireText(source, text, label) {
  if (!source.includes(text)) throw new Error(`Missing ${label}: ${text}`);
}
function rejectText(source, text, label) {
  if (source.includes(text)) throw new Error(`Forbidden ${label}: ${text}`);
}

const requestCancellation = read("supabase/functions/request-automation-cancellation/index.ts");
const reviewCancellation = read("supabase/functions/review-automation-cancellation/index.ts");
const listCancellation = read("supabase/functions/list-cancellation-requests/index.ts");
const cancellationMigration = read("supabase/migrations/20260729000100_subscription_cancellation_refunds.sql");
const monitor = read("supabase/functions/monitor-system-health/index.ts");
const monitorMigration = read("supabase/migrations/20260729000200_system_outage_monitor.sql");
const systemHealth = read("supabase/functions/system-health/index.ts");
const email = read("supabase/functions/_shared/nexus-email.ts");
const database = read("assets/js/nexus-db.js");
const dashboard = read("pages/buyer/dashboard.html");
const adminCancellation = read("pages/admin/customer-automations.html");
const setup = read("pages/buyer/setup.html");
const deploy = read(".github/workflows/deploy-pages.yml");
const config = read("supabase/config.toml");
const notFound = read("404.html");

[
  [requestCancellation, 'stripeMode !== "subscription" || !subscriptionId', "server-side one-time cancellation block"],
  [requestCancellation, '.eq("order_id", order.id)', "order-level bundle request dedupe"],
  [reviewCancellation, 'profile.role !== "admin"', "admin-only refund approval"],
  [reviewCancellation, 'stripe.subscriptions.cancel(', "immediate Stripe subscription cancellation"],
  [reviewCancellation, 'stripe.refunds.create(', "Stripe refund creation"],
  [reviewCancellation, 'reason: "requested_by_customer"', "customer-requested refund reason"],
  [reviewCancellation, 'idempotencyKey: `nexus-cancel-${request.id}`', "cancel idempotency"],
  [reviewCancellation, 'idempotencyKey: `nexus-refund-${request.id}`', "refund idempotency"],
  [reviewCancellation, '.eq("order_id", order.id)', "bundle-wide cancellation"],
  [reviewCancellation, 'payment_status: "refunded"', "refunded order state"],
  [reviewCancellation, 'next_run_at: null', "future runs stopped"],
  [cancellationMigration, "stripe_refund_id text", "refund audit ID"],
  [cancellationMigration, "cancellation_approved_by uuid", "admin approval audit"],
  [listCancellation, "refund_status", "admin refund audit read"],
  [database, '.in("payment_status", ["paid", "refunded", "cancelled", "canceled"])', "cancelled purchase visibility"],
  [dashboard, "function canRequestSubscriptionCancellation", "monthly cancellation UI guard"],
  [dashboard, 'stripeMode === "subscription"', "strict dashboard Stripe mode"],
  [dashboard, "All previously delivered outputs remain available", "cancelled bundle output copy"],
  [adminCancellation, "Cancel &amp; refund", "explicit admin payment action"],
  [adminCancellation, "One-time purchase: approval blocked", "admin one-time approval block"],
  [monitor, "const FAILURE_THRESHOLD = 2", "two-check alert threshold"],
  [monitor, "checkProductionSite()", "website outage check"],
  [monitor, "checkN8n()", "n8n/database readiness check"],
  [monitor, "checkStripe()", "Stripe outage check"],
  [monitor, "checkRuntimeBacklog(adminClient)", "runtime backlog outage check"],
  [monitor, 'transition === "outage" || transition === "recovered"', "outage and recovery transitions"],
  [monitorMigration, "authorize_system_monitor_worker", "monitor worker authorization"],
  [monitorMigration, "encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')", "monitor token hashing"],
  [monitorMigration, "'nexus-system-monitor-5min'", "monitor cron job"],
  [monitorMigration, "'*/5 * * * *'", "five-minute monitor schedule"],
  [systemHealth, "checkAutomatedOutageMonitor", "admin monitor verification"],
  [email, 'case "subscription_cancellation_approved"', "buyer refund email"],
  [email, 'case "system_outage_alert"', "admin outage email"],
  [email, 'case "system_outage_recovered"', "admin recovery email"],
  [config, "[functions.monitor-system-health]", "monitor function config"],
  [setup, "https://support.google.com/youtube/answer/3250431?hl=en", "YouTube Channel ID docs"],
  [setup, "https://help.getslick.com/en/articles/6362168-how-to-find-your-facebook-review-link", "Facebook Reviews URL docs"],
  [setup, "https://www.sixthcitymarketing.com/2025/02/11/create-google-review-link/", "Google Reviews URL docs"],
  [notFound, "Your account, purchases, and delivered outputs are unaffected.", "branded 404 reassurance"],
  [deploy, "404.html", "404 deployment artifact"],
].forEach(([source, text, label]) => requireText(source, text, label));

rejectText(reviewCancellation, '.from("automation_outputs")', "output mutation in cancellation approval");
rejectText(requestCancellation, '.from("automation_outputs")', "output mutation in cancellation request");
rejectText(monitorMigration, "x-nexus-monitor-worker', '<", "placeholder monitor secret");

console.log("Cancellation, refund, outage-alert, tutorial, and 404 launch checks passed.");
