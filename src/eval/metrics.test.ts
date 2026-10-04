import { test } from "node:test";
import assert from "node:assert/strict";
import { summarize } from "./metrics.js";
import type { BaselineResult } from "./baselines.js";
import type { PairRecord } from "./types.js";

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

function result(overrides: Partial<BaselineResult>): BaselineResult {
  return {
    pairId: "p1",
    baseline: "fullPipeline",
    predictedChanged: true,
    predictedRegions: [],
    inputTokens: 0,
    outputTokens: 0,
    ...overrides,
  };
}

test("summarize: perfect detector on changed pairs scores recall 1 and correct precision", () => {
  const pairs = [pair({ id: "p1", kind: "color-change", groundTruthRect: { x: 10, y: 10, w: 20, h: 20 } })];
  const results = [
    result({ pairId: "p1", predictedChanged: true, predictedRegions: [{ x: 10, y: 10, w: 20, h: 20 }], predictedChangeType: "color-change" as any }),
  ];
  const summary = summarize(pairs, results);
  assert.equal(summary.recall, 1);
  assert.equal(summary.precision, 1);
  assert.equal(summary.changeTypeAccuracy, 1);
});

test("summarize: missed detection on a changed pair counts as false negative (recall < 1)", () => {
  const pairs = [pair({ id: "p1", kind: "color-change" })];
  const results = [result({ pairId: "p1", predictedChanged: false, predictedRegions: [] })];
  const summary = summarize(pairs, results);
  assert.equal(summary.recall, 0);
});

test("summarize: false positive on a 'none' pair is captured by falsePositiveRateOnNoChange", () => {
  const pairs = [pair({ id: "p1", kind: "none" })];
  const results = [result({ pairId: "p1", predictedChanged: true, predictedRegions: [{ x: 0, y: 0, w: 5, h: 5 }] })];
  const summary = summarize(pairs, results);
  assert.equal(summary.falsePositiveRateOnNoChange, 1);
  // 'none' pairs are excluded from recall (no changed pairs in this set)
  assert.equal(summary.recall, 0);
});

test("summarize: correct no-change prediction on a 'none' pair yields zero false-positive rate", () => {
  const pairs = [pair({ id: "p1", kind: "none" })];
  const results = [result({ pairId: "p1", predictedChanged: false, predictedRegions: [] })];
  const summary = summarize(pairs, results);
  assert.equal(summary.falsePositiveRateOnNoChange, 0);
});

test("summarize: region precision penalizes a detected-but-mislocalized region", () => {
  const pairs = [pair({ id: "p1", kind: "color-change", groundTruthRect: { x: 100, y: 100, w: 10, h: 10 } })];
  const results = [result({ pairId: "p1", predictedChanged: true, predictedRegions: [{ x: 0, y: 0, w: 5, h: 5 }] })];
  const summary = summarize(pairs, results);
  assert.equal(summary.recall, 1); // detected "something changed"
  assert.equal(summary.precision, 0); // but region doesn't overlap ground truth
});

test("summarize: averages token usage across all results", () => {
  const pairs = [pair({ id: "p1" }), pair({ id: "p2" })];
  const results = [
    result({ pairId: "p1", inputTokens: 100, outputTokens: 20 }),
    result({ pairId: "p2", inputTokens: 200, outputTokens: 40 }),
  ];
  const summary = summarize(pairs, results);
  assert.equal(summary.avgInputTokens, 150);
  assert.equal(summary.avgOutputTokens, 30);
});

test("summarize: detectionPrecision counts false positives on no-change pairs", () => {
  const pairs = [
    pair({ id: "c1", kind: "color-change", groundTruthRect: { x: 10, y: 10, w: 20, h: 20 } }),
    pair({ id: "n1", kind: "none" }),
    pair({ id: "n2", kind: "none" }),
    pair({ id: "n3", kind: "none" }),
  ];
  const results = [
    result({ pairId: "c1", predictedChanged: true, predictedRegions: [{ x: 10, y: 10, w: 20, h: 20 }] }),
    result({ pairId: "n1", predictedChanged: true, predictedRegions: [{ x: 0, y: 0, w: 5, h: 5 }] }),
    result({ pairId: "n2", predictedChanged: false }),
    result({ pairId: "n3", predictedChanged: false }),
  ];
  const summary = summarize(pairs, results);
  // TP=1, FP=1 → detection precision 1/(1+1)
  assert.equal(summary.detectionPrecision, 0.5);
  // old "precision" semantics renamed: detected region overlaps ground truth (IoU >= 0.3)
  assert.equal(summary.localizationHitRate, 1);
});

test("summarize: localizationHitRate keeps the old precision semantics (IoU >= 0.3 on changed pairs)", () => {
  const pairs = [pair({ id: "p1", kind: "color-change", groundTruthRect: { x: 100, y: 100, w: 10, h: 10 } })];
  const results = [result({ pairId: "p1", predictedChanged: true, predictedRegions: [{ x: 0, y: 0, w: 5, h: 5 }] })];
  const summary = summarize(pairs, results);
  assert.equal(summary.localizationHitRate, 0);
  assert.equal(summary.detectionPrecision, 1); // no false positives here
});
