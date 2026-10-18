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
 * Touch devices that can't lock orientation (iOS/iPadOS Safari). There, an
 * element fullscreen of our portrait-shaped .cinema never rotates, and
 * screen.orientation.lock doesn't exist — but YouTube's *native* fullscreen
 * button opens the native video player, which does go landscape. So on those
 * devices we hand playback chrome over to YouTube (controls: 1, no hotzone,
 * no custom bar); everything else keeps the custom controls.
 */
export function needsNativeYoutubeControls(): boolean {
  if (typeof window === "undefined") return false;
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  const canLock =
    typeof screen !== "undefined" && !!screen.orientation && "lock" in screen.orientation;
  return coarse && !canLock;
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
