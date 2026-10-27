import { test } from "node:test";
import assert from "node:assert/strict";
import { pickCause, formatCause, styleKeyToProp } from "./css-cause.js";

const CANDIDATES = [
  { selector: ".btn", value: "blue", important: false, specificity: "(0,1,0)", order: 0 },
  { selector: ".btn--danger", value: "red", important: false, specificity: "(0,1,0)", order: 1 },
  { selector: "#save", value: "green", important: false, specificity: "(1,0,0)", order: 2 },
];

test("pickCause: id selector beats class selectors on specificity", () => {
  const cause = pickCause("background-color", "blue", "green", CANDIDATES)!;
  assert.equal(cause.winning, "#save");
  assert.equal(cause.specificity, "(1,0,0)");
  assert.equal(cause.declaration, "background-color: green");
});

test("pickCause: contenders are the non-winning rules with a reason", () => {
  const cause = pickCause("background-color", "blue", "green", CANDIDATES)!;
  assert.equal(cause.contenders.length, 2);
  assert.ok(cause.contenders.every((c) => c.lost.length > 0));
  assert.ok(cause.contenders.some((c) => c.selector === ".btn--danger"));
});

test("pickCause: winner is the candidate whose value matches the after state", () => {
  // after = red → .btn--danger should win among the class rules
  const cause = pickCause("background-color", "blue", "red", CANDIDATES)!;
  assert.equal(cause.winning, ".btn--danger");
});

test("pickCause: !important beats specificity", () => {
  const candidates = [
    { selector: "#save", value: "green", important: false, specificity: "(1,0,0)", order: 0 },
    { selector: ".btn", value: "red", important: true, specificity: "(0,1,0)", order: 1 },
  ];
  const cause = pickCause("background-color", "green", "red", candidates)!;
  assert.equal(cause.winning, ".btn");
  assert.match(cause.flip ?? "", /important/i);
});

test("pickCause: same specificity falls to source order (later wins)", () => {
  const candidates = [
    { selector: ".a", value: "blue", important: false, specificity: "(0,1,0)", order: 0 },
    { selector: ".b", value: "red", important: false, specificity: "(0,1,0)", order: 1 },
  ];
  const cause = pickCause("background-color", "blue", "red", candidates)!;
  assert.equal(cause.winning, ".b");
  assert.match(cause.flip ?? "", /source order/);
});

test("pickCause: empty candidates returns undefined", () => {
  assert.equal(pickCause("background-color", "blue", "red", []), undefined);
});

test("formatCause: renders winning + flip + overrode", () => {
  const cause = pickCause("background-color", "blue", "green", CANDIDATES)!;
  const text = formatCause(cause);
  assert.match(text, /caused by: #save/);
  assert.match(text, /overrode:/);
});

test("styleKeyToProp: camelCase style keys map to kebab-case properties", () => {
  assert.equal(styleKeyToProp("backgroundColor"), "background-color");
  assert.equal(styleKeyToProp("fontWeight"), "font-weight");
  assert.equal(styleKeyToProp("borderRadius"), "border-radius");
  assert.equal(styleKeyToProp("notAStyle"), undefined);
});