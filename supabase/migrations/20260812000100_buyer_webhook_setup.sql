-- Buyer-managed webhook connection setup.
-- This migration intentionally creates test-only webhook configuration.
-- Live runtime dispatch remains disabled until usage entitlements are enforced.

create extension if not exists pgcrypto;

create table if not exists public.customer_automation_webhook_configs (
  id uuid primary key default gen_random_uuid(),
  customer_automation_id uuid not null unique
    references public.customer_automations(id) on delete cascade,
  buyer_id uuid not null references public.profiles(id) on delete cascade,
  inbound_endpoint_id uuid not null unique default gen_random_uuid(),
  inbound_secret_hash text not null,
  inbound_secret_hint text not null default '',
  inbound_status text not null default 'awaiting_test'
    check (inbound_status in ('awaiting_test', 'test_received', 'confirmed', 'disabled')),
  inbound_last_received_at timestamptz,
  inbound_last_event_id text,
  inbound_last_payload_preview jsonb not null default '{}'::jsonb,
  outbound_url text,
  outbound_status text not null default 'not_configured'
    check (outbound_status in ('not_configured', 'awaiting_test', 'test_succeeded', 'confirmed', 'test_failed', 'disabled')),
  outbound_last_tested_at timestamptz,
  outbound_last_status_code integer,
  outbound_last_error text,
  inbound_confirmed_at timestamptz,
  outbound_confirmed_at timestamptz,
  live_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.customer_automation_webhook_tests (
  id uuid primary key default gen_random_uuid(),
  webhook_config_id uuid not null
    references public.customer_automation_webhook_configs(id) on delete cascade,
  customer_automation_id uuid not null
    references public.customer_automations(id) on delete cascade,
  buyer_id uuid not null references public.profiles(id) on delete cascade,
  direction text not null check (direction in ('inbound', 'outbound')),
  status text not null check (status in ('succeeded', 'failed')),
  event_id text,
  response_status integer,
  error_message text,
  payload_preview jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists customer_automation_webhook_configs_buyer_idx
  on public.customer_automation_webhook_configs(buyer_id, updated_at desc);

create index if not exists customer_automation_webhook_tests_config_idx
  on public.customer_automation_webhook_tests(webhook_config_id, created_at desc);

create index if not exists customer_automation_webhook_tests_buyer_idx
  on public.customer_automation_webhook_tests(buyer_id, created_at desc);

alter table public.customer_automation_webhook_configs enable row level security;
alter table public.customer_automation_webhook_tests enable row level security;

-- All reads and writes go through buyer-authenticated Edge Functions. Keeping
-- these tables unavailable to anon/authenticated prevents secret hashes and
-- test payload previews from being queried directly in the browser.
revoke all on public.customer_automation_webhook_configs from anon, authenticated;
revoke all on public.customer_automation_webhook_tests from anon, authenticated;
grant all on public.customer_automation_webhook_configs to service_role;
grant all on public.customer_automation_webhook_tests to service_role;

select pg_notify('pgrst', 'reload schema');
