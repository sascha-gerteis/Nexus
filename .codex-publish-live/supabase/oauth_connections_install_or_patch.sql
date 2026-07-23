-- Nexus OAuth connection install/patch.
-- Run in the Supabase SQL editor, then deploy:
--   supabase functions deploy oauth-connections --project-ref YOUR_PROJECT_REF
--
-- Required Edge Function secrets:
--   GOOGLE_OAUTH_CLIENT_ID
--   GOOGLE_OAUTH_CLIENT_SECRET
--   GOOGLE_OAUTH_REDIRECT_URI = https://YOUR_PROJECT_REF.supabase.co/functions/v1/oauth-connections
--   NEXUS_CREDENTIAL_SECRET
--   NEXUS_SITE_URL = https://nexus-ai.software

create extension if not exists "pgcrypto";

create table if not exists public.oauth_connections (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_label text,
  owner_profile_id uuid references public.profiles(id) on delete cascade,
  developer_id uuid references public.developers(id) on delete cascade,
  owner_role text not null default 'developer',
  label text not null,
  provider_account_email text,
  provider_account_id text,
  scopes text[] not null default '{}'::text[],
  status text not null default 'active',
  encrypted_token_payload jsonb,
  token_expires_at timestamptz,
  n8n_credential_type text,
  n8n_credential_id text,
  n8n_credential_name text,
  developer_credential_id uuid references public.developer_credentials(id) on delete set null,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint oauth_connections_owner_role_check
    check (owner_role in ('developer', 'admin')),
  constraint oauth_connections_status_check
    check (status in ('active', 'needs_attention', 'revoked'))
);

create table if not exists public.oauth_connection_states (
  id uuid primary key default gen_random_uuid(),
  state_token text not null unique,
  provider text not null,
  owner_profile_id uuid references public.profiles(id) on delete cascade,
  developer_id uuid references public.developers(id) on delete cascade,
  owner_role text not null default 'developer',
  automation_id uuid references public.automations(id) on delete cascade,
  credential_type text,
  label text,
  scope text,
  slot jsonb not null default '{}'::jsonb,
  return_url text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint oauth_connection_states_owner_role_check
    check (owner_role in ('developer', 'admin'))
);

create index if not exists idx_oauth_connections_owner
  on public.oauth_connections(owner_profile_id, owner_role);

create index if not exists idx_oauth_connections_developer
  on public.oauth_connections(developer_id);

create index if not exists idx_oauth_connections_status
  on public.oauth_connections(status);

create unique index if not exists idx_oauth_connections_owner_provider_label
  on public.oauth_connections(
    coalesce(developer_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(provider),
    lower(label)
  )
  where status <> 'revoked';

create index if not exists idx_oauth_connection_states_expires
  on public.oauth_connection_states(expires_at);

alter table public.oauth_connections enable row level security;
alter table public.oauth_connection_states enable row level security;

drop policy if exists "Admins manage OAuth connections" on public.oauth_connections;
create policy "Admins manage OAuth connections"
on public.oauth_connections for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Developers read own OAuth connections" on public.oauth_connections;
create policy "Developers read own OAuth connections"
on public.oauth_connections for select
using (
  exists (
    select 1
    from public.developers d
    where d.id = oauth_connections.developer_id
      and d.profile_id = auth.uid()
  )
);

drop policy if exists "Admins manage OAuth state" on public.oauth_connection_states;
create policy "Admins manage OAuth state"
on public.oauth_connection_states for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Developers read own OAuth state" on public.oauth_connection_states;
create policy "Developers read own OAuth state"
on public.oauth_connection_states for select
using (
  exists (
    select 1
    from public.developers d
    where d.id = oauth_connection_states.developer_id
      and d.profile_id = auth.uid()
  )
);

grant select on public.oauth_connections to authenticated;

select pg_notify('pgrst', 'reload schema');
