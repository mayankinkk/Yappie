import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { YouTubePlayer } from "../player/YouTubePlayer";
import { useRoom } from "../stores/room";
import { useSession } from "../stores/session";
import { formatTime, clamp } from "../lib/time";
import { toggleCinemaFullscreen, activeFullscreenElement } from "../lib/fullscreen";
import { captionsEnabled, setCaptionsEnabled } from "../lib/captions";

interface Props {
  player: YouTubePlayer | null;
  playing: boolean;
  theater: boolean;
  onToggleTheater: () => void;
}

export default function Controls({ player, playing, theater, onToggleTheater }: Props) {
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
  const drift = useRoom((s) => s.drift);
  const resyncNow = useRoom((s) => s.resyncNow);
  const profile = useSession((s) => s.profile);
  const canControl =
    !!profile && (profile.id === hostId || guestsCanControl || grantedTo.includes(profile.id));
  const isHost = !!profile && profile.id === hostId;
  const disabled = !videoId;

  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(() =>
    clamp(Number(localStorage.getItem("yappie.volume") ?? "100") || 0, 0, 100),
  );
  const [seeking, setSeeking] = useState(false);
  const [caps, setCaps] = useState(captionsEnabled);
  const [showHelp, setShowHelp] = useState(false);
  const [fsActive, setFsActive] = useState(false);
  const [fsIdle, setFsIdle] = useState(false);
  const sliderRef = useRef<HTMLInputElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);

  const toggleCaptions = useCallback(() => {
    const next = !caps;
    setCaps(next);
    setCaptionsEnabled(next);
    player?.setCaptionsEnabled(next);
  }, [caps, player]);

  useEffect(() => {
    localStorage.setItem("yappie.volume", String(volume));
    player?.setVolume(volume);
  }, [player, volume]);

  useEffect(() => {
    const onChange = () => setFsActive(!!activeFullscreenElement());
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);

  // In fullscreen while playing: fade the bar out after 3s of no input,
  // bring it back on any mouse move / key / tap.
  useEffect(() => {
    if (!fsActive || !playing) {
      setFsIdle(false);
      return;
    }
    let timer = 0;
    const wake = () => {
      setFsIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setFsIdle(true), 3000);
    };
    wake();
    window.addEventListener("mousemove", wake, { passive: true });
    window.addEventListener("keydown", wake);
    window.addEventListener("pointerdown", wake);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("mousemove", wake);
      window.removeEventListener("keydown", wake);
      window.removeEventListener("pointerdown", wake);
    };
  }, [fsActive, playing]);

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
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.code === "Space") {
        e.preventDefault();
        if (canControl) togglePlayback();
        else requestControl();
        return;
      }
      if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
        if (disabled) return;
        e.preventDefault();
        if (!canControl) {
          requestControl();
          return;
        }
        const step = e.shiftKey ? 30 : 5;
        const current = player?.ready() ? player.getTime() : 0;
        const max = duration > 0 ? duration : Number.MAX_SAFE_INTEGER;
        const next = e.code === "ArrowRight" ? current + step : current - step;
        seekTo(clamp(next, 0, max));
        return;
      }
      if (e.code === "ArrowUp" || e.code === "ArrowDown") {
        if (disabled) return;
        e.preventDefault();
        const step = e.code === "ArrowUp" ? 5 : -5;
        const next = clamp(volume + step, 0, 100);
        setVolume(next);
        if (next > 0 && muted) {
          setMuted(false);
          player?.setMuted(false);
        }
        return;
      }
      if (e.code === "KeyF") {
        if (disabled) return;
        e.preventDefault();
        toggleFullscreen();
        return;
      }
      if (e.code === "KeyM") {
        if (disabled) return;
        e.preventDefault();
        const next = !muted;
        setMuted(next);
        player?.setMuted(next);
      }
      if (e.code === "KeyC") {
        if (disabled) return;
        e.preventDefault();
        toggleCaptions();
      }
      if (e.code === "KeyT") {
        e.preventDefault();
        onToggleTheater();
      }
      if (e.key === "?") {
        e.preventDefault();
        setShowHelp((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlayback, requestControl, seekTo, canControl, disabled, player, duration, muted, volume, caps, onToggleTheater, toggleCaptions]);

  function onSeekCommit() {
    setSeeking(false);
    const value = Number(sliderRef.current?.value || 0);
    if (canControl) seekTo(value);
    else requestControl();
  }

  function toggleFullscreen() {
    toggleCinemaFullscreen();
  }

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
      <div className={`controls${fsIdle ? " fs-idle" : ""}`} ref={controlsRef}>
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
        title="Seek — ←/→ seek 5s, Shift+←/→ seek 30s"
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
      {videoId && drift !== null && (
        <button
          type="button"
          className={`sync-chip ${drift < 0.5 ? "ok" : drift < 1.5 ? "warn" : "bad"}`}
          title="Playback drift vs the host — click to resync"
          onClick={() => resyncNow()}
        >
          {drift < 0.5 ? "in sync" : `±${drift < 10 ? drift.toFixed(1) : `${Math.floor(drift)}+`}s`}
        </button>
      )}
      <button
        className="ctrl-btn"
        title={muted ? "Unmute (M)" : "Mute (M)"}
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
      <input
        className="volume"
        type="range"
        title="Volume"
        aria-label="Volume"
        min={0}
        max={100}
        value={volume}
        disabled={disabled}
        style={{ "--fill": String(volume) } as CSSProperties}
        onChange={(e) => setVolume(Number(e.target.value))}
      />
      <button
        className={`ctrl-btn cc-btn${caps ? " active" : ""}`}
        title={caps ? "Captions on (C)" : "Captions off (C)"}
        aria-label="Captions"
        aria-pressed={caps}
        disabled={disabled}
        onClick={toggleCaptions}
      >
        <svg viewBox="0 0 24 24">
          <rect x="3" y="5" width="18" height="14" rx="3" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path
            d="M10.5 10.5a2.5 2.5 0 1 0 0 3M17 10.5a2.5 2.5 0 1 0 0 3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <button className="ctrl-btn" title="Fullscreen (F)" disabled={disabled} onClick={toggleFullscreen}>
        <svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" /></svg>
      </button>
      <button
        className="ctrl-btn theater-btn"
        title="Theater mode (T)"
        aria-label="Theater mode"
        aria-pressed={theater}
        onClick={onToggleTheater}
      >
        <svg viewBox="0 0 24 24">
          <path
            fillRule="evenodd"
            d="M3 5h4v14H3V5zm14 0h4v14h-4V5zM7 5h10v14H7V5zm2 2v10h6V7H9z"
          />
        </svg>
      </button>
      <button
        className="ctrl-btn help-btn"
        title="Keyboard shortcuts (?)"
        aria-label="Keyboard shortcuts"
        onClick={() => setShowHelp((v) => !v)}
      >
        ?
      </button>
      </div>
      {showHelp && (
        <div
          className="help-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="Keyboard shortcuts"
          onClick={() => setShowHelp(false)}
        >
          <div className="help-card" onClick={(e) => e.stopPropagation()}>
            <div className="help-head">
              <span>Keyboard shortcuts</span>
              <button
                className="ctrl-btn"
                title="Close"
                aria-label="Close"
                onClick={() => setShowHelp(false)}
              >
                ✕
              </button>
            </div>
            <ul className="help-list">
              <li>
                <span className="help-keys">
                  <kbd>Space</kbd>
                </span>
                <span>Play / pause (or ask for control)</span>
              </li>
              <li>
                <span className="help-keys">
                  <kbd>←</kbd>
                  <kbd>→</kbd>
                </span>
                <span>Seek 5s</span>
              </li>
              <li>
                <span className="help-keys">
                  <kbd>Shift</kbd> <span className="help-plus">+</span> <kbd>←</kbd>
                  <span className="help-plus">/</span>
                  <kbd>→</kbd>
                </span>
                <span>Seek 30s</span>
              </li>
              <li>
                <span className="help-keys">
                  <kbd>F</kbd>
                </span>
                <span>Fullscreen</span>
              </li>
              <li>
                <span className="help-keys">
                  <kbd>↑</kbd>
                  <kbd>↓</kbd>
                </span>
                <span>Volume up / down</span>
              </li>
              <li>
                <span className="help-keys">
                  <kbd>M</kbd>
                </span>
                <span>Mute</span>
              </li>
              <li>
                <span className="help-keys">
                  <kbd>C</kbd>
                </span>
                <span>Captions on / off</span>
              </li>
              <li>
                <span className="help-keys">
                  <kbd>T</kbd>
                </span>
                <span>Theater mode</span>
              </li>
              <li>
                <span className="help-keys">
                  <kbd>?</kbd>
                </span>
                <span>Show / hide this help</span>
              </li>
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
