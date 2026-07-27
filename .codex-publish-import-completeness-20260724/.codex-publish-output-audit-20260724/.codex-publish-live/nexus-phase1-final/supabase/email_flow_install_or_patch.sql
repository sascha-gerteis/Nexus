-- Nexus transactional email flow install/patch.
-- Run this in Supabase SQL editor, then deploy send-platform-email and updated functions.

create table if not exists public.email_queue (
  id uuid primary key default gen_random_uuid(),
  recipient_email text not null,
  recipient_name text,
  email_type text not null,
  subject text not null,
  html_body text not null,
  text_body text not null,
  status text not null default 'pending',
  dedupe_key text,
  scheduled_for timestamptz not null default now(),
  sending_started_at timestamptz,
  sent_at timestamptz,
  failed_at timestamptz,
  attempt_count integer not null default 0,
  provider text,
  provider_message_id text,
  last_error text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.email_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  email text not null,
  transactional_enabled boolean not null default true,
  onboarding_enabled boolean not null default true,
  message_notifications_enabled boolean not null default true,
  marketing_enabled boolean not null default false,
  unsubscribed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'email_queue_status_check'
  ) then
    alter table public.email_queue
      add constraint email_queue_status_check
      check (status in ('pending', 'sending', 'sent', 'failed', 'skipped'));
  end if;
end $$;

create unique index if not exists idx_email_queue_dedupe_key
  on public.email_queue (dedupe_key)
  where dedupe_key is not null and dedupe_key <> '';

create index if not exists idx_email_queue_due
  on public.email_queue (status, scheduled_for)
  where status = 'pending';

create index if not exists idx_email_queue_recipient_created
  on public.email_queue (recipient_email, created_at desc);

create unique index if not exists idx_email_preferences_user
  on public.email_preferences (user_id)
  where user_id is not null;

create unique index if not exists idx_email_preferences_email
  on public.email_preferences (lower(email));

alter table public.email_queue enable row level security;
alter table public.email_preferences enable row level security;

grant select on public.email_queue to authenticated;
grant select, update on public.email_preferences to authenticated;

drop policy if exists "Admins can manage email queue" on public.email_queue;
create policy "Admins can manage email queue"
on public.email_queue
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

drop policy if exists "Users can read own email preferences" on public.email_preferences;
create policy "Users can read own email preferences"
on public.email_preferences
for select
to authenticated
using (
  user_id = auth.uid()
  or exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'admin'
  )
);

drop policy if exists "Users can update own email preferences" on public.email_preferences;
create policy "Users can update own email preferences"
on public.email_preferences
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

select pg_notify('pgrst', 'reload schema');

-- Delivery setup notes:
-- 1. Google Workspace can stay as your inbox/MX provider.
-- 2. Use a transactional sender such as Resend, Postmark, Brevo, or MailerSend for HTTP email delivery.
-- 3. Add the provider DNS records in GoDaddy. Do not remove Google Workspace MX records.
-- 4. Set Supabase secrets, for example:
--    EMAIL_PROVIDER=resend
--    EMAIL_FROM_EMAIL=support@nexus-ai.software
--    EMAIL_FROM_NAME=Nexus
--    EMAIL_REPLY_TO=support@nexus-ai.software
--    NEXUS_SITE_URL=https://nexus-ai.software
--    RESEND_API_KEY=<your-resend-api-key>
--    EMAIL_CRON_SECRET=<random-secret>
--
-- Optional Supabase Cron after deploying send-platform-email:
--
-- create extension if not exists pg_cron with schema extensions;
-- create extension if not exists pg_net with schema extensions;
--
-- select cron.schedule(
--   'nexus-email-queue-5min',
--   '*/5 * * * *',
--   $$
--   select net.http_post(
--     url := 'https://<PROJECT_REF>.supabase.co/functions/v1/send-platform-email',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'x-nexus-email-secret', '<EMAIL_CRON_SECRET>'
--     ),
--     body := jsonb_build_object('action', 'send_due', 'limit', 25)
--   );
--   $$
-- );
