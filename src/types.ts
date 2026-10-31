export interface Profile {
  id: string;
  name: string;
  color: number;
  /** Emoji shown instead of initials; empty = fall back to initials. */
  avatar?: string;
}

export interface Participant {
  id: string;
  name: string;
  color: number;
  joinedAt: number;
  avatar?: string;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  name: string;
  color: number;
  avatar?: string;
  text: string;
  ts: number;
  reactions: Record<string, string[]>;
  /** Playback position the message was stamped with ("watch this moment"). */
  videoId?: string | null;
  videoTs?: number | null;
}

export interface QueueItem {
  id: string;
  videoId: string;
  title: string | null;
  addedBy: string;
  addedByName: string;
  addedAt: number;
  votes: Record<string, boolean>;
}

export interface PlaybackPayload {
  videoId: string;
  time: number;
  playing: boolean;
  sentAt: number;
}

export interface ControlPayload extends PlaybackPayload {
  senderId: string;
  senderName: string;
  action: "play" | "pause" | "seek" | "load";
  notify: boolean;
}

export interface RoomSnapshot extends PlaybackPayload {
  senderId: string;
  hostId: string;
  guestsCanControl: boolean;
  queue: QueueItem[];
  version: number;
}

export interface ReactionEvent {
  id: string;
  senderId: string;
  name: string;
  emoji: string;
  ts: number;
}

export interface FloatingReaction extends ReactionEvent {
  lane: number;
}

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: string;
  text: string;
  kind: "info" | "error";
  ts?: number;
  /** When present, the toast renders as a message with buttons instead of
   *  a click-to-dismiss pill. Bounded by ttlMs (default 3200). */
  actions?: ToastAction[];
  ttlMs?: number;
}

export interface PlaybackTarget {
  videoId: string;
  time: number;
  playing: boolean;
}

export type PlayerLocalEvent =
  | { type: "ready" }
  | { type: "ended" }
  | { type: "error"; code?: number };

export interface PlayerAdapter {
  ready(): boolean;
  load(videoId: string, time: number, autoplay: boolean): void;
  play(): void;
  pause(): void;
  seek(time: number): void;
  getTime(): number;
  isPlaying(): boolean;
  /**
   * Raw player state (YouTube: -1 unstarted, 0 ended, 1 playing, 2 paused,
   * 3 buffering, 5 cued) or null while unbound. Lets the sync engine tell a
   * blocked autoplay (cued/paused) apart from a transient buffer.
   */
  getState?(): number | null;
  setMuted(muted: boolean): void;
  setVolume(volume: number): void;
  setCaptionsEnabled(on: boolean): void;
  /** Room-wide caption track (0019). null = Auto; implementations may rebuild the embed to apply it. */
  setCaptionLanguage?(lang: string | null): void;
  destroy(): void;
  onLocalEvent(cb: (e: PlayerLocalEvent) => void): void;
}

export interface Transport {
  send(event: string, payload: unknown): Promise<void> | void;
  on(event: string, cb: (payload: unknown) => void): void;
}
