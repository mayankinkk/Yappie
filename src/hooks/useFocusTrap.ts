import { useEffect, type RefObject } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Modal focus trap: moves focus into the overlay when it opens, keeps Tab /
 * Shift+Tab cycling inside it (even if focus somehow escaped), closes on
 * Escape, and restores focus to whatever had it before the overlay appeared.
 * `active` gates the trap so conditionally-rendered overlays clean up on
 * unmount while always-mounted components (a gear button + card) re-arm per
 * open.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onEscape?: () => void,
): void {
  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (!el) return;
    const container: HTMLElement = el;
    const previous = document.activeElement as HTMLElement | null;

    const focusables = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );

    // After paint, so overlay children exist (and any autoFocus has settled).
    const raf = requestAnimationFrame(() => {
      const first = focusables()[0];
      (first ?? container).focus();
    });

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onEscape?.();
        return;
      }
      if (e.key !== "Tab") return;
      const els = focusables();
      if (!els.length) {
        e.preventDefault();
        return;
      }
      const first = els[0];
      const last = els[els.length - 1];
      const current = document.activeElement;
      const inside = !!current && container.contains(current);
      if (e.shiftKey) {
        if (!inside || current === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (!inside || current === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey);
      if (previous && typeof previous.focus === "function") previous.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}
