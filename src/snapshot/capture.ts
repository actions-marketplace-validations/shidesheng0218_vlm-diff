// DOM snapshot capture, shared by dataset generation, the CLI `snapshot`
// command, and the MCP server. The snapshot shape (a plain JSON array of
// DomNodes) is the contract consumed by src/detect/dom-diff.ts.
//
// The capture body is a plain-JS string expression (not a function literal):
// tsx/esbuild inject a `__name` helper into function expressions that does
// not exist inside the browser page context.

import type { Page } from "playwright";

const SNAPSHOT_EXPRESSION = `(() => {
  const nodes = [];

  function pathFor(el, root) {
    const parts = [];
    let cur = el;
    while (cur && cur !== root) {
      const parent = cur.parentElement;
      const idx = parent ? Array.from(parent.children).indexOf(cur) : 0;
      parts.unshift(cur.tagName + ":" + idx);
      cur = parent;
    }
    return parts.join(">");
  }

  const ATTR_WHITELIST = ["src", "href", "alt", "title", "role", "aria-label", "aria-hidden", "disabled", "placeholder"];

  const root = document.body;
  root.querySelectorAll("*").forEach((el) => {
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    // SVG elements expose className as an SVGAnimatedString, not a string
    const cn = el.className;
    // presence-based: alt="" (decorative) differs from a missing alt
    const attrs = {};
    for (const name of ATTR_WHITELIST) {
      if (el.hasAttribute && el.hasAttribute(name)) attrs[name] = el.getAttribute(name) || "";
    }
    nodes.push({
      path: pathFor(el, root),
      tag: el.tagName,
      id: el.id,
      className: typeof cn === "string" ? cn : ((cn && cn.baseVal) || ""),
      text:
        el.tagName === "INPUT" || el.tagName === "TEXTAREA"
          ? el.value
          : el.children.length === 0
            ? (el.textContent || "").trim()
            : "",
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
      },
      style: {
        color: cs.color,
        backgroundColor: cs.backgroundColor,
        fontWeight: cs.fontWeight,
        borderRadius: cs.borderRadius,
        opacity: cs.opacity,
        boxShadow: cs.boxShadow,
        border: cs.border,
        display: cs.display,
        visibility: cs.visibility,
        overflowX: cs.overflowX,
        overflowY: cs.overflowY,
        textOverflow: cs.textOverflow,
      },
      // box metrics for the zero-baseline layout invariants (src/core/invariants.ts).
      // Rects are border-box; scroll/client are content-box — the invariant
      // checks compare each pair with itself, so the difference cancels out.
      box: {
        scrollWidth: Math.round(el.scrollWidth),
        scrollHeight: Math.round(el.scrollHeight),
        clientWidth: Math.round(el.clientWidth),
        clientHeight: Math.round(el.clientHeight),
      },
      // input type lives OUTSIDE \`attrs\` on purpose: putting it in the attribute
      // whitelist would make every input look changed against pre-0.10 baselines.
      inputType: el.tagName === "INPUT" ? (el.type || "") : undefined,
      attrs,
    });
  });
  return JSON.stringify(nodes);
})()`;

/**
 * Serialize tag/id/class/rect/computed-style for every element under <body>.
 * Rects are viewport-relative and rounded to whole pixels (the detector's
 * tolerance absorbs the jitter).
 *
 * Since v0.10 the snapshot also carries display/visibility/overflow/textOverflow
 * and content-box metrics, used by the zero-token layout invariants. Those
 * fields are additive: older snapshots parse fine and simply skip the rules
 * that need them.
 */
export async function snapshotDom(page: Page): Promise<string> {
  return page.evaluate(SNAPSHOT_EXPRESSION);
}

// ─── Console / network diagnostics ────────────────────────────────────────
// A visual change caused by a thrown exception or a 404 stylesheet is
// otherwise unexplainable from pixels alone. Attach BEFORE navigation so
// load-time failures are recorded.

export interface DiagnosticItem {
  text: string;
  /** how many times the identical message was seen (loops are common) */
  count: number;
  location?: string;
}

export interface FailedRequest {
  method: string;
  url: string;
  failure: string;
}

export interface HttpError {
  url: string;
  status: number;
}

export interface PageDiagnostics {
  consoleErrors: DiagnosticItem[];
  consoleWarnings: DiagnosticItem[];
  pageErrors: DiagnosticItem[];
  failedRequests: FailedRequest[];
  httpErrors: HttpError[];
  summary: {
    consoleErrors: number;
    consoleWarnings: number;
    pageErrors: number;
    failedRequests: number;
    httpErrors: number;
  };
}

const MAX_DIAGNOSTIC_TEXT = 500;

function truncate(s: string): string {
  return s.length > MAX_DIAGNOSTIC_TEXT ? `${s.slice(0, MAX_DIAGNOSTIC_TEXT - 1)}…` : s;
}

/** Dedupe identical messages while keeping an occurrence count.
 *  Dedupe is by text (not call site): "this same error fired 12 times" is the
 *  useful reading for a human, and repeated call sites are the common case. */
function pushUnique(list: DiagnosticItem[], text: string, location?: string): void {
  const existing = list.find((i) => i.text === text);
  if (existing) {
    existing.count++;
    return;
  }
  list.push({ text: truncate(text), count: 1, ...(location ? { location } : {}) });
}

/**
 * Start collecting console errors/warnings, uncaught exceptions and failed
 * requests. Call before `page.goto`, then `finish()` after settling.
 */
export function collectDiagnostics(page: Page): { finish: () => PageDiagnostics } {
  const consoleErrors: DiagnosticItem[] = [];
  const consoleWarnings: DiagnosticItem[] = [];
  const pageErrors: DiagnosticItem[] = [];
  const failedRequests: FailedRequest[] = [];
  const httpErrors: HttpError[] = [];

  page.on("console", (msg) => {
    const type = msg.type();
    if (type !== "error" && type !== "warning") return;
    const loc = msg.location();
    const where = loc?.url ? `${loc.url}:${loc.lineNumber ?? 0}` : undefined;
    const target = type === "error" ? consoleErrors : consoleWarnings;
    pushUnique(target, msg.text(), where);
  });

  page.on("pageerror", (err) => {
    pushUnique(pageErrors, String((err as Error)?.message ?? err));
  });

  page.on("requestfailed", (req) => {
    failedRequests.push({
      method: req.method(),
      url: req.url(),
      failure: req.failure()?.errorText ?? "unknown",
    });
  });

  page.on("response", (res) => {
    const status = res.status();
    if (status >= 400) httpErrors.push({ url: res.url(), status });
  });

  return {
    finish: () => ({
      consoleErrors,
      consoleWarnings,
      pageErrors,
      failedRequests,
      httpErrors,
      summary: {
        // errors are unique messages; the raw occurrence count is in `count`
        consoleErrors: consoleErrors.reduce((s, i) => s + i.count, 0),
        consoleWarnings: consoleWarnings.reduce((s, i) => s + i.count, 0),
        pageErrors: pageErrors.reduce((s, i) => s + i.count, 0),
        failedRequests: failedRequests.length,
        httpErrors: httpErrors.length,
      },
    }),
  };
}