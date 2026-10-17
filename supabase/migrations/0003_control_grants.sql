-- 0003: per-user playback control grants.
-- The host can approve a guest's "ask for control" request; the grant is durable
-- server state (RLS keeps writes host-only) and can be revoked from the roster.

alter table public.rooms
  add column if not exists granted_to uuid[] not null default '{}';

-- join_room now returns the grant list so a rejoining guest restores control
-- immediately, not on the next host UPDATE. (Postgres forbids changing a
-- function's return type in place — drop the old signature first.)
drop function if exists public.join_room(text, text, text);

create or replace function public.join_room(
  p_code text,
  p_password text default null,
  p_name text default 'Guest'
)
returns table (
  p_host_id uuid,
  p_guests_can_control boolean,
  p_locked boolean,
  p_queue jsonb,
  p_queue_version integer,
  p_video_id text,
  p_password_required boolean,
  p_granted_to uuid[]
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_room public.rooms%rowtype;
  v_member public.room_members%rowtype;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select * into v_room from public.rooms where code = upper(trim(coalesce(p_code, '')));
  if not found then
    raise exception 'room_not_found';
  end if;

  select * into v_member
  from public.room_members where room_code = v_room.code and user_id = v_uid;

  if v_member.user_id is not null and v_member.banned then
    raise exception 'banned';
  end if;

  -- Password is only required for users who were never members of this room.
  if v_room.password_hash is not null and v_member.user_id is null then
    if p_password is null then
      raise exception 'password_required';
    end if;
    if crypt(p_password, v_room.password_hash) <> v_room.password_hash then
      raise exception 'password_wrong';
    end if;
  end if;

  -- Locked rooms admit no one who isn't already a member.
  if v_room.locked and (v_member.user_id is null or v_member.left_at is not null) then
    raise exception 'locked';
  end if;

  insert into public.room_members (room_code, user_id, display_name)
  values (v_room.code, v_uid, left(coalesce(nullif(trim(p_name), ''), 'Guest'), 24))
  on conflict (room_code, user_id) do update
    set left_at = null,
        last_seen = now(),
        display_name = excluded.display_name
    where not room_members.banned;

  return query
    select r.host_id, r.guests_can_control, r.locked, r.queue, r.queue_version, r.video_id,
           (r.password_hash is not null), r.granted_to
    from public.rooms r
    where r.code = v_room.code;
end;
$$;
