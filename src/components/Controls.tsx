import { useEffect, useRef, useState } from "react";
import type { YouTubePlayer } from "../player/YouTubePlayer";
import { useRoom } from "../stores/room";
import { useSession } from "../stores/session";
import { formatTime, clamp } from "../lib/time";

interface Props {
  player: YouTubePlayer | null;
  playing: boolean;
}

export default function Controls({ player, playing }: Props) {
  const togglePlayback = useRoom((s) => s.togglePlayback);
  const seekTo = useRoom((s) => s.seekTo);
  const requestControl = useRoom((s) => s.requestControl);
  const hostId = useRoom((s) => s.hostId);
  const guestsCanControl = useRoom((s) => s.guestsCanControl);
  const grantedTo = useRoom((s) => s.grantedTo);
  const pendingControl = useRoom((s) => s.pendingControl);
  const approveControl = useRoom((s) => s.approveControl);
  const denyControl = useRoom((s) => s.denyControl);
  const videoId = useRoom((s) => s.videoId);
  const profile = useSession((s) => s.profile);
  const canControl =
    !!profile && (profile.id === hostId || guestsCanControl || grantedTo.includes(profile.id));
  const isHost = !!profile && profile.id === hostId;

  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [seeking, setSeeking] = useState(false);
  const sliderRef = useRef<HTMLInputElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!player) return;
    const poll = setInterval(() => {
      if (!player.ready()) return;
      const t = player.getTime();
      const d = player.getDuration();
      setTime(t);
      setDuration(d);
      if (!seeking && sliderRef.current) {
        sliderRef.current.value = String(Math.min(t, d || t));
        const pct = d ? clamp((t / d) * 100, 0, 100) : 0;
        sliderRef.current.style.setProperty("--fill", String(pct));
      }
    }, 250);
    return () => clearInterval(poll);
  }, [player, seeking]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.code !== "Space") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      e.preventDefault();
      if (canControl) togglePlayback();
      else requestControl();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlayback, requestControl, canControl]);

  function onSeekCommit() {
    setSeeking(false);
    const value = Number(sliderRef.current?.value || 0);
    if (canControl) seekTo(value);
    else requestControl();
  }

  function toggleFullscreen() {
    const wrap = controlsRef.current?.closest(".player-wrap") || controlsRef.current;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrap?.requestFullscreen?.();
  }

  const disabled = !videoId;

  return (
    <>
      {pendingControl && isHost && (
        <div className="control-request" role="status">
          <span className="cr-text">
            <strong>{pendingControl.name}</strong> wants to control playback
          </span>
          <span className="cr-actions">
            <button className="cr-btn approve" onClick={() => void approveControl()}>
              Approve
            </button>
            <button className="cr-btn deny" onClick={denyControl}>
              Deny
            </button>
          </span>
        </div>
      )}
      <div className="controls" ref={controlsRef}>
      <button
        className="ctrl-btn play"
        title={playing ? "Pause (Space)" : "Play (Space)"}
        disabled={disabled}
        onClick={() => (canControl ? togglePlayback() : requestControl())}
      >
        {playing ? (
          <svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z" /></svg>
        ) : (
          <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
        )}
      </button>
      <input
        ref={sliderRef}
        className="seek"
        type="range"
        min={0}
        max={duration || 100}
        step={0.1}
        defaultValue={0}
        disabled={disabled}
        onPointerDown={() => setSeeking(true)}
        onChange={(e) => {
          const v = Number(e.target.value);
          const pct = duration ? clamp((v / duration) * 100, 0, 100) : 0;
          e.target.style.setProperty("--fill", String(pct));
        }}
        onPointerUp={onSeekCommit}
      />
      <span className="time-label">
        {formatTime(time)} / {formatTime(duration)}
      </span>
      <button
        className="ctrl-btn"
        title={muted ? "Unmute" : "Mute"}
        disabled={disabled}
        onClick={() => {
          const next = !muted;
          setMuted(next);
          player?.setMuted(next);
        }}
      >
        {muted ? (
          <svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4-2.7-2.7z" /></svg>
        ) : (
          <svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z" /></svg>
        )}
      </button>
      <button className="ctrl-btn" title="Fullscreen" disabled={disabled} onClick={toggleFullscreen}>
        <svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" /></svg>
      </button>
      </div>
    </>
  );
}
