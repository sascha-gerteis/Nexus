-- Nexus restricted admin staff role.
--
-- Staff use the normal Nexus signup/login flow. After they create an account,
-- replace the email below and run this file to route that account to the
-- restricted staff dashboard.
--
-- Use this when you invite an operations/helper account that should see
-- analytics, orders, messages, builders, products, and health signals,
-- but should not access finance, credentials, bundles, product creation,
-- or Nexus profile creation.
--
-- Replace the email below, then run the whole file in the Supabase SQL editor.

alter table if exists public.profiles
  drop constraint if exists profiles_role_check;

alter table if exists public.profiles
  add constraint profiles_role_check
  check (
    role is null
    or role in ('buyer', 'developer', 'admin', 'admin_staff')
  );

create or replace function public.is_admin_staff()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin_staff'
  );
$$;

create or replace function public.has_admin_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role in ('admin', 'admin_staff')
  );
$$;

drop policy if exists "Staff read profiles" on public.profiles;
create policy "Staff read profiles"
on public.profiles for select
using (public.has_admin_access() or id = auth.uid());

drop policy if exists "Staff read developers" on public.developers;
create policy "Staff read developers"
on public.developers for select
using (public.has_admin_access());

drop policy if exists "Staff read automations" on public.automations;
create policy "Staff read automations"
on public.automations for select
using (public.has_admin_access());

drop policy if exists "Staff read reviews" on public.reviews;
create policy "Staff read reviews"
on public.reviews for select
using (public.has_admin_access());

drop policy if exists "Staff read developer waitlist" on public.developer_waitlist;
create policy "Staff read developer waitlist"
on public.developer_waitlist for select
using (public.has_admin_access());

drop policy if exists "Staff read contact messages" on public.contact_messages;
create policy "Staff read contact messages"
on public.contact_messages for select
using (public.has_admin_access());

drop policy if exists "Staff read checkout intents" on public.checkout_intents;
create policy "Staff read checkout intents"
on public.checkout_intents for select
using (public.has_admin_access());

-- Promote an existing signed-up user to restricted staff.
-- Change this email before running.
with target_user as (
  select
    id,
    email,
    coalesce(raw_user_meta_data->>'full_name', raw_user_meta_data->>'name', email) as full_name
  from auth.users
  where lower(email) = lower('staff@example.com')
  limit 1
)
insert into public.profiles (id, email, full_name, role, created_at, updated_at)
select id, email, full_name, 'admin_staff', now(), now()
from target_user
on conflict (id) do update
set
  role = 'admin_staff',
  email = excluded.email,
  full_name = coalesce(public.profiles.full_name, excluded.full_name),
  updated_at = now();

notify pgrst, 'reload schema';
