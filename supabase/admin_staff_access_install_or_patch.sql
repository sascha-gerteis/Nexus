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
