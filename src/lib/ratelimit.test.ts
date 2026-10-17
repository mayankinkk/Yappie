import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RateLimiter, MinGap } from "./ratelimit";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RateLimiter", () => {
  it("allows up to the limit within the window", () => {
    const rl = new RateLimiter(3, 1000);
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(false);
  });

  it("tracks keys independently", () => {
    const rl = new RateLimiter(1, 1000);
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("b")).toBe(true);
    expect(rl.allow("a")).toBe(false);
  });

  it("frees capacity after the window slides", () => {
    const rl = new RateLimiter(2, 1000);
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(true);
    expect(rl.allow("a")).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(rl.allow("a")).toBe(true);
  });

  it("keeps working across many distinct keys (no unbounded growth)", () => {
    const rl = new RateLimiter(5, 1000, 10);
    for (let i = 0; i < 500; i++) expect(rl.allow(`k${i}`)).toBe(true);
    // eviction happens internally; behavior for a fresh key must stay correct
    expect(rl.allow("fresh")).toBe(true);
  });

  it("reset clears all state", () => {
    const rl = new RateLimiter(1, 1000);
    expect(rl.allow("a")).toBe(true);
    rl.reset();
    expect(rl.allow("a")).toBe(true);
  });
});

describe("MinGap", () => {
  it("blocks events closer than the gap", () => {
    const gap = new MinGap(500);
    expect(gap.allow("a")).toBe(true);
    expect(gap.allow("a")).toBe(false);
    vi.advanceTimersByTime(501);
    expect(gap.allow("a")).toBe(true);
  });

  it("tracks keys independently", () => {
    const gap = new MinGap(500);
    expect(gap.allow("a")).toBe(true);
    expect(gap.allow("b")).toBe(true);
  });
});
