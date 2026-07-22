-- Fail closed for bundle runtime identity.
-- Bundle workflows and outputs must always point to one exact purchase attempt,
-- one attempt item, and one automation run.

create or replace function public.enforce_bundle_run_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  item public.bundle_run_items%rowtype;
  is_bundle_order boolean := false;
begin
  if new.order_id is not null then
    select exists (
      select 1
      from public.orders as bundle_order
      where bundle_order.id = new.order_id
        and (
          lower(coalesce(bundle_order.order_type, '')) = 'bundle'
          or bundle_order.bundle_id is not null
        )
    ) into is_bundle_order;
  end if;

  is_bundle_order := is_bundle_order
    or new.bundle_run_attempt_id is not null
    or new.bundle_run_item_id is not null;

  if not is_bundle_order then
    return new;
  end if;

  if new.bundle_run_attempt_id is null or new.bundle_run_item_id is null then
    raise exception 'Bundle automation runs require bundle_run_attempt_id and bundle_run_item_id';
  end if;

  select * into item
  from public.bundle_run_items
  where id = new.bundle_run_item_id;

  if not found then
    raise exception 'Bundle run item % does not exist', new.bundle_run_item_id;
  end if;

  if item.bundle_run_attempt_id <> new.bundle_run_attempt_id then
    raise exception 'Bundle automation run attempt does not match its run item';
  end if;

  if item.order_id is distinct from new.order_id then
    raise exception 'Bundle automation run order does not match its run item';
  end if;

  if item.customer_automation_id is distinct from new.customer_automation_id then
    raise exception 'Bundle automation run customer automation does not match its run item';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_bundle_run_identity on public.automation_runs;
create trigger trg_enforce_bundle_run_identity
before insert or update of order_id, customer_automation_id,
  bundle_run_attempt_id, bundle_run_item_id
on public.automation_runs
for each row
execute function public.enforce_bundle_run_identity();

create or replace function public.enforce_bundle_output_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  item public.bundle_run_items%rowtype;
  is_bundle_order boolean := false;
begin
  if new.order_id is not null then
    select exists (
      select 1
      from public.orders as bundle_order
      where bundle_order.id = new.order_id
        and (
          lower(coalesce(bundle_order.order_type, '')) = 'bundle'
          or bundle_order.bundle_id is not null
        )
    ) into is_bundle_order;
  end if;

  if not is_bundle_order and new.customer_automation_id is not null then
    select exists (
      select 1
      from public.customer_automations as customer_automation
      join public.orders as bundle_order on bundle_order.id = customer_automation.order_id
      where customer_automation.id = new.customer_automation_id
        and (
          lower(coalesce(bundle_order.order_type, '')) = 'bundle'
          or bundle_order.bundle_id is not null
        )
    ) into is_bundle_order;
  end if;

  is_bundle_order := is_bundle_order
    or new.bundle_run_attempt_id is not null
    or new.bundle_run_item_id is not null;

  if not is_bundle_order then
    return new;
  end if;

  if new.bundle_run_attempt_id is null
     or new.bundle_run_item_id is null
     or new.automation_run_id is null then
    raise exception 'Bundle outputs require bundle_run_attempt_id, bundle_run_item_id, and automation_run_id';
  end if;

  select * into item
  from public.bundle_run_items
  where id = new.bundle_run_item_id;

  if not found then
    raise exception 'Bundle run item % does not exist', new.bundle_run_item_id;
  end if;

  if item.bundle_run_attempt_id <> new.bundle_run_attempt_id then
    raise exception 'Bundle output attempt does not match its run item';
  end if;

  if item.order_id is distinct from new.order_id then
    raise exception 'Bundle output order does not match its run item';
  end if;

  if item.customer_automation_id is distinct from new.customer_automation_id then
    raise exception 'Bundle output customer automation does not match its run item';
  end if;

  if item.automation_run_id is null or item.automation_run_id <> new.automation_run_id then
    raise exception 'Bundle output automation run does not match its run item';
  end if;

  new.order_id := item.order_id;
  new.bundle_run_attempt_id := item.bundle_run_attempt_id;
  new.customer_automation_id := item.customer_automation_id;
  new.automation_id := coalesce(item.automation_id, new.automation_id);
  new.buyer_id := coalesce(item.buyer_id, new.buyer_id);

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

select pg_notify('pgrst', 'reload schema');