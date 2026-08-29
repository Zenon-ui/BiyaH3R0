-- ============================================================
-- BiyaHERO — Supabase setup
-- Run this once in your project's SQL Editor (Supabase Dashboard
-- -> SQL Editor -> New query -> paste this whole file -> Run).
-- ============================================================

-- Real, persistent user data table (separate from Supabase's own
-- internal auth.users table, which is managed for you and stores
-- the securely-hashed password — BiyaHERO's own code never sees or
-- handles a plaintext or hashed password directly).
create table if not exists public.profiles (
  id uuid references auth.users on delete cascade primary key,
  name text not null,
  email text not null,
  -- 'user' is the default and only role a signup can ever get itself —
  -- see the role-escalation trigger below. Promoting someone to 'admin'
  -- is a deliberate, separate step (see the ADMIN BOOTSTRAPPING note
  -- near the bottom of this file), never something the app itself can
  -- do to its own account.
  role text not null default 'user' check (role in ('user','admin')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Row Level Security: every user can only read/edit their own row.
drop policy if exists "Users can view own profile" on public.profiles;
create policy "Users can view own profile"
  on public.profiles for select
  using ( auth.uid() = id );

drop policy if exists "Users can update own profile" on public.profiles;
create policy "Users can update own profile"
  on public.profiles for update
  using ( auth.uid() = id );

drop policy if exists "Users can insert own profile" on public.profiles;
create policy "Users can insert own profile"
  on public.profiles for insert
  with check ( auth.uid() = id );

-- ============================================================
-- ROLE-BASED ACCESS CONTROL (admin system)
-- ============================================================
-- is_admin() is what every admin-only RLS policy below actually checks —
-- never the frontend. Even if someone bypasses BiyaHERO.js entirely and
-- calls the Supabase REST API directly with their own anon-key session,
-- these policies still apply; there is no frontend-only gate anywhere in
-- this system. security definer + a fixed search_path so it can read
-- profiles.role regardless of the calling user's own row-level access.
create or replace function public.is_admin(uid uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select coalesce((select role = 'admin' from public.profiles where id = uid), false);
$$;

-- Without this, "Users can update own profile" above (using auth.uid() =
-- id, with no column restriction) would let anyone grant themselves the
-- admin role with a single authenticated update() call — the classic way
-- a "hide the admin button in the UI" scheme actually gets bypassed. This
-- trigger makes that impossible at the database level: a role change is
-- only allowed when the row being changed is being changed BY an admin.
create or replace function public.prevent_role_self_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role and not public.is_admin(auth.uid()) then
    raise exception 'Only an existing admin can change a profile''s role.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_role_self_escalation on public.profiles;
create trigger trg_prevent_role_self_escalation
  before update on public.profiles
  for each row execute procedure public.prevent_role_self_escalation();

-- Lets an admin update/promote *other* users' profiles (e.g. from the
-- in-app Admin Dashboard) — separate from "Users can update own profile"
-- above, which only ever covers a user's own row.
drop policy if exists "Admins can update any profile" on public.profiles;
create policy "Admins can update any profile"
  on public.profiles for update
  using ( public.is_admin(auth.uid()) );

drop policy if exists "Admins can view all profiles" on public.profiles;
create policy "Admins can view all profiles"
  on public.profiles for select
  using ( public.is_admin(auth.uid()) );

-- Automatically create a profiles row whenever someone signs up via
-- supabase.auth.signUp(...) in BiyaHERO.js. `raw_user_meta_data->>'name'`
-- reads the { data: { name } } option passed at signup time.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name, email)
  values (new.id, coalesce(new.raw_user_meta_data->>'name', ''), new.email);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();


-- ============================================================
-- HAZARD REPORTS (shared, backend-moderated — replaces the old
-- "prototype sync" that only ever marked local reports as uploaded
-- without actually sending them anywhere)
-- ============================================================
-- One real, shared table other commuters' apps and the Admin Dashboard
-- both read from. BiyaHERO.js still queues a report in localStorage
-- first (so reporting still works offline) and inserts it here the next
-- time syncNow() runs with a connection — see fetchRoadRoute-style
-- comments in BiyaHERO.js for the offline-first reasoning.
create table if not exists public.hazard_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid references auth.users on delete set null,
  label text not null,
  category text,
  lat double precision not null,
  lng double precision not null,
  note text,
  status text not null default 'active' check (status in ('active','resolved','dismissed')),
  created_at timestamptz not null default now(),
  moderated_at timestamptz,
  moderated_by uuid references auth.users on delete set null
);

alter table public.hazard_reports enable row level security;

-- Any signed-in commuter can see the shared hazard feed (that's the
-- whole point of a community reports feature) and can file their own
-- report, but reporter_id must match their own auth.uid() — nobody can
-- submit a report under someone else's name.
drop policy if exists "Authenticated users can view hazard reports" on public.hazard_reports;
create policy "Authenticated users can view hazard reports"
  on public.hazard_reports for select
  using ( auth.role() = 'authenticated' );

drop policy if exists "Users can insert their own hazard reports" on public.hazard_reports;
create policy "Users can insert their own hazard reports"
  on public.hazard_reports for insert
  with check ( auth.uid() = reporter_id );

-- Moderation (marking resolved/dismissed, or deleting a bad report) is
-- admin-only, enforced here — NOT by hiding the moderation buttons in
-- the frontend. A non-admin user's own Supabase session, if pointed
-- directly at this table's update/delete endpoint, is rejected by
-- Postgres itself, regardless of what BiyaHERO.js's UI does or doesn't
-- show them.
drop policy if exists "Admins can moderate hazard reports" on public.hazard_reports;
create policy "Admins can moderate hazard reports"
  on public.hazard_reports for update
  using ( public.is_admin(auth.uid()) );

drop policy if exists "Admins can delete hazard reports" on public.hazard_reports;
create policy "Admins can delete hazard reports"
  on public.hazard_reports for delete
  using ( public.is_admin(auth.uid()) );


-- ============================================================
-- ADMIN BOOTSTRAPPING — read this before expecting the Admin Dashboard
-- to show up for anyone
-- ============================================================
-- Every new signup gets role = 'user' (the column default above), and
-- the trigger above means NOTHING in the app itself — not the API, not
-- a modified request, not admin-looking UI someone reveals in devtools —
-- can promote an account to 'admin'. That has to happen once, deliberately,
-- outside the app: in the Supabase Dashboard's SQL Editor, run
--
--   update public.profiles set role = 'admin' where email = 'you@gmail.com';
--
-- for whichever account(s) should be admins. (This direct SQL Editor
-- update runs as the Postgres owner role, not through PostgREST/RLS, so
-- the self-escalation trigger's "not admin yet" check doesn't block it —
-- that trigger only stops it from happening through the app's own
-- authenticated API calls.) After that, BiyaHERO.js's post-login role
-- fetch will pick it up and reveal the Admin Dashboard for that account.

-- ============================================================
-- OPTIONAL, RECOMMENDED HARDENING: server-side @gmail.com enforcement
-- ============================================================
-- BiyaHERO.js already rejects non-Gmail addresses in the browser before
-- ever calling signUp(). That's enough to satisfy normal use, but a
-- browser check alone can always be bypassed by someone calling the
-- Supabase API directly. For true backend enforcement, wire this
-- function up as a "Before User Created" Auth Hook:
--
--   Dashboard -> Authentication -> Hooks (Beta) -> Before User Created
--   -> Postgres function -> select "public.validate_gmail_domain"
--
-- (Hook availability can vary by Supabase plan/version — if you don't
-- see "Hooks" in your dashboard, the frontend check above is your
-- current safeguard; this is an extra layer, not a required step.)

create or replace function public.validate_gmail_domain(event jsonb)
returns jsonb
language plpgsql
as $$
declare
  user_email text := event->'user'->>'email';
begin
  if user_email is null or user_email !~* '^[A-Za-z0-9._%+-]+@gmail\.com$' then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'message', 'Only @gmail.com email addresses are allowed to register.'
      )
    );
  end if;
  return jsonb_build_object();
end;
$$;
