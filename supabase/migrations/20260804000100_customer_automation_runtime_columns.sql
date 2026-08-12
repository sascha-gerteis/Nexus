-- Keep paid-order provisioning compatible with the runtime fields written by
-- Stripe checkout, bundle provisioning, scheduling, and output delivery.
alter table public.customer_automations
  add column if not exists runtime_trigger_mode text,
  add column if not exists runtime_output_mode text not null default 'standard',
  add column if not exists runtime_no_change_policy text,
  add column if not exists runtime_response_mode text;

select pg_notify('pgrst', 'reload schema');
