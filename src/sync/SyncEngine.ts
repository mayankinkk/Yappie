import type { ControlPayload, PlaybackPayload, PlaybackTarget, PlayerAdapter, RoomSnapshot, Transport } from "../types";
import { clamp, nowMs } from "../lib/time";
import { MinGap, RateLimiter } from "../lib/ratelimit";

/** Min gap between outbound control broadcasts (state is full-snapshot, so coalescing is safe). */
const OUT_GAP_MS = 150;
/** Min gap between sync-request broadcasts. */
const SYNC_REQ_GAP_MS = 3000;
/** Inbound control budget per sender identity (Supabase also caps total events/sec per connection). */
const INBOUND_CONTROL_LIMIT = 12;
const INBOUND_CONTROL_WINDOW_MS = 1000;

export function computeCatchUpTarget(
  p: Pick<PlaybackPayload, "time" | "playing" | "sentAt">,
  now: number,
  maxAgeSec = 15,
): number {
  const age = clamp((now - p.sentAt) / 1000, 0, maxAgeSec);
  return Math.max(0, p.time + (p.playing ? age : 0));
}

export function computeExpectedTime(
  base: Pick<PlaybackPayload, "time" | "sentAt">,
  now: number,
): number {
  return base.time + Math.max(0, (now - base.sentAt) / 1000);
}

export function computeDriftCorrection(
  localRef: Pick<PlaybackPayload, "time" | "sentAt">,
  actual: number,
  now: number,
  threshold = 0.75,
  maxDrift = 120,
): number | null {
  const expected = computeExpectedTime(localRef, now);
  const drift = Math.abs(actual - expected);
  if (drift > threshold && drift < maxDrift) return expected;
  return null;
}

export interface SyncEngineOptions {
  transport: Transport;
  player: PlayerAdapter;
  getRole: () => {
    selfId: string;
    selfName?: string;
    hostId: string;
    guestsCanControl: boolean;
    grantedTo?: string[];
  };
  getVideoId: () => string | null;
  onLocalState: (s: { videoId: string | null; time: number; playing: boolean }) => void;
  onRemoteAction: (text: string) => void;
  onDenied: () => void;
  onControlRequested: (name: string, senderId?: string) => void;
  onEnded: () => void;
}

const EVENTS = ["control", "snapshot", "sync-request", "control-request"] as const;

export class SyncEngine {
  private opts: SyncEngineOptions;
  private localRef: PlaybackPayload = { videoId: "", time: 0, playing: false, sentAt: 0 };
  private lastDrift: number | null = null;
  /** When a remote answer/row last corroborated our baseline (see hasAuthoritativeSync). */
  private lastRemoteAt = 0;
  /** Newest applied sentAt per sender — see isStale(). */
  private lastAppliedFrom: Record<string, number> = {};
  private applying = false;
  private applyTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the player last disagreed with our playing intent (see tick()). */
  private blockSince = 0;
  /** Latest remote payload received before the player was ready (kept so a
   *  refresh's sync answer isn't lost to the iframe warm-up race). */
  private pendingRemote: {
    payload: PlaybackPayload & { action?: ControlPayload["action"] };
    notifyFrom: string;
  } | null = null;
  private unsubscribers: Array<() => void> = [];
  private started = false;
  private outTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly outGap = new MinGap(OUT_GAP_MS);
  private readonly syncReqGap = new MinGap(SYNC_REQ_GAP_MS);
  private readonly syncRespondGap = new MinGap(2000);
  private readonly inboundControl = new RateLimiter(INBOUND_CONTROL_LIMIT, INBOUND_CONTROL_WINDOW_MS);
  private readonly inboundControlReq = new RateLimiter(3, 10_000);

  constructor(opts: SyncEngineOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    const { transport } = this.opts;
    const handlers: Record<string, (payload: unknown) => void> = {
      control: (p) => this.applyControl(p),
      snapshot: (p) => this.applySnapshot(p),
      "sync-request": (p) => this.respondToSyncRequest(p as { senderId?: string } | null),
      "control-request": (p) => {
        const payload = p as { senderName?: string; senderId?: string } | null;
        const name = payload?.senderName || "Someone";
        if (!this.inboundControlReq.allow(String(payload?.senderId || name))) return;
        this.opts.onControlRequested(name, payload?.senderId);
      },
    };
    for (const ev of EVENTS) transport.on(ev, handlers[ev]);
  }

  destroy(): void {
    this.started = false;
    this.pendingRemote = null;
    this.lastAppliedFrom = {};
    this.lastRemoteAt = 0;
    if (this.applyTimer) clearTimeout(this.applyTimer);
    if (this.outTimer) clearTimeout(this.outTimer);
    this.outTimer = null;
    this.unsubscribers.forEach((u) => u());
    this.unsubscribers = [];
  }

  /**
   * Broadcast payloads are not cryptographically authenticated by Realtime, so we
   * enforce the role contract on receive: hostId is server-authoritative (Postgres),
   * so while playback is locked, only payloads from the real host apply. When the
   * host unlocks guest control, any member may control (they're already inside the
   * room channel); attribution beyond that is cosmetic.
   */
  private isTrustedSender(senderId: string | undefined): boolean {
    if (!senderId) return false;
    const { hostId, guestsCanControl, grantedTo } = this.opts.getRole();
    if (guestsCanControl) return true;
    if (!!hostId && senderId === hostId) return true;
    return !!grantedTo?.includes(senderId);
  }

  getLocalRef(): PlaybackPayload {
    return { ...this.localRef };
  }

  canControl(): boolean {
    const { selfId, hostId, guestsCanControl, grantedTo } = this.opts.getRole();
    return selfId === hostId || guestsCanControl || !!grantedTo?.includes(selfId);
  }

  private assertControl(): boolean {
    if (!this.canControl()) {
      this.opts.onDenied();
      const { selfId, selfName } = this.opts.getRole();
      void this.opts.transport.send("control-request", {
        senderId: selfId,
        senderName: selfName || "Guest",
      });
      return false;
    }
    return true;
  }

  private broadcast(action: ControlPayload["action"], notify: boolean, explicitTime?: number): void {
    const videoId = this.opts.getVideoId();
    if (!videoId) return;
    const time =
      explicitTime !== undefined
        ? explicitTime
        : this.opts.player.ready()
          ? this.opts.player.getTime()
          : this.localRef.time;
    // playVideo()/pauseVideo() apply asynchronously (state can still be CUED
    // or BUFFERING right after a fresh load), so trust the user's intent for
    // play/pause instead of the not-yet-updated player state.
    const playing =
      action === "play"
        ? true
        : action === "pause"
          ? false
          : this.opts.player.ready()
            ? this.opts.player.isPlaying()
            : this.localRef.playing;
    const { selfId } = this.opts.getRole();
    this.localRef = { videoId, time, playing, sentAt: nowMs() };
    this.opts.onLocalState({ videoId, time, playing });

    // Payloads carry the full state, so a burst can be coalesced into one
    // send after the gap instead of flooding the channel.
    if (action !== "load" && !this.outGap.allow(selfId)) {
      if (!this.outTimer) {
        const delay = OUT_GAP_MS / 2;
        this.outTimer = setTimeout(() => {
          this.outTimer = null;
          this.flushCoalesced();
        }, delay);
      }
      return;
    }
    const payload: ControlPayload = {
      videoId,
      time,
      playing,
      sentAt: nowMs(),
      senderId: selfId,
      senderName: "",
      action,
      notify,
    };
    void this.opts.transport.send("control", payload);
  }

  /** Sends the latest local state after a coalesced burst (silent — no toast spam). */
  private flushCoalesced(): void {
    const videoId = this.opts.getVideoId();
    if (!videoId || !this.started) return;
    const time = this.opts.player.ready() ? this.opts.player.getTime() : this.localRef.time;
    const playing = this.opts.player.ready()
      ? this.opts.player.isPlaying()
      : this.localRef.playing;
    const { selfId } = this.opts.getRole();
    if (!this.outGap.allow(selfId)) {
      // Still inside the gap — try again shortly.
      this.outTimer = setTimeout(() => {
        this.outTimer = null;
        this.flushCoalesced();
      }, OUT_GAP_MS / 2);
      return;
    }
    this.localRef = { videoId, time, playing, sentAt: nowMs() };
    void this.opts.transport.send("control", {
      videoId,
      time,
      playing,
      sentAt: this.localRef.sentAt,
      senderId: selfId,
      senderName: "",
      action: playing ? "play" : "pause",
      notify: false,
    } satisfies ControlPayload);
  }

  localPlay(): void {
    if (!this.assertControl()) return;
    if (!this.opts.getVideoId()) return;
    this.opts.player.play();
    this.broadcast("play", true);
  }

  localPause(): void {
    if (!this.assertControl()) return;
    if (!this.opts.getVideoId()) return;
    this.opts.player.pause();
    this.broadcast("pause", true);
  }

  localSeek(time: number): void {
    if (!this.assertControl()) return;
    if (!this.opts.getVideoId()) return;
    this.opts.player.seek(time);
    // Pass the TARGET: player.getTime() still reports the pre-seek position
    // while YT processes seekTo asynchronously — a pause a beat later used
    // to capture that stale 31.3s and broadcast it as room truth.
    this.broadcast("seek", true, time);
  }

  localLoad(videoId: string, autoplay = true): void {
    if (!this.assertControl()) return;
    this.opts.player.load(videoId, 0, autoplay);
    this.localRef = { videoId, time: 0, playing: autoplay, sentAt: nowMs() };
    this.opts.onLocalState({ videoId, time: 0, playing: autoplay });
    const { selfId } = this.opts.getRole();
    this.outGap.allow(selfId); // occupy the outbound gap so a burst coalesces after the load
    void this.opts.transport.send("control", {
      videoId,
      time: 0,
      playing: autoplay,
      sentAt: this.localRef.sentAt,
      senderId: this.opts.getRole().selfId,
      senderName: "",
      action: "load",
      notify: true,
    } satisfies ControlPayload);
  }

  applyLoadedState(target: PlaybackTarget): void {
    this.localRef = { ...target, sentAt: nowMs() };
    this.lastRemoteAt = nowMs();
    this.opts.onLocalState(target);
  }

  requestSync(): void {
    if (!this.syncReqGap.allow("sync-request")) return;
    void this.opts.transport.send("sync-request", { senderId: this.opts.getRole().selfId });
  }

  sendSnapshot(snapshot: Omit<RoomSnapshot, "sentAt" | "time" | "playing" | "videoId" | "senderId"> & Partial<PlaybackPayload>): void {
    const videoId = snapshot.videoId ?? this.localRef.videoId ?? "";
    const playing = snapshot.playing ?? this.localRef.playing;
    const time =
      snapshot.time ??
      (this.opts.player.ready() ? this.opts.player.getTime() : this.localRef.time);
    const payload: RoomSnapshot = {
      ...snapshot,
      senderId: this.opts.getRole().selfId,
      videoId,
      time,
      playing,
      sentAt: nowMs(),
    };
    if (videoId) this.localRef = { videoId, time, playing, sentAt: payload.sentAt };
    void this.opts.transport.send("snapshot", payload);
  }

  /**
   * Drop out-of-date payloads without mixing clocks across senders: a
   * single global sentAt rejected everything from a peer whose clock lags
   * the previous sender's (the host's clock would silently mute a
   * granted guest's controls). Order is tracked per senderId — replaying an
   * old capture from that same sender is still rejected.
   */
  private isStale(senderId: string | undefined, sentAt: number): boolean {
    const key = String(senderId || "?");
    const prev = this.lastAppliedFrom[key] ?? 0;
    if (sentAt < prev) return true;
    this.lastAppliedFrom[key] = sentAt;
    return false;
  }

  applyControl(raw: unknown): void {
    const p = raw as ControlPayload | null;
    if (!p || !p.videoId || typeof p.sentAt !== "number") return;
    // REST-fallback broadcasts are echoed back to their sender; a client's own
    // junk (e.g. an answer from a not-yet-loaded player) must never apply.
    if (p.senderId && p.senderId === this.opts.getRole().selfId) return;
    if (typeof p.time !== "number" || !Number.isFinite(p.time)) return;
    if (!this.inboundControl.allow(String(p.senderId || "?"))) return;
    if (!this.isTrustedSender(p.senderId)) return;
    if (this.isStale(p.senderId, p.sentAt)) return;
    this.applyPayload(p, p.notify ? p.senderName : "");
  }

  applySnapshot(raw: unknown): void {
    const p = raw as RoomSnapshot | null;
    if (!p || typeof p.sentAt !== "number") return;
    if (!p.videoId) return;
    if (p.senderId && p.senderId === this.opts.getRole().selfId) return;
    if (typeof p.time !== "number" || !Number.isFinite(p.time)) return;
    if (!this.isTrustedSender(p.senderId)) return;
    if (this.isStale(p.senderId, p.sentAt)) return;
    this.applyPayload(p, "");
  }

  private applyPayload(p: PlaybackPayload & { action?: ControlPayload["action"]; senderName?: string }, notifyFrom: string): void {
    if (!this.opts.player.ready()) {
      // Player (YouTube iframe) still warming up — common right after a
      // refresh. Hold the latest payload and flush it once ready instead of
      // dropping it (which used to leave the rejoiner at 0s).
      this.pendingRemote = { payload: { ...p }, notifyFrom };
      return;
    }
    const age = clamp((nowMs() - p.sentAt) / 1000, 0, 15);
    const target = Math.max(0, p.time + (p.playing ? age : 0));
    const currentVideo = this.opts.getVideoId();
    const changedVideo = currentVideo !== p.videoId;

    this.applying = true;
    if (this.applyTimer) clearTimeout(this.applyTimer);
    this.applyTimer = setTimeout(() => {
      this.applying = false;
    }, 900);

    if (changedVideo) {
      this.opts.player.load(p.videoId, target, p.playing);
    } else {
      const cur = this.opts.player.getTime();
      if (Math.abs(cur - target) > 0.35) this.opts.player.seek(target);
      if (p.playing) this.opts.player.play();
      else this.opts.player.pause();
    }

    this.localRef = { videoId: p.videoId, time: target, playing: p.playing, sentAt: nowMs() };
    this.lastRemoteAt = nowMs();
    this.opts.onLocalState({ videoId: p.videoId, time: target, playing: p.playing });

    if (notifyFrom) {
      const name = notifyFrom || "Someone";
      if (changedVideo) this.opts.onRemoteAction(`${name} shared a video`);
      else if (p.action === "pause") this.opts.onRemoteAction(`${name} paused`);
      else if (p.action === "play") this.opts.onRemoteAction(`${name} pressed play`);
      else if (p.action === "seek") this.opts.onRemoteAction(`${name} skipped`);
    }
  }

  /** Apply a remote payload that arrived while the player was still loading. */
  flushPendingRemote(): void {
    if (!this.pendingRemote || !this.opts.player.ready()) return;
    const { payload, notifyFrom } = this.pendingRemote;
    this.pendingRemote = null;
    this.applyPayload(payload, notifyFrom);
  }

  private respondToSyncRequest(payload?: { senderId?: string } | null): void {
    if (!this.started || !this.syncRespondGap.allow("respond")) return;
    const { selfId } = this.opts.getRole();
    // Self-echo: REST-fallback sends come back to us — never answer ourselves.
    if (payload?.senderId && payload.senderId === selfId) return;
    const videoId = this.opts.getVideoId();
    if (!videoId) return;
    // Only answer with state we have actually loaded: a joiner whose player
    // hasn't cued the room video yet has nothing truthful to say, and its
    // empty answer used to seek everyone else to 0.
    if (this.localRef.videoId !== videoId) return;
    setTimeout(
      () => {
        const current = this.opts.getVideoId();
        if (!current) return;
        const time = this.opts.player.ready() ? this.opts.player.getTime() : this.localRef.time;
        const playing = this.opts.player.ready()
          ? this.opts.player.isPlaying()
          : this.localRef.playing;
        void this.opts.transport.send("control", {
          videoId: current,
          time,
          playing,
          sentAt: nowMs(),
          senderId: this.opts.getRole().selfId,
          senderName: "",
          action: playing ? "play" : "pause",
          notify: false,
        } satisfies ControlPayload);
      },
      80 + Math.random() * 220,
    );
  }

  handlePlayerEnded(): void {
    this.opts.onEnded();
  }

  tick(now = nowMs()): void {
    if (!this.started || this.applying) return;
    if (!this.opts.player.ready()) return;
    this.flushPendingRemote();
    if (!this.started || this.applying) return;
    if (this.localRef.sentAt) {
      const expected = this.localRef.playing
        ? computeExpectedTime(this.localRef, now)
        : this.localRef.time;
      this.lastDrift = Math.abs(this.opts.player.getTime() - expected);
    }
    if (!this.localRef.playing) {
      // The reverse phantom: intent says paused but the player is actually
      // running (blocked-autoplay toggle races, YT resuming after a gesture).
      // Without this the tab keeps advancing while everyone believes the room
      // is paused — persisted rows, sync answers, and the drift chip all lie.
      if (this.opts.player.isPlaying()) {
        if (!this.blockSince) {
          this.blockSince = now;
          return;
        }
        if (now - this.blockSince < 3000) return;
        this.blockSince = 0;
        this.opts.player.pause();
        // Rebase to where the player actually ended up: leaving localRef at
        // the pre-phantom time made the paused-position correction below
        // seek everyone backwards.
        const time = this.opts.player.getTime();
        this.localRef = { ...this.localRef, time, playing: false, sentAt: now };
        this.opts.onLocalState({ videoId: this.localRef.videoId, time, playing: false });
        return;
      }
      this.blockSince = 0;
      // Cue/load quantization (a resume at 130.68s landing at 131.0s) shows
      // a permanent fake drift otherwise. Only correct SMALL drifts: a large
      // gap while paused means a stale baseline, and rewinding the player
      // that far would be worse than showing the drift.
      const actual = this.opts.player.getTime();
      const pausedDrift = Math.abs(actual - this.localRef.time);
      if (pausedDrift > 0.35 && pausedDrift < 2) {
        this.opts.player.seek(this.localRef.time);
      }
      return;
    }
    if (!this.opts.player.isPlaying()) {
      // BUFFERING (YT state 3) is a transient load that resumes on its own;
      // any other non-playing state while our intent says "playing" means
      // the start was blocked (autoplay without a gesture) or playback
      // stopped without an event. Sustained for ~3s, settle the intent to
      // paused so the pill, drift, and sync answers reflect the real player
      // instead of a phantom position racing ahead of a static frame.
      if ((this.opts.player.getState?.() ?? null) === 3) {
        this.blockSince = 0;
        return;
      }
      if (!this.blockSince) {
        this.blockSince = now;
        return;
      }
      if (now - this.blockSince < 3000) return;
      this.blockSince = 0;
      const time = this.opts.player.getTime();
      this.localRef = { ...this.localRef, time, playing: false, sentAt: now };
      this.opts.onLocalState({ videoId: this.localRef.videoId, time, playing: false });
      return;
    }
    this.blockSince = 0;
    const actual = this.opts.player.getTime();
    const correction = computeDriftCorrection(this.localRef, actual, now);
    if (correction === null) return;
    this.applying = true;
    if (this.applyTimer) clearTimeout(this.applyTimer);
    this.applyTimer = setTimeout(() => {
      this.applying = false;
    }, 700);
    this.opts.player.seek(correction);
    this.localRef = { ...this.localRef, time: correction, sentAt: now };
  }

  /** Seconds between our playback position and the host's expected position. */
  getLastDrift(): number | null {
    return this.lastDrift;
  }

  /**
   * Whether our baseline can be trusted as room truth: we are the host (we
   * define the room state), or a remote answer/row arrived within maxAgeMs.
   * A client whose local state never got corroborated must not claim "in sync".
   */
  hasAuthoritativeSync(maxAgeMs: number): boolean {
    const { selfId, hostId } = this.opts.getRole();
    if (hostId && selfId === hostId) return true;
    return this.lastRemoteAt > 0 && nowMs() - this.lastRemoteAt <= maxAgeMs;
  }

  isApplyingRemote(): boolean {
    return this.applying;
  }
}
