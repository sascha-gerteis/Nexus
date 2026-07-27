-- Nexus marketplace bundles foundation.
-- Run this in the Supabase SQL editor, then deploy create-checkout-session, stripe-webhook,
-- product-health-checker, and refresh the frontend.

create extension if not exists pgcrypto;

create table if not exists public.automation_bundles (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  title text not null,
  status text not null default 'draft',
  category text default 'Bundle',
  badge text default 'Bundle',
  short_description text default '',
  long_description text default '',
  outcome text default '',
  bundle_source text not null default 'manual',
  bundle_strategy text not null default 'admin_curated',
  pricing_type text not null default 'monthly',
  currency text not null default 'USD',
  discount_percent numeric(6,2) not null default 10,
  price_override numeric(12,2),
  price_usd numeric(12,2),
  price_thb numeric(12,2),
  setup_type text default 'Self-serve setup for each included automation',
  setup_fee numeric(12,2) default 0,
  setup_fee_usd numeric(12,2) default 0,
  setup_fee_thb numeric(12,2) default 0,
  guided_install_enabled boolean not null default false,
  min_active_items integer not null default 2,
  included_count integer not null default 0,
  active_item_count integer not null default 0,
  base_amount_usd numeric(12,2) default 0,
  discounted_amount_usd numeric(12,2) default 0,
  color text default 'cyan',
  icon text default 'PK',
  rating numeric(3,2) default 5,
  review_count integer default 0,
  preview_mode text default 'template',
  preview_title text default '',
  preview_description text default '',
  preview_image_url text default '',
  preview_code text default '',
  preview_base64 text default '',
  health_status text not null default 'unknown',
  health_last_checked_at timestamptz,
  health_last_failed_at timestamptz,
  health_failure_reason text,
  is_demo boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_recalculated_at timestamptz
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'automation_bundles_status_check'
  ) then
    alter table public.automation_bundles
      add constraint automation_bundles_status_check
      check (status in ('draft', 'active', 'paused', 'archived'));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'automation_bundles_source_check'
  ) then
    alter table public.automation_bundles
      add constraint automation_bundles_source_check
      check (bundle_source in ('manual', 'algorithm', 'system_suggested'));
  end if;
end $$;

create table if not exists public.automation_bundle_items (
  id uuid primary key default gen_random_uuid(),
  bundle_id uuid not null references public.automation_bundles(id) on delete cascade,
  automation_id uuid not null references public.automations(id) on delete cascade,
  position integer not null default 0,
  status text not null default 'active',
  include_in_price boolean not null default true,
  price_weight numeric(8,4) default 1,
  inactive_reason text,
  added_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(bundle_id, automation_id)
);

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'automation_bundle_items_status_check'
  ) then
    alter table public.automation_bundle_items
      add constraint automation_bundle_items_status_check
      check (status in ('active', 'inactive', 'removed_by_health', 'archived'));
  end if;
end $$;

alter table if exists public.orders
  add column if not exists order_type text not null default 'automation',
  add column if not exists bundle_id uuid references public.automation_bundles(id) on delete set null,
  add column if not exists parent_order_id uuid references public.orders(id) on delete set null,
  add column if not exists bundle_snapshot jsonb not null default '{}'::jsonb;

alter table if exists public.customer_automations
  add column if not exists bundle_id uuid references public.automation_bundles(id) on delete set null;

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders(id) on delete cascade,
  bundle_id uuid references public.automation_bundles(id) on delete set null,
  automation_id uuid references public.automations(id) on delete set null,
  developer_id uuid references public.developers(id) on delete set null,
  title text not null default '',
  item_type text not null default 'automation',
  currency text not null default 'USD',
  gross_amount numeric(12,2) not null default 0,
  discount_amount numeric(12,2) not null default 0,
  net_amount numeric(12,2) not null default 0,
  status text not null default 'active',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_automation_bundles_status on public.automation_bundles(status);
create index if not exists idx_automation_bundles_source on public.automation_bundles(bundle_source);
create index if not exists idx_automation_bundle_items_bundle on public.automation_bundle_items(bundle_id, status, position);
create index if not exists idx_automation_bundle_items_automation on public.automation_bundle_items(automation_id, status);
create index if not exists idx_orders_bundle_id on public.orders(bundle_id);
create index if not exists idx_orders_order_type on public.orders(order_type);
create index if not exists idx_customer_automations_bundle_id on public.customer_automations(bundle_id);
create index if not exists idx_order_items_order on public.order_items(order_id);
create index if not exists idx_order_items_bundle on public.order_items(bundle_id);

alter table public.automation_bundles enable row level security;
alter table public.automation_bundle_items enable row level security;
alter table public.order_items enable row level security;

drop policy if exists "Public can read active bundles" on public.automation_bundles;
create policy "Public can read active bundles"
  on public.automation_bundles
  for select
  to anon, authenticated
  using (status = 'active');

drop policy if exists "Admins can manage bundles" on public.automation_bundles;
create policy "Admins can manage bundles"
  on public.automation_bundles
  for all
  to authenticated
  using (exists (
    select 1 from public.profiles
    where profiles.id = (select auth.uid())
      and profiles.role = 'admin'
  ))
  with check (exists (
    select 1 from public.profiles
    where profiles.id = (select auth.uid())
      and profiles.role = 'admin'
  ));

drop policy if exists "Public can read active bundle items" on public.automation_bundle_items;
create policy "Public can read active bundle items"
  on public.automation_bundle_items
  for select
  to anon, authenticated
  using (
    status = 'active'
    and exists (
      select 1 from public.automation_bundles
      where automation_bundles.id = automation_bundle_items.bundle_id
        and automation_bundles.status = 'active'
    )
  );

drop policy if exists "Admins can manage bundle items" on public.automation_bundle_items;
create policy "Admins can manage bundle items"
  on public.automation_bundle_items
  for all
  to authenticated
  using (exists (
    select 1 from public.profiles
    where profiles.id = (select auth.uid())
      and profiles.role = 'admin'
  ))
  with check (exists (
    select 1 from public.profiles
    where profiles.id = (select auth.uid())
      and profiles.role = 'admin'
  ));

drop policy if exists "Admins can read order items" on public.order_items;
create policy "Admins can read order items"
  on public.order_items
  for select
  to authenticated
  using (exists (
    select 1 from public.profiles
    where profiles.id = (select auth.uid())
      and profiles.role = 'admin'
  ));

drop policy if exists "Buyers can read own order items" on public.order_items;
create policy "Buyers can read own order items"
  on public.order_items
  for select
  to authenticated
  using (exists (
    select 1 from public.orders
    where orders.id = order_items.order_id
      and orders.buyer_id = (select auth.uid())
  ));

grant select on public.automation_bundles to anon, authenticated;
grant select on public.automation_bundle_items to anon, authenticated;
grant all on public.automation_bundles to authenticated;
grant all on public.automation_bundle_items to authenticated;
grant select on public.order_items to authenticated;

with seed as (
  insert into public.automation_bundles (
    slug,
    title,
    status,
    category,
    badge,
    short_description,
    long_description,
    outcome,
    bundle_source,
    bundle_strategy,
    pricing_type,
    currency,
    discount_percent,
    color,
    icon,
    setup_type,
    min_active_items,
    preview_title,
    preview_description,
    metadata
  )
  values (
    'online-visibility-reporting-bundle',
    'Online Visibility Reporting Bundle',
    'active',
    'Reporting',
    'Marketing Visibility Pack',
    'A practical reporting pack for brands that want social performance, competitor movement, and online visibility in one dashboard flow.',
    'This bundle combines social media reporting, social listening, and competitor intelligence products so teams can track the online signals that affect growth without buying every workflow separately.',
    'Understand what is working, what competitors are doing, and which online actions deserve attention next.',
    'manual',
    'admin_curated',
    'monthly',
    'USD',
    12,
    'cyan',
    'OV',
    'Self-serve setup for each included report',
    2,
    'Online visibility report pack',
    'A combined monthly reporting bundle with social performance, brand monitoring, and competitor intelligence outputs.',
    jsonb_build_object(
      'future_auto_bundle_ready', true,
      'recommended_max_ratio_note', 'Keep bundles proportional to product count.'
    )
  )
  on conflict (slug) do update set
    title = excluded.title,
    category = excluded.category,
    badge = excluded.badge,
    short_description = excluded.short_description,
    long_description = excluded.long_description,
    outcome = excluded.outcome,
    bundle_source = excluded.bundle_source,
    bundle_strategy = excluded.bundle_strategy,
    pricing_type = excluded.pricing_type,
    discount_percent = excluded.discount_percent,
    color = excluded.color,
    icon = excluded.icon,
    setup_type = excluded.setup_type,
    min_active_items = excluded.min_active_items,
    preview_title = excluded.preview_title,
    preview_description = excluded.preview_description,
    updated_at = now()
  returning id
),
bundle as (
  select id from seed
  union
  select id from public.automation_bundles
  where slug = 'online-visibility-reporting-bundle'
),
chosen_products as (
  select
    a.id,
    row_number() over (
      order by case
        when a.slug = 'social-listening-intelligence' then 1
        when lower(a.title) like '%social listening%' then 1
        when a.slug = 'ai-social-media-reports' then 2
        when lower(a.title) like '%social media%' then 2
        when a.slug = 'competitor-report' then 3
        when lower(a.title) like '%competitor intelligence%' then 3
        when lower(a.title) like '%competitor%' then 4
        when lower(a.title) like '%inquiry%' then 5
        else 10
      end,
      a.created_at
    ) as position
  from public.automations a
  where lower(coalesce(a.status, '')) in ('live', 'active', 'published')
    and (
      a.slug in ('social-listening-intelligence', 'ai-social-media-reports', 'competitor-report', 'competitor-intelligence-report')
      or lower(a.title) like '%social listening%'
      or lower(a.title) like '%social media%'
      or lower(a.title) like '%competitor%'
      or lower(a.title) like '%inquiry%'
    )
  limit 4
)
insert into public.automation_bundle_items (bundle_id, automation_id, position, status, include_in_price)
select bundle.id, chosen_products.id, chosen_products.position, 'active', true
from bundle, chosen_products
on conflict (bundle_id, automation_id) do update set
  position = excluded.position,
  status = 'active',
  include_in_price = true,
  inactive_reason = null,
  updated_at = now();

update public.automation_bundles b
set
  included_count = coalesce(counts.included_count, 0),
  active_item_count = coalesce(counts.active_item_count, 0),
  last_recalculated_at = now(),
  updated_at = now()
from (
  select
    bundle_id,
    count(*)::int as included_count,
    count(*) filter (where status = 'active')::int as active_item_count
  from public.automation_bundle_items
  group by bundle_id
) counts
where b.id = counts.bundle_id;

select pg_notify('pgrst', 'reload schema');
