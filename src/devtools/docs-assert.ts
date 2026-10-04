// Documentation-number gate. README/QUICKSTART numbers have drifted from the
// code on every release so far (test counts, action tags, dataset size), so
// the numbers are now asserted against their sources: data/dataset.json,
// package.json, and the src test suite. Any mismatch prints the diff and
// exits 1. Wired into CI's test job as `npm run docs:assert`.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

interface DatasetPair {
  mutationId?: string;
}

async function readText(root: string, rel: string): Promise<string> {
  return readFile(join(root, rel), "utf8");
}

async function testFileCount(root: string): Promise<number> {
  const entries = await readdir(join(root, "src"), { recursive: true, withFileTypes: true });
  let count = 0;
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".test.ts")) continue;
    const text = await readFile(join(e.parentPath, e.name), "utf8");
    // count test( call sites (line-initial), matching the runner's tally
    count += (text.match(/^\s*test\(/gm) ?? []).length;
  }
  return count;
}

function expectMatch(errors: string[], label: string, text: string, re: RegExp, expected: string): void {
  const matches = [...text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))];
  if (matches.length === 0) {
    errors.push(`${label}: no match for ${re} (expected "${expected}")`);
    return;
  }
  for (const m of matches) {
    if (m[1] !== expected) {
      errors.push(`${label}: found "${m[1]}", expected "${expected}"`);
    }
  }
}

/** Returns the list of inconsistencies; empty means docs match the code. */
export async function runDocsAssert(root: string): Promise<string[]> {
  const errors: string[] = [];
  const readme = await readText(root, "README.md");
  const quickstart = await readText(root, "QUICKSTART.md").catch(() => "");
  const pkg = JSON.parse(await readText(root, "package.json")) as { version: string };
  const dataset = JSON.parse(await readText(root, "data/dataset.json")) as DatasetPair[];

  // dataset size
  const n = String(dataset.length);
  expectMatch(errors, "README pair benchmark", readme, /(\d+)-pair benchmark/, n);
  expectMatch(errors, "README screenshot pairs", readme, /\*\*(\d+) screenshot pairs\*\*/, n);

  // distinct mutation ids
  const mutationIds = String(new Set(dataset.map((p) => p.mutationId)).size);
  expectMatch(errors, "README mutation ids", readme, /(\d+) mutation ids/, mutationIds);

  // version: action tags everywhere + the citation block
  const tag = `v${pkg.version}`;
  expectMatch(errors, "README action tag", readme, /vlm-diff@(v[\d.]+)/, tag);
  expectMatch(errors, "README citation version", readme, /version=\{([\d.]+)\}/, pkg.version);
  if (quickstart) expectMatch(errors, "QUICKSTART action tag", quickstart, /vlm-diff@(v[\d.]+)/, tag);

  // unit test count
  const tests = String(await testFileCount(root));
  expectMatch(errors, "README unit tests", readme, /(\d+) unit tests/, tests);

  return errors;
}

async function main(): Promise<void> {
  const errors = await runDocsAssert(process.cwd());
  if (errors.length > 0) {
    console.error("docs:assert failed — documentation numbers do not match the code:");
    for (const e of errors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }
  console.log("docs:assert OK — README/QUICKSTART numbers match data/dataset.json, package.json and the test suite.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
