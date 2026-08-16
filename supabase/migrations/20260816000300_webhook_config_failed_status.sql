alter table public.customer_automation_webhook_configs
  drop constraint if exists customer_automation_webhook_configs_inbound_status_check;

alter table public.customer_automation_webhook_configs
  add constraint customer_automation_webhook_configs_inbound_status_check
  check (inbound_status in ('awaiting_test', 'test_received', 'test_failed', 'confirmed', 'disabled'));

select pg_notify('pgrst', 'reload schema');
