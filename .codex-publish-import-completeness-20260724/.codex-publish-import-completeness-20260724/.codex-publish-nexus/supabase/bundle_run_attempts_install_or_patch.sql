-- Nexus bundle runtime attempt tracking.
-- Run this in the Supabase SQL editor, then redeploy:
--   submit-automation-setup
--   runtime-submit-output
-- This prevents a new bundle purchase/setup from showing outputs from older bundle runs.

create extension if not exists pgcrypto;

create table if not exists public.bundle_run_attempts (
  id uuid primary key default gen_random_uuid(),
  order_id uuid references public.orders(id) on delete cascade,
  bundle_id uuid references public.automation_bundles(id) on delete set null,
  buyer_id uuid references auth.users(id) on delete cascade,
  status text not null default 'running',
  expected_count integer not null default 0,
  completed_count integer not null default 0,
  failed_count integer not null default 0,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bundle_run_attempts_status_check'
  ) then
    alter table public.bundle_run_attempts
      add constraint bundle_run_attempts_status_check
      check (status in ('queued', 'running', 'success', 'partial_failed', 'failed', 'cancelled', 'timed_out'));
  end if;
end $$;

create table if not exists public.bundle_run_items (
  id uuid primary key default gen_random_uuid(),
  bundle_run_attempt_id uuid not null references public.bundle_run_attempts(id) on delete cascade,
  order_id uuid references public.orders(id) on delete cascade,
  bundle_id uuid references public.automation_bundles(id) on delete set null,
  buyer_id uuid references auth.users(id) on delete cascade,
  customer_automation_id uuid references public.customer_automations(id) on delete cascade,
  automation_id uuid references public.automations(id) on delete set null,
  automation_run_id uuid references public.automation_runs(id) on delete set null,
  output_id uuid references public.automation_outputs(id) on delete set null,
  status text not null default 'running',
  error_message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(bundle_run_attempt_id, customer_automation_id)
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bundle_run_items_status_check'
  ) then
    alter table public.bundle_run_items
      add constraint bundle_run_items_status_check
      check (status in ('queued', 'running', 'success', 'failed', 'cancelled', 'timed_out', 'skipped'));
  end if;
end $$;

alter table if exists public.automation_runs
  add column if not exists bundle_run_attempt_id uuid references public.bundle_run_attempts(id) on delete set null,
  add column if not exists bundle_run_item_id uuid references public.bundle_run_items(id) on delete set null;

alter table if exists public.automation_outputs
  add column if not exists automation_run_id uuid references public.automation_runs(id) on delete set null,
  add column if not exists bundle_run_attempt_id uuid references public.bundle_run_attempts(id) on delete set null,
  add column if not exists bundle_run_item_id uuid references public.bundle_run_items(id) on delete set null;

create index if not exists idx_bundle_run_attempts_buyer_created
  on public.bundle_run_attempts(buyer_id, created_at desc);

create index if not exists idx_bundle_run_attempts_order_bundle
  on public.bundle_run_attempts(order_id, bundle_id, created_at desc);

create index if not exists idx_bundle_run_items_attempt_status
  on public.bundle_run_items(bundle_run_attempt_id, status);

create index if not exists idx_bundle_run_items_customer_created
  on public.bundle_run_items(customer_automation_id, created_at desc);

create index if not exists idx_bundle_run_items_run
  on public.bundle_run_items(automation_run_id);

create index if not exists idx_bundle_run_items_output
  on public.bundle_run_items(output_id);

create index if not exists idx_automation_runs_bundle_attempt
  on public.automation_runs(bundle_run_attempt_id, created_at desc);

create index if not exists idx_automation_runs_bundle_item
  on public.automation_runs(bundle_run_item_id);

create index if not exists idx_automation_outputs_automation_run
  on public.automation_outputs(automation_run_id);

create index if not exists idx_automation_outputs_bundle_attempt
  on public.automation_outputs(bundle_run_attempt_id, created_at desc);

create index if not exists idx_automation_outputs_bundle_item
  on public.automation_outputs(bundle_run_item_id);

alter table public.bundle_run_attempts enable row level security;
alter table public.bundle_run_items enable row level security;

drop policy if exists "Buyers can read own bundle run attempts" on public.bundle_run_attempts;
create policy "Buyers can read own bundle run attempts"
  on public.bundle_run_attempts
  for select
  to authenticated
  using (buyer_id = (select auth.uid()));

drop policy if exists "Admins can read bundle run attempts" on public.bundle_run_attempts;
create policy "Admins can read bundle run attempts"
  on public.bundle_run_attempts
  for select
  to authenticated
  using (exists (
    select 1 from public.profiles
    where profiles.id = (select auth.uid())
      and profiles.role in ('admin', 'support_admin')
  ));

drop policy if exists "Buyers can read own bundle run items" on public.bundle_run_items;
create policy "Buyers can read own bundle run items"
  on public.bundle_run_items
  for select
  to authenticated
  using (buyer_id = (select auth.uid()));

drop policy if exists "Admins can read bundle run items" on public.bundle_run_items;
create policy "Admins can read bundle run items"
  on public.bundle_run_items
  for select
  to authenticated
  using (exists (
    select 1 from public.profiles
    where profiles.id = (select auth.uid())
      and profiles.role in ('admin', 'support_admin')
  ));

grant select on public.bundle_run_attempts to authenticated;
grant select on public.bundle_run_items to authenticated;

select pg_notify('pgrst', 'reload schema');
