-- Product workflow health checker setup.
-- Run this in the Supabase SQL editor, then deploy product-health-checker and system-health.

alter table if exists public.automations
  add column if not exists health_status text not null default 'unknown',
  add column if not exists health_last_checked_at timestamptz,
  add column if not exists health_last_passed_at timestamptz,
  add column if not exists health_last_failed_at timestamptz,
  add column if not exists health_failure_reason text,
  add column if not exists health_failure_details jsonb not null default '{}'::jsonb,
  add column if not exists health_auto_paused_at timestamptz,
  add column if not exists health_previous_status text,
  add column if not exists health_consecutive_failures integer not null default 0,
  add column if not exists health_next_check_at timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'automations_health_status_check'
  ) then
    alter table public.automations
      add constraint automations_health_status_check
      check (
        health_status in (
          'unknown',
          'healthy',
          'warning',
          'failed',
          'needs_recheck',
          'paused_by_health_check',
          'skipped'
        )
      );
  end if;
end $$;

create table if not exists public.automation_health_checks (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid references public.automations(id) on delete cascade,
  developer_id uuid references public.developers(id) on delete set null,
  check_type text not null default 'structural',
  status text not null,
  reason text,
  details jsonb not null default '{}'::jsonb,
  checked_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'automation_health_checks_status_check'
  ) then
    alter table public.automation_health_checks
      add constraint automation_health_checks_status_check
      check (status in ('passed', 'warning', 'failed', 'paused', 'skipped'));
  end if;
end $$;

create index if not exists idx_automation_health_checks_automation_checked
  on public.automation_health_checks (automation_id, checked_at desc);

create index if not exists idx_automation_health_checks_developer_checked
  on public.automation_health_checks (developer_id, checked_at desc);

drop index if exists public.idx_automations_health_due;

create index idx_automations_health_due
  on public.automations (status, health_next_check_at, health_last_checked_at)
  where status in ('live', 'active', 'published');

-- Backfill existing launch products into the new checker cycle.
-- This makes older products due immediately instead of waiting for only newly-created
-- products that already have health metadata.
update public.automations
set
  health_next_check_at = null,
  health_last_checked_at = null,
  health_status = case
    when health_status in ('unknown', 'healthy', 'warning', 'skipped') then 'needs_recheck'
    else health_status
  end,
  health_failure_reason = case
    when health_status in ('unknown', 'healthy', 'warning', 'skipped') then 'Queued for full technical health check.'
    else health_failure_reason
  end,
  health_failure_details = case
    when health_status in ('unknown', 'healthy', 'warning', 'skipped') then jsonb_build_object('queued_by', 'product_health_checker_backfill', 'queued_at', now())
    else health_failure_details
  end
where status in ('live', 'active', 'published')
  and coalesce(listing_type, 'standard') <> 'custom_request';

alter table public.automation_health_checks enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'automation_health_checks'
      and policyname = 'Admins can manage automation health checks'
  ) then
    create policy "Admins can manage automation health checks"
      on public.automation_health_checks
      for all
      using (
        exists (
          select 1
          from public.profiles p
          where p.id = auth.uid()
            and p.role = 'admin'
        )
      )
      with check (
        exists (
          select 1
          from public.profiles p
          where p.id = auth.uid()
            and p.role = 'admin'
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'automation_health_checks'
      and policyname = 'Developers can read own automation health checks'
  ) then
    create policy "Developers can read own automation health checks"
      on public.automation_health_checks
      for select
      using (
        exists (
          select 1
          from public.developers d
          where d.id = automation_health_checks.developer_id
            and d.profile_id = auth.uid()
        )
      );
  end if;
end $$;

grant select on public.automation_health_checks to authenticated;

select pg_notify('pgrst', 'reload schema');

-- Optional Supabase Cron job after product-health-checker and test-n8n-workflow are deployed.
-- This now starts/continues full technical workflow tests for every due live/active/published
-- standard product, including older products with no previous health checker rows.
-- Replace <PROJECT_REF> and <NEXUS_RUNTIME_SECRET>, then run once:
--
-- select cron.schedule(
--   'nexus-product-health-checker-30min',
--   '*/30 * * * *',
--   $$
--   select net.http_post(
--     url := 'https://<PROJECT_REF>.supabase.co/functions/v1/product-health-checker',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'x-nexus-runtime-secret', '<NEXUS_RUNTIME_SECRET>'
--     ),
--     body := jsonb_build_object('action', 'run_due', 'limit', 50)
--   );
--   $$
-- );
