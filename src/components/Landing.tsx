import { useEffect, useState } from "react";
import { useSession, AVATAR_EMOJIS } from "../stores/session";
import { useRoom } from "../stores/room";
import { sanitizeCode } from "../lib/ids";
import { isSupabaseConfigured } from "../lib/supabase";
import { loadRecentRooms } from "../lib/recent";
import { RoomError } from "../lib/rooms-api";
import { YappieMark } from "../App";

interface Props {
  onNeedSetup: () => void;
  askPasswordFor?: string | null;
}

export default function Landing({ onNeedSetup, askPasswordFor }: Props) {
  const profile = useSession((s) => s.profile);
  const setName = useSession((s) => s.setName);
  const setAvatar = useSession((s) => s.setAvatar);
  const signInWithGoogle = useSession((s) => s.signInWithGoogle);
  const createRoom = useRoom((s) => s.createRoom);
  const joinRoom = useRoom((s) => s.joinRoom);
  const pushToast = useRoom((s) => s.pushToast);
  const awaitingApproval = useRoom((s) => s.awaitingApproval);
  const cancelApproval = useRoom((s) => s.cancelApproval);
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
  const [avatarOpen, setAvatarOpen] = useState(false);
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
      setShake((s) => s + 1);
      // The shake remounts the card (key={shake}), so focus must land on
      // the *new* input after React repaints — or mobile keyboards never open.
      requestAnimationFrame(() => document.getElementById("name-input")?.focus());
      pushToast("Enter your name first", "error");
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
    if (busy || awaitingApproval) return;
    if (!requireName() || !requireSetup()) return;
    const pw = createProtected && roomPassword.trim() ? roomPassword.trim() : null;
    if (createProtected && !pw) {
      setShake((s) => s + 1);
      pushToast("Enter a room password", "error");
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
    if (busy || awaitingApproval) return;
    if (!requireName() || !requireSetup()) return;
    if (clean.length !== 6) {
      setShake((s) => s + 1);
      pushToast("Room codes are 6 characters", "error");
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
    if (busy || awaitingApproval) return;
    await doJoin(sanitizeCode(code));
  }

  return (
    <div className="screen landing-wrap">
      <div className={`landing-card ${shake > 0 ? "shake" : ""}`} key={shake}>
        <div className="logo">
          <YappieMark size={34} />
          Yappie
        </div>
        <p className="tagline">Watch YouTube together, perfectly in sync.</p>
        <div className="avatar-pick">
          <button
            type="button"
            className="avatar-pick-btn"
            aria-label="Pick an avatar"
            aria-expanded={avatarOpen}
            onClick={() => setAvatarOpen((v) => !v)}
          >
            <span className={`avatar${profile?.avatar ? " emoji" : ""}`} style={{ ["--h" as string]: profile?.color ?? 30 }}>
              {profile?.avatar || "Aa"}
            </span>
            <span className="avatar-pick-hint">
              {profile?.avatar ? "Change avatar" : "Pick an avatar"}
            </span>
          </button>
          {avatarOpen && (
            <div className="avatar-grid" role="menu" aria-label="Avatar picker">
              {AVATAR_EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  className={`avatar-cell ${profile?.avatar === e ? "active" : ""}`}
                  role="menuitem"
                  onClick={() => {
                    setAvatar(e);
                    setAvatarOpen(false);
                  }}
                >
                  {e}
                </button>
              ))}
              <button
                type="button"
                className={`avatar-cell initials ${!profile?.avatar ? "active" : ""}`}
                title="Use initials"
                onClick={() => {
                  setAvatar("");
                  setAvatarOpen(false);
                }}
              >
                Aa
              </button>
            </div>
          )}
        </div>
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
        <button className="btn primary wide" onClick={handleCreate} disabled={busy || awaitingApproval}>
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
          <button className="btn" onClick={handleJoin} disabled={busy || awaitingApproval}>
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
                disabled={busy || awaitingApproval}
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
        {awaitingApproval && (
          <div className="approval-wait" role="status" aria-live="polite">
            <span className="approval-dot" aria-hidden="true" />
            <div className="approval-copy">
              <strong>Asking the host…</strong>
              <span>This room lets the host approve who's in — hang tight.</span>
            </div>
            <button
              className="btn small ghost"
              onClick={cancelApproval}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        )}
        {isSupabaseConfigured() && (
          <>
            <div className="divider">
              <span>or</span>
            </div>
            <button
              className="btn wide google-btn"
              disabled={busy || awaitingApproval}
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
