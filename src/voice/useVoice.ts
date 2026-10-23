import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LocalTrackPublication,
  Room,
  RemoteParticipant,
  Track,
} from "livekit-client";
import { fetchLiveKitToken, isVoiceConfigured } from "../lib/supabase";
import { useSession } from "../stores/session";
import { useRoom } from "../stores/room";

export interface VoiceParticipant {
  id: string;
  name: string;
  isLocal: boolean;
  speaking: boolean;
  muted: boolean;
}

export interface VideoParticipant {
  id: string;
  name: string;
  isLocal: boolean;
  /** Camera track; VideoStrip attaches it to a <video> element. */
  track: Track | null;
}

interface VoiceState {
  supported: boolean;
  joined: boolean;
  connecting: boolean;
  micOn: boolean;
  cameraOn: boolean;
  error: string | null;
  participants: VoiceParticipant[];
  videos: VideoParticipant[];
}

export type Voice = ReturnType<typeof useVoice>;

export function useVoice(roomCode: string) {
  const profile = useSession((s) => s.profile);
  const [state, setState] = useState<VoiceState>({
    supported: isVoiceConfigured(),
    joined: false,
    connecting: false,
    micOn: false,
    cameraOn: false,
    error: null,
    participants: [],
    videos: [],
  });
  const roomRef = useRef<Room | null>(null);
  const micPubRef = useRef<LocalTrackPublication | null>(null);
  // livekit-client is imported dynamically to keep it out of the app chunk;
  // stash Track.Source here once joined so refreshVideos can look up camera
  // publications without a second import.
  const trackClassRef = useRef<{ Source: { Camera: Track.Source } } | null>(null);

  const refreshParticipants = useCallback(() => {
    const room = roomRef.current;
    if (!room) return;
    const list: VoiceParticipant[] = [];
    const local = room.localParticipant;
    if (local) {
      list.push({
        id: local.sid || "local",
        name: local.name || profile?.name || "You",
        isLocal: true,
        speaking: local.isSpeaking,
        muted: local.isMicrophoneEnabled === false,
      });
    }
    for (const p of room.remoteParticipants.values() as Iterable<RemoteParticipant>) {
      list.push({
        id: p.sid,
        name: p.name || "Guest",
        isLocal: false,
        speaking: p.isSpeaking,
        muted: p.isMicrophoneEnabled === false,
      });
    }
    setState((s) => ({ ...s, participants: list }));
  }, [profile?.name]);

  const refreshVideos = useCallback(() => {
    const room = roomRef.current;
    const Source = trackClassRef.current?.Source;
    if (!room || !Source) return;
    const list: VideoParticipant[] = [];
    const localPub = room.localParticipant.getTrackPublication(Source.Camera);
    if (localPub?.track) {
      list.push({
        id: room.localParticipant.sid || "local",
        name: profile?.name || "You",
        isLocal: true,
        track: localPub.track as Track,
      });
    }
    for (const p of room.remoteParticipants.values() as Iterable<RemoteParticipant>) {
      const pub = p.getTrackPublication(Source.Camera);
      if (pub?.track) {
        list.push({
          id: p.sid,
          name: p.name || "Guest",
          isLocal: false,
          track: pub.track as Track,
        });
      }
    }
    // Track objects are stable across refreshes — skip the update (and a
    // re-render) when nothing actually changed.
    setState((s) =>
      s.videos.length === list.length &&
      list.every((v, i) => v.id === s.videos[i]?.id && v.track === s.videos[i]?.track)
        ? s
        : { ...s, videos: list },
    );
  }, [profile?.name]);

  const refreshAll = useCallback(() => {
    refreshParticipants();
    refreshVideos();
  }, [refreshParticipants, refreshVideos]);

  const join = useCallback(async () => {
    if (!state.supported || roomRef.current) return;
    setState((s) => ({ ...s, connecting: true, error: null }));
    try {
      const [{ Room, RoomEvent, Track }, creds] = await Promise.all([
        import("livekit-client"),
        fetchLiveKitToken(roomCode, profile?.name || "Guest"),
      ]);
      if (!creds) {
        setState((s) => ({ ...s, connecting: false, error: "Voice isn't configured" }));
        return;
      }
      const room: Room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;
      trackClassRef.current = Track;
      room.on(RoomEvent.ParticipantConnected, refreshAll);
      room.on(RoomEvent.ParticipantDisconnected, refreshAll);
      room.on(RoomEvent.ParticipantAttributesChanged, refreshParticipants);
      room.on(RoomEvent.ActiveSpeakersChanged, refreshParticipants);
      room.on(RoomEvent.TrackMuted, refreshParticipants);
      room.on(RoomEvent.TrackPublished, refreshAll);
      room.on(RoomEvent.TrackUnpublished, refreshAll);
      room.on(RoomEvent.LocalTrackPublished, refreshAll);
      room.on(RoomEvent.LocalTrackUnpublished, refreshAll);
      // Remote audio is subscribed automatically but never played until the
      // track is attached to an audio element. Without this, the speaking
      // avatar lights up (levels arrive via the SFU) while everyone hears
      // silence. Video is different: VideoStrip attaches tracks to its own
      // <video> tiles, so here we only refresh the strip's source list.
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) {
          track.attach();
          // Browsers may block autoplay until a user gesture; join was one.
          room.startAudio().catch(() => {});
        }
        refreshAll();
      });
      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach();
        refreshAll();
      });
      room.on(RoomEvent.Disconnected, () => {
        roomRef.current = null;
        micPubRef.current = null;
        trackClassRef.current = null;
        setState((s) => ({
          ...s,
          joined: false,
          micOn: false,
          cameraOn: false,
          participants: [],
          videos: [],
        }));
      });
      try {
        await room.connect(creds.url, creds.token);
      } catch (e) {
        console.error("[voice] connect failed", e);
        roomRef.current = null;
        trackClassRef.current = null;
        setState((s) => ({
          ...s,
          connecting: false,
          error: "Couldn't reach the voice server",
        }));
        return;
      }
      // Acquire + publish the mic immediately (one permission prompt at join,
      // Discord-style) but start MUTED — one click on Join must never open a
      // hot mic to the room. Unmute is an explicit second action. A blocked
      // mic (permission denied, device busy) is NOT fatal — the user still
      // gets room audio and can retry from the mic toggle.
      let micError: string | null = null;
      try {
        const micPub = await room.localParticipant.setMicrophoneEnabled(true);
        await micPub?.mute();
        micPubRef.current = micPub ?? null;
      } catch (e) {
        console.error("[voice] mic acquisition failed", e);
        micError = "Mic blocked — allow microphone access for this site, then click the mic";
      }
      // Attach any remote audio that arrived before the listeners were live
      // (rare race, cheap to cover).
      for (const p of room.remoteParticipants.values()) {
        for (const pub of p.audioTrackPublications.values()) {
          pub.track?.attach();
        }
      }
      setState((s) => ({
        ...s,
        joined: true,
        connecting: false,
        micOn: false,
        error: micError,
      }));
      refreshAll();
    } catch (e) {
      console.error("[voice] join failed", e);
      roomRef.current = null;
      trackClassRef.current = null;
      setState((s) => ({ ...s, connecting: false, error: "Couldn't join voice" }));
    }
  }, [roomCode, profile?.name, state.supported, refreshParticipants, refreshAll]);

  const leave = useCallback(() => {
    const room = roomRef.current;
    roomRef.current = null;
    micPubRef.current = null;
    trackClassRef.current = null;
    void room?.disconnect();
    setState((s) => ({
      ...s,
      joined: false,
      micOn: false,
      cameraOn: false,
      participants: [],
      videos: [],
      error: null,
    }));
  }, []);

  const toggleMic = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    // Mic click is a user gesture — retry blocked remote-audio playback.
    room.startAudio().catch(() => {});
    const next = !state.micOn;
    try {
      if (micPubRef.current) {
        // Already published — flipping mute is instant, no device re-acquire.
        if (next) await micPubRef.current.unmute();
        else await micPubRef.current.mute();
      } else {
        const micPub = await room.localParticipant.setMicrophoneEnabled(next);
        micPubRef.current = micPub ?? null;
      }
      setState((s) => ({ ...s, micOn: next, error: null }));
      refreshAll();
    } catch (e) {
      console.error("[voice] mic toggle failed", e);
      setState((s) => ({
        ...s,
        micOn: false,
        error: "Mic blocked — allow microphone access for this site, then click the mic",
      }));
    }
  }, [state.micOn, refreshAll]);

  const toggleCamera = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    const next = !state.cameraOn;
    try {
      // Disabling fully stops the camera track (OS light off); enabling
      // acquires + publishes. Unlike the mic, nothing happens at join —
      // the webcam is always an explicit second opt-in.
      await room.localParticipant.setCameraEnabled(next);
      setState((s) => ({ ...s, cameraOn: next }));
    } catch {
      // Permission denied or no device — leave the camera off.
      setState((s) => ({ ...s, cameraOn: false }));
    }
    refreshAll();
  }, [state.cameraOn, refreshAll]);

  useEffect(() => {
    return () => {
      roomRef.current?.disconnect();
      roomRef.current = null;
    };
  }, []);

  // ---- Idle auto-leave ---------------------------------------------------
  // Everyone stays muted for a whole movie, so "no speech" is a terrible
  // abandonment signal — it would kick the room mid-film. The page going
  // hidden for 5 straight minutes is the only trustworthy "nobody's here"
  // signal, and every idle minute still bills a LiveKit seat (mute state
  // doesn't matter). Away → warn once with Stay / Leave-now, then drop.
  // (The window overrides are the e2e seam: tests shorten both timers.)
  useEffect(() => {
    if (!state.joined) return;
    const win = window as Window & {
      __YAPPIE_VOICE_IDLE_MS?: number;
      __YAPPIE_VOICE_GRACE_MS?: number;
    };
    const idleMs = win.__YAPPIE_VOICE_IDLE_MS ?? 5 * 60_000;
    const graceMs = win.__YAPPIE_VOICE_GRACE_MS ?? 60_000;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let toastId = "";

    const clearIdle = () => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
    };
    const clearGrace = () => {
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
        graceTimer = undefined;
      }
    };

    const startIdle = () => {
      if (idleTimer !== undefined || graceTimer !== undefined) return;
      idleTimer = setTimeout(() => {
        idleTimer = undefined;
        const mins = Math.max(1, Math.round(idleMs / 60_000));
        const secs = Math.max(1, Math.round(graceMs / 1000));
        toastId = useRoom.getState().pushToast(`Away ${mins} min — leaving voice in ${secs}s`, "info", {
          ttlMs: graceMs,
          actions: [
            { label: "Stay connected", onClick: () => { clearIdle(); clearGrace(); } },
            { label: "Leave now", onClick: leave },
          ],
        });
        // The toast's own ttlMs dismisses it exactly when this fires.
        graceTimer = setTimeout(() => {
          graceTimer = undefined;
          leave();
        }, graceMs);
      }, idleMs);
    };

    const onVis = () => {
      if (document.visibilityState === "hidden") {
        startIdle();
      } else if (idleTimer !== undefined) {
        // Back before the warning fired → never left; cancel silently.
        // Back DURING the grace window the countdown keeps running, so the
        // returner sees the explicit Stay / Leave-now prompt in time.
        clearIdle();
      }
    };

    if (document.visibilityState === "hidden") startIdle();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      clearIdle();
      clearGrace();
      if (toastId) useRoom.getState().dismissToast(toastId);
    };
  }, [state.joined, leave]);

  return { ...state, join, leave, toggleMic, toggleCamera };
}
