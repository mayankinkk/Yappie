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
import { randomId } from "../lib/ids";
import { playSound } from "../lib/sound";
import { SyncEngine } from "../sync/SyncEngine";
import {
  RoomError,
  claimHostRpc,
  createRoomRpc,
  heartbeatRpc,
  joinRoomRpc,
  leaveRoomRpc,
  moderateMemberRpc,
  saveRoomSettings,
  type JoinedRoom,
  type MembershipRow,
  type QueueRow,
  type RoomRow,
} from "../lib/rooms-api";
import { ensureAuthed } from "./session";
import { MinGap, RateLimiter } from "../lib/ratelimit";

const CHAT_TRIM = 200;
const HEARTBEAT_MS = 20_000;
const QUEUE_MAX = 50;
const MUTE_DEFAULT_SECONDS = 300;

// Sender-side budgets: drop our own excess before it hits the network.
const chatOut = new RateLimiter(5, 5000);
const chatOutGap = new MinGap(500);
const reactionOut = new RateLimiter(6, 3000);
const queueAddOut = new RateLimiter(6, 60_000);

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

let transport: Transport | null = null;
let engine: SyncEngine | null = null;
let playerAdapter: PlayerAdapter | null = null;
let channelUnsubscribe: (() => void) | null = null;
let driftTimer: ReturnType<typeof setInterval> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let selfProfile: Profile | null = null;
let claimInFlight = false;

interface RoomState {
  code: string | null;
  connection: "idle" | "connecting" | "connected" | "error";
  hostId: string;
  guestsCanControl: boolean;
  roomLocked: boolean;
  queueVersion: number;
  videoId: string | null;
  playing: boolean;
  queue: QueueItem[];
  messages: ChatMessage[];
  unread: number;
  participants: Participant[];
  members: MembershipRow[];
  floating: FloatingReaction[];
  toasts: ToastItem[];

  createRoom(profile: Profile, password?: string | null): Promise<void>;
  joinRoom(code: string, profile: Profile, password?: string | null): Promise<void>;
  leaveRoom(): void;
  attachPlayer(adapter: PlayerAdapter): void;
  loadMembers(): Promise<void>;
  moderate(userId: string, opts: { banned?: boolean; muteSeconds?: number }): Promise<void>;
  setHost(userId: string): Promise<void>;

  togglePlayback(): void;
  seekTo(time: number): void;
  loadVideo(input: string): Promise<void>;
  sendChat(text: string): void;
  react(emoji: string): void;
  addToQueue(input: string): Promise<void>;
  removeFromQueue(id: string): void;
  playFromQueue(id: string): void;
  toggleGuestControls(): void;
  toggleRoomLock(): Promise<void>;
  requestControl(): void;
  markChatRead(): void;
  pushToast(text: string, kind?: ToastItem["kind"]): void;
  dismissToast(id: string): void;
  getProfile(): Profile | null;
}

function clampText(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

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
  };
}

// Best-effort membership close when the tab goes away (crash path is claim_host()).
function handlePageHide(): void {
  const code = useRoom.getState().code;
  if (code) void leaveRoomRpc(code);
}
if (typeof window !== "undefined") window.addEventListener("pagehide", handlePageHide);

export const useRoom = create<RoomState>((set, get) => {
  /** Server-authoritative room row → local state (RLS-backed; only ever the real host writes it). */
  function applyRoomRow(row: RoomRow): void {
    const s = get();
    const next: Partial<RoomState> = {
      hostId: row.host_id,
      guestsCanControl: row.guests_can_control,
      roomLocked: !!row.locked,
      videoId: row.video_id ?? null,
    };
    if (typeof row.queue_version === "number" && row.queue_version >= s.queueVersion) {
      next.queue = (row.queue || []).map(toQueueItem);
      next.queueVersion = row.queue_version;
    }
    set(next);
    if (row.video_id !== s.videoId) engine?.requestSync();
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
    });
    if (!ok) {
      const supabase = getSupabase();
      if (supabase) {
        const { data } = await supabase
          .from("rooms")
          .select("*")
          .eq("code", s.code)
          .maybeSingle();
        if (data) applyRoomRow(data as RoomRow);
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

  function handleEnded(): void {
    const s = get();
    if (selfProfile?.id !== s.hostId) return;
    const next = s.queue[0];
    if (!next || !engine) return;
    set({ queue: s.queue.slice(1) });
    engine.localLoad(next.videoId, true);
    get().pushToast(`Up next: ${next.title || "video"}`);
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
    const channel = supabase.channel(`sofa-v2-${code}`, {
      config: { presence: { key: profile.id } },
    });

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
        load: (v, t, a) => playerAdapter?.load(v, t, a),
        play: () => playerAdapter?.play(),
        pause: () => playerAdapter?.pause(),
        seek: (t) => playerAdapter?.seek(t),
        getTime: () => playerAdapter?.getTime() ?? 0,
        isPlaying: () => playerAdapter?.isPlaying() ?? false,
        setMuted: (m) => playerAdapter?.setMuted(m),
        destroy: () => {},
        onLocalEvent: () => {},
      },
      getRole: () => ({
        selfId: profile.id,
        hostId: get().hostId,
        guestsCanControl: get().guestsCanControl,
      }),
      getVideoId: () => get().videoId,
      onLocalState: (s) => set({ videoId: s.videoId, playing: s.playing }),
      onRemoteAction: (text) => {
        get().pushToast(text);
        playSound("control");
      },
      onDenied: () => get().pushToast("Only the host can control playback", "error"),
      onControlRequested: (name) => {
        get().pushToast(`${name} is asking to control playback`);
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

    t.on("chat", (payload) => {
      const p = payload as ChatMessage | null;
      if (!p || p.senderId === profile.id) return;
      const member = get().members.find((m) => m.user_id === p.senderId);
      if (member && (member.banned || isMuted(member))) return;
      if (!chatIn.allow(String(p.senderId || "?"))) return;
      pushMessage(
        set,
        get,
        {
          id: clampText(p.id, 64) || randomId(),
          senderId: clampText(p.senderId, 64),
          name: clampText(p.name, 40) || "Guest",
          color: typeof p.color === "number" ? p.color : 30,
          text: clampText(p.text, 500),
          ts: typeof p.ts === "number" ? p.ts : Date.now(),
        },
        true,
      );
    });

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
      },
    );

    channel.on("presence", { event: "sync" }, () => {
      const state = channel.presenceState();
      const list: Participant[] = [];
      for (const key of Object.keys(state)) {
        const p = state[key][0] as unknown as { name?: string; color?: number; joinedAt?: number } | undefined;
        if (!p) continue;
        list.push({
          id: key,
          name: p.name || "Guest",
          color: typeof p.color === "number" ? p.color : 30,
          joinedAt: p.joinedAt || Date.now(),
        });
      }
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
        list.push({ id: profile.id, name: profile.name, color: profile.color, joinedAt: Date.now() });
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
            joinedAt: Date.now(),
          });
          void get().loadMembers();
          engine?.requestSync();
          if (!settled) {
            settled = true;
            resolve();
          }
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          set({ connection: "error" });
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
    queueVersion: 0,
    videoId: null,
    playing: false,
    queue: [],
    messages: [],
    unread: 0,
    participants: [],
    members: [],
    floating: [],
    toasts: [],

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

    async moderate(userId, opts) {
      const s = get();
      if (!s.code) return;
      try {
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

      set({
        code,
        connection: "connecting",
        hostId: joined.hostId,
        guestsCanControl: joined.guestsCanControl,
        roomLocked: joined.locked,
        queue: joined.queue.map(toQueueItem),
        queueVersion: joined.queueVersion,
        videoId: joined.videoId,
        playing: false,
        messages: [],
        unread: 0,
        participants: [],
        members: [],
        floating: [],
      });
      selfProfile = p;
      await connect(code, p);
      const url = new URL(location.href);
      url.searchParams.set("room", code);
      history.replaceState(null, "", url);
      document.title = `Sofa · ${code}`;
      driftTimer = setInterval(() => engine?.tick(), 5000);
      void heartbeatRpc(code);
      heartbeatTimer = setInterval(() => void heartbeatRpc(code), HEARTBEAT_MS);
    },

    leaveRoom() {
      const code = get().code;
      if (code) void leaveRoomRpc(code);
      if (driftTimer) clearInterval(driftTimer);
      driftTimer = null;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
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
        videoId: null,
        playing: false,
        queue: [],
        messages: [],
        unread: 0,
        participants: [],
        members: [],
        floating: [],
      });
      const url = new URL(location.href);
      url.searchParams.delete("room");
      history.replaceState(null, "", url);
      document.title = "Sofa — Watch YouTube together";
    },

    attachPlayer(adapter) {
      playerAdapter = adapter;
      adapter.onLocalEvent((e) => {
        if (e.type === "ended") {
          engine?.handlePlayerEnded();
        } else if (e.type === "error") {
          get().pushToast("This video can't be played here", "error");
        }
      });
      engine?.requestSync();
    },

    togglePlayback() {
      const s = get();
      if (!s.videoId || !playerAdapter) return;
      if (playerAdapter.isPlaying()) engine?.localPause();
      else engine?.localPlay();
    },

    seekTo(time) {
      if (!get().videoId) return;
      engine?.localSeek(time);
    },

    async loadVideo(input) {
      const id = extractVideoId(input);
      if (!id) {
        get().pushToast("Paste a valid YouTube link", "error");
        return;
      }
      const s = get();
      const isController = selfProfile?.id === s.hostId || s.guestsCanControl;
      if (!isController) {
        await get().addToQueue(id);
        get().pushToast("Only the host plays videos — added to the queue instead");
        return;
      }
      engine?.localLoad(id, true);
      if (selfProfile?.id === s.hostId && s.code) {
        void saveRoomSettings(s.code, { video_id: id });
      }
    },

    sendChat(text) {
      const profile = selfProfile;
      if (!profile || !transport || !text.trim()) return;
      const selfMember = get().members.find((m) => m.user_id === profile.id);
      if (isMuted(selfMember)) {
        get().pushToast("You're muted", "error");
        return;
      }
      if (!chatOut.allow(profile.id) || !chatOutGap.allow(profile.id)) {
        get().pushToast("You're messaging too fast", "error");
        return;
      }
      const msg: ChatMessage = {
        id: randomId(),
        senderId: profile.id,
        name: profile.name,
        color: profile.color,
        text: text.trim().slice(0, 500),
        ts: Date.now(),
      };
      void transport.send("chat", msg);
      pushMessage(set, get, msg, false);
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
        void transport?.send("control-request", { senderName: profile.name });
        return;
      }
      const idx = s.queue.findIndex((q) => q.id === id);
      if (idx === -1) return;
      const item = s.queue[idx];
      set({ queue: s.queue.slice(idx + 1) });
      engine?.localLoad(item.videoId, true);
      void publishSnapshot();
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

    requestControl() {
      const profile = selfProfile;
      if (!profile) return;
      void transport?.send("control-request", { senderName: profile.name });
      get().pushToast("Asked the host for control");
    },

    markChatRead() {
      if (get().unread > 0) set({ unread: 0 });
    },

    pushToast(text, kind = "info") {
      // Guards against toast floods (remote actions, rate-limit notices, ...):
      // same message within 3s is deduped, and globally at most ~1 per 350ms.
      const now = Date.now();
      const toasts = get().toasts;
      const last = toasts[toasts.length - 1];
      if (last && last.text === text && now - (last.ts || 0) < 3000) return;
      if (!toastGap.allow("toast")) return;
      const toast: ToastItem = { id: randomId(), text, kind, ts: now };
      set({ toasts: [...toasts.slice(-3), toast] });
      setTimeout(() => get().dismissToast(toast.id), 3200);
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
  return s.hostId === selfProfile.id || s.guestsCanControl;
}

export function isHostNow(): boolean {
  const s = useRoom.getState();
  return !!selfProfile && s.hostId === selfProfile.id;
}
