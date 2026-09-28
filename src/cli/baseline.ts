// Baseline management: the Percy-style workflow for a repo.
//   vlm-diff init [url]      → write .vlm-diff/config.json
//   vlm-diff baseline        → snapshot every configured page into .vlm-diff/baseline/
//   vlm-diff check           → re-capture, diff against baseline, report + exit code
//
// All files live under .vlm-diff/ so the state is version-controllable and
// the project root is anchored (see cli/project.ts).

import { mkdir, readFile, writeFile, access, readdir, appendFile, rm } from "node:fs/promises";
import path from "node:path";
import { diffPair, type DiffVerdict } from "../core/diff.js";
import { cacheDir, projectFile } from "./project.js";
import { FileCacheStore } from "../cache/store.js";
import type { Provider } from "../provider/types.js";

/** Append-only run history: every baseline/check leaves a line you can audit later. */
async function appendHistory(root: string, entry: Record<string, unknown>): Promise<void> {
  try {
    await appendFile(projectFile(root, "history.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", "utf8");
  } catch {
    // history must never break a run
  }
}

/** PNG basenames currently stored as golden baselines (for the overwrite gate). */
export async function existingBaselinePages(root: string): Promise<string[]> {
  try {
    const files = await readdir(projectFile(root, "baseline"));
    return files.filter((f) => f.endsWith(".png")).map((f) => f.replace(/\.png$/, ""));
  } catch {
    return [];
  }
}

/** interaction steps applied before capturing (open a menu, hover a state, scroll) */
export interface PageAction {
  click?: string;
  hover?: string;
  scrollY?: number;
  waitMs?: number;
}

export interface PageTarget {
  name: string;
  url: string;
  /** actions applied after load, before capture (interactive states) */
  actions?: PageAction[];
  /** per-page viewport overrides (multi-viewport responsive checks) */
  viewports?: Array<{ width: number; height: number }>;
}

export interface VlmDiffConfig {
  viewport: { width: number; height: number };
  pages: PageTarget[];
  /** selectors for dynamic content to mask (ads, timestamps, carousels) */
  ignore?: string[];
  /** global viewport matrix — every page is captured at each size */
  viewports?: Array<{ width: number; height: number }>;
}

export interface PageCheckResult {
  name: string;
  url: string;
  verdict?: DiffVerdict;
  error?: string;
}

const DEFAULT_CONFIG: VlmDiffConfig = {
  viewport: { width: 960, height: 500 },
  pages: [{ name: "home", url: "http://localhost:3000/" }],
};

export async function runInit(root: string, seedUrl?: string): Promise<string> {
  const dir = projectFile(root);
  await mkdir(dir, { recursive: true });
  const configPath = projectFile(root, "config.json");
  const config: VlmDiffConfig = seedUrl ? { ...DEFAULT_CONFIG, pages: [{ name: "home", url: seedUrl }] } : DEFAULT_CONFIG;
  try {
    await access(configPath);
    return `${configPath} already exists — not overwritten`;
  } catch {
    await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
    return `wrote ${configPath} — edit "pages" to list the URLs to watch`;
  }
}

async function loadConfig(root: string): Promise<VlmDiffConfig> {
  const configPath = projectFile(root, "config.json");
  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as VlmDiffConfig;
  if (!Array.isArray(parsed.pages) || parsed.pages.length === 0) {
    throw new Error(`${configPath}: "pages" must be a non-empty array of { name, url }`);
  }
  return parsed;
}

interface CapturedPage {
  name: string;
  url: string;
  png: Buffer;
  dom: string;
  /** rects of config.ignore selectors resolved at capture time */
  ignoreRects?: Array<{ x: number; y: number; w: number; h: number }>;
}

/** Resolve ignore selectors to bounding rects in the page (string expression: tsx-injected helpers don't exist in-page). */
async function resolveIgnoreRects(
  page: import("playwright").Page,
  selectors: string[],
): Promise<Array<{ x: number; y: number; w: number; h: number }>> {
  return page.evaluate(`(() => {
    const out = [];
    for (const sel of ${JSON.stringify(selectors)}) {
      document.querySelectorAll(sel).forEach((el) => {
        const r = el.getBoundingClientRect();
        out.push({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
      });
    }
    return out;
  })()`);
}

async function capturePages(config: VlmDiffConfig): Promise<CapturedPage[]> {
  const { chromium } = await import("playwright");
  const { snapshotDom } = await import("../snapshot/capture.js");
  const browser = await chromium.launch();
  try {
    const out: CapturedPage[] = [];
    for (const target of config.pages) {
      // page-level viewports override the global matrix; single viewport keeps
      // the plain name so existing baselines stay compatible
      const viewports = target.viewports ?? config.viewports ?? [config.viewport];
      const multiViewport = viewports.length > 1;
      for (const vp of viewports) {
        const page = await browser.newPage({ viewport: vp });
        await page.goto(target.url, { waitUntil: "load", timeout: 30000 });
        await page.waitForTimeout(100);
        await applyActions(page, target.actions);
        const png = (await page.screenshot()) as Buffer;
        const dom = await snapshotDom(page);
        const ignoreRects = config.ignore?.length ? await resolveIgnoreRects(page, config.ignore) : undefined;
        const name = multiViewport ? `${target.name}@${vp.width}x${vp.height}` : target.name;
        out.push({ name, url: target.url, png, dom, ...(ignoreRects?.length ? { ignoreRects } : {}) });
        await page.close();
      }
    }
    return out;
  } finally {
    await browser.close();
  }
}

/** Interaction steps applied after load, before capture (menu open, hover, scroll). */
async function applyActions(page: import("playwright").Page, actions: PageAction[] | undefined): Promise<void> {
  for (const a of actions ?? []) {
    if (a.click) await page.click(a.click);
    if (a.hover) await page.hover(a.hover);
    if (a.scrollY !== undefined) await page.evaluate(`window.scrollTo(0, ${a.scrollY})`);
    if (a.waitMs) await page.waitForTimeout(a.waitMs);
  }
}

/**
 * Write golden baselines. Overwriting an existing baseline is an irreversible
 * action (the old golden state is gone), so the caller must pass `force: true`
 * after surfacing the impact — the CLI prints the affected pages and asks for
 * `--yes`. Returns `skipped: true` when the gate refused to overwrite.
 */
export async function runBaseline(
  root: string,
  opts: { force?: boolean } = {},
): Promise<{ pages: PageTarget[]; skipped: boolean }> {
  const config = await loadConfig(root);
  const dir = projectFile(root, "baseline");
  const existing = await existingBaselinePages(root);
  if (existing.length > 0 && !opts.force) {
    return { pages: [], skipped: true };
  }

  await mkdir(dir, { recursive: true });
  const captured = await capturePages(config);
  for (const c of captured) {
    await writeFile(path.join(dir, `${c.name}.png`), c.png);
    await writeFile(path.join(dir, `${c.name}.dom.json`), c.dom);
    // ignore-rect sidecar: the masks the golden state was captured with
    const ignorePath = path.join(dir, `${c.name}.ignore.json`);
    if (c.ignoreRects?.length) await writeFile(ignorePath, JSON.stringify(c.ignoreRects));
    else await rm(ignorePath, { force: true });
  }
  await appendHistory(root, {
    action: "baseline",
    overwritten: existing.length > 0,
    pages: captured.map((c) => ({ name: c.name, url: c.url })),
  });
  return { pages: config.pages, skipped: false };
}

/**
 * Re-capture every configured page and diff against the stored baseline.
 * Exit semantics mirror `diff`: caller maps to 0 clean / 1 changed / 3 needs VLM.
 * `reportDir` writes one annotated HTML report per changed page (CI artifact).
 */
export async function runCheck(
  root: string,
  opts: { provider?: Provider; noVlm?: boolean; reportDir?: string } = {},
): Promise<PageCheckResult[]> {
  const config = await loadConfig(root);
  const dir = projectFile(root, "baseline");
  const captured = await capturePages(config);

  if (opts.reportDir) await mkdir(opts.reportDir, { recursive: true });
  const results: PageCheckResult[] = [];
  for (const c of captured) {
    try {
      const basePng = await readFile(path.join(dir, `${c.name}.png`));
      const baseDom = await readFile(path.join(dir, `${c.name}.dom.json`), "utf8");
      // union of baseline-side + current-side ignore rects (either side may move)
      let ignoreRects = c.ignoreRects ?? [];
      try {
        const stored = JSON.parse(await readFile(path.join(dir, `${c.name}.ignore.json`), "utf8")) as Array<{ x: number; y: number; w: number; h: number }>;
        ignoreRects = [...ignoreRects, ...stored];
      } catch { /* no baseline-side masks */ }
      const verdict = await diffPair(basePng, c.png, baseDom, c.dom, {
        provider: opts.noVlm ? undefined : opts.provider,
        cache: new FileCacheStore(cacheDir(root)),
        ignoreRects: ignoreRects.length > 0 ? ignoreRects : undefined,
      });
      results.push({ name: c.name, url: c.url, verdict });
      if (opts.reportDir && verdict.changed) {
        const { generateVisualReport } = await import("../report/visual-report.js");
        await writeFile(
          path.join(opts.reportDir, `${c.name}.html`),
          generateVisualReport({ beforePng: basePng, afterPng: c.png, verdict }),
        );
      }
    } catch (err) {
      results.push({
        name: c.name,
        url: c.url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // persist the current captures + a compact summary so `vlm-diff review`
  // can approve pages later without re-capturing
  const currentDir = projectFile(root, "current");
  await mkdir(currentDir, { recursive: true });
  const { rm } = await import("node:fs/promises");
  const capturedNames = new Set(results.filter((r) => r.verdict?.changed).map((r) => r.name));
  for (const c of captured) {
    const pngPath = path.join(currentDir, `${c.name}.png`);
    const domPath = path.join(currentDir, `${c.name}.dom.json`);
    if (capturedNames.has(c.name)) {
      await writeFile(pngPath, c.png);
      await writeFile(domPath, c.dom);
    } else {
      await rm(pngPath, { force: true });
      await rm(domPath, { force: true });
    }
  }
  await writeFile(
    path.join(currentDir, "last-check.json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        pages: results.map((r) => ({
          name: r.name,
          url: r.url,
          changed: r.verdict?.changed ?? null,
          changeType: r.verdict?.changeType ?? null,
          severity: r.verdict?.severity ?? null,
          summary: r.verdict?.summary ?? null,
          regions: r.verdict?.regions.length ?? 0,
          domIds: r.verdict?.regions.map((x) => x.domId).filter(Boolean) ?? [],
          evidence: r.verdict?.regions
            .map((x) => x.evidence?.domChangedFields?.join(","))
            .filter(Boolean)
            .join("; ") || null,
          a11yImpact: r.verdict?.regions.map((x) => x.a11yImpact).filter(Boolean).join("; ") || null,
          ...(r.error ? { error: r.error } : {}),
        })),
      },
      null,
      2,
    ),
  );

  await appendHistory(root, {
    action: "check",
    exitCode: checkExitCode(results),
    pages: results.map((r) => ({
      name: r.name,
      changed: r.verdict?.changed ?? null,
      changeType: r.verdict?.changeType ?? null,
      severity: r.verdict?.severity ?? null,
      ...(r.error ? { error: r.error } : {}),
    })),
  });
  return results;
}

/** Aggregate exit code for `check`: 0 clean, 1 changes, 3 some page needs a VLM key. */
export function checkExitCode(results: PageCheckResult[]): number {
  let changed = false;
  let pending = false;
  for (const r of results) {
    if (r.error) return 2;
    if (r.verdict?.pendingEscalations) pending = true;
    if (r.verdict?.changed) changed = true;
  }
  if (pending) return 3;
  return changed ? 1 : 0;
}
