#!/usr/bin/env tsx
/**
 * Aggregate multiple MVP reports (from different models) into one comparison
 * table for README/paper. Zero API calls.
 *
 * Usage:
 *   npm run compare:models
 *   npx tsx scripts/compare-models.ts results/mvp-report.json results/mvp-report-qwen3.8-max.json
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

interface MvpReport {
  generatedAt: string;
  model: string;
  n: number;
  baselines: Record<
    string,
    {
      metrics: {
        recall: number;
        /** @deprecated alias of localizationHitRate in older reports */
        precision?: number;
        localizationHitRate: number;
        detectionPrecision: number;
        falsePositiveRateOnNoChange: number;
        changeTypeAccuracy: number;
        avgInputTokens: number;
        avgOutputTokens: number;
      };
      perPair: Array<unknown>;
    }
  >;
  tiered?: {
    totalRegions: number;
    deterministicRegions: number;
    vlmRegions: number;
    escalationRate: number;
    tokenSavingsVsFullPipelineHint: number;
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

async function load(p: string): Promise<MvpReport> {
  return JSON.parse(await readFile(p, "utf8"));
}

async function main() {
  const args = process.argv.slice(2);
  // explicit report paths, or auto-discover results/mvp-report[-tag].json
  let files: string[] = [];
  if (args.length > 0) {
    files = args;
  } else {
    const { readdir } = await import("node:fs/promises");
    const dir = "results";
    files = (await readdir(dir))
      .filter((f) => /^mvp-report(-.+)?\.json$/.test(f))
      .sort()
      .map((f) => path.join(dir, f));
  }
  if (files.length === 0) {
    console.error("No reports found. Run npm run eval:mvp first (with VLM_DIFF_MVP_TAG for extra models).");
    process.exit(1);
  }

  const reports: Array<{ file: string; r: MvpReport }> = [];
  for (const f of files) {
    try {
      reports.push({ file: path.basename(f), r: await load(f) });
    } catch (e) {
      console.error(`Skipping ${f}: ${(e as Error).message}`);
    }
  }

  console.log("Multi-model MVP comparison\n");
  const header =
    "| model | n | tiered: recall / FP / type-acc | tiered tokens/pair | escalation | hint: type-acc | no-hint: type-acc | raw: recall / precision |";
  const sep = "|---|---|---|---|---|---|---|---|";
  console.log(header);
  console.log(sep);
  const md: string[] = [];
  for (const { file, r } of reports) {
    const t = r.baselines.tieredPipeline.metrics;
    const h = r.baselines.fullPipelineWithDomHint.metrics;
    const nh = r.baselines.fullPipelineNoHint.metrics;
    const raw = r.baselines.rawPairToVlm.metrics;
    const esc = r.tiered?.escalationRate;
    const row =
      `| **${r.model}** (${file}) | ${r.n} ` +
      `| ${pct(t.recall)} / ${pct(t.falsePositiveRateOnNoChange)} / **${pct(t.changeTypeAccuracy)}** ` +
      `| ${t.avgInputTokens.toFixed(0)}+${t.avgOutputTokens.toFixed(0)} ` +
      `| ${esc !== undefined ? pct(esc) : "n/a"} ` +
      `| ${pct(h.changeTypeAccuracy)} | ${pct(nh.changeTypeAccuracy)} ` +
      `| ${pct(raw.recall)} / ${pct(raw.localizationHitRate)} / ${pct(raw.detectionPrecision)} |`;
    md.push(row);
    console.log(row);
  }
  console.log("\nKey columns: tiered type accuracy is exact-match vs ground truth; escalation is the fraction of regions sent to the VLM; raw columns are recall / IoU≥0.3 localization hit rate / detection precision (TP/(TP+FP)).");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
