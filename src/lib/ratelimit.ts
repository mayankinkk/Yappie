/**
 * Small, dependency-free rate limiters used on both sides of the wire:
 *  - senders drop their own excess before it hits the network
 *  - receivers drop other clients' excess on arrival (defense against
 *    modified clients that skip the sender-side guards)
 *
 * Server-side Supabase Realtime already caps each connection at
 * `eventsPerSecond` (20) — these add per-event-type, per-identity budgets.
 */

export class RateLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 300,
  ) {}

  /** Returns true when another event from `key` is allowed right now. */
  allow(key: string): boolean {
    const now = Date.now();
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return false;
    }
    arr.push(now);
    this.hits.set(key, arr);
    this.evict(now);
    return true;
  }

  private evict(now: number): void {
    if (this.hits.size <= this.maxKeys) return;
    for (const [k, v] of this.hits) {
      if (v.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
    }
    if (this.hits.size > this.maxKeys) {
      const oldest = this.hits.keys().next();
      if (!oldest.done) this.hits.delete(oldest.value);
    }
  }

  reset(): void {
    this.hits.clear();
  }
}

/** Enforces a minimum gap between consecutive events for a key. */
export class MinGap {
  private last = new Map<string, number>();

  constructor(
    private readonly gapMs: number,
    private readonly maxKeys = 300,
  ) {}

  allow(key: string): boolean {
    const now = Date.now();
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < this.gapMs) return false;
    this.last.set(key, now);
    if (this.last.size > this.maxKeys) {
      const oldest = this.last.keys().next();
      if (!oldest.done) this.last.delete(oldest.value);
    }
    return true;
  }

  reset(): void {
    this.last.clear();
  }
}
