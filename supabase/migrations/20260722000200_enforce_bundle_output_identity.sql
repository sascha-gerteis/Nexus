-- Enforce purchase isolation for every bundle output at the database layer.
-- The bundle run item is the source of truth for order/attempt/run ownership.

create or replace function public.enforce_bundle_output_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  item public.bundle_run_items%rowtype;
begin
  if new.bundle_run_attempt_id is null and new.bundle_run_item_id is null then
    return new;
  end if;

  if new.bundle_run_item_id is null then
    raise exception 'Bundle outputs require bundle_run_item_id';
  end if;

  select * into item
  from public.bundle_run_items
  where id = new.bundle_run_item_id;

  if not found then
    raise exception 'Bundle run item % does not exist', new.bundle_run_item_id;
  end if;

  if new.bundle_run_attempt_id is not null and new.bundle_run_attempt_id <> item.bundle_run_attempt_id then
    raise exception 'Bundle output attempt does not match its run item';
  end if;

  if new.order_id is not null and new.order_id <> item.order_id then
    raise exception 'Bundle output order does not match its run item';
  end if;

  if new.customer_automation_id is not null and new.customer_automation_id <> item.customer_automation_id then
    raise exception 'Bundle output automation does not match its run item';
  end if;

  if item.automation_run_id is not null
     and new.automation_run_id is not null
     and new.automation_run_id <> item.automation_run_id then
    raise exception 'Bundle output run does not match its run item';
  end if;

  new.order_id := item.order_id;
  new.bundle_run_attempt_id := item.bundle_run_attempt_id;
  new.customer_automation_id := item.customer_automation_id;
  new.automation_id := coalesce(item.automation_id, new.automation_id);
  new.buyer_id := coalesce(item.buyer_id, new.buyer_id);
  new.automation_run_id := coalesce(item.automation_run_id, new.automation_run_id);

  return new;
end;
$$;

drop trigger if exists trg_enforce_bundle_output_identity on public.automation_outputs;
create trigger trg_enforce_bundle_output_identity
before insert or update of order_id, customer_automation_id, automation_run_id,
  bundle_run_attempt_id, bundle_run_item_id
on public.automation_outputs
for each row
execute function public.enforce_bundle_output_identity();

-- Repair rows that already carry an exact item identity. Rows without an item
-- remain legacy history and are never used by the exact bundle-attempt UI.
update public.automation_outputs as output
set
  order_id = item.order_id,
  buyer_id = coalesce(item.buyer_id, output.buyer_id),
  customer_automation_id = item.customer_automation_id,
  automation_id = coalesce(item.automation_id, output.automation_id),
  automation_run_id = coalesce(item.automation_run_id, output.automation_run_id),
  bundle_run_attempt_id = item.bundle_run_attempt_id,
  updated_at = now()
from public.bundle_run_items as item
where output.bundle_run_item_id = item.id
  and (
    output.order_id is distinct from item.order_id
    or output.customer_automation_id is distinct from item.customer_automation_id
    or output.bundle_run_attempt_id is distinct from item.bundle_run_attempt_id
    or (item.automation_run_id is not null and output.automation_run_id is distinct from item.automation_run_id)
  );

select pg_notify('pgrst', 'reload schema');
