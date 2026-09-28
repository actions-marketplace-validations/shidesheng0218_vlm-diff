// Trends: aggregate .vlm-diff/history.jsonl (written by check/baseline/review)
// into a picture of how the project's UI changes over time — run counts,
// severity distribution, and per-page flakiness (pages that keep flipping
// between changed and unchanged are the ones to distrust).

import { readFile } from "node:fs/promises";
import { projectFile } from "./project.js";

interface HistoryEntry {
  ts: string;
  action: "check" | "baseline" | "review";
  pages?: Array<{ name: string; changed: boolean | null; changeType?: string | null; severity?: string | null }>;
  approved?: string[];
  skipped?: string[];
  exitCode?: number;
  overwritten?: boolean;
}

export interface PageTrend {
  name: string;
  checks: number;
  changedCount: number;
  flips: number; // changed↔unchanged transitions across consecutive checks
  lastSeverity: string | null;
}

export interface TrendSummary {
  runs: { check: number; baseline: number; review: number };
  firstAt: string | null;
  lastAt: string | null;
  severityCounts: Record<string, number>;
  pages: PageTrend[];
  flakyPages: PageTrend[];
}

/**
 * Suggest ignore selectors for flaky pages: pages that flip between
 * changed/unchanged across checks get their changed regions' DOM ids mapped
 * to `#id` selectors (printed for a human to confirm, never auto-written).
 */
export async function suggestIgnores(root: string): Promise<{ flakyPages: string[]; selectors: string[] }> {
  const trends = await computeTrends(root);
  if (trends.flakyPages.length === 0) return { flakyPages: [], selectors: [] };
  const flakyNames = new Set(trends.flakyPages.map((p) => p.name));

  const raw = await readFile(projectFile(root, "current", "last-check.json"), "utf8").catch(() => null);
  if (!raw) return { flakyPages: [...flakyNames], selectors: [] };
  const parsed = JSON.parse(raw) as { pages: Array<{ name: string; domIds?: string[] }> };
  const selectors: string[] = [];
  for (const p of parsed.pages) {
    if (!flakyNames.has(p.name)) continue;
    for (const id of p.domIds ?? []) if (id) selectors.push(`#${id}`);
  }
  return { flakyPages: [...flakyNames], selectors: [...new Set(selectors)] };
}

export async function computeTrends(root: string): Promise<TrendSummary> {
  const raw = await readFile(projectFile(root, "history.jsonl"), "utf8");
  const entries: HistoryEntry[] = raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

  const runs = { check: 0, baseline: 0, review: 0 };
  const severityCounts: Record<string, number> = {};
  const perPage = new Map<string, PageTrend & { lastChanged: boolean | null }>();

  for (const e of entries) {
    if (e.action === "check" || e.action === "baseline" || e.action === "review") runs[e.action]++;
    if (e.action !== "check" || !e.pages) continue;
    for (const p of e.pages) {
      if (p.changed == null) continue;
      let t = perPage.get(p.name);
      if (!t) {
        t = { name: p.name, checks: 0, changedCount: 0, flips: 0, lastSeverity: null, lastChanged: null };
        perPage.set(p.name, t);
      }
      t.checks++;
      if (p.changed) {
        t.changedCount++;
        if (p.severity) severityCounts[p.severity] = (severityCounts[p.severity] ?? 0) + 1;
        t.lastSeverity = p.severity ?? t.lastSeverity;
      }
      if (t.lastChanged !== null && t.lastChanged !== p.changed) t.flips++;
      t.lastChanged = p.changed;
    }
  }

  const pages = [...perPage.values()].map(({ lastChanged: _lastChanged, ...t }) => t);
  return {
    runs,
    firstAt: entries[0]?.ts ?? null,
    lastAt: entries[entries.length - 1]?.ts ?? null,
    severityCounts,
    pages,
    // flaky = changed state flipped at least twice across checks
    flakyPages: pages.filter((p) => p.flips >= 2).sort((a, b) => b.flips - a.flips),
  };
}

export function formatTrends(t: TrendSummary): string {
  const lines: string[] = [];
  lines.push(`history: ${t.runs.check} check(s), ${t.runs.baseline} baseline(s), ${t.runs.review} review(s)`);
  if (t.firstAt && t.lastAt) lines.push(`window: ${t.firstAt} → ${t.lastAt}`);
  const sev = Object.entries(t.severityCounts).map(([k, v]) => `${k}=${v}`).join(", ");
  if (sev) lines.push(`severity distribution (changed pages): ${sev}`);
  if (t.pages.length > 0) {
    lines.push("");
    lines.push("page                        checks  changed  flips  last severity");
    lines.push("─".repeat(64));
    for (const p of t.pages) {
      lines.push(`${p.name.padEnd(26)} ${String(p.checks).padStart(6)}  ${String(p.changedCount).padStart(7)}  ${String(p.flips).padStart(5)}  ${p.lastSeverity ?? "—"}`);
    }
  }
  if (t.flakyPages.length > 0) {
    lines.push("");
    lines.push(`⚠ flaky pages (flip ≥2×, distrust these baselines): ${t.flakyPages.map((p) => `${p.name} (${p.flips} flips)`).join(", ")}`);
  } else if (t.pages.length > 0) {
    lines.push("\nno flaky pages (no page flipped between changed/unchanged ≥2×)");
  }
  return lines.join("\n");
}
