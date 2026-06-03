-- Nexus user-submitted reviews install/patch.
-- Run this in Supabase SQL editor before deploying the submit-review Edge Function.

alter table if exists public.reviews
  add column if not exists review_type text default 'product',
  add column if not exists developer_id uuid references public.developers(id) on delete cascade,
  add column if not exists reviewer_user_id uuid references public.profiles(id) on delete set null,
  add column if not exists buyer_id uuid references public.profiles(id) on delete set null,
  add column if not exists order_id uuid references public.orders(id) on delete set null,
  add column if not exists customer_automation_id uuid references public.customer_automations(id) on delete set null,
  add column if not exists reviewer_role text,
  add column if not exists reviewer_company text,
  add column if not exists verified_purchase boolean default false,
  add column if not exists source text default 'admin',
  add column if not exists moderation_notes text,
  add column if not exists updated_at timestamptz default now();

update public.reviews
set review_type = 'product'
where review_type is null;

update public.reviews
set source = 'admin'
where source is null;

do $$
begin
  if to_regclass('public.reviews') is not null then
    create index if not exists idx_reviews_developer
      on public.reviews(developer_id);

    create index if not exists idx_reviews_reviewer_user
      on public.reviews(reviewer_user_id);

    create index if not exists idx_reviews_type_status
      on public.reviews(review_type, status);

    create unique index if not exists idx_reviews_one_product_per_user
      on public.reviews(reviewer_user_id, automation_id)
      where review_type = 'product'
        and reviewer_user_id is not null
        and automation_id is not null;

    create unique index if not exists idx_reviews_one_developer_per_user
      on public.reviews(reviewer_user_id, developer_id)
      where review_type = 'developer'
        and reviewer_user_id is not null
        and developer_id is not null;
  end if;
end $$;

create or replace function public.refresh_review_rating_targets()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  target_automation_id uuid;
  target_developer_id uuid;
begin
  if tg_op = 'DELETE' then
    target_automation_id := old.automation_id;
    target_developer_id := old.developer_id;
  else
    target_automation_id := new.automation_id;
    target_developer_id := new.developer_id;
  end if;

  if target_automation_id is not null then
    update public.automations
    set
      rating = coalesce((
        select round(avg(rating)::numeric, 1)
        from public.reviews
        where review_type = 'product'
          and status = 'approved'
          and automation_id = target_automation_id
      ), 0),
      review_count = coalesce((
        select count(*)::integer
        from public.reviews
        where review_type = 'product'
          and status = 'approved'
          and automation_id = target_automation_id
      ), 0),
      updated_at = now()
    where id = target_automation_id;
  end if;

  if target_developer_id is not null then
    update public.developers
    set
      rating = coalesce((
        select round(avg(rating)::numeric, 1)
        from public.reviews
        where review_type = 'developer'
          and status = 'approved'
          and developer_id = target_developer_id
      ), 0),
      review_count = coalesce((
        select count(*)::integer
        from public.reviews
        where review_type = 'developer'
          and status = 'approved'
          and developer_id = target_developer_id
      ), 0),
      updated_at = now()
    where id = target_developer_id;
  end if;

  if tg_op = 'UPDATE' and old.automation_id is distinct from new.automation_id and old.automation_id is not null then
    update public.automations
    set
      rating = coalesce((
        select round(avg(rating)::numeric, 1)
        from public.reviews
        where review_type = 'product'
          and status = 'approved'
          and automation_id = old.automation_id
      ), 0),
      review_count = coalesce((
        select count(*)::integer
        from public.reviews
        where review_type = 'product'
          and status = 'approved'
          and automation_id = old.automation_id
      ), 0),
      updated_at = now()
    where id = old.automation_id;
  end if;

  if tg_op = 'UPDATE' and old.developer_id is distinct from new.developer_id and old.developer_id is not null then
    update public.developers
    set
      rating = coalesce((
        select round(avg(rating)::numeric, 1)
        from public.reviews
        where review_type = 'developer'
          and status = 'approved'
          and developer_id = old.developer_id
      ), 0),
      review_count = coalesce((
        select count(*)::integer
        from public.reviews
        where review_type = 'developer'
          and status = 'approved'
          and developer_id = old.developer_id
      ), 0),
      updated_at = now()
    where id = old.developer_id;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  return new;
end $$;

drop trigger if exists refresh_review_rating_targets_trigger on public.reviews;
create trigger refresh_review_rating_targets_trigger
after insert or update or delete on public.reviews
for each row execute function public.refresh_review_rating_targets();

drop policy if exists "Users can read own reviews" on public.reviews;
create policy "Users can read own reviews"
on public.reviews for select
using (status = 'approved' or public.is_admin() or reviewer_user_id = auth.uid());

select pg_notify('pgrst', 'reload schema');
