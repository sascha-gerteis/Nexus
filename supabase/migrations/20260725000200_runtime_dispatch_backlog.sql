-- Durable runtime dispatch outbox.
-- A setup or scheduled run is queued before Nexus contacts n8n. The queue is
-- service-role only and is drained once per minute by an authenticated worker.

alter table public.automation_setup_submissions
  add column if not exists setup_answers jsonb not null default '{}'::jsonb,
  add column if not exists credential_keys_available text[] not null default '{}'::text[],
  add column if not exists submitted_at timestamptz;

-- Older deployments stored the raw form object in answers. Remove every key
-- that is held in the service-only credential table and keep only non-secret
-- setup values in both compatibility columns.
with redacted as (
  select
    submission.id,
    submission.answers - coalesce(
      array_agg(distinct coalesce(credential.credential_key, credential.key))
        filter (where coalesce(credential.credential_key, credential.key) is not null),
      '{}'::text[]
    ) as safe_answers
  from public.automation_setup_submissions as submission
  left join public.customer_automation_credentials as credential
    on credential.customer_automation_id = submission.customer_automation_id
  group by submission.id, submission.answers
)
update public.automation_setup_submissions as submission
set
  answers = redacted.safe_answers,
  setup_answers = redacted.safe_answers,
  submitted_at = coalesce(submission.submitted_at, submission.created_at),
  updated_at = now()
from redacted
where submission.id = redacted.id;
create table if not exists public.runtime_dispatch_queue (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.automation_runs(id) on delete cascade,
  customer_automation_id uuid not null references public.customer_automations(id) on delete cascade,
  setup_submission_id uuid references public.automation_setup_submissions(id) on delete set null,
  dispatch_origin text not null default 'setup_submit',
  event_payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending',
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_attempt_at timestamptz,
  locked_at timestamptz,
  worker_id uuid,
  accepted_at timestamptz,
  last_error_code text,
  last_error_message text,
  last_error_details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint runtime_dispatch_queue_run_unique unique (run_id),
  constraint runtime_dispatch_queue_status_check
    check (status in ('pending', 'processing', 'accepted', 'dead_letter', 'cancelled')),
  constraint runtime_dispatch_queue_attempt_count_check check (attempt_count >= 0),
  constraint runtime_dispatch_queue_origin_check
    check (dispatch_origin in ('setup_submit', 'scheduled', 'manual'))
);

create index if not exists idx_runtime_dispatch_queue_due
  on public.runtime_dispatch_queue(next_attempt_at, created_at)
  where status = 'pending';

create index if not exists idx_runtime_dispatch_queue_stale_lock
  on public.runtime_dispatch_queue(locked_at)
  where status = 'processing';

create index if not exists idx_runtime_dispatch_queue_customer
  on public.runtime_dispatch_queue(customer_automation_id, created_at desc);

create or replace function public.enforce_runtime_dispatch_identity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  linked_run public.automation_runs%rowtype;
  linked_submission public.automation_setup_submissions%rowtype;
begin
  select *
  into linked_run
  from public.automation_runs
  where id = new.run_id;

  if not found then
    raise exception 'Runtime dispatch run % does not exist', new.run_id;
  end if;

  if linked_run.customer_automation_id is distinct from new.customer_automation_id then
    raise exception 'Runtime dispatch customer automation does not match its run';
  end if;

  if new.setup_submission_id is not null then
    select *
    into linked_submission
    from public.automation_setup_submissions
    where id = new.setup_submission_id;

    if not found then
      raise exception 'Runtime dispatch setup submission % does not exist', new.setup_submission_id;
    end if;

    if linked_submission.customer_automation_id is distinct from new.customer_automation_id then
      raise exception 'Runtime dispatch setup submission does not match its customer automation';
    end if;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists runtime_dispatch_queue_identity_guard
on public.runtime_dispatch_queue;

create trigger runtime_dispatch_queue_identity_guard
before insert or update of run_id, customer_automation_id, setup_submission_id
on public.runtime_dispatch_queue
for each row
execute function public.enforce_runtime_dispatch_identity();

create or replace function public.claim_runtime_dispatch_queue(
  p_limit integer,
  p_worker_id uuid
)
returns setof public.runtime_dispatch_queue
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_worker_id is null then
    raise exception 'worker_id is required';
  end if;

  return query
  with due as (
    select queue.id
    from public.runtime_dispatch_queue as queue
    where (
      queue.status = 'pending'
      and queue.next_attempt_at <= now()
    ) or (
      queue.status = 'processing'
      and queue.locked_at < now() - interval '5 minutes'
    )
    order by queue.next_attempt_at asc, queue.created_at asc
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  )
  update public.runtime_dispatch_queue as queue
  set
    status = 'processing',
    worker_id = p_worker_id,
    locked_at = now(),
    last_attempt_at = now(),
    attempt_count = queue.attempt_count + 1,
    updated_at = now()
  from due
  where queue.id = due.id
  returning queue.*;
end;
$$;

create table if not exists public.runtime_dispatch_worker_config (
  singleton boolean primary key default true check (singleton),
  token_hash text not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz not null default now()
);

create or replace function public.authorize_runtime_dispatch_worker(p_token text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
    from public.runtime_dispatch_worker_config
    where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
  );
$$;

alter table public.runtime_dispatch_queue enable row level security;
alter table public.runtime_dispatch_worker_config enable row level security;

revoke all on public.runtime_dispatch_queue from anon, authenticated;
revoke all on public.runtime_dispatch_worker_config from anon, authenticated;
revoke all on function public.claim_runtime_dispatch_queue(integer, uuid) from public, anon, authenticated;
revoke all on function public.authorize_runtime_dispatch_worker(text) from public, anon, authenticated;

grant all on public.runtime_dispatch_queue to service_role;
grant all on public.runtime_dispatch_worker_config to service_role;
grant execute on function public.claim_runtime_dispatch_queue(integer, uuid) to service_role;
grant execute on function public.authorize_runtime_dispatch_worker(text) to service_role;

do $$
declare
  worker_token text := encode(extensions.gen_random_bytes(32), 'hex');
  existing_job_id bigint;
  project_url text := 'https://vzgblkghicyozoxkljga.supabase.co/functions/v1/process-runtime-dispatch-backlog';
  cron_command text;
begin
  insert into public.runtime_dispatch_worker_config(singleton, token_hash, rotated_at)
  values (
    true,
    encode(extensions.digest(worker_token, 'sha256'), 'hex'),
    now()
  )
  on conflict (singleton) do update
  set
    token_hash = excluded.token_hash,
    rotated_at = excluded.rotated_at;

  select jobid
  into existing_job_id
  from cron.job
  where jobname = 'nexus-runtime-dispatch-backlog-1min';

  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;

  cron_command := format(
    $command$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-nexus-dispatch-worker', %L
        ),
        body := '{"limit":25,"run_due":true}'::jsonb,
        timeout_milliseconds := 50000
      ) as request_id;
    $command$,
    project_url,
    worker_token
  );

  perform cron.schedule(
    'nexus-runtime-dispatch-backlog-1min',
    '* * * * *',
    cron_command
  );

  -- The old daily job contains a literal placeholder secret and can never
  -- authenticate. The minute worker also invokes the due-schedule runner.
  select jobid
  into existing_job_id
  from cron.job
  where jobname = 'nexus-monthly-runner-daily';

  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;
end;
$$;

select pg_notify('pgrst', 'reload schema');
