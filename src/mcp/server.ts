#!/usr/bin/env node
// VLM-Diff MCP server — gives coding agents a visual-regression sense.
//
// Tools:
//   diff_screenshots  diff two screenshots (optionally with DOM snapshots)
//                     through the tiered pipeline and return descriptions
//   snapshot_url      capture a DOM snapshot + screenshot of a URL for later diffing
//
// Wire it up (Claude Code):
//   claude mcp add vlm-diff -- node /path/to/dist/mcp/server.js
// or any MCP-compatible client over stdio.

import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { diffPair, type DiffVerdict } from "../core/diff.js";
import { createProvider, PRESETS } from "../provider/factory.js";
import { FileCacheStore } from "../cache/store.js";
import { loadDotEnv } from "../cli/env.js";
import { annotatePng } from "../report/overlay-png.js";

function formatVerdict(verdict: DiffVerdict): string {
  const lines: string[] = [];
  lines.push(verdict.changed ? "CHANGE DETECTED" : "No meaningful change");
  lines.push(
    `mode: ${verdict.visualOnly ? "visual-only (pixel-driven)" : "DOM + pixel (tiered)"} · ` +
      `pixel delta: ${(verdict.pixelChangedFraction * 100).toFixed(2)}% (${verdict.pixelChangedCount}px)`,
  );
  if (verdict.summary) lines.push(`summary: ${verdict.summary}`);
  if (verdict.changeType) lines.push(`change type: ${verdict.changeType}`);
  if (verdict.severity) lines.push(`severity: ${verdict.severity}`);
  verdict.regions.forEach((r, i) => {
    const pending = r.route === "vlm" && !r.changeType ? " [pending VLM]" : "";
    const sev = r.severity ? ` · ${r.severity}` : "";
    lines.push(`${i + 1}. (${r.x},${r.y} ${r.w}×${r.h}) [${r.source} → ${r.route}] ${r.changeType ?? "?"}${sev}${pending}`);
    if (r.description) lines.push(`   ${r.description}`);
    const fields = r.evidence?.domChangedFields;
    if (fields && fields.length > 0) {
      lines.push(`   evidence: DOM ${fields.join(", ")}`);
    } else if (r.evidence?.escalationReason) {
      lines.push(`   evidence: ${r.evidence.escalationReason}`);
    }
    if (r.a11yImpact) lines.push(`   a11y impact: ${r.a11yImpact}`);
  });
  if (verdict.pendingEscalations > 0) {
    lines.push(`note: ${verdict.pendingEscalations} region(s) need a VLM — set an API key for the server to resolve them`);
  }
  lines.push("", "machine-readable:", JSON.stringify(verdict));
  return lines.join("\n");
}

function tryProvider(providerName?: string, modelName?: string) {
  try {
    // the MCP server's VLM calls are the same high-volume per-region
    // classification as the CLI's — route them through the cheap tier too
    return createProvider({ provider: providerName, model: modelName, tier: "cheap" });
  } catch {
    return undefined; // no key configured — escalated regions stay pending
  }
}

const verdictOutputShape = {
  changed: z.boolean(),
  visualOnly: z.boolean(),
  pixelChangedCount: z.number(),
  pixelChangedFraction: z.number(),
  changeType: z.string().optional(),
  summary: z.string().optional(),
  severity: z.string().optional(),
  pendingEscalations: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
};

async function main() {
  loadDotEnv();
  // version comes from package.json at runtime — a hardcoded string drifted
  // behind the real release before (0.5.0 vs 0.5.1)
  const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };
  const server = new McpServer({ name: "vlm-diff", version: pkg.version });

  server.registerTool(
    "diff_screenshots",
    {
      title: "Diff two UI screenshots",
      description:
        "Diff two UI screenshots with deterministic-first visual regression analysis. " +
        "Regions explained by DOM snapshots are described at zero VLM cost; pixel-only " +
        "deltas (canvas repaints, image swaps) escalate to a VLM when an API key is configured. " +
        "Returns a text summary, the structured verdict (change type, severity, per-region " +
        "descriptions with DOM evidence), and the after frame annotated with numbered " +
        "severity-colored region boxes.",
      inputSchema: {
        before: z.string().describe("absolute path to the before PNG"),
        after: z.string().describe("absolute path to the after PNG"),
        dom_before: z.string().optional().describe("absolute path to the before DOM snapshot JSON (from snapshot_url)"),
        dom_after: z.string().optional().describe("absolute path to the after DOM snapshot JSON (from snapshot_url)"),
        provider: z.enum(Object.keys(PRESETS) as [string, ...string[]]).optional().describe("VLM provider override"),
        model: z.string().optional().describe("model id override"),
        include_images: z.boolean().optional().describe("return annotated frames as image blocks (default true)"),
      },
      outputSchema: verdictOutputShape,
    },
    async ({ before, after, dom_before, dom_after, provider, model, include_images }) => {
      const [beforePng, afterPng] = await Promise.all([readFile(before), readFile(after)]);
      const [domBeforeJson, domAfterJson] = await Promise.all([
        dom_before ? readFile(dom_before, "utf8") : Promise.resolve(undefined),
        dom_after ? readFile(dom_after, "utf8") : Promise.resolve(undefined),
      ]);
      const verdict = await diffPair(beforePng, afterPng, domBeforeJson, domAfterJson, {
        provider: tryProvider(provider, model),
        cache: new FileCacheStore(".cache/classifications"),
      });

      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
        { type: "text", text: formatVerdict(verdict) },
      ];
      if (include_images !== false) {
        // annotated after frame: the agent can SEE where the regions are
        const annotated = annotatePng(
          afterPng,
          verdict.regions.map((r, i) => ({ x: r.x, y: r.y, w: r.w, h: r.h, index: i + 1, severity: r.severity })),
        );
        content.push(
          { type: "image", data: annotated.toString("base64"), mimeType: "image/png" },
          { type: "image", data: beforePng.toString("base64"), mimeType: "image/png" },
        );
      }
      return { content, structuredContent: { ...verdict } };
    },
  );

  server.registerTool(
    "snapshot_url",
    {
      title: "Capture a DOM snapshot + screenshot of a URL",
      description:
        "Capture a DOM snapshot (JSON) and a screenshot (PNG) of a URL with headless Chromium. " +
        "Capture before and after a change, then pass both to diff_screenshots. " +
        "Returns the file paths to use for diffing plus the screenshot itself.",
      inputSchema: {
        url: z.string().describe("http(s):// URL or a local file path to render"),
        width: z.number().optional().describe("viewport width (default 960)"),
        height: z.number().optional().describe("viewport height (default 500)"),
        wait_ms: z.number().optional().describe("settle time before capture in ms (default 100)"),
      },
    },
    async ({ url, width, height, wait_ms }) => {
      const { chromium } = await import("playwright");
      const { snapshotDom } = await import("../snapshot/capture.js");
      const { writeFile } = await import("node:fs/promises");

      const target =
        url.startsWith("http://") || url.startsWith("https://") || url.startsWith("file://")
          ? url
          : `file://${url.startsWith("/") ? url : `${process.cwd()}/${url}`}`;

      const id = randomUUID().slice(0, 8);
      const domPath = join(tmpdir(), `vlm-diff-snapshot-${id}.dom.json`);
      const pngPath = join(tmpdir(), `vlm-diff-snapshot-${id}.png`);

      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: width ?? 960, height: height ?? 500 } });
        await page.goto(target, { waitUntil: "load", timeout: 30000 });
        await page.waitForTimeout(wait_ms ?? 100);
        const dom = await snapshotDom(page);
        const png = await page.screenshot();
        await writeFile(domPath, dom);
        await writeFile(pngPath, png);
        const elementCount = JSON.parse(dom).length;
        return {
          content: [
            {
              type: "text",
              text: `snapshot captured (${elementCount} DOM elements)\ndom_snapshot: ${domPath}\nscreenshot: ${pngPath}\n\nPass these paths to diff_screenshots (dom_before/dom_after + before/after).`,
            },
            { type: "image", data: (png as Buffer).toString("base64"), mimeType: "image/png" },
          ],
        };
      } finally {
        await browser.close();
      }
    },
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[vlm-diff] MCP server running on stdio");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
