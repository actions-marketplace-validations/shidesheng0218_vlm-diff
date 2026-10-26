# Percy bakeoff — vlm-diff side results (offline)

> **Status**: vlm-diff side complete (24/24, zero API calls). Percy side
> pending a human run per `percy-bakeoff-percy-runbook.md`. This file is
> auto-summarized from `results/percy-bakeoff.json`; regenerate with
> `npx tsx scripts/percy-bakeoff.ts`.

## What this is

The first time the tool is run against **real public pages** with
**real source-change regressions**, next to the tool users actually pay for
(Percy). Not synthetic fixtures, not a strawman "raw VLM" arm.

Corpus: 24 scenarios across 5 real pages (`example.com`, `httpbin.org`
forms/links/json/image), in three buckets — **A**: 14 injected regressions,
**B**: 6 pure-noise pairs, **C**: 4 pixel-only changes.

## vlm-diff results (offline, zero API calls)

| Bucket | What it tests | Result | Verdict |
|---|---|---|---|
| **A** — real regressions | recall on injected DOM-visible changes | **14/14 (100%)** | ✅ |
| **B** — pure noise | false positives on re-render / scrollbar / timestamp / hover | **0/6 (100% clean)** | ✅ |
| **C** — pixel-only | canvas / gradient / SVG / shadow (no DOM signal) | **4/4 detected** (1 escalated to VLM as designed) | ✅ |
| **Overall** | | **24/24 (100%)** | ✅ |

### Notes a careful reader should check

- **A05/A06/A08/A09 produced 8 regions** — httpbin's link pages are a flat
  list of siblings, so removing/editing one node cascades position deltas to
  the rest. The deterministic layer attributes reflow followers to their root
  cause, so the pair-level summary stays correct, but the region count shows
  real pages produce messier cascades than the tidy synthetic fixtures. This
  is honest signal, not a bug.
- **B05 (timestamp)** is the interesting one. A dynamic timestamp *is* a real
  DOM text change — the tool reports it unless masked. The scenario models the
  real workflow: the user marks the timestamp region via `ignore` config, and
  the pair then reads clean. This is the correct behavior (and the correct
  expectation), but it depends on the user knowing to mask dynamic regions —
  which is exactly what `vlm-diff trends --suggest-ignores` exists to help with.
- **C02 (CSS gradient)** is the only scenario that needed the VLM escalation
  path: a `linear-gradient` change is not one of the captured computed styles,
  so the DOM layer is silent and the pixel delta crosses the noise floor. This
  is the design working as intended — and it's the case where Percy's pure
  pixel diff also fires.

## The comparison table (to fill after the Percy run)

| Metric | Percy | vlm-diff |
|---|---|---|
| A recall (14) | _pending_ | **14/14** |
| B false positives (6) | _pending_ | **0/6** |
| C detection (4) | _pending_ | **4/4** |
| explains *why* (color/text/layout/cause) | _pending_ (expected: no) | **yes, with DOM evidence** |
| cost / 24 scenarios | _pending_ | **$0.00** (offline) |

## Reproduce

```bash
npx tsx scripts/percy-bakeoff.ts          # offline, ~40s, zero API cost
# then the Percy half: docs/percy-bakeoff-percy-runbook.md
```
