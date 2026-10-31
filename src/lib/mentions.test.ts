import { describe, expect, it } from "vitest";
import { messageMentions, splitMentions } from "./mentions";

describe("messageMentions", () => {
  it("matches the name after @", () => {
    expect(messageMentions("yo @Ada check this", "Ada")).toBe(true);
    expect(messageMentions("@ada", "Ada")).toBe(true);
    expect(messageMentions("hey @ADA!", "Ada")).toBe(true);
  });

  it("rejects partial and unrelated names", () => {
    expect(messageMentions("@Alpha is here", "Al")).toBe(false);
    expect(messageMentions("no mention here", "Ada")).toBe(false);
    expect(messageMentions("@other Ada", "Ada")).toBe(false);
  });

  it("does not read emails as mentions", () => {
    expect(messageMentions("mail ada@example.com now", "example.com")).toBe(false);
    expect(messageMentions("write ada@lovelace.dev", "lovelace.dev")).toBe(false);
    expect(messageMentions("a@Ada", "Ada")).toBe(false);
  });

  it("handles multi-word names with boundaries", () => {
    expect(messageMentions("@Al Pacino fan", "Al Pacino")).toBe(true);
    expect(messageMentions("@Al Pacino2 fan", "Al Pacino")).toBe(false);
    expect(messageMentions("(@Al Pacino)", "Al Pacino")).toBe(true);
  });

  it("treats empty/overlong names as never mentioned", () => {
    expect(messageMentions("@Ada", "")).toBe(false);
    expect(messageMentions("@Ada", "   ")).toBe(false);
    expect(messageMentions(`@${"x".repeat(25)}`, "x".repeat(25))).toBe(false);
  });
});

describe("splitMentions", () => {
  it("splits a message into mention and plain segments", () => {
    const segs = splitMentions("hi @Ada, look", ["Ada"]);
    expect(segs).toEqual([
      { text: "hi ", mention: false },
      { text: "@Ada", mention: true },
      { text: ", look", mention: false },
    ]);
  });

  it("keeps the whole message plain when nobody is named", () => {
    expect(splitMentions("hello world", ["Ada"])).toEqual([{ text: "hello world", mention: false }]);
    expect(splitMentions("hello", [])).toEqual([{ text: "hello", mention: false }]);
  });

  it("prefers the longer name when one contains the other", () => {
    const segs = splitMentions("@Al Pacino rocks", ["Al", "Al Pacino"]);
    expect(segs).toEqual([
      { text: "@Al Pacino", mention: true },
      { text: " rocks", mention: false },
    ]);
  });

  it("splits multiple mentions in one message", () => {
    const segs = splitMentions("@Ada and @Bob", ["Ada", "Bob"]);
    expect(segs).toEqual([
      { text: "@Ada", mention: true },
      { text: " and ", mention: false },
      { text: "@Bob", mention: true },
    ]);
  });

  it("skips email-shaped @", () => {
    const segs = splitMentions("mail a@Ada now", ["Ada"]);
    expect(segs.every((s) => !s.mention)).toBe(true);
  });
});
