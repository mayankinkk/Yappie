import type { ControlPayload, PlaybackPayload, PlaybackTarget, PlayerAdapter, RoomSnapshot, Transport } from "../types";
import { clamp, nowMs } from "../lib/time";

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
  getRole: () => { selfId: string; hostId: string; guestsCanControl: boolean };
  getVideoId: () => string | null;
  onLocalState: (s: { videoId: string | null; time: number; playing: boolean }) => void;
  onRemoteAction: (text: string) => void;
  onDenied: () => void;
  onControlRequested: (name: string) => void;
  onEnded: () => void;
}

const EVENTS = ["control", "snapshot", "sync-request", "control-request"] as const;

export class SyncEngine {
  private opts: SyncEngineOptions;
  private localRef: PlaybackPayload = { videoId: "", time: 0, playing: false, sentAt: 0 };
  private lastAppliedSentAt = 0;
  private applying = false;
  private applyTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribers: Array<() => void> = [];
  private started = false;

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
      "sync-request": () => this.respondToSyncRequest(),
      "control-request": (p) => {
        const name = (p as { senderName?: string } | null)?.senderName || "Someone";
        this.opts.onControlRequested(name);
      },
    };
    for (const ev of EVENTS) transport.on(ev, handlers[ev]);
  }

  destroy(): void {
    this.started = false;
    if (this.applyTimer) clearTimeout(this.applyTimer);
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
    const { hostId, guestsCanControl } = this.opts.getRole();
    if (guestsCanControl) return true;
    return !!hostId && senderId === hostId;
  }

  getLocalRef(): PlaybackPayload {
    return { ...this.localRef };
  }

  canControl(): boolean {
    const { selfId, hostId, guestsCanControl } = this.opts.getRole();
    return selfId === hostId || guestsCanControl;
  }

  private assertControl(): boolean {
    if (!this.canControl()) {
      this.opts.onDenied();
      void this.opts.transport.send("control-request", { senderName: this.opts.getRole().selfId });
      return false;
    }
    return true;
  }

  private broadcast(action: ControlPayload["action"], notify: boolean): void {
    const videoId = this.opts.getVideoId();
    if (!videoId) return;
    const time = this.opts.player.ready() ? this.opts.player.getTime() : this.localRef.time;
    const playing = this.opts.player.ready()
      ? this.opts.player.isPlaying()
      : this.localRef.playing;
    const { selfId } = this.opts.getRole();
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
    this.localRef = { videoId, time, playing, sentAt: payload.sentAt };
    this.opts.onLocalState({ videoId, time, playing });
    void this.opts.transport.send("control", payload);
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
    this.broadcast("seek", true);
  }

  localLoad(videoId: string, autoplay = true): void {
    if (!this.assertControl()) return;
    this.opts.player.load(videoId, 0, autoplay);
    this.localRef = { videoId, time: 0, playing: autoplay, sentAt: nowMs() };
    this.opts.onLocalState({ videoId, time: 0, playing: autoplay });
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
    this.opts.onLocalState(target);
  }

  requestSync(): void {
    void this.opts.transport.send("sync-request", {});
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

  applyControl(raw: unknown): void {
    const p = raw as ControlPayload | null;
    if (!p || !p.videoId || typeof p.sentAt !== "number") return;
    if (!this.isTrustedSender(p.senderId)) return;
    if (p.sentAt < this.lastAppliedSentAt) return;
    this.lastAppliedSentAt = p.sentAt;
    this.applyPayload(p, p.notify ? p.senderName : "");
  }

  applySnapshot(raw: unknown): void {
    const p = raw as RoomSnapshot | null;
    if (!p || typeof p.sentAt !== "number") return;
    if (p.sentAt < this.lastAppliedSentAt) return;
    if (!p.videoId) return;
    if (!this.isTrustedSender(p.senderId)) return;
    this.lastAppliedSentAt = p.sentAt;
    this.applyPayload(p, "");
  }

  private applyPayload(p: PlaybackPayload & { action?: ControlPayload["action"]; senderName?: string }, notifyFrom: string): void {
    if (!this.opts.player.ready()) return;
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
    this.opts.onLocalState({ videoId: p.videoId, time: target, playing: p.playing });

    if (notifyFrom) {
      const name = notifyFrom || "Someone";
      if (changedVideo) this.opts.onRemoteAction(`${name} shared a video`);
      else if (p.action === "pause") this.opts.onRemoteAction(`${name} paused`);
      else if (p.action === "play") this.opts.onRemoteAction(`${name} pressed play`);
      else if (p.action === "seek") this.opts.onRemoteAction(`${name} skipped`);
    }
  }

  private respondToSyncRequest(): void {
    const videoId = this.opts.getVideoId();
    if (!videoId) return;
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
    if (!this.localRef.playing) return;
    if (!this.opts.player.ready()) return;
    if (!this.opts.player.isPlaying()) return;
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

  isApplyingRemote(): boolean {
    return this.applying;
  }
}
