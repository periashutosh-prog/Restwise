-- Run in the Supabase SQL editor, after supabase_survey.sql and supabase_admin.sql.
-- Adds: a survey_type column (digital vs. admin-transcribed online_physical), and a
-- private bucket for scanned Physical Survey pages (PNG, one per response), with
-- admin-only read/write RLS (not a service_role key).

-- ---------- Distinguish digital vs. admin-transcribed responses ----------

alter table public.survey_responses
  add column if not exists survey_type text not null default 'digital';

alter table public.survey_responses
  drop constraint if exists survey_responses_type_check;

alter table public.survey_responses
  add constraint survey_responses_type_check check (survey_type in ('digital', 'online_physical'));

-- pdf_path is null for online_physical rows — those PDFs are regenerated on export
-- from the saved answers, not stored ahead of time.

-- ---------- Physical Surveys bucket (scanned PNGs, one per response) ----------

insert into storage.buckets (id, name, public)
values ('physical-surveys', 'physical-surveys', false)
on conflict (id) do nothing;

drop policy if exists "Admins can upload physical survey scans" on storage.objects;
create policy "Admins can upload physical survey scans"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'physical-surveys'
    and exists (
      select 1 from public.profiles
      where profiles.id = auth.uid() and profiles.role = 'administrator'
    )
  );

drop policy if exists "Admins can read physical survey scans" on storage.objects;
create policy "Admins can read physical survey scans"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'physical-surveys'
    and exists (
      select 1 from public.profiles
      where profiles.id = auth.uid() and profiles.role = 'administrator'
    )
  );
