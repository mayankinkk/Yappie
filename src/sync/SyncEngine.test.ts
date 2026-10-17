import { describe, it, expect } from "vitest";
import {
  computeCatchUpTarget,
  computeExpectedTime,
  computeDriftCorrection,
  SyncEngine,
  type SyncEngineOptions,
} from "./SyncEngine";
import type { ControlPayload, PlayerAdapter, PlayerLocalEvent, RoomSnapshot, Transport } from "../types";

class FakePlayer implements PlayerAdapter {
  time = 0;
  playing = false;
  loaded: { videoId: string; time: number; autoplay: boolean } | null = null;
  private readyState = true;
  private cb: ((e: PlayerLocalEvent) => void) | null = null;

  setReady(v: boolean) { this.readyState = v; }
  ready() { return this.readyState; }
  load(videoId: string, time: number, autoplay: boolean) { this.loaded = { videoId, time, autoplay }; this.time = time; this.playing = autoplay; }
  play() { this.playing = true; }
  pause() { this.playing = false; }
  seek(t: number) { this.time = t; }
  getTime() { return this.time; }
  isPlaying() { return this.playing; }
  setMuted() {}
  destroy() {}
  onLocalEvent(cb: (e: PlayerLocalEvent) => void) { this.cb = cb; }
  emit(type: PlayerLocalEvent["type"]) { this.cb?.({ type } as PlayerLocalEvent); }
}

class FakeTransport implements Transport {
  sent: Array<{ event: string; payload: unknown }> = [];
  private handlers = new Map<string, (p: unknown) => void>();
  send(event: string, payload: unknown) { this.sent.push({ event, payload }); }
  on(event: string, cb: (p: unknown) => void) { this.handlers.set(event, cb); }
  emit(event: string, payload: unknown) { this.handlers.get(event)?.(payload); }
}

function makeEngine(overrides: Partial<SyncEngineOptions> = {}) {
  const player = new FakePlayer();
  const transport = new FakeTransport();
  let role = { selfId: "self", hostId: "self", guestsCanControl: false };
  let videoId: string | null = null;
  const opts: SyncEngineOptions = {
    transport,
    player,
    getRole: () => role,
    getVideoId: () => videoId,
    onLocalState: () => {},
    onRemoteAction: () => {},
    onDenied: () => {},
    onControlRequested: () => {},
    onEnded: () => {},
    ...overrides,
  };
  const engine = new SyncEngine(opts);
  engine.start();
  return {
    engine, player, transport,
    setRole: (r: typeof role) => { role = r; },
    setVideoId: (v: string | null) => { videoId = v; },
  };
}

describe("computeCatchUpTarget", () => {
  const t = 1_000_000;

  it("advances playing position by elapsed time", () => {
    expect(computeCatchUpTarget({ time: 100, playing: true, sentAt: t }, t + 4000)).toBeCloseTo(104);
  });

  it("does not advance paused position", () => {
    expect(computeCatchUpTarget({ time: 100, playing: false, sentAt: t }, t + 4000)).toBe(100);
  });

  it("clamps very old timestamps to max age", () => {
    expect(computeCatchUpTarget({ time: 0, playing: true, sentAt: t }, t + 600_000, 15)).toBe(15);
  });

  it("clamps future timestamps (clock skew) to zero age", () => {
    expect(computeCatchUpTarget({ time: 50, playing: true, sentAt: t }, t - 10_000)).toBe(50);
  });

  it("never returns negative time", () => {
    expect(computeCatchUpTarget({ time: 1, playing: false, sentAt: t }, t)).toBeGreaterThanOrEqual(0);
  });
});

describe("computeExpectedTime", () => {
  it("projects forward from sentAt for playing state", () => {
    expect(computeExpectedTime({ time: 10, sentAt: 5000 }, 8000)).toBeCloseTo(13);
  });

  it("does not go negative for old sentAt", () => {
    expect(computeExpectedTime({ time: 10, sentAt: 5000 }, 1000)).toBe(10);
  });
});

describe("computeDriftCorrection", () => {
  const ref = { time: 100, sentAt: 10_000 };

  it("returns null when drift is under threshold", () => {
    expect(computeDriftCorrection(ref, 100.4, 11_000)).toBeNull();
  });

  it("returns corrected target when drift exceeds threshold", () => {
    const now = 12_000;
    expect(computeDriftCorrection(ref, 105, now)).toBeCloseTo(102);
  });

  it("returns null when drift is absurdly large (stale state)", () => {
    expect(computeDriftCorrection(ref, 500, 11_000)).toBeNull();
  });
});

describe("SyncEngine control gating", () => {
  it("host can play and broadcasts a control event", () => {
    const { engine, player, transport, setVideoId } = makeEngine();
    setVideoId("abcdefghijk");
    player.time = 10;
    engine.localPlay();
    expect(player.isPlaying()).toBe(true);
    const control = transport.sent.find((s) => s.event === "control") as { payload: ControlPayload } | undefined;
    expect(control?.payload.action).toBe("play");
    expect(control?.payload.playing).toBe(true);
  });

  it("guest without permission is denied and sends control-request", () => {
    const { player, transport } = makeEngine();
    let denied = false;
    const deniedEngine = new SyncEngine({
      transport,
      player,
      getRole: () => ({ selfId: "guest", hostId: "host", guestsCanControl: false }),
      getVideoId: () => "abcdefghijk",
      onLocalState: () => {},
      onRemoteAction: () => {},
      onDenied: () => { denied = true; },
      onControlRequested: () => {},
      onEnded: () => {},
    });
    deniedEngine.start();
    deniedEngine.localPlay();
    expect(denied).toBe(true);
    expect(player.isPlaying()).toBe(false);
    expect(transport.sent.some((s) => s.event === "control-request")).toBe(true);
  });

  it("guest can play when guestsCanControl is true", () => {
    const { engine, player, setRole, setVideoId } = makeEngine();
    setRole({ selfId: "guest", hostId: "host", guestsCanControl: true });
    setVideoId("abcdefghijk");
    engine.localPlay();
    expect(player.isPlaying()).toBe(true);
  });
});

describe("SyncEngine remote apply", () => {
  it("applies a control payload to the player", () => {
    const { engine, player, setVideoId } = makeEngine();
    setVideoId("abcdefghijk");
    player.time = 10;
    player.playing = true;
    const payload: ControlPayload = {
      videoId: "abcdefghijk",
      time: 42,
      playing: false,
      sentAt: Date.now(),
      senderId: "host",
      senderName: "Host",
      action: "seek",
      notify: true,
    };
    engine.applyControl(payload);
    expect(player.isPlaying()).toBe(false);
    expect(player.getTime()).toBeCloseTo(42, 0);
  });

  it("loads a new video when payload has a different videoId", () => {
    const { engine, player, setVideoId } = makeEngine();
    setVideoId("aaaaaaaaaaa");
    engine.applyControl({
      videoId: "bbbbbbbbbbb",
      time: 5,
      playing: true,
      sentAt: Date.now(),
      senderId: "host",
      senderName: "Host",
      action: "load",
      notify: true,
    } satisfies ControlPayload);
    expect(player.loaded?.videoId).toBe("bbbbbbbbbbb");
  });

  it("ignores stale payloads older than last applied", () => {
    const { engine, player, setVideoId } = makeEngine();
    setVideoId("abcdefghijk");
    const base = Date.now();
    engine.applyControl({
      videoId: "abcdefghijk", time: 100, playing: true, sentAt: base,
      senderId: "host", senderName: "Host", action: "play", notify: false,
    } satisfies ControlPayload);
    engine.applyControl({
      videoId: "abcdefghijk", time: 10, playing: false, sentAt: base - 5000,
      senderId: "host", senderName: "Host", action: "pause", notify: false,
    } satisfies ControlPayload);
    expect(player.isPlaying()).toBe(true);
  });
});

describe("SyncEngine drift correction", () => {
  it("seeks back into sync when drift is too large", () => {
    const { engine, player, setVideoId } = makeEngine();
    setVideoId("abcdefghijk");
    player.time = 50;
    player.playing = true;
    engine.applyLoadedState({ videoId: "abcdefghijk", time: 50, playing: true });
    player.time = 70;
    engine.tick(Date.now() + 3000);
    expect(Math.abs(player.getTime() - 53)).toBeLessThan(1);
  });

  it("does nothing when paused", () => {
    const { engine, player, setVideoId } = makeEngine();
    setVideoId("abcdefghijk");
    player.time = 100;
    player.playing = false;
    engine.applyLoadedState({ videoId: "abcdefghijk", time: 100, playing: false });
    engine.tick(Date.now() + 10_000);
    expect(player.getTime()).toBeCloseTo(100);
  });
});

describe("SyncEngine snapshot", () => {
  it("applies a room snapshot to the player", () => {
    const { engine, player, setVideoId } = makeEngine();
    setVideoId(null);
    const snap: RoomSnapshot = {
      videoId: "ccccccccccc",
      time: 30,
      playing: true,
      sentAt: Date.now(),
      hostId: "host",
      guestsCanControl: false,
      queue: [],
      version: 1,
    };
    engine.applySnapshot(snap);
    expect(player.loaded?.videoId).toBe("ccccccccccc");
    expect(player.isPlaying()).toBe(true);
  });
});

describe("SyncEngine sync-request response", () => {
  it("responds with current playback when a sync-request arrives", () => {
    const { player, transport, setVideoId } = makeEngine();
    setVideoId("abcdefghijk");
    player.time = 25;
    player.playing = true;
    transport.emit("sync-request", {});
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const control = transport.sent.find((s) => s.event === "control") as { payload: ControlPayload } | undefined;
        expect(control?.payload.time).toBe(25);
        expect(control?.payload.playing).toBe(true);
        resolve();
      }, 400);
    });
  });
});
