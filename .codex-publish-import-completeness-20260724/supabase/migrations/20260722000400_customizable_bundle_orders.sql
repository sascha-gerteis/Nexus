-- Customized bundle purchases are defined by their active order_items.
-- Every downstream customer automation and run item must belong to that exact
-- order selection. This keeps checkout, setup, execution, and output isolated.

create or replace function public.enforce_bundle_order_selection()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_order public.orders%rowtype;
  strict_selection boolean := false;
begin
  if new.order_id is null then
    return new;
  end if;

  select * into selected_order
  from public.orders
  where id = new.order_id;

  if not found then
    return new;
  end if;

  strict_selection :=
    (
      lower(coalesce(selected_order.order_type, '')) = 'bundle'
      or selected_order.bundle_id is not null
    )
    and coalesce((selected_order.bundle_snapshot->>'selection_version')::integer, 0) >= 1;

  if not strict_selection then
    return new;
  end if;

  if new.automation_id is null or not exists (
    select 1
    from public.order_items as selected_item
    where selected_item.order_id = new.order_id
      and selected_item.automation_id = new.automation_id
      and selected_item.status = 'active'
  ) then
    raise exception 'Automation % is not selected for customized bundle order %',
      new.automation_id, new.order_id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_customer_automation_bundle_selection
  on public.customer_automations;
create trigger trg_enforce_customer_automation_bundle_selection
before insert or update of order_id, automation_id
on public.customer_automations
for each row
execute function public.enforce_bundle_order_selection();

create or replace function public.enforce_bundle_run_item_selection()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  selected_order public.orders%rowtype;
  selected_automation_id uuid;
  strict_selection boolean := false;
begin
  if new.order_id is null then
    return new;
  end if;

  select * into selected_order
  from public.orders
  where id = new.order_id;

  if not found then
    return new;
  end if;

  strict_selection :=
    (
      lower(coalesce(selected_order.order_type, '')) = 'bundle'
      or selected_order.bundle_id is not null
    )
    and coalesce((selected_order.bundle_snapshot->>'selection_version')::integer, 0) >= 1;

  if not strict_selection then
    return new;
  end if;

  selected_automation_id := new.automation_id;
  if selected_automation_id is null and new.customer_automation_id is not null then
    select automation_id into selected_automation_id
    from public.customer_automations
    where id = new.customer_automation_id;
  end if;

  if selected_automation_id is null or not exists (
    select 1
    from public.order_items as selected_item
    where selected_item.order_id = new.order_id
      and selected_item.automation_id = selected_automation_id
      and selected_item.status = 'active'
  ) then
    raise exception 'Run item automation % is not selected for customized bundle order %',
      selected_automation_id, new.order_id;
  end if;

  new.automation_id := selected_automation_id;
  return new;
end;
$$;

drop trigger if exists trg_enforce_bundle_run_item_selection
  on public.bundle_run_items;
create trigger trg_enforce_bundle_run_item_selection
before insert or update of order_id, automation_id, customer_automation_id
on public.bundle_run_items
for each row
execute function public.enforce_bundle_run_item_selection();

-- Service-role audit surface. Any returned row is a production integrity issue.
create or replace view public.bundle_purchase_integrity_issues as
select
  'unselected_customer_automation'::text as issue_type,
  selected_order.id as order_id,
  customer_automation.id as record_id,
  customer_automation.automation_id,
  jsonb_build_object(
    'customer_automation_id', customer_automation.id,
    'bundle_id', selected_order.bundle_id
  ) as details
from public.orders as selected_order
join public.customer_automations as customer_automation
  on customer_automation.order_id = selected_order.id
left join public.order_items as selected_item
  on selected_item.order_id = selected_order.id
 and selected_item.automation_id = customer_automation.automation_id
 and selected_item.status = 'active'
where coalesce((selected_order.bundle_snapshot->>'selection_version')::integer, 0) >= 1
  and selected_item.id is null

union all

select
  'unselected_bundle_run_item'::text as issue_type,
  run_item.order_id,
  run_item.id as record_id,
  run_item.automation_id,
  jsonb_build_object(
    'bundle_run_attempt_id', run_item.bundle_run_attempt_id,
    'customer_automation_id', run_item.customer_automation_id
  ) as details
from public.bundle_run_items as run_item
join public.orders as selected_order
  on selected_order.id = run_item.order_id
left join public.order_items as selected_item
  on selected_item.order_id = run_item.order_id
 and selected_item.automation_id = run_item.automation_id
 and selected_item.status = 'active'
where coalesce((selected_order.bundle_snapshot->>'selection_version')::integer, 0) >= 1
  and selected_item.id is null

union all

select
  'invalid_bundle_output_identity'::text as issue_type,
  output.order_id,
  output.id as record_id,
  output.automation_id,
  jsonb_build_object(
    'bundle_run_attempt_id', output.bundle_run_attempt_id,
    'bundle_run_item_id', output.bundle_run_item_id,
    'automation_run_id', output.automation_run_id
  ) as details
from public.automation_outputs as output
join public.orders as selected_order
  on selected_order.id = output.order_id
left join public.bundle_run_items as run_item
  on run_item.id = output.bundle_run_item_id
where (
    lower(coalesce(selected_order.order_type, '')) = 'bundle'
    or selected_order.bundle_id is not null
  )
  and (
    output.bundle_run_attempt_id is null
    or output.bundle_run_item_id is null
    or output.automation_run_id is null
    or run_item.id is null
    or run_item.order_id is distinct from output.order_id
    or run_item.bundle_run_attempt_id is distinct from output.bundle_run_attempt_id
    or run_item.automation_run_id is distinct from output.automation_run_id
    or run_item.customer_automation_id is distinct from output.customer_automation_id
  );

revoke all on public.bundle_purchase_integrity_issues from anon, authenticated;
grant select on public.bundle_purchase_integrity_issues to service_role;

select pg_notify('pgrst', 'reload schema');