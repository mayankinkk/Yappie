-- 0013: moderation completion — kick + chat slow mode.
-- Apply after 0012 (`supabase db push` or paste into the SQL editor).
--
-- Kick = time-boxed rejoin block (kicked_until), distinct from ban which
-- lasts until the host unbans. join_room() rejects while kicked; the roster
-- realtime stream carries kicked_until so the kicked client leaves on its
-- own row update, same pattern as ban.
--
-- Slow mode = per-room minimum gap between one member's chat messages
-- (rooms.slow_mode_seconds, 0 = off, host-set). Enforced server-side inside
-- the existing chat rate-limit trigger; the client gate is courtesy only.

alter table public.room_members
  add column if not exists kicked_until timestamptz;

alter table public.rooms
  add column if not exists slow_mode_seconds integer not null default 0
  check (slow_mode_seconds between 0 and 300);

-- ---------------------------------------------------------------------------
-- join_room(): admit nobody who is currently kicked (redefine from 0003 —
-- Postgres forbids changing the return type in place).
-- ---------------------------------------------------------------------------
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
  p_granted_to uuid[],
  p_slow_mode integer
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
-- kick_member(): host-only, time-boxed; recorded in room_audit like ban.
-- ---------------------------------------------------------------------------
create or replace function public.kick_member(
  p_code text,
  p_user_id uuid,
  p_minutes integer default 5
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := upper(trim(coalesce(p_code, '')));
  v_mins integer := least(greatest(coalesce(p_minutes, 5), 1), 1440);
  v_name text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if not exists (select 1 from public.rooms where code = v_code and host_id = v_uid) then
    raise exception 'not_host';
  end if;
  if p_user_id = v_uid then
    raise exception 'invalid_target';
  end if;

  select display_name into v_name
  from public.room_members
  where room_code = v_code and user_id = p_user_id;

  if v_name is null then
    raise exception 'not_a_member';
  end if;

  update public.room_members
  set kicked_until = now() + make_interval(mins => v_mins)
  where room_code = v_code and user_id = p_user_id;

  insert into public.room_audit (room_code, actor_id, actor_name, action, target_id, target_name, detail)
  select v_code, v_uid, m.display_name, 'kick', p_user_id, v_name,
         'for ' || v_mins || ' minute(s)'
  from public.room_members m
  where m.room_code = v_code and m.user_id = v_uid;
end;
$$;

-- ---------------------------------------------------------------------------
-- Slow mode inside the existing flood gate (redefine trigger function).
-- ---------------------------------------------------------------------------
create or replace function public.enforce_chat_limits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slow integer;
begin
  if (
    select count(*) from public.chat_messages
    where room_code = new.room_code
      and sender_id = new.sender_id
      and created_at > now() - interval '5 seconds'
  ) >= 5 then
    raise exception 'chat_rate_limited';
  end if;

  select slow_mode_seconds into v_slow
  from public.rooms where code = new.room_code;

  if coalesce(v_slow, 0) > 0 then
    if exists (
      select 1 from public.chat_messages
      where room_code = new.room_code
        and sender_id = new.sender_id
        and created_at > now() - make_interval(secs => v_slow)
    ) then
      raise exception 'chat_slow_mode';
    end if;
  end if;

  return new;
end;
$$;

grant execute on function public.kick_member(text, uuid, integer) to authenticated;
grant execute on function public.join_room(text, text, text) to authenticated;
alter function public.join_room(text, text, text) set search_path = public, extensions;
