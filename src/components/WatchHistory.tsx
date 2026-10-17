import { useRoom, canControlNow } from "../stores/room";
import { useSession } from "../stores/session";
import { watchUrl } from "../lib/video-id";

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export default function WatchHistory() {
  const watched = useRoom((s) => s.watched);
  const loadVideo = useRoom((s) => s.loadVideo);
  const videoId = useRoom((s) => s.videoId);
  const name = useSession((s) => s.profile?.name) || "";

  if (watched.length === 0) return null;

  return (
    <div className="card">
      <div className="card-head">
        <span>Watched</span>
        <span>{watched.length}</span>
      </div>
      <div className="watched-body">
        {watched.map((entry) => (
          <div
            key={`${entry.videoId}-${entry.at}`}
            className={`watched-item ${entry.videoId === videoId ? "current" : ""}`}
          >
            <button
              className="watched-main"
              title={canControlNow() ? "Play again" : "Ask to play — you're a guest"}
              onClick={() => void loadVideo(entry.videoId)}
            >
              <img
                className="watched-thumb"
                src={`https://i.ytimg.com/vi/${entry.videoId}/mqdefault.jpg`}
                alt=""
                loading="lazy"
                width={40}
                height={30}
                onError={(e) => {
                  e.currentTarget.style.visibility = "hidden";
                }}
              />
              <span className="watched-title">{entry.title || entry.videoId}</span>
              <span className="watched-time">{relTime(entry.at)}</span>
            </button>
            <a
              className="watched-open"
              href={watchUrl(entry.videoId)}
              target="_blank"
              rel="noreferrer"
              title="Open on YouTube"
            >
              ↗
            </a>
          </div>
        ))}
      </div>
      {!canControlNow() && name && (
        <div className="queue-hint">Click to request a replay — the host plays it.</div>
      )}
    </div>
  );
}
