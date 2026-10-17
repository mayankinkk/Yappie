import { getSupabase } from "./supabase";

export interface WatchedEntry {
  videoId: string;
  title?: string | null;
  at: number;
}

export interface RoomRow {
  code: string;
  host_id: string;
  guests_can_control: boolean;
  locked: boolean;
  queue: QueueRow[] | null;
  queue_version: number;
  video_id: string | null;
  granted_to?: string[] | null;
  watched?: WatchedEntry[] | null;
  password_hash?: string | null;
}

export interface QueueRow {
  id: string;
  videoId: string;
  title: string | null;
  addedBy: string;
  addedByName: string;
  addedAt: number;
}

export interface MembershipRow {
  room_code: string;
  user_id: string;
  display_name: string;
  banned: boolean;
  muted_until: string | null;
  joined_at: string;
  left_at: string | null;
  last_seen: string;
}

export interface ChatRow {
  id: string;
  room_code: string;
  sender_id: string;
  sender_name: string;
  color: number;
  text: string;
  created_at: string;
  reactions?: Record<string, string[]> | null;
}

export class RoomError extends Error {
  readonly code: string;
  readonly silent?: boolean;
  constructor(code: string, message: string, silent = false) {
    super(message);
    this.code = code;
    this.silent = silent;
  }
}

function mapError(raw: string): RoomError {
  const msg = raw || "";
  if (msg.includes("not_authenticated")) {
    return new RoomError("auth", "Sign-in failed — check your Supabase anonymous auth settings");
  }
  if (msg.includes("room_not_found")) return new RoomError("not_found", "Room not found");
  if (msg.includes("password_required")) {
    return new RoomError("password", "That room needs a password", true);
  }
  if (msg.includes("password_wrong")) return new RoomError("password", "Wrong password", true);
  if (msg.includes("banned")) return new RoomError("banned", "You're banned from this room");
  if (msg.includes("locked")) return new RoomError("locked", "The room is locked right now");
  if (msg.includes("rate_limited")) return new RoomError("rate", "Slow down — rooms created too fast");
  if (msg.includes("not_host")) return new RoomError("host", "Only the host can do that");
  if (msg.includes("host_active") || msg.includes("not_senior") || msg.includes("invalid_target")) {
    return new RoomError("host", "Host handoff rejected");
  }
  if (msg.includes("not_a_member")) return new RoomError("member", "Not a member of this room");
  return new RoomError("unknown", "Something went wrong — try again");
}

function rpcMsg(e: { message?: string } | null | undefined): string {
  return e?.message || "";
}

export async function createRoomRpc(password: string | null, name: string): Promise<string> {
  const supabase = getSupabase();
  if (!supabase) throw new RoomError("config", "Connect Supabase first");
  const { data, error } = await supabase.rpc("create_room", {
    p_password: password,
    p_name: name,
  });
  if (error) throw mapError(rpcMsg(error));
  const code = String(data || "").toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) throw mapError("unknown");
  return code;
}

export interface JoinedRoom {
  hostId: string;
  guestsCanControl: boolean;
  locked: boolean;
  queue: QueueRow[];
  queueVersion: number;
  videoId: string | null;
  requiresPassword: boolean;
  grantedTo: string[];
}

export async function joinRoomRpc(
  code: string,
  password: string | null,
  name: string,
): Promise<JoinedRoom> {
  const supabase = getSupabase();
  if (!supabase) throw new RoomError("config", "Connect Supabase first");
  const { data, error } = await supabase.rpc("join_room", {
    p_code: code,
    p_password: password,
    p_name: name,
  });
  if (error) throw mapError(rpcMsg(error));
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw mapError("room_not_found");
  return {
    hostId: String(row.p_host_id),
    guestsCanControl: !!row.p_guests_can_control,
    locked: !!row.p_locked,
    queue: (row.p_queue as QueueRow[] | null) || [],
    queueVersion: Number(row.p_queue_version) || 0,
    videoId: (row.p_video_id as string | null) || null,
    requiresPassword: !!row.p_password_required,
    grantedTo: Array.isArray(row.p_granted_to) ? (row.p_granted_to as string[]) : [],
  };
}

export async function leaveRoomRpc(code: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  await supabase.rpc("leave_room", { p_code: code });
}

export async function claimHostRpc(code: string): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  const { error } = await supabase.rpc("claim_host", { p_code: code });
  if (error) {
    const mapped = mapError(rpcMsg(error));
    // "host came back" / "someone more senior got it" are normal races, not errors.
    if (["host", "member"].includes(mapped.code)) return false;
    if (mapped.code === "not_found" || mapped.code === "banned") return false;
    return false;
  }
  return true;
}

export async function heartbeatRpc(code: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) return;
  await supabase.rpc("heartbeat", { p_code: code });
}

export async function moderateMemberRpc(
  code: string,
  userId: string,
  opts: { banned?: boolean; muteSeconds?: number },
): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new RoomError("config", "Connect Supabase first");
  const { error } = await supabase.rpc("moderate_member", {
    p_code: code,
    p_user_id: userId,
    p_banned: opts.banned ?? null,
    p_mute_seconds: opts.muteSeconds ?? null,
  });
  if (error) {
    const mapped = mapError(rpcMsg(error));
    if (mapped.code === "host") throw new RoomError("host", "Only the host can do that");
    if (mapped.code === "member") throw new RoomError("member", "That person isn't in the room");
    throw mapped;
  }
}

export async function deleteChatMessageRpc(code: string, messageId: string): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new RoomError("config", "Connect Supabase first");
  const { error } = await supabase.rpc("delete_chat_message", {
    p_code: code,
    p_message_id: messageId,
  });
  if (error) {
    const mapped = mapError(rpcMsg(error));
    if (mapped.code === "host") throw new RoomError("host", "Only the host can do that");
    throw mapped;
  }
}

export async function toggleChatReactionRpc(
  code: string,
  messageId: string,
  emoji: string,
): Promise<Record<string, string[]>> {
  const supabase = getSupabase();
  if (!supabase) throw new RoomError("config", "Connect Supabase first");
  const { data, error } = await supabase.rpc("toggle_chat_reaction", {
    p_code: code,
    p_message_id: messageId,
    p_emoji: emoji,
  });
  if (error) throw mapError(rpcMsg(error));
  return (data ?? {}) as Record<string, string[]>;
}

export async function saveRoomSettings(
  code: string,
  settings: {
    guests_can_control?: boolean;
    locked?: boolean;
    queue?: QueueRow[];
    queue_version?: number;
    video_id?: string | null;
    host_id?: string;
    granted_to?: string[];
    watched?: WatchedEntry[];
  },
): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  // .select() makes RLS denials visible: 0 rows affected → caller isn't the host.
  const { data, error } = await supabase.from("rooms").update(settings).eq("code", code).select("code");
  return !error && Array.isArray(data) && data.length > 0;
}
