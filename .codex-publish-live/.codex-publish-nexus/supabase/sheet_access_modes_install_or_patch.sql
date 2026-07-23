-- Google Sheets access modes for Nexus workflow products.
-- Run this once in the Supabase SQL editor before using private per-customer sheets.

alter table if exists public.customer_automations
  add column if not exists private_google_sheet_id text,
  add column if not exists private_google_sheet_url text,
  add column if not exists private_google_sheet_template_id text,
  add column if not exists private_google_sheet_service_account_email text,
  add column if not exists private_google_sheet_provisioned_at timestamptz;

create index if not exists idx_customer_automations_private_google_sheet_id
  on public.customer_automations(private_google_sheet_id)
  where private_google_sheet_id is not null;

notify pgrst, 'reload schema';
