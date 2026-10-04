import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDocsAssert } from "./docs-assert.js";

interface FixtureOpts {
  pairCount: number;
  mutationIds: string[];
  version: string;
  readme: { pairBenchmark?: number; screenshotPairs?: number; mutationIds?: number; unitTests?: number; actionTag?: string; citationVersion?: string };
  quickstartActionTag?: string;
  testSuites: Record<string, number>; // filename → number of test() calls
}

async function makeFixture(o: FixtureOpts): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vlm-diff-docs-"));
  await mkdir(join(root, "data"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  const dataset = Array.from({ length: o.pairCount }, (_, i) => ({ id: `p${i}`, mutationId: o.mutationIds[i % o.mutationIds.length] }));
  await writeFile(join(root, "data", "dataset.json"), JSON.stringify(dataset));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "vlm-diff", version: o.version }));
  const readme = [
    `**${o.readme.pairBenchmark ?? o.pairCount}-pair benchmark** (7 fixtures × ${o.readme.mutationIds ?? o.mutationIds.length} mutation ids).`,
    `**${o.readme.screenshotPairs ?? o.pairCount} screenshot pairs** — 7 fixtures × ${o.readme.mutationIds ?? o.mutationIds.length} mutation ids.`,
    `npm test  # ${o.readme.unitTests ?? 0} unit tests`,
    `- uses: example/vlm-diff@${o.readme.actionTag ?? `v${o.version}`}`,
    `  version={${o.readme.citationVersion ?? o.version}},`,
  ].join("\n");
  await writeFile(join(root, "README.md"), readme);
  await writeFile(join(root, "QUICKSTART.md"), `uses: example/vlm-diff@${o.quickstartActionTag ?? `v${o.version}`}`);
  for (const [name, count] of Object.entries(o.testSuites)) {
    await writeFile(join(root, "src", name), Array.from({ length: count }, (_, i) => `test("t${i}", () => {});`).join("\n"));
  }
  return root;
}

const base: FixtureOpts = {
  pairCount: 193,
  mutationIds: ["a", "b", "c"],
  version: "0.7.0",
  readme: { unitTests: 5 },
  testSuites: { "a.test.ts": 3, "b.test.ts": 2 },
};

test("docs-assert: consistent docs produce no errors", async () => {
  const root = await makeFixture(base);
  try {
    assert.deepEqual(await runDocsAssert(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("docs-assert: wrong pair count in README is caught", async () => {
  const root = await makeFixture({ ...base, readme: { ...base.readme, pairBenchmark: 150 } });
  try {
    const errors = await runDocsAssert(root);
    assert.ok(errors.some((e) => /150/.test(e) && /193/.test(e)), JSON.stringify(errors));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("docs-assert: stale action tag and citation version are caught", async () => {
  const root = await makeFixture({ ...base, readme: { ...base.readme, actionTag: "v0.6.0" }, quickstartActionTag: "v0.6.0" });
  try {
    const errors = await runDocsAssert(root);
    assert.ok(errors.filter((e) => /v0\.6\.0/.test(e)).length >= 2, JSON.stringify(errors));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("docs-assert: wrong unit-test count is caught", async () => {
  const root = await makeFixture({ ...base, readme: { ...base.readme, unitTests: 999 } });
  try {
    const errors = await runDocsAssert(root);
    assert.ok(errors.some((e) => /999/.test(e) && /unit tests/.test(e)), JSON.stringify(errors));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("docs-assert: missing dataset fails with a gate message, not a stack trace", async () => {
  const root = await mkdtemp(join(tmpdir(), "vlm-diff-docs-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "vlm-diff", version: "0.7.0" }));
    await writeFile(join(root, "README.md"), "placeholder");
    // no data/dataset.json — the fresh-clone case (data/ is gitignored)
    const errors = await runDocsAssert(root);
    assert.ok(errors.some((e) => /dataset\.json/.test(e) && /dataset:gen/.test(e)), JSON.stringify(errors));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
