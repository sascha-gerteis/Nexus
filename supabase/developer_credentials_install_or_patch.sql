-- Nexus developer/admin credential vault install/patch.
-- Run this in the Supabase SQL editor, then deploy:
--   supabase functions deploy developer-credentials --project-ref YOUR_PROJECT_REF
--   supabase functions deploy import-n8n-workflow --project-ref YOUR_PROJECT_REF
--
-- Required Edge Function secret:
--   NEXUS_CREDENTIAL_SECRET = long random string used for AES-GCM encryption.

create extension if not exists "pgcrypto";

alter table if exists public.automations
  add column if not exists developer_credential_requirements jsonb not null default '[]'::jsonb,
  add column if not exists n8n_credential_bindings jsonb not null default '[]'::jsonb,
  add column if not exists credential_binding_status text not null default 'not_checked',
  add column if not exists credential_binding_errors jsonb not null default '[]'::jsonb,
  add column if not exists n8n_last_credential_bound_at timestamptz;

do $$
begin
  alter table public.automations
    drop constraint if exists automations_credential_binding_status_check;

  alter table public.automations
    add constraint automations_credential_binding_status_check
    check (
      credential_binding_status in (
        'not_checked',
        'not_required',
        'needs_credentials',
        'bound',
        'failed'
      )
    );
exception
  when undefined_table then null;
end $$;

create table if not exists public.developer_credentials (
  id uuid primary key default gen_random_uuid(),
  developer_id uuid references public.developers(id) on delete cascade,
  owner_profile_id uuid references public.profiles(id) on delete set null,
  owner_role text not null default 'developer',
  provider text not null,
  provider_label text,
  credential_type text not null default 'api_key',
  label text not null,
  n8n_credential_type text,
  n8n_credential_id text,
  n8n_credential_name text,
  status text not null default 'active',
  test_status text not null default 'untested',
  last_four text,
  fingerprint text,
  encrypted_payload jsonb,
  metadata jsonb not null default '{}'::jsonb,
  last_tested_at timestamptz,
  last_synced_at timestamptz,
  last_error text,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint developer_credentials_owner_role_check
    check (owner_role in ('developer', 'admin')),
  constraint developer_credentials_status_check
    check (status in ('active', 'needs_attention', 'revoked')),
  constraint developer_credentials_test_status_check
    check (test_status in ('untested', 'passed', 'failed'))
);

create table if not exists public.automation_credential_requirements (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null references public.automations(id) on delete cascade,
  developer_id uuid references public.developers(id) on delete cascade,
  source text not null default 'developer',
  provider text not null,
  provider_label text,
  credential_type text not null default 'api_key',
  credential_key text not null,
  node_name text not null,
  node_type text,
  n8n_credential_type text,
  n8n_credential_id text,
  n8n_credential_name text,
  developer_credential_id uuid references public.developer_credentials(id) on delete set null,
  required boolean not null default true,
  status text not null default 'missing',
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint automation_credential_requirements_source_check
    check (source in ('developer', 'admin', 'buyer')),
  constraint automation_credential_requirements_status_check
    check (status in ('missing', 'bound', 'not_required', 'failed'))
);

create unique index if not exists idx_developer_credentials_fingerprint
  on public.developer_credentials(developer_id, provider, fingerprint)
  where fingerprint is not null and status <> 'revoked';

create index if not exists idx_developer_credentials_developer
  on public.developer_credentials(developer_id);

create index if not exists idx_developer_credentials_owner
  on public.developer_credentials(owner_profile_id, owner_role);

create index if not exists idx_developer_credentials_status
  on public.developer_credentials(status);

create index if not exists idx_automation_credential_requirements_automation
  on public.automation_credential_requirements(automation_id);

create index if not exists idx_automation_credential_requirements_developer
  on public.automation_credential_requirements(developer_id);

create unique index if not exists idx_automation_credential_requirements_slot
  on public.automation_credential_requirements(
    automation_id,
    node_name,
    credential_key,
    coalesce(n8n_credential_type, '')
  );

alter table public.developer_credentials enable row level security;
alter table public.automation_credential_requirements enable row level security;

drop policy if exists "Admins manage developer credentials" on public.developer_credentials;
create policy "Admins manage developer credentials"
on public.developer_credentials for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Developers read own credential metadata" on public.developer_credentials;
create policy "Developers read own credential metadata"
on public.developer_credentials for select
using (
  exists (
    select 1
    from public.developers d
    where d.id = developer_credentials.developer_id
      and d.profile_id = auth.uid()
  )
);

drop policy if exists "Admins manage automation credential requirements" on public.automation_credential_requirements;
create policy "Admins manage automation credential requirements"
on public.automation_credential_requirements for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Developers read own automation credential requirements" on public.automation_credential_requirements;
create policy "Developers read own automation credential requirements"
on public.automation_credential_requirements for select
using (
  exists (
    select 1
    from public.developers d
    where d.id = automation_credential_requirements.developer_id
      and d.profile_id = auth.uid()
  )
);

grant select on public.developer_credentials to authenticated;
grant select on public.automation_credential_requirements to authenticated;

select pg_notify('pgrst', 'reload schema');
