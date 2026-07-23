-- Restore products that were accidentally paused by the too-strict workflow readiness rule.
-- Review the SELECT first. Then run the UPDATE only for products you want live again.

select
  id,
  title,
  slug,
  status,
  listing_type,
  developer_id,
  n8n_workflow_json is not null as has_workflow_json,
  n8n_workflow_id,
  runtime_webhook_url,
  n8n_webhook_url,
  updated_at
from public.automations
where status = 'paused'
  and coalesce(listing_type, 'standard') <> 'custom_request'
  and (
    n8n_workflow_json is not null
    or nullif(n8n_workflow_id, '') is not null
    or nullif(runtime_webhook_url, '') is not null
    or nullif(n8n_webhook_url, '') is not null
  )
order by updated_at desc;

-- Uncomment after reviewing the rows above.
-- update public.automations
-- set
--   status = 'live',
--   updated_at = now()
-- where status = 'paused'
--   and coalesce(listing_type, 'standard') <> 'custom_request'
--   and (
--     n8n_workflow_json is not null
--     or nullif(n8n_workflow_id, '') is not null
--     or nullif(runtime_webhook_url, '') is not null
--     or nullif(n8n_webhook_url, '') is not null
--   );
--
-- select pg_notify('pgrst', 'reload schema');
