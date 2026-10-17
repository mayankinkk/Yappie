import { useRoom } from "../stores/room";
import { useSession } from "../stores/session";
import { initials } from "../lib/ids";

export default function Watchers() {
  const participants = useRoom((s) => s.participants);
  const hostId = useRoom((s) => s.hostId);
  const myId = useSession((s) => s.profile?.id);
  const sorted = [...participants].sort((a, b) => a.joinedAt - b.joinedAt);

  return (
    <div className="card">
      <div className="card-head">
        <span>Watching</span>
        <span>{participants.length || 1}</span>
      </div>
      <div className="watchers-body">
        {sorted.length === 0 && myId && (
          <span className="watcher-chip you">
            <span className="avatar sm" style={{ ["--h" as string]: useSession.getState().profile?.color ?? 30 }}>
              {initials(useSession.getState().profile?.name || "?")}
            </span>
            <span className="name">You</span>
          </span>
        )}
        {sorted.map((p) => (
          <span
            key={p.id}
            className={`watcher-chip ${p.id === myId ? "you" : ""}`}
            title={p.id === hostId ? `${p.name} (host)` : p.name}
          >
            <span className="avatar sm" style={{ ["--h" as string]: p.color }}>
              {initials(p.name)}
            </span>
            <span className="name">
              {p.id === myId ? `${p.name} (you)` : p.name}
              {p.id === hostId && <span className="host-dot" title="Host">★</span>}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
