// Review workflow (the Percy-style approve): after `vlm-diff check` finds
// changes, `vlm-diff review` walks the changed pages and lets a human approve
// (accept the new look → that page's baseline updates) or skip. Every decision
// lands in .vlm-diff/history.jsonl. Interactive on a TTY, flag-driven in CI.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { projectFile } from "./project.js";

export interface ReviewPage {
  name: string;
  url: string;
  changed: boolean;
  changeType: string | null;
  severity: string | null;
  summary: string | null;
  regions: number;
  evidence: string | null;
  a11yImpact: string | null;
  domIds?: string[];
  error?: string;
}

export interface ReviewOutcome {
  approved: string[];
  skipped: string[];
}

/** Pages that changed in the last `check` (from .vlm-diff/current/last-check.json). */
export async function loadPendingReview(root: string): Promise<ReviewPage[]> {
  const raw = await readFile(projectFile(root, "current", "last-check.json"), "utf8");
  const parsed = JSON.parse(raw) as { pages: ReviewPage[] };
  return parsed.pages.filter((p) => p.changed === true);
}

/** Promote the current capture of the named pages into the golden baseline. */
export async function approvePages(root: string, names: string[]): Promise<void> {
  const currentDir = projectFile(root, "current");
  const baselineDir = projectFile(root, "baseline");
  await mkdir(baselineDir, { recursive: true });
  for (const name of names) {
    for (const ext of ["png", "dom.json"]) {
      const from = path.join(currentDir, `${name}.${ext}`);
      const to = path.join(baselineDir, `${name}.${ext}`);
      await writeFile(to, await readFile(from));
    }
  }
}

export async function recordReview(root: string, outcome: ReviewOutcome): Promise<void> {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(
    projectFile(root, "history.jsonl"),
    JSON.stringify({ ts: new Date().toISOString(), action: "review", ...outcome }) + "\n",
    "utf8",
  );
}

/** Interactive approve/skip per page. Caller must only use this on a TTY. */
export async function reviewInteractive(pages: ReviewPage[]): Promise<ReviewOutcome> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const approved: string[] = [];
  const skipped: string[] = [];
  try {
    for (const p of pages) {
      console.log(`\n⚠ ${p.name} (${p.url})`);
      console.log(`  type: ${p.changeType ?? "?"} · severity: ${p.severity ?? "?"} · regions: ${p.regions}`);
      if (p.summary) console.log(`  ${p.summary}`);
      if (p.evidence) console.log(`  evidence: ${p.evidence}`);
      if (p.a11yImpact) console.log(`  ♿ ${p.a11yImpact}`);
      const ans = (await rl.question("  approve this change and update its baseline? [y/N] ")).trim().toLowerCase();
      if (ans === "y" || ans === "yes") approved.push(p.name);
      else skipped.push(p.name);
    }
  } finally {
    rl.close();
  }
  return { approved, skipped };
}
