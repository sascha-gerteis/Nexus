-- Reliable, database-scheduled delivery for Nexus transactional email.
-- The plaintext worker token exists only inside pg_cron; the database stores its hash.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

create table if not exists public.email_queue_worker_config (
  singleton boolean primary key default true check (singleton),
  token_hash text not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz not null default now()
);

create table if not exists public.email_queue_worker_states (
  singleton boolean primary key default true check (singleton),
  last_checked_at timestamptz,
  last_sent_count integer not null default 0 check (last_sent_count >= 0),
  last_failed_count integer not null default 0 check (last_failed_count >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.authorize_email_queue_worker(p_token text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
    from public.email_queue_worker_config
    where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
  );
$$;

create or replace function public.email_queue_worker_status()
returns jsonb
language sql
stable
security definer
set search_path = public, cron
as $$
  select jsonb_build_object(
    'state', (
      select to_jsonb(state_row)
      from public.email_queue_worker_states as state_row
      where state_row.singleton = true
    ),
    'cron', (
      select jsonb_build_object(
        'jobid', job.jobid,
        'jobname', job.jobname,
        'schedule', job.schedule,
        'active', job.active
      )
      from cron.job as job
      where job.jobname = 'nexus-email-queue-1min'
      limit 1
    ),
    'due_count', (
      select count(*)
      from public.email_queue
      where status = 'pending'
        and scheduled_for <= now()
    ),
    'overdue_count', (
      select count(*)
      from public.email_queue
      where status = 'pending'
        and scheduled_for <= now() - interval '20 minutes'
    ),
    'stuck_count', (
      select count(*)
      from public.email_queue
      where status = 'sending'
        and sending_started_at <= now() - interval '10 minutes'
    )
  );
$$;

alter table public.email_queue_worker_config enable row level security;
alter table public.email_queue_worker_states enable row level security;

revoke all on public.email_queue_worker_config from anon, authenticated;
revoke all on public.email_queue_worker_states from anon, authenticated;
revoke all on function public.authorize_email_queue_worker(text) from public, anon, authenticated;
revoke all on function public.email_queue_worker_status() from public, anon, authenticated;

grant all on public.email_queue_worker_config to service_role;
grant all on public.email_queue_worker_states to service_role;
grant execute on function public.authorize_email_queue_worker(text) to service_role;
grant execute on function public.email_queue_worker_status() to service_role;

-- Do not suddenly send obsolete test-era messages when the worker is enabled.
-- Their audit records remain available as skipped; future and recently due mail is untouched.
update public.email_queue
set
  status = 'skipped',
  last_error = 'Pre-launch delivery expired after more than 48 hours; preserved as skipped rather than sent late.',
  updated_at = now()
where status = 'pending'
  and scheduled_for <= now() - interval '48 hours';

-- Make any interrupted pre-existing send safely retryable.
update public.email_queue
set
  status = 'pending',
  sending_started_at = null,
  scheduled_for = now(),
  last_error = 'Recovered while enabling the production email worker.',
  updated_at = now()
where status = 'sending'
  and sending_started_at <= now() - interval '10 minutes';

insert into public.email_queue_worker_states(singleton)
values (true)
on conflict (singleton) do nothing;

do $$
declare
  worker_token text := encode(extensions.gen_random_bytes(32), 'hex');
  existing_job_id bigint;
  project_url text := 'https://vzgblkghicyozoxkljga.supabase.co/functions/v1/send-platform-email';
  cron_command text;
begin
  insert into public.email_queue_worker_config(singleton, token_hash, rotated_at)
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
  where jobname in ('nexus-email-queue-1min', 'nexus-email-queue-5min')
  order by case when jobname = 'nexus-email-queue-1min' then 0 else 1 end
  limit 1;

  while existing_job_id is not null loop
    perform cron.unschedule(existing_job_id);
    select jobid
    into existing_job_id
    from cron.job
    where jobname in ('nexus-email-queue-1min', 'nexus-email-queue-5min')
    limit 1;
  end loop;

  cron_command := format(
    $command$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-nexus-email-worker', %L
        ),
        body := '{"action":"send_due","limit":25}'::jsonb,
        timeout_milliseconds := 50000
      ) as request_id;
    $command$,
    project_url,
    worker_token
  );

  perform cron.schedule(
    'nexus-email-queue-1min',
    '* * * * *',
    cron_command
  );
end;
$$;

select pg_notify('pgrst', 'reload schema');
