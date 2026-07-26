begin;

create or replace function public.enforce_runtime_output_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  linked_run public.automation_runs%rowtype;
begin
  if coalesce(new.created_by, '') <> 'runtime' then
    return new;
  end if;

  if new.order_id is null
     or new.customer_automation_id is null
     or new.automation_run_id is null then
    raise exception
      'Runtime outputs require order_id, customer_automation_id, and automation_run_id';
  end if;

  select *
  into linked_run
  from public.automation_runs
  where id = new.automation_run_id;

  if not found then
    raise exception 'Runtime output automation run % does not exist', new.automation_run_id;
  end if;

  if linked_run.order_id is distinct from new.order_id then
    raise exception 'Runtime output order does not match its automation run';
  end if;

  if linked_run.customer_automation_id is distinct from new.customer_automation_id then
    raise exception 'Runtime output customer automation does not match its automation run';
  end if;

  if new.buyer_id is not null
     and linked_run.buyer_id is not null
     and linked_run.buyer_id is distinct from new.buyer_id then
    raise exception 'Runtime output buyer does not match its automation run';
  end if;

  if new.automation_id is not null
     and linked_run.automation_id is not null
     and linked_run.automation_id is distinct from new.automation_id then
    raise exception 'Runtime output product does not match its automation run';
  end if;

  new.buyer_id := coalesce(new.buyer_id, linked_run.buyer_id);
  new.automation_id := coalesce(new.automation_id, linked_run.automation_id);
  return new;
end;
$$;

drop trigger if exists automation_outputs_runtime_identity_guard
on public.automation_outputs;

create trigger automation_outputs_runtime_identity_guard
before insert or update of order_id, customer_automation_id, automation_run_id,
  buyer_id, automation_id, created_by
on public.automation_outputs
for each row
execute function public.enforce_runtime_output_identity();

comment on function public.enforce_runtime_output_identity() is
  'Prevents runtime callbacks from creating outputs for a different purchase or automation run.';

commit;