-- 0004: session watch history.
-- Host writes only (RLS keeps updates host-only); stores up to 30 recent
-- entries as {videoId, title, at} JSON objects. Late joiners read it from
-- the rooms row on join (members can SELECT).

alter table public.rooms
  add column if not exists watched jsonb not null default '[]';
