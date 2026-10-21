import { useCallback, useEffect, useRef, useState } from "react";
import type { Room, RemoteParticipant } from "livekit-client";
import { fetchLiveKitToken, isVoiceConfigured } from "../lib/supabase";
import { useSession } from "../stores/session";

export interface VoiceParticipant {
  id: string;
  name: string;
  isLocal: boolean;
  speaking: boolean;
  muted: boolean;
}

interface VoiceState {
  supported: boolean;
  joined: boolean;
  connecting: boolean;
  micOn: boolean;
  error: string | null;
  participants: VoiceParticipant[];
}

export function useVoice(roomCode: string) {
  const profile = useSession((s) => s.profile);
  const [state, setState] = useState<VoiceState>({
    supported: isVoiceConfigured(),
    joined: false,
    connecting: false,
    micOn: false,
    error: null,
    participants: [],
  });
  const roomRef = useRef<Room | null>(null);

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
      room.on(RoomEvent.ParticipantConnected, refreshParticipants);
      room.on(RoomEvent.ParticipantDisconnected, refreshParticipants);
      room.on(RoomEvent.ParticipantAttributesChanged, refreshParticipants);
      room.on(RoomEvent.ActiveSpeakersChanged, refreshParticipants);
      room.on(RoomEvent.TrackMuted, refreshParticipants);
      room.on(RoomEvent.LocalTrackUnpublished, refreshParticipants);
      // Remote audio is subscribed automatically but never played until the
      // track is attached to an audio element. Without this, the speaking
      // avatar lights up (levels arrive via the SFU) while everyone hears
      // silence.
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) {
          track.attach();
          // Browsers may block autoplay until a user gesture; join was one.
          room.startAudio().catch(() => {});
        }
      });
      room.on(RoomEvent.TrackUnsubscribed, (track) => {
        track.detach();
      });
      room.on(RoomEvent.Disconnected, () => {
        roomRef.current = null;
        setState((s) => ({ ...s, joined: false, micOn: false, participants: [] }));
      });
      await room.connect(creds.url, creds.token);
      await room.localParticipant.setMicrophoneEnabled(true);
      // Attach any remote audio that arrived before the listeners were live
      // (rare race, cheap to cover).
      for (const p of room.remoteParticipants.values()) {
        for (const pub of p.audioTrackPublications.values()) {
          pub.track?.attach();
        }
      }
      setState((s) => ({ ...s, joined: true, connecting: false, micOn: true }));
      refreshParticipants();
    } catch {
      roomRef.current = null;
      setState((s) => ({ ...s, connecting: false, error: "Couldn't join voice" }));
    }
  }, [roomCode, profile?.name, state.supported, refreshParticipants]);

  const leave = useCallback(() => {
    const room = roomRef.current;
    roomRef.current = null;
    void room?.disconnect();
    setState((s) => ({ ...s, joined: false, micOn: false, participants: [], error: null }));
  }, []);

  const toggleMic = useCallback(async () => {
    const room = roomRef.current;
    if (!room) return;
    // Mic click is a user gesture — retry blocked remote-audio playback.
    room.startAudio().catch(() => {});
    const next = !state.micOn;
    await room.localParticipant.setMicrophoneEnabled(next);
    setState((s) => ({ ...s, micOn: next }));
    refreshParticipants();
  }, [state.micOn, refreshParticipants]);

  useEffect(() => {
    return () => {
      roomRef.current?.disconnect();
      roomRef.current = null;
    };
  }, []);

  return { ...state, join, leave, toggleMic };
}
