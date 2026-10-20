export interface RecentRoom {
  code: string;
  at: number;
}

const KEY = "yappie.recentRooms";
const MAX = 5;

export function loadRecentRooms(): RecentRoom[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (r): r is RecentRoom =>
          !!r &&
          typeof r === "object" &&
          typeof (r as RecentRoom).code === "string" &&
          typeof (r as RecentRoom).at === "number",
      )
      .filter((r) => r.code.length === 6)
      .slice(0, MAX);
  } catch {
    return [];
  }
}

export function rememberRoom(code: string): RecentRoom[] {
  const clean = code.toUpperCase();
  if (clean.length !== 6) return loadRecentRooms();
  const next = [
    { code: clean, at: Date.now() },
    ...loadRecentRooms().filter((r) => r.code !== clean),
  ].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage full/blocked — recent list is best-effort */
  }
  return next;
}
