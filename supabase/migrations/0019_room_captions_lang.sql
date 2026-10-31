-- 0019: room-wide caption language.
-- Apply after 0018 (`supabase db push` or paste into the SQL editor).
--
-- Caption on/off stays a personal choice (localStorage), but WHICH language
-- the room's subtitles are in is shared: the host picks, the realtime rooms
-- UPDATE echo carries it to every member, and each client steers its embed
-- with cc_lang_pref (a fresh iframe on change, so switching back to Auto
-- really clears the preference). Null = Auto (the video's own default).
-- Old rows are unaffected: null from the start.

alter table public.rooms
  add column if not exists captions_lang text;

alter table public.rooms drop constraint if exists rooms_captions_lang;
alter table public.rooms add constraint rooms_captions_lang
  check (captions_lang is null or captions_lang ~ '^[a-zA-Z-]{2,10}$');
