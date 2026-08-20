begin;

create extension if not exists "pgcrypto";

create table if not exists public.buyer_oauth_connections (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid not null references public.profiles(id) on delete cascade,
  customer_automation_id uuid not null references public.customer_automations(id) on delete cascade,
  automation_id uuid references public.automations(id) on delete cascade,
  provider text not null,
  provider_label text,
  requirement_key text not null,
  label text not null,
  provider_account_email text,
  provider_account_id text,
  scopes text[] not null default '{}'::text[],
  status text not null default 'active',
  encrypted_payload jsonb,
  token_expires_at timestamptz,
  n8n_credential_type text not null,
  n8n_credential_id text,
  n8n_credential_name text,
  last_synced_at timestamptz,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint buyer_oauth_connections_status_check
    check (status in ('active', 'needs_attention', 'revoked'))
);

create table if not exists public.buyer_oauth_connection_states (
  id uuid primary key default gen_random_uuid(),
  state_token text not null unique,
  buyer_id uuid not null references public.profiles(id) on delete cascade,
  customer_automation_id uuid not null references public.customer_automations(id) on delete cascade,
  automation_id uuid references public.automations(id) on delete cascade,
  provider text not null,
  requirement_key text not null,
  credential_type text not null,
  label text not null,
  scope text not null,
  slot jsonb not null default '{}'::jsonb,
  code_verifier text,
  code_challenge text,
  return_url text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists idx_buyer_oauth_connections_active_requirement
  on public.buyer_oauth_connections(customer_automation_id, lower(requirement_key))
  where status <> 'revoked';

create index if not exists idx_buyer_oauth_connections_buyer
  on public.buyer_oauth_connections(buyer_id, customer_automation_id, status);

create index if not exists idx_buyer_oauth_connection_states_expires
  on public.buyer_oauth_connection_states(expires_at);

alter table public.buyer_oauth_connections enable row level security;
alter table public.buyer_oauth_connection_states enable row level security;

drop policy if exists "Admins manage buyer OAuth connections" on public.buyer_oauth_connections;
create policy "Admins manage buyer OAuth connections"
on public.buyer_oauth_connections for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Admins manage buyer OAuth state" on public.buyer_oauth_connection_states;
create policy "Admins manage buyer OAuth state"
on public.buyer_oauth_connection_states for all
using (public.is_admin())
with check (public.is_admin());

-- Buyers deliberately do not receive direct table access because the rows contain
-- encrypted token payloads and n8n credential identifiers. The OAuth Edge Function
-- returns only sanitized connection metadata after checking ownership.
revoke all on public.buyer_oauth_connections from anon, authenticated;
revoke all on public.buyer_oauth_connection_states from anon, authenticated;

select pg_notify('pgrst', 'reload schema');

commit;
