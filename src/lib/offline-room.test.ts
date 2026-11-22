import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  saveOfflineRoom,
  loadOfflineRoom,
  clearOfflineRoom,
  type OfflineRoomSnapshot,
} from "./offline-room";

function stubStorage(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  const store = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
  (globalThis as { localStorage?: unknown }).localStorage = store;
  return store;
}

function snap(overrides: Partial<OfflineRoomSnapshot> = {}): OfflineRoomSnapshot {
  return {
    code: "ABC123",
    savedAt: Date.now(),
    hostId: "host-1",
    guestsCanControl: false,
    roomLocked: false,
    roomSlowMode: 0,
    queueVersion: 3,
    videoId: "dQw4w9WgXcQ",
    queue: [
      {
        id: "q1",
        videoId: "abcDEF12345",
        title: "Test",
        addedBy: "u1",
        addedByName: "Ada",
        addedAt: 1,
        votes: { u1: true },
      },
    ],
    watched: [],
    titles: { abcDEF12345: "Test" },
    messages: [
      {
        id: "m1",
        senderId: "u1",
        name: "Ada",
        color: 10,
        text: "hello",
        ts: 1,
        reactions: {},
      },
    ],
    outbox: [{ text: "queued", moment: null }],
    roomName: "Movie night",
    roomTopic: null,
    maxMembers: null,
    requireApproval: false,
    captionsLang: null,
    grantedTo: ["u2"],
    ...overrides,
  };
}

beforeEach(() => {
  stubStorage();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("saveOfflineRoom / loadOfflineRoom", () => {
  it("round-trips a snapshot for the same code", () => {
    saveOfflineRoom(snap());
    const loaded = loadOfflineRoom("ABC123");
    expect(loaded).not.toBeNull();
    expect(loaded?.code).toBe("ABC123");
    expect(loaded?.videoId).toBe("dQw4w9WgXcQ");
    expect(loaded?.queue).toHaveLength(1);
    expect(loaded?.messages[0]?.text).toBe("hello");
    expect(loaded?.outbox[0]?.text).toBe("queued");
  });

  it("uppercases the lookup code", () => {
    saveOfflineRoom(snap());
    expect(loadOfflineRoom("abc123")?.code).toBe("ABC123");
  });

  it("returns null for a different room code", () => {
    saveOfflineRoom(snap({ code: "ABC123" }));
    expect(loadOfflineRoom("ZZZZ99")).toBeNull();
  });

  it("returns null when storage is corrupt", () => {
    stubStorage({ "yappie.offlineRoom": "not json" });
    expect(loadOfflineRoom("ABC123")).toBeNull();
  });

  it("expires snapshots older than 3 days", () => {
    saveOfflineRoom(snap({ savedAt: Date.now() - 4 * 24 * 60 * 60 * 1000 }));
    expect(loadOfflineRoom("ABC123")).toBeNull();
  });

  it("rejects future timestamps (clock skew)", () => {
    saveOfflineRoom(snap({ savedAt: Date.now() + 60_000 }));
    expect(loadOfflineRoom("ABC123")).toBeNull();
  });

  it("drops malformed queue and message entries", () => {
    saveOfflineRoom(
      snap({
        queue: [
          // @ts-expect-error intentional junk
          { nope: true },
          {
            id: "ok",
            videoId: "vid",
            title: null,
            addedBy: "",
            addedByName: "",
            addedAt: 0,
            votes: {},
          },
        ],
        messages: [
          // @ts-expect-error intentional junk
          { text: 42 },
          {
            id: "m",
            senderId: "u",
            name: "N",
            color: 1,
            text: "hi",
            ts: 2,
            reactions: {},
          },
        ],
      }),
    );
    const loaded = loadOfflineRoom("ABC123");
    expect(loaded?.queue.map((q) => q.id)).toEqual(["ok"]);
    expect(loaded?.messages.map((m) => m.id)).toEqual(["m"]);
  });

  it("clearOfflineRoom removes the entry", () => {
    saveOfflineRoom(snap());
    clearOfflineRoom();
    expect(loadOfflineRoom("ABC123")).toBeNull();
  });

  it("ignores malformed codes on save", () => {
    saveOfflineRoom(snap({ code: "BAD" }));
    expect(loadOfflineRoom("BAD")).toBeNull();
  });
});
