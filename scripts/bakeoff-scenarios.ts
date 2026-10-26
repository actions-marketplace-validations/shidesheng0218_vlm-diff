// Percy bakeoff — scenario definitions + pre-registered answer key.
//
// This file is the single source of truth for the experiment. It lists every
// scenario, the page it applies to, how to produce the before/after pair, and
// the answer a human reviewer expects. The executor (percy-bakeoff.ts) reads
// this and emits results/percy-bakeoff.json; the Percy side is driven manually
// from docs/percy-bakeoff-percy-runbook.md (same scenario ids).
//
// Page sources are NOT synthetic fixtures from src/dataset/ — they are saved
// local copies of real public pages (see SOURCES below), fetched by
// `npm run bakeoff:fetch`. Mutations edit the saved copy's source (a real
// regression is a source change, not a runtime page.evaluate).

export type Bucket = "A" | "B" | "C";

export interface MutationOp {
  /** CSS selector to mutate */
  selector: string;
  /** one of the supported edit kinds */
  kind: "set-style" | "set-text" | "remove" | "set-attr" | "append-html";
  /** for set-style: property + value; for set-text: new text; for set-attr: name/value; for append-html: html */
  prop?: string;
  value?: string;
}

export interface Scenario {
  id: string;
  bucket: Bucket;
  /** key into PAGES */
  page: string;
  /** human description of what the after-image is supposed to show */
  description: string;
  /** Bucket A/C: edits applied to the saved page source to make the "after". Bucket B: no edits. */
  mutations?: MutationOp[];
  /** Bucket B only: which noise mechanism to trigger */
  noise?: "rerender" | "timestamp" | "scrollbar" | "hover";
  /** Pre-registered expected outcome (the answer key) */
  expect: {
    changed: boolean;
    /** expected dominant change kind for changed scenarios */
    kind?: string;
    /** what a perfect report would say, in words a scorer checks for */
    mustMention?: string[];
  };
  /** our honest prior: do we expect vlm-diff to need the VLM here? */
  expectEscalation?: boolean;
}

// ─── Pages ──────────────────────────────────────────────────────────────────
// Saved local copies of real public pages. `bakeoff:fetch` downloads each into
// bakeoff/pages/<key>.html (plus a .url file recording the origin). Because the
// network on this machine is intermittent, SOURCES includes fallbacks; the
// fetch script tries each in order and records which one succeeded.

export interface PageSource {
  key: string;
  /** candidate URLs, tried in order */
  urls: string[];
  /** what kind of real page this stands in for */
  role: string;
}

export const PAGES: PageSource[] = [
  {
    key: "landing",
    role: "landing page with hero + CTA (stands in for a product/pricing page)",
    urls: [
      "https://example.com",
      "https://httpbin.org/html",
    ],
  },
  {
    key: "form",
    role: "real HTML form with labels/inputs/select/textarea",
    urls: ["https://httpbin.org/forms/post"],
  },
  {
    key: "list",
    role: "link list / table-ish content (stands in for a listing page)",
    urls: [
      "https://httpbin.org/links/10/0",
      "https://example.com",
    ],
  },
  {
    key: "status",
    role: "data/status page with values (stands in for a dashboard)",
    urls: ["https://httpbin.org/json", "https://example.com"],
  },
  {
    key: "media",
    role: "page with an <img> + canvas-able content (for pixel-only bucket C)",
    urls: ["https://httpbin.org/image/png", "https://example.com"],
  },
];

// ─── Scenarios ──────────────────────────────────────────────────────────────
// 24 total: A=14 (injected regressions), B=6 (pure noise), C=4 (pixel-only).

export const SCENARIOS: Scenario[] = [
  // ── Bucket A: real regressions injected into real pages ──────────────────
  {
    id: "A01-landing-button-color",
    bucket: "A",
    page: "landing",
    description: "primary CTA / link color changes",
    mutations: [{ selector: "a", kind: "set-style", prop: "color", value: "#dc2626" }],
    expect: { changed: true, kind: "color-change", mustMention: ["color"] },
  },
  {
    id: "A02-landing-heading-text",
    bucket: "A",
    page: "landing",
    description: "main heading text is reworded",
    mutations: [{ selector: "h1", kind: "set-text", value: "Welcome to the Example Platform" }],
    expect: { changed: true, kind: "text-change", mustMention: ["text"] },
  },
  {
    id: "A03-landing-add-banner",
    bucket: "A",
    page: "landing",
    description: "a promotional banner is inserted above the hero",
    mutations: [{ selector: "body", kind: "append-html", value: "<div style=\"background:#dc2626;color:#fff;padding:12px;text-align:center\">50% off this week</div>" }],
    expect: { changed: true, kind: "element-add", mustMention: ["added"] },
  },
  {
    id: "A04-form-submit-color",
    bucket: "A",
    page: "form",
    description: "submit button background changes",
    mutations: [{ selector: "input[type=submit], button", kind: "set-style", prop: "background-color", value: "#16a34a" }],
    expect: { changed: true, kind: "color-change", mustMention: ["background"] },
  },
  {
    id: "A05-form-label-text",
    bucket: "A",
    page: "form",
    description: "a field label is renamed",
    mutations: [{ selector: "label", kind: "set-text", value: "Customer full name" }],
    expect: { changed: true, kind: "text-change", mustMention: ["text"] },
  },
  {
    id: "A06-form-remove-field",
    bucket: "A",
    page: "form",
    description: "a form field is removed",
    mutations: [{ selector: "form p:nth-of-type(2)", kind: "remove" }],
    expect: { changed: true, kind: "element-remove", mustMention: ["removed"] },
  },
  {
    id: "A07-list-add-item",
    bucket: "A",
    page: "list",
    description: "a new link/item is appended to the list",
    mutations: [{ selector: "body", kind: "append-html", value: "<a href=\"/extra\">Extra item</a>" }],
    expect: { changed: true, kind: "element-add", mustMention: ["added"] },
  },
  {
    id: "A08-list-remove-item",
    bucket: "A",
    page: "list",
    description: "an item is removed from the list",
    mutations: [{ selector: "a:nth-of-type(1)", kind: "remove" }],
    expect: { changed: true, kind: "element-remove", mustMention: ["removed"] },
  },
  {
    id: "A09-list-text-number",
    bucket: "A",
    page: "list",
    description: "a numeric/count text changes",
    mutations: [{ selector: "a:nth-of-type(1)", kind: "set-text", value: "Link 1 (updated)" }],
    expect: { changed: true, kind: "text-change", mustMention: ["text"] },
  },
  {
    id: "A10-status-value-color",
    bucket: "A",
    page: "status",
    description: "a status value color changes (red flag)",
    mutations: [{ selector: "body, pre", kind: "set-style", prop: "color", value: "#b91c1c" }],
    expect: { changed: true, kind: "color-change", mustMention: ["color"] },
  },
  {
    id: "A11-status-layout-shift",
    bucket: "A",
    page: "status",
    description: "content block shifts down / spacing regression",
    mutations: [{ selector: "body", kind: "set-style", prop: "margin-top", value: "60px" }],
    expect: { changed: true, kind: "spatial-shift", mustMention: ["moved", "shift", "down"] },
  },
  {
    id: "A12-media-image-swap",
    bucket: "A",
    page: "media",
    description: "image src swapped for a different image (same box)",
    mutations: [{ selector: "img", kind: "set-attr", prop: "src", value: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='100' height='100'><rect width='100' height='100' fill='red'/></svg>" }],
    expect: { changed: true, kind: "other", mustMention: ["image", "source", "src"] },
    expectEscalation: false, // v0.6+ captures src as an attribute → deterministic
  },
  {
    id: "A13-landing-font-weight",
    bucket: "A",
    page: "landing",
    description: "heading becomes bold (style regression)",
    mutations: [{ selector: "h1", kind: "set-style", prop: "font-weight", value: "900" }],
    expect: { changed: true, kind: "style-change", mustMention: ["weight"] },
  },
  {
    id: "A14-form-layout-padding",
    bucket: "A",
    page: "form",
    description: "form container padding grows (layout regression)",
    mutations: [{ selector: "form", kind: "set-style", prop: "padding", value: "40px" }],
    expect: { changed: true, kind: "size-change", mustMention: ["size", "resiz", "shift", "padd"] },
  },

  // ── Bucket B: pure noise (no real change) ────────────────────────────────
  // Ground truth: unchanged. These are where pixel-diff tools cry.
  { id: "B01-landing-rerender", bucket: "B", page: "landing", description: "same page re-captured after a settle wait", noise: "rerender", expect: { changed: false } },
  { id: "B02-form-rerender", bucket: "B", page: "form", description: "same form re-captured", noise: "rerender", expect: { changed: false } },
  { id: "B03-status-rerender", bucket: "B", page: "status", description: "same status page re-captured", noise: "rerender", expect: { changed: false } },
  { id: "B04-landing-scrollbar", bucket: "B", page: "landing", description: "a scrollbar appears (viewport shrinks by a scrollbar width)", noise: "scrollbar", expect: { changed: false } },
  { id: "B05-list-timestamp", bucket: "B", page: "list", description: "a dynamic timestamp region re-renders to a new value (masked via ignore-rect)", noise: "timestamp", expect: { changed: false } },
  { id: "B06-form-hover", bucket: "B", page: "form", description: "a control is captured in hover state by accident", noise: "hover", expect: { changed: false } },

  // ── Bucket C: genuinely pixel-only (DOM is silent) ───────────────────────
  // We EXPECT to need the VLM here (or miss without one). Pre-registered.
  {
    id: "C01-media-canvas-repaint",
    bucket: "C",
    page: "media",
    description: "a canvas is repainted with different content (no DOM change)",
    mutations: [{ selector: "body", kind: "append-html", value: "<canvas id=\"c\" width=\"200\" height=\"80\"></canvas><script>var x=document.getElementById('c').getContext('2d');x.fillStyle='#2563eb';x.fillRect(0,0,200,80);</script>" }],
    expect: { changed: true, kind: "other", mustMention: [] },
    expectEscalation: true,
  },
  {
    id: "C02-media-gradient",
    bucket: "C",
    page: "media",
    description: "a CSS gradient background changes (computed style may not capture it)",
    mutations: [{ selector: "body", kind: "set-style", prop: "background", value: "linear-gradient(90deg,#2563eb,#dc2626)" }],
    expect: { changed: true, kind: "color-change", mustMention: [] },
    expectEscalation: true,
  },
  {
    id: "C03-status-svg-fill",
    bucket: "C",
    page: "status",
    description: "an inline SVG fill changes",
    mutations: [{ selector: "body", kind: "append-html", value: "<svg width=\"120\" height=\"60\"><rect width=\"120\" height=\"60\" fill=\"#16a34a\"/></svg>" }],
    expect: { changed: true, kind: "color-change", mustMention: [] },
    expectEscalation: true,
  },
  {
    id: "C04-landing-boxshadow",
    bucket: "C",
    page: "landing",
    description: "a large box-shadow is added (visual halo, may be subtle to DOM)",
    mutations: [{ selector: "div", kind: "set-style", prop: "box-shadow", value: "0 20px 60px rgba(220,38,38,0.6)" }],
    expect: { changed: true, kind: "style-change", mustMention: [] },
    expectEscalation: false, // boxShadow is a captured computed style
  },
];

// ─── answer-key sanity (used by tests + the executor's self-check) ───────────
export function bucketCounts() {
  return {
    A: SCENARIOS.filter((s) => s.bucket === "A").length,
    B: SCENARIOS.filter((s) => s.bucket === "B").length,
    C: SCENARIOS.filter((s) => s.bucket === "C").length,
    total: SCENARIOS.length,
    changed: SCENARIOS.filter((s) => s.expect.changed).length,
    unchanged: SCENARIOS.filter((s) => !s.expect.changed).length,
  };
}
