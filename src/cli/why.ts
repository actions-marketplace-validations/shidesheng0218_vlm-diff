// `vlm-diff why` — CSS cause attribution against a LIVE page.
//
// Given a URL, an element selector, and a CSS property, answer: which rule
// wins, what else could have set it, and why. This is the diagnostic
// counterpart to `diff`: diff says "background changed blue → red"; `why`
// says "btn--danger now out-ranks btn on specificity".
//
// Zero tokens, no VLM. Pure CSSOM read-back.

import type { ParsedArgs } from "./args.js";
import { attributionsExpression, pickCause, formatCause } from "../core/css-cause.js";

function usage(): string {
  return `usage: vlm-diff why <url> --selector <css> --property <css-prop> [--json]

  example: vlm-diff why http://localhost:3000 --selector "#save" --property background-color`;
}

export async function runWhy(args: ParsedArgs): Promise<number> {
  const [target] = args.positional;
  const selector = args.flags.get("selector");
  const property = args.flags.get("property");
  const json = args.flags.get("json") === true;

  if (!target || typeof selector !== "string" || typeof property !== "string") {
    console.error(`error: why needs <url>, --selector and --property\n\n${usage()}`);
    return 2;
  }

  const url = target.startsWith("http") || target.startsWith("file://")
    ? target
    : `file://${target.startsWith("/") ? target : `${process.cwd()}/${target}`}`;

  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "load" });

    // computed value before any analysis (the "after" state of the live page)
    const afterValue = await page.evaluate(
      ([sel, prop]) => {
        const el = document.querySelector(sel as string);
        if (!el) return undefined;
        return getComputedStyle(el as Element).getPropertyValue(prop as string);
      },
      [selector, property] as const,
    );

    const expr = attributionsExpression();
    const raw = await page.evaluate(
      ([sel, prop, body]) => {
        // eslint-disable-next-line no-eval
        const fn = eval(`(${body})`);
        return fn(sel, prop);
      },
      [selector, property, expr] as const,
    );

    if (!raw || (raw as any).error) {
      console.error(`error: ${(raw as any)?.error ?? "no candidates found"}`);
      return 2;
    }

    const candidates = (raw as any).candidates as Array<{ selector: string; value: string; important: boolean; specificity: string; order: number }>;
    const cause = pickCause(property, /* before */ "", afterValue ?? "", candidates);

    if (json) {
      console.log(JSON.stringify({ selector, property, computedValue: afterValue, candidates, cause }, null, 2));
    } else {
      console.log(`${selector} · ${property} = ${afterValue}`);
      console.log(`  winning rule: ${cause ? formatCause(cause) : "no matching rule found (inline style or UA default)"}`);
      if (cause && cause.contenders.length > 0) {
        for (const c of cause.contenders) console.log(`    contender: ${c.selector} ${c.specificity} ${c.declaration} — ${c.lost}`);
      }
    }
    return 0;
  } finally {
    await browser.close();
  }
}