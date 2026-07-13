-- Nexus payment environment switch.
-- Run this in the Supabase SQL editor before deploying payment-mode/create-checkout-session.

create table if not exists public.platform_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

alter table public.platform_settings enable row level security;

drop policy if exists "Admins can read platform settings" on public.platform_settings;
create policy "Admins can read platform settings"
on public.platform_settings
for select
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  )
);

drop policy if exists "Admins can manage platform settings" on public.platform_settings;
create policy "Admins can manage platform settings"
on public.platform_settings
for all
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  )
)
with check (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  )
);

insert into public.platform_settings (key, value)
values ('payment_mode', jsonb_build_object('mode', 'live'))
on conflict (key) do nothing;

alter table if exists public.orders
  add column if not exists payment_environment text not null default 'live';

do $$
begin
  if to_regclass('public.orders') is not null
    and not exists (
      select 1
      from pg_constraint
      where conname = 'orders_payment_environment_check'
        and conrelid = 'public.orders'::regclass
    ) then
    alter table public.orders
      add constraint orders_payment_environment_check
      check (payment_environment in ('live', 'test'));
  end if;
end $$;

alter table if exists public.orders
  add column if not exists stripe_livemode boolean not null default true;

select pg_notify('pgrst', 'reload schema');
