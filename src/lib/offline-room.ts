import type { ChatMessage, QueueItem } from "../types";
import type { OutboxEntry } from "../stores/room";
import type { WatchedEntry } from "./rooms-api";

/** Last-known room state kept in localStorage so an offline refresh can
 *  reopen the room (queue, chat, outbox) instead of dumping the user on a
 *  broken landing page. Only ever a read-only cache — live truth is Postgres. */
export interface OfflineRoomSnapshot {
  code: string;
  savedAt: number;
  hostId: string;
  guestsCanControl: boolean;
  roomLocked: boolean;
  roomSlowMode: number;
  queueVersion: number;
  videoId: string | null;
  queue: QueueItem[];
  watched: WatchedEntry[];
  titles: Record<string, string>;
  messages: ChatMessage[];
  outbox: OutboxEntry[];
  roomName: string | null;
  roomTopic: string | null;
  maxMembers: number | null;
  requireApproval: boolean;
  captionsLang: string | null;
  grantedTo: string[];
}

const KEY = "yappie.offlineRoom";
/** Snapshots older than this are ignored (matches the recent-rooms horizon
 *  plus a day of slack for "open the tab again tomorrow"). */
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_MESSAGES = 80;
const MAX_QUEUE = 50;

function validCode(code: unknown): code is string {
  return typeof code === "string" && /^[A-Z0-9]{6}$/.test(code);
}

function sanitizeQueue(q: unknown): QueueItem[] {
  if (!Array.isArray(q)) return [];
  return q
    .filter(
      (item): item is QueueItem =>
        !!item &&
        typeof item === "object" &&
        typeof (item as QueueItem).id === "string" &&
        typeof (item as QueueItem).videoId === "string",
    )
    .slice(0, MAX_QUEUE)
    .map((item) => ({
      id: item.id,
      videoId: item.videoId,
      title: typeof item.title === "string" ? item.title : null,
      addedBy: typeof item.addedBy === "string" ? item.addedBy : "",
      addedByName: typeof item.addedByName === "string" ? item.addedByName : "",
      addedAt: typeof item.addedAt === "number" ? item.addedAt : 0,
      votes:
        item.votes && typeof item.votes === "object" && !Array.isArray(item.votes)
          ? item.votes
          : {},
    }));
}

function sanitizeMessages(m: unknown): ChatMessage[] {
  if (!Array.isArray(m)) return [];
  return m
    .filter(
      (msg): msg is ChatMessage =>
        !!msg &&
        typeof msg === "object" &&
        typeof (msg as ChatMessage).id === "string" &&
        typeof (msg as ChatMessage).text === "string",
    )
    .slice(-MAX_MESSAGES)
    .map((msg) => ({
      id: msg.id,
      senderId: typeof msg.senderId === "string" ? msg.senderId : "",
      name: typeof msg.name === "string" ? msg.name : "Guest",
      color: typeof msg.color === "number" ? msg.color : 30,
      avatar: typeof msg.avatar === "string" ? msg.avatar : undefined,
      text: msg.text.slice(0, 500),
      ts: typeof msg.ts === "number" ? msg.ts : Date.now(),
      reactions:
        msg.reactions && typeof msg.reactions === "object" && !Array.isArray(msg.reactions)
          ? msg.reactions
          : {},
      videoId: typeof msg.videoId === "string" ? msg.videoId : null,
      videoTs: typeof msg.videoTs === "number" ? msg.videoTs : null,
    }));
}

function sanitizeOutbox(o: unknown): OutboxEntry[] {
  if (!Array.isArray(o)) return [];
  return o
    .filter(
      (entry): entry is OutboxEntry =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as OutboxEntry).text === "string" &&
        (entry as OutboxEntry).text.length > 0,
    )
    .map((entry) => ({
      text: entry.text.slice(0, 500),
      moment:
        entry.moment && typeof entry.moment === "object" && typeof entry.moment.videoId === "string"
          ? { videoId: entry.moment.videoId, ts: Number(entry.moment.ts) || 0 }
          : null,
    }))
    .slice(-20);
}

function sanitizeTitles(t: unknown): Record<string, string> {
  if (!t || typeof t !== "object" || Array.isArray(t)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(t as Record<string, unknown>)) {
    if (typeof v === "string" && k.length <= 32) out[k] = v.slice(0, 200);
  }
  return out;
}

function sanitizeWatched(w: unknown): WatchedEntry[] {
  if (!Array.isArray(w)) return [];
  return w
    .filter(
      (e): e is WatchedEntry =>
        !!e && typeof e === "object" && typeof (e as WatchedEntry).videoId === "string",
    )
    .slice(0, 30)
    .map((e) => ({
      videoId: e.videoId,
      title: typeof e.title === "string" ? e.title : null,
      at: typeof e.at === "number" ? e.at : 0,
    }));
}

function sanitizeSnapshot(raw: unknown): OfflineRoomSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Partial<OfflineRoomSnapshot>;
  if (!validCode(s.code)) return null;
  if (typeof s.savedAt !== "number" || Date.now() - s.savedAt > MAX_AGE_MS) return null;
  if (Date.now() - s.savedAt < 0) return null;
  return {
    code: s.code,
    savedAt: s.savedAt,
    hostId: typeof s.hostId === "string" ? s.hostId : "",
    guestsCanControl: !!s.guestsCanControl,
    roomLocked: !!s.roomLocked,
    roomSlowMode: typeof s.roomSlowMode === "number" ? s.roomSlowMode : 0,
    queueVersion: typeof s.queueVersion === "number" ? s.queueVersion : 0,
    videoId: typeof s.videoId === "string" && s.videoId ? s.videoId : null,
    queue: sanitizeQueue(s.queue),
    watched: sanitizeWatched(s.watched),
    titles: sanitizeTitles(s.titles),
    messages: sanitizeMessages(s.messages),
    outbox: sanitizeOutbox(s.outbox),
    roomName: typeof s.roomName === "string" ? s.roomName : null,
    roomTopic: typeof s.roomTopic === "string" ? s.roomTopic : null,
    maxMembers: typeof s.maxMembers === "number" ? s.maxMembers : null,
    requireApproval: !!s.requireApproval,
    captionsLang: typeof s.captionsLang === "string" ? s.captionsLang : null,
    grantedTo: Array.isArray(s.grantedTo) ? s.grantedTo.filter((x) => typeof x === "string") : [],
  };
}

export function saveOfflineRoom(snapshot: OfflineRoomSnapshot): void {
  if (!validCode(snapshot.code)) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(snapshot));
  } catch {
    /* storage full/blocked — offline cache is best-effort */
  }
}

export function loadOfflineRoom(code: string): OfflineRoomSnapshot | null {
  const clean = code.toUpperCase();
  if (!validCode(clean)) return null;
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) || "null");
    const snap = sanitizeSnapshot(raw);
    if (!snap || snap.code !== clean) return null;
    return snap;
  } catch {
    return null;
  }
}

export function clearOfflineRoom(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
