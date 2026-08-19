-- Admin-managed buyer output collections are deliberately independent from
-- marketplace products, orders, customer automations, and workflow runs.
create table if not exists public.buyer_output_collections (
  id uuid primary key default gen_random_uuid(),
  buyer_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  description text not null default '',
  icon text not null default 'PR',
  color text not null default 'purple',
  created_by uuid references public.profiles(id) on delete set null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint buyer_output_collections_name_check check (char_length(btrim(name)) between 1 and 120)
);

create unique index if not exists buyer_output_collections_buyer_name_unique
  on public.buyer_output_collections (buyer_id, lower(btrim(name)))
  where archived_at is null;

create table if not exists public.buyer_managed_deliverables (
  id uuid primary key default gen_random_uuid(),
  collection_id uuid not null references public.buyer_output_collections(id) on delete cascade,
  buyer_id uuid not null references public.profiles(id) on delete cascade,
  output_type text not null default 'file',
  status text not null default 'published',
  title text not null,
  summary text not null default '',
  bucket text not null default 'buyer-deliverables',
  storage_path text not null unique,
  file_name text not null,
  file_type text not null default 'application/octet-stream',
  file_size bigint not null,
  delivered_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint buyer_managed_deliverables_status_check check (status in ('published', 'archived')),
  constraint buyer_managed_deliverables_size_check check (file_size > 0 and file_size <= 52428800)
);

create index if not exists buyer_managed_deliverables_buyer_created_idx
  on public.buyer_managed_deliverables (buyer_id, created_at desc);

create index if not exists buyer_managed_deliverables_collection_created_idx
  on public.buyer_managed_deliverables (collection_id, created_at desc);

alter table public.buyer_output_collections enable row level security;
alter table public.buyer_managed_deliverables enable row level security;

drop policy if exists "Buyers can read own output collections" on public.buyer_output_collections;
create policy "Buyers can read own output collections"
  on public.buyer_output_collections
  for select
  to authenticated
  using (buyer_id = auth.uid() and archived_at is null);

drop policy if exists "Buyers can read own managed deliverables" on public.buyer_managed_deliverables;
create policy "Buyers can read own managed deliverables"
  on public.buyer_managed_deliverables
  for select
  to authenticated
  using (buyer_id = auth.uid() and status = 'published');

revoke insert, update, delete on public.buyer_output_collections from anon, authenticated;
revoke insert, update, delete on public.buyer_managed_deliverables from anon, authenticated;
grant select on public.buyer_output_collections to authenticated;
grant select on public.buyer_managed_deliverables to authenticated;

notify pgrst, 'reload schema';
