-- Fix RLS infinite recursion: "members read roster" SELECTed room_members
-- from a policy on room_members itself, and every rooms/chat policy that
-- exists()-checks the roster inherited the same recursion (any direct
-- .from('rooms').select() raised "infinite recursion detected in policy").
--
-- Membership checks now go through SECURITY DEFINER helpers, which bypass
-- RLS internally and break the cycle. Policy logic is unchanged:
--   is_member(code)                → active, non-banned member
--   is_member(code, require_active)→ also left_at is null and not muted
--   exists_member(code, uid)       → that specific user is a member

create or replace function public.is_member(p_room_code text, p_require_active boolean default false)
returns boolean
language sql
security definer
set search_path = public, extensions
stable
as $$
  select exists (
    select 1 from public.room_members m
    where m.room_code = upper(trim(coalesce(p_room_code, '')))
      and m.user_id = auth.uid()
      and not m.banned
      and (
        not p_require_active
        or (m.left_at is null and (m.muted_until is null or m.muted_until < now()))
      )
  );
$$;

create or replace function public.exists_member(p_room_code text, p_user uuid)
returns boolean
language sql
security definer
set search_path = public, extensions
stable
as $$
  select exists (
    select 1 from public.room_members m
    where m.room_code = upper(trim(coalesce(p_room_code, '')))
      and m.user_id = p_user
      and not m.banned
  );
$$;

-- rooms: member read, host-only write (transfer target must be a member)
drop policy if exists "members read room" on public.rooms;
create policy "members read room" on public.rooms for select
  using (public.is_member(rooms.code));

drop policy if exists "host updates room" on public.rooms;
create policy "host updates room" on public.rooms for update
  using (host_id = auth.uid())
  with check (
    host_id = auth.uid()
    or public.exists_member(rooms.code, host_id)
  );

-- room_members: members read their own roster (no self-reference now)
drop policy if exists "members read roster" on public.room_members;
create policy "members read roster" on public.room_members for select
  using (public.is_member(room_members.room_code));

-- chat: same membership rules as before, via the helper
drop policy if exists "members read chat" on public.chat_messages;
create policy "members read chat" on public.chat_messages for select
  using (public.is_member(chat_messages.room_code));

drop policy if exists "active members send chat" on public.chat_messages;
create policy "active members send chat" on public.chat_messages for insert
  with check (
    sender_id = auth.uid()
    and public.is_member(chat_messages.room_code, true)
  );
