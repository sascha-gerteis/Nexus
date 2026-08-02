alter table public.analytics_events
  add column if not exists visitor_key text,
  add column if not exists landing_page text,
  add column if not exists referrer_host text,
  add column if not exists source text,
  add column if not exists medium text,
  add column if not exists campaign text,
  add column if not exists country_code text,
  add column if not exists timezone text,
  add column if not exists language text,
  add column if not exists device_type text,
  add column if not exists browser_name text,
  add column if not exists os_name text;

update public.analytics_events
set visitor_key = coalesce(
  nullif(anonymous_id, ''),
  user_id::text,
  nullif(session_id, ''),
  id::text
)
where visitor_key is null or visitor_key = '';

create index if not exists idx_analytics_events_visitor_created
  on public.analytics_events(visitor_key, created_at desc);

create index if not exists idx_analytics_events_session_created
  on public.analytics_events(session_id, created_at desc);

create index if not exists idx_analytics_events_source_created
  on public.analytics_events(source, created_at desc);

create index if not exists idx_analytics_events_country_created
  on public.analytics_events(country_code, created_at desc);

create or replace function public.get_admin_analytics_summary(
  p_days integer default 30,
  p_audience text default 'customer'
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
with settings as (
  select
    greatest(1, least(coalesce(p_days, 30), 365))::integer as days,
    case
      when lower(coalesce(p_audience, 'customer')) in ('customer', 'developer', 'admin', 'all')
        then lower(coalesce(p_audience, 'customer'))
      else 'customer'
    end as audience,
    date_trunc('day', now()) - make_interval(days => greatest(1, least(coalesce(p_days, 30), 365)) - 1) as range_start,
    now() as range_end
),
all_events as materialized (
  select
    e.*,
    coalesce(nullif(e.visitor_key, ''), nullif(e.anonymous_id, ''), e.user_id::text, nullif(e.session_id, ''), e.id::text) as effective_visitor,
    coalesce(nullif(e.session_id, ''), 'event:' || e.id::text) as effective_session,
    coalesce(
      nullif(e.source, ''),
      case
        when coalesce(e.referrer, '') = '' then 'direct'
        when lower(e.referrer) like '%nexus-ai.software%' or lower(e.referrer) like '%localhost%' then 'direct'
        else nullif(regexp_replace(lower(split_part(e.referrer, '/', 3)), '^www\.', '', 'i'), '')
      end,
      'direct'
    ) as effective_source,
    coalesce(nullif(e.referrer_host, ''), nullif(regexp_replace(lower(split_part(e.referrer, '/', 3)), '^www\.', '', 'i'), ''), '') as effective_referrer_host,
    coalesce(nullif(upper(e.country_code), ''), 'UNKNOWN') as effective_country,
    coalesce(
      nullif(lower(e.device_type), ''),
      case
        when lower(coalesce(e.user_agent, '')) ~ 'ipad|tablet|kindle|silk' then 'tablet'
        when lower(coalesce(e.user_agent, '')) ~ 'mobi|android|iphone|ipod' then 'mobile'
        else 'desktop'
      end
    ) as effective_device,
    coalesce(
      nullif(e.browser_name, ''),
      case
        when lower(coalesce(e.user_agent, '')) like '%edg/%' then 'Edge'
        when lower(coalesce(e.user_agent, '')) like '%opr/%' then 'Opera'
        when lower(coalesce(e.user_agent, '')) like '%firefox/%' then 'Firefox'
        when lower(coalesce(e.user_agent, '')) like '%chrome/%' then 'Chrome'
        when lower(coalesce(e.user_agent, '')) like '%safari/%' then 'Safari'
        else 'Other'
      end
    ) as effective_browser,
    coalesce(
      nullif(e.os_name, ''),
      case
        when lower(coalesce(e.user_agent, '')) like '%windows%' then 'Windows'
        when lower(coalesce(e.user_agent, '')) ~ 'iphone|ipad|ipod' then 'iOS'
        when lower(coalesce(e.user_agent, '')) like '%android%' then 'Android'
        when lower(coalesce(e.user_agent, '')) ~ 'mac os|macintosh' then 'macOS'
        when lower(coalesce(e.user_agent, '')) like '%linux%' then 'Linux'
        else 'Other'
      end
    ) as effective_os
  from public.analytics_events e
),
period_events as materialized (
  select e.*
  from all_events e
  cross join settings s
  where e.created_at >= s.range_start
    and e.created_at <= s.range_end
    and (
      s.audience = 'all'
      or (s.audience = 'customer' and coalesce(e.user_role, 'anonymous') in ('anonymous', 'buyer', 'customer'))
      or (s.audience = 'developer' and coalesce(e.user_role, '') = 'developer')
      or (s.audience = 'admin' and coalesce(e.user_role, '') in ('admin', 'admin_staff'))
    )
),
period_visitors as materialized (
  select effective_visitor, min(created_at) as first_in_period, max(created_at) as last_in_period
  from period_events
  group by effective_visitor
),
lifetime_first as materialized (
  select effective_visitor, min(created_at) as first_seen
  from all_events
  group by effective_visitor
),
session_stats as materialized (
  select
    effective_session,
    min(effective_visitor) as effective_visitor,
    min(created_at) as first_at,
    max(created_at) as last_at,
    count(*) as events,
    count(*) filter (where event_name = 'page_view') as page_views
  from period_events
  group by effective_session
),
session_first as materialized (
  select distinct on (effective_session)
    effective_session,
    effective_visitor,
    effective_source as source,
    coalesce(nullif(medium, ''), case when effective_source = 'direct' then 'none' else 'referral' end) as medium,
    coalesce(campaign, '') as campaign,
    effective_referrer_host as referrer_host,
    coalesce(nullif(landing_page, ''), nullif(page_path, ''), '/') as landing_page
  from period_events
  order by effective_session, created_at asc, id asc
),
first_pages as materialized (
  select distinct on (effective_session)
    effective_session,
    effective_visitor,
    coalesce(nullif(page_path, ''), '/') as page_path
  from period_events
  where event_name = 'page_view'
  order by effective_session, created_at asc, id asc
),
last_pages as materialized (
  select distinct on (effective_session)
    effective_session,
    effective_visitor,
    coalesce(nullif(page_path, ''), '/') as page_path
  from period_events
  where event_name = 'page_view'
  order by effective_session, created_at desc, id desc
),
daily_stats as materialized (
  select
    created_at::date as day,
    count(*) as events,
    count(*) filter (where event_name = 'page_view') as page_views,
    count(distinct effective_visitor) as visitors,
    count(distinct effective_session) as sessions
  from period_events
  group by created_at::date
),
day_series as (
  select generate_series(s.range_start::date, s.range_end::date, interval '1 day')::date as day
  from settings s
),
funnel_counts as (
  select
    count(distinct effective_visitor) as visitors,
    count(distinct effective_visitor) filter (where event_name = 'product_view') as product_viewers,
    count(distinct effective_visitor) filter (where event_name = 'checkout_start') as checkout_starters,
    count(distinct effective_visitor) filter (where event_name in ('message_developer_click', 'message_product_click')) as message_intent,
    count(distinct effective_visitor) filter (where event_name = 'custom_request_submit') as custom_submitters
  from period_events
)
select jsonb_build_object(
  'days', (select days from settings),
  'audience', (select audience from settings),
  'meta', jsonb_build_object(
    'aggregation_mode', 'database',
    'data_complete', true,
    'generated_at', now(),
    'range_start', (select range_start from settings),
    'range_end', (select range_end from settings),
    'country_coverage', coalesce(round(
      100.0 * (select count(distinct effective_visitor) from period_events where effective_country <> 'UNKNOWN')
      / nullif((select count(*) from period_visitors), 0),
      1
    ), 0)
  ),
  'totals', jsonb_build_object(
    'events', (select count(*) from period_events),
    'unique_visitors', (select count(*) from period_visitors),
    'sessions', (select count(*) from session_stats),
    'page_views', (select count(*) from period_events where event_name = 'page_view'),
    'new_visitors', (select count(*) from period_visitors p join lifetime_first l using (effective_visitor) where l.first_seen >= (select range_start from settings)),
    'returning_visitors', (select count(*) from period_visitors p join lifetime_first l using (effective_visitor) where l.first_seen < (select range_start from settings)),
    'authenticated_visitors', (select count(distinct effective_visitor) from period_events where user_id is not null),
    'pages_per_session', coalesce(round(
      (select count(*)::numeric from period_events where event_name = 'page_view')
      / nullif((select count(*)::numeric from session_stats), 0),
      2
    ), 0),
    'events_per_session', coalesce(round(
      (select count(*)::numeric from period_events)
      / nullif((select count(*)::numeric from session_stats), 0),
      2
    ), 0),
    'avg_session_seconds', coalesce(round((select avg(extract(epoch from (last_at - first_at))) from session_stats)::numeric, 1), 0),
    'bounce_rate', coalesce(round(
      100.0 * (select count(*) from session_stats where page_views <= 1)
      / nullif((select count(*) from session_stats), 0),
      1
    ), 0),
    'product_views', (select count(*) from period_events where event_name = 'product_view'),
    'profile_views', (select count(*) from period_events where event_name = 'developer_profile_view'),
    'checkout_starts', (select count(*) from period_events where event_name = 'checkout_start'),
    'message_clicks', (select count(*) from period_events where event_name in ('message_developer_click', 'message_product_click')),
    'custom_request_starts', (select count(*) from period_events where event_name = 'custom_request_start'),
    'custom_request_submits', (select count(*) from period_events where event_name = 'custom_request_submit')
  ),
  'daily', coalesce((
    select jsonb_agg(jsonb_build_object(
      'date', to_char(d.day, 'YYYY-MM-DD'),
      'events', coalesce(s.events, 0),
      'count', coalesce(s.events, 0),
      'page_views', coalesce(s.page_views, 0),
      'visitors', coalesce(s.visitors, 0),
      'sessions', coalesce(s.sessions, 0)
    ) order by d.day)
    from day_series d
    left join daily_stats s using (day)
  ), '[]'::jsonb),
  'events_by_name', coalesce((
    select jsonb_agg(to_jsonb(x) order by x.count desc, x.event_name)
    from (
      select event_name, count(*) as count, count(distinct effective_visitor) as visitors
      from period_events
      group by event_name
      order by count(*) desc
      limit 30
    ) x
  ), '[]'::jsonb),
  'top_actions', coalesce((
    select jsonb_agg(to_jsonb(x) order by x.count desc, x.event_name)
    from (
      select event_name, count(*) as count, count(distinct effective_visitor) as visitors
      from period_events
      where event_name <> 'page_view'
      group by event_name
      order by count(*) desc
      limit 20
    ) x
  ), '[]'::jsonb),
  'top_pages', coalesce((
    select jsonb_agg(to_jsonb(x) order by x.page_views desc, x.page_path)
    from (
      select page_path, count(*) as page_views, count(*) as count, count(distinct effective_visitor) as visitors, count(distinct effective_session) as sessions
      from period_events
      where event_name = 'page_view' and coalesce(page_path, '') <> ''
      group by page_path
      order by count(*) desc
      limit 20
    ) x
  ), '[]'::jsonb),
  'top_landing_pages', coalesce((
    select jsonb_agg(to_jsonb(x) order by x.sessions desc, x.page_path)
    from (
      select page_path, count(*) as sessions, count(*) as count, count(distinct effective_visitor) as visitors
      from first_pages
      group by page_path
      order by count(*) desc
      limit 20
    ) x
  ), '[]'::jsonb),
  'top_exit_pages', coalesce((
    select jsonb_agg(to_jsonb(x) order by x.sessions desc, x.page_path)
    from (
      select page_path, count(*) as sessions, count(*) as count, count(distinct effective_visitor) as visitors
      from last_pages
      group by page_path
      order by count(*) desc
      limit 20
    ) x
  ), '[]'::jsonb),
  'top_sources', coalesce((
    select jsonb_agg(to_jsonb(x) order by x.sessions desc, x.source)
    from (
      select source, medium, count(*) as sessions, count(*) as count, count(distinct effective_visitor) as visitors,
        count(*) filter (where coalesce(campaign, '') <> '') as campaign_sessions
      from session_first
      group by source, medium
      order by count(*) desc
      limit 20
    ) x
  ), '[]'::jsonb),
  'countries', coalesce((
    select jsonb_agg(to_jsonb(x) order by x.visitors desc, x.country_code)
    from (
      select effective_country as country_code, count(distinct effective_visitor) as visitors,
        count(distinct effective_visitor) as count, count(distinct effective_session) as sessions,
        count(*) filter (where event_name = 'page_view') as page_views
      from period_events
      group by effective_country
      order by count(distinct effective_visitor) desc
      limit 20
    ) x
  ), '[]'::jsonb),
  'devices', coalesce((
    select jsonb_agg(to_jsonb(x) order by x.visitors desc, x.device_type, x.browser_name)
    from (
      select effective_device as device_type, effective_browser as browser_name, effective_os as os_name,
        count(distinct effective_visitor) as visitors, count(distinct effective_visitor) as count,
        count(distinct effective_session) as sessions
      from period_events
      group by effective_device, effective_browser, effective_os
      order by count(distinct effective_visitor) desc
      limit 20
    ) x
  ), '[]'::jsonb),
  'user_roles', coalesce((
    select jsonb_agg(to_jsonb(x) order by x.visitors desc, x.user_role)
    from (
      select coalesce(nullif(user_role, ''), 'anonymous') as user_role,
        count(distinct effective_visitor) as visitors, count(distinct effective_visitor) as count,
        count(*) as events
      from period_events
      group by coalesce(nullif(user_role, ''), 'anonymous')
      order by count(distinct effective_visitor) desc
    ) x
  ), '[]'::jsonb),
  'top_products', coalesce((
    select jsonb_agg(to_jsonb(x) order by x.views desc, x.checkout_starts desc, x.count desc)
    from (
      select
        coalesce(automation_id::text, nullif(product_slug, ''), nullif(product_title, ''), 'unknown') as product_key,
        max(automation_id::text) as automation_id,
        max(product_slug) as product_slug,
        max(coalesce(product_title, 'Untitled product')) as product_title,
        max(developer_id::text) as developer_id,
        max(coalesce(developer_name, '')) as developer_name,
        count(*) as count,
        count(*) filter (where event_name = 'product_view') as views,
        count(*) filter (where event_name = 'checkout_start') as checkout_starts,
        count(*) filter (where event_name in ('message_developer_click', 'message_product_click')) as message_clicks,
        count(distinct effective_visitor) as visitors
      from period_events
      where automation_id is not null or coalesce(product_slug, '') <> '' or coalesce(product_title, '') <> ''
      group by coalesce(automation_id::text, nullif(product_slug, ''), nullif(product_title, ''), 'unknown')
      order by count(*) filter (where event_name = 'product_view') desc, count(*) filter (where event_name = 'checkout_start') desc, count(*) desc
      limit 20
    ) x
  ), '[]'::jsonb),
  'top_developers', coalesce((
    select jsonb_agg(to_jsonb(x) order by x.count desc, x.developer_name)
    from (
      select
        coalesce(developer_id::text, profile_developer_id::text, nullif(developer_name, ''), 'unknown') as developer_key,
        max(coalesce(developer_id, profile_developer_id)::text) as developer_id,
        max(coalesce(developer_name, 'Unknown developer')) as developer_name,
        count(*) as count,
        count(*) filter (where event_name = 'developer_profile_view') as profile_views,
        count(*) filter (where event_name = 'product_view') as product_views,
        count(distinct effective_visitor) as visitors
      from period_events
      where developer_id is not null or profile_developer_id is not null or coalesce(developer_name, '') <> ''
      group by coalesce(developer_id::text, profile_developer_id::text, nullif(developer_name, ''), 'unknown')
      order by count(*) desc
      limit 20
    ) x
  ), '[]'::jsonb),
  'funnel', (
    select jsonb_build_array(
      jsonb_build_object('stage', 'Visitors', 'visitors', visitors, 'rate', case when visitors > 0 then 100 else 0 end),
      jsonb_build_object('stage', 'Product viewers', 'visitors', product_viewers, 'rate', coalesce(round(100.0 * product_viewers / nullif(visitors, 0), 1), 0)),
      jsonb_build_object('stage', 'Checkout starts', 'visitors', checkout_starters, 'rate', coalesce(round(100.0 * checkout_starters / nullif(visitors, 0), 1), 0)),
      jsonb_build_object('stage', 'Message intent', 'visitors', message_intent, 'rate', coalesce(round(100.0 * message_intent / nullif(visitors, 0), 1), 0)),
      jsonb_build_object('stage', 'Custom requests sent', 'visitors', custom_submitters, 'rate', coalesce(round(100.0 * custom_submitters / nullif(visitors, 0), 1), 0))
    )
    from funnel_counts
  ),
  'recent_events', coalesce((
    select jsonb_agg(to_jsonb(x) order by x.created_at desc)
    from (
      select id, event_name, page_path, product_title, developer_name, user_role, source,
        effective_country as country_code, effective_device as device_type, created_at
      from period_events
      order by created_at desc
      limit 40
    ) x
  ), '[]'::jsonb)
);
$function$;

revoke all on function public.get_admin_analytics_summary(integer, text) from public;
revoke all on function public.get_admin_analytics_summary(integer, text) from anon;
revoke all on function public.get_admin_analytics_summary(integer, text) from authenticated;
grant execute on function public.get_admin_analytics_summary(integer, text) to service_role;

select pg_notify('pgrst', 'reload schema');
