import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InstrumentedProvider, estimateCallCostUsd } from "./instrumented.js";
import { withTimeout } from "./retry.js";
import { scriptedProvider } from "../test-utils.js";
import type { CostLogEntry } from "../cost/log.js";

test("InstrumentedProvider: logs fn label, model, tokens, cost per call", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vlm-diff-log-"));
  const logPath = join(dir, "cost.jsonl");
  try {
    const inner = scriptedProvider([{ text: '{"ok":true}' }]);
    const p = new InstrumentedProvider(inner, { logPath });
    const result = await p.send("sys", [], { fn: "classify-region" });

    assert.equal(result.text, '{"ok":true}');
    const lines = (await readFile(logPath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const entry: CostLogEntry = JSON.parse(lines[0]);
    assert.equal(entry.fn, "classify-region");
    assert.equal(entry.provider, "stub");
    assert.equal(entry.model, "stub-model");
    assert.equal(entry.inputTokens, 10);
    assert.equal(entry.outputTokens, 5);
    assert.equal(entry.ok, true);
    assert.ok(entry.latencyMs >= 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("InstrumentedProvider: budget gate fails fast once the session spend crosses the cap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vlm-diff-log-"));
  try {
    const inner = scriptedProvider([{ text: "x" }, { text: "y" }]);
    // stub-model is unknown to the pricing table — the gate bills the
    // conservative fallback since P1-3, so a tiny negative budget forces the
    // trip regardless of real spend
    const p = new InstrumentedProvider(inner, { logPath: join(dir, "l.jsonl"), budgetUsd: -0.0001 });
    await assert.rejects(() => p.send("sys", []), /Budget exceeded/);
    assert.equal(inner.calls.length, 0); // fail fast: no API call was made
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("InstrumentedProvider: failures are logged with ok=false and rethrown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vlm-diff-log-"));
  const logPath = join(dir, "cost.jsonl");
  try {
    const failing = {
      name: "stub",
      model: "stub-model",
      async send() {
        throw new Error("HTTP 503");
      },
    };
    const p = new InstrumentedProvider(failing, { logPath });
    await assert.rejects(() => p.send("sys", [], { fn: "judge" }), /HTTP 503/);
    const entry: CostLogEntry = JSON.parse((await readFile(logPath, "utf8")).trim());
    assert.equal(entry.ok, false);
    assert.equal(entry.fn, "judge");
    assert.match(entry.error!, /HTTP 503/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("withTimeout: resolves within the limit and rejects past it", async () => {
  assert.equal(await withTimeout(Promise.resolve(42), 50, "test"), 42);
  await assert.rejects(
    withTimeout(new Promise((r) => setTimeout(r, 200)), 10, "test-api"),
    /timed out after 10ms/,
  );
});

test("InstrumentedProvider: unknown model + finite budget → the gate actually trips", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vlm-diff-log-"));
  try {
    const inner = scriptedProvider(Array.from({ length: 100 }, () => ({ text: "x" })));
    const p = new InstrumentedProvider(inner, { logPath: join(dir, "l.jsonl"), budgetUsd: 0.05 });
    let threw = false;
    for (let i = 0; i < 100; i++) {
      try {
        await p.send("sys", [{ role: "user", content: [{ type: "text", text: "hi" }] }], { maxTokens: 512 });
      } catch (err) {
        assert.match(String(err), /Budget exceeded/);
        threw = true;
        break;
      }
    }
    assert.ok(threw, "gate must trip for unpriced models instead of billing $0 forever");
    assert.ok(inner.calls.length > 0 && inner.calls.length < 100, `expected some calls then a trip, got ${inner.calls.length}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("InstrumentedProvider: in-flight calls reserve budget, so concurrent sends can't overspend", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vlm-diff-log-"));
  try {
    let calls = 0;
    const slow = {
      name: "stub",
      model: "claude-sonnet-5",
      async send() {
        calls++;
        await new Promise((r) => setTimeout(r, 50));
        return { text: "x", usage: { inputTokens: 10, outputTokens: 5 } };
      },
    };
    const messages = [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }];
    const opts = { maxTokens: 512 };
    const reservation = estimateCallCostUsd("claude-sonnet-5", messages, opts);
    // budget fits one reservation, not two
    const p = new InstrumentedProvider(slow, { logPath: join(dir, "l.jsonl"), budgetUsd: reservation * 1.5 });
    const settled = await Promise.allSettled([p.send("sys", messages, opts), p.send("sys", messages, opts)]);
    const ok = settled.filter((s) => s.status === "fulfilled").length;
    const rejected = settled.filter(
      (s) => s.status === "rejected" && /Budget exceeded/.test(String((s as PromiseRejectedResult).reason)),
    ).length;
    assert.equal(ok, 1);
    assert.equal(rejected, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
