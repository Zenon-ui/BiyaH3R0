-- BiyaHERO: idempotent repair for hazard sync. Safe to run more than once.
-- Paste into Supabase -> SQL Editor -> Run.

-- 1. Columns the app inserts into (missing ones cause PGRST204 / 42703 errors)
alter table public.hazard_reports add column if not exists category text;
alter table public.hazard_reports add column if not exists confirmations integer not null default 0;
alter table public.hazard_reports add column if not exists disputes integer not null default 0;
alter table public.hazard_reports add column if not exists initial_confidence integer not null default 40;

-- 2. The insert policy requires is_active(auth.uid()), which is FALSE when a
--    user has no profiles row (accounts created before handle_new_user()
--    existed). Create the missing rows.
insert into public.profiles (id, name, email)
select u.id,
       coalesce(nullif(u.raw_user_meta_data->>'name',''), split_part(u.email,'@',1)),
       u.email
from auth.users u
left join public.profiles p on p.id = u.id
where p.id is null
on conflict do nothing;

-- 3. Make sure nobody is stuck with a null/odd status
update public.profiles set status = 'active' where status is null;

-- 4. Refresh the API schema cache so new columns are seen immediately
notify pgrst, 'reload schema';
