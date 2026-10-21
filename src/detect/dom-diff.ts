// Structural DOM diff: the UI-domain-specific strong signal. Compares two
// DOM snapshots (see dataset/generate.ts snapshotDom) node-by-node via their
// positional path, and reports which nodes changed and how.

export interface DomNode {
  path: string;
  tag: string;
  id: string;
  className: string;
  text: string;
  rect: { x: number; y: number; w: number; h: number };
  style: {
    color: string;
    backgroundColor: string;
    fontWeight: string;
    borderRadius: string;
    opacity: string;
    boxShadow: string;
    border: string;
    /** present since v0.10 (layout invariants); absent in older snapshots */
    display?: string;
    visibility?: string;
    overflowX?: string;
    overflowY?: string;
    textOverflow?: string;
  };
  /** content-box metrics, present since v0.10; absent in older snapshots */
  box?: {
    scrollWidth: number;
    scrollHeight: number;
    clientWidth: number;
    clientHeight: number;
  };
  /** <input> type, captured outside `attrs` so pre-v0.10 baselines don't diff on it */
  inputType?: string;
  /** whitelisted HTML attributes (src, href, alt, aria-label, …); absent in pre-0.6 snapshots */
  attrs?: Record<string, string>;
}

/** Computed styles the structural diff compares. The v0.10 layout-only fields
 *  (display/overflow/…) are deliberately excluded: they are captured for the
 *  invariants checker, not for regression diffing. */
type DiffedStyleKey = "color" | "backgroundColor" | "fontWeight" | "borderRadius" | "opacity" | "boxShadow" | "border";

export interface RectDelta {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

export interface DomChange {
  path: string;
  id: string;
  rect: { x: number; y: number; w: number; h: number };
  changedFields: string[];
  /** after − before rect delta; present whenever changedFields includes "position" or "size" */
  rectDelta?: RectDelta;
  /** before/after values for each changed property (text or computed style); lets the
   *  deterministic describer render "blue → red" without a VLM call */
  values?: Record<string, FieldChange>;
}

export interface FieldChange {
  before: string;
  after: string;
}

export function parseSnapshot(json: string): DomNode[] {
  return JSON.parse(json) as DomNode[];
}

const RECT_TOLERANCE_PX = 1; // sub-pixel layout jitter, not a real change

function rectChanged(a: DomNode["rect"], b: DomNode["rect"]): boolean {
  return (
    Math.abs(a.x - b.x) > RECT_TOLERANCE_PX ||
    Math.abs(a.y - b.y) > RECT_TOLERANCE_PX ||
    Math.abs(a.w - b.w) > RECT_TOLERANCE_PX ||
    Math.abs(a.h - b.h) > RECT_TOLERANCE_PX
  );
}

function rectDeltaOf(b: DomNode["rect"], a: DomNode["rect"]): RectDelta {
  return { dx: a.x - b.x, dy: a.y - b.y, dw: a.w - b.w, dh: a.h - b.h };
}

/** Decompose a rect delta into position (x/y moved) and size (w/h changed) fields. */
export function rectDeltaFields(d: RectDelta): string[] {
  const fields: string[] = [];
  if (Math.abs(d.dx) > RECT_TOLERANCE_PX || Math.abs(d.dy) > RECT_TOLERANCE_PX) fields.push("position");
  if (Math.abs(d.dw) > RECT_TOLERANCE_PX || Math.abs(d.dh) > RECT_TOLERANCE_PX) fields.push("size");
  return fields;
}

/** Per-node field comparison: which fields differ between a matched before/after pair. */
function compareNodes(b: DomNode, a: DomNode): { changedFields: string[]; values: Record<string, FieldChange>; rectDelta?: RectDelta } {
  const changedFields: string[] = [];
  const values: Record<string, FieldChange> = {};
  let rectDelta: RectDelta | undefined;
  if (rectChanged(b.rect, a.rect)) {
    rectDelta = rectDeltaOf(b.rect, a.rect);
    changedFields.push(...rectDeltaFields(rectDelta));
  }
  const styleFields: DiffedStyleKey[] = [
    "color", "backgroundColor", "fontWeight", "borderRadius", "opacity", "boxShadow", "border",
  ];
  if (b.text !== a.text) {
    changedFields.push("text");
    values.text = { before: b.text, after: a.text };
  }
  for (const f of styleFields) {
    if (b.style[f] !== a.style[f]) {
      changedFields.push(f);
      values[f] = { before: b.style[f], after: a.style[f] };
    }
  }
  // attribute changes (v0.6): src swaps, link targets, alt text, aria state.
  // Old snapshots lack attrs — treat as empty so they still diff cleanly.
  const bAttrs = b.attrs ?? {};
  const aAttrs = a.attrs ?? {};
  for (const name of new Set([...Object.keys(bAttrs), ...Object.keys(aAttrs)])) {
    const bv = bAttrs[name] ?? "";
    const av = aAttrs[name] ?? "";
    if (bv !== av) {
      const field = `attr:${name}`;
      changedFields.push(field);
      values[field] = { before: bv, after: av };
    }
  }
  // a11y context: a color change needs the *effective* background even when
  // only one side changed — record both color and backgroundColor on both
  // sides (before==after for the unchanged one) without marking them changed.
  if (changedFields.includes("color") || changedFields.includes("backgroundColor")) {
    if (!values.color) values.color = { before: b.style.color, after: a.style.color };
    if (!values.backgroundColor) values.backgroundColor = { before: b.style.backgroundColor, after: a.style.backgroundColor };
  }
  return { changedFields, values, ...(rectDelta ? { rectDelta } : {}) };
}

/** Map of key → node for keys that appear exactly once (duplicates are unsafe to match). */
function uniqueIndex(nodes: DomNode[], keyOf: (n: DomNode) => string | null): Map<string, DomNode> {
  const count = new Map<string, number>();
  for (const n of nodes) {
    const k = keyOf(n);
    if (k !== null) count.set(k, (count.get(k) ?? 0) + 1);
  }
  const map = new Map<string, DomNode>();
  for (const n of nodes) {
    const k = keyOf(n);
    if (k !== null && count.get(k) === 1) map.set(k, n);
  }
  return map;
}

const idKey = (n: DomNode): string | null => (n.id ? `id:${n.id}` : null);
const sigKey = (n: DomNode): string | null => `sig:${n.tag}|${n.className}|${n.text}`;

/**
 * Diff two DOM snapshots. Returns one DomChange per node whose text, rect, or
 * style differs.
 *
 * v0.3 fuzzy matching: before the positional-path pass, nodes are paired
 * across paths by a stable key (unique id, else unique tag|className|text
 * signature). This makes list reorders and head-insertions align correctly —
 * a card that moved to a different index is one `position` change, not a
 * phantom remove+add plus cascaded text/style diffs at shifted paths. Nodes
 * without a unique key (identical siblings) stay path-matched: reordering
 * visually-identical items is genuinely a no-op.
 */
export function diffDom(before: DomNode[], after: DomNode[]): DomChange[] {
  const changes: DomChange[] = [];
  const consumedBefore = new Set<string>(); // paths of before-nodes already keyed-matched
  const consumedAfter = new Set<string>();

  // Phase 1: stable-key matching (unique ids first, then unique signatures).
  const keyedPairs: Array<{ b: DomNode; a: DomNode }> = [];
  const keyMatchedBefore = new Set<DomNode>();

  for (const keyOf of [idKey, sigKey]) {
    const bByKey = uniqueIndex(before, keyOf);
    const aByKey = uniqueIndex(after, keyOf);
    for (const [key, b] of bByKey) {
      if (keyMatchedBefore.has(b)) continue; // already matched by id
      const a = aByKey.get(key);
      if (a && !keyedPairs.some((p) => p.a === a)) {
        keyedPairs.push({ b, a });
        keyMatchedBefore.add(b);
        consumedBefore.add(b.path);
        consumedAfter.add(a.path);
      }
    }
  }

  for (const { b, a } of keyedPairs) {
    const { changedFields, values, rectDelta } = compareNodes(b, a);
    if (changedFields.length > 0) {
      changes.push({
        path: a.path,
        id: a.id,
        rect: a.rect,
        changedFields,
        ...(rectDelta ? { rectDelta } : {}),
        ...(Object.keys(values).length > 0 ? { values } : {}),
      });
    }
  }

  // Phase 2: positional-path matching for everything not keyed-matched.
  const beforeByPath = new Map(before.map((n) => [n.path, n]));
  const afterByPath = new Map(after.map((n) => [n.path, n]));
  const allPaths = new Set([...beforeByPath.keys(), ...afterByPath.keys()]);
  for (const path of allPaths) {
    const rawB = beforeByPath.get(path);
    const rawA = afterByPath.get(path);
    // a path is unavailable if its node was already claimed by a keyed match
    const b = rawB && !consumedBefore.has(rawB.path) ? rawB : undefined;
    const a = rawA && !consumedAfter.has(rawA.path) ? rawA : undefined;
    if (!b && !a) continue;

    if (!b || !a) {
      // node added or removed — carry the surviving side's text so the
      // deterministic describer can name the added/removed element
      const ref = a ?? b!;
      const values: Record<string, FieldChange> = {};
      if (ref.text) values.text = { before: !b ? "" : ref.text, after: !b ? ref.text : "" };
      changes.push({
        path,
        id: ref.id,
        rect: ref.rect,
        changedFields: [!b ? "added" : "removed"],
        ...(Object.keys(values).length > 0 ? { values } : {}),
      });
      continue;
    }

    const { changedFields, values, rectDelta } = compareNodes(b, a);
    if (changedFields.length > 0) {
      changes.push({
        path,
        id: a.id,
        rect: a.rect,
        changedFields,
        ...(rectDelta ? { rectDelta } : {}),
        ...(Object.keys(values).length > 0 ? { values } : {}),
      });
    }
  }

  return changes;
}
