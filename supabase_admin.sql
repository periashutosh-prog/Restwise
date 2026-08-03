-- Run in the Supabase SQL editor, after supabase_profiles.sql and supabase_survey.sql.
-- Adds a Standard/Administrator role to profiles, lets admins read survey data
-- (responses + the PDFs in the survey-pdfs bucket) via RLS using their OWN session
-- token — no service_role key needed anywhere in the app — and a guarded RPC for
-- promoting another user to admin.

-- ---------- Role column ----------

alter table public.profiles
  add column if not exists role text not null default 'standard';

alter table public.profiles
  drop constraint if exists profiles_role_check;

alter table public.profiles
  add constraint profiles_role_check check (role in ('standard', 'administrator'));

-- Seed the first administrator.
update public.profiles
set role = 'administrator'
where id = (select id from auth.users where lower(email) = 'periashutosh@gmail.com');

-- ---------- Admin read access (RLS, not a secret key) ----------

drop policy if exists "Admins can read all survey responses" on public.survey_responses;
create policy "Admins can read all survey responses"
  on public.survey_responses for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles
      where profiles.id = auth.uid() and profiles.role = 'administrator'
    )
  );

drop policy if exists "Admins can read survey PDFs" on storage.objects;
create policy "Admins can read survey PDFs"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'survey-pdfs'
    and exists (
      select 1 from public.profiles
      where profiles.id = auth.uid() and profiles.role = 'administrator'
    )
  );

-- ---------- Promote another user to admin (guarded RPC) ----------

create or replace function public.promote_to_admin(target_email text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  caller_role text;
  target_id uuid;
  rows_updated int;
begin
  select role into caller_role from public.profiles where id = auth.uid();
  if caller_role is distinct from 'administrator' then
    raise exception 'Only administrators can promote other users.';
  end if;

  select id into target_id from auth.users where lower(email) = lower(target_email);
  if target_id is null then
    raise exception 'No account found for that email.';
  end if;

  update public.profiles set role = 'administrator' where id = target_id;
  get diagnostics rows_updated = row_count;
  if rows_updated = 0 then
    raise exception 'That user has not completed their Restwise profile yet.';
  end if;

  return true;
end;
$$;

grant execute on function public.promote_to_admin(text) to authenticated;
