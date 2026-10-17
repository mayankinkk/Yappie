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
import { randomCode, randomId } from "../lib/ids";
import { playSound } from "../lib/sound";
import { SyncEngine } from "../sync/SyncEngine";

const CHAT_TRIM = 200;

let transport: Transport | null = null;
let engine: SyncEngine | null = null;
let playerAdapter: PlayerAdapter | null = null;
let channelUnsubscribe: (() => void) | null = null;
let driftTimer: ReturnType<typeof setInterval> | null = null;
let selfProfile: Profile | null = null;

interface RoomState {
  code: string | null;
  connection: "idle" | "connecting" | "connected" | "error";
  hostId: string;
  guestsCanControl: boolean;
  queueVersion: number;
  videoId: string | null;
  playing: boolean;
  queue: QueueItem[];
  messages: ChatMessage[];
  unread: number;
  participants: Participant[];
  floating: FloatingReaction[];
  toasts: ToastItem[];

  createRoom(profile: Profile): Promise<void>;
  joinRoom(code: string, profile: Profile, opts?: { creator?: boolean }): Promise<void>;
  leaveRoom(): void;
  attachPlayer(adapter: PlayerAdapter): void;

  togglePlayback(): void;
  seekTo(time: number): void;
  loadVideo(input: string): Promise<void>;
  sendChat(text: string): void;
  react(emoji: string): void;
  addToQueue(input: string): Promise<void>;
  removeFromQueue(id: string): void;
  playFromQueue(id: string): void;
  toggleGuestControls(): void;
  requestControl(): void;
  markChatRead(): void;
  pushToast(text: string, kind?: ToastItem["kind"]): void;
  dismissToast(id: string): void;
  getProfile(): Profile | null;
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

export const useRoom = create<RoomState>((set, get) => {
  function publishSnapshot(): void {
    const s = get();
    if (!engine || !s.code || s.hostId !== selfProfile?.id) return;
    const version = s.queueVersion + 1;
    set({ queueVersion: version });
    engine.sendSnapshot({
      hostId: s.hostId,
      guestsCanControl: s.guestsCanControl,
      queue: get().queue,
      version,
    });
  }

  function applySnapshot(payload: RoomSnapshot): void {
    set({
      hostId: payload.hostId,
      guestsCanControl: payload.guestsCanControl,
      queue: payload.queue || [],
      queueVersion: payload.version,
      videoId: payload.videoId || null,
      playing: payload.playing,
    });
  }

  function handleQueueAdd(item: QueueItem): void {
    const s = get();
    if (selfProfile?.id !== s.hostId) return;
    if (s.queue.some((q) => q.videoId === item.videoId)) return;
    set({ queue: [...s.queue, item] });
    publishSnapshot();
  }

  function handleQueueRemove(payload: { id?: string; by?: string }): void {
    const s = get();
    if (selfProfile?.id !== s.hostId) return;
    const id = payload.id;
    if (!id) return;
    const item = s.queue.find((q) => q.id === id);
    if (!item) return;
    if (payload.by && payload.by !== item.addedBy && payload.by !== s.hostId) return;
    set({ queue: s.queue.filter((q) => q.id !== id) });
    publishSnapshot();
  }

  function handleEnded(): void {
    const s = get();
    if (selfProfile?.id !== s.hostId) return;
    const next = s.queue[0];
    if (!next || !engine) return;
    set({ queue: s.queue.slice(1) });
    engine.localLoad(next.videoId, true);
    get().pushToast(`Up next: ${next.title || "video"}`);
    publishSnapshot();
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
      pushMessage(set, get, { ...p, id: p.id || randomId() }, true);
    });

    t.on("reaction", (payload) => {
      const p = payload as ReactionEvent | null;
      if (!p || p.senderId === profile.id) return;
      addFloating(set, get, p);
      playSound("reaction");
    });

    t.on("queue-add", (payload) => handleQueueAdd(payload as QueueItem));
    t.on("queue-remove", (payload) => handleQueueRemove(payload as { id?: string; by?: string }));

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

      const current = get();
      const ids = list.map((x) => x.id).sort();
      if (current.hostId && ids.length > 0 && !ids.includes(current.hostId)) {
        const decider = ids[0];
        if (decider === profile.id) {
          set({ hostId: profile.id });
          setTimeout(() => publishSnapshot(), 100);
          get().pushToast("You're the host now");
        }
      }
      if (!list.some((x) => x.id === profile.id)) {
        list.push({ id: profile.id, name: profile.name, color: profile.color, joinedAt: Date.now() });
      }
      set({ participants: list });
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
    queueVersion: 0,
    videoId: null,
    playing: false,
    queue: [],
    messages: [],
    unread: 0,
    participants: [],
    floating: [],
    toasts: [],

    async createRoom(profile) {
      const code = randomCode();
      get().pushToast(`Room ${code} created`);
      await get().joinRoom(code, profile, { creator: true });
    },

    async joinRoom(code, profile, opts) {
      if (!isSupabaseConfigured()) {
        get().pushToast("Connect Supabase in settings first", "error");
        throw new Error("not configured");
      }
      get().leaveRoom();
      const creator = !!opts?.creator;
      set({
        code,
        connection: "connecting",
        hostId: creator ? profile.id : "",
        guestsCanControl: creator,
        queue: [],
        messages: [],
        unread: 0,
        participants: [],
        videoId: null,
        playing: false,
        queueVersion: 0,
      });
      selfProfile = profile;
      await connect(code, profile);
      const url = new URL(location.href);
      url.searchParams.set("room", code);
      history.replaceState(null, "", url);
      document.title = `Sofa · ${code}`;
      driftTimer = setInterval(() => engine?.tick(), 5000);
    },

    leaveRoom() {
      if (driftTimer) clearInterval(driftTimer);
      driftTimer = null;
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
        videoId: null,
        playing: false,
        queue: [],
        messages: [],
        unread: 0,
        participants: [],
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
    },

    sendChat(text) {
      const profile = selfProfile;
      if (!profile || !transport || !text.trim()) return;
      const msg: ChatMessage = {
        id: randomId(),
        senderId: profile.id,
        name: profile.name,
        color: profile.color,
        text: text.trim(),
        ts: Date.now(),
      };
      void transport.send("chat", msg);
      pushMessage(set, get, msg, false);
    },

    react(emoji) {
      const profile = selfProfile;
      if (!profile || !transport) return;
      const event: ReactionEvent = {
        id: randomId(),
        senderId: profile.id,
        name: profile.name,
        emoji,
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
        set({ queue: [...s.queue, item] });
        publishSnapshot();
        get().pushToast("Added to queue");
      } else {
        void transport.send("queue-add", item);
        get().pushToast("Requested to add to queue");
      }
      const title = await fetchVideoTitle(id);
      if (!title) return;
      const state = get();
      const existing = state.queue.find((q) => q.id === item.id);
      if (existing) {
        set({ queue: state.queue.map((q) => (q.id === item.id ? { ...q, title } : q)) });
        if (state.hostId === profile.id) publishSnapshot();
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
        publishSnapshot();
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
      publishSnapshot();
    },

    toggleGuestControls() {
      const s = get();
      const profile = selfProfile;
      if (!profile || s.hostId !== profile.id) return;
      set({ guestsCanControl: !s.guestsCanControl });
      publishSnapshot();
      get().pushToast(!s.guestsCanControl ? "Guests can control playback" : "Playback locked to host");
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
      const toast: ToastItem = { id: randomId(), text, kind };
      set({ toasts: [...get().toasts.slice(-3), toast] });
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
