-- 0015: durable playback position for resume-after-refresh.
-- Playback time used to live only in Realtime broadcasts, so a refresh lost
-- the exact timestamp and the rejoiner restarted at 0. The host now mirrors
-- {videoId, time, playing, updatedAt} onto the rooms row (host-gated RLS,
-- same as watched). Late joiners and refreshers read it on join and cue the
-- local player there; a live sync answer from an online host still wins.

alter table public.rooms
  add column if not exists playback jsonb;
