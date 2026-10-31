import { useState } from "react";
import { useRoom, isHostNow } from "../stores/room";
import { useSession } from "../stores/session";

export default function QueuePanel() {
  const queue = useRoom((s) => s.queue);
  const removeFromQueue = useRoom((s) => s.removeFromQueue);
  const playFromQueue = useRoom((s) => s.playFromQueue);
  const addToQueue = useRoom((s) => s.addToQueue);
  const moveQueue = useRoom((s) => s.moveQueue);
  const voteQueue = useRoom((s) => s.voteQueue);
  const hostId = useRoom((s) => s.hostId);
  const myId = useSession((s) => s.profile?.id);
  const isHost = hostId === myId;
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  return (
    <div className="card queue-card">
      <div className="card-head">
        <span>Up next</span>
        <span>{queue.length}</span>
      </div>
      <div className="queue-body">
        {queue.length === 0 && <div className="queue-empty">Queue is empty</div>}
        {queue.map((item, i) => (
          <div
            key={item.id}
            className={`queue-item${dragIndex === i ? " dragging" : ""}${
              overIndex === i && dragIndex !== null && dragIndex !== i ? " drop-target" : ""
            }`}
            draggable={isHost}
            onDragStart={(e) => {
              setDragIndex(i);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", String(i));
            }}
            onDragOver={(e) => {
              if (!isHost || dragIndex === null) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setOverIndex(i);
            }}
            onDragLeave={() => {
              if (overIndex === i) setOverIndex(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              if (!isHost || dragIndex === null) return;
              moveQueue(dragIndex, i);
              setDragIndex(null);
              setOverIndex(null);
            }}
            onDragEnd={() => {
              setDragIndex(null);
              setOverIndex(null);
            }}
          >
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
            <button
              type="button"
              className={`queue-vote${myId && item.votes[myId] ? " voted" : ""}`}
              title={myId && item.votes[myId] ? "Remove your vote" : "Upvote"}
              onClick={() => void voteQueue(item.id)}
            >
              <span className="queue-vote-arrow">▲</span>
              <span className="queue-vote-count">
                {Object.keys(item.votes).length || ""}
              </span>
            </button>
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
            void addToQueue(input.value).then((ok) => {
              if (ok) input.value = "";
            });
          }}
        />
      </div>
      {isHost && <div className="queue-hint">You're the host — you control what plays.</div>}
      {!isHost && <div className="queue-hint">Anyone can queue · most-voted plays next.</div>}
    </div>
  );
}

void isHostNow;
