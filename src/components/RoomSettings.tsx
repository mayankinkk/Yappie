import { useState } from "react";
import { useRoom } from "../stores/room";

/**
 * Host-only room settings (0017): identity (name/topic), participant cap,
 * and the guest-approval gate. Saves through the host-gated rooms UPDATE —
 * the realtime echo carries the new values to everyone else.
 */
export default function RoomSettings() {
  const roomName = useRoom((s) => s.roomName);
  const roomTopic = useRoom((s) => s.roomTopic);
  const maxMembers = useRoom((s) => s.maxMembers);
  const requireApproval = useRoom((s) => s.requireApproval);
  const saveRoomMeta = useRoom((s) => s.saveRoomMeta);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(roomName || "");
  const [topic, setTopic] = useState(roomTopic || "");
  const [cap, setCap] = useState(maxMembers === null ? "" : String(maxMembers));
  const [approval, setApproval] = useState(requireApproval);
  const [saving, setSaving] = useState(false);

  function openForm() {
    setName(roomName || "");
    setTopic(roomTopic || "");
    setCap(maxMembers === null ? "" : String(maxMembers));
    setApproval(requireApproval);
    setOpen(true);
  }

  async function save() {
    const parsed = cap.trim() === "" ? null : Number.parseInt(cap, 10);
    if (parsed !== null && (Number.isNaN(parsed) || parsed < 2 || parsed > 100)) return;
    setSaving(true);
    await saveRoomMeta({
      name,
      topic,
      maxMembers: parsed,
      requireApproval: approval,
    });
    setSaving(false);
    setOpen(false);
  }

  return (
    <>
      <button
        className="btn small ghost"
        onClick={openForm}
        title="Room settings"
        aria-label="Room settings"
      >
        ⚙ Settings
      </button>
      {open && (
        <div className="overlay" onClick={() => setOpen(false)}>
          <div
            className="overlay-card"
            role="dialog"
            aria-modal="true"
            aria-label="Room settings"
            onClick={(e) => e.stopPropagation()}
          >
            <h2>Room settings</h2>
            <p>Everyone sees these — the name shows in the header, the topic on stage.</p>
            <input
              className="field"
              type="text"
              maxLength={40}
              placeholder="Room name (e.g. Movie night)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <input
              className="field"
              type="text"
              maxLength={120}
              placeholder="Topic or note for tonight"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
            />
            <input
              className="field"
              type="number"
              min={2}
              max={100}
              placeholder="Participant cap (2–100, empty = unlimited)"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
            />
            <label className="pw-toggle">
              <input
                type="checkbox"
                checked={approval}
                onChange={(e) => setApproval(e.target.checked)}
              />
              Let me approve people before they join
            </label>
            <div className="overlay-actions">
              <button className="btn ghost" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button className="btn primary" onClick={() => void save()} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
            <p className="overlay-note">
              With approval on, new guests wait at the door until you admit them.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
