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

notify pgrst, 'reload schema';
