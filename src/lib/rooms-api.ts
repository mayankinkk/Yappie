import { getSupabase } from "./supabase";

export interface WatchedEntry {
  videoId: string;
  title?: string | null;
  at: number;
}

/** Host-mirrored playback position on the rooms row (resume after refresh). */
export interface PlaybackPosition {
  videoId: string;
  time: number;
  playing: boolean;
  updatedAt: number;
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
  playback?: PlaybackPosition | null;
  password_hash?: string | null;
  slow_mode_seconds?: number | null;
}

export interface QueueRow {
  id: string;
  videoId: string;
  title: string | null;
  addedBy: string;
  addedByName: string;
  addedAt: number;
  votes?: Record<string, boolean> | null;
}

export interface MembershipRow {
  room_code: string;
  user_id: string;
  display_name: string;
  banned: boolean;
  muted_until: string | null;
  kicked_until?: string | null;
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
  avatar?: string | null;
  text: string;
  created_at: string;
  reactions?: Record<string, string[]> | null;
}

export interface AuditRow {
  id: number;
  room_code: string;
  actor_id: string | null;
  actor_name: string;
  action: string;
  target_id: string | null;
  target_name: string | null;
  detail: string | null;
  created_at: string;
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
  if (msg.includes("kicked")) return new RoomError("kicked", "You were kicked from this room");
  if (msg.includes("locked")) return new RoomError("locked", "The room is locked right now");
  if (msg.includes("rate_limited")) return new RoomError("rate", "Slow down — rooms created too fast");
  if (msg.includes("queue_full")) return new RoomError("queue_full", "Queue is full (max 50)");
  if (msg.includes("already_queued")) return new RoomError("already", "Already in the queue");
  if (msg.includes("not_allowed")) {
    return new RoomError("not_allowed", "Only the host or the adder can remove that");
  }
  if (msg.includes("invalid_video") || msg.includes("invalid_item")) {
    return new RoomError("invalid", "Paste a valid YouTube link");
  }
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
  slowModeSeconds: number;
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
    slowModeSeconds: Number(row.p_slow_mode) || 0,
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

export async function kickMemberRpc(
  code: string,
  userId: string,
  minutes: number,
): Promise<void> {
  const supabase = getSupabase();
  if (!supabase) throw new RoomError("config", "Connect Supabase first");
  const { error } = await supabase.rpc("kick_member", {
    p_code: code,
    p_user_id: userId,
    p_minutes: minutes,
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

export interface VoteQueueResult {
  queue: QueueRow[];
  queueVersion: number;
}

export async function voteQueueRpc(code: string, itemId: string): Promise<VoteQueueResult> {
  const supabase = getSupabase();
  if (!supabase) throw new RoomError("config", "Connect Supabase first");
  const { data, error } = await supabase.rpc("vote_queue_item", {
    p_code: code,
    p_item_id: itemId,
  });
  if (error) throw mapError(rpcMsg(error));
  const raw = (data ?? {}) as { queue?: QueueRow[]; queueVersion?: number };
  return { queue: Array.isArray(raw.queue) ? raw.queue : [], queueVersion: raw.queueVersion ?? 0 };
}

function queueResult(data: unknown): VoteQueueResult {
  const raw = (data ?? {}) as { queue?: QueueRow[]; queueVersion?: number };
  return { queue: Array.isArray(raw.queue) ? raw.queue : [], queueVersion: raw.queueVersion ?? 0 };
}

/**
 * Server-authoritative add (0016): membership + duplicate + max checks and
 * `addedBy = auth.uid()` are enforced in Postgres, so the mutation works
 * without the host's browser and can't be spoofed. The rooms UPDATE echo
 * delivers the new queue to every member.
 */
export async function addQueueItemRpc(
  code: string,
  item: { id: string; videoId: string; title?: string | null; name?: string },
): Promise<VoteQueueResult> {
  const supabase = getSupabase();
  if (!supabase) throw new RoomError("config", "Connect Supabase first");
  const { data, error } = await supabase.rpc("add_queue_item", {
    p_code: code,
    p_item_id: item.id,
    p_video_id: item.videoId,
    p_title: item.title ?? null,
    p_name: item.name ?? null,
  });
  if (error) throw mapError(rpcMsg(error));
  return queueResult(data);
}

/** Server-authoritative remove (0016): host may remove any item, a member only their own. */
export async function removeQueueItemRpc(code: string, itemId: string): Promise<VoteQueueResult> {
  const supabase = getSupabase();
  if (!supabase) throw new RoomError("config", "Connect Supabase first");
  const { data, error } = await supabase.rpc("remove_queue_item", {
    p_code: code,
    p_item_id: itemId,
  });
  if (error) throw mapError(rpcMsg(error));
  return queueResult(data);
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
    playback?: PlaybackPosition | null;
    slow_mode_seconds?: number;
  },
): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  // .select() makes RLS denials visible: 0 rows affected → caller isn't the host.
  const { data, error } = await supabase.from("rooms").update(settings).eq("code", code).select("code");
  return !error && Array.isArray(data) && data.length > 0;
}
