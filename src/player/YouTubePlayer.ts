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
      if (window.YT?.Player && window.YT.PlayerState) {
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
  private suppressStop: number | null = null;
  private destroyed = false;

  constructor(host: HTMLElement) {
    this.host = host;
  }

  // unloadModule kills the captions module, but YouTube re-fetches caption
  // data when a video loads — observed captions creeping back ~5s after a
  // load. Re-suppress on an interval for a bounded window after playback
  // starts, then stop (harmless no-op calls when already suppressed).
  private suppressCaptions(): void {
    const p = this.api() as ModuleCapable | null;
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
    this.suppressStop = window.setTimeout(() => this.stopSuppressLoop(), 20000);
  }

  private stopSuppressLoop(): void {
    if (this.suppressLoop !== null) {
      window.clearInterval(this.suppressLoop);
      this.suppressLoop = null;
    }
    if (this.suppressStop !== null) {
      window.clearTimeout(this.suppressStop);
      this.suppressStop = null;
    }
  }

  // YT.Player handed back by the constructor may still be the pre-ready
  // shell: it has no getPlayerState until the API binds the iframe (and
  // constructing on a detached target leaves it permanently unbound).
  // Every call must go through here so early polls can never throw.
  private api(): YT.Player | null {
    const p = this.player;
    if (!p) return null;
    return typeof (p as { getPlayerState?: unknown }).getPlayerState === "function" ? p : null;
  }

  async init(): Promise<boolean> {
    await loadApi();
    // React StrictMode mounts → destroys → remounts; the first instance's
    // init() resumes after its own destroy() and would otherwise create a
    // zombie YT.Player on the recycled host element.
    if (this.destroyed || this.player) return false;
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
          if (this.muted) this.api()?.mute();
          this.api()?.setVolume(this.volume);
          if (!this.captions) this.startSuppressLoop();
          this.cb?.({ type: "ready" });
        },
        onStateChange: (e) => {
          if (this.destroyed) return;
          if (e.data === YT.PlayerState.PLAYING && !this.captions) this.startSuppressLoop();
          if (e.data === YT.PlayerState.ENDED) this.cb?.({ type: "ended" });
        },
        onError: (e) => {
          if (this.destroyed) return;
          this.cb?.({ type: "error", code: e.data });
        },
      },
    });
    return !this.destroyed;
  }

  ready(): boolean {
    return this.readyState && this.player !== null;
  }

  load(videoId: string, time: number, autoplay: boolean): void {
    const p = this.api();
    if (!p || !this.readyState) return;
    this.currentVideoId = videoId;
    if (autoplay) p.loadVideoById({ videoId, startSeconds: time });
    else p.cueVideoById({ videoId, startSeconds: time });
  }

  play(): void {
    this.api()?.playVideo();
  }

  pause(): void {
    this.api()?.pauseVideo();
  }

  seek(time: number): void {
    this.api()?.seekTo(time, true);
  }

  getTime(): number {
    return this.api()?.getCurrentTime() || 0;
  }

  getDuration(): number {
    return this.api()?.getDuration() || 0;
  }

  isPlaying(): boolean {
    return this.api()?.getPlayerState() === YT.PlayerState.PLAYING;
  }

  getState(): YT.PlayerState | null {
    return this.api()?.getPlayerState() ?? null;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    const p = this.api();
    if (!p || !this.readyState) return;
    if (muted) p.mute();
    else p.unMute();
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(100, volume));
    const p = this.api();
    if (!p || !this.readyState) return;
    p.setVolume(this.volume);
  }

  setCaptionsEnabled(on: boolean): void {
    this.captions = on;
    if (!on) {
      if (this.readyState) this.startSuppressLoop();
      return;
    }
    this.stopSuppressLoop();
    const p = this.api();
    if (!p || !this.readyState) return;
    try {
      (p as ModuleCapable).loadModule?.("captions");
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
