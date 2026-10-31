import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useRoom, type AuditEntry } from "../stores/room";
import { useSession } from "../stores/session";
import { YouTubePlayer } from "../player/YouTubePlayer";
import RoomHeader from "./RoomHeader";
import Controls from "./Controls";
import Chat from "./Chat";
import Watchers from "./Watchers";
import QueuePanel from "./QueuePanel";
import WatchHistory from "./WatchHistory";
import ReactionsBar from "./ReactionsBar";
import VoiceBar from "./VoiceBar";
import VideoStrip from "./VideoStrip";
import ScreenShare from "./ScreenShare";
import { useVoice } from "../voice/useVoice";
import { watchUrl } from "../lib/video-id";
import { shareInvite } from "../lib/invite";
import { timeAgo } from "../lib/time";
import { needsNativeYoutubeControls, toggleCinemaFullscreen } from "../lib/fullscreen";
import { soundEnabled, setSoundEnabled, playSound } from "../lib/sound";
import { canControlNow } from "../stores/room";

function auditPhrase(e: AuditEntry): string {
  const actor = e.actorName || "Host";
  const target = e.targetName || "a member";
  switch (e.action) {
    case "ban":
      return `${actor} banned ${target}`;
    case "kick":
      return `${actor} kicked ${target}`;
    case "unban":
      return `${actor} unbanned ${target}`;
    case "mute":
      return `${actor} muted ${target}`;
    case "unmute":
      return `${actor} unmuted ${target}`;
    case "lock":
      return `${actor} locked the room`;
    case "unlock":
      return `${actor} unlocked the room`;
    case "guests_control_on":
      return `${actor} allowed guest control`;
    case "guests_control_off":
      return `${actor} revoked guest control`;
    case "delete_message":
      return `${actor} deleted ${target}'s message`;
    case "transfer":
      return e.actorName && e.actorName === e.targetName
        ? `${actor} claimed host`
        : `${actor} made ${target} host`;
    case "approve_join":
      return `${actor} let ${target} in`;
    default:
      return `${actor} ${e.action}`;
  }
}

export default function Room() {
  const code = useRoom((s) => s.code)!;
  const voice = useVoice(code);
  const videoId = useRoom((s) => s.videoId);
  const playing = useRoom((s) => s.playing);
  const connection = useRoom((s) => s.connection);
  const drift = useRoom((s) => s.drift);
  const resyncNow = useRoom((s) => s.resyncNow);
  const guestsCanControl = useRoom((s) => s.guestsCanControl);
  const attachPlayer = useRoom((s) => s.attachPlayer);
  const loadVideo = useRoom((s) => s.loadVideo);
  const floating = useRoom((s) => s.floating);
  const titles = useRoom((s) => s.titles);
  const ensureTitle = useRoom((s) => s.ensureTitle);
  const pushToast = useRoom((s) => s.pushToast);
  const reconnect = useRoom((s) => s.reconnect);
  const nowTitle = videoId ? (titles[videoId] ?? null) : null;

  // Recognizable tab when partying among many tabs.
  useEffect(() => {
    document.title = nowTitle
      ? `${playing ? "▶" : "⏸"} ${nowTitle} · Yappie`
      : `Yappie · room ${code}`;
    return () => {
      document.title = "Yappie — Watch YouTube together";
    };
  }, [nowTitle, playing, code]);

  const [offline, setOffline] = useState(() => !navigator.onLine);
  const prevConn = useRef(connection);
  const [player, setPlayer] = useState<YouTubePlayer | null>(null);
  const [buffering, setBuffering] = useState(false);
  const [theater, setTheater] = useState(() => localStorage.getItem("yappie.theater") === "1");
  const hostRef = useRef<HTMLDivElement>(null);
  const [sound, setSound] = useState(soundEnabled());
  const name = useSession((s) => s.profile?.name) || "";
  const togglePlayback = useRoom((s) => s.togglePlayback);
  const requestControl = useRoom((s) => s.requestControl);
  const upNext = useRoom((s) => s.upNext);
  const skipUpNext = useRoom((s) => s.skipUpNext);
  const hostId = useRoom((s) => s.hostId);
  const myId = useSession((s) => s.profile?.id);
  const isHost = !!myId && hostId === myId;
  const [nowTs, setNowTs] = useState(() => Date.now());
  const hotTimer = useRef<number | null>(null);
  // Sidebar collapses to Chat / Queue / People tabs at the same breakpoint
  // where CSS stacks the grid (≤980px).
  const [mobile, setMobile] = useState(() => window.matchMedia("(max-width: 980px)").matches);
  const [panel, setPanel] = useState<"chat" | "queue" | "people">("chat");
  const unread = useRoom((s) => s.unread);
  const mentions = useRoom((s) => s.mentions);
  const queueCount = useRoom((s) => s.queue.length);
  const peopleCount = useRoom((s) => s.participants.length);
  const audit = useRoom((s) => s.audit);
  const roomTopic = useRoom((s) => s.roomTopic);
  const maxMembers = useRoom((s) => s.maxMembers);
  const pendingJoins = useRoom((s) => s.pendingJoins);
  const respondJoin = useRoom((s) => s.respondJoin);
  const captionsLang = useRoom((s) => s.captionsLang);
  // iOS/iPadOS: hand the chrome to YouTube so its fullscreen button can use
  // the native (landscape) video player — see needsNativeYoutubeControls().
  const ytNative = needsNativeYoutubeControls();

  const auditCard =
    isHost && audit.length > 0 ? (
      <section className="card audit-card">
        <div className="card-head">
          <span>Activity</span>
          <span>{audit.length}</span>
        </div>
        <ul className="audit-list">
          {audit.slice(0, 12).map((e) => (
            <li key={e.id} className="audit-item">
              <span className="audit-text">{auditPhrase(e)}</span>
              <span className="audit-time">{timeAgo(e.createdAt)}</span>
            </li>
          ))}
        </ul>
      </section>
    ) : null;

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 980px)");
    const onChange = () => setMobile(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    if (!upNext) return;
    const iv = setInterval(() => setNowTs(Date.now()), 250);
    return () => clearInterval(iv);
  }, [upNext]);

  useEffect(
    () => () => {
      if (hotTimer.current !== null) window.clearTimeout(hotTimer.current);
    },
    [],
  );

  // Transparent layer over the YouTube iframe (which swallows all pointer
  // events): single click toggles playback with a 240ms delay so a double
  // click can cancel it; double click toggles fullscreen — like YouTube.
  function onHotClick() {
    if (hotTimer.current !== null) {
      window.clearTimeout(hotTimer.current);
      hotTimer.current = null;
      return;
    }
    hotTimer.current = window.setTimeout(() => {
      hotTimer.current = null;
      if (!videoId) return;
      if (canControlNow()) togglePlayback();
      else requestControl();
    }, 240);
  }

  function onHotDoubleClick() {
    if (hotTimer.current !== null) {
      window.clearTimeout(hotTimer.current);
      hotTimer.current = null;
    }
    toggleCinemaFullscreen();
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const inner = document.createElement("div");
    host.appendChild(inner);
    const yt = new YouTubePlayer(inner);
    void yt.init().then((ok) => {
      // A false result means this instance was destroyed before its async
      // init finished (StrictMode remount) — never attach a dead player.
      if (!ok) return;
      attachPlayer(yt);
      setPlayer(yt);
    });
    const statePoll = setInterval(() => {
      // getState() is null until the iframe API loads — compared against a
      // null YT.PlayerState that read as BUFFERING and spun over the empty
      // state on slow connections. Only a real BUFFERING state counts.
      const state = yt.getState();
      setBuffering(state !== null && typeof YT !== "undefined" && state === YT.PlayerState?.BUFFERING);
    }, 400);
    return () => {
      clearInterval(statePoll);
      yt.destroy();
      host.innerHTML = "";
    };
  }, [attachPlayer]);

  useEffect(() => {
    if (videoId) ensureTitle(videoId);
  }, [videoId, ensureTitle]);

  // Room-wide caption track (0019): steer the embed when the host changes it
  // (no-op while mounting — the player reads the same cached value itself).
  useEffect(() => {
    player?.setCaptionLanguage(captionsLang);
  }, [player, captionsLang]);

  useEffect(() => {
    const goOffline = () => {
      setOffline(true);
      pushToast("You're offline — playback may drift", "error");
    };
    const goOnline = () => {
      setOffline(false);
      pushToast("Back online");
      // Network back: rebuild a dead channel immediately instead of waiting
      // out the backoff, and flush anything the offline period queued.
      const st = useRoom.getState();
      if (st.code && st.connection === "error") void st.reconnect();
      else void st.flushOutbox();
    };
    window.addEventListener("offline", goOffline);
    window.addEventListener("online", goOnline);
    return () => {
      window.removeEventListener("offline", goOffline);
      window.removeEventListener("online", goOnline);
    };
  }, [pushToast]);

  useEffect(() => {
    const prev = prevConn.current;
    prevConn.current = connection;
    if (connection === "error" && prev === "connected") {
      pushToast("Connection lost — retrying…", "error");
    } else if (connection === "connected" && prev === "error") {
      pushToast("Reconnected");
    }
  }, [connection, pushToast]);

  function toggleTheater() {
    setTheater((v) => {
      const next = !v;
      localStorage.setItem("yappie.theater", next ? "1" : "0");
      return next;
    });
  }

  function toggleSound() {
    const next = !sound;
    setSoundEnabled(next);
    setSound(next);
    if (next) playSound("message");
  }

  function handleLoad(value: string, clear: () => void) {
    // Clear only when something actually landed — an invalid link or a
    // rejected queue add keeps the text so it can be fixed.
    void loadVideo(value).then((ok) => {
      if (ok) clear();
    });
  }

  return (
    <div className="screen room-screen">
      <RoomHeader />
      {offline && (
        <div className="offline-banner" role="alert">
          You're offline — reconnecting when the network is back…
        </div>
      )}
      {isHost && pendingJoins.length > 0 && (
        <div className="join-requests" role="status" aria-live="polite">
          {pendingJoins.map((r) => (
            <div className="join-request" key={r.userId}>
              <span className="jr-text">
                <strong>{r.name}</strong> wants to join
              </span>
              <span className="cr-actions">
                <button
                  type="button"
                  className="cr-btn approve"
                  onClick={() => void respondJoin(r.userId, true)}
                >
                  Admit
                </button>
                <button
                  type="button"
                  className="cr-btn deny"
                  onClick={() => void respondJoin(r.userId, false)}
                >
                  Deny
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      <div className={`main${theater ? " theater" : ""}`}>
        <section className="stage">
          <div className={`cinema${ytNative ? " yt-native" : ""}`}>
            <div className="player-wrap">
              <div ref={hostRef} className="player-host" />
            {videoId && !ytNative && (
              <div className="video-hotzone" onClick={onHotClick} onDoubleClick={onHotDoubleClick} />
            )}
              {!videoId && (
                <div className="empty-state">
                  <div className="big">No video yet</div>
                  <div>Start the party in three steps</div>
                  <ol className="onboard-steps">
                    <li>
                      <span className="step-n" aria-hidden="true">
                        1
                      </span>
                      <span>Paste a YouTube link below</span>
                    </li>
                    <li>
                      <span className="step-n" aria-hidden="true">
                        2
                      </span>
                      <span>Invite your friends</span>
                      <button
                        type="button"
                        className="btn primary small"
                        onClick={() => void shareInvite(code, pushToast)}
                      >
                        Share
                      </button>
                    </li>
                    <li>
                      <span className="step-n" aria-hidden="true">
                        3
                      </span>
                      <span>Press play — everyone stays in sync</span>
                    </li>
                  </ol>
                </div>
              )}
              {buffering && (
                <div className="buffering">
                  <div className="spinner" />
                </div>
              )}
            <div className="reaction-layer">
              {floating.map((f) => (
                <span
                  key={f.id}
                  className="floating-reaction"
                  style={{ "--lane": f.lane } as CSSProperties}
                >
                  {f.emoji}
                </span>
              ))}
            </div>
            {upNext && (
              <div className="up-next" role="status" aria-live="polite">
                <img
                  className="up-next-thumb"
                  alt=""
                  src={`https://i.ytimg.com/vi/${upNext.item.videoId}/mqdefault.jpg`}
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                />
                <div className="up-next-info">
                  <span className="up-next-label">
                    Up next in {Math.max(0, Math.ceil((upNext.endsAt - nowTs) / 1000))}s
                    {Object.keys(upNext.item.votes).length > 0 &&
                      ` · ${Object.keys(upNext.item.votes).length} vote${Object.keys(upNext.item.votes).length === 1 ? "" : "s"}`}
                  </span>
                  <span className="up-next-title">{upNext.item.title || upNext.item.videoId}</span>
                </div>
                {isHost && (
                  <button
                    type="button"
                    className="btn primary up-next-skip"
                    onClick={() => skipUpNext()}
                  >
                    Play now
                  </button>
                )}
              </div>
            )}
            <ScreenShare voice={voice} />
            </div>

            <VideoStrip voice={voice} floating />

            <Controls
              player={player}
              playing={playing}
              theater={theater}
              onToggleTheater={toggleTheater}
            />
          </div>

          <VideoStrip voice={voice} />

          <div className="load-bar">
            <input
              className="field"
              type="text"
              placeholder="Paste a YouTube link…"
              spellCheck={false}
              id="load-input"
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const input = e.currentTarget;
                handleLoad(input.value, () => {
                  input.value = "";
                });
              }}
            />
            <button
              className="btn primary"
              onClick={() => {
                const input = document.getElementById("load-input") as HTMLInputElement;
                handleLoad(input.value, () => {
                  input.value = "";
                });
              }}
            >
              Load
            </button>
          </div>

          <div className="stage-meta">
            {roomTopic && (
              <span className="room-topic" title={roomTopic}>
                {roomTopic}
              </span>
            )}
            {videoId && nowTitle && (
              <span className="now-title" title={nowTitle}>
                {nowTitle}
              </span>
            )}
            <span className={videoId ? "play-state has-video" : "play-state"}>
              {videoId
                ? playing
                  ? "Synced · playing"
                  : "Synced · paused"
                : "Waiting for a video…"}
            </span>
            {maxMembers !== null && (
              <span className="cap-chip" title="Participant cap">
                {peopleCount}/{maxMembers} in room
              </span>
            )}
            {videoId && (
              <button
                type="button"
                className={`sync-pill ${
                  drift === null
                    ? "pending"
                    : drift < 0.5
                      ? "ok"
                      : drift < 1.5
                        ? "warn"
                        : "bad"
                }`}
                title="Playback drift vs the host (checked every 5s) — click to resync"
                onClick={() => resyncNow()}
              >
                {drift === null
                  ? "sync —"
                  : `sync ±${drift < 10 ? drift.toFixed(1) : `${Math.floor(drift)}+`}s`}
                {drift !== null && drift >= 0.5 ? " ↻" : ""}
              </button>
            )}
            {videoId && (
              <a href={watchUrl(videoId)} target="_blank" rel="noreferrer">
                Open on YouTube
              </a>
            )}
            {connection === "error" ? (
              <button
                type="button"
                className="conn-pill conn-error conn-retry"
                title="Reconnect now"
                onClick={() => void reconnect()}
              >
                Disconnected · Retry
              </button>
            ) : (
              <span className={`conn-pill conn-${connection}`}>
                {connection === "connected"
                  ? "Live"
                  : connection === "connecting"
                    ? "Connecting…"
                    : ""}
              </span>
            )}
            <button
              className="sound-toggle"
              onClick={toggleSound}
              title={sound ? "Mute notification sounds" : "Unmute notification sounds"}
            >
              {sound ? "🔊" : "🔇"}
            </button>
            {name && <span className="you-are">as {name}</span>}
            {!canControlNow() && videoId && (
              <span className="lock-note">
                {guestsCanControl ? "…" : "host controls playback"}
              </span>
            )}
          </div>

          <ReactionsBar disabled={!videoId} />
          <VoiceBar voice={voice} />
        </section>

        <aside className="sidebar">
          {mobile ? (
            <>
              <nav className="mobile-tabs" aria-label="Panels">
                <button
                  type="button"
                  role="tab"
                  aria-selected={panel === "chat"}
                  className={`mobile-tab${panel === "chat" ? " active" : ""}`}
                  onClick={() => setPanel("chat")}
                >
                  Chat
                  {mentions > 0 ? (
                    <span className="tab-badge mention-badge" title="Messages that @mention you">
                      @{mentions}
                    </span>
                  ) : (
                    unread > 0 && <span className="tab-badge">{unread}</span>
                  )}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={panel === "queue"}
                  className={`mobile-tab${panel === "queue" ? " active" : ""}`}
                  onClick={() => setPanel("queue")}
                >
                  Queue{queueCount > 0 && <span className="tab-badge">{queueCount}</span>}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={panel === "people"}
                  className={`mobile-tab${panel === "people" ? " active" : ""}`}
                  onClick={() => setPanel("people")}
                >
                  People{peopleCount > 0 && <span className="tab-badge">{peopleCount}</span>}
                </button>
              </nav>
              {panel === "chat" && <Chat />}
              {panel === "queue" && (
                <>
                  <QueuePanel />
                  <WatchHistory />
                </>
              )}
              {panel === "people" && (
                <>
                  <Watchers />
                  {auditCard}
                </>
              )}
            </>
          ) : (
            <>
              <Watchers />
              <QueuePanel />
              <WatchHistory />
              {auditCard}
              <Chat />
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
