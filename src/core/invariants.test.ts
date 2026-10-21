import { test } from "node:test";
import assert from "node:assert/strict";
import { checkInvariants, selectorFor, summarizeFindings } from "./invariants.js";
import type { DomNode } from "../detect/dom-diff.js";

const BASE_STYLE: DomNode["style"] = {
  color: "rgb(0, 0, 0)",
  backgroundColor: "rgba(0, 0, 0, 0)",
  fontWeight: "400",
  borderRadius: "0px",
  opacity: "1",
  boxShadow: "none",
  border: "0px none rgb(0, 0, 0)",
  display: "block",
  visibility: "visible",
  overflowX: "visible",
  overflowY: "visible",
  textOverflow: "clip",
};

function node(overrides: Partial<DomNode> = {}): DomNode {
  const { style, box, ...rest } = overrides;
  return {
    path: "BODY:0>DIV:0",
    tag: "DIV",
    id: "",
    className: "",
    text: "",
    rect: { x: 0, y: 0, w: 100, h: 20 },
    style: { ...BASE_STYLE, ...style },
    box: { scrollWidth: 100, scrollHeight: 20, clientWidth: 100, clientHeight: 20, ...box },
    attrs: {},
    ...rest,
  };
}

test("checkInvariants: a healthy node produces no findings", () => {
  assert.deepEqual(checkInvariants([node({ text: "hello" })]), []);
});

test("checkInvariants: visible content collapsed to zero height is flagged", () => {
  const findings = checkInvariants([node({ text: "hello", rect: { x: 0, y: 0, w: 100, h: 0 } })]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "collapsed");
  assert.equal(findings[0].severity, "moderate");
});

test("checkInvariants: display:none is not treated as collapsed", () => {
  const findings = checkInvariants([
    node({ text: "hello", rect: { x: 0, y: 0, w: 100, h: 0 }, style: { ...BASE_STYLE, display: "none" } }),
  ]);
  assert.deepEqual(findings, []);
});

test("checkInvariants: empty spacer divider is not flagged as collapsed", () => {
  // no text, not a control — a zero-height div is legitimate
  const findings = checkInvariants([node({ rect: { x: 0, y: 0, w: 100, h: 0 } })]);
  assert.deepEqual(findings, []);
});

test("checkInvariants: ellipsis with real overflow reports the clipped px", () => {
  const findings = checkInvariants([
    node({
      text: "a very long label",
      style: { ...BASE_STYLE, overflowX: "hidden", textOverflow: "ellipsis" },
      box: { scrollWidth: 142, scrollHeight: 20, clientWidth: 100, clientHeight: 20 },
    }),
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "text-truncated");
  assert.match(findings[0].message, /42px/);
});

test("checkInvariants: ellipsis configured but text fits is not flagged", () => {
  const findings = checkInvariants([
    node({
      text: "short",
      style: { ...BASE_STYLE, overflowX: "hidden", textOverflow: "ellipsis" },
      box: { scrollWidth: 100, scrollHeight: 20, clientWidth: 100, clientHeight: 20 },
    }),
  ]);
  assert.deepEqual(findings, []);
});

test("checkInvariants: vertically clipped content is flagged", () => {
  const findings = checkInvariants([
    node({
      text: "list",
      style: { ...BASE_STYLE, overflowY: "hidden" },
      box: { scrollWidth: 100, scrollHeight: 80, clientWidth: 100, clientHeight: 20 },
    }),
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "content-overflow");
  assert.match(findings[0].message, /60px/);
});

test("checkInvariants: a scrollable (overflow:auto) box is not a defect", () => {
  const findings = checkInvariants([
    node({
      text: "list",
      style: { ...BASE_STYLE, overflowY: "auto" },
      box: { scrollWidth: 100, scrollHeight: 80, clientWidth: 100, clientHeight: 20 },
    }),
  ]);
  assert.deepEqual(findings, []);
});

test("checkInvariants: control pushed past the viewport edge is breaking", () => {
  const findings = checkInvariants(
    [node({ tag: "BUTTON", rect: { x: 1200, y: 10, w: 100, h: 40 }, text: "Go" })],
    { frameWidth: 1280, frameHeight: 800 },
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "offscreen-interactive");
  assert.equal(findings[0].severity, "breaking");
  assert.match(findings[0].message, /20px past the right edge/);
});

test("checkInvariants: offscreen rule is skipped without frame dimensions", () => {
  const findings = checkInvariants([node({ tag: "BUTTON", rect: { x: 1200, y: 10, w: 100, h: 40 } })]);
  assert.deepEqual(findings, []);
});

test("checkInvariants: undersized control is flagged", () => {
  const findings = checkInvariants([node({ tag: "BUTTON", rect: { x: 0, y: 0, w: 88, h: 20 } })]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "small-target");
  assert.match(findings[0].message, /88×20px/);
});

test("checkInvariants: prose links are not treated as targets", () => {
  // an inline <a> in a paragraph is small by nature; WCAG 2.5.8 exempts inline links
  const findings = checkInvariants([node({ tag: "A", text: "read more", rect: { x: 0, y: 0, w: 60, h: 18 } })]);
  assert.deepEqual(findings, []);
});

test("checkInvariants: a link with role=button is a target", () => {
  const findings = checkInvariants([
    node({ tag: "A", text: "Go", rect: { x: 0, y: 0, w: 60, h: 18 }, attrs: { role: "button" } }),
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].id, "small-target");
});

test("checkInvariants: checkbox inputs are exempt from the target-size rule", () => {
  const findings = checkInvariants([
    node({ tag: "INPUT", inputType: "checkbox", rect: { x: 0, y: 0, w: 16, h: 16 } }),
  ]);
  assert.deepEqual(findings, []);
});

test("checkInvariants: findings are ordered breaking before moderate", () => {
  const findings = checkInvariants(
    [
      node({ tag: "BUTTON", path: "A", rect: { x: 0, y: 0, w: 88, h: 20 } }), // moderate
      node({ tag: "BUTTON", path: "B", rect: { x: 1200, y: 0, w: 100, h: 40 } }), // breaking
    ],
    { frameWidth: 1280, frameHeight: 800 },
  );
  assert.equal(findings[0].severity, "breaking");
  assert.equal(findings[1].severity, "moderate");
});

test("checkInvariants: pre-v0.10 snapshots (no box/style extras) still work", () => {
  const legacy = {
    path: "BODY:0",
    tag: "DIV",
    id: "",
    className: "",
    text: "hello",
    rect: { x: 0, y: 0, w: 100, h: 20 },
    style: { color: "", backgroundColor: "", fontWeight: "", borderRadius: "", opacity: "", boxShadow: "", border: "" },
  } as DomNode;
  // no display (treated as visible), no box → box rules skip, no false positives
  assert.deepEqual(checkInvariants([legacy]), []);
});

test("selectorFor: prefers id, then first class, then tag", () => {
  assert.equal(selectorFor(node({ tag: "DIV", id: "hero" })), "#hero");
  assert.equal(selectorFor(node({ tag: "DIV", className: "card wide" })), "div.card");
  assert.equal(selectorFor(node({ tag: "SPAN" })), "span");
});

test("summarizeFindings: counts by severity", () => {
  const findings = checkInvariants(
    [
      node({ tag: "BUTTON", path: "A", rect: { x: 0, y: 0, w: 88, h: 20 } }),
      node({ tag: "BUTTON", path: "B", rect: { x: 1200, y: 0, w: 100, h: 40 } }),
      node({ tag: "BUTTON", path: "C", rect: { x: 0, y: 0, w: 12, h: 12 } }),
    ],
    { frameWidth: 1280, frameHeight: 800 },
  );
  const s = summarizeFindings(findings);
  assert.equal(s.total, 3);
  assert.equal(s.breaking, 1);
  assert.equal(s.moderate, 2);
});