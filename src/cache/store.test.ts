import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileCacheStore, MemoryCacheStore } from "./store.js";
import { computeCacheKey } from "./key.js";
import type { Classification } from "../classify/vlm-classify.js";

function sampleClassification(): Classification {
  return {
    changeType: "color-change",
    description: "button turned red",
    confidence: 0.9,
    usage: { inputTokens: 100, outputTokens: 20 },
  };
}

test("MemoryCacheStore: set then get returns the entry", async () => {
  const store = new MemoryCacheStore();
  await store.set("key1", { classification: sampleClassification(), cachedAt: new Date().toISOString() });
  const hit = await store.get("key1");
  assert.ok(hit);
  assert.equal(hit!.classification.changeType, "color-change");
});

test("MemoryCacheStore: miss returns null", async () => {
  const store = new MemoryCacheStore();
  assert.equal(await store.get("missing"), null);
});

test("FileCacheStore: persists to disk and reads back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vlm-diff-cache-"));
  try {
    const store = new FileCacheStore(dir);
    await store.set("key1", { classification: sampleClassification(), cachedAt: new Date().toISOString() });
    const hit = await store.get("key1");
    assert.ok(hit);
    assert.equal(hit!.classification.description, "button turned red");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FileCacheStore: expired entries are treated as a miss", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vlm-diff-cache-"));
  try {
    const store = new FileCacheStore(dir, 1000); // 1s TTL
    const staleTimestamp = new Date(Date.now() - 5000).toISOString();
    await store.set("key1", { classification: sampleClassification(), cachedAt: staleTimestamp });
    assert.equal(await store.get("key1"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FileCacheStore: missing file returns null, not a throw", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vlm-diff-cache-"));
  try {
    const store = new FileCacheStore(dir);
    assert.equal(await store.get("never-written"), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("FileCacheStore: entry written under an old prompt version is a miss under the current one", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vlm-diff-cache-"));
  try {
    const store = new FileCacheStore(dir);
    const before = Buffer.from([1, 2, 3]);
    const after = Buffer.from([4, 5, 6]);
    const oldKey = computeCacheKey(before, after, undefined, "m", "old-prompt");
    await store.set(oldKey, {
      classification: sampleClassification(),
      cachedAt: new Date().toISOString(),
      promptVersion: "old-prompt",
    });
    // lookup with the current (default) PROMPT_VERSION misses
    assert.equal(await store.get(computeCacheKey(before, after, undefined, "m")), null);
    // the audit field round-trips
    const hit = await store.get(oldKey);
    assert.equal(hit!.promptVersion, "old-prompt");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
