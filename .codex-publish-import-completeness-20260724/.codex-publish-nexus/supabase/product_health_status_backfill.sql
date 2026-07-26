-- Backfill product health from the latest technical workflow test.
-- Use this after deploying the product health checker when older products still show unknown/needs_recheck.

update public.automations
set
  health_status = case
    when lower(coalesce(n8n_last_test_status, '')) in ('passed', 'passed_with_expected_test_callback_error', 'success', 'succeeded', 'completed')
      then 'healthy'
    when lower(coalesce(n8n_last_test_status, '')) in ('failed', 'error', 'cancelled', 'canceled')
      then case
        when lower(coalesce(status, '')) = 'live' then 'paused_by_health_check'
        else 'failed'
      end
    when coalesce(n8n_workflow_id, '') <> '' or n8n_workflow_json is not null
      then 'needs_recheck'
    else coalesce(nullif(health_status, ''), 'unknown')
  end,
  health_last_checked_at = case
    when n8n_last_tested_at is not null
      then coalesce(health_last_checked_at, n8n_last_tested_at)
    else health_last_checked_at
  end,
  health_last_passed_at = case
    when lower(coalesce(n8n_last_test_status, '')) in ('passed', 'passed_with_expected_test_callback_error', 'success', 'succeeded', 'completed')
      then coalesce(health_last_passed_at, n8n_last_tested_at, now())
    else health_last_passed_at
  end,
  health_last_failed_at = case
    when lower(coalesce(n8n_last_test_status, '')) in ('failed', 'error', 'cancelled', 'canceled')
      then coalesce(health_last_failed_at, n8n_last_tested_at, now())
    else health_last_failed_at
  end,
  health_failure_reason = case
    when lower(coalesce(n8n_last_test_status, '')) in ('passed', 'passed_with_expected_test_callback_error', 'success', 'succeeded', 'completed')
      then null
    when lower(coalesce(n8n_last_test_status, '')) in ('failed', 'error', 'cancelled', 'canceled')
      then coalesce(n8n_last_test_error, health_failure_reason, 'Latest technical workflow check failed.')
    else health_failure_reason
  end,
  health_failure_details = case
    when lower(coalesce(n8n_last_test_status, '')) in ('passed', 'passed_with_expected_test_callback_error', 'success', 'succeeded', 'completed')
      then '{}'::jsonb
    else coalesce(health_failure_details, '{}'::jsonb)
  end,
  health_consecutive_failures = case
    when lower(coalesce(n8n_last_test_status, '')) in ('passed', 'passed_with_expected_test_callback_error', 'success', 'succeeded', 'completed')
      then 0
    else coalesce(health_consecutive_failures, 0)
  end,
  health_next_check_at = case
    when lower(coalesce(n8n_last_test_status, '')) in ('passed', 'passed_with_expected_test_callback_error', 'success', 'succeeded', 'completed')
      then coalesce(health_next_check_at, now() + interval '30 minutes')
    else health_next_check_at
  end
where
  lower(coalesce(listing_type, '')) <> 'custom_request'
  and (
    lower(coalesce(health_status, 'unknown')) in ('unknown', 'needs_recheck', 'skipped')
    or health_status is null
  );

select pg_notify('pgrst', 'reload schema');
