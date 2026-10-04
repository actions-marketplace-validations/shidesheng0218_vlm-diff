# Quick Start

Get from zero to a working visual-regression check in a few minutes. Two ways to use vlm-diff: ad-hoc on any two screenshots, or as a Percy-style baseline workflow in your project.

## Prerequisites

- **Node.js ≥ 20**
- (optional, only for VLM-escalated pixel-only changes) an API key: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `MOONSHOT_API_KEY`, `DASHSCOPE_API_KEY`, or `OPENCODE_API_KEY` — in the environment or a `.env` file at the project root. Most DOM-observable changes need **no key at all** (deterministic tier).

## Install & build

```bash
git clone https://github.com/shidesheng0218/vlm-diff.git
cd vlm-diff
npm install
npm run build
```

## Option A — diff any two screenshots

### 1. Capture the before/after states

```bash
node dist/cli/main.js snapshot http://localhost:3000 --out-dom before.dom.json --out-png before.png
# …apply your change…
node dist/cli/main.js snapshot http://localhost:3000 --out-dom after.dom.json --out-png after.png
```

### 2. Diff them

```bash
node dist/cli/main.js diff before.png after.png \
  --dom-before before.dom.json --dom-after after.dom.json \
  --report report.html
```

Sample output:

```
⚠️  CHANGE DETECTED
   mode: DOM + pixel (tiered) · pixel delta: 1.73% (8281px)
   summary: Element background color changed from blue (rgb(37, 99, 235)) to red (rgb(220, 38, 38))
   type: color-change
   severity: cosmetic
   1. [dom+pixel → deterministic] (108,134 101×31) color-change
      Element background color changed from blue to red
```

Open `report.html` to see before/after with the changed regions boxed and numbered.

**Exit codes**: `0` no change · `1` change detected · `2` error · `3` change detected but needs a VLM key to finish classifying (wire this into CI to distinguish "broke" from "needs config").

## Option B — baseline workflow (recommended for real projects)

```bash
node dist/cli/main.js init http://localhost:3000/   # creates .vlm-diff/config.json
# edit .vlm-diff/config.json to list every page you want watched
vlm-diff baseline                       # capture the golden state
# …later, on any change…
vlm-diff check                          # diff every page vs baseline
vlm-diff review                         # approve intentional changes per page
vlm-diff trends                         # change frequency + flaky-page detection
```

`check` prints one line per page with the change type + severity, and exits `0`/`1`/`3` for CI gating.

Two knobs worth knowing: `"ignore": ["#ad-slot", "[data-timestamp]"]` in `.vlm-diff/config.json` masks dynamic content (ads, timestamps) so it never false-alarms; per-page `actions` (`click`/`hover`/`scrollY`/`waitMs`) capture interactive states, and a `viewports` array adds a responsive matrix.

### Inside existing Playwright tests

```ts
import { capturePage, checkAgainstBaseline } from "vlm-diff/playwright";

const before = await capturePage(page);           // screenshot + DOM snapshot in one call
const verdict = await checkAgainstBaseline(page, "home");
```

## Run the offline demo (no key, no server)

```bash
npm run demo:quick      # real algorithm on synthetic in-memory inputs
npm run demo:generate   # render 3 demo pairs with Playwright
npm run demo:detect     # run deterministic detection on them
```

## Use it from a coding agent (MCP)

```bash
claude mcp add vlm-diff -- node /path/to/vlm-diff/dist/mcp/server.js
```

Two tools become available: `snapshot_url` (capture DOM + screenshot of a URL) and `diff_screenshots` (the full tiered diff). See the README's MCP section.

## Common issues

**"No API key found"** — expected for DOM-only changes (they're described deterministically for free). It's only a problem if a change is pixel-only (canvas repaint / image swap) and you want it classified; then set one of the keys above in `.env` and re-run (exit code 3 tells you this happened).

**`snapshot` can't find Chromium** — run `npx playwright install chromium` once.

## Next steps

- **Gate PRs in CI**: add the composite action (`uses: shidesheng0218/vlm-diff@v0.7.0`) after committing `.vlm-diff/baseline/` — see the GitHub Action section in [README.md](README.md)
- **Evaluations & replication workflow** (datasets, the four-arm benchmark, stats): see [README.md](README.md)
- **Full CLI reference**: `node dist/cli/main.js --help`
- **Report issues**: https://github.com/shidesheng0218/vlm-diff/issues
