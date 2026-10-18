import { describe, it, expect, beforeEach } from "vitest";
import { loadRecentRooms, rememberRoom } from "./recent";

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

beforeEach(() => {
  stubStorage();
});

describe("rememberRoom", () => {
  it("stores a code with a timestamp", () => {
    const list = rememberRoom("ABC123");
    expect(list).toHaveLength(1);
    expect(list[0].code).toBe("ABC123");
    expect(typeof list[0].at).toBe("number");
    expect(loadRecentRooms()).toEqual(list);
  });

  it("uppercases codes and rejects malformed ones", () => {
    rememberRoom("abc123");
    expect(loadRecentRooms()[0].code).toBe("ABC123");
    // invalid input returns the current list unchanged (no throw, no insert)
    expect(rememberRoom("SHORT").map((r) => r.code)).toEqual(["ABC123"]);
    expect(rememberRoom("").map((r) => r.code)).toEqual(["ABC123"]);
    expect(loadRecentRooms()).toHaveLength(1);
  });

  it("moves a known code to the front instead of duplicating", () => {
    rememberRoom("AAAAAA");
    rememberRoom("BBBBBB");
    rememberRoom("AAAAAA");
    const list = loadRecentRooms();
    expect(list.map((r) => r.code)).toEqual(["AAAAAA", "BBBBBB"]);
  });

  it("caps the list at 5, newest first", () => {
    for (const c of ["AAAAA1", "BBBBB2", "CCCCC3", "DDDDD4", "EEEEE5", "FFFFF6"]) {
      rememberRoom(c);
    }
    const list = loadRecentRooms();
    expect(list).toHaveLength(5);
    expect(list[0].code).toBe("FFFFF6");
    expect(list.map((r) => r.code)).not.toContain("AAAAA1");
  });
});

describe("loadRecentRooms", () => {
  it("returns [] for missing or corrupt storage", () => {
    stubStorage({ "sofa.recentRooms": "not json" });
    expect(loadRecentRooms()).toEqual([]);
    stubStorage({ "sofa.recentRooms": '{"nope": true}' });
    expect(loadRecentRooms()).toEqual([]);
  });

  it("filters malformed entries and wrong-length codes", () => {
    stubStorage({
      "sofa.recentRooms": JSON.stringify([
        { code: "GOOD01", at: 123 },
        { code: "nope", at: 123 },
        { code: "BAD", at: "soon" },
        null,
        "string",
        { at: 5 },
      ]),
    });
    const list = loadRecentRooms();
    expect(list).toEqual([{ code: "GOOD01", at: 123 }]);
  });
});
