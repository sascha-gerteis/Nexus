-- Production subscription cancellation and refund audit fields.
-- Cancellation approval is executed by the review-automation-cancellation Edge Function.

create extension if not exists pgcrypto;

create table if not exists public.automation_cancellation_requests (
  id uuid primary key default gen_random_uuid(),
  customer_automation_id uuid references public.customer_automations(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  automation_id uuid references public.automations(id) on delete set null,
  buyer_id uuid references public.profiles(id) on delete set null,
  reason text,
  status text not null default 'pending',
  admin_notes text,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.automation_cancellation_requests
  add column if not exists stripe_subscription_id text,
  add column if not exists stripe_refund_id text,
  add column if not exists stripe_refund_status text,
  add column if not exists stripe_refunded_amount bigint,
  add column if not exists stripe_refunded_currency text,
  add column if not exists stripe_cancellation_status text,
  add column if not exists stripe_cancelled_at timestamptz,
  add column if not exists stripe_refunded_at timestamptz,
  add column if not exists external_action_error text;

alter table public.orders
  add column if not exists stripe_refund_id text,
  add column if not exists refund_status text,
  add column if not exists refunded_at timestamptz,
  add column if not exists refunded_amount bigint,
  add column if not exists refunded_currency text,
  add column if not exists cancellation_approved_at timestamptz,
  add column if not exists cancellation_approved_by uuid references public.profiles(id) on delete set null;

create index if not exists automation_cancellation_requests_order_idx
  on public.automation_cancellation_requests(order_id, created_at desc);

create index if not exists automation_cancellation_requests_pending_idx
  on public.automation_cancellation_requests(status, created_at desc)
  where status = 'pending';

create index if not exists orders_stripe_refund_id_idx
  on public.orders(stripe_refund_id)
  where stripe_refund_id is not null;

alter table public.automation_cancellation_requests enable row level security;

select pg_notify('pgrst', 'reload schema');
