// CLI provider construction. The CLI's only VLM call site is high-volume
// per-region classification, so it always asks for the cheap tier — with
// VLM_DIFF_CLASSIFY_MODEL unset this still resolves to the default model
// (the opt-in routing semantics in factory.ts are unchanged).

import { createProvider } from "../provider/factory.js";
import type { Provider } from "../provider/types.js";

export function createCliProvider(choice: { provider?: string; model?: string }): Provider {
  return createProvider({ provider: choice.provider, model: choice.model, tier: "cheap" });
}
