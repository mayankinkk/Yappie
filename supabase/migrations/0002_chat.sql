-- 0002: durable chat history (late joiners see the conversation).
-- Apply together with 0001 (paste after it in the SQL editor, or `supabase db push`).
--
-- Chat goes through Postgres instead of a bare broadcast:
--   * RLS: only active, non-banned, unmuted members can insert (as themselves)
--   * a trigger enforces server-side rate limits (5 msgs / 5s) that modified
--     clients cannot bypass
--   * delivery uses the same Realtime channel via postgres_changes (INSERT),
--     so latency stays in the same range as broadcasts

create table if not exists public.chat_messages (
  id text primary key,
  room_code text not null references public.rooms (code) on delete cascade,
  sender_id uuid not null,
  sender_name text not null default 'Guest',
  color integer not null default 30,
  text text not null check (char_length(text) between 1 and 500),
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_room_idx
  on public.chat_messages (room_code, created_at desc);
create index if not exists chat_messages_rate_idx
  on public.chat_messages (room_code, sender_id, created_at desc);

alter table public.chat_messages enable row level security;

create policy "members read chat" on public.chat_messages for select using (
  exists (
    select 1 from public.room_members m
    where m.room_code = chat_messages.room_code
      and m.user_id = auth.uid()
      and not m.banned
  )
);

create policy "active members send chat" on public.chat_messages for insert
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from public.room_members m
      where m.room_code = chat_messages.room_code
        and m.user_id = auth.uid()
        and not m.banned
        and m.left_at is null
        and (m.muted_until is null or m.muted_until < now())
    )
  );

-- Server-side flood gate (the client-side limiter is just a courtesy).
create or replace function public.enforce_chat_limits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (
    select count(*) from public.chat_messages
    where room_code = new.room_code
      and sender_id = new.sender_id
      and created_at > now() - interval '5 seconds'
  ) >= 5 then
    raise exception 'chat_rate_limited';
  end if;
  return new;
end;
$$;

create trigger chat_rate_limit
  before insert on public.chat_messages
  for each row
  execute function public.enforce_chat_limits();

grant select, insert on public.chat_messages to authenticated;

do $$
begin
  alter publication supabase_realtime add table public.chat_messages;
exception when duplicate_object then null;
end $$;
