begin;

alter table public.message_threads
  drop constraint if exists message_threads_thread_type_check;

alter table public.message_threads
  add constraint message_threads_thread_type_check
  check (thread_type in (
    'product_inquiry',
    'developer_inquiry',
    'order_support',
    'custom_request',
    'admin_support',
    'admin_developer'
  )) not valid;

alter table public.message_threads validate constraint message_threads_thread_type_check;

commit;
