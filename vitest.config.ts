import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: {
      NODE_ENV: "test",
      VOICE_PROVIDERS: "fake",
      TURN_SECRET: "test-secret-do-not-use-in-prod",
      ELEVENLABS_NARSI_VOICE_ID: "fake-voice-id",
    },
  },
});
