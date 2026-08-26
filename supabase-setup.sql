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
