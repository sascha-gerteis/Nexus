-- Private objects uploaded by the owner admin and exposed only through short-lived,
-- buyer-authorized signed URLs from the managed-deliverables Edge Function.
insert into storage.buckets (id, name, public, file_size_limit)
values ('buyer-deliverables', 'buyer-deliverables', false, 52428800)
on conflict (id) do update
set public = false,
    file_size_limit = 52428800;