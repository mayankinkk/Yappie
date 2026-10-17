import { useRoom, isHostNow } from "../stores/room";
import { useSession } from "../stores/session";
import { SofaMark } from "../App";

export default function RoomHeader() {
  const code = useRoom((s) => s.code)!;
  const hostId = useRoom((s) => s.hostId);
  const guestsCanControl = useRoom((s) => s.guestsCanControl);
  const toggleGuestControls = useRoom((s) => s.toggleGuestControls);
  const leaveRoom = useRoom((s) => s.leaveRoom);
  const pushToast = useRoom((s) => s.pushToast);
  const profile = useSession((s) => s.profile);
  const isHost = profile?.id === hostId;

  async function copyLink() {
    const link = `${location.origin}${location.pathname}?room=${code}`;
    try {
      await navigator.clipboard.writeText(link);
      pushToast("Invite link copied");
    } catch {
      window.prompt("Copy this invite link:", link);
    }
  }

  return (
    <header className="topbar">
      <div className="logo">
        <SofaMark size={26} />
        Sofa
      </div>
      <div className="room-chip">
        Room <strong>{code}</strong>
      </div>
      {isHost && <span className="badge host-badge">Host</span>}
      <div className="spacer" />
      {isHost && (
        <button className="btn small ghost" onClick={toggleGuestControls}>
          {guestsCanControl ? "Lock playback" : "Allow guest control"}
        </button>
      )}
      {!isHost && !guestsCanControl && (
        <span className="badge locked-badge">Host-locked</span>
      )}
      <button className="btn small ghost" onClick={() => void copyLink()}>
        Copy invite
      </button>
      <button className="btn small ghost" onClick={leaveRoom}>
        Leave
      </button>
    </header>
  );
}

void isHostNow;
