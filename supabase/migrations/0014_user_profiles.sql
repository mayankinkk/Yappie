-- 0014: user profiles that stick
--   * user_profiles: server-side name/avatar/color per auth user (own-row RLS)
--   * chat_messages.avatar: emoji avatar carried with each message

create table if not exists public.user_profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  name text not null default 'Guest',
  avatar text not null default '',
  color integer not null default 30,
  updated_at timestamptz not null default now()
);

alter table public.user_profiles enable row level security;

create policy "read own profile" on public.user_profiles
  for select using (auth.uid() = user_id);
create policy "insert own profile" on public.user_profiles
  for insert with check (auth.uid() = user_id);
create policy "update own profile" on public.user_profiles
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

grant select, insert, update on public.user_profiles to authenticated;

alter table public.chat_messages
  add column if not exists avatar text not null default '';
