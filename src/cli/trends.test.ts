import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeTrends, formatTrends } from "./trends.js";

async function projectWithHistory(lines: string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vlm-diff-trends-"));
  await mkdir(join(root, ".vlm-diff"), { recursive: true });
  await writeFile(join(root, ".vlm-diff", "history.jsonl"), lines.join("\n") + "\n");
  return root;
}

test("computeTrends: aggregates runs, severity, and per-page change counts", async () => {
  const root = await projectWithHistory([
    JSON.stringify({ ts: "t1", action: "check", exitCode: 1, pages: [{ name: "home", changed: true, changeType: "color-change", severity: "cosmetic" }] }),
    JSON.stringify({ ts: "t2", action: "check", exitCode: 1, pages: [{ name: "home", changed: true, changeType: "text-change", severity: "moderate" }] }),
    JSON.stringify({ ts: "t3", action: "check", exitCode: 0, pages: [{ name: "home", changed: false }] }),
    JSON.stringify({ ts: "t4", action: "baseline", overwritten: true, pages: [{ name: "home" }] }),
  ]);
  try {
    const t = await computeTrends(root);
    assert.equal(t.runs.check, 3);
    assert.equal(t.runs.baseline, 1);
    assert.deepEqual(t.severityCounts, { cosmetic: 1, moderate: 1 });
    const home = t.pages.find((p) => p.name === "home")!;
    assert.equal(home.checks, 3);
    assert.equal(home.changedCount, 2);
    assert.equal(home.flips, 1); // changed, changed, unchanged → one transition
    assert.equal(t.flakyPages.length, 0); // one flip is not flaky
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("computeTrends: a page flipping changed↔unchanged repeatedly is flaky", async () => {
  const root = await projectWithHistory([
    JSON.stringify({ ts: "t1", action: "check", pages: [{ name: "p", changed: true, severity: "cosmetic" }] }),
    JSON.stringify({ ts: "t2", action: "check", pages: [{ name: "p", changed: false }] }),
    JSON.stringify({ ts: "t3", action: "check", pages: [{ name: "p", changed: true, severity: "moderate" }] }),
    JSON.stringify({ ts: "t4", action: "check", pages: [{ name: "p", changed: false }] }),
  ]);
  try {
    const t = await computeTrends(root);
    const p = t.pages[0];
    assert.equal(p.flips, 3); // changed→unchanged→changed→unchanged
    assert.equal(t.flakyPages.length, 1);
    assert.match(formatTrends(t), /flaky pages/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("computeTrends: steady page is not flaky", async () => {
  const root = await projectWithHistory([
    JSON.stringify({ ts: "t1", action: "check", pages: [{ name: "p", changed: true, severity: "cosmetic" }] }),
    JSON.stringify({ ts: "t2", action: "check", pages: [{ name: "p", changed: true, severity: "cosmetic" }] }),
  ]);
  try {
    const t = await computeTrends(root);
    assert.equal(t.flakyPages.length, 0);
    assert.match(formatTrends(t), /no flaky pages/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("suggestIgnores: flaky pages map their domIds to selectors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vlm-diff-sug-"));
  try {
    await mkdir(join(dir, ".vlm-diff", "current"), { recursive: true });
    await writeFile(join(dir, ".vlm-diff", "history.jsonl"), [
      JSON.stringify({ ts: "t1", action: "check", pages: [{ name: "p", changed: true }] }),
      JSON.stringify({ ts: "t2", action: "check", pages: [{ name: "p", changed: false }] }),
      JSON.stringify({ ts: "t3", action: "check", pages: [{ name: "p", changed: true }] }),
      JSON.stringify({ ts: "t4", action: "check", pages: [{ name: "p", changed: false }] }),
    ].join("\n") + "\n");
    await writeFile(join(dir, ".vlm-diff", "current", "last-check.json"), JSON.stringify({
      at: "t4",
      pages: [{ name: "p", changed: false, domIds: ["clock", "ad-slot"] }],
    }));
    const { suggestIgnores } = await import("./trends.js");
    const out = await suggestIgnores(dir);
    assert.deepEqual(out.flakyPages, ["p"]);
    assert.deepEqual(out.selectors.sort(), ["#ad-slot", "#clock"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("suggestIgnores: steady project returns nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vlm-diff-sug-"));
  try {
    await mkdir(join(dir, ".vlm-diff"), { recursive: true });
    await writeFile(join(dir, ".vlm-diff", "history.jsonl"), JSON.stringify({ ts: "t1", action: "check", pages: [{ name: "p", changed: false }] }) + "\n");
    const { suggestIgnores } = await import("./trends.js");
    const out = await suggestIgnores(dir);
    assert.equal(out.flakyPages.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
