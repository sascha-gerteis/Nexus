create extension if not exists "pgcrypto";

create table if not exists public.analytics_events (
  id uuid primary key default gen_random_uuid(),
  event_name text not null,
  event_type text not null default 'interaction',
  page_path text,
  page_url text,
  referrer text,
  anonymous_id text,
  session_id text,
  user_id uuid references auth.users(id) on delete set null,
  user_role text,
  developer_id uuid references public.developers(id) on delete set null,
  profile_developer_id uuid references public.developers(id) on delete set null,
  automation_id uuid references public.automations(id) on delete set null,
  product_slug text,
  product_title text,
  developer_name text,
  metadata jsonb not null default '{}'::jsonb,
  viewport jsonb not null default '{}'::jsonb,
  user_agent text,
  created_at timestamptz not null default now()
);

alter table public.analytics_events
  add column if not exists event_type text not null default 'interaction',
  add column if not exists page_path text,
  add column if not exists page_url text,
  add column if not exists referrer text,
  add column if not exists anonymous_id text,
  add column if not exists session_id text,
  add column if not exists user_id uuid references auth.users(id) on delete set null,
  add column if not exists user_role text,
  add column if not exists developer_id uuid references public.developers(id) on delete set null,
  add column if not exists profile_developer_id uuid references public.developers(id) on delete set null,
  add column if not exists automation_id uuid references public.automations(id) on delete set null,
  add column if not exists product_slug text,
  add column if not exists product_title text,
  add column if not exists developer_name text,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists viewport jsonb not null default '{}'::jsonb,
  add column if not exists user_agent text,
  add column if not exists created_at timestamptz not null default now();

create index if not exists idx_analytics_events_created_at
  on public.analytics_events(created_at desc);

create index if not exists idx_analytics_events_event_created
  on public.analytics_events(event_name, created_at desc);

create index if not exists idx_analytics_events_automation_created
  on public.analytics_events(automation_id, created_at desc);

create index if not exists idx_analytics_events_developer_created
  on public.analytics_events(developer_id, created_at desc);

create index if not exists idx_analytics_events_profile_developer_created
  on public.analytics_events(profile_developer_id, created_at desc);

create index if not exists idx_analytics_events_page_created
  on public.analytics_events(page_path, created_at desc);

alter table public.analytics_events enable row level security;

grant select on public.analytics_events to authenticated;

drop policy if exists "Admins read analytics events" on public.analytics_events;
create policy "Admins read analytics events"
on public.analytics_events
for select
to authenticated
using (public.is_admin());

drop policy if exists "Developers read own analytics events" on public.analytics_events;
create policy "Developers read own analytics events"
on public.analytics_events
for select
to authenticated
using (
  exists (
    select 1
    from public.developers d
    where d.profile_id = auth.uid()
      and (
        analytics_events.developer_id = d.id
        or analytics_events.profile_developer_id = d.id
      )
  )
);

select pg_notify('pgrst', 'reload schema');
