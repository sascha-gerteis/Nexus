-- Automatic Nexus production outage monitoring.
-- A database-owned secret authenticates the five-minute monitor worker.

create table if not exists public.system_monitor_states (
  monitor_key text primary key,
  current_status text not null default 'ok'
    check (current_status in ('ok', 'warning', 'error')),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  last_message text,
  last_details jsonb not null default '{}'::jsonb,
  last_checked_at timestamptz,
  last_changed_at timestamptz,
  last_alerted_at timestamptz,
  last_recovered_at timestamptz,
  last_transition_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.system_monitor_worker_config (
  singleton boolean primary key default true check (singleton),
  token_hash text not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz not null default now()
);

create or replace function public.authorize_system_monitor_worker(p_token text)
returns boolean
language sql
stable
security definer
set search_path = public, extensions
as $$
  select exists (
    select 1
    from public.system_monitor_worker_config
    where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
  );
$$;

create or replace function public.system_monitor_status()
returns jsonb
language sql
stable
security definer
set search_path = public, cron
as $$
  select jsonb_build_object(
    'state', (
      select to_jsonb(state_row)
      from public.system_monitor_states as state_row
      where state_row.monitor_key = 'nexus-production'
    ),
    'cron', (
      select jsonb_build_object(
        'jobid', job.jobid,
        'jobname', job.jobname,
        'schedule', job.schedule,
        'active', job.active
      )
      from cron.job as job
      where job.jobname = 'nexus-system-monitor-5min'
      limit 1
    )
  );
$$;

alter table public.system_monitor_states enable row level security;
alter table public.system_monitor_worker_config enable row level security;

revoke all on public.system_monitor_states from anon, authenticated;
revoke all on public.system_monitor_worker_config from anon, authenticated;
revoke all on function public.authorize_system_monitor_worker(text) from public, anon, authenticated;
revoke all on function public.system_monitor_status() from public, anon, authenticated;

grant all on public.system_monitor_states to service_role;
grant all on public.system_monitor_worker_config to service_role;
grant execute on function public.authorize_system_monitor_worker(text) to service_role;
grant execute on function public.system_monitor_status() to service_role;

do $$
declare
  worker_token text := encode(extensions.gen_random_bytes(32), 'hex');
  existing_job_id bigint;
  project_url text := 'https://vzgblkghicyozoxkljga.supabase.co/functions/v1/monitor-system-health';
  cron_command text;
begin
  insert into public.system_monitor_worker_config(singleton, token_hash, rotated_at)
  values (
    true,
    encode(extensions.digest(worker_token, 'sha256'), 'hex'),
    now()
  )
  on conflict (singleton) do update
  set token_hash = excluded.token_hash,
      rotated_at = excluded.rotated_at;

  select jobid
  into existing_job_id
  from cron.job
  where jobname = 'nexus-system-monitor-5min';

  if existing_job_id is not null then
    perform cron.unschedule(existing_job_id);
  end if;

  cron_command := format(
    $command$
      select net.http_post(
        url := %L,
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'x-nexus-monitor-worker', %L
        ),
        body := '{"action":"check"}'::jsonb,
        timeout_milliseconds := 45000
      ) as request_id;
    $command$,
    project_url,
    worker_token
  );

  perform cron.schedule(
    'nexus-system-monitor-5min',
    '*/5 * * * *',
    cron_command
  );
end;
$$;

select pg_notify('pgrst', 'reload schema');
