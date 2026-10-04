// Renders a single self-contained HTML report from an eval run: per-pair
// before/after thumbnails with detected regions overlaid, classification
// results, cache hit markers, and a cost summary banner. No external assets
// (images are inlined as base64) so the file can be shared or attached to a
// CI artifact on its own.

import { readFile } from "node:fs/promises";
import { PNG } from "pngjs";
import type { BaselineResult } from "../eval/baselines.js";
import type { PairRecord } from "../eval/types.js";
import { estimateCostUsd } from "../cost/pricing.js";
import { regionOverlaySvg } from "./overlay.js";

export interface ReportSummary {
  totalPairs: number;
  changedPairs: number;
  noChangePairs: number;
  cacheHits: number;
  cacheMisses: number;
  totalCostUsd: number;
  savedCostUsd: number;
}

export interface ReportInput {
  pairs: PairRecord[];
  results: BaselineResult[];
  provider: { name: string; model: string };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/**
 * Cost of one BaselineResult. When per-region classifications exist, each
 * region is priced by the model that actually classified it (cheap-tier
 * routing means that is often NOT the report's primary model); arms without
 * per-region detail (rawPairToVlm) fall back to pair-level tokens priced by
 * the primary model. Cache-hit regions carry zeroed usage, so they bill $0.
 */
export function estimateResultCostUsd(r: BaselineResult, fallbackModel: string): number {
  if (r.classifications && r.classifications.length > 0) {
    return r.classifications.reduce(
      (sum, c) => sum + estimateCostUsd(c.model ?? fallbackModel, c.usage),
      0,
    );
  }
  return estimateCostUsd(fallbackModel, { inputTokens: r.inputTokens, outputTokens: r.outputTokens });
}

export function computeReportSummary(input: ReportInput): ReportSummary {
  const { pairs, results, provider } = input;
  const byId = new Map(pairs.map((p) => [p.id, p]));

  let changedPairs = 0;
  let noChangePairs = 0;
  let cacheHits = 0;
  let cacheMisses = 0;
  let totalCostUsd = 0;
  let savedCostUsd = 0;

  for (const r of results) {
    const pair = byId.get(r.pairId);
    if (pair?.kind === "none") noChangePairs++;
    else changedPairs++;

    if (r.cached === true) {
      cacheHits++;
      // The cost we *would* have paid had this not been a cache hit — the
      // classify call for this pair used the same crop, so re-use its actual
      // token usage from a cache-miss run isn't available here; approximate
      // using the average non-cached cost for this baseline instead.
    } else if (r.cached === false) {
      cacheMisses++;
      totalCostUsd += estimateResultCostUsd(r, provider.model);
    } else {
      totalCostUsd += estimateResultCostUsd(r, provider.model);
    }
  }

  // Estimate savings from cache hits using the average cost-per-classification
  // observed among cache misses in this same run (falls back to 0 if every
  // call was a hit, since there's nothing to extrapolate from).
  if (cacheHits > 0 && cacheMisses > 0) {
    const avgMissCost = totalCostUsd / cacheMisses;
    savedCostUsd = avgMissCost * cacheHits;
  }

  return {
    totalPairs: results.length,
    changedPairs,
    noChangePairs,
    cacheHits,
    cacheMisses,
    totalCostUsd,
    savedCostUsd,
  };
}

export async function generateHtmlReport(input: ReportInput, dataDir: string): Promise<string> {
  const { pairs, results, provider } = input;
  const byId = new Map(pairs.map((p) => [p.id, p]));
  const summary = computeReportSummary(input);

  const rows = await Promise.all(
    results.map(async (r) => {
      const pair = byId.get(r.pairId);
      if (!pair) return "";
      const beforePngBuf = await readFile(`${dataDir}/${pair.before}`);
      const afterPngBuf = await readFile(`${dataDir}/${pair.after}`);
      const beforeB64 = beforePngBuf.toString("base64");
      const afterB64 = afterPngBuf.toString("base64");
      // actually overlay the detected regions on the after frame (the header
      // comment promised this; the v0.1/v0.2 implementation only rendered
      // bare images)
      const afterDims = PNG.sync.read(afterPngBuf);
      const overlay = regionOverlaySvg(
        (r.classifications ?? []).map((c, i) => ({ x: c.region.x, y: c.region.y, w: c.region.w, h: c.region.h, index: i + 1 })),
        afterDims.width,
        afterDims.height,
      );
      const cacheLabel =
        r.cached === true ? `<span class="badge badge-hit">cache hit</span>` :
        r.cached === false ? `<span class="badge badge-miss">cache miss</span>` : "";
      const cost = estimateResultCostUsd(r, provider.model);

      return `
        <div class="pair-card">
          <div class="pair-header">
            <strong>${escapeHtml(pair.id)}</strong>
            <span class="kind">${escapeHtml(pair.kind)}</span>
            ${cacheLabel}
          </div>
          <div class="pair-images">
            <figure><div class="imgwrap"><img src="data:image/png;base64,${beforeB64}" /></div><figcaption>before</figcaption></figure>
            <figure><div class="imgwrap"><img src="data:image/png;base64,${afterB64}" />${overlay}</div><figcaption>after${overlay ? " (regions annotated)" : ""}</figcaption></figure>
          </div>
          <div class="pair-result">
            <div>changed: <strong>${r.predictedChanged}</strong></div>
            ${
              r.classifications && r.classifications.length > 0
                ? `<div class="regions">${r.classifications
                    .map(
                      (c) => `
                    <div class="region-row">
                      <span class="region-type">${escapeHtml(c.changeType)}</span>
                      ${c.route === "deterministic" ? '<span class="badge badge-det">deterministic</span>' : c.route === "vlm" ? '<span class="badge badge-vlm">vlm</span>' : ""}
                      <span class="region-desc">${escapeHtml(c.description)}</span>
                      <span class="region-meta">${c.region.w}×${c.region.h} @(${c.region.x},${c.region.y}) · ${escapeHtml(c.source)} · conf ${c.confidence.toFixed(2)}${c.cached === true ? " · cache hit" : ""}</span>
                    </div>`,
                    )
                    .join("")}</div>`
                : `${r.predictedChangeType ? `<div>type: <strong>${escapeHtml(r.predictedChangeType)}</strong></div>` : ""}
                   ${r.description ? `<div>description: ${escapeHtml(r.description)}</div>` : ""}`
            }
            <div class="cost">tokens: ${r.inputTokens}in/${r.outputTokens}out · $${cost.toFixed(5)}</div>
          </div>
        </div>`;
    }),
  );

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>VLM-Diff Eval Report</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f5f5f7; margin: 0; padding: 32px; color: #1a1a1a; }
  h1 { font-size: 22px; }
  .summary { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 32px; }
  .stat { background: white; border-radius: 10px; padding: 16px 24px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .stat .value { font-size: 28px; font-weight: 700; }
  .stat .label { font-size: 13px; color: #666; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 16px; }
  .pair-card { background: white; border-radius: 10px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .pair-header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .kind { color: #666; font-size: 13px; }
  .badge { font-size: 11px; padding: 2px 8px; border-radius: 6px; font-weight: 600; }
  .badge-hit { background: #d1fae5; color: #065f46; }
  .badge-miss { background: #fee2e2; color: #991b1b; }
  .badge-det { background: #dbeafe; color: #1e40af; margin-right: 6px; }
  .badge-vlm { background: #fef3c7; color: #92400e; margin-right: 6px; }
  .pair-images { display: flex; gap: 8px; margin-bottom: 8px; }
  .pair-images figure { margin: 0; flex: 1; }
  .pair-images .imgwrap { position: relative; }
  .pair-images img { width: 100%; border-radius: 6px; display: block; }
  .pair-images figcaption { text-align: center; font-size: 11px; color: #888; margin-top: 2px; }
  .pair-result { font-size: 13px; line-height: 1.5; }
  .regions { margin-top: 6px; display: flex; flex-direction: column; gap: 6px; }
  .region-row { border-left: 3px solid #d1d5db; padding-left: 8px; }
  .region-type { font-weight: 700; margin-right: 6px; }
  .region-desc { color: #333; }
  .region-meta { display: block; color: #888; font-size: 11px; }
  .cost { color: #888; font-size: 12px; margin-top: 4px; }
</style>
</head>
<body>
  <h1>VLM-Diff Eval Report</h1>
  <div class="summary">
    <div class="stat"><div class="value">${summary.totalPairs}</div><div class="label">total pairs</div></div>
    <div class="stat"><div class="value">${summary.changedPairs}</div><div class="label">changed</div></div>
    <div class="stat"><div class="value">${summary.noChangePairs}</div><div class="label">no change</div></div>
    <div class="stat"><div class="value">${summary.cacheHits}</div><div class="label">cache hits</div></div>
    <div class="stat"><div class="value">$${summary.totalCostUsd.toFixed(4)}</div><div class="label">total cost</div></div>
    <div class="stat"><div class="value">$${summary.savedCostUsd.toFixed(4)}</div><div class="label">saved by cache</div></div>
  </div>
  <div class="grid">
    ${rows.join("\n")}
  </div>
</body>
</html>`;
}
