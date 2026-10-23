import { useEffect } from "react";
import type { Voice } from "../voice/useVoice";
import { useRoom } from "../stores/room";
import { initials } from "../lib/ids";

interface Props {
  voice: Voice;
}

export default function VoiceBar({ voice }: Props) {
  const {
    supported,
    joined,
    connecting,
    micOn,
    cameraOn,
    sharing,
    participants,
    error,
    join,
    leave,
    toggleMic,
    toggleCamera,
    toggleScreenShare,
  } = voice;
  const setVoicePresence = useRoom((s) => s.setVoicePresence);
  // iOS Safari can't capture the screen — hide the button there rather
  // than offering a picker that always fails.
  const canShare = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;

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
          <button
            className={`ctrl-btn cam ${cameraOn ? "cam-on" : "cam-off"}`}
            onClick={() => void toggleCamera()}
            title={cameraOn ? "Turn camera off" : "Turn camera on"}
            aria-label={cameraOn ? "Turn camera off" : "Turn camera on"}
          >
            <svg viewBox="0 0 24 24">
              <path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z" />
            </svg>
          </button>
          {canShare && (
            <button
              className={`ctrl-btn share ${sharing ? "share-on" : "share-off"}`}
              onClick={() => void toggleScreenShare()}
              title={sharing ? "Stop sharing your screen" : "Share your screen (present mode)"}
              aria-label={sharing ? "Stop sharing screen" : "Share screen"}
            >
              <svg viewBox="0 0 24 24">
                <path d="M20 4H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4v2H7v2h10v-2h-1v-2h4a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 12H4V6h16v10z" />
                <path d="M12 8l3 3h-2v4h-2v-4H9l3-3z" />
              </svg>
            </button>
          )}
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
