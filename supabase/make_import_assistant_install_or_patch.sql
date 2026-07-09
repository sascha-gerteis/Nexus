-- Nexus Make.com import assistant install/patch.
-- Run this in the Supabase SQL editor, then deploy:
--   supabase functions deploy make-import-assistant --project-ref YOUR_PROJECT_REF
--   supabase functions deploy developer-products --project-ref YOUR_PROJECT_REF
--   supabase functions deploy import-n8n-workflow --project-ref YOUR_PROJECT_REF
--
-- The assistant stores Make blueprints and reusable module mappings, then writes
-- generated n8n JSON back to automations only when every Make module is resolved.

create extension if not exists "pgcrypto";

alter table if exists public.automations
  add column if not exists workflow_source_platform text not null default 'n8n',
  add column if not exists make_blueprint jsonb,
  add column if not exists make_import_status text not null default 'not_started',
  add column if not exists make_import_session_id uuid,
  add column if not exists make_conversion_summary jsonb not null default '{}'::jsonb,
  add column if not exists make_unresolved_modules jsonb not null default '[]'::jsonb;

do $$
begin
  alter table public.automations
    drop constraint if exists automations_workflow_source_platform_check;

  alter table public.automations
    add constraint automations_workflow_source_platform_check
    check (workflow_source_platform in ('n8n', 'make', 'zapier', 'python', 'manual'));

  alter table public.automations
    drop constraint if exists automations_make_import_status_check;

  alter table public.automations
    add constraint automations_make_import_status_check
    check (
      make_import_status in (
        'not_started',
        'scanned',
        'needs_substitutes',
        'support_requested',
        'converted',
        'failed'
      )
    );
exception
  when undefined_table then null;
end $$;

create table if not exists public.workflow_node_mappings (
  id uuid primary key default gen_random_uuid(),
  source_platform text not null default 'make',
  source_app text,
  source_module text not null,
  source_action text,
  source_module_key text not null,
  source_fingerprint text,
  target_strategy text not null default 'manual_support',
  target_n8n_node_type text,
  target_operation text,
  http_template jsonb not null default '{}'::jsonb,
  field_map jsonb not null default '{}'::jsonb,
  credential_requirements jsonb not null default '[]'::jsonb,
  confidence text not null default 'low',
  status text not null default 'draft',
  scope text not null default 'global',
  developer_id uuid references public.developers(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  validated_by_run_id uuid,
  validated_by_automation_id uuid references public.automations(id) on delete set null,
  validation_count integer not null default 0,
  last_validated_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workflow_node_mappings_source_platform_check
    check (source_platform in ('make', 'zapier')),
  constraint workflow_node_mappings_target_strategy_check
    check (target_strategy in ('direct_n8n_node', 'http_request', 'code_node', 'manual_support')),
  constraint workflow_node_mappings_confidence_check
    check (confidence in ('high', 'medium', 'low')),
  constraint workflow_node_mappings_status_check
    check (status in ('draft', 'validated', 'global', 'disabled')),
  constraint workflow_node_mappings_scope_check
    check (scope in ('global', 'developer', 'admin'))
);

create table if not exists public.workflow_import_sessions (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid references public.automations(id) on delete cascade,
  developer_id uuid references public.developers(id) on delete set null,
  source_platform text not null default 'make',
  source_blueprint jsonb not null default '{}'::jsonb,
  module_summary jsonb not null default '{}'::jsonb,
  resolved_groups jsonb not null default '[]'::jsonb,
  unresolved_groups jsonb not null default '[]'::jsonb,
  generated_workflow_json jsonb,
  status text not null default 'scanned',
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workflow_import_sessions_source_platform_check
    check (source_platform in ('make', 'zapier')),
  constraint workflow_import_sessions_status_check
    check (status in ('scanned', 'needs_substitutes', 'support_requested', 'converted', 'failed'))
);

create table if not exists public.workflow_import_support_requests (
  id uuid primary key default gen_random_uuid(),
  import_session_id uuid references public.workflow_import_sessions(id) on delete cascade,
  automation_id uuid references public.automations(id) on delete cascade,
  developer_id uuid references public.developers(id) on delete set null,
  source_platform text not null default 'make',
  source_module_key text not null,
  source_app text,
  source_module text,
  source_action text,
  source_module_label text,
  usage_count integer not null default 1,
  dev_notes text,
  admin_notes text,
  status text not null default 'open',
  resolution_mapping_id uuid references public.workflow_node_mappings(id) on delete set null,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workflow_import_support_requests_source_platform_check
    check (source_platform in ('make', 'zapier')),
  constraint workflow_import_support_requests_status_check
    check (status in ('open', 'in_review', 'resolved', 'closed'))
);

drop index if exists idx_workflow_node_mappings_source_key_global;

create index if not exists idx_workflow_node_mappings_source_key_global
  on public.workflow_node_mappings(source_platform, source_module_key)
  where scope = 'global' and status in ('validated', 'global');

create index if not exists idx_workflow_node_mappings_source_key
  on public.workflow_node_mappings(source_platform, source_module_key, status);

create index if not exists idx_workflow_node_mappings_developer
  on public.workflow_node_mappings(developer_id, source_platform, source_module_key);

create index if not exists idx_workflow_import_sessions_automation
  on public.workflow_import_sessions(automation_id, created_at desc);

create index if not exists idx_workflow_import_sessions_developer
  on public.workflow_import_sessions(developer_id, created_at desc);

create index if not exists idx_workflow_import_support_requests_status
  on public.workflow_import_support_requests(status, created_at desc);

create index if not exists idx_workflow_import_support_requests_developer
  on public.workflow_import_support_requests(developer_id, created_at desc);

alter table public.workflow_node_mappings enable row level security;
alter table public.workflow_import_sessions enable row level security;
alter table public.workflow_import_support_requests enable row level security;

drop policy if exists "Admins manage workflow node mappings" on public.workflow_node_mappings;
create policy "Admins manage workflow node mappings"
on public.workflow_node_mappings for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Developers read reusable workflow mappings" on public.workflow_node_mappings;
create policy "Developers read reusable workflow mappings"
on public.workflow_node_mappings for select
using (
  scope = 'global'
  or exists (
    select 1
    from public.developers d
    where d.id = workflow_node_mappings.developer_id
      and d.profile_id = auth.uid()
  )
);

drop policy if exists "Admins manage workflow import sessions" on public.workflow_import_sessions;
create policy "Admins manage workflow import sessions"
on public.workflow_import_sessions for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Developers read own workflow import sessions" on public.workflow_import_sessions;
create policy "Developers read own workflow import sessions"
on public.workflow_import_sessions for select
using (
  exists (
    select 1
    from public.developers d
    where d.id = workflow_import_sessions.developer_id
      and d.profile_id = auth.uid()
  )
);

drop policy if exists "Admins manage workflow import support requests" on public.workflow_import_support_requests;
create policy "Admins manage workflow import support requests"
on public.workflow_import_support_requests for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Developers read own workflow import support requests" on public.workflow_import_support_requests;
create policy "Developers read own workflow import support requests"
on public.workflow_import_support_requests for select
using (
  exists (
    select 1
    from public.developers d
    where d.id = workflow_import_support_requests.developer_id
      and d.profile_id = auth.uid()
  )
);

grant select on public.workflow_node_mappings to authenticated;
grant select on public.workflow_import_sessions to authenticated;
grant select on public.workflow_import_support_requests to authenticated;

select pg_notify('pgrst', 'reload schema');
