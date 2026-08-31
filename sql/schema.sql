-- ===========================================================================
-- Sonubrace database schema (PostgreSQL / Supabase)
--
-- Run this ONCE in the Supabase SQL editor before pointing config.js at your
-- project. It creates the two tables the platform uses and the row-level
-- security policies that make the public anon key safe to publish: every
-- policy checks auth.uid() = user_id, so a signed-in user can only ever read
-- or write their own rows, and an unauthenticated caller can read nothing.
--
-- These tables hold health information. Enable point-in-time recovery, keep
-- the service-role key out of any client, and make sure the study has whatever
-- ethics approval your institution requires before collecting real data.
-- ===========================================================================

-- ---------------------------------------------------------------- profiles --
create table if not exists public.health_profiles (
  user_id          uuid primary key references auth.users(id) on delete cascade,

  -- basics
  age              integer check (age between 1 and 120),
  sex              text check (sex in ('female','male','intersex')),
  height_cm        numeric(5,1) check (height_cm between 60 and 250),
  weight_kg        numeric(5,1) check (weight_kg between 20 and 300),

  -- recent vitals
  systolic_mmhg    integer check (systolic_mmhg between 60 and 260),
  diastolic_mmhg   integer check (diastolic_mmhg between 30 and 160),
  fasting_glucose  integer check (fasting_glucose between 40 and 500),

  -- history and lifestyle
  conditions       text[] default '{}',
  smoking          text check (smoking in ('never','former','current')),
  activity         text check (activity in ('active','moderate','light','sedentary')),
  alcohol          text check (alcohol in ('none','occasional','regular','heavy')),
  sleep_hours      numeric(3,1) check (sleep_hours between 0 and 16),
  family_history   boolean default false,
  medications      text,

  -- acquisition setup: these feed the Doppler equation directly
  site             text default 'radial',
  angle_deg        numeric(4,1) check (angle_deg >= 0 and angle_deg < 90),

  updated_at       timestamptz default now()
);

comment on column public.health_profiles.angle_deg is
  'Insonation angle in degrees. Velocity scales with 1/cos(theta), so this is the most '
  'influential single setting in the whole system. Must stay below 90.';

-- -------------------------------------------------------------- recordings --
create table if not exists public.recordings (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,

  -- the user names their own recordings and may rename them at any time
  name             text not null check (char_length(name) between 1 and 80),
  created_at       timestamptz not null default now(),

  source           text not null default 'simulation' check (source in ('simulation','device')),
  scenario         text,
  duration_s       numeric(6,2),
  site             text,
  angle_deg        numeric(4,1),
  signal_quality   numeric(4,3) check (signal_quality between 0 and 1),

  -- computed parameters: the three main ones plus the supporting indices
  params           jsonb not null default '{}'::jsonb,

  -- decimated velocity envelope; the full P(f,t) matrix is deliberately NOT
  -- stored, because everything the analysis needs is derivable from this
  envelope         jsonb,

  notes            text check (notes is null or char_length(notes) <= 500)
);

create index if not exists recordings_user_created_idx
  on public.recordings (user_id, created_at desc);

-- Frequently filtered in trend views.
create index if not exists recordings_params_pattern_idx
  on public.recordings ((params->>'patternKey'));

-- ------------------------------------------------------------------- RLS ----
alter table public.health_profiles enable row level security;
alter table public.recordings      enable row level security;

-- health_profiles: one row per user, owned entirely by that user.
drop policy if exists "own profile select" on public.health_profiles;
create policy "own profile select" on public.health_profiles
  for select using (auth.uid() = user_id);

drop policy if exists "own profile insert" on public.health_profiles;
create policy "own profile insert" on public.health_profiles
  for insert with check (auth.uid() = user_id);

drop policy if exists "own profile update" on public.health_profiles;
create policy "own profile update" on public.health_profiles
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own profile delete" on public.health_profiles;
create policy "own profile delete" on public.health_profiles
  for delete using (auth.uid() = user_id);

-- recordings: same ownership rule.
drop policy if exists "own recordings select" on public.recordings;
create policy "own recordings select" on public.recordings
  for select using (auth.uid() = user_id);

drop policy if exists "own recordings insert" on public.recordings;
create policy "own recordings insert" on public.recordings
  for insert with check (auth.uid() = user_id);

drop policy if exists "own recordings update" on public.recordings;
create policy "own recordings update" on public.recordings
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own recordings delete" on public.recordings;
create policy "own recordings delete" on public.recordings
  for delete using (auth.uid() = user_id);

-- ------------------------------------------------------------- housekeeping -
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists health_profiles_touch on public.health_profiles;
create trigger health_profiles_touch
  before update on public.health_profiles
  for each row execute function public.touch_updated_at();
