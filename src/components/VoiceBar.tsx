import { useEffect } from "react";
import { useVoice } from "../voice/useVoice";
import { isVoiceConfigured } from "../lib/supabase";
import { useRoom } from "../stores/room";
import { initials } from "../lib/ids";

interface Props {
  roomCode: string;
}

export default function VoiceBar({ roomCode }: Props) {
  const supported = isVoiceConfigured();
  const { joined, connecting, micOn, participants, error, join, leave, toggleMic } =
    useVoice(roomCode);
  const setVoicePresence = useRoom((s) => s.setVoicePresence);

  // Publish voice membership through presence so peers who haven't joined
  // voice get the "X joined voice" toast.
  useEffect(() => {
    setVoicePresence(joined);
    return () => setVoicePresence(false);
  }, [joined, setVoicePresence]);

  if (!supported) return null;

  return (
    <div className="voice-bar">
      {!joined ? (
        <button className="btn small voice-join" onClick={() => void join()} disabled={connecting}>
          {connecting ? "Connecting voice…" : "🎙 Join voice"}
        </button>
      ) : (
        <>
          <button
            className={`ctrl-btn mic ${micOn ? "mic-on" : "mic-off"}`}
            onClick={() => void toggleMic()}
            title={micOn ? "Mute mic" : "Unmute mic"}
          >
            <svg viewBox="0 0 24 24">
              <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" />
            </svg>
          </button>
          <span className="voice-label">Voice</span>
          <div className="voice-people">
            {participants.map((p) => (
              <span
                key={p.id}
                className={`voice-person ${p.speaking ? "speaking" : ""}`}
                title={`${p.name}${p.muted ? " (muted)" : ""}`}
              >
                <span className="avatar sm">{initials(p.name)}</span>
                {p.muted && <span className="mic-badge">🔇</span>}
              </span>
            ))}
          </div>
          <button className="btn small ghost" onClick={leave}>
            Leave voice
          </button>
        </>
      )}
      {error && <span className="voice-error">{error}</span>}
    </div>
  );
}
