export interface Profile {
  id: string;
  name: string;
  color: number;
}

export interface Participant {
  id: string;
  name: string;
  color: number;
  joinedAt: number;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  name: string;
  color: number;
  text: string;
  ts: number;
  reactions: Record<string, string[]>;
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

export interface ToastItem {
  id: string;
  text: string;
  kind: "info" | "error";
  ts?: number;
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
  setMuted(muted: boolean): void;
  setVolume(volume: number): void;
  setCaptionsEnabled(on: boolean): void;
  destroy(): void;
  onLocalEvent(cb: (e: PlayerLocalEvent) => void): void;
}

export interface Transport {
  send(event: string, payload: unknown): Promise<void> | void;
  on(event: string, cb: (payload: unknown) => void): void;
}
