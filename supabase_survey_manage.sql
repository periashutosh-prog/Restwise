-- Run in the Supabase SQL editor, after supabase_admin.sql and supabase_import_export.sql.
-- Lets admins delete survey responses and the associated files, via RLS using their
-- OWN session token — no service_role key needed.

drop policy if exists "Admins can delete survey responses" on public.survey_responses;
create policy "Admins can delete survey responses"
  on public.survey_responses for delete
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid() and profiles.role = 'administrator'
    )
  );

drop policy if exists "Admins can delete survey PDFs" on storage.objects;
create policy "Admins can delete survey PDFs"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'survey-pdfs'
    and exists (
      select 1 from public.profiles
      where profiles.id = auth.uid() and profiles.role = 'administrator'
    )
  );

drop policy if exists "Admins can delete physical survey scans" on storage.objects;
create policy "Admins can delete physical survey scans"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'physical-surveys'
    and exists (
      select 1 from public.profiles
      where profiles.id = auth.uid() and profiles.role = 'administrator'
    )
  );
