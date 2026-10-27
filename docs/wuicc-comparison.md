# Can we run vlm-diff on WUICC-bench? — feasibility assessment

> Status: assessed 2026-10-26. **Conclusion: not directly, and that constraint is
> actually the story.** Network to HuggingFace was unreachable during this
> session, so this is a methodology + decision document, not a run.

## What WUICC-bench is (verified from the abstract, arXiv:2607.01728)

- Task: **Web UI Image Change Captioning (WUICC)** — describe a UI change in
  words, at the intersection of visual regression testing and image
  difference captioning.
- Content: image pairs + human-written change descriptions.
- Evaluated: **11 image-difference-captioning (IDC) methods + 2 zero-shot
  general LLMs.** Headline finding: all struggle on web UIs (layout
  diversity, dense text, fine-grained changes).
- Motivation stated in the abstract: pixel-level VRT is "semantically blind",
  and "no dataset exists to support natural language descriptions of UI
  changes."

## The structural mismatch (why "run on their benchmark" is not a drop-in)

Their dataset is **image pairs + text captions**. It has **no DOM snapshots**.

Our pipeline's advantage is the deterministic tier, which needs the DOM. On
their data:

- **Tier 1 (DOM detection) cannot run** — there is no DOM to diff.
- **Tier 2 (template description) cannot run** — no DOM evidence to render.
- Only the **Tier 3 escalation path** (crop → VLM classify) applies.

So a naive "vlm-diff on WUICC-bench" would test *only our weakest tier* and
hide the 97% of the value. That's a loss by construction, not a measurement.

## The honest comparison is the other direction

WUICC-bench's own finding — "trained methods suppress noise more selectively
than pixel-diff, but still struggle on web UI" — is the strongest possible
setup for our claim. The positioning that follows from their own abstract:

> They proved the visual-only approach is hard on web UI.
> We showed the structural approach makes 97% of it free.

The right artifact is therefore **not** "our score on their benchmark", it's:

1. A section in our paper/README (done, 2026-10-26) framing them as closest
   prior work and naming the structural gap.
2. **If** we want a head-to-head: replicate their task *with DOM*, i.e. take
   a sample of their image pairs, render the *source* pages (if their dataset
   includes them) or reconstruct equivalent pages, capture DOM, and run our
   full pipeline vs their reported IDC baselines on the same images.

## Decision tree (when network allows fetching the dataset)

```
Fetch WUICC-bench dataset from HuggingFace
│
├─ Does it include source HTML/DOM, or only images+captions?
│   ├─ includes DOM/HTML → run full pipeline, compare vs their 11 baselines.
│   │                    This is the strong outcome: same task, same images,
│   │                    we add the structural signal they lack.
│   └─ images+captions only → two options:
│        (a) Run ONLY our Tier-3 (crop+VLM) vs their IDC methods — honest but
│            shows our weakest tier; label it clearly as "escalation path only".
│        (b) Treat their benchmark as motivation, not a target, and instead
│            extend OUR 193-pair dataset with dense-text / diverse-layout
│            fixtures to cover the cases they say are hard. Cheaper and more
│            defensible.
│
└─ Dataset not downloadable / gated → option (b). Their abstract already
   concedes the difficulty; we don't need their data to make the point.
```

## Recommendation

**Do (b) unless their dataset ships DOM.** The persuasive comparison isn't a
number on their leaderboard — it's that their 11 methods can't use the signal
we built the whole tool around. Spend the effort on the Percy bakeoff (a
competitor users actually pay for) and on extending our dataset toward the
hard cases WUICC names (dense text, diverse layouts), where we're currently
synthetic-fixture-heavy.

## Action items (blocked on network to HuggingFace)

- [ ] `curl https://huggingface.co/api/datasets?search=WUICC` (was unreachable)
- [ ] If found: inspect whether the dataset ships source HTML/DOM or only images
- [ ] Record the dataset card URL + license here
- [ ] Decide branch (a) vs (b) per the tree above
