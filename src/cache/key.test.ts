import { test } from "node:test";
import assert from "node:assert/strict";
import { computeCacheKey, PROMPT_VERSION } from "./key.js";

test("computeCacheKey: identical inputs produce the same key", () => {
  const before = Buffer.from([1, 2, 3]);
  const after = Buffer.from([4, 5, 6]);
  assert.equal(computeCacheKey(before, after), computeCacheKey(before, after));
});

test("computeCacheKey: different inputs produce different keys", () => {
  const before = Buffer.from([1, 2, 3]);
  const afterA = Buffer.from([4, 5, 6]);
  const afterB = Buffer.from([7, 8, 9]);
  assert.notEqual(computeCacheKey(before, afterA), computeCacheKey(before, afterB));
});

test("computeCacheKey: before/after are not commutative", () => {
  const a = Buffer.from([1, 2, 3]);
  const b = Buffer.from([4, 5, 6]);
  assert.notEqual(computeCacheKey(a, b), computeCacheKey(b, a));
});

test("computeCacheKey: prompt context changes the key for identical pixels", () => {
  const before = Buffer.from([1, 2, 3]);
  const after = Buffer.from([4, 5, 6]);
  const noHint = computeCacheKey(before, after);
  const withHint = computeCacheKey(before, after, '{"fields":["borderRadius"]}');
  assert.notEqual(noHint, withHint);
});

test("computeCacheKey: same prompt context is stable", () => {
  const before = Buffer.from([1, 2, 3]);
  const after = Buffer.from([4, 5, 6]);
  const ctx = '{"fields":["borderRadius"]}';
  assert.equal(computeCacheKey(before, after, ctx), computeCacheKey(before, after, ctx));
});

test("computeCacheKey: model context changes the key (no cross-model cache poisoning)", () => {
  const before = Buffer.from([1, 2, 3]);
  const after = Buffer.from([4, 5, 6]);
  const kimi = computeCacheKey(before, after, undefined, "dashscope/kimi/kimi-k3");
  const qwen = computeCacheKey(before, after, undefined, "dashscope/qwen3.8-max");
  const none = computeCacheKey(before, after);
  assert.notEqual(kimi, qwen);
  assert.notEqual(kimi, none);
});

test("computeCacheKey: prompt version changes the key for identical inputs", () => {
  const before = Buffer.from([1, 2, 3]);
  const after = Buffer.from([4, 5, 6]);
  const v1 = computeCacheKey(before, after, undefined, "m", "prompt-v1");
  const v2 = computeCacheKey(before, after, undefined, "m", "prompt-v2");
  assert.notEqual(v1, v2);
  // the default is the current PROMPT_VERSION
  assert.equal(
    computeCacheKey(before, after, undefined, "m"),
    computeCacheKey(before, after, undefined, "m", PROMPT_VERSION),
  );
});
