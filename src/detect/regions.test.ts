import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { detect, mergeNestedRegions, type CandidateRegion } from "./regions.js";
import type { DomNode } from "./dom-diff.js";

function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    const off = i * 4;
    png.data[off] = rgb[0];
    png.data[off + 1] = rgb[1];
    png.data[off + 2] = rgb[2];
    png.data[off + 3] = 255;
  }
  return PNG.sync.write(png);
}

function node(overrides: Partial<DomNode> = {}): DomNode {
  return {
    path: "DIV:0",
    tag: "DIV",
    id: "x",
    className: "",
    text: "",
    rect: { x: 10, y: 10, w: 20, h: 15 },
    style: { color: "rgb(0,0,0)", backgroundColor: "rgb(255,255,255)", fontWeight: "400", borderRadius: "0px", opacity: "1", boxShadow: "none", border: "0px none rgb(0,0,0)" },
    ...overrides,
  };
}

test("detect: no DOM change suppresses pixel noise (no-change pair)", () => {
  // identical DOM, but images differ slightly (render-timing/AA noise)
  const before = [node()];
  const after = [node()];
  const beforePng = solidPng(60, 60, [255, 255, 255]);
  const afterPng = solidPng(60, 60, [254, 254, 254]); // subtle uniform noise, well over pixelmatch threshold potentially
  const result = detect(JSON.stringify(before), JSON.stringify(after), beforePng, afterPng);
  assert.equal(result.changed, false);
  assert.equal(result.regions.length, 0);
});

test("detect: DOM change produces a candidate region even without pixel corroboration", () => {
  const before = [node({})];
  const after = [node({ style: { ...node().style, backgroundColor: "rgb(220,38,38)" } })];
  const beforePng = solidPng(60, 60, [255, 255, 255]);
  const afterPng = solidPng(60, 60, [255, 255, 255]); // pixel diff sees nothing (contrived)
  const result = detect(JSON.stringify(before), JSON.stringify(after), beforePng, afterPng);
  assert.equal(result.changed, true);
  assert.equal(result.regions.length, 1);
  assert.equal(result.regions[0].source, "dom");
});

test("detect: DOM change corroborated by pixel diff is marked dom+pixel", () => {
  const before = [node({ rect: { x: 10, y: 10, w: 20, h: 15 } })];
  const after = [node({ rect: { x: 30, y: 10, w: 20, h: 15 } })];
  const beforePng = solidPng(80, 80, [255, 255, 255]);
  const afterPng = new PNG({ width: 80, height: 80 });
  for (let y = 0; y < 80; y++) {
    for (let x = 0; x < 80; x++) {
      const off = (y * 80 + x) * 4;
      const inRegion = x >= 30 && x < 50 && y >= 10 && y < 25;
      const [r, g, b] = inRegion ? [220, 38, 38] : [255, 255, 255];
      afterPng.data[off] = r;
      afterPng.data[off + 1] = g;
      afterPng.data[off + 2] = b;
      afterPng.data[off + 3] = 255;
    }
  }
  const result = detect(JSON.stringify(before), JSON.stringify(after), beforePng, PNG.sync.write(afterPng));
  assert.equal(result.changed, true);
  assert.ok(result.regions.some((r) => r.source === "dom+pixel"));
});

test("detect: rect changes carry position/size fields and the signed delta", () => {
  const before = [node({ rect: { x: 10, y: 10, w: 20, h: 15 } })];
  const after = [node({ rect: { x: 10, y: 10, w: 26, h: 15 } })]; // grew wider only
  const img = solidPng(60, 60, [255, 255, 255]);
  const result = detect(JSON.stringify(before), JSON.stringify(after), img, img);
  assert.equal(result.regions.length, 1);
  assert.deepEqual(result.regions[0].domChangedFields, ["size"]);
  assert.deepEqual(result.regions[0].rectDelta, { dx: 0, dy: 0, dw: 6, dh: 0 });
});

function blockPng(width: number, height: number, block: { x: number; y: number; w: number; h: number }, rgb: [number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const off = (y * width + x) * 4;
      const inBlock = x >= block.x && x < block.x + block.w && y >= block.y && y < block.y + block.h;
      const [r, g, b] = inBlock ? rgb : [255, 255, 255];
      png.data[off] = r;
      png.data[off + 1] = g;
      png.data[off + 2] = b;
      png.data[off + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

test("detect: DOM-unchanged pair with a large pixel delta escalates as visual-only (canvas case)", () => {
  const dom = JSON.stringify([node()]);
  const beforePng = solidPng(100, 100, [255, 255, 255]);
  // 20×20 repaint = 4% of the frame, far above the 0.2% default threshold
  const afterPng = blockPng(100, 100, { x: 40, y: 40, w: 20, h: 20 }, [0, 0, 0]);
  const result = detect(dom, dom, beforePng, afterPng);
  assert.equal(result.changed, true);
  assert.equal(result.visualOnly, true);
  assert.equal(result.domChangeCount, 0);
  assert.equal(result.regions.length, 1);
  assert.equal(result.regions[0].source, "pixel");
  // AA exclusion may shave the block's border; assert the interior survives
  assert.ok(result.regions[0].w >= 16 && result.regions[0].h >= 16);
  assert.ok(result.pixelChangedFraction > 0.02);
});

test("detect: DOM-unchanged pair below the pixel threshold stays suppressed", () => {
  const dom = JSON.stringify([node()]);
  const beforePng = solidPng(200, 200, [255, 255, 255]);
  // 4×4 speck = 0.04% of the frame, below the 0.2% default threshold
  const afterPng = blockPng(200, 200, { x: 100, y: 100, w: 4, h: 4 }, [0, 0, 0]);
  const result = detect(dom, dom, beforePng, afterPng);
  assert.equal(result.changed, false);
  assert.equal(result.visualOnly, false);
  assert.equal(result.regions.length, 0);
});

test("detect: pixelOnlyThreshold override can escalate sub-default deltas", () => {
  const dom = JSON.stringify([node()]);
  const beforePng = solidPng(200, 200, [255, 255, 255]);
  const afterPng = blockPng(200, 200, { x: 100, y: 100, w: 4, h: 4 }, [0, 0, 0]);
  const result = detect(dom, dom, beforePng, afterPng, { pixelOnlyThreshold: 0.0001 });
  assert.equal(result.changed, true);
  assert.equal(result.visualOnly, true);
  // the speck is below the grouping min-area, so the mask-bounds fallback kicks in
  assert.equal(result.regions.length, 1);
  assert.deepEqual({ x: result.regions[0].x, y: result.regions[0].y, w: result.regions[0].w, h: result.regions[0].h }, { x: 100, y: 100, w: 4, h: 4 });
});

test("detect: DOM-change path reports pixel audit fields and visualOnly=false", () => {
  const before = [node()];
  const after = [node({ style: { ...node().style, backgroundColor: "rgb(220,38,38)" } })];
  const img = solidPng(60, 60, [255, 255, 255]);
  const result = detect(JSON.stringify(before), JSON.stringify(after), img, img);
  assert.equal(result.visualOnly, false);
  assert.equal(result.pixelChangedCount, 0);
  assert.equal(result.pixelChangedFraction, 0);
});

test("detect: removed element region uses the replacement's after-rect and keeps the original as counterpart", () => {
  // link-3 removed; link-2 (in after) sits where link-3 used to be
  const before = [
    node({ path: "A:0", id: "link-2", rect: { x: 10, y: 10, w: 20, h: 10 } }),
    node({ path: "A:1", id: "link-3", rect: { x: 40, y: 10, w: 15, h: 10 } }),
  ];
  const after = [
    node({ path: "A:0", id: "link-2", rect: { x: 35, y: 10, w: 20, h: 10 } }), // slid into link-3's area
  ];
  const img = solidPng(80, 40, [255, 255, 255]);
  const result = detect(JSON.stringify(before), JSON.stringify(after), img, img);
  const removed = result.regions.find((r) => r.domId === "link-3");
  assert.ok(removed, "expected a region for the removed element");
  assert.deepEqual(removed.domChangedFields, ["removed"]);
  // region rect = the replacement's after-rect (link-2 at 35,10), not the vacated 40,10
  assert.deepEqual({ x: removed.x, y: removed.y, w: removed.w, h: removed.h }, { x: 35, y: 10, w: 20, h: 10 });
  assert.deepEqual(removed.counterpartRect, { x: 40, y: 10, w: 15, h: 10 });
});

// ── v0.3 semantic region merging ──

function geomRegion(x: number, y: number, w: number, h: number, id = ""): CandidateRegion {
  return { x, y, w, h, source: "dom", domChangedFields: ["position"], domId: id, rectDelta: { dx: 4, dy: 0, dw: 0, dh: 0 } };
}

test("mergeNestedRegions: a child moving inside its moving parent collapses into the parent", () => {
  const card = geomRegion(10, 10, 100, 60, "card-1");
  const title = geomRegion(14, 14, 90, 16, ""); // inside card
  const body = geomRegion(14, 34, 90, 30, "");  // inside card
  const merged = mergeNestedRegions([title, body, card]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].domId, "card-1");
});

test("mergeNestedRegions: non-geometry children are kept even when nested", () => {
  const card = geomRegion(10, 10, 100, 60, "card-1");
  const textChild: CandidateRegion = { x: 14, y: 14, w: 90, h: 16, source: "dom", domChangedFields: ["text"], domId: "t" };
  const merged = mergeNestedRegions([textChild, card]);
  assert.equal(merged.length, 2); // text change is not a follower
});

test("mergeNestedRegions: sibling moves are not merged (no containment)", () => {
  const a = geomRegion(0, 0, 100, 40, "a");
  const b = geomRegion(110, 0, 100, 40, "b");
  const merged = mergeNestedRegions([a, b]);
  assert.equal(merged.length, 2);
});

test("mergeNestedRegions: equal-rect regions don't loop or merge", () => {
  const a = geomRegion(0, 0, 100, 40, "a");
  const b = geomRegion(0, 0, 100, 40, "b");
  const merged = mergeNestedRegions([a, b]);
  assert.equal(merged.length, 2);
});

// ── v0.7 ignore regions (dynamic-content masks) ──

test("detect: DOM change fully inside an ignore rect is dropped", () => {
  const before = [node({ id: "ad", rect: { x: 10, y: 10, w: 20, h: 15 } })];
  const after = [node({ id: "ad", rect: { x: 10, y: 10, w: 20, h: 15 }, style: { ...node().style, backgroundColor: "rgb(220,38,38)" } })];
  const img = solidPng(60, 60, [255, 255, 255]);
  const result = detect(JSON.stringify(before), JSON.stringify(after), img, img, {
    ignoreRects: [{ x: 0, y: 0, w: 40, h: 30 }],
  });
  assert.equal(result.changed, false);
  assert.equal(result.regions.length, 0);
});

test("detect: DOM change only partially overlapping an ignore rect is kept", () => {
  const before = [node({ id: "ad", rect: { x: 10, y: 10, w: 20, h: 15 } })];
  const after = [node({ id: "ad", rect: { x: 10, y: 10, w: 20, h: 15 }, style: { ...node().style, backgroundColor: "rgb(220,38,38)" } })];
  const img = solidPng(60, 60, [255, 255, 255]);
  const result = detect(JSON.stringify(before), JSON.stringify(after), img, img, {
    ignoreRects: [{ x: 15, y: 10, w: 10, h: 15 }], // covers only the right half
  });
  assert.equal(result.changed, true);
});

test("detect: pixel delta inside an ignore rect never crosses the threshold", () => {
  const dom = JSON.stringify([node()]);
  const beforePng = solidPng(100, 100, [255, 255, 255]);
  const afterPng = blockPng(100, 100, { x: 40, y: 40, w: 20, h: 20 }, [0, 0, 0]);
  const result = detect(dom, dom, beforePng, afterPng, {
    ignoreRects: [{ x: 35, y: 35, w: 30, h: 30 }],
  });
  assert.equal(result.changed, false);
});
