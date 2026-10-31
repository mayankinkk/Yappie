/**
 * Invite sharing: the native share sheet on touch devices, clipboard on
 * desktop. Copy-to-clipboard alone is a desktop mental model — phones have
 * a share target for every messaging app the invite is destined for.
 */

export function inviteLink(code: string): string {
  return `${location.origin}${location.pathname}?room=${encodeURIComponent(code)}`;
}

/** Touch-like device with a native share sheet worth opening. */
export function canNativeShare(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.share === "function" &&
    typeof window !== "undefined" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}

function isUserCancel(e: unknown): boolean {
  return e instanceof DOMException && (e.name === "AbortError" || e.name === "NotAllowedError");
}

/**
 * Share the room invite: native sheet on phones, clipboard elsewhere.
 * A cancelled sheet is not an error — no fallback prompt, no toast.
 */
export async function shareInvite(code: string, toast?: (text: string) => void): Promise<void> {
  const link = inviteLink(code);
  if (canNativeShare()) {
    try {
      await navigator.share({
        title: "Join my Yappie room",
        text: `Join my watch party — room ${code}`,
        url: link,
      });
      return;
    } catch (e) {
      if (isUserCancel(e)) return;
      // Share failed (permissions, no target) — fall through to the clipboard.
    }
  }
  try {
    await navigator.clipboard.writeText(link);
    toast?.("Invite link copied");
  } catch {
    window.prompt("Copy this invite link:", link);
  }
}
