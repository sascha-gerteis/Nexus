-- Developer waitlist structured automation fields.
-- Run this in the Supabase SQL editor, then refresh/reload the app so PostgREST schema cache updates.

create table if not exists public.developer_waitlist (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null,
  company text,
  website text,
  automation_type text,
  experience text,
  message text,
  status text default 'new',
  created_at timestamptz default now()
);

alter table public.developer_waitlist
  add column if not exists automation_categories text[] not null default '{}'::text[],
  add column if not exists build_stack text[] not null default '{}'::text[],
  add column if not exists build_stack_other text;

create index if not exists idx_developer_waitlist_automation_categories
on public.developer_waitlist using gin (automation_categories);

create index if not exists idx_developer_waitlist_build_stack
on public.developer_waitlist using gin (build_stack);

comment on column public.developer_waitlist.automation_categories
is 'Selected automation types from the public developer waitlist.';

comment on column public.developer_waitlist.build_stack
is 'Selected build stack/platforms/frameworks from the public developer waitlist.';

comment on column public.developer_waitlist.build_stack_other
is 'Free-text build stack entry from the public developer waitlist.';

alter table public.developer_waitlist enable row level security;

create or replace function public.is_admin()
returns boolean
language sql
security definer
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
    and role = 'admin'
  );
$$;

grant usage on schema public to anon, authenticated;
grant insert on public.developer_waitlist to anon, authenticated;
grant select on public.developer_waitlist to authenticated;

drop policy if exists "Public can create developer waitlist" on public.developer_waitlist;
create policy "Public can create developer waitlist"
on public.developer_waitlist for insert
with check (true);

drop policy if exists "Admins manage developer waitlist" on public.developer_waitlist;
create policy "Admins manage developer waitlist"
on public.developer_waitlist for all
using (public.is_admin())
with check (public.is_admin());

notify pgrst, 'reload schema';
