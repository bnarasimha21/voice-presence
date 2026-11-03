import { describe, it, expect } from "vitest";
import { id3CommentFrame } from "@/lib/id3";

describe("id3CommentFrame", () => {
  it("starts with the ID3 magic bytes", () => {
    const frame = id3CommentFrame("AI-generated voice");
    const header = new TextDecoder().decode(frame.slice(0, 3));
    expect(header).toBe("ID3");
  });

  it("carries the comment text in the frame bytes", () => {
    const frame = id3CommentFrame("AI-generated voice disclosure");
    const text = new TextDecoder("utf-8", { fatal: false }).decode(frame);
    expect(text).toContain("AI-generated voice disclosure");
    expect(text).toContain("COMM");
  });
});
