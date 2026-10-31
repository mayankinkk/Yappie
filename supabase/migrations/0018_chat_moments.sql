-- 0018: timestamped chat — "watch this moment".
-- Apply after 0017 (`supabase db push` or paste into the SQL editor).
--
-- A message can now carry the playback position it was written against, so a
-- reaction to a scene ("watch this at 3:42!") ships with the coordinates and
-- anyone can jump back to it. Both columns are nullable: messages sent
-- without a stamp (or before this migration) simply have none, and old
-- clients keep inserting without them — realtime INSERTs just include the
-- new fields once they land.

alter table public.chat_messages
  add column if not exists video_id text,
  add column if not exists video_ts integer;

alter table public.chat_messages drop constraint if exists chat_video_ts_bounds;
alter table public.chat_messages add constraint chat_video_ts_bounds
  check (video_ts is null or video_ts >= 0);
