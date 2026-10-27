// CSS cause attribution: for an element whose computed style changed, answer
// "which rule wins now, and what else could have set it". This is the step
// that turns a regression *report* ("background blue → red") into a
// *diagnosis* ("btn--danger now out-ranks btn").
//
// Pure string/DOM analysis over a snapshot + the page's stylesheets. No VLM,
// no extra tokens. The browser's CSSOM already resolved the cascade; we just
// read it back and rank the candidates by specificity/order/important.

import type { DomNode } from "../detect/dom-diff.js";

export interface CssCause {
  /** CSS property that changed, e.g. "background-color" */
  property: string;
  /** human-readable "what wins now": selector (file-ish context) */
  winning: string;
  /** the winning declaration, e.g. "background-color: red" */
  declaration: string;
  /** specificity of the winning rule, e.g. "(0,1,0)" */
  specificity: string;
  /** other rules that also match and could have set this property */
  contenders: Array<{ selector: string; declaration: string; specificity: string; lost: string }>;
  /** what actually flipped the outcome, when we can tell */
  flip?: string;
}

// kebab-case → the camelCase keys used in DomNode.style
const PROP_TO_STYLEKEY: Record<string, string> = {
  color: "color",
  "background-color": "backgroundColor",
  "font-weight": "fontWeight",
  "border-radius": "borderRadius",
  opacity: "opacity",
  "box-shadow": "boxShadow",
  border: "border",
};

/** Map a DomNode.style key (camelCase) to the CSS property name (kebab-case). */
export function styleKeyToProp(styleKey: string): string | undefined {
  for (const [prop, key] of Object.entries(PROP_TO_STYLEKEY)) {
    if (key === styleKey) return prop;
  }
  return undefined;
}

interface Candidate {
  selector: string;
  value: string;
  important: boolean;
  specificity: [number, number, number];
  order: number;
}

/**
 * Read every stylesheet in the page and collect the declarations that could
 * set `property` on an element matching `matcher`. Runs inside the page via
 * page.evaluate — must be a self-contained function body (no closure refs).
 */
export function attributionsExpression(): string {
  return `(function(targetSelector, property) {
    function specOf(sel) {
      // crude but correct-enough specificity: (id, class/attr/pseudo-class, type)
      var id = (sel.match(/#[\\w-]+/g) || []).length;
      var cls = (sel.match(/(\\.[\\w-]+)|(\\[[^\\]]+\\])|(\\:[\\w-]+(\\([^)]*\\))?)/g) || [])
        .filter(function(s){ return s.indexOf("::") !== 0; }).length;
      var typ = (sel.replace(/#[\\w-]+/g," ").replace(/(\\.[\\w-]+)|(\\[[^\\]]+\\])|(\\::?[\\w-]+(\\([^)]*\\))?)/g," ")
        .trim().split(/[\\s>+~]+/).filter(function(t){return t && /^[a-zA-Z]/.test(t);})).length;
      return [id, cls, typ];
    }
    function specStr(s){ return "(" + s[0] + "," + s[1] + "," + s[2] + ")"; }
    function matches(sel) {
      try { return !!document.querySelector(targetSelector) && document.querySelector(targetSelector).matches(sel); }
      catch (e) { return false; }
    }
    var target = document.querySelector(targetSelector);
    if (!target) return { error: "selector matched nothing: " + targetSelector };
    var cands = [];
    var order = 0;
    for (var si = 0; si < document.styleSheets.length; si++) {
      var sheet = document.styleSheets[si];
      var rules;
      try { rules = rulesOf(sheet); } catch (e) { continue; } // cross-origin sheets throw
      for (var ri = 0; ri < rules.length; ri++) {
        var rule = rules[ri];
        if (!rule.selectorText || !rule.style) continue;
        var selectors = rule.selectorText.split(",");
        for (var k = 0; k < selectors.length; k++) {
          var sel = selectors[k].trim();
          if (!matches(sel)) continue;
          // read both the longhand and any shorthand that sets it
          var val = rule.style.getPropertyValue(property);
          var prio = rule.style.getPropertyPriority(property);
          if (val) {
            cands.push({ selector: sel, value: val, important: prio === "important", specificity: specOf(sel), order: order++ });
          }
        }
      }
    }
    function rulesOf(sheetOrRule) {
      var out = [];
      var list = sheetOrRule.cssRules || sheetOrRule.rules || [];
      for (var i = 0; i < list.length; i++) {
        var r = list[i];
        out.push(r);
        if (r.cssRules) { var nested = rulesOf(r); for (var j = 0; j < nested.length; j++) out.push(nested[j]); }
      }
      return out;
    }
    return { property: property, candidates: cands.map(function(c){
      return { selector: c.selector, value: c.value, important: c.important, specificity: specStr(c.specificity), order: c.order };
    }) };
  })`;
}

/**
 * Given the page-side candidates, pick the winner and explain the flip.
 * `before`/`after` are the computed values from the DOM diff.
 */
export function pickCause(
  property: string,
  beforeValue: string,
  afterValue: string,
  candidates: Array<{ selector: string; value: string; important: boolean; specificity: string; order: number }>,
): CssCause | undefined {
  if (!candidates || candidates.length === 0) return undefined;

  // winner = highest priority among those whose value matches the after state
  const ranked = [...candidates].sort((a, b) => {
    if (a.important !== b.important) return a.important ? -1 : 1;
    const sa = a.specificity, sb = b.specificity;
    if (sa !== sb) return sa < sb ? 1 : -1; // string compare works for "(0,1,0)"-style tuples at our magnitudes
    return b.order - a.order; // later rule wins ties
  });
  const winner = ranked.find((c) => c.value === afterValue) ?? ranked[0];
  const contenders = ranked
    .filter((c) => c.selector !== winner.selector)
    .slice(0, 3)
    .map((c) => ({
      selector: c.selector,
      declaration: `${property}: ${c.value}`,
      specificity: c.specificity,
      lost: c.important !== winner.important
        ? "loses on !important"
        : c.specificity !== winner.specificity
          ? "loses on specificity"
          : "loses on source order",
    }));

  const wasWinning = candidates.find((c) => c.value === beforeValue && c.selector !== winner.selector);
  const flip = winner.important
    ? "an !important declaration now wins"
    : wasWinning && winner.specificity > wasWinning.specificity
      ? `${winner.selector} now out-ranks ${wasWinning.selector} on specificity`
      : winner.specificity === (wasWinning?.specificity ?? winner.specificity) && wasWinning
        ? "same specificity — later source order wins"
        : undefined;

  return {
    property,
    winning: winner.selector,
    declaration: `${property}: ${winner.value}`,
    specificity: winner.specificity,
    contenders,
    ...(flip ? { flip } : {}),
  };
}

/** Render a CssCause as a short human sentence appended to a description. */
export function formatCause(cause: CssCause): string {
  const bits = [`caused by: ${cause.winning} (${cause.specificity}) → ${cause.declaration}`];
  if (cause.flip) bits.push(`flip: ${cause.flip}`);
  if (cause.contenders.length > 0) {
    bits.push(`overrode: ${cause.contenders.map((c) => `${c.selector} (${c.declaration})`).join(", ")}`);
  }
  return bits.join(" · ");
}