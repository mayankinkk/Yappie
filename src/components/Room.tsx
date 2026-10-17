import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useRoom } from "../stores/room";
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
import { watchUrl } from "../lib/video-id";
import { soundEnabled, setSoundEnabled, playSound } from "../lib/sound";
import { canControlNow } from "../stores/room";

export default function Room() {
  const code = useRoom((s) => s.code)!;
  const videoId = useRoom((s) => s.videoId);
  const playing = useRoom((s) => s.playing);
  const connection = useRoom((s) => s.connection);
  const drift = useRoom((s) => s.drift);
  const guestsCanControl = useRoom((s) => s.guestsCanControl);
  const attachPlayer = useRoom((s) => s.attachPlayer);
  const loadVideo = useRoom((s) => s.loadVideo);
  const floating = useRoom((s) => s.floating);
  const [player, setPlayer] = useState<YouTubePlayer | null>(null);
  const [buffering, setBuffering] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  const [sound, setSound] = useState(soundEnabled());
  const name = useSession((s) => s.profile?.name) || "";

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const inner = document.createElement("div");
    host.appendChild(inner);
    const yt = new YouTubePlayer(inner);
    void yt.init().then(() => {
      attachPlayer(yt);
      setPlayer(yt);
    });
    const statePoll = setInterval(() => {
      setBuffering(yt.getState() === YT.PlayerState.BUFFERING);
    }, 400);
    return () => {
      clearInterval(statePoll);
      yt.destroy();
      host.innerHTML = "";
    };
  }, [attachPlayer]);

  function toggleSound() {
    const next = !sound;
    setSoundEnabled(next);
    setSound(next);
    if (next) playSound("message");
  }

  function handleLoad(value: string, clear: () => void) {
    void loadVideo(value).then(clear);
  }

  return (
    <div className="screen room-screen">
      <RoomHeader />
      <div className="main">
        <section className="stage">
          <div className="player-wrap">
            <div ref={hostRef} className="player-host" />
            {!videoId && (
              <div className="empty-state">
                <div className="big">No video yet</div>
                <div>Paste a YouTube link below to start the party</div>
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
          </div>

          <Controls player={player} playing={playing} />

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
            <span>
              {videoId
                ? playing
                  ? "Synced · playing"
                  : "Synced · paused"
                : "Waiting for a video…"}
            </span>
            {videoId && (
              <span
                className={`sync-pill ${
                  drift === null
                    ? "pending"
                    : drift < 0.5
                      ? "ok"
                      : drift < 1.5
                        ? "warn"
                        : "bad"
                }`}
                title="Playback drift vs the host (checked every 5s)"
              >
                {drift === null
                  ? "sync —"
                  : `sync ±${drift < 10 ? drift.toFixed(1) : `${Math.floor(drift)}+`}s`}
              </span>
            )}
            {videoId && (
              <a href={watchUrl(videoId)} target="_blank" rel="noreferrer">
                Open on YouTube
              </a>
            )}
            <span className={`conn-pill conn-${connection}`}>
              {connection === "connected"
                ? "Live"
                : connection === "connecting"
                  ? "Connecting…"
                  : connection === "error"
                    ? "Disconnected"
                    : ""}
            </span>
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
          <VoiceBar roomCode={code} />
        </section>

        <aside className="sidebar">
          <Watchers />
          <QueuePanel />
          <WatchHistory />
          <Chat />
        </aside>
      </div>
    </div>
  );
}
