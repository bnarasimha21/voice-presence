import { describe, it, expect } from "vitest";
import { SentenceChunker } from "@/lib/chunker";

describe("SentenceChunker", () => {
  it("emits a complete sentence as soon as punctuation and whitespace arrive", () => {
    const c = new SentenceChunker();
    expect(c.push("Hello")).toEqual([]);
    expect(c.push(" there. ")).toEqual(["Hello there."]);
  });

  it("holds a trailing partial sentence until flush", () => {
    const c = new SentenceChunker();
    c.push("First sentence. Second part");
    expect(c.flush()).toBe("Second part");
  });

  it("returns null from flush when nothing is buffered", () => {
    const c = new SentenceChunker();
    c.push("Done.");
    c.flush(); // drains nothing extra since "Done." was already emitted
    expect(c.flush()).toBeNull();
  });

  it("handles multiple sentences arriving in one delta", () => {
    const c = new SentenceChunker();
    const out = c.push("One. Two! Three?");
    expect(out).toEqual(["One.", "Two!"]);
    expect(c.flush()).toBe("Three?");
  });
});
