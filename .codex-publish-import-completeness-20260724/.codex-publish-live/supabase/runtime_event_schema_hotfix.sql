-- Hotfix: developer product saves require the runtime fields on automations.
-- Run this in the Supabase SQL editor if saves fail with:
--   Could not find the 'runtime_event_schema' column of 'automations' in the schema cache
--
-- This is safe to re-run. It only adds missing columns and reloads PostgREST's schema cache.

alter table if exists public.automations
  add column if not exists runtime_trigger_mode text not null default 'legacy',
  add column if not exists runtime_run_frequency text not null default 'manual',
  add column if not exists runtime_interval_count integer not null default 1,
  add column if not exists runtime_interval_unit text not null default 'month',
  add column if not exists runtime_no_change_policy text not null default 'no_output',
  add column if not exists runtime_response_mode text not null default 'dashboard_output',
  add column if not exists runtime_event_schema jsonb not null default '[]'::jsonb;

select pg_notify('pgrst', 'reload schema');
