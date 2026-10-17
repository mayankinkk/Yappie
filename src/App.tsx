import { useEffect, useState } from "react";
import { useSession } from "./stores/session";
import { useRoom } from "./stores/room";
import { isValidRoomCode } from "./lib/ids";
import { RoomError } from "./lib/rooms-api";
import Landing from "./components/Landing";
import Room from "./components/Room";
import Toasts from "./components/Toasts";
import SetupOverlay from "./components/SetupOverlay";
import { isSupabaseConfigured } from "./lib/supabase";

export default function App() {
  const [booted, setBooted] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [askPassword, setAskPassword] = useState<string | null>(null);
  const profile = useSession((s) => s.profile);
  const init = useSession((s) => s.init);
  const code = useRoom((r) => r.code);
  const joinRoom = useRoom((r) => r.joinRoom);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const p = await init();
      if (cancelled) return;
      const roomParam = new URLSearchParams(location.search).get("room")?.toUpperCase() || "";
      if (isValidRoomCode(roomParam) && isSupabaseConfigured() && p.name !== "Guest") {
        try {
          await joinRoom(roomParam, p);
        } catch (e) {
          // Password-protected room: fall back to the landing page with the
          // password prompt open for this code. Other errors toast in the store.
          if (e instanceof RoomError && e.code === "password") setAskPassword(roomParam);
        }
      }
      if (!isSupabaseConfigured()) setShowSetup(true);
      setBooted(true);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!booted || !profile) {
    return (
      <div className="boot">
        <div className="logo">
          <SofaMark size={40} />
          Sofa
        </div>
      </div>
    );
  }

  return (
    <>
      {code ? (
        <Room />
      ) : (
        <Landing onNeedSetup={() => setShowSetup(true)} askPasswordFor={askPassword} />
      )}
      <Toasts />
      {showSetup && (
        <SetupOverlay
          onClose={() => setShowSetup(false)}
          onSaved={() => setShowSetup(false)}
        />
      )}
    </>
  );
}

export function SofaMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect width="64" height="64" rx="15" fill="#F59E0B" />
      <path d="M12 33c0-4.4 3.6-8 8-8h24c4.4 0 8 3.6 8 8v9H12v-9z" fill="#1a1205" />
      <rect x="15" y="42" width="7" height="8" rx="2.5" fill="#1a1205" />
      <rect x="42" y="42" width="7" height="8" rx="2.5" fill="#1a1205" />
    </svg>
  );
}
