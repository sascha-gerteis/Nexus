-- Nexus manual developer payouts install/patch.
-- Run this in Supabase SQL editor before deploying stripe-webhook and developer-stripe-account.

create extension if not exists pgcrypto;

alter table if exists public.orders
  add column if not exists stripe_fee_amount numeric(12, 2) default 0,
  add column if not exists net_amount numeric(12, 2) default 0,
  add column if not exists platform_fee_amount numeric(12, 2) default 0,
  add column if not exists platform_net_amount numeric(12, 2) default 0,
  add column if not exists developer_earning_amount numeric(12, 2) default 0,
  add column if not exists revenue_share_status text default 'unallocated';

alter table if exists public.developers
  add column if not exists payout_method text default 'manual_bank_transfer',
  add column if not exists payout_details jsonb not null default '{}'::jsonb,
  add column if not exists payout_note text,
  add column if not exists payout_settings_updated_at timestamptz;

create table if not exists public.developer_earnings (
  id uuid primary key default gen_random_uuid(),
  developer_id uuid not null references public.developers(id) on delete cascade,
  automation_id uuid references public.automations(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  payout_request_id uuid,
  source_type text not null default 'order_payment',
  source_id text,
  currency text not null default 'THB',
  gross_amount numeric(12, 2) not null default 0,
  stripe_fee_amount numeric(12, 2) not null default 0,
  net_amount numeric(12, 2) not null default 0,
  platform_fee_amount numeric(12, 2) not null default 0,
  platform_net_amount numeric(12, 2) not null default 0,
  developer_amount numeric(12, 2) not null default 0,
  platform_fee_bps integer not null default 2000,
  developer_share_bps integer not null default 8000,
  status text not null default 'available',
  transfer_status text not null default 'available',
  payout_status text not null default 'available',
  stripe_payment_intent_id text,
  stripe_charge_id text,
  stripe_balance_transaction_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table if exists public.developer_earnings
  add column if not exists developer_id uuid references public.developers(id) on delete cascade,
  add column if not exists automation_id uuid references public.automations(id) on delete set null,
  add column if not exists order_id uuid references public.orders(id) on delete set null,
  add column if not exists payout_request_id uuid,
  add column if not exists source_type text not null default 'order_payment',
  add column if not exists source_id text,
  add column if not exists currency text not null default 'THB',
  add column if not exists gross_amount numeric(12, 2) not null default 0,
  add column if not exists stripe_fee_amount numeric(12, 2) not null default 0,
  add column if not exists net_amount numeric(12, 2) not null default 0,
  add column if not exists platform_fee_amount numeric(12, 2) not null default 0,
  add column if not exists platform_net_amount numeric(12, 2) not null default 0,
  add column if not exists developer_amount numeric(12, 2) not null default 0,
  add column if not exists platform_fee_bps integer not null default 2000,
  add column if not exists developer_share_bps integer not null default 8000,
  add column if not exists status text not null default 'available',
  add column if not exists transfer_status text not null default 'available',
  add column if not exists payout_status text not null default 'available',
  add column if not exists stripe_payment_intent_id text,
  add column if not exists stripe_charge_id text,
  add column if not exists stripe_balance_transaction_id text,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create table if not exists public.developer_payout_requests (
  id uuid primary key default gen_random_uuid(),
  developer_id uuid not null references public.developers(id) on delete cascade,
  requested_by uuid references public.profiles(id) on delete set null,
  paid_by uuid references public.profiles(id) on delete set null,
  currency text not null default 'THB',
  amount numeric(12, 2) not null default 0,
  earnings_ids uuid[] not null default array[]::uuid[],
  payout_method text not null default 'manual_bank_transfer',
  payout_details jsonb not null default '{}'::jsonb,
  developer_note text,
  admin_note text,
  payment_reference text,
  payment_receipt_url text,
  payment_receipt_file_name text,
  payment_receipt_mime_type text,
  payment_receipt_base64 text,
  status text not null default 'pending',
  requested_at timestamptz not null default now(),
  reviewed_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint developer_payout_requests_status_check
    check (status in ('pending', 'approved', 'paid', 'rejected', 'cancelled'))
);

alter table if exists public.developer_payout_requests
  add column if not exists developer_id uuid references public.developers(id) on delete cascade;

alter table if exists public.developer_payout_requests
  add column if not exists requested_by uuid references public.profiles(id) on delete set null;

alter table if exists public.developer_payout_requests
  add column if not exists paid_by uuid references public.profiles(id) on delete set null;

alter table if exists public.developer_payout_requests
  add column if not exists currency text not null default 'THB';

alter table if exists public.developer_payout_requests
  add column if not exists amount numeric(12, 2) not null default 0;

alter table if exists public.developer_payout_requests
  add column if not exists earnings_ids uuid[] not null default array[]::uuid[];

alter table if exists public.developer_payout_requests
  add column if not exists payout_method text not null default 'manual_bank_transfer';

alter table if exists public.developer_payout_requests
  add column if not exists payout_details jsonb not null default '{}'::jsonb;

alter table if exists public.developer_payout_requests
  add column if not exists developer_note text;

alter table if exists public.developer_payout_requests
  add column if not exists admin_note text;

alter table if exists public.developer_payout_requests
  add column if not exists payment_reference text;

alter table if exists public.developer_payout_requests
  add column if not exists payment_receipt_url text;

alter table if exists public.developer_payout_requests
  add column if not exists payment_receipt_file_name text;

alter table if exists public.developer_payout_requests
  add column if not exists payment_receipt_mime_type text;

alter table if exists public.developer_payout_requests
  add column if not exists payment_receipt_base64 text;

alter table if exists public.developer_payout_requests
  add column if not exists status text not null default 'pending';

alter table if exists public.developer_payout_requests
  add column if not exists requested_at timestamptz not null default now();

alter table if exists public.developer_payout_requests
  add column if not exists reviewed_at timestamptz;

alter table if exists public.developer_payout_requests
  add column if not exists paid_at timestamptz;

alter table if exists public.developer_payout_requests
  add column if not exists created_at timestamptz not null default now();

alter table if exists public.developer_payout_requests
  add column if not exists updated_at timestamptz not null default now();

alter table if exists public.developer_earnings
  drop constraint if exists developer_earnings_payout_request_id_fkey;

alter table if exists public.developer_earnings
  drop constraint if exists developer_earnings_source_type_check;

alter table if exists public.developer_earnings
  drop constraint if exists developer_earnings_status_check;

alter table if exists public.developer_earnings
  drop constraint if exists developer_earnings_transfer_status_check;

alter table if exists public.developer_earnings
  drop constraint if exists developer_earnings_payout_status_check;

alter table if exists public.developer_payout_requests
  drop constraint if exists developer_payout_requests_status_check;

alter table if exists public.developer_earnings
  add constraint developer_earnings_source_type_check
  check (source_type in ('order_payment', 'subscription_invoice', 'manual_adjustment'));

alter table if exists public.developer_earnings
  add constraint developer_earnings_status_check
  check (status in (
    'available',
    'requested',
    'approved',
    'paid',
    'transferred',
    'pending',
    'failed',
    'refunded',
    'disputed',
    'refunded_after_payout',
    'disputed_after_payout',
    'cancelled'
  ));

alter table if exists public.developer_earnings
  add constraint developer_earnings_transfer_status_check
  check (transfer_status in (
    'available',
    'requested',
    'approved',
    'paid',
    'transferred',
    'pending',
    'failed',
    'refunded',
    'disputed',
    'refunded_after_payout',
    'disputed_after_payout',
    'cancelled'
  ));

alter table if exists public.developer_earnings
  add constraint developer_earnings_payout_status_check
  check (payout_status in (
    'available',
    'unrequested',
    'recorded',
    'requested',
    'approved',
    'paid',
    'transferred',
    'pending',
    'failed',
    'refunded',
    'disputed',
    'refunded_after_payout',
    'disputed_after_payout',
    'cancelled'
  ));

alter table if exists public.developer_earnings
  add constraint developer_earnings_payout_request_id_fkey
  foreign key (payout_request_id)
  references public.developer_payout_requests(id)
  on delete set null;

alter table if exists public.developer_payout_requests
  add constraint developer_payout_requests_status_check
  check (status in ('pending', 'approved', 'paid', 'rejected', 'cancelled'));

create index if not exists idx_developer_earnings_developer
  on public.developer_earnings(developer_id);

create index if not exists idx_developer_earnings_order
  on public.developer_earnings(order_id);

create index if not exists idx_developer_earnings_payout_status
  on public.developer_earnings(payout_status);

create unique index if not exists idx_developer_earnings_source_unique
  on public.developer_earnings(source_type, source_id)
  where source_id is not null;

create index if not exists idx_developer_payout_requests_developer
  on public.developer_payout_requests(developer_id);

create index if not exists idx_developer_payout_requests_status
  on public.developer_payout_requests(status);

alter table public.developer_earnings enable row level security;
alter table public.developer_payout_requests enable row level security;

drop policy if exists "Admins manage developer earnings" on public.developer_earnings;
create policy "Admins manage developer earnings"
on public.developer_earnings for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Developers read own earnings" on public.developer_earnings;
create policy "Developers read own earnings"
on public.developer_earnings for select
using (
  exists (
    select 1
    from public.developers d
    where d.id = developer_earnings.developer_id
      and d.profile_id = auth.uid()
  )
);

drop policy if exists "Admins manage developer payout requests" on public.developer_payout_requests;
create policy "Admins manage developer payout requests"
on public.developer_payout_requests for all
using (public.is_admin())
with check (public.is_admin());

drop policy if exists "Developers read own payout requests" on public.developer_payout_requests;
create policy "Developers read own payout requests"
on public.developer_payout_requests for select
using (
  exists (
    select 1
    from public.developers d
    where d.id = developer_payout_requests.developer_id
      and d.profile_id = auth.uid()
  )
);

select pg_notify('pgrst', 'reload schema');
