-- Nexus demo marketplace mode install/patch.
-- Run this in the Supabase SQL editor before deploying the demo-marketplace Edge Function.

alter table if exists public.developers
  add column if not exists is_demo boolean not null default false,
  add column if not exists demo_seed_key text;

alter table if exists public.automations
  add column if not exists is_demo boolean not null default false,
  add column if not exists demo_seed_key text,
  add column if not exists listing_type text default 'standard';

alter table if exists public.reviews
  add column if not exists is_demo boolean not null default false,
  add column if not exists demo_seed_key text,
  add column if not exists review_type text default 'product',
  add column if not exists developer_id uuid references public.developers(id) on delete cascade,
  add column if not exists reviewer_role text,
  add column if not exists reviewer_company text,
  add column if not exists verified_purchase boolean default false,
  add column if not exists source text default 'admin',
  add column if not exists updated_at timestamptz default now();

do $$
begin
  if to_regclass('public.developers') is not null then
    create unique index if not exists idx_developers_demo_seed_key
      on public.developers(demo_seed_key)
      where demo_seed_key is not null;

    create index if not exists idx_developers_is_demo_status
      on public.developers(is_demo, status);
  end if;

  if to_regclass('public.automations') is not null then
    create unique index if not exists idx_automations_demo_seed_key
      on public.automations(demo_seed_key)
      where demo_seed_key is not null;

    create index if not exists idx_automations_is_demo_status
      on public.automations(is_demo, status);
  end if;

  if to_regclass('public.reviews') is not null then
    create unique index if not exists idx_reviews_demo_seed_key
      on public.reviews(demo_seed_key)
      where demo_seed_key is not null;

    create index if not exists idx_reviews_is_demo_status
      on public.reviews(is_demo, status);
  end if;
end $$;

notify pgrst, 'reload schema';
