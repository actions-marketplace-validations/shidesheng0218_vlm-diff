// Mutation taxonomy, loosely aligned with VLM-SubtleBench's category axes
// (spatial, color, size, text, add/remove, style) plus a "none" category
// for no-change pairs — the class where naive pixel diff reports high
// false-positive rates due to anti-aliasing/render-timing noise.

export type MutationKind =
  | "spatial-shift"
  | "color-change"
  | "size-change"
  | "text-change"
  | "element-add"
  | "element-remove"
  | "style-change"
  | "other"
  | "none";

export interface Mutation {
  id: string;
  kind: MutationKind;
  /** magnitude bucket, used to stratify the dataset (small vs large changes) */
  magnitude: "small" | "large";
  /** CSS selector of the element this mutation targets (absent for "none") */
  selector?: string;
  /** human-readable description of exactly what was mutated, used as ground truth */
  description: string;
  /** JS run in the page context (via page.evaluate) to apply the mutation */
  apply: (selector: string | undefined) => void;
  /** "none" pairs only: settle time before the after capture (default 20ms) */
  settleMs?: number;
  /** "none" pairs only: reload the page between captures instead of re-rendering in place */
  reload?: boolean;
}

// NOTE: `apply` bodies are serialized via toString() and re-executed inside
// the page context by dataset/generate.ts (Playwright's page.evaluate takes
// a function, not a closure over Node-side state), so they must be
// self-contained: no references to outer scope beyond their own parameter.
//
// Spatial shifts try margin first, then fall back to a transform if the rect
// didn't actually move. Margins are the semantically honest way to move an
// element (they push siblings, like a real layout regression) but silently
// no-op on inline elements (<a>), table cells, flex items whose free space is
// consumed by justify-content, and collapsed vertical margins — a naive
// marginLeft produces a DOM-identical pair in those fixtures. The transform
// fallback keeps every spatial mutation both pixel- and DOM-observable; the
// DOM diff tracks `transform` as a changed field (see snapshotDom).

// Newer mutations target different elements in different fixtures, so the
// selector is resolved per-fixture from this map (keyed by fixture filename).
// The legacy mutations below use a single multi-target selector and rely on
// non-matching selectors simply matching nothing.
export interface TargetedMutation extends Mutation {
  targets: Record<string, string>;
}

export function isTargeted(m: Mutation): m is TargetedMutation {
  return "targets" in m;
}

/** Self-contained page-context helper: shift by `px` along `axis`, margin-first with transform fallback. Serialized inline by toString(). */
function shiftPx(sel: string | undefined, px: number, axis: "x" | "y"): void {
  document.querySelectorAll(sel!).forEach((el) => {
    const h = el as HTMLElement;
    const before = el.getBoundingClientRect();
    if (axis === "x") h.style.marginLeft = `${px}px`;
    else h.style.marginTop = `${px}px`;
    const after = el.getBoundingClientRect();
    if (Math.abs(axis === "x" ? after.x - before.x : after.y - before.y) < 1) {
      h.style.transform = axis === "x" ? `translateX(${px}px)` : `translateY(${px}px)`;
    }
  });
}

export const MUTATIONS: Mutation[] = [
  {
    id: "spatial-shift-small",
    kind: "spatial-shift",
    magnitude: "small",
    selector: "#card-2, #email, #link-2, #row-1 td:first-child, #btn-cancel, #stat-1",
    description: "shift target element by 6px (margin-left, transform fallback)",
    apply: (sel) => {
      document.querySelectorAll(sel!).forEach((el) => {
        const h = el as HTMLElement;
        const x0 = el.getBoundingClientRect().x;
        h.style.marginLeft = "6px";
        if (Math.abs(el.getBoundingClientRect().x - x0) < 1) h.style.transform = "translateX(6px)";
      });
    },
  },
  {
    id: "spatial-shift-large",
    kind: "spatial-shift",
    magnitude: "large",
    selector: "#card-2, #email, #link-2, #row-1 td:first-child, #btn-cancel, #stat-1",
    description: "shift target element by 28px (margin-left, transform fallback)",
    apply: (sel) => {
      document.querySelectorAll(sel!).forEach((el) => {
        const h = el as HTMLElement;
        const x0 = el.getBoundingClientRect().x;
        h.style.marginLeft = "28px";
        if (Math.abs(el.getBoundingClientRect().x - x0) < 1) h.style.transform = "translateX(28px)";
      });
    },
  },
  {
    id: "color-change-small",
    kind: "color-change",
    magnitude: "small",
    selector: ".btn, .submit, .cta, #new-deploy, .btn-primary, #bars .bar:nth-child(4)",
    description: "shift accent color by a small hue delta (low contrast difference)",
    apply: (sel) => {
      document.querySelectorAll(sel!).forEach((el) => {
        (el as HTMLElement).style.backgroundColor = "#3b6fe0";
      });
    },
  },
  {
    id: "color-change-large",
    kind: "color-change",
    magnitude: "large",
    selector: ".btn, .submit, .cta, #new-deploy, .btn-primary, #bars .bar:nth-child(4)",
    description: "change accent color to a high-contrast complementary color",
    apply: (sel) => {
      document.querySelectorAll(sel!).forEach((el) => {
        (el as HTMLElement).style.backgroundColor = "#dc2626";
      });
    },
  },
  {
    id: "size-change-small",
    kind: "size-change",
    magnitude: "small",
    selector: "#card-1, #name, .logo, #row-2, #modal, #users-value",
    description: "resize target element by +10% width/height",
    apply: (sel) => {
      document.querySelectorAll(sel!).forEach((el) => {
        const h = el as HTMLElement;
        h.style.transform = "scale(1.1)";
        h.style.transformOrigin = "top left";
      });
    },
  },
  {
    id: "size-change-large",
    kind: "size-change",
    magnitude: "large",
    selector: "#card-1, #name, .logo, #row-2, #modal, #users-value",
    description: "resize target element by +35% width/height",
    apply: (sel) => {
      document.querySelectorAll(sel!).forEach((el) => {
        const h = el as HTMLElement;
        h.style.transform = "scale(1.35)";
        h.style.transformOrigin = "top left";
      });
    },
  },
  {
    id: "text-change-similar",
    kind: "text-change",
    magnitude: "small",
    selector: "#card-1 h3, #name, #link-1, #row-1 .ver, #modal-title, #rev-delta",
    description: "replace text content with a similarly-lengthed alternative",
    apply: (sel) => {
      const map: Record<string, string> = { H3: "Project Falcan", INPUT: "Jordan Reyas", A: "Product+", H2: "Delete project!", TD: "v2.14.1", DIV: "+12.9%" };
      document.querySelectorAll(sel!).forEach((el) => {
        if (el.tagName === "INPUT") (el as HTMLInputElement).value = map[el.tagName] ?? "Changed";
        else el.textContent = map[el.tagName] ?? "Changed";
      });
    },
  },
  {
    id: "text-change-different",
    kind: "text-change",
    magnitude: "large",
    selector: "#card-1 h3, #name, #link-1, #row-1 .ver, #modal-title, #rev-delta",
    description: "replace text content with a substantially different string",
    apply: (sel) => {
      document.querySelectorAll(sel!).forEach((el) => {
        if (el.tagName === "INPUT") (el as HTMLInputElement).value = "A completely different value here";
        else el.textContent = "Totally different label";
      });
    },
  },
  {
    id: "element-add",
    kind: "element-add",
    magnitude: "large",
    selector: "#grid, #form, #links, #deploy-rows, #modal-actions, #cards",
    description: "insert a new sibling element into the container",
    apply: (sel) => {
      const container = document.querySelector(sel!);
      if (!container) return;
      const clone = container.children[0]?.cloneNode(true) as HTMLElement | undefined;
      if (clone) container.appendChild(clone);
    },
  },
  {
    id: "element-remove",
    kind: "element-remove",
    magnitude: "large",
    selector: "#grid, #form, #links, #deploy-rows, #modal-actions, #cards",
    description: "remove the last child element from the container",
    apply: (sel) => {
      const container = document.querySelector(sel!);
      if (container && container.children.length > 0) {
        container.removeChild(container.children[container.children.length - 1]);
      }
    },
  },
  {
    id: "style-change-weight",
    kind: "style-change",
    magnitude: "small",
    selector: "#card-1 h3, .submit, .logo, #deploys th:first-child, #modal-title, #rev-value",
    description: "change font-weight from bold to normal",
    apply: (sel) => {
      document.querySelectorAll(sel!).forEach((el) => {
        (el as HTMLElement).style.fontWeight = "400";
      });
    },
  },
  {
    id: "style-change-radius",
    kind: "style-change",
    magnitude: "large",
    selector: ".card, .btn, .cta, .submit, #new-deploy, .btn-primary, .stat",
    description: "change border-radius from rounded to square",
    apply: (sel) => {
      document.querySelectorAll(sel!).forEach((el) => {
        (el as HTMLElement).style.borderRadius = "0px";
      });
    },
  },
  {
    id: "none",
    kind: "none",
    magnitude: "small",
    description: "no DOM/CSS mutation — re-render only, to measure false-positive rate from anti-aliasing/timing noise",
    apply: () => {
      // intentionally a no-op
    },
  },
];

// ─── Mutation expansion (2026-08-24): +12 variants × 6 fixtures ───────────
// Same taxonomy axes, new elements/axes/directions/magnitudes. All of these
// resolve their target per fixture via `targets` (fixture filename → selector).

export const EXTRA_MUTATIONS: TargetedMutation[] = [
  {
    id: "spatial-shift-tiny",
    kind: "spatial-shift",
    magnitude: "small",
    targets: { "card-list.html": "#card-3", "form.html": "#team", "navbar.html": "#link-3", "table.html": "#row-3 td:first-child", "modal.html": "#btn-confirm", "dashboard.html": "#stat-2 .value" },
    description: "shift target element by 3px (margin-left, transform fallback)",
    apply: (sel) => {
      document.querySelectorAll(sel!).forEach((el) => {
        const h = el as HTMLElement;
        const x0 = el.getBoundingClientRect().x;
        h.style.marginLeft = "3px";
        if (Math.abs(el.getBoundingClientRect().x - x0) < 1) h.style.transform = "translateX(3px)";
      });
    },
  },
  {
    id: "spatial-shift-medium",
    kind: "spatial-shift",
    magnitude: "small",
    targets: { "card-list.html": "#card-3", "form.html": "#team", "navbar.html": "#link-3", "table.html": "#row-3 td:first-child", "modal.html": "#btn-confirm", "dashboard.html": "#stat-2 .value" },
    description: "shift target element by 12px (margin-left, transform fallback)",
    apply: (sel) => {
      document.querySelectorAll(sel!).forEach((el) => {
        const h = el as HTMLElement;
        const x0 = el.getBoundingClientRect().x;
        h.style.marginLeft = "12px";
        if (Math.abs(el.getBoundingClientRect().x - x0) < 1) h.style.transform = "translateX(12px)";
      });
    },
  },
  {
    id: "spatial-shift-vertical",
    kind: "spatial-shift",
    magnitude: "small",
    targets: { "card-list.html": "#card-2", "form.html": "#email", "navbar.html": "#link-2", "table.html": "#row-3 td:first-child", "dashboard.html": "#stat-2" },
    description: "shift target element down by 8px (margin-top, transform fallback)",
    apply: (sel) => {
      document.querySelectorAll(sel!).forEach((el) => {
        const h = el as HTMLElement;
        const y0 = el.getBoundingClientRect().y;
        h.style.marginTop = "8px";
        if (Math.abs(el.getBoundingClientRect().y - y0) < 1) h.style.transform = "translateY(8px)";
      });
    },
  },
  {
    id: "color-change-text",
    kind: "color-change",
    magnitude: "small",
    targets: { "card-list.html": "#card-1 h3", "form.html": "label", "navbar.html": "#link-1", "table.html": "th", "modal.html": "#modal-title", "dashboard.html": "#rev-value" },
    description: "change text color of the target",
    apply: (sel) => { document.querySelectorAll(sel!).forEach((el) => { (el as HTMLElement).style.color = "#dc2626"; }); },
  },
  {
    id: "color-change-border",
    kind: "color-change",
    magnitude: "small",
    targets: { "card-list.html": "#card-1", "form.html": "#name", "navbar.html": "#cta", "table.html": "#panel", "modal.html": "#modal", "dashboard.html": "#stat-1" },
    description: "add/alter the target's border color",
    apply: (sel) => { document.querySelectorAll(sel!).forEach((el) => { (el as HTMLElement).style.border = "2px solid #2563eb"; }); },
  },
  {
    id: "size-change-shrink",
    kind: "size-change",
    magnitude: "small",
    targets: { "card-list.html": "#card-2", "form.html": "#email", "navbar.html": ".logo", "table.html": "#new-deploy", "modal.html": "#modal", "dashboard.html": "#stat-2" },
    description: "shrink target element by 10% via scale(0.9)",
    apply: (sel) => { document.querySelectorAll(sel!).forEach((el) => { const h = el as HTMLElement; h.style.transform = "scale(0.9)"; h.style.transformOrigin = "top left"; }); },
  },
  {
    id: "size-change-grow-medium",
    kind: "size-change",
    magnitude: "small",
    targets: { "card-list.html": "#card-3", "form.html": "#team", "navbar.html": "#cta", "table.html": "#panel", "modal.html": "#modal", "dashboard.html": "#chart" },
    description: "resize target element by +20% via scale(1.2)",
    apply: (sel) => { document.querySelectorAll(sel!).forEach((el) => { const h = el as HTMLElement; h.style.transform = "scale(1.2)"; h.style.transformOrigin = "top left"; }); },
  },
  {
    id: "text-change-shorten",
    kind: "text-change",
    magnitude: "small",
    targets: { "card-list.html": "#card-2 h3", "form.html": "h2", "table.html": "#row-1 .svc", "modal.html": "#modal-title", "dashboard.html": "#stat-1 .label" },
    description: "shorten the target's text content (keep first half)",
    apply: (sel) => {
      document.querySelectorAll(sel!).forEach((el) => {
        const t = (el.textContent ?? "").trim();
        el.textContent = t.slice(0, Math.max(1, Math.ceil(t.length / 2)));
      });
    },
  },
  {
    id: "text-change-number",
    kind: "text-change",
    magnitude: "small",
    targets: { "card-list.html": "#card-1 h3", "form.html": "#team", "table.html": "#row-2 .err", "modal.html": "#modal-body", "dashboard.html": "#rev-value" },
    description: "change a numeric value (price/count/metric)",
    apply: (sel) => {
      const map: Record<string, string> = { H3: "Project Falcon 2", INPUT: "10-25 people", A: "Pricing+", TD: "23", P: "This will permanently remove the project and its 21 deployments. This action cannot be undone.", DIV: "$52,980" };
      document.querySelectorAll(sel!).forEach((el) => {
        const v = map[el.tagName] ?? "42";
        if (el.tagName === "INPUT") (el as HTMLInputElement).value = v; else el.textContent = v;
      });
    },
  },
  {
    id: "element-remove-first",
    kind: "element-remove",
    magnitude: "large",
    targets: { "card-list.html": "#grid", "form.html": "#form", "navbar.html": "#links", "table.html": "#deploy-rows", "modal.html": "#modal-actions", "dashboard.html": "#cards" },
    description: "remove the FIRST child element from the container",
    apply: (sel) => {
      const container = document.querySelector(sel!);
      if (container && container.children.length > 0) container.removeChild(container.children[0]);
    },
  },
  {
    id: "style-change-shadow",
    kind: "style-change",
    magnitude: "small",
    targets: { "card-list.html": "#card-1", "form.html": "#form", "navbar.html": "#nav", "table.html": "#panel", "modal.html": "#modal", "dashboard.html": "#stat-1" },
    description: "change the target's box-shadow",
    apply: (sel) => { document.querySelectorAll(sel!).forEach((el) => { (el as HTMLElement).style.boxShadow = "0 8px 24px rgba(37,99,235,0.35)"; }); },
  },
  {
    id: "style-change-opacity",
    kind: "style-change",
    magnitude: "small",
    targets: { "card-list.html": "#card-3", "form.html": "#submit", "table.html": "#row-4", "dashboard.html": "#chart" },
    description: "lower the target's opacity to 0.5",
    apply: (sel) => { document.querySelectorAll(sel!).forEach((el) => { (el as HTMLElement).style.opacity = "0.5"; }); },
  },
  {
    id: "none-b",
    kind: "none",
    magnitude: "small",
    targets: {},
    settleMs: 60,
    description: "no DOM/CSS mutation (second no-change sample, 60ms settle)",
    apply: () => { /* no-op */ },
  },
  {
    id: "none-c",
    kind: "none",
    magnitude: "small",
    targets: {},
    settleMs: 100,
    description: "no DOM/CSS mutation (third no-change sample, 100ms settle)",
    apply: () => { /* no-op */ },
  },
];

// ─── v0.2 expansion (2026-09-02): pixel-only mutations + no-change depth ───
// The v0.1 dataset was DOM-observable by construction, which made the
// escalation rate circular (99.3% determinism was guaranteed by the
// benchmark). These mutations exercise the pixel-only path that the relaxed
// no-change suppression rule (regions.ts) now escalates to the VLM:
// canvas/SVG repaints and image swaps change zero captured DOM fields.
// The extra "none" variants deepen the false-positive denominator (v0.1
// had 6 no-change pairs; the 95% CI on a 0% FP rate reached ~39%).
// `targets: {}` on none-kind mutations means "every fixture" (generate.ts).

export const V02_MUTATIONS: TargetedMutation[] = [
  {
    id: "canvas-repaint-color",
    kind: "color-change",
    magnitude: "large",
    targets: { "media.html": "#chart-canvas" },
    description: "canvas bar chart repainted in a different color (zero DOM signal)",
    apply: (sel) => {
      const c = document.querySelector(sel!) as HTMLCanvasElement;
      const ctx = c.getContext("2d")!;
      let s = 42; // identical seed/geometry as the fixture's initial draw
      const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
      ctx.fillStyle = "#f3f4f6";
      ctx.fillRect(0, 0, c.width, c.height);
      for (let i = 0; i < 8; i++) {
        const h = 24 + Math.floor(rnd() * 100);
        ctx.fillStyle = "#dc2626";
        ctx.fillRect(i * 36 + 14, 140 - h, 26, h);
      }
    },
  },
  {
    id: "canvas-repaint-shape",
    kind: "size-change",
    magnitude: "small",
    targets: { "media.html": "#chart-canvas" },
    description: "canvas bar chart redrawn with different bar heights (zero DOM signal)",
    apply: (sel) => {
      const c = document.querySelector(sel!) as HTMLCanvasElement;
      const ctx = c.getContext("2d")!;
      let s = 1337; // different seed → different heights, same palette
      const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
      ctx.fillStyle = "#f3f4f6";
      ctx.fillRect(0, 0, c.width, c.height);
      for (let i = 0; i < 8; i++) {
        const h = 24 + Math.floor(rnd() * 100);
        ctx.fillStyle = "#3b82f6";
        ctx.fillRect(i * 36 + 14, 140 - h, 26, h);
      }
    },
  },
  {
    id: "svg-repaint-fill",
    kind: "color-change",
    magnitude: "small",
    targets: { "media.html": "#spark-bg" },
    description: "SVG sparkline background recolored via fill attribute (not a captured DOM field)",
    // A stroke-only recolor on a 2px line changes ~0.04% of frame pixels —
    // below any sane noise floor, so it would never reach the VLM tier and
    // would only re-document pixel diff's known limit. Recoloring the 200×48
    // background rect crosses the floor, and a `fill` attribute change is
    // invisible to the DOM snapshot (geometry and captured styles unchanged).
    // Note: the target color must clear pixelmatch's own YIQ threshold (0.15);
    // #fecaca sits below it and registers zero changed pixels.
    apply: (sel) => {
      document.querySelectorAll(sel!).forEach((el) => {
        el.setAttribute("fill", "#f87171");
      });
    },
  },
  {
    id: "image-src-swap",
    kind: "other",
    magnitude: "large",
    targets: { "media.html": "#avatar" },
    description: "image src swapped for a different graphic (deterministic since v0.6: src is a captured DOM attribute)",
    apply: (sel) => {
      const swapped =
        "data:image/svg+xml;utf8," +
        encodeURIComponent(
          "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'>" +
            "<rect width='64' height='64' rx='12' fill='#dc2626'/>" +
            "<circle cx='32' cy='26' r='10' fill='white'/>" +
            "<rect x='16' y='40' width='32' height='14' rx='7' fill='white'/>" +
            "</svg>",
        );
      document.querySelectorAll(sel!).forEach((el) => {
        (el as HTMLImageElement).src = swapped;
      });
    },
  },
  {
    id: "list-reorder",
    kind: "spatial-shift",
    magnitude: "large",
    targets: { "card-list.html": "#grid", "table.html": "#deploy-rows" },
    description: "reverse the order of the container's children (reorder — fuzzy DOM matching must align by identity, not position)",
    apply: (sel) => {
      const container = document.querySelector(sel!);
      if (!container) return;
      const kids = Array.from(container.children);
      for (let i = kids.length - 1; i >= 0; i--) container.appendChild(kids[i]);
    },
  },
  {
    id: "contrast-degrade",
    kind: "color-change",
    magnitude: "small",
    targets: { "card-list.html": "#card-1 .btn", "navbar.html": "#cta", "modal.html": "#btn-confirm", "table.html": "#new-deploy", "form.html": ".submit" },
    description: "text color washed out against its background (drops below WCAG AA contrast)",
    // targets buttons (which own both color and backgroundColor) so the a11y
    // assessor can compute contrast from the recorded values
    apply: (sel) => {
      document.querySelectorAll(sel!).forEach((el) => { (el as HTMLElement).style.color = "#93c5fd"; });
    },
  },
  {
    id: "alt-remove",
    kind: "text-change",
    magnitude: "small",
    targets: { "media.html": "#avatar" },
    description: "alt attribute removed from the image (accessibility regression, zero pixel change)",
    apply: (sel) => {
      document.querySelectorAll(sel!).forEach((el) => { el.removeAttribute("alt"); });
    },
  },
  {
    id: "none-d",
    kind: "none",
    magnitude: "small",
    targets: {},
    settleMs: 200,
    description: "no DOM/CSS mutation (long-settle re-render, 200ms)",
    apply: () => { /* no-op */ },
  },
  {
    id: "none-e",
    kind: "none",
    magnitude: "small",
    targets: {},
    reload: true,
    description: "no DOM/CSS mutation (full page reload between captures)",
    apply: () => { /* no-op */ },
  },
  {
    id: "none-f",
    kind: "none",
    magnitude: "small",
    targets: {},
    reload: true,
    settleMs: 100,
    description: "no DOM/CSS mutation (reload + 100ms settle, second reload sample)",
    apply: () => { /* no-op */ },
  },
];
