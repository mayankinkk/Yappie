import { useState } from "react";
import { useRoom } from "../stores/room";
import { useSession } from "../stores/session";
import { initials } from "../lib/ids";

const MUTE_MINUTES = 5;

export default function Watchers() {
  const participants = useRoom((s) => s.participants);
  const members = useRoom((s) => s.members);
  const hostId = useRoom((s) => s.hostId);
  const moderate = useRoom((s) => s.moderate);
  const setHost = useRoom((s) => s.setHost);
  const myId = useSession((s) => s.profile?.id);
  const isHost = !!myId && myId === hostId;
  const [expanded, setExpanded] = useState<string | null>(null);
  const sorted = [...participants].sort((a, b) => a.joinedAt - b.joinedAt);

  function memberInfo(userId: string) {
    return members.find((m) => m.user_id === userId);
  }

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
        {sorted.map((p) => {
          const info = memberInfo(p.id);
          const muted = !!info?.muted_until && Date.parse(info.muted_until) > Date.now();
          const banned = !!info?.banned;
          const canModerate = isHost && p.id !== myId;
          const open = canModerate && expanded === p.id;
          return (
            <div className="watcher-row" key={p.id}>
              <span
                className={`watcher-chip ${p.id === myId ? "you" : ""} ${canModerate ? "clickable" : ""}`}
                title={p.id === hostId ? `${p.name} (host)` : p.name}
                onClick={() => canModerate && setExpanded(open ? null : p.id)}
              >
                <span className="avatar sm" style={{ ["--h" as string]: p.color }}>
                  {initials(p.name)}
                </span>
                <span className="name">
                  {p.id === myId ? `${p.name} (you)` : p.name}
                  {p.id === hostId && <span className="host-dot" title="Host">★</span>}
                  {muted && <span className="member-dot" title="Muted">🔇</span>}
                  {banned && <span className="member-dot" title="Banned">🚫</span>}
                </span>
              </span>
              {open && (
                <div className="watcher-actions">
                  <button
                    className="btn small ghost"
                    onClick={() => {
                      void moderate(p.id, banned ? { banned: false } : { banned: true });
                      setExpanded(null);
                    }}
                  >
                    {banned ? "Unban" : "Ban"}
                  </button>
                  <button
                    className="btn small ghost"
                    onClick={() => {
                      void moderate(
                        p.id,
                        muted ? { muteSeconds: 0 } : { muteSeconds: MUTE_MINUTES * 60 },
                      );
                      setExpanded(null);
                    }}
                  >
                    {muted ? "Unmute" : `Mute ${MUTE_MINUTES}m`}
                  </button>
                  <button
                    className="btn small ghost"
                    onClick={() => {
                      void setHost(p.id);
                      setExpanded(null);
                    }}
                  >
                    Make host
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
