type FullscreenCapable = HTMLElement & {
  webkitRequestFullscreen?: () => void;
};

type FullscreenDoc = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

export function activeFullscreenElement(): Element | null {
  const doc = document as FullscreenDoc;
  return document.fullscreenElement || doc.webkitFullscreenElement || null;
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
  if (el?.requestFullscreen) void el.requestFullscreen();
  else el?.webkitRequestFullscreen?.();
}
