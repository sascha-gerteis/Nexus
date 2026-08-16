alter table public.customer_automation_webhook_configs
  add column if not exists inbound_test_started_at timestamptz;

comment on column public.customer_automation_webhook_configs.inbound_test_started_at is
  'Server timestamp for the latest buyer-started inbound connection test. Confirmation requires a newer authenticated receipt.';
