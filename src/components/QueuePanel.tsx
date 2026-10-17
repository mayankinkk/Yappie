import { useRoom, isHostNow } from "../stores/room";
import { useSession } from "../stores/session";

export default function QueuePanel() {
  const queue = useRoom((s) => s.queue);
  const removeFromQueue = useRoom((s) => s.removeFromQueue);
  const playFromQueue = useRoom((s) => s.playFromQueue);
  const addToQueue = useRoom((s) => s.addToQueue);
  const hostId = useRoom((s) => s.hostId);
  const myId = useSession((s) => s.profile?.id);
  const isHost = hostId === myId;

  return (
    <div className="card queue-card">
      <div className="card-head">
        <span>Up next</span>
        <span>{queue.length}</span>
      </div>
      <div className="queue-body">
        {queue.length === 0 && <div className="queue-empty">Queue is empty</div>}
        {queue.map((item, i) => (
          <div key={item.id} className="queue-item">
            <span className="queue-index">{i + 1}</span>
            <img
              className="queue-thumb"
              src={`https://i.ytimg.com/vi/${item.videoId}/mqdefault.jpg`}
              alt=""
              loading="lazy"
              width={52}
              height={39}
              onError={(e) => {
                e.currentTarget.style.visibility = "hidden";
              }}
            />
            <div className="queue-info">
              <div className="queue-title">{item.title || item.videoId}</div>
              <div className="queue-meta">
                added by {item.addedBy === myId ? "you" : item.addedByName}
              </div>
            </div>
            <div className="queue-actions">
              {isHost && (
                <button className="queue-btn" title="Play now" onClick={() => playFromQueue(item.id)}>
                  ▶
                </button>
              )}
              {(isHost || item.addedBy === myId) && (
                <button className="queue-btn" title="Remove" onClick={() => removeFromQueue(item.id)}>
                  ✕
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="queue-add">
        <input
          className="field small"
          type="text"
          placeholder="Add a YouTube link…"
          spellCheck={false}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            const input = e.currentTarget;
            void addToQueue(input.value).then(() => {
              input.value = "";
            });
          }}
        />
      </div>
      {isHost && <div className="queue-hint">You're the host — you control what plays.</div>}
      {!isHost && <div className="queue-hint">Anyone can queue · the host plays.</div>}
    </div>
  );
}

void isHostNow;
