import { useState } from "react";
import { useSession } from "../stores/session";
import { useRoom } from "../stores/room";
import { sanitizeCode } from "../lib/ids";
import { isSupabaseConfigured } from "../lib/supabase";
import { RoomError } from "../lib/rooms-api";
import { SofaMark } from "../App";

interface Props {
  onNeedSetup: () => void;
}

export default function Landing({ onNeedSetup }: Props) {
  const profile = useSession((s) => s.profile);
  const setName = useSession((s) => s.setName);
  const createRoom = useRoom((s) => s.createRoom);
  const joinRoom = useRoom((s) => s.joinRoom);
  const pushToast = useRoom((s) => s.pushToast);
  const [code, setCode] = useState(
    new URLSearchParams(location.search).get("room")?.toUpperCase() || "",
  );
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(0);

  function requireName(): boolean {
    if (!profile?.name || profile.name === "Guest") {
      const input = document.getElementById("name-input") as HTMLInputElement | null;
      input?.focus();
      setShake((s) => s + 1);
      return false;
    }
    return true;
  }

  function requireSetup(): boolean {
    if (!isSupabaseConfigured()) {
      onNeedSetup();
      return false;
    }
    return true;
  }

  async function handleCreate() {
    if (busy) return;
    if (!requireName() || !requireSetup()) return;
    setBusy(true);
    try {
      await createRoom(profile!);
    } catch (e) {
      if (!(e instanceof RoomError)) pushToast("Couldn't create the room", "error");
    } finally {
      setBusy(false);
    }
  }

  async function handleJoin() {
    if (busy) return;
    if (!requireName() || !requireSetup()) return;
    const clean = sanitizeCode(code);
    if (clean.length !== 6) {
      setShake((s) => s + 1);
      return;
    }
    setBusy(true);
    try {
      await joinRoom(clean, profile!);
    } catch (e) {
      if (!(e instanceof RoomError)) pushToast("Couldn't join the room", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="screen landing-wrap">
      <div className={`landing-card ${shake > 0 ? "shake" : ""}`} key={shake}>
        <div className="logo">
          <SofaMark size={34} />
          Sofa
        </div>
        <p className="tagline">Watch YouTube together, perfectly in sync.</p>
        <input
          id="name-input"
          className="field"
          type="text"
          maxLength={24}
          placeholder="Your name"
          defaultValue={profile?.name === "Guest" ? "" : profile?.name || ""}
          onBlur={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
          }}
        />
        <button className="btn primary wide" onClick={handleCreate} disabled={busy}>
          {busy ? "Joining…" : "Create a room"}
        </button>
        <div className="divider">
          <span>or join a friend</span>
        </div>
        <div className="join-row">
          <input
            className="field code-field"
            type="text"
            maxLength={6}
            placeholder="CODE"
            value={code}
            spellCheck={false}
            onChange={(e) => setCode(sanitizeCode(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === "Enter") void handleJoin();
            }}
          />
          <button className="btn" onClick={handleJoin} disabled={busy}>
            Join
          </button>
        </div>
      </div>
    </div>
  );
}
