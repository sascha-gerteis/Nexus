-- Product runtime modes for Nexus automation products.
-- Run this in the Supabase SQL editor, then redeploy:
--   supabase functions deploy developer-products --project-ref YOUR_PROJECT_REF
--   supabase functions deploy stripe-webhook --project-ref YOUR_PROJECT_REF
--   supabase functions deploy submit-automation-setup --project-ref YOUR_PROJECT_REF
--   supabase functions deploy provision-customer-workflow --project-ref YOUR_PROJECT_REF
--   supabase functions deploy run-scheduled-automations --project-ref YOUR_PROJECT_REF
--   supabase functions deploy system-health --project-ref YOUR_PROJECT_REF

alter table if exists public.automations
  add column if not exists runtime_trigger_mode text not null default 'legacy',
  add column if not exists runtime_run_frequency text not null default 'manual',
  add column if not exists runtime_interval_count integer not null default 1,
  add column if not exists runtime_interval_unit text not null default 'month',
  add column if not exists runtime_no_change_policy text not null default 'no_output',
  add column if not exists runtime_response_mode text not null default 'dashboard_output',
  add column if not exists runtime_event_schema jsonb not null default '[]'::jsonb;

do $$
begin
  alter table public.automations
    drop constraint if exists automations_runtime_trigger_mode_check;

  alter table public.automations
    add constraint automations_runtime_trigger_mode_check
    check (
      runtime_trigger_mode in (
        'legacy',
        'setup_complete',
        'on_demand',
        'scheduled_interval',
        'subscription_monthly',
        'manual'
      )
    );

  alter table public.automations
    drop constraint if exists automations_runtime_run_frequency_check;

  alter table public.automations
    add constraint automations_runtime_run_frequency_check
    check (
      runtime_run_frequency in (
        'manual',
        'on_demand',
        'every_30_minutes',
        'hourly',
        'daily',
        'weekly',
        'monthly'
      )
    );

  alter table public.automations
    drop constraint if exists automations_runtime_interval_unit_check;

  alter table public.automations
    add constraint automations_runtime_interval_unit_check
    check (runtime_interval_unit in ('minute', 'hour', 'day', 'week', 'month'));

  alter table public.automations
    drop constraint if exists automations_runtime_no_change_policy_check;

  alter table public.automations
    add constraint automations_runtime_no_change_policy_check
    check (runtime_no_change_policy in ('no_output', 'status_event', 'empty_output'));

  alter table public.automations
    drop constraint if exists automations_runtime_response_mode_check;

  alter table public.automations
    add constraint automations_runtime_response_mode_check
    check (runtime_response_mode in ('dashboard_output', 'instant_message', 'alert_only', 'webhook_ack'));
exception
  when undefined_table then null;
end $$;

alter table if exists public.customer_automations
  add column if not exists runtime_trigger_mode text,
  add column if not exists runtime_no_change_policy text,
  add column if not exists runtime_response_mode text,
  add column if not exists run_frequency text default 'manual',
  add column if not exists schedule_status text default 'inactive',
  add column if not exists schedule_anchor_at timestamptz,
  add column if not exists next_run_at timestamptz,
  add column if not exists last_run_at timestamptz,
  add column if not exists last_run_requested_at timestamptz,
  add column if not exists last_event_triggered_at timestamptz,
  add column if not exists last_no_change_at timestamptz;

create index if not exists idx_automations_runtime_trigger_mode
  on public.automations (runtime_trigger_mode, runtime_run_frequency);

create index if not exists idx_customer_automations_runtime_schedule
  on public.customer_automations (runtime_trigger_mode, run_frequency, schedule_status, next_run_at);

select pg_notify('pgrst', 'reload schema');
