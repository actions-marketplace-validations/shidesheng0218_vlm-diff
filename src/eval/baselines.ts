// The four conditions being compared, per the plan's scientific core:
//   (a) rawPairToVlm    — full before/after images straight to the VLM, ask "what changed"
//   (b) pixelDiffOnly   — perceptual diff candidate regions, no DOM signal, no VLM
//   (c) fullPipeline    — DOM diff + pixel diff fusion (with no-change suppression) -> VLM classify
//   (d) tieredPipeline  — deterministic-first: regions the DOM fully explains are
//                         described from templates (0 tokens); only ambiguous
//                         regions (pixel-only, cascade reflow, combined
//                         move+resize) escalate to VLM classification

import { readFile } from "node:fs/promises";
import type { Provider } from "../provider/types.js";
import { imageBlock, textBlock } from "../provider/types.js";
import { detect, mergeNestedRegions, type CandidateRegion, type DetectionResult } from "../detect/regions.js";
import { diffImages, groupRegions } from "../detect/perceptual-diff.js";
import { classifyRegion, classifyRegionCached, cropRegion } from "../classify/vlm-classify.js";
import type { ChangeKind, Classification, DomHint } from "../classify/vlm-classify.js";
import { describeRegions } from "../describe/describe.js";
import type { CacheStore } from "../cache/store.js";
import { extractJson } from "../util/json.js";
import type { PairRecord } from "./types.js";
// re-exported for callers that only need the record shape from this module
export type { PairRecord };

export interface RegionClassification {
  region: { x: number; y: number; w: number; h: number };
  source: CandidateRegion["source"];
  changeType: ChangeKind;
  description: string;
  confidence: number;
  usage: { inputTokens: number; outputTokens: number };
  cached?: boolean;
  /** how this region's description was produced (tieredPipeline only) */
  route?: "deterministic" | "vlm";
  /** true when this region carries the pair's root-cause change rather than being a reflow follower (tieredPipeline only) */
  rootCause?: boolean;
}

export interface BaselineResult {
  pairId: string;
  baseline: "rawPairToVlm" | "pixelDiffOnly" | "fullPipeline" | "tieredPipeline";
  predictedChanged: boolean;
  predictedRegions: Array<{ x: number; y: number; w: number; h: number }>;
  /** pair-level change type = the largest region's classification (scoring continuity) */
  predictedChangeType?: ChangeKind;
  description?: string;
  /** per-region classifications, largest region first (fullPipeline / tieredPipeline) */
  classifications?: RegionClassification[];
  inputTokens: number;
  outputTokens: number;
  cached?: boolean;
}

const RAW_PAIR_SYSTEM = `You are comparing a "before" and "after" screenshot of the same UI. Determine if anything changed, and if so, what and where.

Respond with strict JSON only, no markdown fences:
{"changed": true|false, "changeType": "spatial-shift" | "color-change" | "size-change" | "text-change" | "element-add" | "element-remove" | "style-change" | "other" | "none", "description": "<one sentence>", "region": {"x": <int>, "y": <int>, "w": <int>, "h": <int>} | null}`;

export async function runRawPairToVlm(provider: Provider, pair: PairRecord, dataDir: string): Promise<BaselineResult> {
  const before = await readFile(`${dataDir}/${pair.before}`);
  const after = await readFile(`${dataDir}/${pair.after}`);

  const result = await provider.send(
    RAW_PAIR_SYSTEM,
    [
      {
        role: "user",
        content: [
          textBlock("Before:"),
          imageBlock(before.toString("base64"), "image/png"),
          textBlock("After:"),
          imageBlock(after.toString("base64"), "image/png"),
        ],
      },
    ],
    { fn: "raw-pair", maxTokens: 1024 },
  );

  let changed = false;
  let changeType: ChangeKind | undefined;
  let description: string | undefined;
  let region: { x: number; y: number; w: number; h: number } | undefined;
  const parsed = extractJson(result.text) as
    | { changed?: boolean; changeType?: ChangeKind; description?: string; region?: { x: number; y: number; w: number; h: number } | null }
    | undefined;
  if (parsed) {
    changed = !!parsed.changed;
    changeType = parsed.changeType;
    description = parsed.description;
    region = parsed.region ?? undefined;
  }
  // unparseable response counts as "no detection" for scoring purposes

  return {
    pairId: pair.id,
    baseline: "rawPairToVlm",
    predictedChanged: changed,
    predictedRegions: region ? [region] : [],
    predictedChangeType: changeType,
    description,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  };
}

export async function runPixelDiffOnly(pair: PairRecord, dataDir: string): Promise<BaselineResult> {
  const before = await readFile(`${dataDir}/${pair.before}`);
  const after = await readFile(`${dataDir}/${pair.after}`);
  const { mask, width, height } = diffImages(before, after);
  const regions = groupRegions(mask, width, height);

  return {
    pairId: pair.id,
    baseline: "pixelDiffOnly",
    predictedChanged: regions.length > 0,
    predictedRegions: regions.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })),
    inputTokens: 0,
    outputTokens: 0,
  };
}

/** Upper bound on VLM calls per pair. Pathological pages can produce dozens
 *  of DOM changes; classify the largest regions first and stop here. */
export const MAX_REGIONS_TO_CLASSIFY = 8;

/**
 * Classify every detected region in parallel, largest first. Each region gets
 * its own crop and (when available) its own DOM-field hint, so a pair with
 * several changed elements produces one classification per element.
 */
export async function classifyDetectedRegions(
  provider: Provider,
  cache: CacheStore | undefined,
  before: Buffer,
  after: Buffer,
  regions: CandidateRegion[],
  useDomHint: boolean,
  maxRegions: number = MAX_REGIONS_TO_CLASSIFY,
): Promise<RegionClassification[]> {
  const sorted = [...regions].sort((a, b) => b.w * b.h - a.w * a.h).slice(0, maxRegions);
  return Promise.all(
    sorted.map(async (region) => {
      const hint: DomHint | undefined =
        useDomHint && region.domChangedFields && region.domChangedFields.length > 0
          ? {
              fields: region.domChangedFields,
              id: region.domId,
              ...(region.rectDelta ? { rectDelta: region.rectDelta } : {}),
              ...(region.counterpartRect ? { counterpartRect: region.counterpartRect } : {}),
            }
          : undefined;
      const c: Classification & { cached?: boolean } = cache
        ? await classifyRegionCached(provider, cache, cropRegion(before, region), cropRegion(after, region), hint)
        : await classifyRegion(provider, cropRegion(before, region), cropRegion(after, region), hint);
      return {
        region: { x: region.x, y: region.y, w: region.w, h: region.h },
        source: region.source,
        changeType: c.changeType,
        description: c.description,
        confidence: c.confidence,
        usage: c.usage,
        cached: c.cached,
      };
    }),
  );
}

/**
 * End-to-end no-change aggregation: when detection was purely pixel-driven
 * (no DOM evidence) and every classified region comes back "none", the pixel
 * delta that triggered detection was not a real change (render jitter that
 * crossed the floor, benign repaint). The pair verdict flips back to
 * unchanged; classifications and token usage stay attached for auditing.
 * Gated on `visualOnly` so a DOM-observable change can never be vetoed by a
 * model hiccup — the DOM diff remains authoritative whenever it has signal.
 */
function aggregateNone(
  result: BaselineResult,
  classifications: RegionClassification[],
  visualOnly: boolean,
): BaselineResult {
  if (visualOnly && classifications.length > 0 && classifications.every((c) => c.changeType === "none")) {
    return {
      ...result,
      predictedChanged: false,
      predictedChangeType: "none",
      description: classifications[0].description,
    };
  }
  return result;
}

export async function runFullPipeline(
  provider: Provider,
  pair: PairRecord,
  dataDir: string,
  cache?: CacheStore,
  /** pass each region's DOM changedFields to the classifier as a text hint (default on) */
  useDomHint: boolean = true,
  maxRegions: number = MAX_REGIONS_TO_CLASSIFY,
): Promise<BaselineResult> {
  const before = await readFile(`${dataDir}/${pair.before}`);
  const after = await readFile(`${dataDir}/${pair.after}`);
  const detection: DetectionResult = detect(pair.domBefore, pair.domAfter, before, after);

  if (!detection.changed || detection.regions.length === 0) {
    return {
      pairId: pair.id,
      baseline: "fullPipeline",
      predictedChanged: false,
      predictedRegions: [],
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  const classifications = await classifyDetectedRegions(
    provider, cache, before, after, detection.regions, useDomHint, maxRegions,
  );

  if (classifications.length === 0) {
    // regions were detected but the caller capped classification at zero
    return {
      pairId: pair.id,
      baseline: "fullPipeline",
      predictedChanged: true,
      predictedRegions: detection.regions.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })),
      classifications: [],
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  // Pair-level type/description come from the largest region, keeping MVP
  // scoring comparable across runs; per-region detail rides along in
  // `classifications`.
  const primary = classifications[0];

  return aggregateNone(
    {
      pairId: pair.id,
      baseline: "fullPipeline",
      predictedChanged: true,
      predictedRegions: detection.regions.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })),
      predictedChangeType: primary.changeType,
      description: primary.description,
      classifications,
      inputTokens: classifications.reduce((s, c) => s + c.usage.inputTokens, 0),
      outputTokens: classifications.reduce((s, c) => s + c.usage.outputTokens, 0),
      cached: cache ? classifications.every((c) => c.cached === true) : undefined,
    },
    classifications,
    detection.visualOnly,
  );
}

/**
 * Deterministic-first tiered pipeline. Same detection stage as
 * runFullPipeline, but each region is routed first: regions the DOM diff
 * fully explains get a template description with zero VLM tokens; only
 * ambiguous regions (pixel-only, cascade reflow, combined move+resize) are
 * classified by the VLM. Pair-level type/description still come from the
 * largest region, keeping scoring comparable across arms.
 */
export async function runTieredPipeline(
  provider: Provider,
  pair: PairRecord,
  dataDir: string,
  cache?: CacheStore,
  maxRegions: number = MAX_REGIONS_TO_CLASSIFY,
): Promise<BaselineResult> {
  const before = await readFile(`${dataDir}/${pair.before}`);
  const after = await readFile(`${dataDir}/${pair.after}`);
  const detection: DetectionResult = detect(pair.domBefore, pair.domAfter, before, after);

  if (!detection.changed || detection.regions.length === 0) {
    return {
      pairId: pair.id,
      baseline: "tieredPipeline",
      predictedChanged: false,
      predictedRegions: [],
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  // Semantic merge: nested geometry-only regions (a card and its children
  // moving together) collapse into the outermost logical change unit.
  const merged = mergeNestedRegions(detection.regions);
  const sorted = [...merged].sort((a, b) => b.w * b.h - a.w * a.h).slice(0, maxRegions);

  // Batch-describe with root-cause attribution: geometry-only regions in a
  // pair that also has a non-geometry change get follower wording.
  const descriptions = describeRegions(sorted);
  const deterministic: RegionClassification[] = [];
  const escalated: CandidateRegion[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const region = sorted[i];
    const d = descriptions[i];
    if (d.route === "deterministic") {
      deterministic.push({
        region: { x: region.x, y: region.y, w: region.w, h: region.h },
        source: region.source,
        changeType: d.changeType!,
        description: d.description!,
        confidence: d.confidence!,
        usage: { inputTokens: 0, outputTokens: 0 },
        route: "deterministic",
        rootCause: d.rootCause,
      });
    } else {
      escalated.push(region);
    }
  }

  // classifyDetectedRegions sorts its input again (stable for distinct
  // sizes) and caps at maxRegions — the escalated list is already within cap.
  // Escalations are pixel-only repaints: no DOM explanation exists, so they
  // are their own root causes.
  const vlmClassifications: RegionClassification[] =
    escalated.length > 0
      ? (await classifyDetectedRegions(provider, cache, before, after, escalated, true, maxRegions)).map((c) => ({
          ...c,
          route: "vlm" as const,
          rootCause: true,
        }))
      : [];

  const classifications = [...deterministic, ...vlmClassifications]
    // pair-level type comes from the first entry: root causes (the region that
    // carries the actual change) before reflow followers, then largest first.
    // A removed card's container shrinking is a follower; the lifecycle region
    // must win even when the container is bigger.
    .sort((a, b) => {
      if ((b.rootCause ?? false) !== (a.rootCause ?? false)) return (b.rootCause ?? false) ? 1 : -1;
      return b.region.w * b.region.h - a.region.w * a.region.h;
    });

  if (classifications.length === 0) {
    return {
      pairId: pair.id,
      baseline: "tieredPipeline",
      predictedChanged: true,
      predictedRegions: detection.regions.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })),
      classifications: [],
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  const primary = classifications[0];

  return aggregateNone(
    {
      pairId: pair.id,
      baseline: "tieredPipeline",
      predictedChanged: true,
      predictedRegions: detection.regions.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })),
      predictedChangeType: primary.changeType,
      description: primary.description,
      classifications,
      inputTokens: classifications.reduce((s, c) => s + c.usage.inputTokens, 0),
      outputTokens: classifications.reduce((s, c) => s + c.usage.outputTokens, 0),
      cached: cache
        ? vlmClassifications.length === 0
          ? undefined // no VLM call happened — this pair has no cache concept; [].every() must not count as a hit
          : vlmClassifications.every((c) => c.cached === true)
        : undefined,
    },
    classifications,
    detection.visualOnly,
  );
}
