import { useEffect, useState } from "react";
import { useSession } from "../stores/session";
import { useRoom } from "../stores/room";
import { sanitizeCode } from "../lib/ids";
import { isSupabaseConfigured } from "../lib/supabase";
import { loadRecentRooms } from "../lib/recent";
import { RoomError } from "../lib/rooms-api";
import { SofaMark } from "../App";

interface Props {
  onNeedSetup: () => void;
  askPasswordFor?: string | null;
}

export default function Landing({ onNeedSetup, askPasswordFor }: Props) {
  const profile = useSession((s) => s.profile);
  const setName = useSession((s) => s.setName);
  const signInWithGoogle = useSession((s) => s.signInWithGoogle);
  const createRoom = useRoom((s) => s.createRoom);
  const joinRoom = useRoom((s) => s.joinRoom);
  const pushToast = useRoom((s) => s.pushToast);
  const [code, setCode] = useState(
    new URLSearchParams(location.search).get("room")?.toUpperCase() || "",
  );
  const [busy, setBusy] = useState(false);
  const [shake, setShake] = useState(0);
  const [joinPassword, setJoinPassword] = useState<string | null>(null);
  const [passwordDraft, setPasswordDraft] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [createProtected, setCreateProtected] = useState(false);
  const [roomPassword, setRoomPassword] = useState("");
  const [recent] = useState(loadRecentRooms);

  useEffect(() => {
    const clean = sanitizeCode(askPasswordFor || "");
    if (clean.length === 6) {
      setCode(clean);
      setJoinPassword((prev) => prev ?? clean);
    }
  }, [askPasswordFor]);

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

  function handleJoinError(e: unknown, clean: string): void {
    if (e instanceof RoomError && e.code === "password") {
      setJoinPassword(clean);
      setPasswordError(e.message === "Wrong password" ? "Wrong password" : "");
      return;
    }
    if (joinPassword) setJoinPassword(null);
    setPasswordDraft("");
    setPasswordError("");
    if (!(e instanceof RoomError)) pushToast("Couldn't join the room", "error");
  }

  async function handleCreate() {
    if (busy) return;
    if (!requireName() || !requireSetup()) return;
    const pw = createProtected && roomPassword.trim() ? roomPassword.trim() : null;
    if (createProtected && !pw) {
      setShake((s) => s + 1);
      return;
    }
    setBusy(true);
    try {
      await createRoom(profile!, pw);
    } catch (e) {
      if (!(e instanceof RoomError)) pushToast("Couldn't create the room", "error");
    } finally {
      setBusy(false);
    }
  }

  async function doJoin(clean: string) {
    if (busy) return;
    if (!requireName() || !requireSetup()) return;
    if (clean.length !== 6) {
      setShake((s) => s + 1);
      return;
    }
    setBusy(true);
    setPasswordError("");
    try {
      await joinRoom(clean, profile!, joinPassword ? passwordDraft : null);
      setJoinPassword(null);
      setPasswordDraft("");
    } catch (e) {
      handleJoinError(e, clean);
    } finally {
      setBusy(false);
    }
  }

  async function handleJoin() {
    if (busy) return;
    await doJoin(sanitizeCode(code));
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
        <label className="pw-toggle">
          <input
            type="checkbox"
            checked={createProtected}
            onChange={(e) => setCreateProtected(e.target.checked)}
          />
          Protect the room with a password
        </label>
        {createProtected && (
          <input
            className="field"
            type="password"
            maxLength={64}
            placeholder="Room password"
            value={roomPassword}
            onChange={(e) => setRoomPassword(e.target.value)}
          />
        )}
        <div className="divider">
          <span>or join a friend</span>
        </div>
        <div className="join-row">
          <input
            id="code-input"
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
        {recent.length > 0 && (
          <div className="recent-rooms" aria-label="Recent rooms">
            <span className="recent-label">Recent</span>
            {recent.map((r) => (
              <button
                key={r.code}
                className="recent-chip"
                title={`Rejoin room ${r.code}`}
                disabled={busy}
                onClick={() => {
                  setCode(r.code);
                  void doJoin(r.code);
                }}
              >
                {r.code}
              </button>
            ))}
          </div>
        )}
        {joinPassword && (
          <div className="join-password">
            <input
              id="join-password-input"
              className="field"
              type="password"
              maxLength={64}
              autoFocus
              placeholder="Password for this room"
              value={passwordDraft}
              onChange={(e) => setPasswordDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleJoin();
              }}
            />
            {passwordError && <div className="field-error">{passwordError}</div>}
          </div>
        )}
        {isSupabaseConfigured() && (
          <>
            <div className="divider">
              <span>or</span>
            </div>
            <button
              className="btn wide google-btn"
              disabled={busy}
              onClick={() => {
                void signInWithGoogle().then((err) => {
                  if (err) pushToast(err, "error");
                });
              }}
            >
              <span className="google-g" aria-hidden="true">
                G
              </span>
              Continue with Google
            </button>
          </>
        )}
      </div>
    </div>
  );
}
