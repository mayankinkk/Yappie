-- 0011: room audit log (host-visible moderation history).
-- Apply after 0010 (`supabase db push` or paste into the SQL editor).
--
-- Records every moderation-relevant action inside a room:
--   * ban / unban / mute / unmute  — inside moderate_member()
--   * delete_message               — inside delete_chat_message()
--   * transfer / lock / unlock /
--     guests_control_on / guests_control_off — AFTER UPDATE trigger on rooms
--     (covers the RLS-guarded direct updates the app uses for settings and
--      host_id, including claim_host()/leave_room() promotions)
--
-- Clients can only SELECT, and the policy limits reads to the room's host —
-- there is no INSERT/UPDATE/DELETE policy, so writes happen exclusively via
-- the SECURITY DEFINER functions and trigger (the table owner bypasses RLS;
-- explicit grants below revoke write on top of the empty policies).
-- Rows cascade away with their room, and the 0010 GC prunes dormant rooms,
-- so the log needs no retention job of its own.

create table if not exists public.room_audit (
  id bigint generated always as identity primary key,
  room_code text not null references public.rooms (code) on delete cascade,
  actor_id uuid,
  actor_name text not null default 'Host',
  action text not null,
  target_id uuid,
  target_name text,
  detail text,
  created_at timestamptz not null default now()
);

create index if not exists room_audit_room_idx
  on public.room_audit (room_code, created_at desc);

alter table public.room_audit enable row level security;

create policy "host reads audit" on public.room_audit for select using (
  exists (
    select 1 from public.rooms r
    where r.code = room_audit.room_code
      and r.host_id = auth.uid()
  )
);

grant select on public.room_audit to authenticated;
revoke insert, update, delete on public.room_audit from anon, authenticated;

-- Stream new entries to the host's open room channel.
do $$
begin
  alter publication supabase_realtime add table public.room_audit;
exception when duplicate_object then null;
end $$;

-- ---------------------------------------------------------------------------
-- moderate_member(): record ban/unban and mute/unmute alongside the update.
-- ---------------------------------------------------------------------------
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
  v_actor_name text;
  v_target_name text;
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

  select display_name into v_target_name
  from public.room_members
  where room_code = v_code and user_id = p_user_id;
  if v_target_name is null then
    raise exception 'not_a_member';
  end if;

  select display_name into v_actor_name
  from public.room_members
  where room_code = v_code and user_id = v_uid;

  update public.room_members
  set banned = coalesce(p_banned, banned),
      muted_until = case
        when p_mute_seconds is null then muted_until
        when p_mute_seconds <= 0 then null
        else now() + (p_mute_seconds || ' seconds')::interval
      end
  where room_code = v_code and user_id = p_user_id;

  if p_banned is not null then
    insert into public.room_audit (room_code, actor_id, actor_name, action, target_id, target_name)
    values (v_code, v_uid, coalesce(v_actor_name, 'Host'),
            case when p_banned then 'ban' else 'unban' end,
            p_user_id, v_target_name);
  end if;
  if p_mute_seconds is not null then
    insert into public.room_audit (room_code, actor_id, actor_name, action, target_id, target_name)
    values (v_code, v_uid, coalesce(v_actor_name, 'Host'),
            case when p_mute_seconds > 0 then 'mute' else 'unmute' end,
            p_user_id, v_target_name);
  end if;
end;
$$;

grant execute on function public.moderate_member(text, uuid, boolean, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- delete_chat_message(): capture the sender + excerpt before the row goes.
-- ---------------------------------------------------------------------------
create or replace function public.delete_chat_message(p_code text, p_message_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_code text := upper(trim(coalesce(p_code, '')));
  v_actor_name text;
  v_sender_id uuid;
  v_sender_name text;
  v_excerpt text;
begin
  if v_uid is null then
    raise exception 'not_authenticated';
  end if;
  if not exists (select 1 from public.rooms where code = v_code and host_id = v_uid) then
    raise exception 'not_host';
  end if;

  select display_name into v_actor_name
  from public.room_members
  where room_code = v_code and user_id = v_uid;

  select sender_id, sender_name, left(text, 80)
  into v_sender_id, v_sender_name, v_excerpt
  from public.chat_messages
  where room_code = v_code and id = p_message_id;
  if not found then
    return;
  end if;

  delete from public.chat_messages
  where room_code = v_code and id = p_message_id;

  insert into public.room_audit (room_code, actor_id, actor_name, action, target_id, target_name, detail)
  values (v_code, v_uid, coalesce(v_actor_name, 'Host'), 'delete_message',
          v_sender_id, v_sender_name, v_excerpt);
end;
$$;

grant execute on function public.delete_chat_message(text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- rooms trigger: settings/host changes that go through plain RLS updates.
-- ---------------------------------------------------------------------------
create or replace function public.audit_room_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_actor_name text;
  v_new_host_name text;
begin
  if v_uid is not null then
    select display_name into v_actor_name
    from public.room_members
    where room_code = new.code and user_id = v_uid;
  end if;

  if old.host_id is distinct from new.host_id then
    select display_name into v_new_host_name
    from public.room_members
    where room_code = new.code and user_id = new.host_id;
    insert into public.room_audit (room_code, actor_id, actor_name, action, target_id, target_name)
    values (new.code, v_uid, coalesce(v_actor_name, 'System'), 'transfer',
            new.host_id, coalesce(v_new_host_name, 'Member'));
  end if;

  if old.locked is distinct from new.locked then
    insert into public.room_audit (room_code, actor_id, actor_name, action)
    values (new.code, v_uid, coalesce(v_actor_name, 'Host'),
            case when new.locked then 'lock' else 'unlock' end);
  end if;

  if old.guests_can_control is distinct from new.guests_can_control then
    insert into public.room_audit (room_code, actor_id, actor_name, action)
    values (new.code, v_uid, coalesce(v_actor_name, 'Host'),
            case when new.guests_can_control then 'guests_control_on' else 'guests_control_off' end);
  end if;

  return new;
end;
$$;

drop trigger if exists rooms_audit_trg on public.rooms;
create trigger rooms_audit_trg
  after update on public.rooms
  for each row
  execute function public.audit_room_changes();
