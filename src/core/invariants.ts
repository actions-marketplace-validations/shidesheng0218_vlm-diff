// Zero-baseline layout invariants. Every other check in this tool compares
// two frames; these rules judge a SINGLE frame, so they need no baseline, no
// previous run, and no API key — the lowest-friction entry point in the
// product ("is my page broken right now?").
//
// Each rule is deliberately narrow and high-precision: this is an audit a
// human reads, so a false positive costs more than a missed edge case. Rules
// whose prerequisite fields are missing (pre-v0.10 snapshots) are skipped
// rather than guessed at.

import type { DomNode } from "../detect/dom-diff.js";

export type InvariantId =
  | "collapsed"
  | "text-truncated"
  | "content-overflow"
  | "offscreen-interactive"
  | "small-target";

export type InvariantSeverity = "breaking" | "moderate" | "cosmetic";

export interface InvariantFinding {
  id: InvariantId;
  severity: InvariantSeverity;
  /** best-effort human selector: #id, else tag.class, else tag */
  selector: string;
  path: string;
  message: string;
  detail?: Record<string, number | string>;
}

export interface InvariantOptions {
  /** viewport width in px; enables the offscreen rule */
  frameWidth?: number;
  /** viewport height in px; enables the offscreen rule */
  frameHeight?: number;
}

/** WCAG 2.2 AA 2.5.8 target-size minimum, in px. */
const MIN_TARGET_PX = 24;
/** rounding tolerance: sub-pixel layout can report scrollWidth one px over */
const TOLERANCE_PX = 1;

const CONTROL_TAGS = new Set(["BUTTON", "SELECT", "TEXTAREA"]);
const CONTROL_ROLES = new Set(["button", "tab", "menuitem", "switch", "combobox"]);
/** input types that are self-evidently a target the user must hit */
const TARGET_INPUT_TYPES = new Set(["", "text", "search", "email", "password", "tel", "url", "number", "submit", "button", "reset"]);

function inputType(node: DomNode): string {
  return node.tag === "INPUT" ? (node.inputType ?? "").toLowerCase() : "";
}

function isControl(node: DomNode): boolean {
  if (node.tag === "INPUT") return TARGET_INPUT_TYPES.has(inputType(node));
  if (CONTROL_TAGS.has(node.tag)) return true;
  const role = (node.attrs?.role ?? "").toLowerCase();
  return CONTROL_ROLES.has(role);
}

function isVisible(node: DomNode): boolean {
  const s = node.style;
  if (s.display === "none") return false;
  if (s.visibility === "hidden" || s.visibility === "collapse") return false;
  if (s.opacity === "0") return false;
  return true;
}

function hasContent(node: DomNode): boolean {
  return node.text.trim().length > 0 || isControl(node);
}

/** `#id` if present, else tag.class (first class only), else tag — lowercase. */
export function selectorFor(node: DomNode): string {
  const tag = node.tag.toLowerCase();
  if (node.id) return `#${node.id}`;
  const cls = node.className.trim().split(/\s+/)[0];
  return cls ? `${tag}.${cls}` : tag;
}

function clippedBy(hidden: string | undefined): boolean {
  return hidden === "hidden" || hidden === "clip";
}

/**
 * Check one DOM snapshot for layout defects that don't require a baseline.
 * Returns findings ordered by severity (breaking first), then document path.
 */
export function checkInvariants(nodes: DomNode[], options: InvariantOptions = {}): InvariantFinding[] {
  const findings: InvariantFinding[] = [];

  for (const node of nodes) {
    if (!isVisible(node)) continue;
    const { w, h } = node.rect;
    const box = node.box;

    // ── collapsed: visible, has content, but one axis is zero ──
    if (hasContent(node) && ((h === 0 && w > 0) || (w === 0 && h > 0))) {
      findings.push({
        id: "collapsed",
        severity: "moderate",
        selector: selectorFor(node),
        path: node.path,
        message: `element collapsed to ${w}×${h}px — its content renders in zero space`,
        detail: { w, h, text: node.text.slice(0, 40) },
      });
      continue; // no other rect-based rule is meaningful for a collapsed node
    }

    let textTruncated = false;

    // ── text-truncated: ellipsis is configured AND the text actually overflows ──
    if (box && node.style.textOverflow === "ellipsis" && clippedBy(node.style.overflowX)) {
      const over = box.scrollWidth - box.clientWidth;
      if (over > TOLERANCE_PX) {
        textTruncated = true;
        findings.push({
          id: "text-truncated",
          severity: "moderate",
          selector: selectorFor(node),
          path: node.path,
          message: `text clipped by ${over}px (ellipsis)`,
          detail: { overflowPx: over, clientWidth: box.clientWidth, text: node.text.slice(0, 40) },
        });
      }
    }

    // ── content-overflow: content is lost, not merely scrollable ──
    // overflow:auto/scroll is fine (the user can scroll); hidden/clip is not.
    if (box && !textTruncated) {
      if (clippedBy(node.style.overflowY)) {
        const over = box.scrollHeight - box.clientHeight;
        if (over > TOLERANCE_PX) {
          findings.push({
            id: "content-overflow",
            severity: "moderate",
            selector: selectorFor(node),
            path: node.path,
            message: `content overflows vertically by ${over}px and is clipped (overflow-y: ${node.style.overflowY})`,
            detail: { overflowPx: over, scrollHeight: box.scrollHeight, clientHeight: box.clientHeight },
          });
        }
      }
      if (clippedBy(node.style.overflowX)) {
        const over = box.scrollWidth - box.clientWidth;
        if (over > TOLERANCE_PX) {
          findings.push({
            id: "content-overflow",
            severity: "moderate",
            selector: selectorFor(node),
            path: node.path,
            message: `content overflows horizontally by ${over}px and is clipped (overflow-x: ${node.style.overflowX})`,
            detail: { overflowPx: over, scrollWidth: box.scrollWidth, clientWidth: box.clientWidth },
          });
        }
      }
    }

    if (!isControl(node) || (w === 0 && h === 0)) continue;

    // ── offscreen-interactive: a control the user cannot reach ──
    const { frameWidth, frameHeight } = options;
    if (frameWidth !== undefined && frameHeight !== undefined) {
      const right = node.rect.x + w;
      const bottom = node.rect.y + h;
      const outRight = right - frameWidth;
      const outBottom = bottom - frameHeight;
      const outLeft = -node.rect.x;
      const outTop = -node.rect.y;
      const worst = Math.max(outRight, outBottom, outLeft, outTop);
      if (worst > TOLERANCE_PX) {
        const side =
          worst === outRight ? "right" : worst === outBottom ? "bottom" : worst === outLeft ? "left" : "top";
        findings.push({
          id: "offscreen-interactive",
          severity: "breaking",
          selector: selectorFor(node),
          path: node.path,
          message: `interactive element extends ${Math.round(worst)}px past the ${side} edge of the viewport — unreachable`,
          detail: { overflowPx: Math.round(worst), side, w, h },
        });
      }
    }

    // ── small-target: below the WCAG 2.2 AA minimum ──
    if (w > 0 && h > 0 && (w < MIN_TARGET_PX || h < MIN_TARGET_PX)) {
      findings.push({
        id: "small-target",
        severity: "moderate",
        selector: selectorFor(node),
        path: node.path,
        message: `interactive target is ${w}×${h}px, below the ${MIN_TARGET_PX}×${MIN_TARGET_PX} minimum (WCAG 2.5.8)`,
        detail: { w, h, minPx: MIN_TARGET_PX },
      });
    }
  }

  const rank: Record<InvariantSeverity, number> = { breaking: 0, moderate: 1, cosmetic: 2 };
  return findings.sort((a, b) => (rank[a.severity] - rank[b.severity]) || a.path.localeCompare(b.path));
}

/** Counts by severity, for exit codes and one-line summaries. */
export function summarizeFindings(findings: InvariantFinding[]): { total: number; breaking: number; moderate: number; cosmetic: number } {
  return {
    total: findings.length,
    breaking: findings.filter((f) => f.severity === "breaking").length,
    moderate: findings.filter((f) => f.severity === "moderate").length,
    cosmetic: findings.filter((f) => f.severity === "cosmetic").length,
  };
}