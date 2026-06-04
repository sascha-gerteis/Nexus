-- Developer waitlist structured automation fields.
-- Run this in the Supabase SQL editor, then refresh/reload the app so PostgREST schema cache updates.

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

notify pgrst, 'reload schema';
