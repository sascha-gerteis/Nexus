-- One-off cleanup for a deleted n8n Gmail credential that was previously
-- written into the Tech Sales Job Alerts workflow JSON.
--
-- Safe scope:
-- - Only touches automations whose saved JSON/bindings reference the exact
--   stale n8n credential ID below.
-- - Does not delete products, workflows, or developer credentials.
-- - Removes the stale credential reference from saved Nexus JSON so a fresh
--   n8n editor sync can store the currently selected live credential.

do $$
declare
  stale_id constant text := 'hqfqeOuCoYjw0ZHL';
begin
  create or replace function pg_temp.nexus_strip_stale_n8n_credential(
    workflow jsonb,
    stale_credential_id text
  )
  returns jsonb
  language plpgsql
  as $fn$
  declare
    node jsonb;
    key text;
    value jsonb;
    new_nodes jsonb := '[]'::jsonb;
    new_credentials jsonb;
  begin
    if workflow is null
      or jsonb_typeof(workflow) <> 'object'
      or jsonb_typeof(workflow->'nodes') <> 'array'
    then
      return workflow;
    end if;

    for node in select * from jsonb_array_elements(workflow->'nodes')
    loop
      if jsonb_typeof(node->'credentials') = 'object' then
        new_credentials := '{}'::jsonb;

        for key, value in select * from jsonb_each(node->'credentials')
        loop
          if coalesce(value->>'id', '') <> stale_credential_id then
            new_credentials := new_credentials || jsonb_build_object(key, value);
          end if;
        end loop;

        if new_credentials = '{}'::jsonb then
          node := node - 'credentials';
        else
          node := jsonb_set(node, '{credentials}', new_credentials, false);
        end if;
      end if;

      new_nodes := new_nodes || jsonb_build_array(node);
    end loop;

    return jsonb_set(workflow, '{nodes}', new_nodes, false);
  end;
  $fn$;

  update public.automations
  set
    n8n_workflow_json = pg_temp.nexus_strip_stale_n8n_credential(n8n_workflow_json, stale_id),
    n8n_normalized_workflow_json = pg_temp.nexus_strip_stale_n8n_credential(n8n_normalized_workflow_json, stale_id),
    n8n_credential_bindings = coalesce(
      (
        select jsonb_agg(binding)
        from jsonb_array_elements(coalesce(n8n_credential_bindings, '[]'::jsonb)) as binding
        where binding::text not like '%' || stale_id || '%'
      ),
      '[]'::jsonb
    ),
    credential_binding_errors = coalesce(
      (
        select jsonb_agg(binding_error)
        from jsonb_array_elements(coalesce(credential_binding_errors, '[]'::jsonb)) as binding_error
        where binding_error::text not like '%' || stale_id || '%'
      ),
      '[]'::jsonb
    ),
    credential_binding_status = case
      when credential_binding_status = 'bound' then 'not_checked'
      else credential_binding_status
    end,
    n8n_last_test_status = 'not_tested',
    n8n_last_test_error = null,
    updated_at = now()
  where coalesce(n8n_credential_bindings::text, '') like '%' || stale_id || '%'
     or coalesce(credential_binding_errors::text, '') like '%' || stale_id || '%'
     or coalesce(n8n_workflow_json::text, '') like '%' || stale_id || '%'
     or coalesce(n8n_normalized_workflow_json::text, '') like '%' || stale_id || '%';

  perform pg_notify('pgrst', 'reload schema');
end $$;
