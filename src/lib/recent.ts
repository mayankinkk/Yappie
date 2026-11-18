export interface RecentRoom {
  code: string;
  at: number;
}

const KEY = "yappie.recentRooms";
const MAX = 5;
/** Don't keep every recent room forever: drop entries untouched for 2 days,
 * so abandoned rooms don't clutter the recents list. */
const MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000;

function now(): number {
  return Date.now();
}

export function loadRecentRooms(): RecentRoom[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    const cutoff = now() - MAX_AGE_MS;
    return raw
      .filter(
        (r): r is RecentRoom =>
          !!r &&
          typeof r === "object" &&
          typeof (r as RecentRoom).code === "string" &&
          typeof (r as RecentRoom).at === "number",
      )
      .filter((r) => r.code.length === 6)
      .filter((r) => r.at >= cutoff) // expire old entries instead of keeping them all
      .sort((a, b) => b.at - a.at) // newest first, so the cap keeps the relevant ones
      .slice(0, MAX);
  } catch {
    return [];
  }
}

export function rememberRoom(code: string): RecentRoom[] {
  const clean = code.toUpperCase();
  if (clean.length !== 6) return loadRecentRooms();
  const next = [
    { code: clean, at: now() },
    ...loadRecentRooms().filter((r) => r.code !== clean),
  ].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage full/blocked — recent list is best-effort */
  }
  return next;
}
