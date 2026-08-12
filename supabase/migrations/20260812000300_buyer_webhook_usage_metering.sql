-- Opt-in live buyer-webhook runtime, monthly usage entitlements, and run packs.
-- Existing runtime modes are deliberately excluded from every function below.

begin;

-- Some older Nexus databases received these subscription fields through the
-- monthly runner install script rather than a timestamped migration. Adding
-- them here is idempotent and ensures the entitlement functions compile on
-- both histories without changing any existing values.
alter table public.orders
  add column if not exists stripe_mode text,
  add column if not exists stripe_subscription_status text,
  add column if not exists stripe_current_period_start timestamptz,
  add column if not exists stripe_current_period_end timestamptz,
  add column if not exists stripe_subscription_id text,
  add column if not exists stripe_cancel_at_period_end boolean default false;

alter table public.automations
  add column if not exists runtime_trigger_mode text not null default 'legacy',
  add column if not exists webhook_included_runs integer not null default 0,
  add column if not exists webhook_topup_runs integer not null default 0,
  add column if not exists webhook_topup_price numeric(12, 2) not null default 0;

alter table public.automations
  drop constraint if exists automations_webhook_included_runs_check,
  add constraint automations_webhook_included_runs_check check (webhook_included_runs >= 0),
  drop constraint if exists automations_webhook_topup_runs_check,
  add constraint automations_webhook_topup_runs_check check (webhook_topup_runs >= 0),
  drop constraint if exists automations_webhook_topup_price_check,
  add constraint automations_webhook_topup_price_check check (webhook_topup_price >= 0);

alter table public.automations
  drop constraint if exists automations_runtime_trigger_mode_check,
  add constraint automations_runtime_trigger_mode_check
    check (runtime_trigger_mode in (
      'legacy', 'setup_complete', 'on_demand', 'buyer_webhook',
      'scheduled_interval', 'subscription_monthly', 'manual'
    ));

alter table public.runtime_dispatch_queue
  add column if not exists setup_overrides jsonb not null default '{}'::jsonb,
  add column if not exists request_payload jsonb not null default '{}'::jsonb;

alter table public.runtime_dispatch_queue
  drop constraint if exists runtime_dispatch_queue_setup_overrides_check,
  add constraint runtime_dispatch_queue_setup_overrides_check check (jsonb_typeof(setup_overrides) = 'object'),
  drop constraint if exists runtime_dispatch_queue_request_payload_check,
  add constraint runtime_dispatch_queue_request_payload_check check (jsonb_typeof(request_payload) = 'object'),
  drop constraint if exists runtime_dispatch_queue_origin_check,
  add constraint runtime_dispatch_queue_origin_check
    check (dispatch_origin in ('setup_submit', 'scheduled', 'manual', 'buyer_webhook'));

alter table public.bundle_run_attempts
  add column if not exists attempt_kind text not null default 'setup_bundle';

alter table public.bundle_run_attempts
  drop constraint if exists bundle_run_attempts_attempt_kind_check,
  add constraint bundle_run_attempts_attempt_kind_check
    check (attempt_kind in ('setup_bundle', 'runtime_event'));

alter table public.customer_automation_webhook_configs
  drop constraint if exists customer_automation_webhook_configs_mapping_phase_live_gate,
  drop constraint if exists customer_automation_webhook_configs_live_readiness_check,
  add constraint customer_automation_webhook_configs_live_readiness_check
    check (
      live_enabled = false
      or (
        inbound_status = 'confirmed'
        and event_mapping_status = 'confirmed'
        and inbound_confirmed_at is not null
        and event_mapping_confirmed_at is not null
      )
    );

create table if not exists public.customer_automation_usage_entitlements (
  id uuid primary key default gen_random_uuid(),
  customer_automation_id uuid not null references public.customer_automations(id) on delete cascade,
  buyer_id uuid not null references public.profiles(id) on delete cascade,
  automation_id uuid not null references public.automations(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  included_units integer not null default 0 check (included_units >= 0),
  purchased_units integer not null default 0 check (purchased_units >= 0),
  used_units integer not null default 0 check (used_units >= 0),
  warning_notified_at timestamptz,
  exhausted_notified_at timestamptz,
  source_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_automation_usage_period_check check (period_end > period_start),
  constraint customer_automation_usage_entitlement_period_unique unique (customer_automation_id, period_start)
);

create table if not exists public.automation_usage_topups (
  id uuid primary key default gen_random_uuid(),
  customer_automation_id uuid not null references public.customer_automations(id) on delete cascade,
  buyer_id uuid not null references public.profiles(id) on delete cascade,
  automation_id uuid not null references public.automations(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  entitlement_id uuid references public.customer_automation_usage_entitlements(id) on delete set null,
  units integer not null check (units > 0),
  amount numeric(12, 2) not null check (amount > 0),
  currency text not null,
  payment_environment text not null default 'live' check (payment_environment in ('live', 'test')),
  status text not null default 'pending' check (status in ('pending', 'paid', 'expired', 'failed', 'refunded')),
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  stripe_fee_amount numeric(12, 2),
  platform_fee_amount numeric(12, 2),
  developer_earning_amount numeric(12, 2),
  fulfilled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.customer_automation_usage_ledger (
  id uuid primary key default gen_random_uuid(),
  entitlement_id uuid not null references public.customer_automation_usage_entitlements(id) on delete cascade,
  customer_automation_id uuid not null references public.customer_automations(id) on delete cascade,
  buyer_id uuid not null references public.profiles(id) on delete cascade,
  order_id uuid not null references public.orders(id) on delete cascade,
  entry_type text not null check (entry_type in ('webhook_run', 'topup_grant', 'admin_adjustment')),
  units integer not null check (units > 0),
  event_key text not null,
  automation_run_id uuid references public.automation_runs(id) on delete set null,
  topup_id uuid references public.automation_usage_topups(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint customer_automation_usage_event_unique unique (customer_automation_id, event_key)
);

create index if not exists customer_automation_usage_entitlements_current_idx
  on public.customer_automation_usage_entitlements(customer_automation_id, period_end desc);
create index if not exists automation_usage_topups_buyer_idx
  on public.automation_usage_topups(buyer_id, created_at desc);
create index if not exists automation_usage_topups_customer_idx
  on public.automation_usage_topups(customer_automation_id, created_at desc);
create index if not exists customer_automation_usage_ledger_entitlement_idx
  on public.customer_automation_usage_ledger(entitlement_id, created_at desc);

alter table public.customer_automation_usage_entitlements enable row level security;
alter table public.automation_usage_topups enable row level security;
alter table public.customer_automation_usage_ledger enable row level security;

revoke all on public.customer_automation_usage_entitlements from anon, authenticated;
revoke all on public.automation_usage_topups from anon, authenticated;
revoke all on public.customer_automation_usage_ledger from anon, authenticated;
grant all on public.customer_automation_usage_entitlements to service_role;
grant all on public.automation_usage_topups to service_role;
grant all on public.customer_automation_usage_ledger to service_role;

-- Run packs use the same 80/20 marketplace wallet as product payments, but
-- retain their own source identity so they never overwrite base order revenue.
alter table if exists public.developer_earnings
  drop constraint if exists developer_earnings_source_type_check;
alter table if exists public.developer_earnings
  add constraint developer_earnings_source_type_check
  check (source_type in ('order_payment', 'subscription_invoice', 'usage_topup', 'manual_adjustment'));

create or replace function public.ensure_customer_automation_usage_entitlement(
  p_customer_automation_id uuid,
  p_period_start timestamptz default null,
  p_period_end timestamptz default null,
  p_source_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  linked_automation public.customer_automations%rowtype;
  linked_order public.orders%rowtype;
  product public.automations%rowtype;
  entitlement public.customer_automation_usage_entitlements%rowtype;
  resolved_start timestamptz;
  resolved_end timestamptz;
  payment_state text;
  subscription_state text;
begin
  select * into linked_automation
  from public.customer_automations
  where id = p_customer_automation_id;

  if not found then
    return jsonb_build_object('ok', false, 'status', 'not_found', 'error', 'Customer automation was not found.');
  end if;

  select * into linked_order from public.orders where id = linked_automation.order_id;
  select * into product from public.automations where id = linked_automation.automation_id;

  if linked_order.id is null or product.id is null then
    return jsonb_build_object('ok', false, 'status', 'identity_missing', 'error', 'Purchase identity is incomplete.');
  end if;

  -- Exact opt-in gate. Legacy on-demand and every other existing mode remain untouched.
  if lower(coalesce(product.runtime_trigger_mode, '')) <> 'buyer_webhook' then
    return jsonb_build_object('ok', false, 'status', 'not_eligible', 'error', 'This product is not configured for buyer webhook requests.');
  end if;

  if lower(coalesce(product.pricing_type, '')) <> 'monthly' then
    return jsonb_build_object('ok', false, 'status', 'monthly_required', 'error', 'Live webhook usage requires a monthly subscription product.');
  end if;
  if lower(coalesce(linked_order.stripe_mode, '')) <> 'subscription'
     and coalesce(linked_order.stripe_subscription_id, '') = '' then
    return jsonb_build_object('ok', false, 'status', 'monthly_required', 'error', 'Live webhook usage requires a monthly subscription purchase.');
  end if;

  payment_state := lower(coalesce(linked_order.payment_status, ''));
  subscription_state := lower(coalesce(linked_order.stripe_subscription_status, ''));
  if payment_state <> 'paid' then
    return jsonb_build_object('ok', false, 'status', 'payment_inactive', 'error', 'The subscription payment is not active.');
  end if;
  if subscription_state <> '' and subscription_state not in ('active', 'trialing') then
    return jsonb_build_object('ok', false, 'status', 'subscription_inactive', 'error', 'The subscription is not active.');
  end if;
  if lower(coalesce(linked_order.order_status, '')) in ('cancelled', 'canceled', 'expired', 'refunded') then
    return jsonb_build_object('ok', false, 'status', 'order_inactive', 'error', 'The subscription order is not active.');
  end if;

  resolved_start := coalesce(p_period_start, linked_order.stripe_current_period_start, date_trunc('month', now()));
  resolved_end := coalesce(p_period_end, linked_order.stripe_current_period_end, resolved_start + interval '1 month');
  if resolved_end <= resolved_start then resolved_end := resolved_start + interval '1 month'; end if;

  insert into public.customer_automation_usage_entitlements (
    customer_automation_id, buyer_id, automation_id, order_id,
    period_start, period_end, included_units, source_key, updated_at
  ) values (
    linked_automation.id, linked_automation.buyer_id, linked_automation.automation_id, linked_automation.order_id,
    resolved_start, resolved_end, greatest(coalesce(product.webhook_included_runs, 0), 0), p_source_key, now()
  )
  on conflict (customer_automation_id, period_start) do update
  set
    period_end = excluded.period_end,
    included_units = greatest(public.customer_automation_usage_entitlements.included_units, excluded.included_units),
    source_key = coalesce(excluded.source_key, public.customer_automation_usage_entitlements.source_key),
    updated_at = now()
  returning * into entitlement;

  return jsonb_build_object(
    'ok', true,
    'status', 'active',
    'entitlement_id', entitlement.id,
    'customer_automation_id', entitlement.customer_automation_id,
    'period_start', entitlement.period_start,
    'period_end', entitlement.period_end,
    'included_units', entitlement.included_units,
    'purchased_units', entitlement.purchased_units,
    'used_units', entitlement.used_units,
    'total_units', entitlement.included_units + entitlement.purchased_units,
    'remaining_units', greatest(entitlement.included_units + entitlement.purchased_units - entitlement.used_units, 0),
    'topup_units', greatest(coalesce(product.webhook_topup_runs, 0), 0),
    'topup_price', greatest(coalesce(product.webhook_topup_price, 0), 0),
    'currency', upper(coalesce(product.currency, linked_order.currency, 'USD'))
  );
end;
$$;

create or replace function public.reserve_buyer_webhook_runtime_dispatch(
  p_webhook_config_id uuid,
  p_event_id text,
  p_event_payload jsonb,
  p_setup_overrides jsonb,
  p_request_payload jsonb,
  p_request_preview jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  config public.customer_automation_webhook_configs%rowtype;
  linked_automation public.customer_automations%rowtype;
  linked_order public.orders%rowtype;
  product public.automations%rowtype;
  entitlement public.customer_automation_usage_entitlements%rowtype;
  usage_summary jsonb;
  prior_entry public.customer_automation_usage_ledger%rowtype;
  new_run_id uuid := gen_random_uuid();
  new_run_key text;
  new_attempt_id uuid;
  new_item_id uuid;
  is_bundle boolean := false;
  total_units integer;
  remaining_units integer;
  notification_kind text := '';
begin
  if coalesce(length(trim(p_event_id)), 0) = 0 or length(p_event_id) > 200 then
    return jsonb_build_object('ok', false, 'status', 'invalid_event_id', 'error', 'A valid event ID is required.');
  end if;
  if jsonb_typeof(coalesce(p_event_payload, '{}'::jsonb)) <> 'object'
     or jsonb_typeof(coalesce(p_setup_overrides, '{}'::jsonb)) <> 'object'
     or jsonb_typeof(coalesce(p_request_payload, '{}'::jsonb)) <> 'object'
     or jsonb_typeof(coalesce(p_request_preview, '{}'::jsonb)) <> 'object' then
    return jsonb_build_object('ok', false, 'status', 'invalid_payload', 'error', 'Webhook runtime payload must be an object.');
  end if;

  select * into config
  from public.customer_automation_webhook_configs
  where id = p_webhook_config_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'status', 'not_found', 'error', 'Webhook endpoint was not found.');
  end if;
  if config.live_enabled is not true then
    return jsonb_build_object('ok', false, 'status', 'not_live', 'error', 'This webhook is not live.');
  end if;
  if config.inbound_status <> 'confirmed' or config.event_mapping_status <> 'confirmed' then
    return jsonb_build_object('ok', false, 'status', 'confirmation_required', 'error', 'Webhook connection and event mapping must be confirmed.');
  end if;

  select * into linked_automation
  from public.customer_automations
  where id = config.customer_automation_id
  for update;
  select * into linked_order from public.orders where id = linked_automation.order_id;
  select * into product from public.automations where id = linked_automation.automation_id;

  -- Second exact opt-in gate protects direct RPC callers and imported legacy products.
  if product.id is null or lower(coalesce(product.runtime_trigger_mode, '')) <> 'buyer_webhook' then
    return jsonb_build_object('ok', false, 'status', 'not_eligible', 'error', 'This product is not configured for buyer webhook requests.');
  end if;

  select * into prior_entry
  from public.customer_automation_usage_ledger
  where customer_automation_id = linked_automation.id
    and event_key = 'webhook:' || linked_automation.id::text || ':' || p_event_id;
  if found then
    return jsonb_build_object(
      'ok', true, 'status', 'duplicate', 'duplicate', true,
      'run_id', prior_entry.automation_run_id, 'event_id', p_event_id
    );
  end if;

  usage_summary := public.ensure_customer_automation_usage_entitlement(linked_automation.id, null, null, null);
  if coalesce((usage_summary->>'ok')::boolean, false) is not true then return usage_summary; end if;

  select * into entitlement
  from public.customer_automation_usage_entitlements
  where id = (usage_summary->>'entitlement_id')::uuid
  for update;

  total_units := entitlement.included_units + entitlement.purchased_units;
  if entitlement.used_units >= total_units then
    if entitlement.exhausted_notified_at is null then
      update public.customer_automation_usage_entitlements
      set exhausted_notified_at = now(), updated_at = now()
      where id = entitlement.id;
      insert into public.automation_events (
        customer_automation_id, buyer_id, automation_id, order_id,
        event_type, title, message, created_by, created_at
      ) values (
        linked_automation.id, linked_automation.buyer_id, linked_automation.automation_id, linked_automation.order_id,
        'webhook_usage_exhausted', 'Monthly webhook limit reached',
        coalesce(product.title, 'This automation') || ' has used all ' || total_units || ' available runs for this billing period. Incoming requests are paused until more runs are added or the allowance renews.',
        'system', now()
      );
      notification_kind := 'exhausted';
    end if;
    return jsonb_build_object(
      'ok', false, 'status', 'quota_exhausted', 'error', 'Monthly webhook run limit reached.',
      'remaining_units', 0, 'total_units', total_units,
      'period_end', entitlement.period_end,
      'topup_available', coalesce(product.webhook_topup_runs, 0) > 0 and coalesce(product.webhook_topup_price, 0) > 0,
      'notification', notification_kind
    );
  end if;

  new_run_key := 'webhook:' || linked_automation.id::text || ':' || p_event_id;
  is_bundle := lower(coalesce(linked_order.order_type, '')) = 'bundle' or linked_order.bundle_id is not null;

  if is_bundle then
    new_attempt_id := gen_random_uuid();
    new_item_id := gen_random_uuid();
    insert into public.bundle_run_attempts (
      id, order_id, bundle_id, buyer_id, status, expected_count,
      completed_count, failed_count, started_at, attempt_kind, created_at, updated_at
    ) values (
      new_attempt_id, linked_order.id, linked_order.bundle_id, linked_automation.buyer_id,
      'queued', 1, 0, 0, now(), 'runtime_event', now(), now()
    );
    insert into public.bundle_run_items (
      id, bundle_run_attempt_id, order_id, bundle_id, buyer_id,
      customer_automation_id, automation_id, status, started_at, created_at, updated_at
    ) values (
      new_item_id, new_attempt_id, linked_order.id, linked_order.bundle_id, linked_automation.buyer_id,
      linked_automation.id, linked_automation.automation_id, 'queued', now(), now(), now()
    );
  end if;

  insert into public.automation_runs (
    id, customer_automation_id, buyer_id, automation_id, order_id,
    runtime_type, trigger_type, trigger_source, run_key, scheduled_for,
    status, request_payload, bundle_run_attempt_id, bundle_run_item_id,
    started_at, created_at, updated_at
  ) values (
    new_run_id, linked_automation.id, linked_automation.buyer_id, linked_automation.automation_id, linked_automation.order_id,
    coalesce(linked_automation.runtime_type, product.runtime_type, 'n8n_managed'),
    'buyer_webhook', 'buyer-webhook-ingress', new_run_key, now(),
    'queued', coalesce(p_request_preview, '{}'::jsonb), new_attempt_id, new_item_id,
    null, now(), now()
  );

  if new_item_id is not null then
    update public.bundle_run_items
    set automation_run_id = new_run_id, updated_at = now()
    where id = new_item_id;
  end if;

  insert into public.runtime_dispatch_queue (
    run_id, customer_automation_id, setup_submission_id, dispatch_origin,
    event_payload, setup_overrides, request_payload, status,
    next_attempt_at, created_at, updated_at
  ) values (
    new_run_id, linked_automation.id, null, 'buyer_webhook',
    coalesce(p_event_payload, '{}'::jsonb), coalesce(p_setup_overrides, '{}'::jsonb),
    coalesce(p_request_payload, '{}'::jsonb), 'pending', now(), now(), now()
  );

  insert into public.customer_automation_usage_ledger (
    entitlement_id, customer_automation_id, buyer_id, order_id,
    entry_type, units, event_key, automation_run_id, metadata, created_at
  ) values (
    entitlement.id, linked_automation.id, linked_automation.buyer_id, linked_automation.order_id,
    'webhook_run', 1, new_run_key, new_run_id,
    jsonb_build_object('event_id', p_event_id, 'bundle_run_attempt_id', new_attempt_id, 'bundle_run_item_id', new_item_id), now()
  );

  update public.customer_automation_usage_entitlements
  set used_units = used_units + 1, updated_at = now()
  where id = entitlement.id
  returning included_units + purchased_units - used_units into remaining_units;

  if remaining_units = 0 and entitlement.exhausted_notified_at is null then
    update public.customer_automation_usage_entitlements
    set exhausted_notified_at = now(), updated_at = now()
    where id = entitlement.id;
    insert into public.automation_events (
      customer_automation_id, buyer_id, automation_id, order_id,
      event_type, title, message, created_by, created_at
    ) values (
      linked_automation.id, linked_automation.buyer_id, linked_automation.automation_id, linked_automation.order_id,
      'webhook_usage_exhausted', 'Monthly webhook limit reached',
      coalesce(product.title, 'This automation') || ' accepted its final available run. New requests are now paused until more runs are added or the allowance renews.',
      'system', now()
    );
    notification_kind := 'exhausted';
  elsif remaining_units > 0
        and remaining_units <= greatest(1, ceil(total_units * 0.20)::integer)
        and entitlement.warning_notified_at is null then
    update public.customer_automation_usage_entitlements
    set warning_notified_at = now(), updated_at = now()
    where id = entitlement.id;
    insert into public.automation_events (
      customer_automation_id, buyer_id, automation_id, order_id,
      event_type, title, message, created_by, created_at
    ) values (
      linked_automation.id, linked_automation.buyer_id, linked_automation.automation_id, linked_automation.order_id,
      'webhook_usage_warning', 'Webhook runs are running low',
      coalesce(product.title, 'This automation') || ' has ' || remaining_units || ' of ' || total_units || ' runs left in this billing period.',
      'system', now()
    );
    notification_kind := 'warning';
  end if;

  return jsonb_build_object(
    'ok', true, 'status', 'queued', 'duplicate', false,
    'run_id', new_run_id, 'run_key', new_run_key, 'event_id', p_event_id,
    'bundle_run_attempt_id', new_attempt_id, 'bundle_run_item_id', new_item_id,
    'entitlement_id', entitlement.id, 'remaining_units', greatest(remaining_units, 0),
    'total_units', total_units, 'period_end', entitlement.period_end,
    'notification', notification_kind
  );
end;
$$;

create or replace function public.fulfill_customer_automation_usage_topup(
  p_topup_id uuid,
  p_stripe_checkout_session_id text,
  p_stripe_payment_intent_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  topup public.automation_usage_topups%rowtype;
  entitlement public.customer_automation_usage_entitlements%rowtype;
  usage_summary jsonb;
  ledger_created boolean := false;
begin
  select * into topup
  from public.automation_usage_topups
  where id = p_topup_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'status', 'not_found', 'error', 'Usage top-up was not found.');
  end if;
  if topup.status = 'paid' then
    select * into entitlement
    from public.customer_automation_usage_entitlements
    where id = topup.entitlement_id;
    return jsonb_build_object(
      'ok', true, 'status', 'paid', 'duplicate', true,
      'topup_id', topup.id, 'units', topup.units,
      'entitlement_id', entitlement.id,
      'included_units', coalesce(entitlement.included_units, 0),
      'purchased_units', coalesce(entitlement.purchased_units, 0),
      'used_units', coalesce(entitlement.used_units, 0),
      'remaining_units', greatest(
        coalesce(entitlement.included_units, 0) + coalesce(entitlement.purchased_units, 0) - coalesce(entitlement.used_units, 0), 0
      ),
      'period_end', entitlement.period_end
    );
  end if;
  if topup.status <> 'pending' then
    return jsonb_build_object('ok', false, 'status', topup.status, 'error', 'This usage top-up cannot be fulfilled.');
  end if;
  if coalesce(length(trim(p_stripe_checkout_session_id)), 0) = 0 then
    return jsonb_build_object('ok', false, 'status', 'invalid_session', 'error', 'Stripe Checkout Session ID is required.');
  end if;
  if topup.stripe_checkout_session_id is not null
     and topup.stripe_checkout_session_id <> p_stripe_checkout_session_id then
    return jsonb_build_object('ok', false, 'status', 'identity_mismatch', 'error', 'Stripe Checkout Session does not match this top-up.');
  end if;

  usage_summary := public.ensure_customer_automation_usage_entitlement(
    topup.customer_automation_id, null, null, 'topup:' || topup.id::text
  );
  if coalesce((usage_summary->>'ok')::boolean, false) is not true then return usage_summary; end if;

  select * into entitlement
  from public.customer_automation_usage_entitlements
  where id = (usage_summary->>'entitlement_id')::uuid
  for update;

  insert into public.customer_automation_usage_ledger (
    entitlement_id, customer_automation_id, buyer_id, order_id,
    entry_type, units, event_key, topup_id, metadata, created_at
  ) values (
    entitlement.id, topup.customer_automation_id, topup.buyer_id, topup.order_id,
    'topup_grant', topup.units, 'topup:' || topup.id::text, topup.id,
    jsonb_build_object('stripe_checkout_session_id', p_stripe_checkout_session_id), now()
  ) on conflict (customer_automation_id, event_key) do nothing;
  ledger_created := found;

  if ledger_created then
    update public.customer_automation_usage_entitlements
    set purchased_units = purchased_units + topup.units,
        warning_notified_at = null,
        exhausted_notified_at = null,
        updated_at = now()
    where id = entitlement.id;
  end if;

  update public.automation_usage_topups
  set entitlement_id = entitlement.id,
      status = 'paid',
      stripe_checkout_session_id = p_stripe_checkout_session_id,
      stripe_payment_intent_id = nullif(trim(coalesce(p_stripe_payment_intent_id, '')), ''),
      fulfilled_at = now(),
      updated_at = now()
  where id = topup.id;

  if ledger_created then
    insert into public.automation_events (
      customer_automation_id, buyer_id, automation_id, order_id,
      event_type, title, message, created_by, created_at
    ) values (
      topup.customer_automation_id, topup.buyer_id, topup.automation_id, topup.order_id,
      'webhook_usage_topup_paid', 'Additional webhook runs added',
      topup.units || ' additional runs are now available for this billing period.',
      'system', now()
    );
  end if;

  return jsonb_build_object(
    'ok', true, 'status', 'paid', 'duplicate', not ledger_created,
    'topup_id', topup.id, 'entitlement_id', entitlement.id, 'units', topup.units,
    'included_units', entitlement.included_units,
    'purchased_units', entitlement.purchased_units + case when ledger_created then topup.units else 0 end,
    'used_units', entitlement.used_units,
    'remaining_units', greatest(
      entitlement.included_units + entitlement.purchased_units + case when ledger_created then topup.units else 0 end - entitlement.used_units,
      0
    ),
    'period_end', entitlement.period_end
  );
end;
$$;

create or replace function public.renew_order_usage_entitlements(
  p_order_id uuid,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_source_key text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  item record;
  result jsonb;
  renewed integer := 0;
begin
  if p_order_id is null or p_period_start is null or p_period_end is null or p_period_end <= p_period_start then
    return jsonb_build_object('ok', false, 'renewed', 0, 'error', 'A valid order billing period is required.');
  end if;

  for item in
    select customer_automation.id
    from public.customer_automations as customer_automation
    join public.automations as product on product.id = customer_automation.automation_id
    where customer_automation.order_id = p_order_id
      and lower(coalesce(product.runtime_trigger_mode, '')) = 'buyer_webhook'
  loop
    result := public.ensure_customer_automation_usage_entitlement(
      item.id, p_period_start, p_period_end, p_source_key
    );
    if coalesce((result->>'ok')::boolean, false) then renewed := renewed + 1; end if;
  end loop;
  return jsonb_build_object('ok', true, 'renewed', renewed);
end;
$$;

revoke all on function public.ensure_customer_automation_usage_entitlement(uuid, timestamptz, timestamptz, text) from public, anon, authenticated;
revoke all on function public.reserve_buyer_webhook_runtime_dispatch(uuid, text, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.fulfill_customer_automation_usage_topup(uuid, text, text) from public, anon, authenticated;
revoke all on function public.renew_order_usage_entitlements(uuid, timestamptz, timestamptz, text) from public, anon, authenticated;
grant execute on function public.ensure_customer_automation_usage_entitlement(uuid, timestamptz, timestamptz, text) to service_role;
grant execute on function public.reserve_buyer_webhook_runtime_dispatch(uuid, text, jsonb, jsonb, jsonb, jsonb) to service_role;
grant execute on function public.fulfill_customer_automation_usage_topup(uuid, text, text) to service_role;
grant execute on function public.renew_order_usage_entitlements(uuid, timestamptz, timestamptz, text) to service_role;

select pg_notify('pgrst', 'reload schema');

commit;
