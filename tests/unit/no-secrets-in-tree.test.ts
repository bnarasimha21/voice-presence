import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { readFileSync } from "fs";

// Issue 1: fails if any git-tracked file contains a value shaped like a
// real Anthropic or ElevenLabs key. Checks tracked files only (via
// `git ls-files`), not the whole working tree, so an untracked local
// `.env.local` with a real key does not fail this test and is never read
// by it.

const SECRET_PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{20,}/, // Anthropic key shape
  /\bxi-[A-Za-z0-9]{20,}\b/, // ElevenLabs key shape, if ever prefixed this way
];

describe("no secret-shaped values in tracked files", () => {
  it("scans every git-tracked text file", () => {
    const root = execSync("git rev-parse --show-toplevel", { cwd: __dirname })
      .toString()
      .trim();
    const files = execSync("git ls-files", { cwd: root })
      .toString()
      .split("\n")
      .filter(Boolean);

    const hits: string[] = [];
    for (const file of files) {
      let content: string;
      try {
        content = execSync(`git show HEAD:"${file}"`, { cwd: root }).toString();
      } catch {
        // Not committed yet (new file in the working tree); read it directly.
        try {
          content = readFileSync(join(root, file), "utf8");
        } catch {
          continue;
        }
      }
      for (const pattern of SECRET_PATTERNS) {
        if (pattern.test(content)) hits.push(file);
      }
    }
    expect(hits).toEqual([]);
  });
});

function join(a: string, b: string): string {
  return `${a}/${b}`;
}
