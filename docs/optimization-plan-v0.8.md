# vlm-diff 优化任务书 v0.8.0 → v0.9.0

> 交给编码模型的执行文档。所有缺陷均来自一次只读审计（6 个子系统并行）+ 人工复核，带 `file:line`。
> 仓库：`/Users/eastbuy/Documents/Claude code项目/多模态强化工具`
> 基线：`v0.7.0`（master `ca87182`，工作区干净，npm 上 `vlm-diff@0.7.0` 已发布）

---

## 0. 硬约束（先读这一节）

**必须遵守：**
- 只允许离线验证：`npm run build`、`npx tsc --noEmit`、`npm test`（= `tsc && node --test dist/**/*.test.js`）
- 不引入新运行时依赖（`zod` / `pngjs` / `pixelmatch` / `playwright` / `openai` / `@anthropic-ai/sdk` / `@modelcontextprotocol/sdk` 已存在）
- 不改动任何现有测试的既有断言（新增测试另起 `test(...)` case）
- 每个任务在 commit message 里回填本文的任务号（如 `fix(P0-3)`），便于回归对照

**禁止：**
- 跑任何付费 API 命令：`npm run eval:run`、`eval:mvp`、`judge:mvp`、`judge:calibrate`、`compare:models`、`eval:specialist`
- `npm run replay:*`（会重跑 dataset 与路由回放，属于验收动作，由人来做）
- `npm publish`、`git push`、`gh release`、Marketplace 相关操作
- 顺手重构无关代码；每个任务只改它需要改的文件

**交付形态：**每个任务 = 代码改动 + 新增单测 + 一句话说明"改前行为 / 改后行为"。

---

## 1. 为什么做这一轮（背景）

上一轮把数据集从 39 对扩到 193 对、把四臂评测跑通、把 CLI/MCP/SDK 的产品壳搭起来之后，**度量层和成本层的正确性没有跟上功能扩张**。审计发现的不是"缺功能"，而是**现有数字不可信**：

- 报告里的 `precision` 从来不含假阳性，所以它不随检测质量变化（`metrics.ts:81`）——这个指标目前没有区分力。
- 多区域分类已经实现，但评分仍然只取最大区域，`table-element-add` 检出 8 个区域只考了 1 个（`baselines.ts:236`）。
- 纯确定性对（没有 VLM 调用）被 `[].every()` 判成 `cached: true`，污染命中计数与省钱估算（`baselines.ts:363`）。
- 缓存键不含 prompt 版本，改了系统提示词后最长 7 天会持续复用旧结论（`cache/key.ts:14-27`）——A/B 实验会得出"改动无效"的假结论。
- 预算闸门对未定价模型恒返回 $0，熔断在最需要它的场景（第三方便宜模型）下失效（`pricing.ts:41-49`）。
- README 把"193 对离线回放"和"真实 API 调用"写进同一句话（`README.md:145`），这是对外最容易被质疑的一条。

**这一轮的目标不是加功能，是让已有结论站得住。** 完成后：指标定义正确、分层可查、成本口径与实际计费一致、缓存不会给出过期结论、文档数字与代码一致。

---

## 2. 任务清单

### P0 — 正确性（必须先做，全部离线可验证）

#### P0-1 修正 `precision` 定义，补真正的假阳性率

**问题**：`src/eval/metrics.ts:81` 只在 `r.predictedChanged === true` 且 ground truth 也是"变更"时递增分母，被判变更的 no-change 对（真 FP）根本不进分母。所以 `precision` 恒为 `TP/(TP+FN-漏检)`，与检测质量无关。实测所有报告 `precision = 0.8235`，raw 臂与 tiered 臂完全相同。

**改法**：
- 新增 `detectionPrecision = TP / (TP + FP)`，其中 `FP = predictedChanged ∧ pair.kind === "none"`
- 现有 `precision` 重命名为 `localizationHitRate`（语义：检测到的区域是否落在 ground truth 框内，IoU ≥ 0.3），更新 `src/eval/metrics.ts:29,52` 的注释
- `MetricsSummary` 两个字段都保留，消费方（`scripts/stats-report.ts`、`scripts/compare-models.ts:94`）同步更新字段名

**验收**：新增单测——构造 3 个 no-change 对其中 1 个误报，断言 `detectionPrecision === 0.5`（若 TP=1, FP=1），且 `localizationHitRate` 仍按原语义计算。

**工作量**：S（~40 行 + 2 个测试）

---

#### P0-2 多区域评分：区域级正确率

**问题**：`src/eval/baselines.ts:236`（`classifications[0]` 作为 pair 级类型）与 `src/eval/metrics.ts:88`（只比这一个值）。实测 `table-element-add` 检出 8 个区域（1 个 add + 7 个兄弟 size-change），只考了 1 个；`card-list-style-change-radius` 6 个区域同样。`metrics.ts` 完全不读 `r.classifications` 做逐区域评分。

**改法**：
- `MetricsSummary` 新增两个指标：
  - `regionTypeRecall`：对每个已检出区域，`changeType === pair.kind` 的占比（分母 = 所有区域数）
  - `pairContainsCorrectType`：pair 级"至少有一个区域的类型正确"的占比（这个比 `changeTypeAccuracy` 更能反映"用户能否从报告里看到正确答案"）
- 保留 `changeTypeAccuracy`（最大区域口径）不动，三个数并列输出，注释写明各自口径
- `perPairDetail`（`run-mvp.ts:282`）已经存了全部 `classifications`，无需改数据结构

**验收**：新增单测——构造一个 pair 有 3 个区域、类型分别为 `[spatial-shift, size-change, size-change]`、ground truth 为 `size-change`，断言 `regionTypeRecall === 2/3`、`pairContainsCorrectType === 1`、`changeTypeAccuracy === 0`（最大区域判错）。

**工作量**：S（~50 行 + 3 个测试）

---

#### P0-3 修 `[].every()` 导致的缓存误记

**问题**：`src/eval/baselines.ts:363` 用 `vlmClassifications.every((c) => c.cached === true)` 判定 pair 级缓存状态。纯确定性对（无 VLM 调用）的 `vlmClassifications` 为空数组，`[].every()` 返回 `true`，于是这些对被记成 `cached: true`，污染 `computeReportSummary`（`src/report/generate.ts:50-51`）的 hits 计数与省钱估算。

**改法**：
- 空数组时记 `cached: undefined`（语义：本对没有缓存概念），显式写 `vlmClassifications.length === 0 ? undefined : vlmClassifications.every(...)`
- 检查 `src/eval/baselines.ts:249` 是否有同样问题（那里是分类结果，非空，但一并确认）

**验收**：新增单测——纯确定性 pair（mock 掉 VLM 调用）断言 `cached === undefined`；混合命中（3 个区域中 1 个 miss）断言 `cached === false`。

**工作量**：S（~10 行 + 2 个测试）

---

#### P0-4 修正 element-remove 的 before 裁剪窗

**问题**：删除元素后，区域 rect 被替换成"滑进空位的兄弟元素"的 after-rect（`src/detect/regions.ts:231` 把原 rect 存进 `counterpartRect`），但 `src/eval/baselines.ts:152-153` 的 `cropRegion(before, region)` 仍用同一个 after-rect 去裁 before 帧。**结果是：模型看到的 before 图是"替换者在 before 帧的样子"，而不是被删元素本身——视觉证据与提示词互相矛盾。** 目前唯一的防线是提示词文本（`vlm-classify.ts:101-106` 已经会描述 `counterpartRect`），属于治标。

这解释了为什么 `navbar-element-remove` 在两轮 MVP 中都被判成 `spatial-shift`：模型看到的是"某个元素在 before 帧里位于别处"，最合理的解释就是位移。

**改法**：
- `cropRegion` 增加可选参数或新函数 `cropRegionAt(png, rect, padding)`，让 before 帧用 `region.counterpartRect ?? region` 裁剪，after 帧用 `region` 裁剪
- `classifyRegion` / `classifyRegionCached` 的调用点（`baselines.ts:152-155`）同步
- 缓存键已经包含 hint（`cache/key.ts:29`），hint 里含 `counterpartRect`，所以 key 会自然区分，无需额外改动

**验收**：
- 新增单测：removed 区域的 before/after 裁剪坐标必须不同（当前相同）——用 `solidPng` 造两帧、在 before 帧的目标位置画一个可识别的色块，断言 before crop 的像素来自 `counterpartRect` 位置
- 断言提示词仍含 `REMOVED`（回归 `vlm-classify.test.ts:119` 的既有断言）
- 断言缓存键因裁剪像素变化而变化

**工作量**：S/M（~40 行 + 3 个测试）

---

#### P0-5 缓存键纳入 prompt 版本

**问题**：`src/cache/key.ts:14-27` 的键只含 `beforeCrop ‖ afterCrop ‖ promptContext(hint) ‖ modelContext`。`SYSTEM_PROMPT`（`vlm-classify.ts:64-67`）、`hintSentence` 的补充句（`vlm-classify.ts:95-130`）、`parseClassification` 的归一化逻辑（`vlm-classify.ts:194-209`）**都不进键**。TTL 7 天（`store.ts:19`）意味着改了 prompt 后最长 7 天持续复用旧结论。注释自称"identical prompt"（`key.ts:1-3`），但 prompt 并未被哈希。

**改法**：
- 新增 `PROMPT_VERSION` 常量（与 `CACHE_KEY_VERSION` 并列，`key.ts:14`），并在 `computeCacheKey` 里纳入
- 更稳的做法：把 `SYSTEM_PROMPT` 内容做进 hash（但会导致每次改一个标点就全量失效，按你的判断二选一；推荐显式版本号 + 注释要求改 prompt 时 bump）
- 缓存条目增加 `promptVersion` 字段供审计（`cache/store.ts:9-12` 的 entry 类型）

**验收**：
- `key.test.ts` 新增："prompt 版本变化 → key 变化"
- `store.test.ts` 新增："旧版本条目被当 miss"（或至少断言 entry 里记了版本）

**工作量**：S（~20 行 + 2 个测试）

---

### P1 — 成本与路由正确性（离线可验证）

#### P1-1 CLI 接上 cheap-tier 路由

**问题**：`createProvider` 的 `tier === "cheap"` 只有 `src/eval/run.ts:33` 和 `run-mvp.ts:131` 两处传。`tryCreateProvider`（`src/cli/main.ts:124`）构造对象只有 `provider`/`model`，**完全不传 tier**；`src/core/diff.ts:22-23` 接收的是已构造好的 provider，自己无从设置。结果：`VLM_DIFF_CLASSIFY_MODEL` 这个 README 承诺的省钱开关（`README.md:325`）对 CLI 完全无效，CLI 的高频逐区域分类永远跑主模型。

**改法**：
- `src/cli/main.ts:124` 的 `createProvider` 调用传 `tier: "cheap"`（CLI 的定位就是高频调用，正是该路由的目标场景）
- 确认 `factory.ts:66-72` 的 opt-in 语义不变：只有 `VLM_DIFF_CLASSIFY_MODEL` 显式设置时才切模型，否则用 default（这条已有测试 `factory-routing.test.ts:4-22` 固化，不要改）

**验收**：新增单测——设 `VLM_DIFF_CLASSIFY_MODEL=claude-haiku-4.5` 后调用 CLI 的 provider 构造路径，断言拿到的是 cheap 模型；不设时断言是 default。

**工作量**：S（~10 行 + 1 个测试）

---

#### P1-2 成本口径按实际模型计价

**问题**：`src/provider/instrumented.ts:23-24` 记录的 `model` 是 `inner.model`（正确），但报告层 `src/report/generate.ts:58,60,108` **无条件**用主 provider 的模型算钱（`estimateCostUsd(provider.model, ...)`，provider 来自 `run.ts:32`）。于是一旦用户设了 `VLM_DIFF_CLASSIFY_MODEL=claude-haiku-4.5`（$0.8/$4），实际分类跑 Haiku，报告却按 Sonnet（$3/$15）计价——**成本被高估约 3.75 倍**，而预算闸门用的是正确的 per-wrapper model，两者口径打架。

**改法**：
- 让 `computeReportSummary` 消费每个区域实际的 `usage` + 模型身份，而不是重新按 `provider.model` 估算
- 最小改动路径：`BaselineResult` 的每个 classification 已经带 `usage`，但没带模型名；在 `RegionClassification` 加 `model: string`（由 `classifyRegion` 从 `provider.model` 填），报告层按区域累加
- 或者更省事：报告层直接读 `.cache/cost-log.jsonl` 的 `costUsd` 求和（`src/cost/log.ts` 已有全量记录），与闸门口径天然一致——按你的判断选一条，但要保证**报告成本与预算闸门用同一个来源**

**验收**：新增单测——注入一个声称自己是 cheap 模型的 stub provider，断言 summary 用的是 cheap 模型价目而非 primary 的。

**工作量**：M（~60 行 + 2 个测试）

---

#### P1-3 预算闸门：未知模型兜底价 + 并发预留

**问题**：
1. `src/cost/pricing.ts:41-49` 对不在表里的模型返回 $0 并只告警一次。而预设表里恰好有未定价模型：`dashscope.cheapModel = "qwen3.8-flash"` 不在 `PRICING_TABLE`（表里只有 `qwen3.8-max`，`pricing.ts:23`），`opencode` 常指向 `glm-5.2`/`minimax-m3`（`factory.ts:34`）同样没价。用这些模型时 `spentUsd` 恒为 0，`VLM_DIFF_BUDGET_USD` **永不触发**。
2. `spentUsd` 只在调用成功后累加（`instrumented.ts:50-52`），在途并发调用全部已通过检查，最坏超支 N × 单次成本。

**改法**：
- 未知模型用可配置的非零兜底价（如 `VLM_DIFF_DEFAULT_PRICE`，或取表内最贵条目），至少让闸门有量纲
- 调用前按 token 估算上限做**预留**，成功后冲正——堵住并发超支
- 顺手补 `PRICING_TABLE` 里缺失的预设模型（`qwen3.8-flash`、`glm-5.2`、`minimax-m3`），若定价未知则用保守值并标注 `estimate: true`

**验收**：`instrumented.test.ts` 已有"负预算时 `inner.calls.length === 0`"的测试模式（`:35-47`），新增：未知模型 + 有限预算 → 断言闸门在若干次调用后触发。

**工作量**：S/M（~50 行 + 2 个测试）

---

### P2 — 文档与声称同步（纯文本，但决定对外可信度）

#### P2-1 拆开"离线回放"与"真实 API 调用"

**问题**：`README.md:145` 写 "**193-pair benchmark** ... four arms, real API calls. Detection: 151/151 changed pairs, 0/42 false positives"。实际：193 对只跑离线回放（`npm run replay:router`，**0 API 调用**，juejin 文章自己写得很清楚）；真实 API 四臂只有 36 对（`results/mvp-report.json`，$0.1781）。把离线确定性检测的成绩放进 "real API calls" 句子里，是对外最容易被抓住的一条。

**改法**：拆成两句——
- 检测层：193 对离线回放，0 API 调用，151/151、0/42（95% CI 上界 8.4%）
- 四臂对照：36 对 + 51 对真实 API 调用（分别标注日期与模型）

**验收**：人工核对 README:145 附近不再有歧义；`results/router-replay.json` 与 `results/mvp-report*.json` 的数字能对上。

**工作量**：S（~10 行）

---

#### P2-2 README 加全量口径的升级率

**问题**：`README.md:150-152` 的 tiered 行写 `escalation: 1.3%`，那是 36 对最小臂的数；**全量 193 对的真实升级率是 2.87%（19/662 区域）**（`results/router-replay.json:regionEscalationRate`）。文档没有任何一行给出全量口径，读者会把 1.3% 误当全集值。另外"97%" 与 "96.8%"（`COMPETITIVE_ANALYSIS.md:45`）并存，实为同一测量的两个快照。

**改法**：加一行"全量 193 对离线升级率 2.9%（19 区域）"，并把 97% 标注来源（`results/router-replay.json`，643/662）；统一 96.8% → 97%。

**工作量**：S（~5 行）

---

#### P2-3 同步过时数字（测试数 / Action tag / 变异表）

具体清单（每条都要改）：

| 位置 | 现状 | 正确值 |
|---|---|---|
| `README.md:310` | `212 unit tests` | **217**（或删掉硬编码数字） |
| `README.md:295`、`QUICKSTART.md:102` | `uses: ...@v0.6.0` | `@v0.7.0` |
| `README.md:392` | `version={0.6.0}` | `0.7.0` |
| `README.md:322` | cost-log 字段 `tokens` | `inputTokens, outputTokens`（实现见 `instrumented.ts:55-63`） |
| `README.md:342-353` | 变异表合计 197 ≠ 193；`element add/remove 18` | 按 kind 重列：spatial 31 / color 31 / size 25 / text 23 / element-add **6** / element-remove **12** / style 22 / other 1 / none 42 = 193 |
| `README.md:335,145` | `31 mutation types` | 以 `data/dataset.json` 去重后的 mutationId 数为准 |
| `docs/publish.md:3,21` | `0.5.2` / `v0.5.1` | 改成 `vX.Y.Z` 占位（别写死版本号） |

**验收**：新增 `npm run docs:assert`（见 P2-4）能自动抓出这些不一致。

**工作量**：S（~30 行文本）

---

#### P2-4 加文档数字门禁（防止再次漂移）

**问题**：B-1/B-2/P2-3 这类漂移**已经重复发生两轮**（v0.5.2→v0.6、v0.6→v0.7）。README 里的测试数、Action tag、数据集规模每次发版都烂一次。

**改法**：新增 `scripts/docs-assert.ts` + `npm run docs:assert`：
- 读 `data/dataset.json` 数对数，与 README 里的正则匹配比对
- 读 `package.json` 版本，与 README/QUICKSTART 里的 Action tag、citation 比对
- 数 `src/**/*.test.ts` 的 `test(` 调用，与 README 声明比对
- 任一处不一致 → 打印差异 + `exit 1`
- 挂进 `.github/workflows/ci.yml` 的 test job

**验收**：故意改错 README 里一个数字，`npm run docs:assert` 必须 exit 1。

**工作量**：M（~120 行 + 1 个测试）

---

#### P2-5 修 `media-image-src-swap` 的三处矛盾

**问题**（唯一一处"文档声称与代码/数据集直接冲突"）：
- `README.md:354` 说 "Since v0.6, attribute changes (src/href/alt/aria) are captured, which **moved the image-swap pair from the escalation path into the deterministic tier**"
- `README.md:197` 说该对"唯一失分…**VLM 写成**蓝→红"，即它在 VLM 层被分类
- 实际：`data/dataset.json` 该对 `kind: "other"`，`description` 仍写 "src is not a captured DOM field"；`src/snapshot/capture.ts:24` 的白名单**确实含 `src`**，`src/detect/dom-diff.ts:106` 也对比 `attr:src`

**改法**：
1. 先跑 `npm run replay:router`（这一步由人执行）确认该对当前是否仍进 `escalatedPairs`
2. 若已走确定性路径：改 `src/dataset/mutations.ts:454` 的 description 与 kind，同步 README:197 的旧叙述（那叙述来自 v0.2 报告）
3. 若仍走 VLM：改 `README.md:354` 的声称
4. 无论哪条，明确"pixel-only"是**跨 kind 的构造属性**（5 个 mutationId），不是 kind 名——`README.md:350` 把它列成 kind 是错的

**验收**：README:197 / :350 / :354 三处口径一致，且与 `data/dataset.json` 一致。

**工作量**：S/M（~20 行，含一次回放验证）

---

#### P2-6 更新对外的三篇营销文

**问题**：`docs/marketing/hn-post.md:5,31,37`、`ACTION_PLAN.md:70,81,86`、`devto-article.md:4,63,65,69` 全部是 **v0.1 数字**："92% recall, 0% false positives"、"39 UI screenshot pairs"、"75-82% accuracy predicted"。现实是 193 对 / 100% 召回 / 90.2% 降本。`docs/juejin-article.md:1,26,103` 停在 145 对 / 611 区域 / "99.3%"（现为 662 区域 / 643 确定性 / 97.1%）。

**改法**（二选一，推荐 L 路径）：
- **S 路径**：每篇文首加横幅 `> 数据快照：v0.1（39 对）— 最新数据见 README`
- **L 路径**：重写到当前数字

**理由**：这几篇是外部读者的第一落点，错的又是标题里的数字。README 改得再准，落地页数字不对，可信度一样崩。

**工作量**：S（加横幅）或 L（重写正文）

---

### P3 — 稳健性与工程质量（可选，按剩余预算）

| 任务 | 问题 | 改法 | 工作量 |
|---|---|---|---|
| P3-1 分类并发受控 | `baselines.ts:140` 无界 `Promise.all`，最多 8 区域同时发；`pool.ts` 只被 judge 用（`run.ts:83`） | 换成已有的 `mapWithConcurrency`（`src/util/pool.ts`），cap 默认 4（与 judge 对齐），env 可调 | S |
| P3-2 裁剪解码复用 | `cropRegion` 每裁一次整帧 `PNG.sync.read`（`vlm-classify.ts:50-51`），每对最多 8 区域 × 2 帧 = 16 次 | 每对帧只解码一次，crop 接受已解码帧 | S |
| P3-3 缓存写原子化 + in-flight 去重 | `store.ts:44-47` 直接 `writeFile`；`get` 只对 ENOENT 兜底，JSON.parse 失败会抛错（`:38-41`）；同 key 并发会各打一次 API | temp+rename；parse 失败降级为 miss；`classifyRegionCached` 加 per-key in-flight map | S/M |
| P3-4 JSON 提取字符串感知 | `util/json.ts:15-31` 的大括号扫描不识别字符串字面量，描述里出现 `}` 会截断 → 降级 `other` | 改为状态机识别 `"` 与 `\"` | S |
| P3-5 temperature 与运行指纹 | provider 层零 `temperature`（`anthropic.ts`/`openai.ts`），两次运行不可复现；报告无缓存状态标记，热缓存跑出的 token 数接近 0 | 显式传 `temperature: 0`（env 可覆盖）；报告顶层加 `reproducibility: {temperature, cacheEnabled, cacheKeyVersion, gitSha}` | S |
| P3-6 `npm test` 空套件假绿 | `package.json:12` 的 `node --test dist/**/*.test.js` 在 dist 无测试时 exit 0；`prepack.mjs:15` 正会删掉 dist 下的 `.test.js` | glob 加引号；用例数为 0 时 fail | S |
| P3-7 统计多重比较校正 | `scripts/stats-report.ts:147-150` 一次跑 4 组 McNemar，`:155` 直接用 `p < 0.05` 判定，无 Bonferroni/FDR | 加 Holm-Bonferroni；配对检验返回 `skippedIds` 并打印实际用了几对 | S |

---

## 3. 建议执行顺序与分批

1. **第一批（P0 全部）**：5 个任务，全部离线可验证，改完重跑 `npm test`。这批决定"现有数字可不可信"。
2. **第二批（P1 全部）**：3 个任务，成本与路由口径。
3. **第三批（P2-1 ~ P2-4）**：文档同步 + 门禁脚本。P2-4 是关键——没有它，下一版还会烂。
4. **第四批（P2-5 / P2-6）**：需要一次 `replay:router` 验证 + 人工判断的文档任务。
5. **第五批（P3 按需）**：稳健性。P3-1/P3-3 优先。

---

## 4. 全局验收标准

**代码：**
- `npm run build` 通过，无 TS 错误
- `npm test` 全绿，且用例数 **只增不减**（当前 217；每个任务都要加测试）
- 不引入新运行时依赖
- 现有 31 个测试文件的既有断言未被修改

**行为：**
- P0-3 后：纯确定性对不再被记为 `cached: true`
- P0-4 后：element-remove 的 before/after 裁剪坐标不同，提示词与图像一致
- P0-5 后：改 `SYSTEM_PROMPT` 必然导致缓存 miss（可用单测证明）
- P1-1 后：设 `VLM_DIFF_CLASSIFY_MODEL` 对 CLI 生效
- P1-3 后：未知模型 + 有限预算时闸门真的会触发

**文档：**
- `npm run docs:assert` 通过（P2-4 完成后）
- README:145 不再把离线回放与 API 调用混在一句
- README 的测试数、Action tag、变异表、数据集规模与代码一致

---

## 5. 交付时要说明的事

每个任务提交时，在 commit message 里写清：
- 任务号（如 `fix(P0-3)`）
- **改前行为 / 改后行为**（一句话）
- 新增了哪些测试、断言了什么

最后给一份汇总：哪些任务完成、哪些跳过及原因、`npm test` 的实际用例数、以及任何你做判断时改变的做法（比如 P1-2 选了"读 cost-log"而非"给区域加 model 字段"——说明为什么）。

---

## 附：不要做的事（重复强调）

- 不要为了让指标好看而调整评测逻辑——这一轮的目标是**让数字正确**，不是让数字变好。如果修完 P0-1 后 `detectionPrecision` 比原来的 `precision` 低，那是修正，不是回退。
- 不要顺手重构 `src/eval/*` 的数据结构。`perPairDetail` 已经带了 `classifications` 全量信息，P0-2 不需要新增字段。
- 不要改 `data/` 下的任何东西（193 对数据集与 labels 是已有资产，重新生成会打断与其他报告的可比性）。
- 不要动 `factory.ts:66-72` 的 opt-in 语义（P1-1 只是让 CLI 接上它，不是改它）。
