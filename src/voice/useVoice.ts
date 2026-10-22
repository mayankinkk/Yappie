import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LocalTrackPublication,
  Room,
  RemoteParticipant,
  Track,
} from "livekit-client";
import { fetchLiveKitToken, isVoiceConfigured } from "../lib/supabase";
import { useSession } from "../stores/session";

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
      await room.connect(creds.url, creds.token);
      // Acquire + publish the mic immediately (one permission prompt at join,
      // Discord-style) but start MUTED — one click on Join must never open a
      // hot mic to the room. Unmute is an explicit second action.
      const micPub = await room.localParticipant.setMicrophoneEnabled(true);
      await micPub?.mute();
      micPubRef.current = micPub ?? null;
      // Attach any remote audio that arrived before the listeners were live
      // (rare race, cheap to cover).
      for (const p of room.remoteParticipants.values()) {
        for (const pub of p.audioTrackPublications.values()) {
          pub.track?.attach();
        }
      }
      setState((s) => ({ ...s, joined: true, connecting: false, micOn: false }));
      refreshAll();
    } catch {
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
    if (micPubRef.current) {
      // Already published — flipping mute is instant, no device re-acquire.
      if (next) await micPubRef.current.unmute();
      else await micPubRef.current.mute();
    } else {
      await room.localParticipant.setMicrophoneEnabled(next);
    }
    setState((s) => ({ ...s, micOn: next }));
    refreshAll();
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

  return { ...state, join, leave, toggleMic, toggleCamera };
}
