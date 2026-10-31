-- 0017: room identity, capacity, and guest-approval admission.
-- Apply after 0016 (`supabase db push` or paste into the SQL editor).
--
-- Rooms were anonymous: a 6-character code and nothing else, unlimited
-- headcount, and anyone holding the link walked straight in (password and
-- lock were the only gates). This adds:
--   * name / topic      — what the room is; shown in the header and stage
--   * max_members       — hard participant cap, enforced by join_room and
--                         approve_join (null = unlimited, old rooms unchanged)
--   * require_approval  — strangers are refused by join_room with
--                         'approval_required'; the waiting client asks over
--                         the room channel, and the host admits them through
--                         approve_join (host-only, SECURITY DEFINER) or
--                         declines over the same channel
--
-- Contract (client maps errors in rooms-api.ts mapError):
--   join_room    → ... existing codes | room_full | approval_required
--   approve_join → not_authenticated | room_not_found | not_host |
--                  banned | kicked | room_full

alter table public.rooms
  add column if not exists name text,
  add column if not exists topic text,
  add column if not exists max_members integer,
  add column if not exists require_approval boolean not null default false;

alter table public.rooms drop constraint if exists rooms_name_len;
alter table public.rooms add constraint rooms_name_len
  check (name is null or char_length(name) <= 40);

alter table public.rooms drop constraint if exists rooms_topic_len;
alter table public.rooms add constraint rooms_topic_len
  check (topic is null or char_length(topic) <= 120);

alter table public.rooms drop constraint if exists rooms_max_members_bounds;
alter table public.rooms add constraint rooms_max_members_bounds
  check (max_members is null or (max_members >= 2 and max_members <= 100));

-- ---------------------------------------------------------------------------
-- join_room(): unchanged through password/lock, plus the two new gates.
-- Already-admitted members (left_at is null) pass every gate on rejoin —
-- capacity and approval only ever face people who aren't in the room yet.
-- ---------------------------------------------------------------------------
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
  p_granted_to uuid[],
  p_slow_mode integer
)
language plpgsql
security definer
set search_path = public, extensions
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

  if v_member.kicked_until is not null and v_member.kicked_until > now() then
    raise exception 'kicked';
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

  -- Participant cap (0017): members may come and going members may return;
  -- everyone new faces the count.
  if v_room.max_members is not null
     and (v_member.user_id is null or v_member.left_at is not null)
     and (select count(*) from public.room_members
          where room_code = v_room.code and left_at is null) >= v_room.max_members then
    raise exception 'room_full';
  end if;

  -- Guest approval (0017): strangers wait for the host to call approve_join;
  -- the waiting client rejoins once the membership row exists.
  if v_room.require_approval
     and (v_member.user_id is null or v_member.left_at is not null) then
    raise exception 'approval_required';
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
           (r.password_hash is not null), r.granted_to, r.slow_mode_seconds
    from public.rooms r
    where r.code = v_room.code;
end;
$$;

-- ---------------------------------------------------------------------------
-- approve_join(): host-only admission for require_approval rooms (0017).
-- Inserts the waiting user's membership (or revives a left one) so their
-- retried join_room succeeds; the capacity check runs first, so an approval
-- can never overfill the room. Recorded in room_audit like ban/kick.
-- ---------------------------------------------------------------------------
create or replace function public.approve_join(
  p_code text,
  p_user uuid,
  p_name text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := upper(trim(coalesce(p_code, '')));
  v_room public.rooms%rowtype;
  v_member public.room_members%rowtype;
  v_actor_name text;
  v_target_name text := left(coalesce(nullif(trim(p_name), ''), 'Guest'), 24);
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select * into v_room from public.rooms where code = v_code;
  if not found then
    raise exception 'room_not_found';
  end if;
  if v_room.host_id <> v_uid then
    raise exception 'not_host';
  end if;

  select * into v_member
  from public.room_members where room_code = v_code and user_id = p_user;

  if v_member.user_id is not null and v_member.banned then
    raise exception 'banned';
  end if;
  if v_member.kicked_until is not null and v_member.kicked_until > now() then
    raise exception 'kicked';
  end if;

  if v_room.max_members is not null
     and (v_member.user_id is null or v_member.left_at is not null)
     and (select count(*) from public.room_members
          where room_code = v_code and left_at is null) >= v_room.max_members then
    raise exception 'room_full';
  end if;

  insert into public.room_members (room_code, user_id, display_name)
  values (v_code, p_user, v_target_name)
  on conflict (room_code, user_id) do update
    set left_at = null,
        last_seen = now(),
        display_name = excluded.display_name
    where not room_members.banned;

  select display_name into v_actor_name
  from public.room_members where room_code = v_code and user_id = v_uid;

  insert into public.room_audit (room_code, actor_id, actor_name, action, target_id, target_name)
  values (v_code, v_uid, coalesce(v_actor_name, 'Host'), 'approve_join', p_user, v_target_name);
end;
$$;

grant execute on function public.join_room(text, text, text) to authenticated;
grant execute on function public.approve_join(text, uuid, text) to authenticated;
