-- Change credential uniqueness from "same secret fingerprint" to "same owner/provider/name".
--
-- Run this once in Supabase SQL editor, then redeploy developer-credentials.
-- This allows a developer/admin to save multiple OpenAI/Gemini/etc credentials
-- for the same provider as long as each saved credential has a different label.

drop index if exists public.idx_developer_credentials_fingerprint;

do $$
begin
  if to_regclass('public.developer_credentials') is null then
    raise notice 'developer_credentials table does not exist yet. Run developer_credentials_install_or_patch.sql first.';
    return;
  end if;

  if exists (
    select 1
    from public.developer_credentials
    where status <> 'revoked'
    group by
      coalesce(developer_id, '00000000-0000-0000-0000-000000000000'::uuid),
      lower(provider),
      lower(label)
    having count(*) > 1
  ) then
    raise exception 'Duplicate active credential names exist. Rename or revoke duplicates before creating the name uniqueness index.';
  end if;

  create unique index if not exists idx_developer_credentials_owner_provider_label
    on public.developer_credentials(
      coalesce(developer_id, '00000000-0000-0000-0000-000000000000'::uuid),
      lower(provider),
      lower(label)
    )
    where status <> 'revoked';
end $$;

notify pgrst, 'reload schema';
