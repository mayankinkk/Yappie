/**
 * Chat @mention detection and rendering helpers.
 *
 * A mention is `@` + a known display name, matched case-insensitively with
 * word boundaries on both sides so "@Al" never lights up inside "@Alpha"
 * and "email@example.com" is never read as a mention of "example.com".
 */

const NAME_MAX = 24;

function escapeRe(v: string): string {
  return v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `text` contains a `@name` for this exact (case-insensitive) name. */
export function messageMentions(text: string, name: string | undefined | null): boolean {
  const target = (name || "").trim();
  if (!target || target.length > NAME_MAX) return false;
  const re = new RegExp(`@${escapeRe(target)}(?![\\p{L}\\p{N}_])`, "iu");
  const match = re.exec(text);
  if (!match) return false;
  const before = match.index > 0 ? text[match.index - 1] : "";
  // "a@b" / "user@host" are email-shaped, not mentions.
  return !before || !/[\p{L}\p{N}_@]/u.test(before);
}

export interface TextSegment {
  text: string;
  mention: boolean;
}

/**
 * Split `text` into plain and mention segments for highlighted rendering.
 * Longer names win so "Al Pacino" beats "Al" when both are present.
 */
export function splitMentions(text: string, names: readonly (string | undefined | null)[]): TextSegment[] {
  const valid = [
    ...new Set(
      names
        .map((n) => (n || "").trim())
        .filter((n) => n.length > 0 && n.length <= NAME_MAX),
    ),
  ].sort((a, b) => b.length - a.length);
  if (!valid.length || !text) return [{ text, mention: false }];

  const alt = valid.map(escapeRe).join("|");
  const re = new RegExp(`@(${alt})(?![\\p{L}\\p{N}_])`, "giu");

  const out: TextSegment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const before = m.index > 0 ? text[m.index - 1] : "";
    if (before && /[\p{L}\p{N}_@]/u.test(before)) continue;
    if (m.index > last) out.push({ text: text.slice(last, m.index), mention: false });
    out.push({ text: m[0], mention: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), mention: false });
  return out.length ? out : [{ text, mention: false }];
}
