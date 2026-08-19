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
  add column if not exists referrer_host text,
  add column if not exists source text,
  add column if not exists medium text,
  add column if not exists campaign text,
  add column if not exists landing_page text,
  add column if not exists anonymous_id text,
  add column if not exists session_id text,
  add column if not exists visitor_key text,
  add column if not exists country_code text,
  add column if not exists timezone text,
  add column if not exists language text,
  add column if not exists device_type text,
  add column if not exists browser_name text,
  add column if not exists os_name text,
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

update public.analytics_events
set visitor_key = coalesce(
  nullif(anonymous_id, ''),
  user_id::text,
  nullif(session_id, ''),
  id::text
)
where visitor_key is null or visitor_key = '';

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

create index if not exists idx_analytics_events_visitor_created
  on public.analytics_events(visitor_key, created_at desc);

create index if not exists idx_analytics_events_session_created
  on public.analytics_events(session_id, created_at desc);

create index if not exists idx_analytics_events_source_created
  on public.analytics_events(source, created_at desc);

create index if not exists idx_analytics_events_country_created
  on public.analytics_events(country_code, created_at desc);

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

create or replace function public.get_marketplace_product_ranking(
  p_days integer default 90
)
returns table (
  listing_type text,
  listing_id text,
  listing_slug text,
  clicks_30 bigint,
  unique_clicks_30 bigint,
  clicks_90 bigint,
  unique_clicks_90 bigint,
  last_clicked_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  with eligible_events as (
    select
      case when e.event_name = 'bundle_view' then 'bundle' else 'product' end as listing_type,
      case
        when e.event_name = 'bundle_view' then nullif(e.metadata ->> 'bundle_id', '')
        else e.automation_id::text
      end as listing_id,
      case
        when e.event_name = 'bundle_view' then nullif(e.metadata ->> 'bundle_slug', '')
        else nullif(e.product_slug, '')
      end as listing_slug,
      coalesce(
        nullif(e.visitor_key, ''),
        nullif(e.anonymous_id, ''),
        e.user_id::text,
        nullif(e.session_id, ''),
        e.id::text
      ) as effective_visitor,
      e.created_at
    from public.analytics_events e
    where e.event_name in ('product_view', 'bundle_view')
      and e.created_at >= now() - make_interval(days => greatest(1, least(coalesce(p_days, 90), 365)))
  ), normalized as (
    select
      listing_type,
      coalesce(listing_id, listing_slug) as listing_key,
      listing_id,
      listing_slug,
      effective_visitor,
      created_at
    from eligible_events
    where coalesce(listing_id, listing_slug) is not null
  )
  select
    n.listing_type,
    max(n.listing_id) as listing_id,
    max(n.listing_slug) as listing_slug,
    count(*) filter (where n.created_at >= now() - interval '30 days') as clicks_30,
    count(distinct n.effective_visitor) filter (where n.created_at >= now() - interval '30 days') as unique_clicks_30,
    count(*) as clicks_90,
    count(distinct n.effective_visitor) as unique_clicks_90,
    max(n.created_at) as last_clicked_at
  from normalized n
  group by n.listing_type, n.listing_key
  order by
    count(distinct n.effective_visitor) filter (where n.created_at >= now() - interval '30 days') desc,
    count(*) filter (where n.created_at >= now() - interval '30 days') desc,
    count(distinct n.effective_visitor) desc,
    count(*) desc;
$$;

revoke all on function public.get_marketplace_product_ranking(integer) from public;
revoke all on function public.get_marketplace_product_ranking(integer) from anon;
revoke all on function public.get_marketplace_product_ranking(integer) from authenticated;
grant execute on function public.get_marketplace_product_ranking(integer) to service_role;

select pg_notify('pgrst', 'reload schema');
