-- BiyaHERO: one vote per account per hazard (admins included).
-- Paste into Supabase -> SQL Editor -> Run. Safe to re-run.

-- 1. Remove existing extra votes: keep each account's FIRST reaction per report.
delete from public.hazard_reactions r
using (
  select id,
         row_number() over (partition by report_id, user_id order by created_at, id) as rn
  from public.hazard_reactions
) d
where r.id = d.id and d.rn > 1;

-- 2. Make it impossible at the database level (one row per account per report).
drop index if exists public.hazard_reactions_one_per_user;
create unique index hazard_reactions_one_per_user
  on public.hazard_reactions (report_id, user_id);

-- 3. Remove the admin exemption from the trigger.
create or replace function public.enforce_reaction_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.hazard_reactions
    where report_id = new.report_id and user_id = new.user_id
  ) then
    raise exception 'You have already reacted to this report.';
  end if;
  return new;
end;
$$;

-- 4. Recompute the running totals from the cleaned-up reactions.
update public.hazard_reports hr set
  confirmations = (select count(*) from public.hazard_reactions x where x.report_id = hr.id and x.reaction = 'up'),
  disputes      = (select count(*) from public.hazard_reactions x where x.report_id = hr.id and x.reaction = 'down');

notify pgrst, 'reload schema';
