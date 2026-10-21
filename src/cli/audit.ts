// `vlm-diff audit` — zero-baseline page check.
//
// Every other command compares two frames. This one reads a single frame (a
// snapshot on disk, or a URL captured on the fly) and reports defects that
// are wrong regardless of any previous state: clipped content, collapsed
// elements, unreachable controls, undersized targets — plus console errors
// and failed requests when capturing live.
//
// Exit codes match the rest of the CLI: 0 = clean, 1 = findings, 2 = error.

import { readFile } from "node:fs/promises";
import { PNG } from "pngjs";
import { checkInvariants, summarizeFindings, type InvariantFinding } from "../core/invariants.js";
import { collectDiagnostics, snapshotDom, type PageDiagnostics } from "../snapshot/capture.js";
import type { DomNode } from "../detect/dom-diff.js";
import type { ParsedArgs } from "./args.js";

export interface AuditResult {
  ok: boolean;
  source: string;
  frame: { width: number; height: number } | null;
  findings: InvariantFinding[];
  summary: ReturnType<typeof summarizeFindings>;
  diagnostics?: PageDiagnostics;
}

function usageLine(): string {
  return `usage:
  vlm-diff audit <dom.json> [--png <shot.png>] [--diag <diag.json>] [--json]
  vlm-diff audit --url <url> [--width <px>] [--height <px>] [--wait-ms <ms>] [--json]`;
}

function formatDiagnostics(d: PageDiagnostics): string[] {
  const lines: string[] = [];
  const push = (label: string, items: string[]) => {
    if (items.length === 0) return;
    lines.push(`  ${label}: ${items.length}`);
    for (const item of items.slice(0, 8)) lines.push(`    ${item}`);
    if (items.length > 8) lines.push(`    … ${items.length - 8} more`);
  };

  push(
    "console errors",
    d.consoleErrors.map((i) => `${i.text}${i.count > 1 ? `  ×${i.count}` : ""}`),
  );
  push(
    "uncaught exceptions",
    d.pageErrors.map((i) => `${i.text}${i.count > 1 ? `  ×${i.count}` : ""}`),
  );
  push(
    "failed requests",
    d.failedRequests.map((r) => `${r.method} ${r.url} — ${r.failure}`),
  );
  push(
    "http errors",
    d.httpErrors.map((r) => `${r.url} — ${r.status}`),
  );
  push(
    "console warnings",
    d.consoleWarnings.map((i) => `${i.text}${i.count > 1 ? `  ×${i.count}` : ""}`),
  );
  return lines;
}

function printHuman(result: AuditResult): void {
  const { summary } = result;
  if (summary.total === 0) {
    console.log(`✅ AUDIT CLEAN — ${result.source} (no layout defects found)`);
  } else {
    const parts = [
      summary.breaking ? `${summary.breaking} breaking` : "",
      summary.moderate ? `${summary.moderate} moderate` : "",
      summary.cosmetic ? `${summary.cosmetic} cosmetic` : "",
    ].filter(Boolean);
    console.log(`⚠️  AUDIT — ${summary.total} findings (${parts.join(", ")}) in ${result.source}\n`);
    for (const f of result.findings) {
      console.log(`  ${f.severity.padEnd(9)} ${f.selector.padEnd(24)} ${f.message}`);
    }
  }

  if (result.diagnostics) {
    const lines = formatDiagnostics(result.diagnostics);
    if (lines.length > 0) {
      console.log("\nPage diagnostics:");
      console.log(lines.join("\n"));
    }
  }
}

async function frameFromPng(path: string): Promise<{ width: number; height: number } | null> {
  try {
    const png = PNG.sync.read(await readFile(path));
    return { width: png.width, height: png.height };
  } catch {
    return null;
  }
}

export async function runAudit(args: ParsedArgs): Promise<number> {
  const json = args.flags.get("json") === true;
  const url = args.flags.get("url");
  const [domPath] = args.positional;

  let nodes: DomNode[];
  let source: string;
  let frame: { width: number; height: number } | null = null;
  let diagnostics: PageDiagnostics | undefined;

  if (typeof url === "string") {
    const width = Number(args.flags.get("width") ?? 1280);
    const height = Number(args.flags.get("height") ?? 800);
    const waitMs = Number(args.flags.get("wait-ms") ?? 100);
    const target = url.startsWith("http://") || url.startsWith("https://") || url.startsWith("file://")
      ? url
      : `file://${url.startsWith("/") ? url : `${process.cwd()}/${url}`}`;

    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width, height } });
      const collector = collectDiagnostics(page);
      await page.goto(target, { waitUntil: "load" });
      await page.waitForTimeout(waitMs);
      const dom = await snapshotDom(page);
      nodes = JSON.parse(dom) as DomNode[];
      diagnostics = collector.finish();
      frame = { width, height };
      source = target;
    } finally {
      await browser.close();
    }
  } else {
    if (!domPath) {
      console.error(`error: audit needs a <dom.json> or --url <url>\n\n${usageLine()}`);
      return 2;
    }
    try {
      nodes = JSON.parse(await readFile(domPath, "utf8")) as DomNode[];
    } catch (err) {
      console.error(`error: cannot read DOM snapshot ${domPath}: ${err instanceof Error ? err.message : err}`);
      return 2;
    }
    source = domPath;

    const pngPath = args.flags.get("png");
    if (typeof pngPath === "string") {
      frame = await frameFromPng(pngPath);
      if (!frame && !json) console.error(`note: could not read frame size from ${pngPath}; offscreen checks skipped`);
    }

    const diagPath = args.flags.get("diag");
    if (typeof diagPath === "string") {
      try {
        diagnostics = JSON.parse(await readFile(diagPath, "utf8")) as PageDiagnostics;
      } catch (err) {
        if (!json) console.error(`note: could not read diagnostics ${diagPath}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  const findings = checkInvariants(nodes, {
    frameWidth: frame?.width,
    frameHeight: frame?.height,
  });
  const summary = summarizeFindings(findings);
  const result: AuditResult = {
    ok: summary.total === 0,
    source,
    frame,
    findings,
    summary,
    ...(diagnostics ? { diagnostics } : {}),
  };

  if (json) {
    console.log(JSON.stringify(result));
  } else {
    printHuman(result);
  }

  // Diagnostics that indicate a broken page (uncaught exceptions, failed
  // requests) count as findings for the exit code even when the layout is
  // structurally clean — a page that threw is not a healthy page.
  const diagnosticsBroken =
    (diagnostics?.summary.pageErrors ?? 0) > 0 || (diagnostics?.summary.failedRequests ?? 0) > 0;
  return summary.total > 0 || diagnosticsBroken ? 1 : 0;
}