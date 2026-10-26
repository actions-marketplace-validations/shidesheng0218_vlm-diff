# Percy runbook — the manual half of the bakeoff

This is the human-operated counterpart to `scripts/percy-bakeoff.ts`. Same
scenario ids, same pages, same answer key. The goal: capture Percy's actual
output for each scenario so the two tools can be scored side by side.

Read `docs/percy-bakeoff-design.md` first. This file is the checklist you
execute.

---

## 0. One-time setup

1. Create a free Percy account at https://percy.io (the free / trial tier is
   enough — we need < 100 snapshots).
2. Create a new project, e.g. `vlm-diff-bakeoff`.
3. Get the `PERCY_TOKEN` for that project.
4. In a scratch dir, install their Playwright SDK:
   ```bash
   npm init -y && npm i -D @percy/cli @percy/playwright playwright
   npx playwright install chromium
   ```

> Percy renders snapshots on *their* infrastructure. That's fine and fair —
> each tool runs in its native habitat. Note it in the writeup.

---

## 1. Snapshot each scenario

For every scenario id in `scripts/bakeoff-scenarios.ts`, take a Percy snapshot
of the **before** and **after** page. The before/after files are already
produced by our executor into `bakeoff/pages/` and `bakeoff/pairs/` — but for
Percy you serve the HTML and snapshot it with their SDK.

Easiest path — a tiny Percy script that walks the same pages:

```js
// percy-run.mjs
import { chromium } from "playwright";
import percySnapshot from "@percy/playwright";
import { readFileSync, readdirSync } from "fs";

const PAGES = "./bakeoff/pages";        // from our executor
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

for (const f of readdirSync(PAGES).filter((f) => f.endsWith(".html"))) {
  await page.goto("file://" + PAGES + "/" + f);
  await page.waitForTimeout(200);
  await percySnapshot(page, f.replace(".html", ""));
}
await browser.close();
```

Run it with `PERCY_TOKEN=... npx percy exec -- node percy-run.mjs`.

> Percy needs one *build* per run. Take all "before" snapshots in build #1,
> then all "after" snapshots in build #2, and compare the two builds. That
> is Percy's native before/after model.

---

## 2. What to record per scenario

For each scenario id, open the Percy build diff and record in a scratch file:

| field | value |
|---|---|
| scenario id | e.g. `A01-landing-button-color` |
| Percy flagged a diff? | yes / no |
| # of diffs Percy reported | integer |
| did the diff match the injected change? | yes / partial / no / noise-only |
| what a reviewer would do next | e.g. "open the page, hunt for why" |
| time-to-answer "why did this change" | seconds, your stopwatch |

Then map to the shared answer key (`expect.changed`, `expect.kind`,
`expect.mustMention` in `bakeoff-scenarios.ts`).

---

## 3. Scoring sheet

Fill this table after both runs (ours from `results/percy-bakeoff.json`,
Percy's from §2):

| scenario | truth | Percy: diff? | Percy: correct? | vlm-diff: changed? | vlm-diff: correct? | vlm-diff: explained? |
|---|---|---|---|---|---|---|
| A01 … | changed | | | | | |
| … | | | | | | |
| B01 … | unchanged | | | | | |
| C01 … | changed (pixel-only) | | | | | |

Then compute, per bucket:

- **A recall** = correct-A / total-A
- **B false positives** = flagged-B / total-B  (lower is better)
- **C detection** = correct-C / total-C  (we expect to need VLM here)
- **Explainability** = % of changed scenarios where the report names the cause
  (Percy: essentially 0 — it shows pixels, not causes)

---

## 4. Publish

Write `docs/percy-bakeoff.md` with: corpus, method, the table above, every
disagreement adjudicated, **and where we lost**. Update README only if the
outcome is a win or an honest tie (see the pre-registered criteria in
`percy-bakeoff-design.md` §5).
