#!/usr/bin/env node
// vlm-diff CLI — diff any two screenshots with the tiered pipeline.
//
//   vlm-diff diff before.png after.png [--dom-before b.json --dom-after a.json] [options]
//   vlm-diff snapshot <url> --out-dom a.json [--out-png shot.png]
//
// Exit codes for `diff`: 0 = no change, 1 = change detected, 2 = error.

import { readFile } from "node:fs/promises";
import { loadDotEnv } from "./env.js";
import { parseArgs, type ParsedArgs } from "./args.js";
import { diffPair, type DiffVerdict } from "../core/diff.js";
import { PRESETS } from "../provider/factory.js";
import { createCliProvider } from "./provider.js";
import { FileCacheStore } from "../cache/store.js";
import { cacheDir, findProjectRoot } from "./project.js";
import { runInit, runBaseline, runCheck, checkExitCode, existingBaselinePages } from "./baseline.js";
import { loadPendingReview, approvePages, recordReview, reviewInteractive, type ReviewOutcome } from "./review.js";
import { computeTrends, formatTrends, suggestIgnores } from "./trends.js";

function usage(): string {
  return `vlm-diff — deterministic-first UI screenshot diffing

Usage:
  vlm-diff diff <before.png> <after.png> [options]
  vlm-diff snapshot <url-or-file> --out-dom <file.json> [--out-png <file.png>] [options]
  vlm-diff init [url]       create .vlm-diff/config.json (optionally seeded with a page)
  vlm-diff baseline         snapshot every configured page into .vlm-diff/baseline/
                            (overwriting an existing baseline requires --yes)
  vlm-diff check            re-capture pages and diff against the baseline
  vlm-diff review           approve changed pages from the last check
                            (interactive on a TTY; --approve a,b or --approve-all in CI)
  vlm-diff trends           aggregate .vlm-diff/history.jsonl into a trend summary
                            (--suggest-ignores: mask candidates for flaky pages)

diff options:
  --dom-before <file>     JSON DOM snapshot of the before frame (from \`vlm-diff snapshot\`)
  --dom-after <file>      JSON DOM snapshot of the after frame
  --provider <name>       ${Object.keys(PRESETS).join(" | ")} (default: auto-detect from API keys)
  --model <id>            model id override (default: provider preset)
  --threshold <fraction>  pixel-only escalation threshold, fraction of frame (default 0.002)
  --max-regions <n>       cap on regions to describe/classify (default 8)
  --ignore-rect <rects>   mask dynamic content: "x,y,w,h;x,y,w,h" — changes fully
                          inside these rects never count (ads, timestamps)
  --no-cache              skip the classification cache (.cache/classifications)
  --no-vlm                detection only: never call a VLM API
  --json                  machine-readable single-line JSON output
  --report <file.html>    write a self-contained HTML report with annotated regions

snapshot options:
  --out-dom <file>        write the DOM snapshot JSON here (required)
  --out-png <file>        also save a full-page screenshot
  --width <px>            viewport width (default 960)
  --height <px>           viewport height (default 500)
  --wait-ms <ms>          settle time before capture (default 100)

Without DOM snapshots, diff degrades to pixel-only mode: significant pixel
deltas are escalated to the VLM. API keys are read from the environment or
a local .env file (ANTHROPIC_API_KEY, OPENAI_API_KEY, MOONSHOT_API_KEY,
DASHSCOPE_API_KEY, OPENCODE_API_KEY).

Exit codes (diff): 0 = no change, 1 = change detected, 2 = error,
  3 = change detected but needs a VLM API key to finish classifying.`;
}

async function runDiff(args: ParsedArgs): Promise<number> {
  const [beforePath, afterPath] = args.positional;
  if (!beforePath || !afterPath) {
    console.error("error: diff needs <before.png> <after.png>\n\n" + usage());
    return 2;
  }

  const json = args.flags.get("json") === true;
  const noVlm = args.flags.get("no-vlm") === true;
  const reportPath = args.flags.get("report");
  const beforePng = await readFile(beforePath);
  const afterPng = await readFile(afterPath);

  const domBefore = args.flags.get("dom-before");
  const domAfter = args.flags.get("dom-after");
  const domBeforeJson = typeof domBefore === "string" ? await readFile(domBefore, "utf8") : undefined;
  const domAfterJson = typeof domAfter === "string" ? await readFile(domAfter, "utf8") : undefined;

  const threshold = args.flags.get("threshold");
  const maxRegions = args.flags.get("max-regions");
  const ignoreRects = parseIgnoreRects(args.flags.get("ignore-rect"));

  const verdict = await diffPair(beforePng, afterPng, domBeforeJson, domAfterJson, {
    pixelOnlyThreshold: typeof threshold === "string" ? Number(threshold) : undefined,
    maxRegions: typeof maxRegions === "string" ? Number(maxRegions) : undefined,
    ignoreRects,
    cache: args.flags.get("no-cache") === true ? undefined : new FileCacheStore(cacheDir()),
    provider: noVlm ? undefined : tryCreateProvider(args, json),
  });

  if (typeof reportPath === "string") {
    const { generateVisualReport } = await import("../report/visual-report.js");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(reportPath, generateVisualReport({ beforePng, afterPng, verdict }));
    if (!json) console.log(`\n📄 report written to ${reportPath}`);
  }

  if (json) {
    console.log(JSON.stringify({ before: beforePath, after: afterPath, ...verdict }));
  } else {
    printHuman(verdict, Boolean(domBeforeJson && domAfterJson));
  }

  if (verdict.pendingEscalations > 0) {
    if (!json) {
      console.error(
        `\nnote: ${verdict.pendingEscalations} region(s) need VLM classification — set an API key (or pass --provider) to resolve them.`,
      );
    }
    // distinct exit code: a diff that *worked* but needs a key is not an error
    return 3;
  }
  return verdict.changed ? 1 : 0;
}

function tryCreateProvider(args: ParsedArgs, json: boolean) {
  try {
    const provider = args.flags.get("provider");
    const model = args.flags.get("model");
    return createCliProvider({
      provider: typeof provider === "string" ? provider : undefined,
      model: typeof model === "string" ? model : undefined,
    });
  } catch (err) {
    if (!json) console.error(`note: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** Parse --ignore-rect "x,y,w,h;x,y,w,h" into rects. */
function parseIgnoreRects(raw: string | boolean | undefined): Array<{ x: number; y: number; w: number; h: number }> | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const rects = raw.split(";").map((part) => {
    const [x, y, w, h] = part.split(",").map(Number);
    if ([x, y, w, h].some((n) => !Number.isFinite(n))) throw new Error(`--ignore-rect needs "x,y,w,h" segments, got "${part}"`);
    return { x, y, w, h };
  });
  return rects.length > 0 ? rects : undefined;
}

/** One-line provenance summary: which DOM properties drove the description. */
function evidenceLine(ev?: DiffVerdict["regions"][number]["evidence"]): string | undefined {
  if (!ev) return undefined;
  const fields = ev.domChangedFields ?? [];
  if (fields.length === 0) return ev.escalationReason;
  const transitions = fields
    .filter((f) => ev.domValues?.[f])
    .slice(0, 2)
    .map((f) => {
      const v = ev.domValues![f];
      const b = v.before.length > 24 ? v.before.slice(0, 21) + "…" : v.before;
      const a = v.after.length > 24 ? v.after.slice(0, 21) + "…" : v.after;
      return `${f}: ${b} → ${a}`;
    });
  const rest = fields.length > 2 ? `, +${fields.length - 2} more` : "";
  return `DOM ${fields.join(", ")}${transitions.length ? ` (${transitions.join("; ")}${rest})` : ""}`;
}

function printHuman(v: DiffVerdict, hadDom: boolean) {
  console.log(v.changed ? "⚠️  CHANGE DETECTED" : "✅ No meaningful change");
  console.log(
    `   mode: ${hadDom ? "DOM + pixel (tiered)" : "pixel-only"}${v.visualOnly ? ", visual-only delta" : ""} · ` +
      `pixel delta: ${(v.pixelChangedFraction * 100).toFixed(2)}% (${v.pixelChangedCount}px)`,
  );
  if (v.summary) console.log(`   summary: ${v.summary}`);
  if (v.changeType) console.log(`   type: ${v.changeType}`);
  if (v.severity) console.log(`   severity: ${v.severity}${v.severity === "breaking" ? " ⛔" : ""}`);
  v.regions.forEach((r, i) => {
    const tokens = r.inputTokens + r.outputTokens > 0 ? ` · ${r.inputTokens}+${r.outputTokens} tok` : "";
    const pending = r.route === "vlm" && !r.changeType ? " · pending VLM" : "";
    const sev = r.severity && r.severity !== "cosmetic" ? ` · ${r.severity}` : "";
    console.log(
      `   ${i + 1}. [${r.source} → ${r.route}] (${r.x},${r.y} ${r.w}×${r.h}) ` +
        `${r.changeType ?? "?"}${sev}${tokens}${pending}`,
    );
    if (r.description) console.log(`      ${r.description}`);
    const evidence = evidenceLine(r.evidence);
    if (evidence) console.log(`      evidence: ${evidence}`);
    if (r.a11yImpact) console.log(`      ♿ a11y impact: ${r.a11yImpact}`);
  });
  if (v.inputTokens + v.outputTokens > 0) {
    console.log(`   tokens: ${v.inputTokens} in / ${v.outputTokens} out`);
  }
}

async function runSnapshot(args: ParsedArgs): Promise<number> {
  const [target] = args.positional;
  const outDom = args.flags.get("out-dom");
  if (!target || typeof outDom !== "string") {
    console.error("error: snapshot needs <url> and --out-dom <file>\n\n" + usage());
    return 2;
  }

  const width = Number(args.flags.get("width") ?? 960);
  const height = Number(args.flags.get("height") ?? 500);
  const waitMs = Number(args.flags.get("wait-ms") ?? 100);
  const outPng = args.flags.get("out-png");

  const { chromium } = await import("playwright");
  const { snapshotDom } = await import("../snapshot/capture.js");
  const { writeFile } = await import("node:fs/promises");

  const url = target.startsWith("http://") || target.startsWith("https://") || target.startsWith("file://")
    ? target
    : `file://${target.startsWith("/") ? target : `${process.cwd()}/${target}`}`;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(url, { waitUntil: "load" });
    await page.waitForTimeout(waitMs);
    const dom = await snapshotDom(page);
    await writeFile(outDom, dom);
    console.log(`DOM snapshot: ${outDom} (${JSON.parse(dom).length} elements)`);
    if (typeof outPng === "string") {
      await page.screenshot({ path: outPng });
      console.log(`Screenshot:   ${outPng}`);
    }
    return 0;
  } finally {
    await browser.close();
  }
}

async function runInitCmd(args: ParsedArgs): Promise<number> {
  const seedUrl = args.positional[0];
  const msg = await runInit(process.cwd(), seedUrl);
  console.log(msg);
  console.log("next: vlm-diff baseline   (snapshot the configured pages)");
  return 0;
}

async function runBaselineCmd(args: ParsedArgs): Promise<number> {
  const root = findProjectRoot();
  const force = args.flags.get("yes") === true;
  const existing = await existingBaselinePages(root);
  if (existing.length > 0 && !force) {
    // overwriting golden baselines is irreversible — show the blast radius first
    console.log(`⚠ a baseline already exists for ${existing.length} page(s): ${existing.join(", ")}`);
    console.log("  overwriting replaces the golden state irreversibly.");
    console.log("  pass --yes to confirm: vlm-diff baseline --yes");
    return 2;
  }
  const { pages } = await runBaseline(root, { force: true });
  console.log(`baseline written: ${pages.length} page(s) → ${root}/.vlm-diff/baseline/${existing.length > 0 ? " (overwritten)" : ""}`);
  for (const p of pages) console.log(`  ${p.name}: ${p.url}`);
  return 0;
}

async function runCheckCmd(args: ParsedArgs): Promise<number> {
  const root = findProjectRoot();
  const noVlm = args.flags.get("no-vlm") === true;
  const json = args.flags.get("json") === true;
  const reportFlag = args.flags.get("report");
  const reportDir = typeof reportFlag === "string" ? reportFlag : undefined;
  const results = await runCheck(root, {
    provider: noVlm ? undefined : tryCreateProvider(args, json),
    noVlm,
    reportDir,
  });
  const code = checkExitCode(results);

  if (json) {
    // CI/Action contract: one JSON line, summary per page + exit code
    console.log(JSON.stringify({
      exitCode: code,
      pages: results.map((r) => ({
        name: r.name,
        url: r.url,
        ...(r.error
          ? { error: r.error }
          : {
              changed: r.verdict!.changed,
              changeType: r.verdict!.changeType ?? null,
              severity: r.verdict!.severity ?? null,
              regions: r.verdict!.regions.length,
              pendingEscalations: r.verdict!.pendingEscalations,
            }),
      })),
    }));
    return code;
  }

  let anyBreaking = false;
  for (const r of results) {
    if (r.error) {
      console.log(`  ✗ ${r.name}: ERROR ${r.error}`);
      continue;
    }
    const v = r.verdict!;
    const sev = v.severity ? ` · ${v.severity}` : "";
    if (v.changed) {
      anyBreaking = anyBreaking || v.severity === "breaking";
      console.log(`  ⚠ ${r.name}: ${v.changeType ?? "changed"}${sev} — ${v.summary ?? `${v.regions.length} region(s)`}`);
    } else {
      console.log(`  ✓ ${r.name}: no change`);
    }
  }
  if (reportDir) console.log(`📄 annotated reports written to ${reportDir}`);
  if (code === 1 && anyBreaking) console.log("\n⛔ breaking changes detected");
  if (code === 1) {
    console.log("\nnext steps: if these changes are intentional, update the golden state with `vlm-diff baseline --yes` (history is kept in .vlm-diff/history.jsonl)");
  }
  if (code === 3) console.log("\nnote: some pages need a VLM API key to finish classifying (exit 3)");
  return code;
}

async function runReviewCmd(args: ParsedArgs): Promise<number> {
  const root = findProjectRoot();
  let pending;
  try {
    pending = await loadPendingReview(root);
  } catch {
    console.error("nothing to review — run `vlm-diff check` first (it records .vlm-diff/current/last-check.json)");
    return 2;
  }
  if (pending.length === 0) {
    console.log("nothing to review — the last check was clean");
    return 0;
  }

  const approveAll = args.flags.get("approve-all") === true;
  const approveFlag = args.flags.get("approve");
  const approveList = typeof approveFlag === "string" ? approveFlag.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

  let outcome: ReviewOutcome;
  if (approveAll) {
    outcome = { approved: pending.map((p) => p.name), skipped: [] };
  } else if (approveList) {
    const approveSet = new Set(approveList);
    for (const n of approveList) {
      if (!pending.some((p) => p.name === n)) console.log(`  note: "${n}" has no pending change`);
    }
    outcome = {
      approved: pending.filter((p) => approveSet.has(p.name)).map((p) => p.name),
      skipped: pending.filter((p) => !approveSet.has(p.name)).map((p) => p.name),
    };
  } else if (process.stdout.isTTY) {
    outcome = await reviewInteractive(pending);
  } else {
    console.error("non-interactive environment: use --approve <pages> or --approve-all");
    return 2;
  }

  if (outcome.approved.length > 0) {
    await approvePages(root, outcome.approved);
    await recordReview(root, outcome);
  }
  console.log(`\napproved: ${outcome.approved.length} page(s)${outcome.approved.length > 0 ? " (baselines updated)" : ""}; skipped: ${outcome.skipped.length}`);
  return 0;
}

async function runTrendsCmd(args: ParsedArgs): Promise<number> {
  const root = findProjectRoot();
  try {
    if (args.flags.get("suggest-ignores") === true) {
      const { flakyPages, selectors } = await suggestIgnores(root);
      if (flakyPages.length === 0) {
        console.log("no flaky pages — nothing to mask");
        return 0;
      }
      console.log(`flaky pages (flip ≥2×): ${flakyPages.join(", ")}`);
      if (selectors.length > 0) {
        console.log('suggested ignore selectors — review and add to .vlm-diff/config.json "ignore":');
        for (const s of selectors) console.log(`  "${s}"`);
      } else {
        console.log("no id-carrying regions in the last check — inspect those pages' dynamic widgets");
      }
      return 0;
    }
    const trends = await computeTrends(root);
    console.log(formatTrends(trends));
    return 0;
  } catch {
    console.error("no history yet — run `vlm-diff check` or `vlm-diff baseline` first (history lives in .vlm-diff/history.jsonl)");
    return 2;
  }
}

async function main(): Promise<number> {
  loadDotEnv(findProjectRoot()); // load .env from the anchored project root, not cwd
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (!command || command === "help" || command === "--help" || command === "-h" || args.flags.get("help") === true) {
    console.log(usage());
    return command ? 0 : 2;
  }
  if (command === "diff") return runDiff(args);
  if (command === "snapshot") return runSnapshot(args);
  if (command === "init") return runInitCmd(args);
  if (command === "baseline") return runBaselineCmd(args);
  if (command === "check") return runCheckCmd(args);
  if (command === "review") return runReviewCmd(args);
  if (command === "trends") return runTrendsCmd(args);
  console.error(`unknown command: ${command}\n\n` + usage());
  return 2;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 2;
  });
