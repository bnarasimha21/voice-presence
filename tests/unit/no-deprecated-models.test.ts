import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

// Issue 4 acceptance criterion: no deprecated model id appears in the
// source. `eleven_turbo_v2_5` is deprecated in favour of
// `eleven_flash_v2_5`; config.ts is the only place a TTS model id should
// live, and it should not default to the deprecated one.

const SOURCE_DIRS = ["app", "lib", "components"];
const ROOT = join(__dirname, "..", "..");

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("no deprecated ElevenLabs model id in source", () => {
  it("never references eleven_turbo", () => {
    const hits: string[] = [];
    for (const dir of SOURCE_DIRS) {
      for (const file of listFiles(join(ROOT, dir))) {
        const content = readFileSync(file, "utf8");
        if (content.includes("eleven_turbo")) hits.push(file);
      }
    }
    expect(hits).toEqual([]);
  });
});
