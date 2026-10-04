---
title: Building a Visual Regression Tool with VLMs and DOM Diffing
published: true
description: How I combined DOM structure with vision-language models to achieve 92% recall with 0% false positives in UI regression testing
tags: webdev, testing, ai, opensource
cover_image: https://dev-to-uploads.s3.amazonaws.com/uploads/articles/default-cover.png
---

> **Data snapshot: v0.1 (39 pairs).** The numbers in this article (92% recall, 0% false positives, 39 pairs) are from the initial release. Current figures: 193 pairs, 151/151 changed pairs detected with 0/42 false positives (offline replay), 97.1% of regions answered deterministically, 90.2% token reduction — see the README.

Hey Dev.to! I built a tool that combines DOM diffing with vision-language models (VLMs) for UI regression testing. Here's why and how.

## The Problem with Current Visual Regression Tools

Ever used Percy, Chromatic, or Applitools? They catch real UI changes, but also flag **tons of false positives** from:

- 🔴 Anti-aliasing noise
- 🔴 Font rendering jitter
- 🔴 Input focus rings
- 🔴 Dynamic timestamps

This creates "alert fatigue" — developers start ignoring reports because 80% are false positives.

## The Key Insight

UI screenshots have a **unique advantage** over generic images: **DOM structure as ground truth**.

If the DOM hasn't changed, pixel differences are just rendering noise, not semantic changes.

## My Solution: VLM-Diff

A two-stage hybrid pipeline:

### Stage 1: Deterministic Detection (No VLM needed)

```typescript
// Pseudo-code
const domChanges = compareDom(beforeDom, afterDom);
const pixelRegions = perceptualDiff(beforeImg, afterImg);

if (domChanges.length === 0) {
  return { changed: false };  // Suppress pixel noise!
}

// Otherwise, fuse DOM + pixel regions
const candidates = fuseDomAndPixelRegions(domChanges, pixelRegions);
```

### Stage 2: VLM Classification (Only for changed regions)

```typescript
for (const region of candidates) {
  const beforeCrop = cropImage(beforeImg, region);
  const afterCrop = cropImage(afterImg, region);
  
  const result = await vlm.classify({
    images: [beforeCrop, afterCrop],
    prompt: "What changed? color/text/position/size/other?"
  });
  
  console.log(result.changeType, result.description);
}
```

**Why cropping?** VLM-SubtleBench (March 2026) showed that side-by-side full images hurt accuracy in 9/10 categories. Cropping focuses the model's attention and **reduces token cost by 68%**.

## Results (39 UI Screenshot Pairs)

| Metric | Naive VLM | Pixel-Only | **VLM-Diff** |
|--------|-----------|------------|--------------|
| Recall | 70-75% | 92% | **92%** ✅ |
| Precision | 30-40% | 85-90% | **88-92%** |
| False Positive Rate | 15-25% | 0% | **0%** ✅ |
| Classification Accuracy | 55-65% | N/A | **75-82%** |
| Avg Input Tokens | ~2500 | 0 | **~800** |

**✅ = Confirmed on real data** (deterministic layer)  
Others = Predicted based on VLM-SubtleBench baselines

## Quick Start

```bash
git clone https://github.com/shidesheng0218/vlm-diff
cd vlm-diff
npm install
npm run demo:quick  # 2-minute demo, no API key needed
```

This runs a simulated demo showing how DOM diff detects changes and suppresses false positives.

## Tech Stack

- **TypeScript + Playwright**: Screenshot capture + DOM serialization
- **pixelmatch**: Perceptual pixel diffing
- **Claude Opus 4 / GPT-4o**: VLM classification

## Architecture Diagram

```
Input: before.png + after.png + DOM snapshots
         ↓
┌─────────────────────────────────┐
│ Stage 1: Deterministic Detection│
│  • DOM diff (structure changes) │
│  • Pixel diff (visual changes)  │
│  • If DOM unchanged → return NO │
│  • Otherwise → fuse regions     │
└─────────────────────────────────┘
         ↓
┌─────────────────────────────────┐
│ Stage 2: VLM Classification     │
│  • Crop changed regions         │
│  • Send to Claude/GPT           │
│  • Get change type + description│
└─────────────────────────────────┘
         ↓
Output: {
  changed: true,
  regions: [
    {
      rect: {x, y, width, height},
      changeType: "color-change",
      description: "Button changed from blue to red",
      confidence: 0.92
    }
  ]
}
```

## What's Next?

I'm deciding between two paths:

1. **Productize**: Build CLI + CI integration (GitHub Action)
2. **Academic**: Expand dataset, publish paper, submit to workshop

**Questions for the community:**

- Would you use this in production?
- What features are missing?
- Anyone want to compare with Percy/Chromatic on real projects?

## Open Source

- GitHub: https://github.com/shidesheng0218/vlm-diff
- License: MIT
- Paper draft included (4 pages, VLM-SubtleBench format)

---

Happy to answer questions! What would make this useful for your projects? 🚀

---

## Related Work

This builds on recent research:

- [VLM-SubtleBench](https://arxiv.org/abs/2603.07888) (March 2026): GPT-5-thinking only achieves 77.8% on subtle visual differences
- [OmniDiff](https://arxiv.org/abs/2503.11093): Fine-tuned specialists outperform zero-shot VLMs by 6×
- [WUICC-bench](https://arxiv.org/abs/2607.01728) (July 2026): First UI regression benchmark

The innovation here is using **DOM structure as ground truth** to suppress false positives — a domain-specific advantage that generic image-diff tools can't leverage.
