-- Nexus Python runner support.
-- Run this in the Supabase SQL editor, then deploy the run-python-automation Edge Function.

alter table if exists public.automations
  add column if not exists python_script_code text,
  add column if not exists python_requirements text not null default '',
  add column if not exists python_entrypoint text not null default 'run',
  add column if not exists python_runtime_version text not null default 'python3.11',
  add column if not exists python_timeout_seconds integer not null default 120,
  add column if not exists python_last_test_status text not null default 'not_tested',
  add column if not exists python_last_tested_at timestamptz,
  add column if not exists python_last_test_error text,
  add column if not exists python_last_test_result jsonb not null default '{}'::jsonb,
  add column if not exists workflow_source_platform text not null default 'n8n',
  add column if not exists workflow_placeholder_mappings jsonb not null default '[]'::jsonb,
  add column if not exists detected_placeholders jsonb not null default '{}'::jsonb,
  add column if not exists placeholder_validation_status text not null default 'not_checked',
  add column if not exists placeholder_validation_errors jsonb not null default '[]'::jsonb,
  add column if not exists runtime_event_schema jsonb not null default '[]'::jsonb,
  add column if not exists sheet_access_config jsonb not null default '{}'::jsonb;

alter table if exists public.automations
  drop constraint if exists automations_workflow_source_platform_check;

alter table if exists public.automations
  drop constraint if exists automations_runtime_type_check;

alter table if exists public.automations
  drop constraint if exists automations_python_timeout_seconds_check;

alter table if exists public.automations
  add constraint automations_runtime_type_check
  check (runtime_type in ('manual', 'n8n_managed', 'python_runner'));

alter table if exists public.automations
  add constraint automations_workflow_source_platform_check
  check (workflow_source_platform in ('n8n', 'make', 'zapier', 'python', 'manual'));

alter table if exists public.automations
  add constraint automations_python_timeout_seconds_check
  check (python_timeout_seconds between 5 and 300);

select pg_notify('pgrst', 'reload schema');
