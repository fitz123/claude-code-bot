/**
 * Codex quota usage Pi extension wrapper.
 *
 * Loaded only by the out-of-band quota sampler. Normal bot-spawned Pi sessions
 * keep their existing extension set and transport behavior; the sampler passes
 * this wrapper explicitly for a tiny SSE probe so Codex response headers can be
 * cached locally for `/status` and node_exporter.
 */

import {
  captureCodexQuotaFromProviderResponse,
  formatCodexQuotaWriteError,
} from "../../src/pi-extensions/codex-usage.js";

interface PiExtensionLike {
  on: (eventName: string, handler: (...args: unknown[]) => unknown) => void;
}

export default function (pi: PiExtensionLike): void {
  pi.on("after_provider_response", (...args: unknown[]) => {
    const event = args.length === 1 ? args[0] : args;
    const result = captureCodexQuotaFromProviderResponse(event);
    if (result.status === "write_error") {
      // eslint-disable-next-line no-console -- structured warning for the sampler process
      console.warn(formatCodexQuotaWriteError(result.error));
    }
  });
}
