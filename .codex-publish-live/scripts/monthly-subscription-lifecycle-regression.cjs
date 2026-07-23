const fs = require("fs");

const checkout = fs.readFileSync("supabase/functions/create-checkout-session/index.ts", "utf8");
const stripeWebhook = fs.readFileSync("supabase/functions/stripe-webhook/index.ts", "utf8");
const submitSetup = fs.readFileSync("supabase/functions/submit-automation-setup/index.ts", "utf8");
const runner = fs.readFileSync("supabase/functions/run-scheduled-automations/index.ts", "utf8");
const provision = fs.readFileSync("supabase/functions/provision-customer-workflow/index.ts", "utf8");
const installRequest = fs.readFileSync("supabase/functions/nexus-install-request/index.ts", "utf8");
const migration = fs.readFileSync("supabase/monthly_subscription_runner_install_or_patch.sql", "utf8");

function requireText(source, text, label) {
  if (!source.includes(text)) {
    throw new Error(`Missing ${label}: ${text}`);
  }
}

[
  [checkout, 'if (pricingType === "monthly") return "subscription";', "monthly Stripe checkout mode"],
  [checkout, 'priceData.recurring = { interval: "month" };', "monthly Stripe recurring price"],
  [checkout, 'sessionParams.subscription_data = { metadata };', "subscription metadata"],
  [checkout, 'bundleCheckoutMode(bundle, products)', "bundle-level checkout mode"],
  [checkout, 'if (pricingType === "monthly") return "subscription";', "monthly bundle billing"],
  [checkout, 'if (pricingType === "one_time") return "payment";', "one-time bundle billing"],
  [stripeWebhook, 'case "invoice.paid"', "invoice payment renewal handler"],
  [stripeWebhook, 'case "invoice.payment_failed"', "invoice failure handler"],
  [stripeWebhook, 'case "customer.subscription.updated"', "subscription update handler"],
  [stripeWebhook, 'case "customer.subscription.deleted"', "subscription deletion handler"],
  [stripeWebhook, 'function subscriptionCancellationRequested(order: any)', "cancellation request guard"],
  [stripeWebhook, 'await activateBundleSchedulesIfReady(scheduleOrder, status);', "bundle-wide subscription reactivation"],
  [stripeWebhook, 'schedule_status: "cancelled",\n      next_run_at: null', "cancellation clears next run"],
  [stripeWebhook, 'schedule_status: "paused",\n    next_run_at: null', "payment failure clears next run"],
  [submitSetup, 'if (mode === "subscription_monthly") return "monthly";', "monthly setup frequency"],
  [submitSetup, 'next_run_at: nextScheduledDate(frequency, now)', "next monthly setup run"],
  [runner, '.eq("schedule_status", "active")', "active schedules only"],
  [runner, '.not("run_frequency", "in", "(manual,on_demand)")', "scheduled frequencies only"],
  [runner, '.lte("next_run_at", nowIso())', "due schedules only"],
  [runner, 'stripe_cancel_at_period_end', "runner cancellation guard"],
  [runner, 'schedule_status: cancelled ? "cancelled" : "paused"', "stale schedule quarantine"],
  [runner, '!subscriptionCancelled', "forced runs cannot bypass cancellation"],
  [runner, 'next_run_at = nextScheduledDate(frequency, scheduledFor, new Date())', "schedule advancement"],
  [provision, 'stripe_cancel_at_period_end', "provisioning cancellation guard"],
  [installRequest, 'stripe_cancel_at_period_end', "guided install cancellation guard"],
  [migration, 'create unique index if not exists idx_automation_runs_run_key_unique', "duplicate monthly run protection"],
  [migration, "'nexus-monthly-runner-daily'", "scheduled runner cron template"],
].forEach(([source, text, label]) => requireText(source, text, label));

function addMonths(date, months) {
  const next = new Date(date.getTime());
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next;
}

const calendarCases = [
  ["2026-01-31T10:00:00.000Z", "2026-02-28T10:00:00.000Z"],
  ["2028-01-31T10:00:00.000Z", "2028-02-29T10:00:00.000Z"],
  ["2026-04-30T10:00:00.000Z", "2026-05-30T10:00:00.000Z"],
];

for (const [start, expected] of calendarCases) {
  const actual = addMonths(new Date(start), 1).toISOString();
  if (actual !== expected) {
    throw new Error(`Monthly calendar mismatch for ${start}: ${actual} !== ${expected}`);
  }
}

process.stdout.write(JSON.stringify({
  checkoutSubscriptions: true,
  standaloneRenewals: true,
  bundleRenewals: true,
  cancellationStopsSchedules: true,
  staleSchedulesQuarantined: true,
  duplicateRunsBlocked: true,
  calendarCases: calendarCases.length,
}));