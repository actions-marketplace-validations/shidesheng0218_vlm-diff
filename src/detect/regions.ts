// Fuses DOM diff + perceptual diff into final candidate regions.
//
// Core design decision (relaxed in v0.2): the DOM diff is the authority on
// whether the page MODEL changed. When it reports zero changes, sub-threshold
// pixel deltas are suppressed as anti-aliasing/render-timing noise — but a
// pixel delta above `pixelOnlyThreshold` is treated as a visual-only change
// (canvas/SVG repaint, image swap, third-party widget) and escalated to the
// VLM tier, which can still rule it "none" end-to-end (see runTieredPipeline).
// The v0.1 rule suppressed EVERYTHING on DOM-unchanged pairs, which made the
// escalation path unreachable for exactly the cases it was built for.
//
// When DOM diff DOES report changes, its rects are the primary candidate
// regions (precise, attributable to a specific element/property). Pixel
// regions are used only as corroboration/expansion for changes that are
// visually significant but not captured by DOM diff.

import { diffDom, parseSnapshot, type DomChange, type FieldChange, type RectDelta } from "./dom-diff.js";
import { diffImages, groupRegions, maskBounds, type PixelRegion } from "./perceptual-diff.js";

/**
 * Fraction of AA-excluded changed pixels above which a DOM-unchanged pair is
 * treated as a visual-only change instead of render noise. 0.2% of the frame
 * sits far above re-render jitter (measured <0.01% on the fixture set) and
 * far below any genuine repaint (canvas/image swaps change >1%).
 */
export const DEFAULT_PIXEL_ONLY_THRESHOLD = 0.002;

export interface IgnoreRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DetectOptions {
  /** override DEFAULT_PIXEL_ONLY_THRESHOLD (fraction of frame pixels, 0–1) */
  pixelOnlyThreshold?: number;
  /**
   * Dynamic-content masks (Applitools-style ignore regions): DOM changes
   * fully inside an ignore rect and pixel regions centered inside one are
   * dropped before region construction — timestamps, ads, and carousels stop
   * being false positives.
   */
  ignoreRects?: IgnoreRect[];
}

export interface CandidateRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  source: "dom" | "pixel" | "dom+pixel";
  domChangedFields?: string[];
  domId?: string;
  /** positional path of the DOM node (ids can be empty) */
  domPath?: string;
  /** before/after values of the changed properties, when the region came from a DOM change */
  domValues?: Record<string, FieldChange>;
  /** after − before rect delta, when the change includes a rect change */
  rectDelta?: RectDelta;
  /** for removed elements: the after-frame rect of the element that now occupies the vacated area */
  counterpartRect?: { x: number; y: number; w: number; h: number };
}

export interface DetectionResult {
  changed: boolean;
  regions: CandidateRegion[];
  domChangeCount: number;
  pixelRegionCount: number;
  /** pixels flagged by pixelmatch (anti-aliasing excluded) */
  pixelChangedCount: number;
  /** pixelChangedCount as a fraction of all frame pixels */
  pixelChangedFraction: number;
  /** true when the DOM is unchanged but the pixel delta crossed the threshold */
  visualOnly: boolean;
}

const GEOMETRY_ONLY = new Set(["position", "size"]);
function isGeometryOnlyRegion(r: CandidateRegion): boolean {
  return !!r.domChangedFields && r.domChangedFields.length > 0 && r.domChangedFields.every((f) => GEOMETRY_ONLY.has(f));
}
function containsRect(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return b.x >= a.x && b.y >= a.y && b.x + b.w <= a.x + a.w && b.y + b.h <= a.y + a.h;
}

/**
 * Semantic merge: a geometry-only region fully contained in a larger
 * geometry-only region is the same logical move (a card and its children
 * moving together is one move). Collapse the inner into the outer so a
 * single logical change doesn't fan out into N regions. Applied at the
 * pipeline level (not in detect()) so detection stays granular for metrics.
 */
export function mergeNestedRegions(regions: CandidateRegion[]): CandidateRegion[] {
  const result = [...regions];
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < result.length; i++) {
      for (let j = 0; j < result.length; j++) {
        if (i === j) continue;
        const inner = result[i];
        const outer = result[j];
        if (!isGeometryOnlyRegion(inner) || !isGeometryOnlyRegion(outer)) continue;
        if (outer.w * outer.h <= inner.w * inner.h) continue; // outer must be strictly larger
        if (!containsRect(outer, inner)) continue;
        result.splice(i, 1);
        changed = true;
        break outer;
      }
    }
  }
  return result;
}

function rectsOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function overlapArea(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }): number {
  const iw = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const ih = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return iw > 0 && ih > 0 ? iw * ih : 0;
}

export function detect(
  domBeforeJson: string,
  domAfterJson: string,
  beforePng: Buffer,
  afterPng: Buffer,
  options?: DetectOptions,
): DetectionResult {
  const domBefore = parseSnapshot(domBeforeJson);
  const domAfter = parseSnapshot(domAfterJson);
  const ignoreRects = options?.ignoreRects ?? [];

  const { mask, width, height, changedCount: rawChangedCount } = diffImages(beforePng, afterPng);

  // dynamic-content masks: zero the mask inside ignore rects before any
  // counting/grouping, so ignored areas don't even reach the noise threshold
  let changedCount = rawChangedCount;
  if (ignoreRects.length > 0) {
    for (const ig of ignoreRects) {
      const x0 = Math.max(0, ig.x);
      const y0 = Math.max(0, ig.y);
      const x1 = Math.min(width, ig.x + ig.w);
      const y1 = Math.min(height, ig.y + ig.h);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) mask[y * width + x] = 0;
      }
    }
    changedCount = 0;
    for (let i = 0; i < mask.length; i++) changedCount += mask[i];
  }

  // DOM changes fully inside an ignore rect are dropped too
  const domChanges: DomChange[] = diffDom(domBefore, domAfter).filter(
    (dc) => !ignoreRects.some((ig) => containsRect(ig, dc.rect)),
  );

  const pixelRegions: PixelRegion[] = groupRegions(mask, width, height);
  const framePixels = width * height;
  const pixelChangedFraction = framePixels > 0 ? changedCount / framePixels : 0;
  const pixelAudit = {
    pixelChangedCount: changedCount,
    pixelChangedFraction,
  };

  if (domChanges.length === 0) {
    const threshold = options?.pixelOnlyThreshold ?? DEFAULT_PIXEL_ONLY_THRESHOLD;

    // No-change suppression: the DOM diff is the authority on the page model,
    // so sub-threshold pixel deltas are render noise and do not count.
    if (pixelChangedFraction < threshold) {
      return {
        changed: false,
        regions: [],
        domChangeCount: 0,
        pixelRegionCount: pixelRegions.length,
        ...pixelAudit,
        visualOnly: false,
      };
    }

    // Visual-only change: the pixels moved enough to matter but nothing in
    // the DOM explains it (canvas/SVG repaint, image swap, embedded widget).
    // Hand the pixel regions to the VLM tier; it may still rule the delta
    // meaningless ("none") at aggregation time.
    const regions: CandidateRegion[] =
      pixelRegions.length > 0
        ? pixelRegions.map((pr) => ({ x: pr.x, y: pr.y, w: pr.w, h: pr.h, source: "pixel" }))
        : // changedCount crossed the threshold but every component was below
          // the grouping min-area: fall back to the mask's bounding box so the
          // delta still reaches the VLM instead of vanishing.
          (() => {
            const bounds = maskBounds(mask, width, height);
            return bounds ? [{ ...bounds, source: "pixel" as const }] : [];
          })();

    return {
      changed: regions.length > 0,
      regions,
      domChangeCount: 0,
      pixelRegionCount: pixelRegions.length,
      ...pixelAudit,
      visualOnly: true,
    };
  }

  const regions: CandidateRegion[] = domChanges.map((dc) => {
    // Removed elements have no after-frame rect: use the rect of whatever now
    // overlaps the vacated area, so the classifier sees the replacement
    // (the cascade sibling that slid into place) rather than empty space.
    const afterRect = dc.changedFields.includes("removed")
      ? domAfter
          .filter((n) => rectsOverlap(dc.rect, n.rect))
          .sort((a, b) => overlapArea(dc.rect, b.rect) - overlapArea(dc.rect, a.rect))[0]?.rect
      : undefined;
    const rect = afterRect ?? dc.rect;
    const corroborated = pixelRegions.some((pr) => rectsOverlap(rect, pr));
    return {
      x: rect.x,
      y: rect.y,
      w: Math.max(rect.w, 1),
      h: Math.max(rect.h, 1),
      source: corroborated ? "dom+pixel" : "dom",
      domChangedFields: dc.changedFields,
      domId: dc.id,
      domPath: dc.path,
      ...(dc.values ? { domValues: dc.values } : {}),
      ...(dc.rectDelta ? { rectDelta: dc.rectDelta } : {}),
      ...(afterRect ? { counterpartRect: { ...dc.rect } } : {}),
    };
  });

  // Pixel regions with no corresponding DOM change (e.g. canvas/non-DOM
  // repaint) are added as pixel-only candidates.
  for (const pr of pixelRegions) {
    const alreadyCovered = domChanges.some((dc) => rectsOverlap(dc.rect, pr));
    if (!alreadyCovered) {
      regions.push({ x: pr.x, y: pr.y, w: pr.w, h: pr.h, source: "pixel" });
    }
  }

  return {
    changed: true,
    regions,
    domChangeCount: domChanges.length,
    pixelRegionCount: pixelRegions.length,
    ...pixelAudit,
    visualOnly: false,
  };
}
