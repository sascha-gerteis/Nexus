-- Buyer-owned webhook event-to-runtime mapping.
-- This phase prepares and confirms the runtime envelope but cannot dispatch it.

alter table public.customer_automation_webhook_configs
  add column if not exists event_mapping jsonb not null default '[]'::jsonb,
  add column if not exists event_mapping_status text not null default 'not_configured',
  add column if not exists event_mapping_last_event_id text,
  add column if not exists event_mapping_last_validated_at timestamptz,
  add column if not exists event_mapping_last_error text,
  add column if not exists event_mapping_preview jsonb not null default '{}'::jsonb,
  add column if not exists event_mapping_confirmed_at timestamptz,
  add column if not exists runtime_contract_version text not null default 'nexus_runtime_v1';

alter table public.customer_automation_webhook_configs
  drop constraint if exists customer_automation_webhook_configs_event_mapping_check;
alter table public.customer_automation_webhook_configs
  add constraint customer_automation_webhook_configs_event_mapping_check
  check (jsonb_typeof(event_mapping) = 'array');

alter table public.customer_automation_webhook_configs
  drop constraint if exists customer_automation_webhook_configs_mapping_status_check;
alter table public.customer_automation_webhook_configs
  add constraint customer_automation_webhook_configs_mapping_status_check
  check (event_mapping_status in (
    'not_configured',
    'awaiting_validation',
    'validation_failed',
    'validated',
    'confirmed'
  ));

alter table public.customer_automation_webhook_configs
  drop constraint if exists customer_automation_webhook_configs_runtime_contract_check;
alter table public.customer_automation_webhook_configs
  add constraint customer_automation_webhook_configs_runtime_contract_check
  check (runtime_contract_version = 'nexus_runtime_v1');

-- A later usage-entitlement migration must explicitly remove this gate before
-- external events are allowed to create paid runtime runs.
alter table public.customer_automation_webhook_configs
  drop constraint if exists customer_automation_webhook_configs_mapping_phase_live_gate;
alter table public.customer_automation_webhook_configs
  add constraint customer_automation_webhook_configs_mapping_phase_live_gate
  check (live_enabled = false);

create unique index if not exists customer_automation_webhook_tests_event_identity_idx
  on public.customer_automation_webhook_tests(webhook_config_id, direction, event_id)
  where event_id is not null;

select pg_notify('pgrst', 'reload schema');
