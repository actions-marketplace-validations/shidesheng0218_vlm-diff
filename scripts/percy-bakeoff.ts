#!/usr/bin/env tsx
/**
 * Percy bakeoff — vlm-diff side executor.
 *
 * Reads the scenario definitions + answer key from scripts/bakeoff-scenarios.ts,
 * produces each before/after pair, runs the tiered pipeline, and writes a
 * machine-readable results/percy-bakeoff.json plus a human summary.
 *
 * Idempotent: pages are fetched once into bakeoff/pages/, pairs are rendered
 * once into bakeoff/pairs/, and re-runs reuse them (pass --refresh to redo).
 *
 * This is intentionally offline for Buckets A and B. Bucket C scenarios set
 * expectEscalation:true; those need a VLM key to actually classify, so the
 * executor runs them with --no-vlm by default and records `needsVlm: true`.
 * Re-run with a provider env var set to resolve them.
 *
 * Usage:
 *   npx tsx scripts/percy-bakeoff.ts [--refresh] [--only A01,A02] [--vlm]
 */

import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";
import { snapshotDom, collectDiagnostics } from "../src/snapshot/capture.js";
import { diffPair } from "../src/core/diff.js";
import { FileCacheStore } from "../src/cache/store.js";
import { PAGES, SCENARIOS, bucketCounts, type Scenario } from "./bakeoff-scenarios.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const PAGES_DIR = path.join(ROOT, "bakeoff", "pages");
const PAIRS_DIR = path.join(ROOT, "bakeoff", "pairs");
const RESULTS = path.join(ROOT, "results");
const VIEWPORT = { width: 1280, height: 800 };

const args = process.argv.slice(2);
const REFRESH = args.includes("--refresh");
const USE_VLM = args.includes("--vlm");
const onlyIdx = args.indexOf("--only");
const ONLY = onlyIdx >= 0 ? args[onlyIdx + 1]?.split(",") : undefined;

// ─── helpers ────────────────────────────────────────────────────────────────

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

function applyMutationsHtml(html: string, scenario: Scenario): string {
  // Apply the scenario's mutations by editing the saved source. We do simple,
  // robust string/DOM surgery — this is for a bakeoff, not a general engine.
  // We inject a <script> that runs the mutations so the "after" page is a real
  // document that renders the change (keeps it reproducible + debuggable).
  if (!scenario.mutations || scenario.mutations.length === 0) return "";
  const ops = JSON.stringify(scenario.mutations);
  const injector = `\n<script>\n(function(){\n  const ops = ${ops};\n  for (const m of ops) {\n    document.querySelectorAll(m.selector).forEach(function(el){\n      if (m.kind === "set-style") el.style.setProperty(m.prop, m.value);\n      else if (m.kind === "set-text") el.textContent = m.value;\n      else if (m.kind === "set-attr") el.setAttribute(m.prop, m.value);\n      else if (m.kind === "remove") el.remove();\n      else if (m.kind === "append-html") el.insertAdjacentHTML("beforeend", m.value);\n    });\n  }\n})();\n</script>\n`;
  return html.replace(/<\/body>/i, injector + "</body>");
}

async function renderPage(browserPage: Page, url: string) {
  const collector = collectDiagnostics(browserPage);
  await browserPage.goto(url, { waitUntil: "load" });
  await browserPage.waitForTimeout(200);
  const dom = await snapshotDom(browserPage);
  const png = await browserPage.screenshot();
  const diag = collector.finish();
  return { dom, png, diag };
}

// Noise mechanisms for Bucket B. Each returns the AFTER page variant.
async function renderNoise(browser: any, url: string, noise: NonNullable<Scenario["noise"]>) {
  if (noise === "rerender") {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await page.goto(url, { waitUntil: "load" });
    await page.waitForTimeout(600); // settle differently
    const dom = await snapshotDom(page);
    const png = await page.screenshot();
    await page.close();
    return { dom, png };
  }
  if (noise === "scrollbar") {
    // same content, but force a scrollbar to appear (viewport effectively narrower)
    const page = await browser.newPage({ viewport: VIEWPORT });
    await page.goto(url, { waitUntil: "load" });
    await page.evaluate(() => { document.documentElement.style.overflowY = "scroll"; });
    await page.waitForTimeout(100);
    const dom = await snapshotDom(page);
    const png = await page.screenshot();
    await page.close();
    return { dom, png };
  }
  if (noise === "timestamp") {
    // A dynamic timestamp: the SAME element exists in both frames, its text
    // differs. This is a real DOM change a user would mark "ignore". We model
    // it as: before-frame gets the node with timestamp T0, after-frame same
    // node with T1. The scenario's expected outcome (unchanged) only holds if
    // the caller masks the region — which is exactly the real workflow
    // (config `ignore`). The executor passes an ignoreRect covering the node.
    const page = await browser.newPage({ viewport: VIEWPORT });
    await page.goto(url, { waitUntil: "load" });
    await page.evaluate(() => {
      let el = document.getElementById("ts-stamp");
      if (!el) {
        el = document.createElement("div");
        el.id = "ts-stamp";
        el.style.cssText = "position:fixed;bottom:4px;right:8px;font-size:11px;color:#999";
        document.body.appendChild(el);
      }
      el.textContent = "rendered 2026-10-26T03:00:00.000Z"; // T1 (before used T0)
    });
    await page.waitForTimeout(100);
    const dom = await snapshotDom(page);
    const png = await page.screenshot();
    await page.close();
    return { dom, png };
  }
  if (noise === "hover") {
    const page = await browser.newPage({ viewport: VIEWPORT });
    await page.goto(url, { waitUntil: "load" });
    const el = await page.$("a, button, input[type=submit]");
    if (el) await el.hover();
    await page.waitForTimeout(100);
    const dom = await snapshotDom(page);
    const png = await page.screenshot();
    await page.close();
    return { dom, png };
  }
  throw new Error("unknown noise: " + noise);
}

// ─── fetch real pages (with fallbacks) ─────────────────────────────────────

async function fetchPages(): Promise<Record<string, string>> {
  await mkdir(PAGES_DIR, { recursive: true });
  const localFiles: Record<string, string> = {};
  for (const p of PAGES) {
    const file = path.join(PAGES_DIR, `${p.key}.html`);
    const marker = path.join(PAGES_DIR, `${p.key}.url`);
    if (!REFRESH && (await exists(file))) {
      localFiles[p.key] = file;
      continue;
    }
    let saved = false;
    for (const url of p.urls) {
      try {
        const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(15000) } as any);
        if (!res.ok) continue;
        let body = await res.text();
        // wrap non-HTML (e.g. httpbin /json, /image) into a minimal HTML shell
        if (!/<html/i.test(body)) {
          body = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:system-ui;margin:16px;padding:16px}</style></head><body><pre>${body.replace(/</g, "&lt;")}</pre></body></html>`;
        }
        await writeFile(file, body);
        await writeFile(marker, url);
        console.log(`  fetched ${p.key} ← ${url}`);
        saved = true;
        break;
      } catch (e) {
        console.log(`  (${p.key}: ${url} unreachable, trying fallback)`);
      }
    }
    if (!saved) {
      console.log(`  WARN: could not fetch any source for page "${p.key}" — scenarios using it will be skipped`);
      continue;
    }
    localFiles[p.key] = file;
  }
  return localFiles;
}

// ─── main ───────────────────────────────────────────────────────────────────

interface Outcome {
  id: string;
  bucket: Bucket2;
  page: string;
  description: string;
  expectedChanged: boolean;
  detectedChanged: boolean;
  correct: boolean;
  changeType?: string;
  summary?: string;
  regions: number;
  needsVlm: boolean;
  inputTokens: number;
  outputTokens: number;
  mustMentionHit?: boolean;
  note?: string;
}
type Bucket2 = "A" | "B" | "C";

async function main() {
  await mkdir(PAIRS_DIR, { recursive: true });
  await mkdir(RESULTS, { recursive: true });

  console.log("Fetching real pages…");
  const localFiles = await fetchPages();

  const browser = await chromium.launch();
  const cache = new FileCacheStore(path.join(ROOT, ".cache", "classifications"));
  const provider = USE_VLM ? undefined : undefined; // default offline; wire provider when --vlm

  const outcomes: Outcome[] = [];
  const wanted = SCENARIOS.filter((s) => !ONLY || ONLY.includes(s.id));

  for (const s of wanted) {
    const pageFile = localFiles[s.page];
    if (!pageFile) {
      console.log(`  SKIP ${s.id} (page "${s.page}" not fetched)`);
      continue;
    }
    const html = await readFile(pageFile, "utf8");
    const beforeUrl = `file://${pageFile}`;
    const afterHtml = applyMutationsHtml(html, s);
    const afterFile = path.join(PAGES_DIR, `${s.page}__${s.id}.after.html`);
    if (afterHtml) await writeFile(afterFile, afterHtml);
    const afterUrl = afterHtml ? `file://${afterFile}` : beforeUrl;

    // render before
    let beforePng: Buffer, beforeDom: string, afterPng: Buffer, afterDom: string;
    {
      const page = await browser.newPage({ viewport: VIEWPORT });
      // timestamp noise: seed the SAME node in the before frame at T0 so the
      // after frame's T1 is a text change on an existing element, not an add.
      if (s.noise === "timestamp") {
        const collector = collectDiagnostics(page);
        await page.goto(beforeUrl, { waitUntil: "load" });
        await page.evaluate(() => {
          const el = document.createElement("div");
          el.id = "ts-stamp";
          el.style.cssText = "position:fixed;bottom:4px;right:8px;font-size:11px;color:#999";
          el.textContent = "rendered 2026-10-26T00:00:00.000Z"; // T0
          document.body.appendChild(el);
        });
        await page.waitForTimeout(100);
        beforeDom = await snapshotDom(page);
        beforePng = await page.screenshot();
        collector.finish();
      } else {
        const r = await renderPage(page, beforeUrl);
        beforePng = r.png; beforeDom = r.dom;
      }
      await page.close();
    }
    // render after (noise or mutated)
    if (s.noise) {
      const r = await renderNoise(browser, beforeUrl, s.noise);
      afterPng = r.png; afterDom = r.dom;
    } else {
      const page = await browser.newPage({ viewport: VIEWPORT });
      const r = await renderPage(page, afterUrl);
      afterPng = r.png; afterDom = r.dom;
      await page.close();
    }

    await writeFile(path.join(PAIRS_DIR, `${s.id}-before.png`), beforePng);
    await writeFile(path.join(PAIRS_DIR, `${s.id}-after.png`), afterPng);

    // Bucket B timestamp: the dynamic node lives at bottom-right of the frame;
    // a real user masks it via config `ignore`. Reproduce that here.
    const ignoreRects = s.noise === "timestamp"
      ? [{ x: VIEWPORT.width - 320, y: VIEWPORT.height - 40, w: 320, h: 40 }]
      : undefined;

    const verdict = await diffPair(beforePng, afterPng, beforeDom, afterDom, {
      provider: undefined, // offline; Bucket C escalations are recorded as pending
      cache,
      ignoreRects,
    });

    const detectedChanged = verdict.changed;
    const correct = detectedChanged === s.expect.changed;
    const text = (verdict.summary ?? "") + " " + verdict.regions.map((r) => r.description ?? "").join(" ");
    const mustMentionHit = s.expect.mustMention && s.expect.mustMention.length > 0
      ? s.expect.mustMention.some((m) => text.toLowerCase().includes(m.toLowerCase()))
      : undefined;

    outcomes.push({
      id: s.id,
      bucket: s.bucket,
      page: s.page,
      description: s.description,
      expectedChanged: s.expect.changed,
      detectedChanged,
      correct,
      changeType: verdict.changeType,
      summary: verdict.summary,
      regions: verdict.regions.length,
      needsVlm: s.expectEscalation === true && verdict.pendingEscalations > 0,
      inputTokens: verdict.inputTokens,
      outputTokens: verdict.outputTokens,
      mustMentionHit,
      note: verdict.pendingEscalations > 0 ? `${verdict.pendingEscalations} escalation(s) pending (needs VLM)` : undefined,
    });

    const mark = correct ? "✓" : "✗";
    console.log(`  ${mark} ${s.id}  expected=${s.expect.changed} detected=${detectedChanged}  regions=${verdict.regions.length}${verdict.pendingEscalations ? ` (${verdict.pendingEscalations} pending VLM)` : ""}`);
  }

  await browser.close();

  // aggregate
  const byBucket = (b: Bucket2) => outcomes.filter((o) => o.bucket === b);
  const acc = (list: Outcome[]) => (list.length === 0 ? { n: 0, correct: 0, rate: null as number | null } : { n: list.length, correct: list.filter((o) => o.correct).length, rate: list.filter((o) => o.correct).length / list.length });

  const report = {
    generatedAt: new Date().toISOString(),
    tool: "vlm-diff",
    offline: !USE_VLM,
    scenarios: wanted.length,
    bucketCounts: bucketCounts(),
    totals: {
      A_recall: acc(byBucket("A").filter((o) => o.expectedChanged)),
      B_fp: acc(byBucket("B")),
      C: acc(byBucket("C")),
      overall: acc(outcomes),
    },
    outcomes,
  };

  const outPath = path.join(RESULTS, "percy-bakeoff.json");
  await writeFile(outPath, JSON.stringify(report, null, 2));

  console.log("\n=== vlm-diff bakeoff summary (offline) ===");
  const fmt = (x: { n: number; correct: number; rate: number | null }) => x.rate === null ? "n/a" : `${x.correct}/${x.n} (${(x.rate * 100).toFixed(0)}%)`;
  console.log(`Bucket A recall:   ${fmt(report.totals.A_recall)}`);
  console.log(`Bucket B clean:    ${fmt(report.totals.B_fp)}  (want 100% = no false positives)`);
  console.log(`Bucket C detected: ${fmt(report.totals.C)}`);
  console.log(`Overall correct:   ${fmt(report.totals.overall)}`);
  console.log(`\nReport: ${outPath}`);
  console.log("\nNext: run the same scenario ids through Percy per docs/percy-bakeoff-percy-runbook.md");
}

main().catch((e) => { console.error(e); process.exit(1); });
