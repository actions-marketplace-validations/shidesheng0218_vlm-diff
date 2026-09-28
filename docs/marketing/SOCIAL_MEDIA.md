# X/Twitter 推广方案（v0.7 版，2026-09）

> 取代旧版文案（旧版用的 v0.1 数字：92% 召回、68% 降本、demo:quick CTA——全部过时）。

## 定位主线（选一个主打，其余作跟进）

**主打钩子（数据最硬）**：弱模型全图检测漏掉 100% 的变化，同一模型过我们的管线 100% 召回。
备选钩子：97% 区域零 token · 每条描述带可核查证据 · agent 能看见自己改的 UI · $0.18 跑完整个评测。

## 发布节奏

| 时间（北京） | 对应美国 | 内容 |
|---|---|---|
| 周二–周四 22:00–24:00 | 美东上午 | 主推帖串（thread） |
| D+2 | 同上 | 基准深挖帖（弱模型对照表图） |
| D+5 | 同上 | 无障碍角度帖（WCAG 对比度，差异化） |
| D+8 | 同上 | 成本帖（token 经济学） |
| D+12 | 同上 | agent/MCP 演示帖 |

周二到周四效果最好；避开周一上午和周末。

## 主推帖串（英文，可直接复制）

**Tweet 1（钩子 + GIF）**：
```
A frontier vision model missed 100% of subtle UI changes when shown full screenshots.

Same model, piped through a DOM-grounded pipeline: 100% recall, 0% false positives.

vlm-diff — the visual verifier for agentic coding workflows. Open source 🧵
```
配图：`docs/pipeline-demo.gif`

**Tweet 2（架构）**：
```
The trick: don't ask the VLM to *find* changes at all.

DOM diff + pixel diff localize them deterministically. 97% of regions get template descriptions at zero tokens — the VLM only sees small crops, and only when the DOM can't explain the change.
```

**Tweet 3（证据）**：
```
Every description carries the values it was derived from:

"backgroundColor: rgb(37,99,235) → rgb(220,38,38)"

No vibes. Checkable evidence. Even WCAG contrast drops are caught deterministically (5.2:1 → 2.9:1, below AA).
```
配图：`docs/report-example.png`

**Tweet 4（agent 角度）**：
```
Coding agents can now verify their own UI edits: snapshot → diff → annotated frame + typed verdict over MCP.

npm i -g vlm-diff

Playwright SDK is two lines: checkAgainstBaseline(page, "home")
```

**Tweet 5（收尾 CTA）**：
```
CLI + MCP server + GitHub Action (PRs get a severity table + annotated report artifact). Percy-style approve/review loop built in.

Every number in the repo has a CI + a blind-judge study behind it.

⭐ https://github.com/shidesheng0218/vlm-diff
📄 paper draft: paper/vlm-diff.tex
```

## 跟进帖（D+2 起）

**D+2 基准帖**：贴弱模型对照表（raw 0% vs tiered 91.2%），文案："When the VLM is weak, architecture carries the product. raw full-image: 0% recall. Tiered pipeline: 100% recall, 91% type accuracy. Same model."

**D+5 无障碍帖**："Visual regression tools compare pixels. We also compute what the change does to a screen reader: WCAG contrast math + alt/aria removal detection, deterministic, zero tokens."

**D+8 成本帖**："What does a UI diff cost? DOM-explained: $0. Full eval on 51 pairs: $1.36. Every call logged to a cost ledger (fn, model, tokens, $). Budget gate included."

**D+12 agent 帖**：录一段 Claude Code 调用 MCP 工具验证 UI 改动的 30 秒录屏（最有转化潜力的一帖，agent 圈最吃这个）。

## 视觉素材清单（仓库现有）

| 素材 | 用途 | 状态 |
|---|---|---|
| `docs/pipeline-demo.gif` | 主推帖 1 | ✅ 可直接用 |
| `docs/report-example.png` | 证据帖 3 | ✅ 可直接用 |
| `docs/cover.png` | ❌ 勿用 | 数字过时（97%/95%/-87%、Claude Opus/GPT-5） |
| `docs/xhs-*.png` | 中文平台用，X 不合适 | 中文小红书素材 |

录屏（D+12 用）需要现录：Claude Code 里跑一遍 snapshot→diff 流程，30 秒以内。

## 个人资料与承接

- 置顶推：主推帖串
- 简介加 GitHub 链接
- 确保 repo 首页 README 就是门面（已改版）
- 同步动作：GitHub Marketplace 勾选（`docs/publish.md` 有步骤）让 X 流量落地到 Action 安装

## 互动策略

- 每条评论都回
- 不主动 @ 大号求转发（掉价）；如被大号转了再感谢互动
- 标签克制：`#buildinpublic` 足够，别堆标签
- 有人提竞品，正面回应给差异（DOM ground truth + agent 原生 + 成本），不贬低

## 衡量指标（每周看一次）

```bash
curl -s "https://api.npmjs.org/downloads/point/last-week/vlm-diff"   # npm 下载
gh api repos/shidesheng0218/vlm-diff/traffic/views                   # 仓库浏览
gh api repos/shidesheng0218/vlm-diff --jq .stargazers_count          # star 数
```

健康的首两周参考线：npm 周下载破百、star 破 20、有 1-2 条来自陌生人的 issue/评论。达不到就调整钩子重发，而不是加量。
