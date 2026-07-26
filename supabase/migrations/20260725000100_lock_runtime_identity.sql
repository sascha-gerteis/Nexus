begin;

create or replace function public.enforce_automation_run_purchase_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  linked_automation public.customer_automations%rowtype;
begin
  if new.customer_automation_id is null then
    return new;
  end if;

  select *
  into linked_automation
  from public.customer_automations
  where id = new.customer_automation_id;

  if not found then
    raise exception 'Automation run customer automation % does not exist', new.customer_automation_id;
  end if;

  if linked_automation.order_id is distinct from new.order_id then
    raise exception 'Automation run order does not match its customer automation';
  end if;

  if new.buyer_id is not null
     and linked_automation.buyer_id is not null
     and linked_automation.buyer_id is distinct from new.buyer_id then
    raise exception 'Automation run buyer does not match its customer automation';
  end if;

  if new.automation_id is not null
     and linked_automation.automation_id is not null
     and linked_automation.automation_id is distinct from new.automation_id then
    raise exception 'Automation run product does not match its customer automation';
  end if;

  new.buyer_id := coalesce(new.buyer_id, linked_automation.buyer_id);
  new.automation_id := coalesce(new.automation_id, linked_automation.automation_id);
  return new;
end;
$$;

drop trigger if exists automation_runs_purchase_identity_guard
on public.automation_runs;

create trigger automation_runs_purchase_identity_guard
before insert or update of order_id, customer_automation_id, buyer_id, automation_id
on public.automation_runs
for each row
execute function public.enforce_automation_run_purchase_identity();

do $$
begin
  if exists (
    select 1
    from public.automation_runs
    where run_key is not null and run_key <> ''
    group by run_key
    having count(*) > 1
  ) then
    raise exception 'Cannot enforce unique automation run keys while duplicate run_key rows exist';
  end if;

  if exists (
    select 1
    from public.automation_outputs
    where automation_run_id is not null
    group by automation_run_id
    having count(*) > 1
  ) then
    raise exception 'Cannot enforce one output per automation run while duplicate runtime outputs exist';
  end if;

  if exists (
    select 1
    from public.automation_outputs
    where bundle_run_item_id is not null
    group by bundle_run_item_id
    having count(*) > 1
  ) then
    raise exception 'Cannot enforce one output per bundle item while duplicate bundle outputs exist';
  end if;
end;
$$;

create unique index if not exists idx_automation_runs_run_key_unique
  on public.automation_runs(run_key)
  where run_key is not null and run_key <> '';

create unique index if not exists idx_automation_outputs_run_unique
  on public.automation_outputs(automation_run_id)
  where automation_run_id is not null;

create unique index if not exists idx_automation_outputs_bundle_item_unique
  on public.automation_outputs(bundle_run_item_id)
  where bundle_run_item_id is not null;

comment on function public.enforce_automation_run_purchase_identity() is
  'Prevents automation runs from crossing customer automation, order, buyer, or product ownership.';

commit;
