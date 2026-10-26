# Experiment Design: vlm-diff vs Percy on real pages (the "Percy 对局")

> **Status**: design doc, nothing implemented. This is the experiment that
> answers the question marketing copy cannot: *does the tool beat the tool
> users actually pay for, on pages neither tool was tuned for?*
>
> Cost: one Percy trial project + one afternoon of setup + one $0.50–$1.00 VLM
> bill. Everything on the vlm-diff side runs offline; Percy side runs on their
> free tier.

---

## 1. Why this experiment exists

Every number this project publishes today is one of:

1. **Synthetic benchmarks** (193 pairs, our own fixtures, our own mutations)
2. **Self-referential comparisons** (our pipeline vs "raw VLM" — a strawman
   nobody ships)
3. **Real-repo validation with git-diff ground truth** (6 scenarios, no
   competitor in the frame)

Percy appears **nowhere** in the evidence chain. That is the single biggest
credibility gap for an external reader: the README claims a 0% FP rate and
natural-language descriptions, but has never been run next to the tool that
makes users accept both of those problems today.

Two possible outcomes, both valuable:

- **We win**: "on the same 24 real-page change scenarios, Percy reported N
  diffs, vlm-diff reported M with DOM evidence" is the strongest piece of
  content this project can produce — reproducible, falsifiable, and not a
  benchmark.
- **We lose**: we learn exactly where (dynamic content? fonts? our
  threshold?), and we fix it before someone else finds it for us. The
  project's whole credibility is built on publishing refuted hypotheses;
  a measured loss is on-brand.

There is no outcome where running this experiment is wasted.

---

## 2. Research questions

| # | Question | Metric | Pre-registered verdict |
|---|----------|--------|--------|
| Q1 | **Signal quality** — of the real regressions we inject, what fraction does each tool surface as *actionable*? | recall on injected changes | win if vlm-diff ≥ Percy |
| Q2 | **Noise** — how much of each tool's output is anti-aliasing / font / animation noise that a human would dismiss? | FP on untouched page re-captures (Percy) vs our no-change path | win if vlm-diff FP < Percy FP |
| Q3 | **Explainability** — can a reviewer act on the report without opening the page? | % of diffs with a correct human-readable cause (color/text/layout/lifecycle) | we expect to win by construction; Percy has no description channel at all |
| Q4 | **Cost at scale** | $/1000 comparisons at current usage | we win trivially; document the exact gap |

**Hypothesis under test** (state it before running): *On real pages, vlm-diff
matches Percy on recall for DOM-observable regressions, beats it on noise
suppression, and beats it decisively on explainability and cost — while
losing wherever changes are pixel-only (canvas/video) or fonts differ.*

We do not expect to win everything. We expect to lose on at least one axis,
and the writeup must say which.

---

## 3. Materials: the page corpus

**24 scenarios**, in three buckets. All pages must be *real* — no synthetic
fixtures from `src/dataset/`. Each scenario is a (before, after) pair of a
real page.

### Bucket A — real regressions injected into real pages (14 scenarios)

Take 7 real public pages (see §3.4), apply 2 realistic mutations each via the
existing mutation machinery (devtools protocol or a local copy with an edited
stylesheet — see §4.2). Mutations drawn from the *dominantly real* classes:

- button color change (the classic)
- pricing/number text change ("$49" → "$59")
- nav item removed
- image src swap (same box, different picture)
- heading reworded
- padding/spacing regression (layout shift)
- font-weight change

### Bucket B — real-world noise (6 scenarios)

Capture the same real page twice with zero source changes, varying only:

- re-render after a `waitForTimeout` (render timing)
- a scrollbar appearing/disappearing
- a cookie banner animating in
- a `new Date()`-rendered timestamp in the page
- an ad/iframe that loads different content
- hover state accidentally captured

These are the pairs that make pixel-diff tools cry. This is where Q2 lives.

### Bucket C — genuinely pixel-only changes (4 scenarios)

- a canvas chart re-rendered with new data
- an SVG icon path changed
- a background image swapped
- a CSS gradient changed (not a solid color)

This is where *we* should lose or at least escalate — the DOM has nothing to
say. Percy sees pixels and wins by default. Pre-registering this expectation
keeps the writeup honest.

### 3.4 Page selection criteria

Pick 7 pages from public, non-authenticated, mostly-static sites:

- 1–2 landing pages with a hero + pricing (e.g. a popular OSS project's site)
- 1 docs page
- 1 e-commerce-ish listing page
- 1 page with a data table
- 1 page with a form
- 1 page known to have an ad or a timestamp (feeds Bucket B)

Criteria: publicly reachable, render deterministically in headless Chromium,
no login, no aggressive bot-blocking, small enough to screenshot at
1280×800. Fork/save a local copy for Bucket A so we can mutate the source
repeatably.

---

## 4. Method

### 4.1 Percy side

1. Free trial project at percy.io (or the open-source plan).
2. Their Playwright SDK: `percySnapshot(page, name)` at before and after.
3. **Record**: number of diffs flagged per scenario, time-to-review,
   whether the diff surfaced the *actual* change or just pixel noise,
   and what a human reviewer would have to do to answer "why".
4. Note Percy's own anti-noise features (they have some: e.g. "diff
   sensitivity" settings) and leave them at defaults — that's what a real
   user gets.

### 4.2 vlm-diff side

For each scenario:

```bash
vlm-diff snapshot <before-url> --out-dom b.dom.json --out-png b.png --out-diag b.diag.json
vlm-diff snapshot <after-url>  --out-dom a.dom.json --out-png a.png --out-diag a.diag.json
vlm-diff diff b.png a.png --dom-before b.dom.json --dom-after a.dom.json --report out.html --json
```

- Run with `--no-vlm` first to isolate the deterministic layer; run once more
  with a cheap VLM key for Bucket C escalations.
- Record: changed/not, per-region type + description + evidence, tokens,
  cost, wall time.

For Bucket A mutations, prefer editing the *saved local copy's* HTML/CSS over
runtime JS injection — it is more realistic (a real regression is a source
change, not a `page.evaluate`), and it makes the experiment reproducible by
anyone with the two files.

### 4.3 Blinding & scoring

- One person (or a second model) scores both tools' outputs against a
  pre-written answer key per scenario, **without seeing which tool produced
  which report** where feasible (Percy's UI is recognizable, so blinding is
  partial — acknowledge this).
- The answer key is written **before** either tool runs.
- Every disagreement between the two tools gets manually adjudicated and the
  adjudication is published with the writeup.

### 4.4 What we do NOT measure

- Multi-browser rendering (Percy wins by infrastructure; out of scope)
- Team/collab features (out of scope — that's a product, not a diff engine)
- Baseline approval workflows (out of scope)

Scoping these out explicitly in the writeup prevents the "you didn't test X"
thread.

---

## 5. Deliverables

1. `results/percy-bakeoff.json` — machine-readable per-scenario outcomes for
   both tools (vlm-diff side generated by a script; Percy side transcribed).
2. `docs/percy-bakeoff.md` — the writeup: method, corpus, results table,
   every disagreement adjudicated, **including where we lost**.
3. A README section ("vs Percy, on real pages") with the headline table —
   added only if we win or tie; if we lose broadly, the writeup still gets
   published (in `docs/`) but README is not touched.
4. Optionally, a juejin/dev.to post built from #2.

### Pre-registered success criteria (write these down before running)

| Outcome | Threshold | Then |
|---|---|---|
| Clear win | we match Percy recall AND beat it on FP and explainability | README table + post |
| Mixed | we win some axes, lose pixel-only (expected) | publish full writeup; README gets the honest mixed table |
| Loss | Percy beats us on DOM-observable recall | do not add to README; open issues for each lost scenario; the writeup becomes a "known limitations" doc |

The third row is the one that protects the project's credibility. Publish it
if it happens.

---

## 6. Risks & honest caveats

- **Percy's noise handling may be better than assumed.** They have years of
  heuristics. If Bucket B shows Percy at 0 FP too, Q2 becomes a tie — still
  fine, say so.
- **Our pixel-only escalation needs a VLM key** — Bucket C results depend on
  the model we pick. Run it with the cheap tier (that's the product's actual
  behavior) and note the model in the results.
- **Fonts / sub-pixel rendering differ between Percy's cloud and local
  Playwright.** Both tools see the page in *their* renderer; that's a fair
  fight (each tool in its native habitat), but it means "same page" is
  "same source, two renderers". Note it.
- **Small corpus.** 24 scenarios is a bakeoff, not a benchmark. Frame it as
  such — "24 real-page scenarios" not "we evaluated extensively".
- **Do not name-call.** The writeup is "here is what each tool reported",
  not "Percy is bad". Percy is a good product; the point is that the
  *category* has a noise/explainability gap, not that a competitor is
  incompetent.

---

## 7. Effort estimate

| Step | Time |
|---|---|
| Pick + save 7 pages, write answer key | 1–2 h |
| Inject 14 mutations (local copies) | 1–2 h |
| Percy trial setup + 24 snapshot runs | 1–2 h |
| vlm-diff script + runs (automatable, reuse `validate-real-repo.ts` patterns) | 1 h |
| Adjudication + writeup | 2–3 h |
| **Total** | **~1 day** |

The vlm-diff side can be one script (`scripts/percy-bakeoff.ts`) that loops
over a JSON scenario list and emits `results/percy-bakeoff.json` — reusing
`snapshotDom`, `collectDiagnostics`, and `diffPair` as-is. No new product
code needed.

---

## 8. What happens after

- **If clear win**: the bakeoff table becomes the new README centerpiece
  (replacing the synthetic-only headline), the post goes to juejin/dev.to,
  and the HN post (currently v0.1 numbers) gets rewritten around it.
- **If mixed**: the loss column becomes the v0.10 roadmap, and the writeup
  goes out as "where we lose, measured".
- **Either way**: `scripts/percy-bakeoff.ts` stays in the repo as a
  repeatable harness — the next competitor comparison (Chromatic,
  Lost Pixel) is a config change, not a new experiment.
