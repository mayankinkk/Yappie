import type { PlayerAdapter, PlayerLocalEvent } from "../types";

declare global {
  interface Window {
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytReadyPromise: Promise<void> | null = null;

function loadApi(): Promise<void> {
  if (!ytReadyPromise) {
    ytReadyPromise = new Promise((resolve, reject) => {
      if (window.YT?.Player) {
        resolve();
        return;
      }
      const existing = document.querySelector<HTMLScriptElement>("script[data-yt-api]");
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        prev?.();
        resolve();
      };
      if (existing) return;
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      s.async = true;
      s.dataset.ytApi = "1";
      s.onerror = () => reject(new Error("Failed to load YouTube API"));
      document.head.appendChild(s);
    });
  }
  return ytReadyPromise;
}

export class YouTubePlayer implements PlayerAdapter {
  private host: HTMLElement;
  private player: YT.Player | null = null;
  private readyState = false;
  private cb: ((e: PlayerLocalEvent) => void) | null = null;
  private currentVideoId: string | null = null;
  private muted = false;
  private volume = 100;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  async init(): Promise<void> {
    await loadApi();
    if (this.player) return;
    this.player = new YT.Player(this.host, {
      playerVars: {
        controls: 0,
        modestbranding: 1,
        rel: 0,
        playsinline: 1,
        iv_load_policy: 3,
        disablekb: 1,
        origin: location.protocol.startsWith("http") ? location.origin : undefined,
      },
      events: {
        onReady: () => {
          this.readyState = true;
          if (this.muted) this.player?.mute();
          this.player?.setVolume(this.volume);
          this.cb?.({ type: "ready" });
        },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.ENDED) this.cb?.({ type: "ended" });
        },
        onError: (e) => {
          this.cb?.({ type: "error", code: e.data });
        },
      },
    });
  }

  ready(): boolean {
    return this.readyState && this.player !== null;
  }

  load(videoId: string, time: number, autoplay: boolean): void {
    if (!this.player || !this.readyState) return;
    this.currentVideoId = videoId;
    if (autoplay) this.player.loadVideoById({ videoId, startSeconds: time });
    else this.player.cueVideoById({ videoId, startSeconds: time });
  }

  play(): void {
    this.player?.playVideo();
  }

  pause(): void {
    this.player?.pauseVideo();
  }

  seek(time: number): void {
    this.player?.seekTo(time, true);
  }

  getTime(): number {
    return this.player?.getCurrentTime() || 0;
  }

  getDuration(): number {
    return this.player?.getDuration() || 0;
  }

  isPlaying(): boolean {
    return this.player?.getPlayerState() === YT.PlayerState.PLAYING;
  }

  getState(): YT.PlayerState | null {
    return this.player?.getPlayerState() ?? null;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (!this.player || !this.readyState) return;
    if (muted) this.player.mute();
    else this.player.unMute();
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(100, volume));
    if (!this.player || !this.readyState) return;
    this.player.setVolume(this.volume);
  }

  getCurrentVideoId(): string | null {
    return this.currentVideoId;
  }

  destroy(): void {
    try {
      this.player?.destroy();
    } catch {
      /* already gone */
    }
    this.player = null;
    this.readyState = false;
    this.host.innerHTML = "";
  }

  onLocalEvent(cb: (e: PlayerLocalEvent) => void): void {
    this.cb = cb;
  }
}
