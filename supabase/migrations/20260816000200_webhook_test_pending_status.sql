alter table public.customer_automation_webhook_tests
  drop constraint if exists customer_automation_webhook_tests_status_check;

alter table public.customer_automation_webhook_tests
  add constraint customer_automation_webhook_tests_status_check
  check (status in ('pending', 'succeeded', 'failed'));

select pg_notify('pgrst', 'reload schema');
