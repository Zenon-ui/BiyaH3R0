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
-- MAP POIs (admin-managed, backend-enforced)
-- ============================================================
-- This table now holds BOTH the app's original bundled destinations
-- (seeded below, migrated from the lagunaDestinations array that used
-- to be the only copy of this data, hardcoded in BiyaHERO.js) and any
-- new POIs an admin adds later — one real, shared source of truth
-- instead of two. BiyaHERO.js still ships lagunaDestinations as an
-- offline fallback (so the map has real places on it before the first
-- successful sync, or with no connection at all) but treats this table
-- as authoritative once it's reachable — see loadLivePois() in
-- BiyaHERO.js. Editing/deleting a seed POI works exactly like any
-- other row here once it's been seeded; there's no special case.
create table if not exists public.pois (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  sub text,
  category text not null,
  lat double precision not null,
  lng double precision not null,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.pois enable row level security;

-- Read access matches hazard_reports: any signed-in commuter sees the
-- shared POI set (that's the point — an admin adding a POI should show
-- up on everyone's map), but only admins can write.
drop policy if exists "Authenticated users can view POIs" on public.pois;
create policy "Authenticated users can view POIs"
  on public.pois for select
  using ( auth.role() = 'authenticated' );

drop policy if exists "Admins can insert POIs" on public.pois;
create policy "Admins can insert POIs"
  on public.pois for insert
  with check ( public.is_admin(auth.uid()) );

drop policy if exists "Admins can update POIs" on public.pois;
create policy "Admins can update POIs"
  on public.pois for update
  using ( public.is_admin(auth.uid()) );

drop policy if exists "Admins can delete POIs" on public.pois;
create policy "Admins can delete POIs"
  on public.pois for delete
  using ( public.is_admin(auth.uid()) );

create or replace function public.set_poi_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_pois_updated_at on public.pois;
create trigger trg_pois_updated_at
  before update on public.pois
  for each row execute procedure public.set_poi_updated_at();

-- Seed data — migrates the app's original bundled destinations list
-- (the lagunaDestinations array already baked into BiyaHERO.js) into
-- this table too, so an admin opening the Dashboard for the first time
-- sees the full real POI set rather than an empty table, and can add to
-- or build on what's already there. Safe to re-run: the WHERE NOT
-- EXISTS guard skips a row if a POI with that exact name already
-- exists, so running this file twice won't create duplicates.
insert into public.pois (name, sub, category, lat, lng)
select * from (values
  ('Santa Cruz Public Market', 'Santa Cruz, Laguna (provincial capital)', 'City Center', 14.2814, 121.4157),
  ('SM City Santa Rosa', 'Santa Rosa City, Laguna', 'Mall', 14.3123, 121.0947),
  ('Calamba City Hall', 'Calamba City, Laguna', 'City Center', 14.2117, 121.1653),
  ('San Pablo City Plaza', 'San Pablo City, Laguna', 'City Center', 14.0703, 121.3256),
  ('Biñan City Hall', 'Biñan City, Laguna', 'City Center', 14.3426, 121.0839),
  ('Cabuyao City Hall', 'Cabuyao City, Laguna', 'City Center', 14.2776, 121.125),
  ('Los Baños Municipal Hall', 'Los Baños, Laguna', 'City Center', 14.17, 121.2237),
  ('Sta. Rosa Tagaytay Road', 'Santa Rosa City, Laguna', 'Road', 14.287, 121.089),
  ('Enchanted Kingdom', 'San Lorenzo, Santa Rosa City, Laguna', 'Theme Park', 14.2819473, 121.0953936),
  ('University of the Philippines Los Baños (UPLB)', 'Los Baños, Laguna', 'University', 14.1651, 121.2415),
  ('Pagsanjan Falls', 'Pagsanjan, Laguna', 'Landmark', 14.2697, 121.4527),
  ('Rizal Shrine, Calamba', 'Calamba City, Laguna', 'Landmark', 14.2138, 121.1652),
  ('Nagcarlan Underground Cemetery', 'Brgy. Bambang, Nagcarlan, Laguna', 'Landmark', 14.13135, 121.41482),
  ('Paete Church', 'Paete, Laguna', 'Landmark', 14.3667, 121.48),
  ('Lake Caliraya', 'Lumban / Cavinti / Kalayaan, Laguna', 'Landmark', 14.29583, 121.53194),
  ('Mount Makiling', 'Los Baños / Bay, Laguna', 'Landmark', 14.1367, 121.205),
  ('Seven Lakes, San Pablo', 'San Pablo City, Laguna', 'Landmark', 14.0781, 121.3272),
  ('Pila Heritage Town Plaza', 'Pila, Laguna', 'Landmark', 14.2333, 121.3667),
  ('Majayjay Church (Taytay Falls area)', 'Majayjay, Laguna', 'Landmark', 14.1444, 121.4736),
  ('San Pablo Cathedral', 'Cathedral-Parish of St. Paul the First Hermit, San Pablo City', 'Church', 14.069725, 121.326575),
  ('San Pablo City Hall', 'San Pablo City, Laguna', 'Government', 14.070007, 121.325681),
  ('SM City San Pablo', 'Maharlika Highway, Brgy. San Rafael, San Pablo City', 'Mall', 14.07145, 121.30177),
  ('San Pablo City Science Integrated High School', 'San Pablo City, Laguna', 'School', 14.06452, 121.34254),
  ('San Pablo City National High School', 'Brgy. VI-D, San Pablo City, Laguna', 'School', 14.07673, 121.32092),
  ('San Pablo District Hospital', 'San Pablo City, Laguna (approx. — near Sampaloc Lake)', 'Hospital', 14.0775, 121.326),
  ('San Pedro City Hall', 'San Pedro City, Laguna', 'City Center', 14.3583, 121.0583),
  ('Saint Peter of Alcantara Parish Church (Pakil)', 'Pakil, Laguna — Diocesan Shrine of Our Lady of Turumba', 'Church', 14.380826, 121.478914),
  ('Siniloan Church (Sts. Peter and Paul Parish)', 'Siniloan, Laguna', 'Church', 14.421999, 121.446129),
  ('San Agustin Parish Church, Bay', 'Bay, Laguna — the old Laguna provincial capital', 'Church', 14.180369, 121.284315),
  ('Saint John the Baptist Parish Church (Liliw)', 'Liliw, Laguna — the "Flip-flops Capital of the Philippines"', 'Church', 14.12982, 121.43581),
  ('Mercury Drug – Sta. Rosa Poblacion', 'Gomez St / Tatlong Hari St, Market Area, Santa Rosa City', 'Pharmacy', 14.313827, 121.112702),
  ('Petron – Bypass Road', 'Barangay Bucal, Calamba City', 'Gas Station', 14.181185, 121.15913),
  ('Shell – San Rafael', 'Brgy. San Rafael, San Pablo City', 'Gas Station', 14.07119, 121.304877),
  ('Caltex – Balibago / RSBS Blvd', 'Balibago, Santa Rosa City', 'Gas Station', 14.288834, 121.094695),
  ('Security Bank – Biñan', 'National Highway, Biñan City', 'Bank', 14.333108, 121.08152),
  ('BDO – Biñan Central Mall', 'Malvar St. cor. Old National Hwy, Biñan City', 'Bank', 14.332739, 121.082215),
  ('BPI ATM – Waltermart Cabuyao', 'KM 47 National Hwy, Brgy. Banlic, Cabuyao City', 'Bank', 14.232896, 121.134128),
  ('SM Supermarket – SM City San Pablo', 'National Highway, San Pablo City', 'Supermarket', 14.071201, 121.302592),
  ('South Supermarket', 'National Highway, Los Baños', 'Supermarket', 14.176812, 121.262219),
  ('Los Baños Public Market', '149 Villegas St., Los Baños', 'Wet Market', 14.181555, 121.224374),
  ('Pamilihang Bayan ng Batong Malake', 'National Highway, Los Baños', 'Wet Market', 14.179636, 121.24054),
  ('Cabuyao City Police Station', 'Manila South Rd, Cabuyao City', 'Police', 14.271199, 121.124208),
  ('Santa Cruz Municipal Police Station', 'A. Mabini St., Santa Cruz', 'Police', 14.282458, 121.416004),
  ('Santa Rosa City Fire Station', 'Rizal Ave, Santa Rosa City', 'Fire Station', 14.31575, 121.110555),
  ('Laguna Technopark Fire Station', 'Science Ave, Don Jose, Santa Rosa City', 'Fire Station', 14.26136, 121.057583),
  ('San Pedro Doctors Hospital', 'National Highway, San Pedro City', 'Hospital', 14.348863, 121.064919),
  ('LPH – San Pedro District Hospital', 'Puerto Azul St., San Pedro City', 'Hospital', 14.362976, 121.042297),
  ('Calamba Medical Center', 'Crossing, Asian Hwy, Calamba City', 'Hospital', 14.206167, 121.152387),
  ('Calamba Doctors Hospital', 'KM 49, San Cristobal Bridge, Calamba City', 'Hospital', 14.217319, 121.141912),
  ('Dr. Jose P. Rizal Memorial Provincial Hospital', 'Manila South Rd, Calamba City', 'Hospital', 14.191669, 121.167549),
  ('Robinsons Place Santa Rosa', 'Manila South Rd, Santa Rosa City', 'Mall', 14.319167, 121.096667),
  ('Central Mall Biñan', 'Manila South Rd, Biñan City', 'Mall', 14.332788, 121.082296),
  ('SM City Calamba', 'National Road, Brgy. Real, Calamba City', 'Mall', 14.204185, 121.154586),
  ('Jollibee Pacita', 'Pacita Complex, National Hwy, San Pedro City', 'Fast Food', 14.346811, 121.06565),
  ('Bertie''s Artisan Bakeshop', 'Bucal Bypass Rd, Calamba City', 'Bakery', 14.17885, 121.155876),
  ('Pidol''s Bakeshop – Calamba', 'San Jose Rd, Calamba City', 'Bakery', 14.213768, 121.169877),
  ('Calle Arco Restaurant', 'Pagsanjan (riverside dining)', 'Restaurant', 14.273165, 121.453248),
  ('SM Calamba Parking Area', 'Real Rd, Brgy. Real, Calamba City', 'Parking', 14.202951, 121.154139),
  ('Bacay''s Water Refilling Station', 'Marcos Paulino St., San Pablo City', 'Water Station', 14.064392, 121.325789),
  ('LLi Bus Terminal', 'Pagsanjan', 'Terminal', 14.264924, 121.430832),
  ('SLEX Santa Rosa Exit', 'South Luzon Expressway, Santa Rosa City', 'Highway', 14.301, 121.085),
  ('SLEX Calamba Exit', 'South Luzon Expressway, Calamba City', 'Highway', 14.225, 121.14),
  ('Manila South Road, San Pablo', 'National Highway, San Pablo City', 'Highway', 14.085, 121.31)
) as v(name, sub, category, lat, lng)
where not exists (select 1 from public.pois p where p.name = v.name);



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
