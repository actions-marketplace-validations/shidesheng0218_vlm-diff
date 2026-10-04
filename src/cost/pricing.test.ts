import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCostUsd, estimateGateCostUsd } from "./pricing.js";

test("estimateCostUsd: computes cost for a known model", () => {
  const cost = estimateCostUsd("claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  assert.equal(cost, 3 + 15); // $3/M in + $15/M out
});

test("estimateCostUsd: unknown model returns 0", () => {
  assert.equal(estimateCostUsd("some-unreleased-model", { inputTokens: 1000, outputTokens: 1000 }), 0);
});

test("estimateCostUsd: zero usage returns 0", () => {
  assert.equal(estimateCostUsd("claude-sonnet-5", { inputTokens: 0, outputTokens: 0 }), 0);
});

test("estimateCostUsd: PRICING_OVERRIDES_JSON overrides the built-in table", () => {
  const prev = process.env.PRICING_OVERRIDES_JSON;
  process.env.PRICING_OVERRIDES_JSON = JSON.stringify({
    "claude-sonnet-5": { inputPerMillion: 1, outputPerMillion: 2 },
  });
  try {
    const cost = estimateCostUsd("claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    assert.equal(cost, 3);
  } finally {
    if (prev === undefined) delete process.env.PRICING_OVERRIDES_JSON;
    else process.env.PRICING_OVERRIDES_JSON = prev;
  }
});

test("estimateGateCostUsd: unknown model bills the conservative fallback, never $0", () => {
  const cost = estimateGateCostUsd("some-unreleased-model", { inputTokens: 1000, outputTokens: 1000 });
  // fallback = most expensive table entry (claude-opus-4.8: $15/M in, $75/M out)
  assert.ok(Math.abs(cost - 0.09) < 1e-12, `expected 0.09, got ${cost}`);
});

test("estimateGateCostUsd: known models use their table price", () => {
  const cost = estimateGateCostUsd("claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 0 });
  assert.equal(cost, 3);
});

test("estimateGateCostUsd: VLM_DIFF_DEFAULT_PRICE overrides the fallback", () => {
  const prev = process.env.VLM_DIFF_DEFAULT_PRICE;
  process.env.VLM_DIFF_DEFAULT_PRICE = "2"; // $2/M for both directions
  try {
    const cost = estimateGateCostUsd("some-unreleased-model", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    assert.equal(cost, 4);
  } finally {
    if (prev === undefined) delete process.env.VLM_DIFF_DEFAULT_PRICE;
    else process.env.VLM_DIFF_DEFAULT_PRICE = prev;
  }
});

test("pricing table covers the preset cheap/opencode models", () => {
  for (const model of ["qwen3.8-flash", "glm-5.2", "minimax-m3"]) {
    assert.ok(estimateCostUsd(model, { inputTokens: 1000, outputTokens: 1000 }) > 0, `${model} must be priced`);
  }
});
