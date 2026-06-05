import { runCodexQuotaSamplerFromCli } from "../src/codex-quota-sampler.js";

runCodexQuotaSamplerFromCli().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[codex-quota-sampler] ${message}`);
  process.exitCode = 1;
});
