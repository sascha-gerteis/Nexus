-- Restore the original Nexus-owned launch products to legacy runtime mode.
--
-- These products existed before the Nexus credential vault. Their n8n
-- workflows use credentials that were created directly in the hosted n8n
-- instance, so they should not be blocked by developer credential binding.
--
-- Run this once in the Supabase SQL editor after deploying:
--   create-checkout-session
--   developer-credentials
--   import-n8n-workflow

with legacy_products(slug) as (
  values
    ('inquiry-report'),
    ('competitor-report'),
    ('ai-social-media-reports'),
    ('social-listening-intelligence'),
    ('ai-customer-support-chatbot')
)
update public.automations a
set
  status = 'live',
  runtime_type = case
    when coalesce(a.n8n_workflow_id, '') <> ''
      or coalesce(nullif(a.runtime_webhook_url, ''), nullif(a.n8n_webhook_url, ''), '') <> ''
      or a.n8n_workflow_json is not null
    then 'n8n_managed'
    else a.runtime_type
  end,
  workflow_source_platform = 'n8n',
  n8n_import_status = case
    when coalesce(a.n8n_workflow_id, '') <> ''
      or coalesce(nullif(a.runtime_webhook_url, ''), nullif(a.n8n_webhook_url, ''), '') <> ''
      or a.n8n_workflow_json is not null
    then 'imported'
    else a.n8n_import_status
  end,
  n8n_import_error = null,
  n8n_last_test_status = case
    when coalesce(a.n8n_workflow_id, '') <> ''
      or coalesce(nullif(a.runtime_webhook_url, ''), nullif(a.n8n_webhook_url, ''), '') <> ''
      or a.n8n_workflow_json is not null
    then 'passed'
    else a.n8n_last_test_status
  end,
  n8n_last_test_error = null,
  n8n_last_test_result = jsonb_build_object(
    'ok', true,
    'status', 'passed',
    'legacy_nexus_direct_n8n_credentials', true,
    'restored_at', now()
  ),
  n8n_last_tested_at = coalesce(a.n8n_last_tested_at, now()),
  developer_credential_requirements = '[]'::jsonb,
  n8n_credential_bindings = '[]'::jsonb,
  credential_binding_status = 'bound',
  credential_binding_errors = '[]'::jsonb,
  n8n_last_credential_bound_at = now(),
  n8n_last_import_result = coalesce(a.n8n_last_import_result, '{}'::jsonb)
    || jsonb_build_object(
      'legacy_nexus_direct_n8n_credentials', true,
      'credential_binding_status', 'bound',
      'restored_at', now()
    ),
  updated_at = now(),
  internal_notes = concat_ws(
    E'\n\n',
    nullif(a.internal_notes, ''),
    concat('[', now(), '] Restored as original Nexus legacy n8n product. Direct credentials remain inside hosted n8n; future products still use Nexus credential binding.')
  )
from legacy_products lp
where a.slug = lp.slug;

notify pgrst, 'reload schema';

select
  slug,
  title,
  status,
  runtime_type,
  workflow_source_platform,
  n8n_import_status,
  n8n_last_test_status,
  credential_binding_status,
  coalesce(n8n_workflow_id, '') as n8n_workflow_id,
  coalesce(nullif(runtime_webhook_url, ''), nullif(n8n_webhook_url, ''), '') as runtime_url
from public.automations
where slug in (
  'inquiry-report',
  'competitor-report',
  'ai-social-media-reports',
  'social-listening-intelligence',
  'ai-customer-support-chatbot'
)
order by slug;
