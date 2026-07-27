alter table public.automations
  add column if not exists guided_install_enabled boolean not null default false;

update public.automations
set guided_install_enabled = true
where developer_id is null
  and coalesce(listing_type, 'standard') <> 'custom_request';

select pg_notify('pgrst', 'reload schema');
