-- Run in Supabase SQL editor. Two tables:
--   1) timetables         — the parent's current schedule as JSON (source of truth for Compile)
--   2) smartwatch_status  — firmware versions + last compiled binary

create table if not exists public.timetables (
  id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  blocks jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_timetables_updated_at on public.timetables;
create trigger trg_timetables_updated_at
  before update on public.timetables
  for each row execute function public.set_updated_at();

alter table public.timetables enable row level security;

create policy "Timetable viewable by owner"
  on public.timetables for select
  using (auth.uid() = id);

create policy "Users can insert their own timetable"
  on public.timetables for insert
  with check (auth.uid() = id);

create policy "Users can update their own timetable"
  on public.timetables for update
  using (auth.uid() = id)
  with check (auth.uid() = id);


create table if not exists public.smartwatch_status (
  id uuid primary key default auth.uid() references auth.users(id) on delete cascade,

  current_version text,                       -- version currently flashed on the watch (last known)
  latest_version text,                        -- latest available firmware version
  latest_version_released_at date,            -- release date of latest version

  compiled_program text,                      -- base64-encoded RWBIN compiled schedule
  compiled_protocol_version smallint not null default 1,
  compiled_at timestamptz,                    -- when "Compile" was last run

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_smartwatch_status_updated_at on public.smartwatch_status;
create trigger trg_smartwatch_status_updated_at
  before update on public.smartwatch_status
  for each row execute function public.set_updated_at();

alter table public.smartwatch_status enable row level security;

create policy "Smartwatch status viewable by owner"
  on public.smartwatch_status for select
  using (auth.uid() = id);

create policy "Users can insert their own smartwatch status"
  on public.smartwatch_status for insert
  with check (auth.uid() = id);

create policy "Users can update their own smartwatch status"
  on public.smartwatch_status for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

-- Seed a starter row per existing user is not done automatically — the app
-- upserts on first Compile, so no seed data is required.
