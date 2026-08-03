-- Run in the Supabase SQL editor.
-- Public student survey: anyone (unauthenticated) can submit, but nobody can read
-- other people's submissions back through the public anon key — this is student PII
-- (name, school, class), so it's write-only from the client's perspective. Only the
-- Supabase dashboard / service_role key can read it back.

create extension if not exists pgcrypto;

-- ---------- Storage bucket for the filled, signed PDF per submission ----------

insert into storage.buckets (id, name, public)
values ('survey-pdfs', 'survey-pdfs', false)
on conflict (id) do nothing;

-- Anyone can upload (insert) a PDF into this bucket...
create policy "Anyone can upload a survey PDF"
  on storage.objects for insert
  to anon, authenticated
  with check (bucket_id = 'survey-pdfs');

-- ...but nobody (anon or authenticated) can list, read, update, or delete objects in
-- it — no select/update/delete policy means those actions are denied by RLS default.

-- ---------- Structured response data (mirrors the printed form) ----------

create table if not exists public.survey_responses (
  id uuid primary key default gen_random_uuid(),

  is_anonymous boolean not null default false,
  respondent_name text,          -- null when is_anonymous = true
  student_class text not null,
  school text,                   -- null when is_anonymous = true

  q1_sleep_hours text not null,       -- 'a' | 'b' | 'c'
  q2_stress_frequency text not null,  -- 'a' | 'b' | 'c'
  q3_breaks text not null,            -- 'a' | 'b' | 'c'
  q4_energy_level text not null,      -- 'a' | 'b' | 'c' | 'd'
  q5_sleep_time text,
  q6_wake_time text,
  q7_tuition_days text,
  q8_tuition_subjects text,

  pdf_path text,                 -- object path inside the survey-pdfs bucket
  created_at timestamptz not null default now()
);

alter table public.survey_responses enable row level security;

create policy "Anyone can submit a survey response"
  on public.survey_responses for insert
  to anon, authenticated
  with check (true);

-- No select/update/delete policy => responses are private, readable only via the
-- Supabase dashboard or a service_role key.
