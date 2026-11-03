// Runs once at server startup (Next.js instrumentation hook). Issue 16:
// refuse to boot in production with a placeholder or too-short secret
// rather than silently running with one a deployer forgot to replace.
import { assertSecretsAreRealInProduction } from "@/lib/config";

export function register() {
  assertSecretsAreRealInProduction();
}
