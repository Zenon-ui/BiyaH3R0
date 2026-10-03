-- BiyaHERO: idempotent repair for Confirm / Dispute reactions. Safe to re-run.
-- Paste into Supabase -> SQL Editor -> Run.

create table if not exists public.hazard_reactions (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.hazard_reports on delete cascade,
  user_id uuid not null references auth.users on delete cascade,
  reaction text not null check (reaction in ('up','down')),
  created_at timestamptz not null default now()
);

create index if not exists idx_hazard_reactions_report on public.hazard_reactions (report_id);

alter table public.hazard_reactions enable row level security;

drop policy if exists "Authenticated users can view hazard reactions" on public.hazard_reactions;
create policy "Authenticated users can view hazard reactions"
  on public.hazard_reactions for select
  using ( auth.role() = 'authenticated' );

drop policy if exists "Users can insert their own hazard reactions" on public.hazard_reactions;
create policy "Users can insert their own hazard reactions"
  on public.hazard_reactions for insert
  with check ( auth.uid() = user_id and public.is_active(auth.uid()) );

drop policy if exists "Admins can delete hazard reactions" on public.hazard_reactions;
create policy "Admins can delete hazard reactions"
  on public.hazard_reactions for delete
  using ( public.is_admin(auth.uid()) );

create or replace function public.enforce_reaction_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin(new.user_id) and exists (
    select 1 from public.hazard_reactions
    where report_id = new.report_id and user_id = new.user_id
  ) then
    raise exception 'You have already reacted to this report.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_reaction_limit on public.hazard_reactions;
create trigger trg_enforce_reaction_limit
  before insert on public.hazard_reactions
  for each row execute procedure public.enforce_reaction_limit();

create or replace function public.apply_reaction_to_report()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.reaction = 'up' then
    update public.hazard_reports set confirmations = confirmations + 1 where id = new.report_id;
  else
    update public.hazard_reports set disputes = disputes + 1 where id = new.report_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_apply_reaction_to_report on public.hazard_reactions;
create trigger trg_apply_reaction_to_report
  after insert on public.hazard_reactions
  for each row execute procedure public.apply_reaction_to_report();



notify pgrst, 'reload schema';
