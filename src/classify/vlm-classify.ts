// VLM classification stage. Given a candidate region (from detect/regions.ts),
// crop before/after around it and ask the model to classify + describe the
// change. The model never sees the full image pair concatenated — per
// VLM-SubtleBench, that hurt 9/10 categories — and never does localization;
// that's the deterministic layer's job.

import type { Provider } from "../provider/types.js";
import { imageBlock, textBlock } from "../provider/types.js";
import { PNG } from "pngjs";
import type { CacheStore } from "../cache/store.js";
import { computeCacheKey, PROMPT_VERSION } from "../cache/key.js";
import { extractJson } from "../util/json.js";

export type ChangeKind =
  | "spatial-shift"
  | "color-change"
  | "size-change"
  | "text-change"
  | "element-add"
  | "element-remove"
  | "style-change"
  | "other"
  /** the detector flagged the region but no meaningful visual change exists;
   *  pair-level aggregation turns an all-"none" verdict back into "unchanged" */
  | "none";

export const CHANGE_KINDS: readonly ChangeKind[] = [
  "spatial-shift",
  "color-change",
  "size-change",
  "text-change",
  "element-add",
  "element-remove",
  "style-change",
  "other",
  "none",
];

export interface Classification {
  changeType: ChangeKind;
  description: string;
  confidence: number;
  usage: { inputTokens: number; outputTokens: number };
}

const CROP_PADDING = 16;

/** Crop a rect (with padding) out of a full-frame PNG buffer. Accepts any
 *  {x,y,w,h} — callers pass a CandidateRegion or its counterpartRect. */
export function cropRegion(pngBuffer: Buffer, region: { x: number; y: number; w: number; h: number }): Buffer {
  const src = PNG.sync.read(pngBuffer);
  // Regions can extend beyond the frame (e.g. a 1.35× scale pushes an element
  // partially off-viewport); clamp into bounds and never emit a 0-size crop.
  const x = Math.max(0, Math.min(src.width - 1, region.x - CROP_PADDING));
  const y = Math.max(0, Math.min(src.height - 1, region.y - CROP_PADDING));
  const w = Math.max(1, Math.min(src.width - x, region.w + 2 * CROP_PADDING));
  const h = Math.max(1, Math.min(src.height - y, region.h + 2 * CROP_PADDING));

  const out = new PNG({ width: w, height: h });
  PNG.bitblt(src, out, x, y, w, h, 0, 0);
  return PNG.sync.write(out);
}

const SYSTEM_PROMPT = `You are comparing a cropped "before" region and the corresponding cropped "after" region from a UI screenshot. A deterministic detector has already localized this region as containing a change (or borderline noise) — your job is ONLY to classify the type of change and describe it, not to search the rest of the image. If the two crops are effectively identical (render noise, no meaningful visual difference), answer "none" and say there is no meaningful change.

Respond with strict JSON only, no markdown fences:
{"changeType": "spatial-shift" | "color-change" | "size-change" | "text-change" | "element-add" | "element-remove" | "style-change" | "other" | "none", "description": "<one sentence>", "confidence": <0-1>}`;

/**
 * Ground-truth evidence from the DOM diff, passed to the classifier as a
 * text hint. Motivation: the 2026-08-19 MVP showed crop-then-classify loses
 * the reference frame needed for type judgments (border-radius needs other
 * corners, color shift needs other swatches) — but the DOM diff already
 * knows which computed properties changed, and telling the model costs
 * ~50 tokens. Rect changes name their axes (position vs size, with signed
 * deltas) so a translation can't be mistaken for a scaling, and element
 * add/remove gets an explicit lifecycle sentence since "added"/"removed"
 * are not computed properties.
 */
export interface DomHint {
  /** computed-property names that changed, e.g. ["borderRadius"], ["color","backgroundColor"] */
  fields: string[];
  /** element id when known */
  id?: string;
  /** signed rect deltas when the change is positional/dimensional, e.g. {dx: 32, dw: 0} */
  rectDelta?: { dx: number; dy: number; dw: number; dh: number };
  /** for element-remove regions: the rect the element occupied in the before frame (crop is the replacement's rect) */
  counterpartRect?: { x: number; y: number; w: number; h: number };
}

function px(n: number): string {
  return `${Math.round(n)}px`;
}

function hintSentence(hint: DomHint): string {
  const target = hint.id ? ` (element #${hint.id})` : "";

  // Element lifecycle changes get their own prompt shape: "added"/"removed"
  // are not computed properties, and the default fields sentence would be
  // more confusing than helpful.
  if (hint.fields.includes("removed")) {
    const orig = hint.counterpartRect
      ? ` It previously occupied ${px(hint.counterpartRect.w)}×${px(hint.counterpartRect.h)} at (${px(hint.counterpartRect.x)}, ${px(hint.counterpartRect.y)}).`
      : "";
    return `Additional evidence from the deterministic DOM diff: an element${target} was REMOVED from this area in the after frame.${orig} The before crop shows the element itself; the after crop shows whatever moved into its place. This is an element-remove — do not classify the replacement's appearance as a shift or style change.`;
  }
  if (hint.fields.includes("added")) {
    return `Additional evidence from the deterministic DOM diff: an element${target} was ADDED to this area in the after frame. The before crop has no such element; the after crop shows the new element. This is an element-add — do not classify it as a shift or style change.`;
  }

  // Position/size changes name the component axes and the signed deltas, so
  // the model can tell a translation (dx/dy only) from a scaling (dw/dh only)
  // without needing the global reference frame the crop removed.
  const hasGeometry = hint.fields.includes("position") || hint.fields.includes("size");
  if (hasGeometry) {
    const parts: string[] = [];
    if (hint.fields.includes("position") && hint.rectDelta) {
      parts.push(`moved by (${px(hint.rectDelta.dx)}, ${px(hint.rectDelta.dy)})`);
    }
    if (hint.fields.includes("size") && hint.rectDelta) {
      parts.push(`resized by (${px(hint.rectDelta.dw)} × ${px(hint.rectDelta.dh)})`);
    }
    const motion = parts.length > 0 ? `: ${parts.join(", ")}` : "";
    const other = hint.fields.filter((f) => f !== "position" && f !== "size");
    const also = other.length > 0 ? ` Also changed: ${other.join(", ")}.` : "";
    return `Additional evidence from the deterministic DOM diff: the element in this region${target} changed geometry${motion}. This is ground truth, not a guess — position-only change = spatial-shift, size-only change = size-change, both = both.${also}`;
  }

  return `Additional evidence from the deterministic DOM diff: the element in this region${target} changed these computed properties: ${hint.fields.join(", ")}. Treat this as a strong prior for changeType — the visual difference in the crop may be too subtle to see, but the DOM-level change is ground truth, not a guess.`;
}

export function buildSystemPrompt(hint?: DomHint): string {
  if (!hint || hint.fields.length === 0) return SYSTEM_PROMPT;
  return `${SYSTEM_PROMPT}

${hintSentence(hint)}`;
}

export async function classifyRegion(
  provider: Provider,
  beforeCrop: Buffer,
  afterCrop: Buffer,
  hint?: DomHint,
): Promise<Classification> {
  const result = await provider.send(
    buildSystemPrompt(hint),
    [
      {
        role: "user",
        content: [
          textBlock("Before region:"),
          imageBlock(beforeCrop.toString("base64"), "image/png"),
          textBlock("After region:"),
          imageBlock(afterCrop.toString("base64"), "image/png"),
        ],
      },
    ],
    // one sentence + a small JSON object: a tight output cap keeps this the
    // cheapest call in the pipeline and the cost log can attribute it
    { fn: "classify-region", maxTokens: 512 },
  );

  return { ...parseClassification(result.text), usage: result.usage };
}

/**
 * classifyRegion wrapped with a content-addressed cache: identical
 * before/after crop pixels skip the VLM call entirely and return the
 * previously stored classification with zero token usage.
 */
/** Same-key calls in flight — concurrent duplicates await the shared promise
 *  instead of each paying for their own API call. */
const inFlight = new Map<string, Promise<Classification>>();

export async function classifyRegionCached(
  provider: Provider,
  cache: CacheStore,
  beforeCrop: Buffer,
  afterCrop: Buffer,
  hint?: DomHint,
): Promise<Classification & { cached: boolean }> {
  const key = computeCacheKey(
    beforeCrop,
    afterCrop,
    hint ? JSON.stringify(hint) : undefined,
    `${provider.name}/${provider.model}`,
  );
  const hit = await cache.get(key);
  if (hit) {
    return { ...hit.classification, usage: { inputTokens: 0, outputTokens: 0 }, cached: true };
  }

  const pending = inFlight.get(key);
  if (pending) {
    const shared = await pending;
    return { ...shared, usage: { inputTokens: 0, outputTokens: 0 }, cached: true };
  }

  const call = classifyRegion(provider, beforeCrop, afterCrop, hint);
  inFlight.set(key, call);
  try {
    const result = await call;
    await cache.set(key, { classification: result, cachedAt: new Date().toISOString(), promptVersion: PROMPT_VERSION });
    return { ...result, cached: false };
  } finally {
    inFlight.delete(key);
  }
}

export function parseClassification(text: string): Omit<Classification, "usage"> {
  const parsed = extractJson(text) as
    | { changeType?: unknown; description?: unknown; confidence?: unknown }
    | undefined;
  if (!parsed) {
    return { changeType: "other", description: text.trim(), confidence: 0 };
  }
  const changeType: ChangeKind =
    typeof parsed.changeType === "string" && (CHANGE_KINDS as readonly string[]).includes(parsed.changeType)
      ? (parsed.changeType as ChangeKind)
      : "other";
  return {
    changeType,
    description: typeof parsed.description === "string" ? parsed.description : "",
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
  };
}
