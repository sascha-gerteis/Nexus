-- One-time cleanup for existing paid orders that already have published outputs.
-- New outputs are handled automatically by runtime-submit-output.
update public.orders as o
set
  order_status = 'completed',
  updated_at = now()
where o.payment_status = 'paid'
  and coalesce(o.order_status, '') not in (
    'cancelled',
    'checkout_expired',
    'payment_failed',
    'refunded'
  )
  and exists (
    select 1
    from public.automation_outputs as ao
    where ao.order_id = o.id
      and ao.status = 'published'
  );

notify pgrst, 'reload schema';
