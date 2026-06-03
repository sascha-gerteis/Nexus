-- Nexus monthly subscription automation runner install/patch.
-- Run this in Supabase SQL editor before deploying the updated Edge Functions.

alter table if exists public.orders
  add column if not exists stripe_subscription_status text,
  add column if not exists stripe_current_period_start timestamptz,
  add column if not exists stripe_current_period_end timestamptz,
  add column if not exists stripe_cancel_at_period_end boolean default false,
  add column if not exists last_invoice_paid_at timestamptz;

alter table if exists public.customer_automations
  add column if not exists run_frequency text default 'manual',
  add column if not exists schedule_status text default 'inactive',
  add column if not exists schedule_anchor_at timestamptz,
  add column if not exists next_run_at timestamptz,
  add column if not exists last_run_at timestamptz,
  add column if not exists last_run_requested_at timestamptz;

alter table if exists public.automation_runs
  add column if not exists run_key text,
  add column if not exists scheduled_for timestamptz,
  add column if not exists trigger_source text,
  add column if not exists request_payload jsonb default '{}'::jsonb,
  add column if not exists response_payload jsonb default '{}'::jsonb;

do $$
begin
  if to_regclass('public.orders') is not null then
    create index if not exists idx_orders_stripe_subscription_id
      on public.orders(stripe_subscription_id);

    create index if not exists idx_orders_subscription_status
      on public.orders(stripe_subscription_status);
  end if;

  if to_regclass('public.customer_automations') is not null then
    create index if not exists idx_customer_automations_schedule_due
      on public.customer_automations(run_frequency, schedule_status, next_run_at);

    create index if not exists idx_customer_automations_order_id
      on public.customer_automations(order_id);
  end if;

  if to_regclass('public.automation_runs') is not null then
    create unique index if not exists idx_automation_runs_run_key_unique
      on public.automation_runs(run_key)
      where run_key is not null and run_key <> '';

    create index if not exists idx_automation_runs_scheduled_for
      on public.automation_runs(scheduled_for);
  end if;
end $$;

-- Optional Supabase Cron setup after deploying run-scheduled-automations:
-- 1. Enable pg_cron + pg_net in Supabase if they are not already enabled.
-- 2. Replace <project-ref> and <service-role-key> in the private SQL session only.
-- 3. Run the cron.schedule block below.
--
-- Example body:
--   {"action":"run_due","limit":25}
--
-- Keep the Authorization header server-side only. Never expose the service role key in frontend code.
--
-- create extension if not exists pg_cron with schema extensions;
-- create extension if not exists pg_net with schema extensions;
--
-- select cron.unschedule('nexus-monthly-runner-daily')
-- where exists (
--   select 1 from cron.job where jobname = 'nexus-monthly-runner-daily'
-- );
--
-- select cron.schedule(
--   'nexus-monthly-runner-daily',
--   '10 2 * * *',
--   $$
--   select net.http_post(
--     url := 'https://<project-ref>.supabase.co/functions/v1/run-scheduled-automations',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'Authorization', 'Bearer <service-role-key>'
--     ),
--     body := '{"action":"run_due","limit":25}'::jsonb
--   ) as request_id;
--   $$
-- );
