# Changelog

## [0.9.0] — 2026-10-10

The "make the numbers trustworthy" release — a correctness audit of the metrics, cost and cache layers. No new surface area; the goal was making the existing claims stand up.

### Metrics correctness

- **`detectionPrecision` split from `localizationHitRate`** (`src/eval/metrics.ts`): the old `precision` never counted false positives — predicted-changed no-change pairs were excluded from the denominator, so it read `0.8235` identically for the raw and tiered arms. `detectionPrecision = TP/(TP+FP)` with FP = predictedChanged ∧ kind none; the old metric is renamed to what it actually measures (does the detected region land on the ground-truth box, IoU ≥ 0.3).
- **Region-level type scoring** (`regionTypeRecall`): multi-region pairs are scored per detected region instead of only the largest one (`table-element-add` detects 8 regions and previously scored 1). `changeTypeAccuracy` keeps its largest-region semantics and is labeled as such.
- **Deterministic-only pairs no longer count as cache hits** (`[].every()` on an empty classification list returned true, inflating hit counts and the money-saved estimate).
- **`element-remove` crops the before frame at `counterpartRect`** so the before crop shows the removed element itself and the prompt matches the image.
- **Cache keys include `PROMPT_VERSION` ("p1")**: editing the system prompt now invalidates old conclusions instead of serving them for up to 7 days. Entries carry a `promptVersion` audit field; entries from other prompt versions degrade to a miss.

### Cost & routing

- CLI classification routes through the cheap tier via `VLM_DIFF_CLASSIFY_MODEL` (strictly opt-in, unchanged).
- Report costs are billed by the model that actually classified each region (per-region `model` field); cache-hit regions bill zero. Previously every region was priced at the primary provider's model — ~3.75× overstatement under Haiku classification.
- The budget gate works for unpriced models: a conservative fallback price (`VLM_DIFF_DEFAULT_PRICE` or the table's highest) replaces the silent $0, and in-flight calls reserve budget so concurrent sends cannot overspend. Pricing table gains `qwen3.8-flash`, `glm-5.2`, `minimax-m3` (marked as estimates).

### Docs & gates

- `npm run docs:assert` pins README/QUICKSTART numbers — test counts, action tags, citation version, dataset size, mutation ids — to their sources (dataset, package.json, the test suite), and runs in CI's replay-gate job.
- README no longer merges the 193-pair offline replay with live-API claims; full-set figures (662 regions, 97.1% deterministic, 2.9% escalation) are separated from the small live arm; action tags/citation/roadmap synced; the four marketing posts carry data-snapshot banners.

### Robustness

- Classification concurrency is bounded (`VLM_DIFF_CLASSIFY_CONCURRENCY`, default 4).
- Cache writes are atomic (temp+rename), corrupt entries degrade to a miss, and identical in-flight classifications dedupe to one API call.
- `npm test` fails on an empty suite instead of going silently green.

Tests: 217 → 251.

## [0.7.0] — 2026-09-20

The "absorb the competitors' best ideas" release.

### Playwright SDK

- New `vlm-diff/playwright` subpath export (`src/sdk/playwright.ts`, with types): `capturePage(page)` returns `{png, dom}` in one call; `checkAgainstBaseline(page, name, opts)` diffs a page against its golden baseline and returns the full `DiffVerdict` (with `baselineMissing` when no golden exists). Integration into an existing Playwright suite is two lines.

### Ignore regions (dynamic-content masks)

- `.vlm-diff/config.json` gains `"ignore": ["#ad-slot", "[data-timestamp]"]`. Selectors resolve to rects at capture time (stored as `*.ignore.json` sidecars next to baselines); at diff time, pixel deltas inside those rects are masked out before the noise threshold and DOM changes fully inside them are dropped. Timestamps/ads/carousels stop being false positives.
- `vlm-diff diff --ignore-rect "x,y,w,h[;…]"` for ad-hoc masking.
- Live-verified: a real button color change inside an ignored region reports "no change" end-to-end.

### Scenario actions + viewport matrix

- Pages in config can carry `actions: [{click: "#menu"}, {hover: ".nav"}, {scrollY: 300}, {waitMs: 500}]` (applied after load, before capture) and per-page or global `viewports` arrays; multi-viewport captures are named `home@390x844`.
- Live-verified: a click-opened menu round-trips cleanly (identical with-action runs; removing the action surfaces the menu's geometry change).

### flaky → ignore loop

- `vlm-diff trends --suggest-ignores`: pages that flip changed↔unchanged across checks get their changed regions' DOM ids printed as candidate `#id` selectors — review before adding to `ignore`.

Tests: 212 → 217.

## [0.6.0] — 2026-09-20

The "deepen the moat, strengthen the weaknesses" release.

### Moat: attribute awareness + accessibility signals (all deterministic, zero tokens)

- **Attribute-aware DOM capture** (`src/snapshot/capture.ts`): snapshots now carry a whitelisted attribute set (`src`, `href`, `alt`, `title`, `role`, `aria-label`, `aria-hidden`, `disabled`, `placeholder`). `dom-diff` compares them per node; the describer has attribute templates ("image source changed from … to …", "alt text removed"). Effect: the `image-src-swap` pair moved from the VLM escalation path to the deterministic tier (replay escalation 3.0% → 2.9%), and link-target/alt changes are now free, evidence-carrying detections.
- **Deterministic accessibility analysis** (`src/core/a11y.ts`): WCAG 2.1 contrast math over the DOM's recorded color values (contrast dropping below AA 4.5:1 is flagged with the exact ratios, e.g. `5.2:1 → 2.9:1`), plus alt/aria-label removal detection. A11y-impacting cosmetic changes lift to `moderate` severity. Surfaced in CLI, JSON, HTML report, and MCP output. New dataset mutations `contrast-degrade` and `alt-remove` exercise both paths (the latter is a zero-pixel change only the DOM layer can see).
- Dataset: 187 → 193 pairs; offline type accuracy 91.7% → 92.7% (root-cause-first).

### Weaknesses: review + trends (the Percy-style loop, CLI-native)

- **`vlm-diff review`**: after `check` finds changes, approve per page (updates that page's golden baseline) — interactive on a TTY, `--approve a,b` / `--approve-all` for CI. Approvals are recorded in history.
- **`vlm-diff trends`**: aggregates `history.jsonl` (previously write-only) into run counts, severity distribution, per-page change frequency, and **flaky-page detection** (pages flipping between changed/unchanged ≥2× — the baselines to distrust).

### Fixes folded in

- `check` now persists current captures + a compact last-check summary under `.vlm-diff/current/` (the input `review` works from).
- README/paper/QUICKSTART synced; `docs/publish.md` gains the MCP-registry publishing note.

Tests: 198 → 212.

## [0.5.2] — 2026-09-08

### Distribution (the last mile)

- **Published to npm as `vlm-diff`**: removed `private: true`, added a `files` whitelist (runtime only — the previously-missing field would have shipped an empty/broken package since `dist/` is gitignored), full metadata (`repository`/`keywords`/`license`/`author`/`homepage`), and a `prepack` step that rebuilds and strips compiled tests. `npm pack --dry-run` verified: 37 files, both bins, zero test/eval/dataset artifacts.
- LICENSE author placeholder fixed (`shidesheng`); README citation block synced (author + version).
- MCP server version now read from package.json at runtime (the hardcoded string had drifted a version behind).
- GitHub: topics set, `v0.5.1` release created; Marketplace listing steps documented in `docs/publish.md` (the final checkbox is GitHub-UI-only).

### Model routing fix

- Classification routing is now **strictly opt-in** via `VLM_DIFF_CLASSIFY_MODEL` only. The v0.4 preset-level default (dashscope → qwen3.8-flash) silently rerouted eval classification and 403'd on entitlement-restricted accounts — caught while probing cross-tier models, removed, and the README's promise corrected.

### Weak-model stress test (third model, 51 pairs)

- `qwen3.7-flash` four-arm replication: raw arm recall **0%** (missed all 34 changed pairs), yet the tiered arm still scored **100% recall / 0% FP / 91.2% type accuracy** — the strongest demonstration yet that the pipeline's robustness is architectural, not model-dependent. DeepSeek/GLM/Kimi entitlement on this account remains denied; Claude/GPT-class replication documented as pending key.
- The unknown-model pricing warning fired correctly for qwen3.7-flash (its cost is untracked by design).

## [0.5.1] — 2026-09-08

### Fixed

- **GitHub Action**: a failing `check` inside the composite action aborted the run before the report upload and PR comment steps could execute (found by a real PR test). The check step now only records outputs; a final "Fail per policy" step surfaces the failure after artifacts and comments are in place. Verified end-to-end on a live PR: severity comment posted, `vlm-diff-reports` artifact uploaded, and the check still fails correctly under `fail-on: any`.
- `cropRegion` no longer crashes on regions that extend beyond the frame (scaled elements partially off-viewport) — clamps into bounds with a minimum 1px crop.

### Specialist model tooling (path C)

- **`npm run export:labels`**: materializes the deterministic tier's free labels — 652 labeled region-crop pairs (636 deterministic at zero cost + 16 pixel-only labels already paid for in the v0.2 run) into `data/training/`.
- **`npm run eval:specialist`**: evaluates any candidate classifier on the exported labels (hint-free, exact-match type accuracy, per-kind breakdown, cost-logged).
- **Baseline measured**: qwen3.8-max hint-free on the labels scores 50% — every miss is the model hedging subtle changes into `other`, which is exactly what a specialist trained on these labels must fix. Fine-tune entitlement on DashScope's native API verified (200); the job itself is deferred deliberately — it's recurring paid infrastructure, documented in [docs/specialist-model.md](docs/specialist-model.md).

## [0.5.0] — 2026-09-07

The "agent verifier" release: vlm-diff is now positioned as the visual verification layer for agentic coding workflows.

### MCP: agents can now see

- **`diff_screenshots` returns annotated frames as MCP image blocks** — the after frame with numbered, severity-colored region boxes (new pixel-level `annotatePng`, extracted from the demo GIF script into `src/report/overlay-png.ts`), plus the before frame. Agents verify visually, not just textually.
- **Typed `structuredContent`** via `registerTool` + `outputSchema` — the verdict is typed JSON, no more JSON-embedded-in-text.
- `snapshot_url` returns the screenshot as an image block too.
- `include_images: false` opts out for text-only clients.

### CI contract

- `vlm-diff check --json` emits one structured line (`{exitCode, pages[]}` with changeType/severity/regions/pendingEscalations per page).
- `vlm-diff check --report <dir>` writes an annotated HTML report per changed page (CI artifact).

### GitHub Action

- Composite action in the repo root (`action.yml`): install → build → check → upload annotated reports → PR comment with a severity table. Consumes the exit-code contract correctly (errors always fail; changes fail per `fail-on: breaking|any|never`; "needs VLM key" warns without failing). Self-tested in CI (`action-smoke` job).

### Docs

- README repositioned as "the visual verifier for agentic coding workflows"; new [agent recipes](docs/agent-recipes.md) for Claude Code / Cursor / ZCode.

Tests: 194 → 197.

## [0.4.0] — 2026-09-04

The "trust & cost" release — turning the pipeline into something you can run inside a real workflow and defend in a review.

### Verifiability (evidence everywhere)

- Every region verdict now carries `evidence`: the exact DOM properties it was derived from and their before/after values (deterministic tier), or the escalation reason (VLM tier). Surfaced in the CLI, the JSON output, the HTML report, and the MCP tool — you can check any description against the raw values that produced it.

### Reliability

- Every API call has a 120s timeout (`VLM_DIFF_TIMEOUT_MS`), applied inside the retry layer so a hung call becomes a retryable failure instead of a stalled run.
- Per-call output caps: classification 512 tokens, judges/raw 1024 (the OpenAI adapter previously sent no cap at all).

### User control & trust

- **Baseline overwrite requires explicit confirmation**: `vlm-diff baseline` against an existing golden state prints the affected pages and exits until you pass `--yes`. The gate refuses before any network/capture work happens.
- **Run history**: every `baseline`/`check` appends an auditable JSON line to `.vlm-diff/history.jsonl` (timestamp, pages, verdicts, exit code).
- `check` now prints a concrete next step on failure (`baseline --yes` if the change is intentional).

### Cost as a product feature

- **Cost log**: every VLM call records `{ts, fn, provider, model, tokens, latencyMs, costUsd, ok}` to `.cache/cost-log.jsonl` — per-feature spend is answerable with `jq`. `fn` attributes calls to `classify-region` / `raw-pair` / `judge` / `judge-blind`.
- **Budget gate**: `VLM_DIFF_BUDGET_USD` fails fast when a session's estimated spend crosses the cap.
- **Model routing (opt-in)**: high-volume region classification can run on a cheaper tier (`VLM_DIFF_CLASSIFY_MODEL`, or the preset's documented cheap model) while the full-image arm stays on the reasoning model. Nothing routes unless configured — results never change silently.

Docs: README gains a "Data handling & privacy" boundary section (what leaves the machine: cropped regions only; what never leaves: keys, full screenshots, DOM snapshots, baselines).

Tests: 185 → 194.

## [0.3.0] — 2026-09-04

The "structural understanding" release: positional diffing → keyed matching, plus a product-grade shell.

### Algorithm

- **Fuzzy DOM matching** (`src/detect/dom-diff.ts`): nodes are now paired by a stable key (unique `id`, else unique `tag|className|text` signature) before the positional-path pass. List reorders and head-insertions align by identity — a moved card is one `position` change, not a phantom remove+add plus cascaded diffs. Reordering visually-identical siblings is correctly a no-op.
- **Semantic region merging** (`mergeNestedRegions` in `src/detect/regions.ts`): a geometry-only region fully contained in a larger geometry-only region collapses into it (a card and its children moving is one logical change). Applied at the pipeline level; detection stays granular for metrics.
- **Deterministic severity** (`src/core/severity.ts`): ordered zero-token rules classify every region breaking/moderate/cosmetic (lifecycle and numeric-text changes are breaking; large moves/resizes moderate; color/style cosmetic). Surfaced in the CLI, the HTML report, and the MCP tool output; drives CI gating semantics.
- Dataset: 187 pairs — new `list-reorder` mutation (card grid + table rows) covering the fuzzy-matching path.

### Product

- **CLI visual report** (`vlm-diff diff --report out.html`): self-contained HTML with before/after side-by-side, the after frame annotated with numbered severity-colored region boxes, and a card per region (type/description/route/confidence/severity). The eval HTML report (`src/report/generate.ts`) now actually draws the region overlays its header always claimed.
- **Baseline workflow** (`vlm-diff init` / `baseline` / `check`): Percy-style golden snapshots under `.vlm-diff/`, with `check` re-capturing and diffing every configured page.
- **CLI hardening**: argument parser no longer lets a boolean flag swallow a positional (`--no-vlm before.png` used to eat `before.png`); supports `--flag=value`; new exit code **3** for "changed but needs a VLM key" so CI can tell it apart from errors; cache/`.env` anchor to the project root (walk-up from cwd) instead of cwd.

### Docs & demo

- QUICKSTART.md rewritten — it pointed at files and scripts that didn't exist.
- Demo GIF is now reproducible from a clean checkout (`scripts/generate-demo-gif.ts` assembles `docs/pipeline-demo.gif` in-process via pure-JS `gifenc`); dead dependency `gif.js.optimized` removed.
- Launch/marketing materials moved to `docs/marketing/` — the root directory is now the tool, not the campaign workspace.

Tests: 156 → 185.

## [0.2.0] — 2026-09-02

The "research demo → usable tool" release. Five verified problems, fixed:

### Algorithm

- **Relaxed no-change suppression** (`src/detect/regions.ts`): v0.1 suppressed every pixel delta when the DOM was unchanged, which made the VLM escalation path unreachable for exactly the cases it was built for (canvas repaints change zero DOM fields). v0.2 splits the rule at a noise floor (`pixelOnlyThreshold`, default 0.2% of frame pixels): sub-floor deltas stay suppressed; above-floor deltas become `visualOnly` pairs whose pixel regions escalate to the VLM tier.
- **End-to-end "none" aggregation** (`src/eval/baselines.ts`, `src/core/diff.ts`): a purely pixel-driven pair whose escalated regions are all classified `none` flips back to unchanged — false-positive accounting is now an end-to-end measurement. Gated on `visualOnly` so DOM evidence can never be vetoed by a model hiccup.
- **Classifier taxonomy**: `ChangeKind` gains `none`; `parseClassification` validates against the union (garbage types coerce to `other`).
- **Size-mismatch robustness** (`src/detect/perceptual-diff.ts`): frames of different sizes (real pages change height between versions) are normalized onto a common max-size canvas instead of crashing pixelmatch.

### Dataset (145 → 185 pairs)

- New `media.html` fixture with `<canvas>`/`<svg>`/`<img>` widgets.
- 4 pixel-only mutations that only the escalation path can handle: canvas repaint (color), canvas repaint (shape), SVG area fill via attribute, image `src` swap.
- No-change pairs deepened 6 → 42 (re-render/reload/settle variants; the previously dead `none-b`/`none-c` mutations now generate). The 0% FP rate's Clopper-Pearson 95% CI upper bound drops from ≈46% to ≈8%.
- DOM snapshots are SVG-safe (`className` unwrapped from `SVGAnimatedString`).
- Generation skips mutations whose selector matches nothing in a fixture instead of emitting mislabeled pairs.

### CLI & integrations

- **`vlm-diff` CLI** (`src/cli/`, `bin` entry): `diff <before.png> <after.png> [--dom-before/--dom-after] [--provider/--model] [--threshold] [--json] [--no-vlm]` with CI exit codes (0 no change / 1 changed / 2 error) and graceful pixel-only degradation without DOM snapshots; `snapshot <url> --out-dom [--out-png]` captures any page via Playwright. `.env` support via a built-in loader (no dependency).
- **MCP server** (`src/mcp/server.ts`, `vlm-diff-mcp` bin): `diff_screenshots` and `snapshot_url` tools over stdio — coding agents get a visual-regression sense. `npm run mcp:smoke` walks the full handshake offline.
- **Shared capture module** (`src/snapshot/capture.ts`): dataset generation, CLI, and MCP all use one snapshot implementation (the demo script's diverged 4-field copy is gone).

### Statistics (`src/eval/stats.ts`, `npm run stats:report`)

- Clopper-Pearson exact CIs for every rate, Wilson CIs for cross-checks.
- McNemar exact test for paired arm comparisons.
- Seeded percentile bootstrap for judge score gaps.
- Retroactive over existing reports: e.g. tiered vs raw recall is significant (p=0.016); tiered vs hint type accuracy is not (p=0.5 at n=30); all judge dimensions' bootstrap CIs straddle zero.

### Judge calibration (`npm run judge:calibrate`)

- Human labels for all 30 judged pairs (`data/judge-human-labels.json`, committed): 27/30 pairs have both descriptions correct — consistent with the 14/14/2 split. The judge's vlm lean concentrates on the 3 factually wrong descriptions. Judge-vs-human correctness agreement 66.7%/80%: usable in aggregate, too noisy per pair.

### Live re-run on the expanded subset (2026-09-02)

- Four-arm MVP on the 51-pair v0.2 subset with qwen3.8-max ($1.36 total): tiered recall 100% [CI 89.7–100%], FP 0% on 17 no-change pairs (upper bound now 19.5%), end-to-end type accuracy 97.1%, 90.2% token savings vs the hinted arm, subset escalation 18.7% (pixel-only media pairs by construction). The single type "miss" (`media-image-src-swap`) is a label-granularity artifact: the VLM described the icon swap as a blue→red color change, which is factually correct.
- All four pixel-only media pairs were classified correctly by the VLM tier — the escalation path is now exercised live, not just offline.
- Model coverage note: this DashScope account entitles only qwen3.8-max (kimi/GLM denied at runtime, qwen3.7-max is text-only), so the v0.1 kimi+qwen reports remain the cross-vendor evidence.

### Real-world validation (`scripts/validate-real-repo.ts`)

- Git-worktree harness with git-diff ground truth over pages and linked local assets. 6 commit-pair scenarios across two real open-source repos: 0 false positives, 0 misses; image-content swaps escalate 100%, DOM-explained changes stay 83% deterministic; visually-silent source changes (`lang` attribute, font URL protocol, JS interaction fix) are reported as a separate `silent` verdict class.

### Bug fixes

- **Cache key includes provider+model** (`src/cache/key.ts`): switching models with a warm cache no longer silently returns another model's classifications (version-prefixed keys invalidate v0.1 entries automatically).
- **Single pricing table** (`src/cost/pricing.ts`): the duplicate table in `run-mvp.ts` is gone; kimi/qwen models have entries; unknown models warn once instead of silently reporting $0.
- **Eval robustness** (`src/eval/run-mvp.ts`, `src/eval/run.ts`, `src/eval/judge-mvp.ts`): per-pair errors are isolated (one failure no longer kills a multi-dollar run), results checkpoint after every pair (`VLM_DIFF_MVP_RESUME=1` to resume), judge calls are concurrency-capped, the tiered arm joins `eval:run`, judge reports support `VLM_DIFF_JUDGE_TAG` and record skipped pairs.
- **Retry bounds**: worst-case wait drops from ~3.4h (8 attempts, 15s base) to ~100s (5 attempts, 5s base, 30s cap), configurable via `VLM_DIFF_RETRY_ATTEMPTS`/`VLM_DIFF_RETRY_BASE_MS`.
- **JSON extraction** deduplicated into `src/util/json.ts` (was copy-pasted in 4 places).
- Dead `domRegionCount` parameter removed from the describe API.
- Cross-platform `postbuild` (was `mkdir -p && cp -r`).
- Demo chain rewritten on real code: `demo:quick` runs the real algorithm on synthetic inputs, `demo:generate`/`demo:detect` use the real snapshot format and `detect()` (the old `demo:detect` imported a module that didn't exist).

### CI

- New `cli-mcp-smoke` job: demo chain, CLI exit-code smoke, MCP handshake — all offline.

### Docs

- README rewritten CLI-first; dataset/validation sections updated with CIs; new Real-World Validation section; limitations re-derived.
- Paper (`paper/vlm-diff.tex`) updated: thresholded suppression, expanded dataset, real-repo results, CIs/McNemar/bootstrap, judge calibration.
- Juejin article gains a v0.2 section and re-derived limitations.

## [0.1.0] — 2026-08-28

Initial research prototype: DOM+pixel fusion detection, crop-then-classify with DOM-field hints, tiered deterministic-first descriptions, four-arm MVP (Kimi K3), cross-vendor replication (qwen3.8-max), blind judge (14/14/2), zero-cost CI escalation gate.
