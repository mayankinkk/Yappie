type FullscreenCapable = HTMLElement & {
  webkitRequestFullscreen?: () => void;
};

type FullscreenDoc = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

/** lib.dom omits ScreenOrientation.lock (non-standard); it's exactly what we need. */
type LockableOrientation = ScreenOrientation & {
  lock?: (orientation: string) => Promise<void>;
  unlock?: () => void;
};

export function activeFullscreenElement(): Element | null {
  const doc = document as FullscreenDoc;
  return document.fullscreenElement || doc.webkitFullscreenElement || null;
}

/**
 * Touch devices with no element-Fullscreen API (iPhone Safari). There our
 * .cinema can never go fullscreen, so playback chrome is handed over to
 * YouTube (controls: 1, no hotzone, no custom bar): its fullscreen button
 * lives inside the iframe we cannot overlay, and it's the only path to a
 * rotating player. The gate is the Fullscreen API itself — NOT
 * screen.orientation.lock: Firefox Android lacks lock yet element fullscreen
 * works fine, and gating on lock used to push every such Android browser
 * onto YouTube's controls, killing our fullscreen (and the floating camera
 * strip) there. Every Android browser has requestFullscreen, so it keeps the
 * custom controls and both features work.
 */
export function needsNativeYoutubeControls(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") return false;
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  const el = document.documentElement as FullscreenCapable;
  const canFullscreen = !!(el.requestFullscreen || el.webkitRequestFullscreen);
  return coarse && !canFullscreen;
}

function lockLandscape(): void {
  try {
    const so = typeof screen === "undefined" ? null : (screen.orientation as LockableOrientation | null);
    const p = so?.lock?.("landscape");
    p?.catch(() => {
      /* fullscreen already gone or lock refused — stay as-is */
    });
  } catch {
    /* unsupported — stay portrait */
  }
}

export function unlockOrientation(): void {
  try {
    const so = typeof screen === "undefined" ? null : (screen.orientation as LockableOrientation | null);
    so?.unlock?.();
  } catch {
    /* ignore */
  }
}

/** Toggle fullscreen on the .cinema wrapper (player + controls). */
export function toggleCinemaFullscreen(): void {
  const doc = document as FullscreenDoc;
  const el = document.querySelector(".cinema") as FullscreenCapable | null;
  if (activeFullscreenElement()) {
    if (document.exitFullscreen) void document.exitFullscreen();
    else void doc.webkitExitFullscreen?.();
    return;
  }
  if (el?.requestFullscreen) {
    const done = el.requestFullscreen();
    if (done && typeof done.then === "function") void done.then(lockLandscape).catch(() => {});
    else lockLandscape();
  } else if (el?.webkitRequestFullscreen) {
    el.webkitRequestFullscreen();
    lockLandscape();
  }
}

if (typeof document !== "undefined") {
  const onExit = () => {
    if (!activeFullscreenElement()) unlockOrientation();
  };
  document.addEventListener("fullscreenchange", onExit);
  document.addEventListener("webkitfullscreenchange", onExit);
}
