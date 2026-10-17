-- 0001: server-authoritative rooms (host, settings, queue, membership).
-- Apply with `supabase db push` (after `supabase link`) or paste into the SQL editor.
--
-- Security model:
--   * Room code alone never grants power: joining goes through join_room() which
--     validates password / lock / ban server-side and writes membership rows.
--   * host_id lives in Postgres; clients can never elect themselves — claim_host()
--     is a compare-and-swap that only succeeds when the current host is gone/stale
--     and the caller is the most senior online member.
--   * Settings/queue updates (rooms table) are RLS-gated to the current host_id,
--     so even a modified client cannot change them.
--   * Playback control travels over Realtime broadcasts (latency); receivers
--     reject payloads whose senderId is not the DB host. See README "Security".

create extension if not exists pgcrypto;

create table if not exists public.rooms (
  code text primary key check (code ~ '^[A-Z0-9]{6}$'),
  host_id uuid not null,
  created_by uuid not null,
  guests_can_control boolean not null default true,
  password_hash text,
  locked boolean not null default false,
  queue jsonb not null default '[]'::jsonb,
  queue_version integer not null default 0,
  video_id text,
  created_at timestamptz not null default now()
);
create index if not exists rooms_host_idx on public.rooms (host_id);

create table if not exists public.room_members (
  room_code text not null references public.rooms (code) on delete cascade,
  user_id uuid not null,
  display_name text not null default 'Guest',
  banned boolean not null default false,
  muted_until timestamptz,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  last_seen timestamptz not null default now(),
  primary key (room_code, user_id)
);
create index if not exists room_members_user_idx on public.room_members (user_id);
create index if not exists room_members_room_active_idx on public.room_members (room_code, left_at);

alter table public.rooms enable row level security;
alter table public.room_members enable row level security;

-- Read: active, non-banned members only.
create policy "members read room" on public.rooms for select using (
  exists (
    select 1 from public.room_members m
    where m.room_code = rooms.code and m.user_id = auth.uid() and not m.banned
  )
);
create policy "members read roster" on public.room_members for select using (
  exists (
    select 1 from public.room_members m
    where m.room_code = room_members.room_code and m.user_id = auth.uid() and not m.banned
  )
);

-- Write: host only. host_id may only be transferred to an existing member
-- (direct transfer by the host, or via claim_host()/leave_room()).
create policy "host updates room" on public.rooms for update
  using (host_id = auth.uid())
  with check (
    host_id = auth.uid()
    or exists (
      select 1 from public.room_members m
      where m.room_code = rooms.code and m.user_id = host_id and not m.banned
    )
  );

-- All membership writes go through security-definer functions below.
revoke insert, update, delete on public.room_members from anon, authenticated;
revoke insert, delete on public.rooms from anon, authenticated;
grant select, update on public.rooms to authenticated;
grant select on public.room_members to authenticated;

-- Realtime broadcast of changes (host migration, settings, bans land instantly).
do $$
begin
  alter publication supabase_realtime add table public.rooms;
exception when duplicate_object then null;
end $$;
do $$
begin
  alter publication supabase_realtime add table public.room_members;
exception when duplicate_object then null;
end $$;

-- Create a room; creator becomes host + first member.
-- Password (optional) is bcrypt-hashed; never returned to clients.
create or replace function public.create_room(p_password text default null, p_name text default 'Guest')
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_alpha constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v_bytes bytea;
  v_code text;
  v_hash text := null;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if coalesce(length(trim(coalesce(p_password, ''))), 0) > 0 then
    v_hash := crypt(trim(p_password), gen_salt('bf', 10));
  end if;
  if (select count(*) from public.rooms where created_by = v_uid and created_at > now() - interval '1 minute') >= 5 then
    raise exception 'rate_limited';
  end if;

  for _ in 1..5 loop
    v_bytes := gen_random_bytes(6);
    v_code := '';
    for i in 0..5 loop
      v_code := v_code || substr(v_alpha, 1 + (get_byte(v_bytes, i) % 32), 1);
    end loop;
    begin
      insert into public.rooms (code, host_id, created_by, password_hash)
      values (v_code, v_uid, v_uid, v_hash);
      insert into public.room_members (room_code, user_id, display_name)
      values (v_code, v_uid, left(coalesce(nullif(trim(p_name), ''), 'Guest'), 24));
      return v_code;
    exception when unique_violation then
      null;
    end;
  end loop;
  raise exception 'code_generation_failed';
end;
$$;

-- Join (or rejoin) a room: password / lock / ban enforced here, never on the client.
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
  p_password_required boolean
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
           (r.password_hash is not null)
    from public.rooms r
    where r.code = v_room.code;
end;
$$;

-- Mark self as gone; if the caller was the host, promote the senior active member.
create or replace function public.leave_room(p_code text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := upper(trim(coalesce(p_code, '')));
  v_room public.rooms%rowtype;
begin
  if v_uid is null then
    return;
  end if;

  update public.room_members
  set left_at = now()
  where room_code = v_code and user_id = v_uid and left_at is null;

  select * into v_room from public.rooms where code = v_code for update;
  if found and v_room.host_id = v_uid then
    update public.rooms
    set host_id = (
      select m.user_id from public.room_members m
      where m.room_code = v_code and not m.banned and m.left_at is null and m.user_id <> v_uid
      order by m.joined_at asc
      limit 1
    )
    where code = v_code
      and exists (
        select 1 from public.room_members m
        where m.room_code = v_code and not m.banned and m.left_at is null and m.user_id <> v_uid
      );
  end if;
end;
$$;

-- Host handoff for abrupt departures (crashed tab, dead connection).
-- Compare-and-swap: only succeeds when the current host is no longer an
-- *online* member and the caller is the most senior online member.
create or replace function public.claim_host(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := upper(trim(coalesce(p_code, '')));
  v_room public.rooms%rowtype;
  v_joined timestamptz;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;

  select * into v_room from public.rooms where code = v_code for update;
  if not found then
    raise exception 'room_not_found';
  end if;

  if exists (
    select 1 from public.room_members m
    where m.room_code = v_code and m.user_id = v_uid and m.banned
  ) then
    raise exception 'banned';
  end if;

  select joined_at into v_joined
  from public.room_members
  where room_code = v_code and user_id = v_uid and left_at is null;
  if not found then
    raise exception 'not_a_member';
  end if;

  -- Current host still online → nothing to claim.
  if exists (
    select 1 from public.room_members m
    where m.room_code = v_code and m.user_id = v_room.host_id
      and not m.banned and m.left_at is null
      and m.last_seen > now() - interval '60 seconds'
  ) then
    raise exception 'host_active';
  end if;

  -- Another online member is more senior → they get it first.
  if exists (
    select 1 from public.room_members m
    where m.room_code = v_code and not m.banned and m.left_at is null
      and m.user_id <> v_uid
      and m.last_seen > now() - interval '60 seconds'
      and m.joined_at < v_joined
  ) then
    raise exception 'not_senior';
  end if;

  update public.rooms set host_id = v_uid where code = v_code;
  return v_uid;
end;
$$;

-- Heartbeat: keeps last_seen fresh so claim_host() can tell online from gone,
-- and revives membership left behind by a best-effort pagehide leave.
create or replace function public.heartbeat(p_code text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.room_members
  set last_seen = now(),
      left_at = null
  where room_code = upper(trim(coalesce(p_code, ''))) and user_id = auth.uid();
$$;

-- Host-only moderation: ban / unban / mute / unmute. (UI lands in a later commit.)
create or replace function public.moderate_member(
  p_code text,
  p_user_id uuid,
  p_banned boolean default null,
  p_mute_seconds integer default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := upper(trim(coalesce(p_code, '')));
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
  if not exists (select 1 from public.room_members where room_code = v_code and user_id = p_user_id) then
    raise exception 'not_a_member';
  end if;

  update public.room_members
  set banned = coalesce(p_banned, banned),
      muted_until = case
        when p_mute_seconds is null then muted_until
        when p_mute_seconds <= 0 then null
        else now() + (p_mute_seconds || ' seconds')::interval
      end
  where room_code = v_code and user_id = p_user_id;
end;
$$;

-- Allow the host to toggle a locked room through the normal RLS update path.
-- (locked is already covered by "host updates room"; no extra grant needed.)

grant execute on function public.create_room(text, text) to authenticated;
grant execute on function public.join_room(text, text, text) to authenticated;
grant execute on function public.leave_room(text) to authenticated;
grant execute on function public.claim_host(text) to authenticated;
grant execute on function public.heartbeat(text) to authenticated;
grant execute on function public.moderate_member(text, uuid, boolean, integer) to authenticated;
