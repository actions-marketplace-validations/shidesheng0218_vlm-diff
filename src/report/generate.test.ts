import { test } from "node:test";
import assert from "node:assert/strict";
import { computeReportSummary } from "./generate.js";
import type { BaselineResult } from "../eval/baselines.js";
import type { PairRecord } from "../eval/types.js";

function pair(overrides: Partial<PairRecord>): PairRecord {
  return {
    id: "p1",
    fixture: "card-list.html",
    mutationId: "m1",
    kind: "color-change",
    magnitude: "small",
    description: "d",
    before: "images/p1-before.png",
    after: "images/p1-after.png",
    domBefore: "[]",
    domAfter: "[]",
    ...overrides,
  };
}

function classifiedRegion(model: string | undefined, inputTokens: number, outputTokens: number) {
  return {
    region: { x: 0, y: 0, w: 10, h: 10 },
    source: "dom" as const,
    changeType: "color-change" as const,
    description: "d",
    confidence: 0.9,
    usage: { inputTokens, outputTokens },
    cached: false,
    ...(model ? { model } : {}),
  };
}

test("computeReportSummary: prices each classified region by its own model, not the primary provider's", () => {
  const pairs = [pair({ id: "p1", kind: "color-change" })];
  const results: BaselineResult[] = [
    {
      pairId: "p1",
      baseline: "fullPipeline",
      predictedChanged: true,
      predictedRegions: [{ x: 0, y: 0, w: 10, h: 10 }],
      classifications: [classifiedRegion("claude-haiku-4.5", 1000, 100)],
      inputTokens: 1000,
      outputTokens: 100,
      cached: false,
    },
  ];
  // report assembled with the PRIMARY provider, while classification ran on the cheap tier
  const summary = computeReportSummary({ pairs, results, provider: { name: "anthropic", model: "claude-sonnet-5" } });
  const haiku = (1000 / 1e6) * 0.8 + (100 / 1e6) * 4;
  const sonnet = (1000 / 1e6) * 3 + (100 / 1e6) * 15;
  assert.ok(Math.abs(summary.totalCostUsd - haiku) < 1e-12, `expected haiku pricing ${haiku}, got ${summary.totalCostUsd}`);
  assert.notEqual(summary.totalCostUsd, sonnet);
});

test("computeReportSummary: results without per-region detail fall back to the report provider's model", () => {
  const pairs = [pair({ id: "p1", kind: "color-change" })];
  const results: BaselineResult[] = [
    {
      pairId: "p1",
      baseline: "rawPairToVlm",
      predictedChanged: true,
      predictedRegions: [{ x: 0, y: 0, w: 10, h: 10 }],
      inputTokens: 2000,
      outputTokens: 50,
    },
  ];
  const summary = computeReportSummary({ pairs, results, provider: { name: "anthropic", model: "claude-sonnet-5" } });
  const sonnet = (2000 / 1e6) * 3 + (50 / 1e6) * 15;
  assert.ok(Math.abs(summary.totalCostUsd - sonnet) < 1e-12);
});

test("computeReportSummary: cache-hit regions bill zero regardless of recorded model", () => {
  const pairs = [pair({ id: "p1", kind: "color-change" })];
  const results: BaselineResult[] = [
    {
      pairId: "p1",
      baseline: "fullPipeline",
      predictedChanged: true,
      predictedRegions: [{ x: 0, y: 0, w: 10, h: 10 }],
      classifications: [classifiedRegion("claude-sonnet-5", 0, 0)],
      inputTokens: 0,
      outputTokens: 0,
      cached: true,
    },
  ];
  const summary = computeReportSummary({ pairs, results, provider: { name: "anthropic", model: "claude-sonnet-5" } });
  assert.equal(summary.totalCostUsd, 0);
});
