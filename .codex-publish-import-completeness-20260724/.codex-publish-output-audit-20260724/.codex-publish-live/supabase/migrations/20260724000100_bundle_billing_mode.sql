-- Bundle-level billing is authoritative for Stripe checkout and fulfillment.
alter table if exists public.automation_bundles
  add column if not exists pricing_type text not null default 'monthly';

update public.automation_bundles
set pricing_type = 'monthly'
where lower(coalesce(pricing_type, '')) not in ('monthly', 'one_time');

alter table if exists public.automation_bundles
  drop constraint if exists automation_bundles_pricing_type_check;

alter table if exists public.automation_bundles
  add constraint automation_bundles_pricing_type_check
  check (pricing_type in ('monthly', 'one_time'));

select pg_notify('pgrst', 'reload schema');