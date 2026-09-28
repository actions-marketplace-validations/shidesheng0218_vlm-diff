// Playwright SDK: the two-line integration for existing test suites.
//
//   import { capturePage, checkAgainstBaseline } from "vlm-diff/playwright";
//
//   const before = await capturePage(page);
//   // …apply the change…
//   const after = await capturePage(page);
//
// Or straight to a golden baseline stored by the CLI (`vlm-diff baseline`):
//
//   const verdict = await checkAgainstBaseline(page, "home");
//
// Both sit on the same pipeline as the CLI/MCP — same snapshots, same verdict.

import type { Page } from "playwright";
import { readFile } from "node:fs/promises";
import { snapshotDom } from "../snapshot/capture.js";
import { diffPair, type DiffOptions, type DiffVerdict } from "../core/diff.js";
import { projectFile } from "../cli/project.js";

export interface PageCapture {
  /** full-viewport screenshot */
  png: Buffer;
  /** DOM snapshot JSON (the format diffPair consumes) */
  dom: string;
}

/** Capture a page's screenshot + DOM snapshot in one call. */
export async function capturePage(page: Page): Promise<PageCapture> {
  const png = (await page.screenshot()) as Buffer;
  const dom = await snapshotDom(page);
  return { png, dom };
}

export interface CheckBaselineOptions extends DiffOptions {
  /** project root containing .vlm-diff/ (defaults to cwd) */
  root?: string;
}

export type BaselineVerdict = DiffVerdict & { baselineMissing?: boolean };

/**
 * Diff the page's current state against the stored golden baseline.
 * `baselineMissing: true` when no golden exists for that page — run
 * `vlm-diff baseline` (or `vlm-diff init <url> && vlm-diff baseline --yes`)
 * to seed it.
 */
export async function checkAgainstBaseline(
  page: Page,
  name: string,
  opts: CheckBaselineOptions = {},
): Promise<BaselineVerdict> {
  const root = opts.root ?? process.cwd();
  let basePng: Buffer;
  let baseDom: string;
  try {
    basePng = await readFile(projectFile(root, "baseline", `${name}.png`));
    baseDom = await readFile(projectFile(root, "baseline", `${name}.dom.json`), "utf8");
  } catch {
    return {
      changed: false,
      visualOnly: false,
      pixelChangedCount: 0,
      pixelChangedFraction: 0,
      regions: [],
      pendingEscalations: 0,
      inputTokens: 0,
      outputTokens: 0,
      baselineMissing: true,
    };
  }
  const current = await capturePage(page);
  return diffPair(basePng, current.png, baseDom, current.dom, opts);
}
