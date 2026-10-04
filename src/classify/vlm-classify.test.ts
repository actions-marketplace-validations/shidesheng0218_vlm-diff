import { test } from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import { classifyRegion, classifyRegionCached, cropRegion, parseClassification } from "./vlm-classify.js";
import { scriptedProvider } from "../test-utils.js";
import { MemoryCacheStore } from "../cache/store.js";

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

test("cropRegion: crops with padding, clamped to image bounds", () => {
  const src = solidPng(100, 100, [255, 255, 255]);
  const region = { x: 40, y: 40, w: 10, h: 10, source: "dom" as const };
  const crop = cropRegion(src, region);
  const decoded = PNG.sync.read(crop);
  // padding is 16px each side, so expect 10 + 2*16 = 42
  assert.equal(decoded.width, 42);
  assert.equal(decoded.height, 42);
});

test("cropRegion: clamps padding at image edges", () => {
  const src = solidPng(100, 100, [255, 255, 255]);
  const region = { x: 2, y: 2, w: 5, h: 5, source: "dom" as const };
  const crop = cropRegion(src, region);
  const decoded = PNG.sync.read(crop);
  // x clamps to 0, so width = 5 + 16 (only right padding fits fully, left clamped)
  assert.ok(decoded.width <= 5 + 2 * 16);
  assert.ok(decoded.width >= 5);
});

test("cropRegion: off-frame regions clamp instead of crashing", () => {
  // regression: a scaled element can extend beyond the viewport; cropping it
  // used to throw "bitblt reading outside image"
  const src = solidPng(100, 100, [255, 255, 255]);
  const outOfBounds = { x: 90, y: 95, w: 80, h: 60, source: "dom" as const };
  const crop = cropRegion(src, outOfBounds);
  const decoded = PNG.sync.read(crop);
  assert.ok(decoded.width >= 1 && decoded.height >= 1);
  assert.ok(decoded.width <= 100 && decoded.height <= 100);
});

test("parseClassification: parses well-formed JSON", () => {
  const result = parseClassification('{"changeType":"color-change","description":"button turned red","confidence":0.9}');
  assert.equal(result.changeType, "color-change");
  assert.equal(result.description, "button turned red");
  assert.equal(result.confidence, 0.9);
});

test("parseClassification: strips markdown code fences", () => {
  const result = parseClassification('```json\n{"changeType":"text-change","description":"label changed","confidence":0.7}\n```');
  assert.equal(result.changeType, "text-change");
});

test("parseClassification: falls back to 'other' on malformed output", () => {
  const result = parseClassification("not json at all");
  assert.equal(result.changeType, "other");
  assert.equal(result.confidence, 0);
});

test("parseClassification: accepts the none verdict for visual-only regions", () => {
  const result = parseClassification('{"changeType":"none","description":"no meaningful change","confidence":0.8}');
  assert.equal(result.changeType, "none");
});

test("parseClassification: unknown changeType values are coerced to 'other'", () => {
  const result = parseClassification('{"changeType":"cosmic-ray-flip","description":"x","confidence":0.5}');
  assert.equal(result.changeType, "other");
});

test("parseClassification: extracts JSON embedded in prose", () => {
  const result = parseClassification('Sure! Here is the result: {"changeType":"text-change","description":"label","confidence":0.6} Hope that helps.');
  assert.equal(result.changeType, "text-change");
});

test("classifyRegion: sends before/after image blocks and parses response", async () => {
  const provider = scriptedProvider([
    { text: '{"changeType":"spatial-shift","description":"element moved right","confidence":0.85}' },
  ]);
  const before = solidPng(20, 20, [255, 255, 255]);
  const after = solidPng(20, 20, [255, 255, 255]);
  const result = await classifyRegion(provider, before, after);
  assert.equal(result.changeType, "spatial-shift");
  assert.equal(provider.calls.length, 1);
  const content = provider.calls[0][0].content;
  assert.equal(content.filter((b) => b.type === "image").length, 2);
});

test("classifyRegion: DOM hint is appended to the system prompt", async () => {
  const provider = scriptedProvider([
    { text: '{"changeType":"style-change","description":"border radius removed","confidence":0.9}' },
  ]);
  const before = solidPng(20, 20, [255, 255, 255]);
  const after = solidPng(20, 20, [255, 255, 255]);
  await classifyRegion(provider, before, after, { fields: ["borderRadius"], id: "card-1" });
  assert.match(provider.systems[0], /borderRadius/);
  assert.match(provider.systems[0], /#card-1/);
  assert.match(provider.systems[0], /ground truth/);
});

test("classifyRegion: no hint keeps the base system prompt", async () => {
  const provider = scriptedProvider([
    { text: '{"changeType":"other","description":"x","confidence":0.5}' },
  ]);
  const before = solidPng(20, 20, [255, 255, 255]);
  const after = solidPng(20, 20, [255, 255, 255]);
  await classifyRegion(provider, before, after);
  assert.doesNotMatch(provider.systems[0], /ground truth/);
});

test("buildSystemPrompt: removed element gets an explicit lifecycle hint", async () => {
  const provider = scriptedProvider([
    { text: '{"changeType":"element-remove","description":"link removed","confidence":0.9}' },
  ]);
  const before = solidPng(20, 20, [255, 255, 255]);
  const after = solidPng(20, 20, [255, 255, 255]);
  await classifyRegion(provider, before, after, {
    fields: ["removed"],
    id: "link-3",
    counterpartRect: { x: 517, y: 22, w: 32, h: 16 },
  });
  assert.match(provider.systems[0], /REMOVED/);
  assert.match(provider.systems[0], /element-remove/);
  assert.match(provider.systems[0], /#link-3/);
  assert.match(provider.systems[0], /previously occupied/);
  // must NOT use the generic "changed these computed properties" phrasing
  assert.doesNotMatch(provider.systems[0], /computed properties: removed/);
});

test("buildSystemPrompt: added element gets an explicit lifecycle hint", async () => {
  const provider = scriptedProvider([
    { text: '{"changeType":"element-add","description":"row added","confidence":0.9}' },
  ]);
  const before = solidPng(20, 20, [255, 255, 255]);
  const after = solidPng(20, 20, [255, 255, 255]);
  await classifyRegion(provider, before, after, { fields: ["added"], id: "row-4" });
  assert.match(provider.systems[0], /ADDED/);
  assert.match(provider.systems[0], /element-add/);
});

test("buildSystemPrompt: position-only rect delta spells out the translation", async () => {
  const provider = scriptedProvider([
    { text: '{"changeType":"spatial-shift","description":"moved right","confidence":0.9}' },
  ]);
  const before = solidPng(20, 20, [255, 255, 255]);
  const after = solidPng(20, 20, [255, 255, 255]);
  await classifyRegion(provider, before, after, {
    fields: ["position"],
    id: "card-2",
    rectDelta: { dx: 32, dy: 0, dw: 0, dh: 0 },
  });
  assert.match(provider.systems[0], /moved by \(32px, 0px\)/);
  assert.match(provider.systems[0], /spatial-shift/);
  assert.doesNotMatch(provider.systems[0], /resized/);
});

test("buildSystemPrompt: size-only rect delta spells out the resize", async () => {
  const provider = scriptedProvider([
    { text: '{"changeType":"size-change","description":"grew","confidence":0.9}' },
  ]);
  const before = solidPng(20, 20, [255, 255, 255]);
  const after = solidPng(20, 20, [255, 255, 255]);
  await classifyRegion(provider, before, after, {
    fields: ["size"],
    id: "logo",
    rectDelta: { dx: 0, dy: 0, dw: -4, dh: 2 },
  });
  assert.match(provider.systems[0], /resized by \(-4px × 2px\)/);
  assert.match(provider.systems[0], /size-change/);
  assert.doesNotMatch(provider.systems[0], /moved by/);
});

test("classifyRegionCached: second call with identical crops is a cache hit and skips the provider", async () => {
  const provider = scriptedProvider([
    { text: '{"changeType":"color-change","description":"button turned red","confidence":0.9}' },
  ]);
  const cache = new MemoryCacheStore();
  const before = solidPng(20, 20, [255, 255, 255]);
  const after = solidPng(20, 20, [200, 0, 0]);

  const first = await classifyRegionCached(provider, cache, before, after);
  assert.equal(first.cached, false);
  assert.equal(provider.calls.length, 1);

  const second = await classifyRegionCached(provider, cache, before, after);
  assert.equal(second.cached, true);
  assert.equal(second.changeType, "color-change");
  assert.equal(second.usage.inputTokens, 0);
  assert.equal(provider.calls.length, 1); // no additional call made
});

test("classifyRegionCached: different crops are separate cache entries", async () => {
  const provider = scriptedProvider([
    { text: '{"changeType":"color-change","description":"a","confidence":0.9}' },
    { text: '{"changeType":"text-change","description":"b","confidence":0.8}' },
  ]);
  const cache = new MemoryCacheStore();
  const before = solidPng(20, 20, [255, 255, 255]);
  const afterA = solidPng(20, 20, [200, 0, 0]);
  const afterB = solidPng(20, 20, [0, 200, 0]);

  const a = await classifyRegionCached(provider, cache, before, afterA);
  const b = await classifyRegionCached(provider, cache, before, afterB);
  assert.equal(a.cached, false);
  assert.equal(b.cached, false);
  assert.equal(provider.calls.length, 2);
});

test("classifyRegionCached: concurrent same-key calls share a single provider call", async () => {
  let calls = 0;
  const provider = {
    name: "stub",
    model: "stub-model",
    async send() {
      calls++;
      await new Promise((r) => setTimeout(r, 30));
      return { text: '{"changeType":"color-change","description":"d","confidence":0.9}', usage: { inputTokens: 10, outputTokens: 5 } };
    },
  };
  const cache = new MemoryCacheStore();
  const before = solidPng(20, 20, [255, 255, 255]);
  const after = solidPng(20, 20, [200, 0, 0]);

  const [a, b] = await Promise.all([
    classifyRegionCached(provider, cache, before, after),
    classifyRegionCached(provider, cache, before, after),
  ]);

  assert.equal(calls, 1); // the duplicate waited on the in-flight call
  assert.equal(a.cached, false);
  assert.equal(a.changeType, "color-change");
  assert.equal(b.cached, true);
  assert.equal(b.changeType, "color-change");
  assert.equal(b.usage.inputTokens, 0); // the duplicate paid nothing
});
