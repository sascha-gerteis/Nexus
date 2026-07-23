-- Nexus locked embedded n8n editor install/patch.
-- Run this in the Supabase SQL editor, then deploy:
--   npx.cmd supabase functions deploy n8n-editor-gateway --project-ref YOUR_PROJECT_REF
--   npx.cmd supabase functions deploy import-n8n-workflow --project-ref YOUR_PROJECT_REF
--   npx.cmd supabase functions deploy test-n8n-workflow --project-ref YOUR_PROJECT_REF
--
-- Required Edge Function secrets:
--   N8N_BASE_URL
--   N8N_API_KEY
--   N8N_EDITOR_EMAIL
--   N8N_EDITOR_PASSWORD
--   N8N_EDITOR_SESSION_SECRET
-- Optional:
--   NEXUS_APP_ORIGIN=https://nexus-ai.software

create extension if not exists "pgcrypto";

create table if not exists public.n8n_editor_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  automation_id uuid not null references public.automations(id) on delete cascade,
  n8n_workflow_id text not null,
  profile_id uuid references public.profiles(id) on delete cascade,
  developer_id uuid references public.developers(id) on delete cascade,
  role text not null,
  encrypted_n8n_cookie jsonb,
  status text not null default 'active',
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint n8n_editor_sessions_role_check
    check (role in ('admin', 'developer')),
  constraint n8n_editor_sessions_status_check
    check (status in ('active', 'revoked', 'expired'))
);

create index if not exists idx_n8n_editor_sessions_automation
  on public.n8n_editor_sessions(automation_id);

create index if not exists idx_n8n_editor_sessions_profile
  on public.n8n_editor_sessions(profile_id);

create index if not exists idx_n8n_editor_sessions_expires
  on public.n8n_editor_sessions(expires_at);

alter table public.n8n_editor_sessions enable row level security;

drop policy if exists "No direct client access to n8n editor sessions" on public.n8n_editor_sessions;
create policy "No direct client access to n8n editor sessions"
on public.n8n_editor_sessions
for all
using (false)
with check (false);

revoke all on public.n8n_editor_sessions from anon;
revoke all on public.n8n_editor_sessions from authenticated;

select pg_notify('pgrst', 'reload schema');
