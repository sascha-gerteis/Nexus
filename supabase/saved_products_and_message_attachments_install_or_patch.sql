-- Nexus saved products + private message attachments.
-- Run in Supabase SQL editor, then deploy the message-attachments and messages functions.

create table if not exists public.buyer_saved_products (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid not null references auth.users(id) on delete cascade,
  automation_id uuid not null references public.automations(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (buyer_id, automation_id)
);

alter table public.buyer_saved_products enable row level security;

drop policy if exists "buyer_saved_products_select_own" on public.buyer_saved_products;
create policy "buyer_saved_products_select_own"
on public.buyer_saved_products
for select
to authenticated
using ((select auth.uid()) = buyer_id);

drop policy if exists "buyer_saved_products_insert_own" on public.buyer_saved_products;
create policy "buyer_saved_products_insert_own"
on public.buyer_saved_products
for insert
to authenticated
with check ((select auth.uid()) = buyer_id);

drop policy if exists "buyer_saved_products_delete_own" on public.buyer_saved_products;
create policy "buyer_saved_products_delete_own"
on public.buyer_saved_products
for delete
to authenticated
using ((select auth.uid()) = buyer_id);

grant select, insert, delete on public.buyer_saved_products to authenticated;
create index if not exists idx_buyer_saved_products_buyer_created
  on public.buyer_saved_products (buyer_id, created_at desc);
create index if not exists idx_buyer_saved_products_automation
  on public.buyer_saved_products (automation_id);

alter table public.messages
  add column if not exists attachments jsonb not null default '[]'::jsonb;

create index if not exists idx_messages_attachments_gin
  on public.messages using gin (attachments);

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'message-attachments',
  'message-attachments',
  false,
  15728640,
  array[
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'application/octet-stream',
    'application/pdf',
    'text/plain',
    'text/csv',
    'application/zip',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

select pg_notify('pgrst', 'reload schema');
