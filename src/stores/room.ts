import { create } from "zustand";
import type {
  ChatMessage,
  FloatingReaction,
  Participant,
  PlayerAdapter,
  Profile,
  QueueItem,
  ReactionEvent,
  RoomSnapshot,
  ToastItem,
  Transport,
} from "../types";
import { getSupabase, isSupabaseConfigured } from "../lib/supabase";
import { extractVideoId, fetchVideoTitle } from "../lib/video-id";
import { rememberRoom } from "../lib/recent";
import { randomId } from "../lib/ids";
import { playSound } from "../lib/sound";
import { SyncEngine, computeExpectedTime } from "../sync/SyncEngine";
import {
  RoomError,
  claimHostRpc,
  createRoomRpc,
  heartbeatRpc,
  joinRoomRpc,
  leaveRoomRpc,
  moderateMemberRpc,
  kickMemberRpc,
  deleteChatMessageRpc,
  toggleChatReactionRpc,
  voteQueueRpc,
  saveRoomSettings,
  type AuditRow,
  type ChatRow,
  type JoinedRoom,
  type MembershipRow,
  type PlaybackPosition,
  type QueueRow,
  type RoomRow,
  type WatchedEntry,
} from "../lib/rooms-api";
import { ensureAuthed } from "./session";
import { MinGap, RateLimiter } from "../lib/ratelimit";
import { captureError } from "../lib/telemetry";

const CHAT_TRIM = 200;
const HEARTBEAT_MS = 20_000;
const QUEUE_MAX = 50;
const WATCHED_MAX = 30;
const MUTE_DEFAULT_SECONDS = 300;

// Sender-side budgets: drop our own excess before it hits the network.
const chatOut = new RateLimiter(5, 5000);
const chatOutGap = new MinGap(500);
const reactionOut = new RateLimiter(6, 3000);
const queueAddOut = new RateLimiter(6, 60_000);
const resyncOut = new RateLimiter(6, 10_000);
const voteOut = new RateLimiter(10, 10_000);

// Receiver-side budgets: drop other clients' excess on arrival. These defend
// against modified clients that skip the sender-side guards above.
const chatIn = new RateLimiter(5, 5000);
const reactionIn = new RateLimiter(8, 3000);
const queueAddIn = new RateLimiter(6, 60_000);
const toastGap = new MinGap(350);
const membersRefresh = new MinGap(10_000);

function isMuted(row: MembershipRow | undefined): boolean {
  return !!row?.muted_until && Date.parse(row.muted_until) > Date.now();
}

export interface AuditEntry {
  id: number;
  action: string;
  actorName: string;
  targetId: string | null;
  targetName: string | null;
  detail: string | null;
  createdAt: number;
}

function rowToChat(row: ChatRow): ChatMessage {
  return {
    id: clampText(row.id, 64) || randomId(),
    senderId: clampText(row.sender_id, 64),
    name: clampText(row.sender_name, 40) || "Guest",
    color: typeof row.color === "number" ? row.color : 30,
    avatar: clampText(row.avatar || "", 8),
    text: clampText(row.text, 500),
    ts: Date.parse(row.created_at) || Date.now(),
    reactions:
      row.reactions && typeof row.reactions === "object"
        ? Object.fromEntries(
            Object.entries(row.reactions).map(([emoji, ids]) => [
              emoji,
              Array.isArray(ids) ? ids.map(String) : [],
            ]),
          )
        : {},
  };
}

function rowToAudit(row: AuditRow): AuditEntry {
  return {
    id: Number(row.id) || 0,
    action: clampText(row.action, 32),
    actorName: clampText(row.actor_name, 40) || "Host",
    targetId: row.target_id ? clampText(row.target_id, 64) : null,
    targetName: row.target_name ? clampText(row.target_name, 40) : null,
    detail: row.detail ? clampText(row.detail, 80) : null,
    createdAt: Date.parse(row.created_at) || Date.now(),
  };
}

let transport: Transport | null = null;
let engine: SyncEngine | null = null;
let playerAdapter: PlayerAdapter | null = null;
/** Video id the local player was last told to show (engine or fallback). */
let localLoadedVideoId: string | null = null;
let upNextTimer: ReturnType<typeof setTimeout> | null = null;
let channelUnsubscribe: (() => void) | null = null;
let driftTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let presenceChannel: { track: (p: Record<string, unknown>) => Promise<string> } | null = null;
let presenceJoinedAt = 0;
let typingFlag = false;
let typingHeartbeat: ReturnType<typeof setInterval> | null = null;
let voiceFlag = false;
let voiceAnnounced: Set<string> | null = null;
let voiceSeeded = false;
let selfProfile: Profile | null = null;
let claimInFlight = false;
/** Last position the host mirrored to rooms.playback (seeded on join). */
let resumeRef: PlaybackPosition | null = null;
let playbackPersistTimer: ReturnType<typeof setInterval> | null = null;
let lastPlaybackPersistAt = 0;

/** Min gap between periodic host playback writes (explicit actions bypass). */
const PLAYBACK_PERSIST_MIN_GAP = 8_000;
const PLAYBACK_PERSIST_MS = 10_000;

/** How long a peer's "typing" state stays visible without a heartbeat refresh. */
const TYPING_TTL = 4_000;

interface RoomState {
  code: string | null;
  connection: "idle" | "connecting" | "connected" | "error";
  hostId: string;
  guestsCanControl: boolean;
  roomLocked: boolean;
  roomSlowMode: number;
  queueVersion: number;
  videoId: string | null;
  playing: boolean;
  queue: QueueItem[];
  watched: WatchedEntry[];
  titles: Record<string, string>;
  messages: ChatMessage[];
  unread: number;
  participants: Participant[];
  members: MembershipRow[];
  grantedTo: string[];
  pendingControl: { fromId: string; name: string; ts: number } | null;
  drift: number | null;
  floating: FloatingReaction[];
  toasts: ToastItem[];
  typing: Record<string, { name: string; at: number }>;
  upNext: { item: QueueItem; endsAt: number } | null;
  audit: AuditEntry[];
  /** Last chat text whose insert failed — restored into the composer. */
  failedChat: { text: string; nonce: number } | null;

  createRoom(profile: Profile, password?: string | null): Promise<void>;
  joinRoom(code: string, profile: Profile, password?: string | null): Promise<void>;
  leaveRoom(): void;
  attachPlayer(adapter: PlayerAdapter): void;
  loadMembers(): Promise<void>;
  loadChat(): Promise<void>;
  loadAudit(): Promise<void>;
  moderate(userId: string, opts: { banned?: boolean; muteSeconds?: number; kickMinutes?: number }): Promise<void>;
  setHost(userId: string): Promise<void>;
  approveControl(): Promise<void>;
  denyControl(): void;
  revokeControl(userId: string): Promise<void>;

  togglePlayback(): void;
  seekTo(time: number): void;
  loadVideo(input: string): Promise<void>;
  ensureTitle(videoId: string): void;
  resyncNow(): void;
  sendChat(text: string): void;
  deleteChatMessage(id: string): Promise<void>;
  reactToMessage(messageId: string, emoji: string): Promise<void>;
  setTyping(active: boolean): void;
  setVoicePresence(inVoice: boolean): void;
  react(emoji: string): void;
  addToQueue(input: string): Promise<void>;
  removeFromQueue(id: string): void;
  playFromQueue(id: string): void;
  moveQueue(from: number, to: number): void;
  voteQueue(itemId: string): Promise<void>;
  skipUpNext(): void;
  toggleGuestControls(): void;
  toggleRoomLock(): Promise<void>;
  setSlowMode(seconds: number): Promise<void>;
  requestControl(): void;
  markChatRead(): void;
  dismissFailedChat(): void;
  pushToast(text: string, kind?: ToastItem["kind"], opts?: Pick<ToastItem, "actions" | "ttlMs">): string;
  dismissToast(id: string): void;
  getProfile(): Profile | null;
}

function clampText(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

const titleInFlight = new Set<string>();

function pushMessage(
  set: (partial: Partial<RoomState>) => void,
  get: () => RoomState,
  msg: ChatMessage,
  incoming: boolean,
): void {
  const messages = [...get().messages, msg];
  if (messages.length > CHAT_TRIM) messages.splice(0, messages.length - CHAT_TRIM);
  set({ messages, unread: incoming ? get().unread + 1 : get().unread });
  if (incoming) playSound("message");
}

function toQueueItem(row: QueueRow): QueueItem {
  return {
    id: clampText(row.id, 64) || randomId(),
    videoId: clampText(row.videoId, 32),
    title: row.title ? clampText(row.title, 200) : null,
    addedBy: clampText(row.addedBy, 64),
    addedByName: clampText(row.addedByName, 40),
    addedAt: typeof row.addedAt === "number" ? row.addedAt : Date.now(),
    votes:
      row.votes && typeof row.votes === "object"
        ? Object.fromEntries(
            Object.entries(row.votes).filter(([id, v]) => id.length > 0 && v === true),
          )
        : {},
  };
}

// Best-effort membership close when the tab goes away (crash path is claim_host()).
function handlePageHide(): void {
  const code = useRoom.getState().code;
  if (code) {
    flushPlaybackNow();
    void leaveRoomRpc(code);
  }
}
if (typeof window !== "undefined") window.addEventListener("pagehide", handlePageHide);

export const useRoom = create<RoomState>((set, get) => {
  /** Server-authoritative room row → local state (RLS-backed; only ever the real host writes it). */
  function applyRoomRow(row: RoomRow, opts?: { forceQueue?: boolean }): void {
    const s = get();
    const next: Partial<RoomState> = {
      hostId: row.host_id,
      guestsCanControl: row.guests_can_control,
      roomLocked: !!row.locked,
      roomSlowMode:
        typeof row.slow_mode_seconds === "number" ? row.slow_mode_seconds : s.roomSlowMode,
      videoId: row.video_id ?? null,
      grantedTo: Array.isArray(row.granted_to) ? row.granted_to : [],
    };
    // Only adopt a queue that is genuinely newer: queue_version changes if
    // and only if the content changes, so an equal version keeps the same
    // array reference — playback-only room writes (every ~10s) then no
    // longer hand every member a fresh queue array to re-render.
    if (
      typeof row.queue_version === "number" &&
      (opts?.forceQueue || row.queue_version > s.queueVersion)
    ) {
      next.queue = (row.queue || []).map(toQueueItem);
      next.queueVersion = row.queue_version;
    }
    set(next);
    if (row.video_id !== s.videoId) {
      clearUpNext();
      engine?.requestSync();
      scheduleSelfSyncFallback(row.video_id);
    }
  }

  /**
   * Realtime broadcasts are NOT echoed back to their sender, and only a
   * trusted peer (host/granted) answers sync-request — so a client joining
   * alone (host, or anyone while the host is offline) would otherwise stare
   * at an empty player forever. Cue the local video as a fallback when no
   * trusted state arrives within ~900ms; an early remote answer always wins.
   */
  let selfSyncTimer: ReturnType<typeof setTimeout> | null = null;
  function scheduleSelfSyncFallback(videoId: string | null): void {
    if (selfSyncTimer) clearTimeout(selfSyncTimer);
    selfSyncTimer = null;
    if (!videoId) return;
    let tries = 0;
    const attempt = () => {
      selfSyncTimer = null;
      const s = get();
      if (!s.videoId || s.videoId !== videoId) return;
      if (localLoadedVideoId === videoId) return;
      if (playerAdapter?.isPlaying()) return;
      if (playerAdapter?.ready()) {
        localLoadedVideoId = videoId;
        const start = resumeStartSeconds(videoId);
        const resumePlaying = resumeShouldAutoplay(videoId);
        playerAdapter.load(videoId, start, resumePlaying);
        engine?.applyLoadedState({ videoId, time: start, playing: resumePlaying });
        return;
      }
      if (++tries < 20) selfSyncTimer = setTimeout(attempt, 500);
    };
    selfSyncTimer = setTimeout(attempt, 900);
  }

  /**
   * Host-only session watch history. Deduped against the most recent entry;
   * capped at WATCHED_MAX and persisted through the host-gated rooms UPDATE.
   */
  function recordWatched(videoId: string, title?: string | null): void {
    const s = get();
    if (!s.code || !selfProfile || s.hostId !== selfProfile.id) return;
    if (s.watched[0]?.videoId === videoId) return;
    const watched: WatchedEntry[] = [
      { videoId, title: title ? clampText(title, 200) : null, at: Date.now() },
      ...s.watched,
    ].slice(0, WATCHED_MAX);
    set({ watched });
    void saveRoomSettings(s.code, { watched });
  }

  /**
   * Per-videoId YouTube title cache (oEmbed, fetched at most once per id).
   * Seeds from the queue/watch history before hitting the network so the
   * now-playing header can render instantly when the title is already known.
   */
  function ensureTitle(videoId: string): void {
    if (!videoId || get().titles[videoId]) return;
    const known =
      get().queue.find((q) => q.videoId === videoId)?.title ||
      get().watched.find((w) => w.videoId === videoId)?.title;
    if (known) {
      set((s) => ({ titles: { ...s.titles, [videoId]: known } }));
      return;
    }
    if (titleInFlight.has(videoId)) return;
    titleInFlight.add(videoId);
    void fetchVideoTitle(videoId).then((title) => {
      titleInFlight.delete(videoId);
      if (title) set((s) => ({ titles: { ...s.titles, [videoId]: title } }));
    });
  }

  /**
   * Host-only persistence of room settings/queue. The UPDATE itself is RLS-gated
   * to host_id in Postgres — a modified client fails here with 0 rows affected.
   * Broadcast snapshot still goes out so everyone gets playback time immediately.
   */
  async function publishSnapshot(): Promise<void> {
    const s = get();
    if (!engine || !s.code || s.hostId !== selfProfile?.id) return;
    const version = s.queueVersion + 1;
    const ok = await saveRoomSettings(s.code, {
      queue: s.queue as unknown as QueueRow[],
      queue_version: version,
      guests_can_control: s.guestsCanControl,
      locked: s.roomLocked,
      video_id: s.videoId,
      playback: currentPlayback(),
    });
    if (!ok) {
      const supabase = getSupabase();
      if (supabase) {
        const { data } = await supabase
          .from("rooms")
          .select("*")
          .eq("code", s.code)
          .maybeSingle();
        // RLS rejected our write — the server row is truth even at an equal
        // queue_version (our local queue may be ahead of what landed).
        if (data) applyRoomRow(data as RoomRow, { forceQueue: true });
      }
      get().pushToast("Only the host can change the room", "error");
      return;
    }
    set({ queueVersion: version });
    engine.sendSnapshot({
      hostId: s.hostId,
      guestsCanControl: s.guestsCanControl,
      queue: get().queue,
      version,
    });
  }

  function applySnapshot(payload: RoomSnapshot): void {
    const s = get();
    if (!payload || typeof payload.sentAt !== "number") return;
    // Settings (queue/permissions/host) only ever come from Postgres rows now;
    // broadcasts carry playback state and must come from the server-known host.
    if (s.hostId && payload.senderId !== s.hostId) return;
    set({ videoId: payload.videoId || null, playing: payload.playing });
  }

  function handleQueueAdd(item: QueueItem): void {
    const s = get();
    if (selfProfile?.id !== s.hostId) return;
    if (!item.videoId || !/^[\w-]{11}$/.test(item.videoId)) return;
    if (s.queue.some((q) => q.videoId === item.videoId)) return;
    if (s.queue.length >= QUEUE_MAX) return;
    set({ queue: [...s.queue, item] });
    void publishSnapshot();
  }

  function handleQueueRemove(payload: { id?: string; by?: string }): void {
    const s = get();
    if (selfProfile?.id !== s.hostId) return;
    const id = typeof payload.id === "string" ? payload.id : "";
    if (!id) return;
    const item = s.queue.find((q) => q.id === id);
    if (!item) return;
    if (payload.by && payload.by !== item.addedBy && payload.by !== s.hostId) return;
    set({ queue: s.queue.filter((q) => q.id !== id) });
    void publishSnapshot();
  }

  /**
   * Every client detects ENDED locally (players stay in sync), so all of
   * them show the same 5s "Up next" countdown derived from queue[0]; only
   * the host actually advances (timer or "Play now"), and the resulting
   * video change clears everyone else's overlay.
   */
  function handleEnded(): void {
    startUpNext();
  }

  function startUpNext(): void {
    const s = get();
    if (s.upNext || !s.queue.length) return;
    // Upvote-to-play: most votes wins when the video ends; ties keep queue order.
    let best = s.queue[0];
    for (const item of s.queue) {
      if (Object.keys(item.votes).length > Object.keys(best.votes).length) best = item;
    }
    set({ upNext: { item: best, endsAt: Date.now() + 5000 } });
    upNextTimer = setTimeout(() => {
      upNextTimer = null;
      advanceFromQueue();
    }, 5200);
  }

  function clearUpNext(): void {
    if (upNextTimer) clearTimeout(upNextTimer);
    upNextTimer = null;
    if (get().upNext) set({ upNext: null });
  }

  /** Host: play the item the overlay announced (falls back to queue head). */
  function advanceFromQueue(): void {
    const shown = get().upNext?.item ?? null;
    clearUpNext();
    const s = get();
    if (!selfProfile || selfProfile.id !== s.hostId || !engine) return;
    const list = s.queue.slice();
    const idx = shown ? list.findIndex((q) => q.id === shown.id) : -1;
    let next: QueueItem;
    if (idx >= 0) next = list.splice(idx, 1)[0];
    else if (list.length) next = list.splice(0, 1)[0];
    else return;
    set({ queue: list });
    engine.localLoad(next.videoId, true);
    recordWatched(next.videoId, next.title);
    get().pushToast(`Up next: ${next.title || "video"}`);
    persistPlayback({ force: true });
    void publishSnapshot();
  }

  /**
   * Deterministic, server-checked host handoff. Fires when presence says the
   * host is gone; Postgres decides whether the claim is legal (host stale +
   * caller is the senior online member) and notifies everyone via the rooms row.
   */
  async function attemptClaim(): Promise<void> {
    const s = get();
    if (!s.code || !selfProfile || s.hostId === selfProfile.id) return;
    if (claimInFlight) return;
    if (s.participants.length === 0) return;
    if (s.participants.some((p) => p.id === s.hostId)) return;
    claimInFlight = true;
    try {
      const won = await claimHostRpc(s.code);
      if (!won && get().hostId !== selfProfile.id) {
        const stillGone = !get().participants.some((p) => p.id === get().hostId);
        if (stillGone && get().code) setTimeout(() => void attemptClaim(), 6000);
      }
    } finally {
      claimInFlight = false;
    }
  }

  function connect(code: string, profile: Profile): Promise<void> {
    const supabase = getSupabase();
    if (!supabase) return Promise.reject(new Error("Supabase not configured"));

    selfProfile = profile;
    set({ connection: "connecting" });
    presenceJoinedAt = Date.now();
    const channel = supabase.channel(`yappie-v2-${code}`, {
      config: { presence: { key: profile.id } },
    });
    presenceChannel = channel;

    const t: Transport = {
      async send(event, payload) {
        await channel.send({ type: "broadcast", event, payload } as never);
      },
      on(event, cb) {
        channel.on("broadcast", { event }, (msg) => cb(msg.payload));
      },
    };
    transport = t;

    engine = new SyncEngine({
      transport: t,
      player: {
        ready: () => playerAdapter?.ready() ?? false,
      load: (v, t, a) => {
        localLoadedVideoId = v;
        playerAdapter?.load(v, t, a);
      },
        play: () => playerAdapter?.play(),
        pause: () => playerAdapter?.pause(),
        seek: (t) => playerAdapter?.seek(t),
        getTime: () => playerAdapter?.getTime() ?? 0,
        isPlaying: () => playerAdapter?.isPlaying() ?? false,
        getState: () => playerAdapter?.getState?.() ?? null,
        setMuted: (m) => playerAdapter?.setMuted(m),
        setVolume: (v) => playerAdapter?.setVolume(v),
        setCaptionsEnabled: (on) => playerAdapter?.setCaptionsEnabled(on),
        destroy: () => {},
        onLocalEvent: () => {},
      },
      getRole: () => ({
        selfId: profile.id,
        selfName: profile.name,
        hostId: get().hostId,
        guestsCanControl: get().guestsCanControl,
        grantedTo: get().grantedTo,
      }),
      getVideoId: () => get().videoId,
      onLocalState: (s) => set({ videoId: s.videoId, playing: s.playing }),
      onRemoteAction: (text) => {
        get().pushToast(text);
        playSound("control");
      },
      onDenied: () => get().pushToast("Only the host can control playback", "error"),
      onControlRequested: (name, senderId) => {
        const clean = clampText(name || "Someone", 40);
        get().pushToast(`${clean} is asking to control playback`);
        const s = get();
        if (selfProfile && s.hostId === selfProfile.id) {
          const from = senderId
            ? s.participants.find((p) => p.id === senderId)
            : s.participants.find((p) => p.name === clean);
          set({ pendingControl: { fromId: from?.id || senderId || "", name: clean, ts: Date.now() } });
          setTimeout(() => {
            const p = get().pendingControl;
            if (p && Date.now() - p.ts >= 15_000) set({ pendingControl: null });
          }, 15_500);
        }
      },
      onEnded: handleEnded,
    });
    engine.start();

    t.on("snapshot", (payload) => applySnapshot(payload as RoomSnapshot));

    t.on("sync-request", () => {
      if (selfProfile?.id === get().hostId) {
        setTimeout(
          () => publishSnapshot(),
          60 + Math.random() * 200,
        );
      }
    });

    // Chat arrives via the database (durable, rate-limited, RLS-checked) —
    // the same channel streams INSERTs as it once did broadcasts.
    channel.on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "chat_messages", filter: `room_code=eq.${code}` },
      (payload) => {
        const row = payload.new as ChatRow | null;
        if (!row) return;
        if (row.sender_id === profile.id) {
          // Local echo was already added optimistically — dedupe by id.
          if (get().messages.some((m) => m.id === row.id)) return;
        }
        const member = get().members.find((m) => m.user_id === row.sender_id);
        if (member && member.banned) return;
        if (!chatIn.allow(String(row.sender_id || "?"))) return;
        pushMessage(set, get, rowToChat(row), row.sender_id !== profile.id);
      },
    );
    // Host moderation: message deleted server-side → drop it everywhere.
    channel.on(
      "postgres_changes",
      { event: "DELETE", schema: "public", table: "chat_messages", filter: `room_code=eq.${code}` },
      (payload) => {
        const old = payload.old as { id?: string } | null;
        if (!old?.id) return;
        set((s) => ({ messages: s.messages.filter((m) => m.id !== old.id) }));
      },
    );
    // Audit log: moderation entries stream to the host (RLS only delivers
    // rows the subscriber may read, so guests never see this fire).
    channel.on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "room_audit", filter: `room_code=eq.${code}` },
      (payload) => {
        const row = payload.new as AuditRow | null;
        if (!row) return;
        const entry = rowToAudit(row);
        set((s) => ({ audit: [entry, ...s.audit.filter((e) => e.id !== entry.id)].slice(0, 30) }));
      },
    );
    // Reaction toggles arrive as row updates (only reactions ever change).
    channel.on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "chat_messages", filter: `room_code=eq.${code}` },
      (payload) => {
        const row = payload.new as ChatRow | null;
        if (!row?.id) return;
        const reactions =
          row.reactions && typeof row.reactions === "object" ? row.reactions : {};
        set((s) => ({
          messages: s.messages.map((m) => (m.id === row.id ? { ...m, reactions } : m)),
        }));
      },
    );

    t.on("reaction", (payload) => {
      const p = payload as ReactionEvent | null;
      if (!p || p.senderId === profile.id) return;
      const member = get().members.find((m) => m.user_id === p.senderId);
      if (member && (member.banned || isMuted(member))) return;
      if (!reactionIn.allow(String(p.senderId || "?"))) return;
      addFloating(set, get, {
        id: clampText(p.id, 64) || randomId(),
        senderId: clampText(p.senderId, 64),
        name: clampText(p.name, 40),
        emoji: clampText(p.emoji, 8),
        ts: typeof p.ts === "number" ? p.ts : Date.now(),
      });
      playSound("reaction");
    });

    t.on("queue-add", (payload) => {
      const p = payload as QueueItem | null;
      if (!p) return;
      if (!queueAddIn.allow(String(p.addedBy || "?"))) return;
      handleQueueAdd({
        id: clampText(p.id, 64) || randomId(),
        videoId: clampText(p.videoId, 32),
        title: p.title ? clampText(p.title, 200) : null,
        addedBy: clampText(p.addedBy, 64),
        addedByName: clampText(p.addedByName, 40),
        addedAt: typeof p.addedAt === "number" ? p.addedAt : Date.now(),
        votes: {},
      });
    });
    t.on("queue-remove", (payload) => handleQueueRemove(payload as { id?: string; by?: string }));

    // Server state: host_id, permissions, queue, bans — everything durable.
    channel.on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "rooms", filter: `code=eq.${code}` },
      (payload) => {
        const row = payload.new as RoomRow | null;
        if (row?.code === code) applyRoomRow(row);
      },
    );
    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "room_members", filter: `room_code=eq.${code}` },
      (payload) => {
        const row = (payload.new ?? payload.old) as MembershipRow | null;
        if (!row || row.room_code !== code) return;
        const members = [...get().members];
        const idx = members.findIndex((m) => m.user_id === row.user_id);
        if (payload.eventType === "DELETE") {
          if (idx >= 0) members.splice(idx, 1);
          set({ members });
          return;
        }
        if (idx >= 0) members[idx] = row;
        else members.push(row);
        set({ members });
        if (row.user_id === profile.id && row.banned) {
          get().pushToast("You were banned from this room", "error");
          setTimeout(() => get().leaveRoom(), 500);
        }
        if (
          row.user_id === profile.id &&
          row.kicked_until &&
          Date.parse(row.kicked_until) > Date.now()
        ) {
          get().pushToast("You were kicked from this room", "error");
          setTimeout(() => get().leaveRoom(), 500);
        }
      },
    );

    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState();
      const list: Participant[] = [];
      const typingMap: Record<string, { name: string; at: number }> = {};
      const now = Date.now();
      for (const key of Object.keys(state)) {
        const p = state[key][0] as unknown as
          | {
              name?: string;
              color?: number;
              joinedAt?: number;
              typingAt?: number;
              avatar?: string;
              inVoice?: boolean;
            }
          | undefined;
        if (!p) continue;
        if (
          typeof p.typingAt === "number" &&
          p.typingAt > 0 &&
          now - p.typingAt < TYPING_TTL &&
          key !== profile.id
        ) {
          typingMap[key] = { name: p.name || "Guest", at: p.typingAt };
        }
        // "X joined voice" — announced once per voice session so people who
        // haven't joined voice still learn it's happening. The first sync
        // seeds silently (they were already in voice when we arrived).
        if (key !== profile.id) {
          if (!voiceAnnounced) voiceAnnounced = new Set();
          if (p.inVoice === true) {
            if (!voiceSeeded) voiceAnnounced.add(key);
            else if (!voiceAnnounced.has(key)) {
              voiceAnnounced.add(key);
              get().pushToast(`${p.name || "Someone"} joined voice`);
            }
          } else {
            voiceAnnounced.delete(key);
          }
        }
        list.push({
          id: key,
          name: p.name || "Guest",
          color: typeof p.color === "number" ? p.color : 30,
          joinedAt: p.joinedAt || Date.now(),
          avatar: typeof p.avatar === "string" ? p.avatar : "",
        });
      }
      voiceSeeded = true;
      set({ typing: typingMap });
      const prev = get().participants;
      const prevIds = new Set(prev.map((x) => x.id));
      const prevNames = new Map(prev.map((x) => [x.id, x.name]));

      for (const person of list) {
        if (!prevIds.has(person.id) && prev.length > 0 && person.id !== profile.id) {
          get().pushToast(`${person.name} joined`);
          playSound("join");
        }
      }
      for (const person of prev) {
        if (!list.some((x) => x.id === person.id)) {
          get().pushToast(`${prevNames.get(person.id) || "Someone"} left`);
          playSound("leave");
        }
      }

      if (!list.some((x) => x.id === profile.id)) {
        list.push({
          id: profile.id,
          name: profile.name,
          color: profile.color,
          joinedAt: Date.now(),
          avatar: profile.avatar || "",
        });
      }
      set({ participants: list });

      // Host missing from presence → let Postgres arbitrate the handoff.
      const current = get();
      if (current.hostId && current.hostId !== profile.id && !list.some((x) => x.id === current.hostId)) {
        setTimeout(() => void attemptClaim(), 3000);
      }
      // Roster data (mute/ban badges) can drift if realtime DELETEs are filtered
      // by RLS — refresh opportunistically, at most every 10s.
      if (membersRefresh.allow("members")) void get().loadMembers();
    });

    return new Promise((resolve, reject) => {
      let settled = false;
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          set({ connection: "connected" });
          void channel.track({
            name: profile.name,
            color: profile.color,
            avatar: profile.avatar || "",
            joinedAt: presenceJoinedAt,
            inVoice: voiceFlag,
          });
          void get().loadMembers();
          void get().loadChat();
          void get().loadAudit();
          engine?.requestSync();
          scheduleSelfSyncFallback(get().videoId);
          if (!settled) {
            settled = true;
            resolve();
          }
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          set({ connection: "error" });
          captureError(new Error(`realtime_${status}`), { room: code });
          if (!settled) {
            settled = true;
            reject(new Error(status));
          }
        }
      });
      channelUnsubscribe = () => {
        try {
          channel.unsubscribe();
        } catch {
          /* already left */
        }
      };
    });
  }

  return {
    code: null,
    connection: "idle",
    hostId: "",
    guestsCanControl: true,
    roomLocked: false,
    roomSlowMode: 0,
    queueVersion: 0,
    videoId: null,
    playing: false,
    queue: [],
    watched: [],
    titles: {},
    messages: [],
    unread: 0,
    participants: [],
    members: [],
    grantedTo: [],
    pendingControl: null,
    drift: null,
    floating: [],
    toasts: [],
    typing: {},
    upNext: null,
    audit: [],
    failedChat: null,

    async loadMembers() {
      const s = get();
      const supabase = getSupabase();
      if (!s.code || !supabase) return;
      const { data } = await supabase
        .from("room_members")
        .select("*")
        .eq("room_code", s.code);
      if (data && get().code === s.code) set({ members: data as MembershipRow[] });
    },

    async loadChat() {
      const s = get();
      const supabase = getSupabase();
      if (!s.code || !supabase) return;
      const { data } = await supabase
        .from("chat_messages")
        .select("*")
        .eq("room_code", s.code)
        .order("created_at", { ascending: false })
        .limit(CHAT_TRIM);
      if (!data || get().code !== s.code) return;
      const history = (data as ChatRow[]).map(rowToChat).reverse();
      const seen = new Set(get().messages.map((m) => m.id));
      const merged = [...history.filter((m) => !seen.has(m.id)), ...get().messages];
      set({ messages: merged.slice(-CHAT_TRIM) });
    },

    async loadAudit() {
      const s = get();
      const supabase = getSupabase();
      if (!s.code || !supabase || !isHostNow()) return;
      const { data } = await supabase
        .from("room_audit")
        .select("id, action, actor_name, target_id, target_name, detail, created_at")
        .eq("room_code", s.code)
        .order("created_at", { ascending: false })
        .limit(30);
      if (!data || get().code !== s.code) return;
      set({ audit: (data as AuditRow[]).map(rowToAudit) });
    },

    async moderate(userId, opts) {
      const s = get();
      if (!s.code) return;
      try {
        if (typeof opts.kickMinutes === "number") {
          await kickMemberRpc(s.code, userId, opts.kickMinutes);
          get().pushToast(`Kicked for ${opts.kickMinutes} min`);
          await get().loadMembers();
          return;
        }
        await moderateMemberRpc(s.code, userId, opts);
        if (opts.banned === true) get().pushToast("Banned from the room");
        else if (opts.banned === false) get().pushToast("Unbanned");
        else if (opts.muteSeconds === 0) get().pushToast("Mute lifted");
        else get().pushToast(`Muted for ${Math.round((opts.muteSeconds ?? MUTE_DEFAULT_SECONDS) / 60)} min`);
        await get().loadMembers();
      } catch (e) {
        get().pushToast(e instanceof RoomError ? e.message : "Couldn't update that member", "error");
      }
    },

    async setHost(userId) {
      const s = get();
      if (!s.code) return;
      const ok = await saveRoomSettings(s.code, { host_id: userId });
      if (ok) get().pushToast("Host transferred");
      else get().pushToast("Only the host can transfer hosting", "error");
    },

    async approveControl() {
      const s = get();
      const target = s.pendingControl?.fromId;
      if (!s.code || !target) {
        set({ pendingControl: null });
        return;
      }
      const granted = Array.from(new Set([...s.grantedTo, target]));
      const ok = await saveRoomSettings(s.code, { granted_to: granted });
      if (ok) {
        set({ pendingControl: null });
        get().pushToast(`Granted playback control to ${s.pendingControl?.name ?? "guest"}`);
      } else {
        get().pushToast("Only the host can grant control", "error");
      }
    },

    denyControl() {
      set({ pendingControl: null });
    },

    async revokeControl(userId) {
      const s = get();
      if (!s.code) return;
      const granted = s.grantedTo.filter((id) => id !== userId);
      const ok = await saveRoomSettings(s.code, { granted_to: granted });
      if (ok) get().pushToast("Revoked playback control");
      else get().pushToast("Only the host can revoke control", "error");
    },

    async createRoom(profile, password) {
      if (!isSupabaseConfigured()) {
        get().pushToast("Connect Supabase in settings first", "error");
        throw new RoomError("config", "Connect Supabase first", true);
      }
      const p = (await ensureAuthed()) || profile;
      let code: string;
      try {
        code = await createRoomRpc(password ?? null, p.name);
      } catch (e) {
        const err = e instanceof RoomError ? e : new RoomError("unknown", "Couldn't create the room");
        if (!err.silent) get().pushToast(err.message, "error");
        throw new RoomError(err.code, err.message, true);
      }
      get().pushToast(`Room ${code} created`);
      await get().joinRoom(code, p, password ?? null);
    },

    async joinRoom(code, profile, password) {
      if (!isSupabaseConfigured()) {
        get().pushToast("Connect Supabase in settings first", "error");
        throw new RoomError("config", "Connect Supabase first", true);
      }
      const p = (await ensureAuthed()) || profile;
      get().leaveRoom();

      let joined: JoinedRoom;
      try {
        joined = await joinRoomRpc(code, password ?? null, p.name);
      } catch (e) {
        const err = e instanceof RoomError ? e : new RoomError("unknown", "Couldn't join the room");
        if (!err.silent) get().pushToast(err.message, "error");
        throw new RoomError(err.code, err.message, true);
      }

      // Watch history + resume position live on the rooms row (members can
      // SELECT). Fetched as two queries on purpose: `playback` only exists
      // after migration 0015, and one joint select would fail wholesale on an
      // unapplied schema — taking the history down with it.
      let watched: WatchedEntry[] = [];
      let playback: PlaybackPosition | null = null;
      const supabase = getSupabase();
      if (supabase) {
        try {
          const res = await supabase.from("rooms").select("watched").eq("code", code).maybeSingle();
          if (Array.isArray(res?.data?.watched)) watched = res.data.watched as WatchedEntry[];
        } catch {
          /* history is non-essential */
        }
        try {
          const res = await supabase.from("rooms").select("playback").eq("code", code).maybeSingle();
          const pb = res?.data?.playback as PlaybackPosition | null | undefined;
          if (pb && typeof pb.videoId === "string" && typeof pb.time === "number") {
            playback = {
              videoId: pb.videoId,
              time: Math.max(0, pb.time),
              playing: !!pb.playing,
              updatedAt: typeof pb.updatedAt === "number" ? pb.updatedAt : 0,
            };
            // Stale position from a different video — ignore it.
            if (joined.videoId && playback.videoId !== joined.videoId) playback = null;
          }
        } catch {
          /* resume is non-essential (column lands with 0015) */
        }
      }
      resumeRef = playback;

      set({
        code,
        connection: "connecting",
        hostId: joined.hostId,
        guestsCanControl: joined.guestsCanControl,
        roomLocked: joined.locked,
        roomSlowMode: joined.slowModeSeconds,
        queue: joined.queue.map(toQueueItem),
        queueVersion: joined.queueVersion,
        videoId: joined.videoId,
        grantedTo: joined.grantedTo || [],
        pendingControl: null,
        watched,
        titles: {},
        playing: false,
        messages: [],
        unread: 0,
        participants: [],
        members: [],
        floating: [],
        typing: {},
        upNext: null,
        audit: [],
        failedChat: null,
      });
      selfProfile = p;
      await connect(code, p);
      rememberRoom(code);
      const url = new URL(location.href);
      url.searchParams.set("room", code);
      history.replaceState(null, "", url);
      document.title = `Yappie · ${code}`;
      driftTimer = setInterval(() => {
        engine?.tick();
        set({ drift: engine?.getLastDrift() ?? null });
      }, 5000);
      void heartbeatRpc(code);
      heartbeatTimer = setInterval(() => void heartbeatRpc(code), HEARTBEAT_MS);
      if (playbackPersistTimer) clearInterval(playbackPersistTimer);
      playbackPersistTimer = setInterval(() => persistPlayback(), PLAYBACK_PERSIST_MS);
    },

    leaveRoom() {
      const code = get().code;
      if (code) void leaveRoomRpc(code);
      if (driftTimer) clearInterval(driftTimer);
      driftTimer = null;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      if (playbackPersistTimer) clearInterval(playbackPersistTimer);
      playbackPersistTimer = null;
      resumeRef = null;
      if (typingHeartbeat) clearInterval(typingHeartbeat);
      typingHeartbeat = null;
      typingFlag = false;
      voiceFlag = false;
      voiceAnnounced = null;
      voiceSeeded = false;
      presenceChannel = null;
      presenceJoinedAt = 0;
      channelUnsubscribe?.();
      channelUnsubscribe = null;
      engine?.destroy();
      engine = null;
      transport = null;
      playerAdapter = null;
      selfProfile = null;
      set({
        code: null,
        connection: "idle",
        hostId: "",
        roomLocked: false,
        roomSlowMode: 0,
        videoId: null,
        playing: false,
        queue: [],
        watched: [],
        messages: [],
        unread: 0,
        participants: [],
        members: [],
        grantedTo: [],
        pendingControl: null,
        drift: null,
        floating: [],
        typing: {},
        upNext: null,
        audit: [],
        failedChat: null,
      });
      const url = new URL(location.href);
      url.searchParams.delete("room");
      history.replaceState(null, "", url);
      document.title = "Yappie — Watch YouTube together";
    },

    attachPlayer(adapter) {
      playerAdapter = adapter;
      localLoadedVideoId = null;
      adapter.onLocalEvent((e) => {
        if (e.type === "ended") {
          engine?.handlePlayerEnded();
        } else if (e.type === "error") {
          get().pushToast("This video can't be played here", "error");
        } else if (e.type === "ready") {
          // A sync answer may have arrived while the iframe was still warming
          // up — the engine held it; apply it now that the player can take it.
          engine?.flushPendingRemote();
        }
      });
      engine?.requestSync();
      scheduleSelfSyncFallback(get().videoId);
    },

    togglePlayback() {
      const s = get();
      if (!s.videoId || !playerAdapter) return;
      if (playerAdapter.isPlaying()) engine?.localPause();
      else engine?.localPlay();
      persistPlayback({ force: true });
    },

    seekTo(time) {
      if (!get().videoId) return;
      engine?.localSeek(time);
      persistPlayback({ force: true });
    },

    /**
     * Local catch-up to the host's expected position (and play/pause state).
     * The engine auto-corrects mid-playback drift, but tick() bails when the
     * local player is paused while the host expects playback — this fixes
     * that class of stall, and anything else the viewer can feel.
     */
    resyncNow() {
      if (!engine || !playerAdapter?.ready()) return;
      if (!resyncOut.allow("resync")) return;
      const ref = engine.getLocalRef();
      if (!ref.videoId) return;
      const expected = ref.playing ? computeExpectedTime(ref, Date.now()) : ref.time;
      playerAdapter.seek(expected);
      if (ref.playing && !playerAdapter.isPlaying()) playerAdapter.play();
      else if (!ref.playing && playerAdapter.isPlaying()) playerAdapter.pause();
      set({ drift: 0 });
    },

    ensureTitle,

    async loadVideo(input) {
      const id = extractVideoId(input);
      if (!id) {
        get().pushToast("Paste a valid YouTube link", "error");
        return;
      }
      const s = get();
      const isController = canControlNow();
      if (!isController) {
        await get().addToQueue(id);
        get().pushToast("Only the host plays videos — added to the queue instead");
        return;
      }
      engine?.localLoad(id, true);
      clearUpNext();
      if (selfProfile?.id === s.hostId && s.code) {
        void saveRoomSettings(s.code, { video_id: id });
        void fetchVideoTitle(id).then((title) => recordWatched(id, title));
      }
      persistPlayback({ force: true });
    },

    sendChat(text) {
      const profile = selfProfile;
      const s = get();
      const supabase = getSupabase();
      if (!profile || !s.code || !supabase || !text.trim()) return;
      const selfMember = s.members.find((m) => m.user_id === profile.id);
      // Blocked sends hand the text back to the composer (submit already
      // cleared it) so nothing typed is ever silently dropped.
      const restore = () => set({ failedChat: { text: text.trim().slice(0, 500), nonce: Date.now() } });
      if (isMuted(selfMember)) {
        get().pushToast("You're muted", "error");
        restore();
        return;
      }
      if (s.roomSlowMode > 0) {
        let lastOwn = 0;
        for (let i = s.messages.length - 1; i >= 0; i--) {
          if (s.messages[i].senderId === profile.id) {
            lastOwn = s.messages[i].ts;
            break;
          }
        }
        const waitMs = s.roomSlowMode * 1000 - (Date.now() - lastOwn);
        if (waitMs > 0) {
          get().pushToast(`Slow mode — wait ${Math.ceil(waitMs / 1000)}s`, "error");
          restore();
          return;
        }
      }
      if (!chatOut.allow(profile.id) || !chatOutGap.allow(profile.id)) {
        get().pushToast("You're messaging too fast", "error");
        restore();
        return;
      }
      const msg: ChatMessage = {
        id: randomId(),
        senderId: profile.id,
        name: profile.name,
        color: profile.color,
        avatar: profile.avatar || "",
        text: text.trim().slice(0, 500),
        ts: Date.now(),
        reactions: {},
      };
      void supabase
        .from("chat_messages")
        .insert({
          id: msg.id,
          room_code: s.code,
          sender_id: msg.senderId,
          sender_name: msg.name,
          color: msg.color,
          avatar: msg.avatar,
          text: msg.text,
        })
        .then(({ error }: { error: { message?: string } | null }) => {
          if (!error) {
            // The realtime INSERT can beat this HTTP response — only echo if
            // the websocket path hasn't already delivered the same row.
            if (!get().messages.some((m) => m.id === msg.id)) pushMessage(set, get, msg, false);
            return;
          }
          if (String(error.message || "").includes("chat_rate_limited")) {
            get().pushToast("You're messaging too fast", "error");
          } else if (String(error.message || "").includes("muted_until")) {
            get().pushToast("You're muted", "error");
          } else {
            get().pushToast("Message not sent", "error");
          }
          // Give the text back to the composer so a failed send (or a
          // refresh mid-insert) never silently eats what the user typed.
          set({ failedChat: { text: msg.text, nonce: Date.now() } });
        });
    },

    /**
     * Host-only chat moderation. Optimistically drops the message locally;
     * the server-side DELETE streams a realtime DELETE event to everyone else.
     */
    async deleteChatMessage(id) {
      const s = get();
      const profile = selfProfile;
      if (!profile || !s.code || s.hostId !== profile.id) return;
      set({ messages: s.messages.filter((m) => m.id !== id) });
      try {
        await deleteChatMessageRpc(s.code, id);
      } catch {
        get().pushToast("Couldn't delete the message", "error");
      }
    },

    /**
     * Toggle own reaction on a chat message. The RPC returns the message's
     * full post-toggle reactions map, which we apply locally; other members
     * get the same state via the chat_messages UPDATE event.
     */
    async reactToMessage(messageId, emoji) {
      const s = get();
      const profile = selfProfile;
      const clean = emoji.slice(0, 8);
      if (!profile || !s.code || !clean) return;
      if (!reactionOut.allow(`msg-${profile.id}`)) return;
      try {
        const reactions = await toggleChatReactionRpc(s.code, messageId, clean);
        set((state) => ({
          messages: state.messages.map((m) => (m.id === messageId ? { ...m, reactions } : m)),
        }));
      } catch {
        /* not_found (deleted meanwhile) or not_member — drop silently */
      }
    },

    /**
     * Publishes "I'm typing" through presence metadata. Re-track happens only
     * on idle->typing / typing->idle transitions (keystrokes don't churn
     * presence); while active, a 2s heartbeat refreshes typingAt so peers'
     * TTL doesn't expire mid-sentence.
     */
    setTyping(active) {
      if (!selfProfile || !get().code || !presenceChannel) return;
      if (typingFlag === active) return;
      typingFlag = active;
      const payload = () => ({
        name: selfProfile!.name,
        color: selfProfile!.color,
        avatar: selfProfile!.avatar || "",
        joinedAt: presenceJoinedAt,
        typingAt: active ? Date.now() : 0,
        inVoice: voiceFlag,
      });
      void presenceChannel.track(payload());
      if (active) {
        if (!typingHeartbeat) {
          typingHeartbeat = setInterval(() => {
            if (!typingFlag || !selfProfile || !presenceChannel) return;
            void presenceChannel.track({
              name: selfProfile.name,
              color: selfProfile.color,
              avatar: selfProfile.avatar || "",
              joinedAt: presenceJoinedAt,
              typingAt: Date.now(),
              inVoice: voiceFlag,
            });
          }, 2000);
        }
      } else if (typingHeartbeat) {
        clearInterval(typingHeartbeat);
        typingHeartbeat = null;
      }
    },

    /**
     * Publishes "I'm in voice" through presence so peers who haven't joined
     * voice still see "X joined voice" — the only signal that makes people
     * realize voice is happening. One re-track per transition; the typing
     * heartbeat also carries the flag so it isn't wiped between transitions.
     */
    setVoicePresence(inVoice) {
      if (!selfProfile || !get().code || !presenceChannel) return;
      if (voiceFlag === inVoice) return;
      voiceFlag = inVoice;
      void presenceChannel.track({
        name: selfProfile.name,
        color: selfProfile.color,
        avatar: selfProfile.avatar || "",
        joinedAt: presenceJoinedAt,
        typingAt: typingFlag ? Date.now() : 0,
        inVoice,
      });
    },

    react(emoji) {
      const profile = selfProfile;
      if (!profile || !transport) return;
      const selfMember = get().members.find((m) => m.user_id === profile.id);
      if (isMuted(selfMember)) return;
      if (!reactionOut.allow(profile.id)) return;
      const event: ReactionEvent = {
        id: randomId(),
        senderId: profile.id,
        name: profile.name,
        emoji: emoji.slice(0, 8),
        ts: Date.now(),
      };
      void transport.send("reaction", event);
      addFloating(set, get, event);
    },

    async addToQueue(input) {
      const id = extractVideoId(input);
      if (!id) {
        get().pushToast("Paste a valid YouTube link", "error");
        return;
      }
      const profile = selfProfile;
      const s = get();
      if (!profile || !transport) return;
      if (s.queue.some((q) => q.videoId === id) || s.videoId === id) {
        get().pushToast("Already in the queue");
        return;
      }
      const item: QueueItem = {
        id: randomId(),
        videoId: id,
        title: null,
        addedBy: profile.id,
        addedByName: profile.name,
        addedAt: Date.now(),
        votes: {},
      };
      if (s.hostId === profile.id) {
        if (s.queue.length >= QUEUE_MAX) {
          get().pushToast("Queue is full (max 50)", "error");
          return;
        }
        set({ queue: [...s.queue, item] });
        void publishSnapshot();
        get().pushToast("Added to queue");
      } else {
        if (s.queue.length >= QUEUE_MAX || !queueAddOut.allow(profile.id)) {
          get().pushToast("Slow down with the queue requests", "error");
          return;
        }
        void transport.send("queue-add", item);
        get().pushToast("Requested to add to queue");
      }
      const title = await fetchVideoTitle(id);
      if (!title) return;
      const state = get();
      const existing = state.queue.find((q) => q.id === item.id);
      if (existing) {
        set({ queue: state.queue.map((q) => (q.id === item.id ? { ...q, title } : q)) });
        if (state.hostId === profile.id) void publishSnapshot();
      }
    },

    removeFromQueue(id) {
      const s = get();
      const profile = selfProfile;
      if (!profile || !transport) return;
      const item = s.queue.find((q) => q.id === id);
      if (!item) return;
      const allowed = item.addedBy === profile.id || s.hostId === profile.id;
      if (!allowed) {
        get().pushToast("Only the host or the adder can remove that", "error");
        return;
      }
      if (s.hostId === profile.id) {
        set({ queue: s.queue.filter((q) => q.id !== id) });
        void publishSnapshot();
      } else {
        void transport.send("queue-remove", { id, by: profile.id });
      }
    },

    playFromQueue(id) {
      const s = get();
      const profile = selfProfile;
      if (!profile) return;
      if (s.hostId !== profile.id) {
        get().pushToast("Only the host can jump the queue", "error");
        void transport?.send("control-request", {
          senderId: profile.id,
          senderName: profile.name,
        });
        return;
      }
      const idx = s.queue.findIndex((q) => q.id === id);
      if (idx === -1) return;
      const item = s.queue[idx];
      set({ queue: s.queue.slice(idx + 1) });
      engine?.localLoad(item.videoId, true);
      recordWatched(item.videoId, item.title);
      void publishSnapshot();
    },

    /**
     * Host-only queue reorder (drag-and-drop). Mirrors the other host queue
     * mutations: local set + publishSnapshot (version bump, RLS-gated UPDATE,
     * broadcast to everyone).
     */
    moveQueue(from, to) {
      const s = get();
      const profile = selfProfile;
      if (!profile || s.hostId !== profile.id) return;
      if (from === to) return;
      if (from < 0 || from >= s.queue.length || to < 0 || to >= s.queue.length) return;
      const queue = s.queue.slice();
      const [item] = queue.splice(from, 1);
      queue.splice(to, 0, item);
      set({ queue });
      void publishSnapshot();
    },

    /**
     * Toggle own upvote on a queue item (any member, host included). The RPC
     * returns the post-toggle queue + version, which we apply immediately;
     * the rooms UPDATE event echoes the same state to everyone else.
     */
    async voteQueue(itemId) {
      const s = get();
      const profile = selfProfile;
      if (!profile || !s.code) return;
      if (!voteOut.allow(profile.id)) return;
      try {
        const { queue, queueVersion } = await voteQueueRpc(s.code, itemId);
        set({ queue: queue.map(toQueueItem), queueVersion });
      } catch {
        /* not_found (item just removed) or not_member — drop silently */
      }
    },

    skipUpNext() {
      advanceFromQueue();
    },

    toggleGuestControls() {
      const s = get();
      const profile = selfProfile;
      if (!profile || s.hostId !== profile.id) return;
      set({ guestsCanControl: !s.guestsCanControl });
      void publishSnapshot();
      get().pushToast(!s.guestsCanControl ? "Guests can control playback" : "Playback locked to host");
    },

    async toggleRoomLock() {
      const s = get();
      const profile = selfProfile;
      if (!profile || s.hostId !== profile.id || !s.code) return;
      const locked = !s.roomLocked;
      const ok = await saveRoomSettings(s.code, { locked });
      if (!ok) {
        get().pushToast("Only the host can lock the room", "error");
        return;
      }
      set({ roomLocked: locked });
      get().pushToast(locked ? "Room locked — new guests can't join" : "Room unlocked");
    },

    async setSlowMode(seconds) {
      const s = get();
      const profile = selfProfile;
      if (!profile || s.hostId !== profile.id || !s.code) return;
      const clamped = Math.max(0, Math.min(300, Math.round(seconds)));
      const ok = await saveRoomSettings(s.code, { slow_mode_seconds: clamped });
      if (!ok) {
        get().pushToast("Only the host can change slow mode", "error");
        return;
      }
      set({ roomSlowMode: clamped });
      get().pushToast(clamped ? `Slow mode: 1 message / ${clamped}s` : "Slow mode off");
    },

    requestControl() {
      const profile = selfProfile;
      if (!profile) return;
      void transport?.send("control-request", { senderId: profile.id, senderName: profile.name });
      get().pushToast("Asked the host for control");
    },

    markChatRead() {
      if (get().unread > 0) set({ unread: 0 });
    },

    dismissFailedChat() {
      if (get().failedChat) set({ failedChat: null });
    },

    pushToast(text, kind = "info", opts) {
      // Guards against toast floods (remote actions, rate-limit notices, ...):
      // same message within 3s is deduped, and globally at most ~1 per 350ms.
      const now = Date.now();
      const toasts = get().toasts;
      const last = toasts[toasts.length - 1];
      if (last && last.text === text && now - (last.ts || 0) < 3000) return last.id;
      if (!toastGap.allow("toast")) return "";
      const toast: ToastItem = {
        id: randomId(),
        text,
        kind,
        ts: now,
        actions: opts?.actions,
        ttlMs: opts?.ttlMs,
      };
      set({ toasts: [...toasts.slice(-3), toast] });
      // Action toasts usually carry their own bounded ttlMs (a countdown
      // the caller also drives); plain toasts keep the default pop-in/out.
      setTimeout(() => get().dismissToast(toast.id), opts?.ttlMs ?? 3200);
      return toast.id;
    },

    dismissToast(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    },

    getProfile() {
      return selfProfile;
    },
  };
});

function addFloating(
  set: (partial: Partial<RoomState>) => void,
  get: () => RoomState,
  event: ReactionEvent,
): void {
  const lane = Math.floor(Math.random() * 7);
  const floating: FloatingReaction = { ...event, lane };
  set({ floating: [...get().floating, floating] });
  setTimeout(() => {
    set({ floating: get().floating.filter((f) => f.id !== event.id) });
  }, 3600);
}

export function canControlNow(): boolean {
  const s = useRoom.getState();
  if (!selfProfile) return false;
  return (
    s.hostId === selfProfile.id || s.guestsCanControl || s.grantedTo.includes(selfProfile.id)
  );
}

/**
 * Start position for a rejoining client: the host-mirrored playback row.
 * Wall-clock catch-up only applies within RESUME_CATCHUP_MAX_SECS of the
 * last host write — the row's `playing` flag means "was going" at persist
 * time, not "keep going forever"; beyond the window the row is stale (the
 * host left) and catching up would push short videos past their end.
 * Live sync answers from an online host still override this — it's the
 * fallback when nobody's broadcasting (host refreshing/crashed) or the
 * answer lost the iframe race.
 */
const RESUME_CATCHUP_MAX_SECS = 300;

function resumeStartSeconds(videoId: string): number {
  const r = resumeRef;
  if (!r || r.videoId !== videoId) return 0;
  if (!r.playing) return Math.max(0, r.time);
  const age = Math.max(0, (Date.now() - r.updatedAt) / 1000);
  if (age > RESUME_CATCHUP_MAX_SECS) return Math.max(0, r.time);
  return Math.max(0, r.time + age);
}

/** Only autoplay a resume when the room was actively playing recently. */
function resumeShouldAutoplay(videoId: string): boolean {
  const r = resumeRef;
  if (!r || r.videoId !== videoId || !r.playing) return false;
  return (Date.now() - r.updatedAt) / 1000 <= RESUME_CATCHUP_MAX_SECS;
}

/** Current playback position as a persistable row, or null if nothing's loaded. */
function currentPlayback(): PlaybackPosition | null {
  const ref = engine?.getLocalRef();
  if (!ref?.videoId) return null;
  return {
    videoId: ref.videoId,
    time: playerAdapter?.ready() ? playerAdapter.getTime() : ref.time,
    playing: playerAdapter?.ready() ? playerAdapter.isPlaying() : ref.playing,
    updatedAt: Date.now(),
  };
}

/**
 * Host-only: mirror the playback position onto rooms.playback so a refresh
 * resumes where everyone stopped instead of restarting at 0. RLS rejects
 * non-host writes (saveRoomSettings returns false — silently ignored here).
 */
function persistPlayback(opts?: { force?: boolean }): void {
  const s = useRoom.getState();
  if (!s.code || !selfProfile || s.hostId !== selfProfile.id) return;
  const now = Date.now();
  if (!opts?.force && now - lastPlaybackPersistAt < PLAYBACK_PERSIST_MIN_GAP) return;
  const pos = currentPlayback();
  if (!pos) return;
  lastPlaybackPersistAt = now;
  resumeRef = pos;
  void saveRoomSettings(s.code, { playback: pos });
}

/** pagehide flush: write the position immediately, ignoring the min gap. */
function flushPlaybackNow(): void {
  persistPlayback({ force: true });
}

export function isHostNow(): boolean {
  const s = useRoom.getState();
  return !!selfProfile && s.hostId === selfProfile.id;
}
