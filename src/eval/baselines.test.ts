import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyDetectedRegions, MAX_REGIONS_TO_CLASSIFY, runFullPipeline, runTieredPipeline } from "./baselines.js";
import type { PairRecord } from "./types.js";
import { scriptedProvider } from "../test-utils.js";
import { MemoryCacheStore } from "../cache/store.js";
import type { CandidateRegion } from "../detect/regions.js";
import type { DomNode } from "../detect/dom-diff.js";

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

function region(x: number, y: number, w: number, h: number, extra?: Partial<CandidateRegion>): CandidateRegion {
  return { x, y, w, h, source: "dom", ...extra };
}

const okTurn = (type: string) => ({
  text: `{"changeType":"${type}","description":"d","confidence":0.9}`,
});

test("classifyDetectedRegions: classifies every region, largest first, and sums usage", async () => {
  const provider = scriptedProvider([okTurn("color-change"), okTurn("text-change"), okTurn("spatial-shift")]);
  const before = solidPng(200, 200, [255, 255, 255]);
  const after = solidPng(200, 200, [200, 200, 200]);
  const regions = [
    region(10, 10, 5, 5), // smallest
    region(50, 50, 40, 40), // largest
    region(120, 120, 10, 10),
  ];

  const results = await classifyDetectedRegions(provider, undefined, before, after, regions, true);

  assert.equal(results.length, 3);
  assert.equal(provider.calls.length, 3);
  // largest region classified first
  assert.deepEqual(results[0].region, { x: 50, y: 50, w: 40, h: 40 });
  assert.equal(results[0].changeType, "color-change");
  assert.equal(results[2].changeType, "spatial-shift");
  // scriptedProvider bills 10 in / 5 out per call
  const inputSum = results.reduce((s, r) => s + r.usage.inputTokens, 0);
  assert.equal(inputSum, 30);
});

test("classifyDetectedRegions: respects the maxRegions cap", async () => {
  const provider = scriptedProvider([okTurn("color-change"), okTurn("color-change")]);
  const before = solidPng(200, 200, [255, 255, 255]);
  const after = solidPng(200, 200, [200, 200, 200]);
  const regions = [
    region(0, 0, 50, 50),
    region(60, 60, 40, 40),
    region(120, 120, 30, 30),
    region(160, 0, 20, 20),
  ];

  const results = await classifyDetectedRegions(provider, undefined, before, after, regions, true, 2);

  assert.equal(results.length, 2);
  assert.equal(provider.calls.length, 2);
  assert.deepEqual(results[0].region, { x: 0, y: 0, w: 50, h: 50 });
  assert.deepEqual(results[1].region, { x: 60, y: 60, w: 40, h: 40 });
});

test("classifyDetectedRegions: each region's DOM fields become its own hint", async () => {
  const provider = scriptedProvider([okTurn("color-change"), okTurn("style-change")]);
  const before = solidPng(200, 200, [255, 255, 255]);
  const after = solidPng(200, 200, [200, 200, 200]);
  const regions = [
    region(10, 10, 40, 40, { domChangedFields: ["backgroundColor"], domId: "btn" }),
    region(80, 80, 30, 30, { domChangedFields: ["borderRadius"], domId: "card" }),
  ];

  await classifyDetectedRegions(provider, undefined, before, after, regions, true);

  assert.equal(provider.systems.length, 2);
  assert.match(provider.systems[0], /backgroundColor/);
  assert.match(provider.systems[0], /#btn/);
  assert.match(provider.systems[1], /borderRadius/);
  assert.match(provider.systems[1], /#card/);
});

test("classifyDetectedRegions: useDomHint=false drops hints even when fields exist", async () => {
  const provider = scriptedProvider([okTurn("color-change")]);
  const before = solidPng(100, 100, [255, 255, 255]);
  const after = solidPng(100, 100, [200, 200, 200]);
  const regions = [region(10, 10, 20, 20, { domChangedFields: ["backgroundColor"] })];

  await classifyDetectedRegions(provider, undefined, before, after, regions, false);

  assert.doesNotMatch(provider.systems[0], /ground truth/);
});

test("classifyDetectedRegions: cache hits zero out usage on the second run", async () => {
  const provider = scriptedProvider([okTurn("color-change"), okTurn("text-change")]);
  const cache = new MemoryCacheStore();
  const before = solidPng(200, 200, [255, 255, 255]);
  const after = solidPng(200, 200, [200, 200, 200]);
  const regions = [region(10, 10, 40, 40), region(80, 80, 20, 20)];

  const first = await classifyDetectedRegions(provider, cache, before, after, regions, true);
  assert.equal(provider.calls.length, 2);
  assert.ok(first.every((r) => r.cached === false));

  const second = await classifyDetectedRegions(provider, cache, before, after, regions, true);
  assert.equal(provider.calls.length, 2); // no new calls
  assert.ok(second.every((r) => r.cached === true));
  assert.equal(second.reduce((s, r) => s + r.usage.inputTokens, 0), 0);
});

test("MAX_REGIONS_TO_CLASSIFY covers the whole dataset's max region count", async () => {
  // v0.1 topped out at 6 regions per pair (element-remove in card-list);
  // the v0.2 canvas repaint produces 8 separate bar regions
  assert.ok(MAX_REGIONS_TO_CLASSIFY >= 8);
});

// ── runTieredPipeline ──

function domNode(id: string, overrides: Partial<DomNode> = {}): DomNode {
  return {
    path: `DIV:${id}`,
    tag: "DIV",
    id,
    className: "",
    text: "",
    rect: { x: 10, y: 10, w: 40, h: 40 },
    style: {
      color: "rgb(17, 24, 39)",
      backgroundColor: "rgb(255, 255, 255)",
      fontWeight: "400",
      borderRadius: "0px",
      opacity: "1",
      boxShadow: "none",
      border: "0px none rgb(0, 0, 0)",
    },
    ...overrides,
  };
}

function fillRect(png: PNG, x: number, y: number, w: number, h: number, rgb: [number, number, number]): void {
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const off = (yy * png.width + xx) * 4;
      png.data[off] = rgb[0];
      png.data[off + 1] = rgb[1];
      png.data[off + 2] = rgb[2];
      png.data[off + 3] = 255;
    }
  }
}

async function writePairFixture(before: PNG, after: PNG): Promise<{ dataDir: string; pair: PairRecord }> {
  const dataDir = await mkdtemp(join(tmpdir(), "vlm-diff-tiered-"));
  await writeFile(join(dataDir, "before.png"), PNG.sync.write(before));
  await writeFile(join(dataDir, "after.png"), PNG.sync.write(after));
  const pair: PairRecord = {
    id: "tiered-test",
    fixture: "test.html",
    mutationId: "test",
    kind: "color-change",
    magnitude: "large",
    description: "test fixture",
    before: "before.png",
    after: "after.png",
    domBefore: JSON.stringify([domNode("btn")]),
    domAfter: JSON.stringify([domNode("btn", { style: { ...domNode("btn").style, backgroundColor: "rgb(220, 38, 38)" } })]),
  };
  return { dataDir, pair };
}

test("runTieredPipeline: fully-explained color change uses zero VLM calls", async () => {
  const provider = scriptedProvider([okTurn("other")]);
  const before = new PNG({ width: 200, height: 200 });
  fillRect(before, 0, 0, 200, 200, [255, 255, 255]);
  const after = new PNG({ width: 200, height: 200 });
  fillRect(after, 0, 0, 200, 200, [255, 255, 255]);
  fillRect(after, 10, 10, 40, 40, [220, 38, 38]);

  const { dataDir, pair } = await writePairFixture(before, after);
  try {
    const result = await runTieredPipeline(provider, pair, dataDir);

    assert.equal(provider.calls.length, 0); // deterministic tier covered everything
    assert.equal(result.predictedChanged, true);
    assert.equal(result.predictedChangeType, "color-change");
    assert.match(result.description!, /background color changed from white/);
    assert.match(result.description!, /to red/);
    assert.equal(result.inputTokens, 0);
    assert.ok(result.classifications!.every((c) => c.route === "deterministic"));
    assert.equal(result.classifications![0].confidence, 1);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("runTieredPipeline: pixel-only region escalates to the VLM, DOM regions stay deterministic", async () => {
  const provider = scriptedProvider([okTurn("other")]);
  const before = new PNG({ width: 200, height: 200 });
  fillRect(before, 0, 0, 200, 200, [255, 255, 255]);
  const after = new PNG({ width: 200, height: 200 });
  fillRect(after, 0, 0, 200, 200, [255, 255, 255]);
  fillRect(after, 10, 10, 40, 40, [220, 38, 38]); // matches the DOM change
  fillRect(after, 150, 150, 20, 20, [0, 0, 0]); // repaint with no DOM signal

  const { dataDir, pair } = await writePairFixture(before, after);
  try {
    const result = await runTieredPipeline(provider, pair, dataDir);

    assert.equal(provider.calls.length, 1); // only the pixel-only region
    assert.equal(result.classifications!.length, 2);
    const routes = result.classifications!.map((c) => c.route).sort();
    assert.deepEqual(routes, ["deterministic", "vlm"]);
    // pair-level type comes from the largest region, which is the deterministic one
    assert.equal(result.predictedChangeType, "color-change");
    assert.equal(result.inputTokens, 10); // one scripted call
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("runTieredPipeline: pair-level type prefers the root cause over a larger reflow follower", async () => {
  const provider = scriptedProvider([okTurn("other")]);
  // container with three children; the last child is removed and the
  // container shrinks — the container's follower region is larger than the
  // removed element's region, but element-remove must still win pair-level.
  const child = (i: number, rect: { x: number; y: number; w: number; h: number }, text: string): DomNode =>
    domNode(`card-${i}`, { path: `DIV:0/DIV:${i}`, rect, text });
  const domBefore = [
    domNode("grid", { path: "DIV:0", rect: { x: 0, y: 0, w: 300, h: 300 }, text: "" }),
    child(0, { x: 0, y: 0, w: 300, h: 100 }, "Card 1"),
    child(1, { x: 0, y: 100, w: 300, h: 100 }, "Card 2"),
    child(2, { x: 0, y: 200, w: 300, h: 100 }, "Card 3"),
  ];
  const domAfter = [domBefore[0], domBefore[1], domBefore[2]].map((n) =>
    n.id === "grid" ? { ...n, rect: { x: 0, y: 0, w: 300, h: 200 } } : n,
  );

  const before = new PNG({ width: 400, height: 400 });
  fillRect(before, 0, 0, 400, 400, [255, 255, 255]);
  fillRect(before, 0, 0, 300, 300, [240, 240, 240]);
  fillRect(before, 0, 200, 300, 100, [200, 200, 200]); // card 3
  const after = new PNG({ width: 400, height: 400 });
  fillRect(after, 0, 0, 400, 400, [255, 255, 255]);
  fillRect(after, 0, 0, 300, 200, [240, 240, 240]);

  const dataDir = await mkdtemp(join(tmpdir(), "vlm-diff-tiered-"));
  await writeFile(join(dataDir, "before.png"), PNG.sync.write(before));
  await writeFile(join(dataDir, "after.png"), PNG.sync.write(after));
  const pair: PairRecord = {
    id: "tiered-remove-test",
    fixture: "test.html",
    mutationId: "element-remove",
    kind: "element-remove",
    magnitude: "large",
    description: "remove last child",
    before: "before.png",
    after: "after.png",
    domBefore: JSON.stringify(domBefore),
    domAfter: JSON.stringify(domAfter),
  };

  try {
    const result = await runTieredPipeline(provider, pair, dataDir);

    assert.equal(provider.calls.length, 0);
    assert.equal(result.predictedChangeType, "element-remove");
    assert.match(result.description!, /removed from the layout/);
    // the container region is present as a follower with reflow wording
    const follower = result.classifications!.find((c) => c.changeType === "size-change");
    assert.ok(follower);
    assert.match(follower!.description!, /as part of a layout shift/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

// ── visual-only pairs (v0.2 relaxed suppression) ──

async function writeVisualOnlyFixture(): Promise<{ dataDir: string; pair: PairRecord }> {
  const before = new PNG({ width: 200, height: 200 });
  fillRect(before, 0, 0, 200, 200, [255, 255, 255]);
  const after = new PNG({ width: 200, height: 200 });
  fillRect(after, 0, 0, 200, 200, [255, 255, 255]);
  // 60×60 repaint = 9% of the frame: a canvas-style repaint, zero DOM signal
  fillRect(after, 70, 70, 60, 60, [37, 99, 235]);

  const dataDir = await mkdtemp(join(tmpdir(), "vlm-diff-visual-"));
  await writeFile(join(dataDir, "before.png"), PNG.sync.write(before));
  await writeFile(join(dataDir, "after.png"), PNG.sync.write(after));
  const pair: PairRecord = {
    id: "visual-only-test",
    fixture: "test.html",
    mutationId: "canvas-repaint",
    kind: "other",
    magnitude: "large",
    description: "canvas repaint with no DOM signal",
    before: "before.png",
    after: "after.png",
    domBefore: JSON.stringify([domNode("host")]),
    domAfter: JSON.stringify([domNode("host")]), // identical DOM
  };
  return { dataDir, pair };
}

test("runTieredPipeline: visual-only pair escalates and keeps a real VLM-confirmed change", async () => {
  const provider = scriptedProvider([okTurn("color-change")]);
  const { dataDir, pair } = await writeVisualOnlyFixture();
  try {
    const result = await runTieredPipeline(provider, pair, dataDir);

    assert.equal(provider.calls.length, 1); // the pixel-only region escalated
    assert.equal(result.predictedChanged, true);
    assert.equal(result.predictedChangeType, "color-change");
    assert.equal(result.classifications!.length, 1);
    assert.equal(result.classifications![0].route, "vlm");
    assert.ok(result.inputTokens > 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("runTieredPipeline: visual-only pair flips back to unchanged when the VLM rules none", async () => {
  const provider = scriptedProvider([okTurn("none")]);
  const { dataDir, pair } = await writeVisualOnlyFixture();
  try {
    const result = await runTieredPipeline(provider, pair, dataDir);

    assert.equal(provider.calls.length, 1);
    assert.equal(result.predictedChanged, false);
    assert.equal(result.predictedChangeType, "none");
    // classifications and usage stay attached for auditing
    assert.equal(result.classifications!.length, 1);
    assert.ok(result.inputTokens > 0);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("runFullPipeline: DOM-explained pair is never vetoed by an all-none VLM verdict", async () => {
  // DOM says backgroundColor changed; a confused VLM answers "none". The DOM
  // diff is authoritative, so the pair verdict must stay changed even though
  // the model's "none" is preserved verbatim as the pair-level type.
  const provider = scriptedProvider([okTurn("none")]);
  const before = new PNG({ width: 200, height: 200 });
  fillRect(before, 0, 0, 200, 200, [255, 255, 255]);
  const after = new PNG({ width: 200, height: 200 });
  fillRect(after, 0, 0, 200, 200, [255, 255, 255]);
  fillRect(after, 10, 10, 40, 40, [220, 38, 38]);

  const { dataDir, pair } = await writePairFixture(before, after);
  try {
    const result = await runFullPipeline(provider, pair, dataDir);

    assert.equal(result.predictedChanged, true); // DOM evidence wins
    assert.equal(result.predictedChangeType, "none"); // model answer preserved
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("runTieredPipeline: fully deterministic pair has no cache concept (cached === undefined)", async () => {
  const provider = scriptedProvider([okTurn("other")]);
  const cache = new MemoryCacheStore();
  const before = new PNG({ width: 200, height: 200 });
  fillRect(before, 0, 0, 200, 200, [255, 255, 255]);
  const after = new PNG({ width: 200, height: 200 });
  fillRect(after, 0, 0, 200, 200, [255, 255, 255]);
  fillRect(after, 10, 10, 40, 40, [220, 38, 38]);

  const { dataDir, pair } = await writePairFixture(before, after);
  try {
    const result = await runTieredPipeline(provider, pair, dataDir, cache);
    assert.equal(provider.calls.length, 0); // no VLM call happened at all
    assert.equal(result.cached, undefined); // NOT true — [].every() must not leak into cache accounting
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("runTieredPipeline: mixed cache hit/miss across escalated regions reports cached === false", async () => {
  const provider = scriptedProvider([okTurn("color-change"), okTurn("color-change"), okTurn("color-change")]);
  const cache = new MemoryCacheStore();

  const makePair = async (squares: Array<[number, number, number, number]>, id: string) => {
    const before = new PNG({ width: 200, height: 200 });
    fillRect(before, 0, 0, 200, 200, [255, 255, 255]);
    const after = new PNG({ width: 200, height: 200 });
    fillRect(after, 0, 0, 200, 200, [255, 255, 255]);
    for (const [x, y, w, h] of squares) fillRect(after, x, y, w, h, [37, 99, 235]);
    const dataDir = await mkdtemp(join(tmpdir(), "vlm-diff-cache-"));
    await writeFile(join(dataDir, "before.png"), PNG.sync.write(before));
    await writeFile(join(dataDir, "after.png"), PNG.sync.write(after));
    const pair: PairRecord = {
      id,
      fixture: "test.html",
      mutationId: "canvas-repaint",
      kind: "other",
      magnitude: "large",
      description: "pixel-only repaint",
      before: "before.png",
      after: "after.png",
      domBefore: JSON.stringify([domNode("host")]),
      domAfter: JSON.stringify([domNode("host")]),
    };
    return { dataDir, pair };
  };

  const a = await makePair([[70, 70, 60, 60]], "cache-warm");
  const b = await makePair([[70, 70, 60, 60], [150, 150, 20, 20]], "cache-mixed");
  try {
    const warm = await runTieredPipeline(provider, a.pair, a.dataDir, cache);
    assert.equal(warm.cached, false); // cold cache: the one escalated region missed
    const mixed = await runTieredPipeline(provider, b.pair, b.dataDir, cache);
    assert.equal(mixed.classifications!.filter((c) => c.route === "vlm").length, 2);
    assert.equal(mixed.cached, false); // one hit + one miss → not a full hit
  } finally {
    await rm(a.dataDir, { recursive: true, force: true });
    await rm(b.dataDir, { recursive: true, force: true });
  }
});
