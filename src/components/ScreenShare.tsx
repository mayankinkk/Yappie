import { useEffect, useRef } from "react";
import type { Voice } from "../voice/useVoice";

interface Props {
  voice: Voice;
}

/**
 * Present mode: covers the player area with a screen-share stream — the
 * sharer's own preview locally, the presenter's stream for everyone else.
 * A remote presenter wins when both share (watching the screen is the
 * point; the VoiceBar button still toggles your own). Renders inside
 * .player-wrap, so it fills the frame in fullscreen too.
 */
export default function ScreenShare({ voice }: Props) {
  const { screens, sharing, toggleScreenShare } = voice;
  const local = screens.find((s) => s.isLocal && sharing);
  const active = screens.find((s) => !s.isLocal) ?? local ?? null;

  const ref = useRef<HTMLVideoElement>(null);
  const track = active?.track ?? null;
  useEffect(() => {
    const el = ref.current;
    if (!el || !track) return;
    track.attach(el);
    return () => {
      track.detach(el);
    };
  }, [track]);

  if (!active) return null;
  return (
    <div className="screenshare" data-self={active.isLocal ? "self" : "peer"}>
      <div className="screenshare-head">
        <span className="screenshare-who">
          {active.isLocal ? "You're presenting" : `${active.name} is presenting`}
        </span>
        {active.isLocal && (
          <button type="button" className="btn small" onClick={() => void toggleScreenShare()}>
            Stop sharing
          </button>
        )}
      </div>
      <video ref={ref} autoPlay playsInline muted />
    </div>
  );
}
