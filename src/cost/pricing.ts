// Per-model USD pricing, in dollars per 1M tokens. These defaults are
// approximate and were accurate at time of writing — provider pricing
// changes independently of this repo, so treat cost figures as directional,
// not billing-accurate. Override via PRICING_OVERRIDES_JSON (a JSON object
// keyed by model name) if your rates differ.

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  /** true when the numbers are a conservative guess, not vendor-verified */
  estimate?: boolean;
}

export const PRICING_TABLE: Record<string, ModelPricing> = {
  "claude-sonnet-5": { inputPerMillion: 3, outputPerMillion: 15 },
  "claude-opus-4.8": { inputPerMillion: 15, outputPerMillion: 75 },
  "claude-haiku-4.5": { inputPerMillion: 0.8, outputPerMillion: 4 },
  "gpt-5": { inputPerMillion: 5, outputPerMillion: 15 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  // Kimi K3 — Moonshot direct and DashScope-hosted share the same ballpark.
  // Verify against current vendor pricing before treating costs as exact.
  "kimi-k3": { inputPerMillion: 0.6, outputPerMillion: 2.5 },
  "kimi/kimi-k3": { inputPerMillion: 0.6, outputPerMillion: 2.5 },
  // Verify against current DashScope pricing.
  "qwen3.8-max": { inputPerMillion: 1.2, outputPerMillion: 6 },
  // Preset cheap/third-party models — conservative guesses (estimate: true),
  // present so the budget gate has a dimension on every preset route.
  "qwen3.8-flash": { inputPerMillion: 0.15, outputPerMillion: 0.6, estimate: true },
  "glm-5.2": { inputPerMillion: 1, outputPerMillion: 4, estimate: true },
  "minimax-m3": { inputPerMillion: 0.5, outputPerMillion: 2, estimate: true },
};

function loadOverrides(): Record<string, ModelPricing> {
  const raw = process.env.PRICING_OVERRIDES_JSON;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    console.warn("[cost] PRICING_OVERRIDES_JSON is not valid JSON — ignoring overrides");
    return {};
  }
}

const warnedModels = new Set<string>();

/** Returns 0 for unknown models and warns once per model, so silently-wrong
 *  cost columns can't sneak into a report. */
export function estimateCostUsd(model: string, usage: { inputTokens: number; outputTokens: number }): number {
  const pricing = loadOverrides()[model] ?? PRICING_TABLE[model];
  if (!pricing) {
    if (!warnedModels.has(model)) {
      warnedModels.add(model);
      console.warn(`[cost] no pricing known for model "${model}" — cost reported as $0 (set PRICING_OVERRIDES_JSON to fix)`);
    }
    return 0;
  }
  return (
    (usage.inputTokens / 1_000_000) * pricing.inputPerMillion +
    (usage.outputTokens / 1_000_000) * pricing.outputPerMillion
  );
}

/**
 * Conservative fallback for the budget gate: VLM_DIFF_DEFAULT_PRICE (a bare
 * number = $/M applied to both directions, or a JSON
 * {"inputPerMillion":x,"outputPerMillion":y}), else the most expensive known
 * model. The gate must never treat an unpriced model as free.
 */
function gateFallbackPricing(): ModelPricing {
  const raw = process.env.VLM_DIFF_DEFAULT_PRICE;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "number" && parsed > 0) return { inputPerMillion: parsed, outputPerMillion: parsed };
      if (parsed && typeof parsed.inputPerMillion === "number" && typeof parsed.outputPerMillion === "number") {
        return { inputPerMillion: parsed.inputPerMillion, outputPerMillion: parsed.outputPerMillion };
      }
    } catch {
      // not JSON — fall through to the table maximum
    }
    console.warn("[cost] VLM_DIFF_DEFAULT_PRICE is not a number or {inputPerMillion,outputPerMillion} JSON — using table maximum");
  }
  let max: ModelPricing = { inputPerMillion: 0, outputPerMillion: 0 };
  for (const p of Object.values(PRICING_TABLE)) {
    if (p.inputPerMillion + p.outputPerMillion > max.inputPerMillion + max.outputPerMillion) max = p;
  }
  return max;
}

const gateWarnedModels = new Set<string>();

/** Like estimateCostUsd, but unknown models bill the conservative fallback
 *  instead of $0 — used by the budget gate and the cost log so the gate works
 *  on third-party models missing from PRICING_TABLE. */
export function estimateGateCostUsd(model: string, usage: { inputTokens: number; outputTokens: number }): number {
  const pricing = loadOverrides()[model] ?? PRICING_TABLE[model];
  if (pricing) {
    return (
      (usage.inputTokens / 1_000_000) * pricing.inputPerMillion +
      (usage.outputTokens / 1_000_000) * pricing.outputPerMillion
    );
  }
  if (!gateWarnedModels.has(model)) {
    gateWarnedModels.add(model);
    console.warn(`[cost] no pricing known for model "${model}" — budget gate bills the conservative fallback (set PRICING_OVERRIDES_JSON or VLM_DIFF_DEFAULT_PRICE to fix)`);
  }
  const fb = gateFallbackPricing();
  return (usage.inputTokens / 1_000_000) * fb.inputPerMillion + (usage.outputTokens / 1_000_000) * fb.outputPerMillion;
}
