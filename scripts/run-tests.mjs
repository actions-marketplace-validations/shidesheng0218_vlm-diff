#!/usr/bin/env node
// Test runner with a zero-test guard. The old `node --test dist/**/*.test.js`
// relied on shell globbing: without globstar `**` is just `*` (top-level
// dist/*.test.js silently skipped), and an empty match exits 0 — so a dist
// stripped by prepack looked green. This runner collects test files itself
// and treats an empty suite as a failure.

import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";

function collect(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...collect(p));
    else if (e.name.endsWith(".test.js")) out.push(p);
  }
  return out;
}

if (!existsSync("dist")) {
  console.error("no dist/ directory — run `npm run build` first (an empty suite is a failure, not a pass)");
  process.exit(1);
}
const files = collect("dist");
if (files.length === 0) {
  console.error("no test files found under dist/ — run `npm run build` first (an empty suite is a failure, not a pass)");
  process.exit(1);
}
const r = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
process.exit(r.status ?? 1);
