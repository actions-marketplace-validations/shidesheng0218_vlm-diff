import type { BaselineResult } from "./baselines.js";
import type { PairRecord } from "./types.js";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function iou(a: Rect, b: Rect): number {
  const ix = Math.max(a.x, b.x);
  const iy = Math.max(a.y, b.y);
  const iw = Math.min(a.x + a.w, b.x + b.w) - ix;
  const ih = Math.min(a.y + a.h, b.y + b.h) - iy;
  if (iw <= 0 || ih <= 0) return 0;
  const intersection = iw * ih;
  const union = a.w * a.h + b.w * b.h - intersection;
  return union > 0 ? intersection / union : 0;
}

const IOU_HIT_THRESHOLD = 0.3;

export interface MetricsSummary {
  baseline: string;
  n: number;
  /** ground-truth-changed pairs correctly flagged as changed */
  recall: number;
  /**
   * @deprecated misleading name — this never counted false positives.
   * Use localizationHitRate (same value) or detectionPrecision (TP / (TP+FP)).
   * Kept so existing consumers/tests keep compiling; removed in a future major.
   */
  precision: number;
  /** predicted-changed pairs whose region overlaps ground truth (IoU > 0.3); the old `precision` semantics */
  localizationHitRate: number;
  /** TP / (TP + FP), where FP = predictedChanged on a ground-truth "none" pair */
  detectionPrecision: number;
  /** ground-truth "none" pairs incorrectly flagged as changed */
  falsePositiveRateOnNoChange: number;
  /** among correctly-detected changed pairs, fraction with correct changeType (largest-region口径: BaselineResult.predictedChangeType) */
  changeTypeAccuracy: number;
  /** per-region口径: across all classified regions on ground-truth-changed pairs, fraction whose changeType === pair.kind */
  regionTypeRecall: number;
  /** pair-level口径: among ground-truth-changed pairs predicted changed, fraction with at least one region typed correctly (can the user find the right answer in the report) */
  pairContainsCorrectType: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  /** among classified regions, fraction that needed a VLM call (tieredPipeline only; undefined otherwise) */
  vlmRegionShare?: number;
  /** among classified regions, fraction described deterministically at 0 tokens (tieredPipeline only) */
  deterministicRegionShare?: number;
}

export function summarize(pairs: PairRecord[], results: BaselineResult[]): MetricsSummary {
  const byId = new Map(pairs.map((p) => [p.id, p]));
  const baseline = results[0]?.baseline ?? "unknown";

  let truePositives = 0; // ground truth changed, predicted changed
  let falseNegatives = 0; // ground truth changed, predicted unchanged
  let noChangePairs = 0;
  let noChangeFalsePositives = 0;
  let precisionHits = 0;
  let precisionAttempts = 0; // predicted-changed pairs where ground truth also changed (denominator for localizationHitRate)
  let typeCorrect = 0;
  let typeAttempts = 0;
  let regionTypeMatches = 0;
  let regionTypeTotal = 0;
  let pairsWithCorrectType = 0;
  let detectedChangedPairs = 0; // ground-truth-changed pairs predicted changed (denominator for pairContainsCorrectType)
  let inputTokenSum = 0;
  let outputTokenSum = 0;
  let routedRegions = 0;
  let deterministicRegions = 0;

  for (const r of results) {
    const pair = byId.get(r.pairId);
    if (!pair) continue;
    const groundTruthChanged = pair.kind !== "none";
    inputTokenSum += r.inputTokens;
    outputTokenSum += r.outputTokens;
    for (const c of r.classifications ?? []) {
      if (c.route) {
        routedRegions++;
        if (c.route === "deterministic") deterministicRegions++;
      }
    }

    if (!groundTruthChanged) {
      noChangePairs++;
      if (r.predictedChanged) noChangeFalsePositives++;
      continue;
    }

    if (r.predictedChanged) {
      truePositives++;
      precisionAttempts++;
      detectedChangedPairs++;
      const gtRect = groundTruthRect(pair);
      if (gtRect && r.predictedRegions.some((pr) => iou(pr, gtRect) >= IOU_HIT_THRESHOLD)) {
        precisionHits++;
      }
      if (r.predictedChangeType) {
        typeAttempts++;
        if (r.predictedChangeType === pair.kind) typeCorrect++;
      }
      let pairHasCorrectType = false;
      for (const c of r.classifications ?? []) {
        regionTypeTotal++;
        if (c.changeType === pair.kind) {
          regionTypeMatches++;
          pairHasCorrectType = true;
        }
      }
      if (pairHasCorrectType) pairsWithCorrectType++;
    } else {
      falseNegatives++;
    }
  }

  const changedTotal = truePositives + falseNegatives;
  const localizationHitRate = precisionAttempts > 0 ? precisionHits / precisionAttempts : 0;

  return {
    baseline,
    n: results.length,
    recall: changedTotal > 0 ? truePositives / changedTotal : 0,
    precision: localizationHitRate,
    localizationHitRate,
    detectionPrecision:
      truePositives + noChangeFalsePositives > 0 ? truePositives / (truePositives + noChangeFalsePositives) : 0,
    falsePositiveRateOnNoChange: noChangePairs > 0 ? noChangeFalsePositives / noChangePairs : 0,
    changeTypeAccuracy: typeAttempts > 0 ? typeCorrect / typeAttempts : 0,
    regionTypeRecall: regionTypeTotal > 0 ? regionTypeMatches / regionTypeTotal : 0,
    pairContainsCorrectType: detectedChangedPairs > 0 ? pairsWithCorrectType / detectedChangedPairs : 0,
    avgInputTokens: results.length > 0 ? inputTokenSum / results.length : 0,
    avgOutputTokens: results.length > 0 ? outputTokenSum / results.length : 0,
    ...(routedRegions > 0
      ? {
          vlmRegionShare: (routedRegions - deterministicRegions) / routedRegions,
          deterministicRegionShare: deterministicRegions / routedRegions,
        }
      : {}),
  };
}

function groundTruthRect(pair: PairRecord): Rect | undefined {
  return pair.groundTruthRect;
}
