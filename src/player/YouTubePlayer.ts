import type { PlayerAdapter, PlayerLocalEvent } from "../types";
import { needsNativeYoutubeControls } from "../lib/fullscreen";
import { captionsEnabled } from "../lib/captions";

// loadModule/unloadModule exist on the real player but not in @types/youtube.
type ModuleCapable = YT.Player & {
  loadModule?: (name: string) => void;
  unloadModule?: (name: string) => void;
};

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
  private captions = captionsEnabled();
  private suppressLoop: number | null = null;
  private destroyed = false;
  private destroyed = false;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  // unloadModule kills the captions module, but YouTube re-fetches caption
  // data when a video loads — observed captions creeping back ~5s after a
  // load. Re-suppress on an interval for a bounded window after playback
  // starts, then stop (harmless no-op calls when already suppressed).
  private suppressCaptions(): void {
    const p = this.player as ModuleCapable | null;
    if (!p) return;
    try {
      p.unloadModule?.("captions");
      p.unloadModule?.("cc");
    } catch {
      /* module API unavailable */
    }
  }

  private startSuppressLoop(): void {
    this.stopSuppressLoop();
    this.suppressCaptions();
    this.suppressLoop = window.setInterval(() => this.suppressCaptions(), 2000);
    window.setTimeout(() => this.stopSuppressLoop(), 20000);
  }

  private stopSuppressLoop(): void {
    if (this.suppressLoop !== null) {
      window.clearInterval(this.suppressLoop);
      this.suppressLoop = null;
    }
  }

  async init(): Promise<void> {
    await loadApi();
    // React StrictMode mounts → destroys → remounts; the first instance's
    // init() resumes after its own destroy() and would otherwise create a
    // zombie YT.Player on the recycled host element.
    if (this.destroyed || this.player) return;
    this.player = new YT.Player(this.host, {
      playerVars: {
        controls: needsNativeYoutubeControls() ? 1 : 0,
        modestbranding: 1,
        rel: 0,
        playsinline: 1,
        iv_load_policy: 3,
        disablekb: 1,
        origin: location.protocol.startsWith("http") ? location.origin : undefined,
      },
      events: {
        onReady: () => {
          if (this.destroyed) return;
          this.readyState = true;
          if (this.muted) this.player?.mute();
          this.player?.setVolume(this.volume);
          if (!this.captions) this.startSuppressLoop();
          this.cb?.({ type: "ready" });
        },
        onStateChange: (e) => {
          if (e.data === YT.PlayerState.PLAYING && !this.captions) this.startSuppressLoop();
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

  setCaptionsEnabled(on: boolean): void {
    this.captions = on;
    if (!on) {
      if (this.readyState) this.startSuppressLoop();
      return;
    }
    this.stopSuppressLoop();
    if (!this.player || !this.readyState) return;
    try {
      (this.player as ModuleCapable).loadModule?.("captions");
    } catch {
      /* module API unavailable */
    }
  }

  getCurrentVideoId(): string | null {
    return this.currentVideoId;
  }

  destroy(): void {
    this.destroyed = true;
    this.stopSuppressLoop();
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
