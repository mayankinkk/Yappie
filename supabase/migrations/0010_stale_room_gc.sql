-- 0010: stale-room garbage collection.
-- Apply after 0009 (`supabase db push` or paste into the SQL editor).
--
-- Rooms are pure session state (queue, history, membership, grants) and used
-- to grow forever. This prunes rooms with no signs of life for `p_idle_days`:
--   * created longer ago than the horizon, AND
--   * no member heartbeat (`last_seen`, refreshed every ~30s while online)
--     or join/leave inside the horizon, AND
--   * no chat message inside the horizon
-- Membership and chat cascade on delete, so a single DELETE cleans up.
--
-- SECURITY DEFINER mirrors the other privileged helpers, but execution is
-- revoked from anon/authenticated: only the service role (the GitHub Actions
-- GC cron) or a SQL editor session may prune. Bounds are enforced so a
-- mistaken call can never nuke recent rooms.

create or replace function public.prune_stale_rooms(p_idle_days integer default 30)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_cutoff timestamptz;
begin
  if p_idle_days < 7 or p_idle_days > 365 then
    raise exception 'invalid_idle_days';
  end if;
  v_cutoff := now() - make_interval(days => p_idle_days);

  with gone as (
    delete from public.rooms r
    where r.created_at < v_cutoff
      and not exists (
        select 1 from public.room_members m
        where m.room_code = r.code
          and m.last_seen > v_cutoff
      )
      and not exists (
        select 1 from public.chat_messages c
        where c.room_code = r.code
          and c.created_at > v_cutoff
      )
    returning 1
  )
  select count(*) into v_count from gone;

  return v_count;
end;
$$;

revoke execute on function public.prune_stale_rooms(integer) from public, anon, authenticated;
grant execute on function public.prune_stale_rooms(integer) to service_role;
