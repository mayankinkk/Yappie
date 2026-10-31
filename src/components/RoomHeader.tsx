import { useState } from "react";
import { useRoom, isHostNow } from "../stores/room";
import { useSession } from "../stores/session";
import { YappieMark } from "../App";
import { canNativeShare, shareInvite } from "../lib/invite";
import RoomSettings from "./RoomSettings";

export default function RoomHeader() {
  const code = useRoom((s) => s.code)!;
  const roomName = useRoom((s) => s.roomName);
  const hostId = useRoom((s) => s.hostId);
  const guestsCanControl = useRoom((s) => s.guestsCanControl);
  const roomLocked = useRoom((s) => s.roomLocked);
  const toggleGuestControls = useRoom((s) => s.toggleGuestControls);
  const toggleRoomLock = useRoom((s) => s.toggleRoomLock);
  const leaveRoom = useRoom((s) => s.leaveRoom);
  const pushToast = useRoom((s) => s.pushToast);
  const profile = useSession((s) => s.profile);
  const isHost = profile?.id === hostId;
  // Phones get the native share sheet behind a "Share" label; desktop keeps
  // the familiar copy affordance.
  const [nativeShare] = useState(canNativeShare);

  return (
    <header className="topbar">
      <div className="logo">
        <YappieMark size={26} />
        Yappie
      </div>
      <div className="room-chip" title={roomName || `Room ${code}`}>
        {roomName ? <strong className="room-name">{roomName}</strong> : "Room"}{" "}
        <strong>{code}</strong>
      </div>
      {isHost && <span className="badge host-badge">Host</span>}
      <div className="spacer" />
      {isHost && (
        <>
          <RoomSettings />
          <button className="btn small ghost" onClick={toggleGuestControls}>
            {guestsCanControl ? "Lock playback" : "Allow guest control"}
          </button>
          <button
            className={`btn small ghost ${roomLocked ? "active" : ""}`}
            onClick={() => void toggleRoomLock()}
            title={roomLocked ? "Let new guests join" : "Stop new guests from joining"}
          >
            {roomLocked ? "Room locked" : "Lock room"}
          </button>
        </>
      )}
      {!isHost && !guestsCanControl && (
        <span className="badge locked-badge">Host-locked</span>
      )}
      {roomLocked && !isHost && <span className="badge locked-badge">Invite only</span>}
      <button
        className="btn small ghost"
        onClick={() => void shareInvite(code, pushToast)}
        title={nativeShare ? "Share the invite" : "Copy the invite link"}
      >
        {nativeShare ? "Share" : "Copy invite"}
      </button>
      <button className="btn small ghost danger" onClick={leaveRoom}>
        Leave
      </button>
    </header>
  );
}

void isHostNow;
