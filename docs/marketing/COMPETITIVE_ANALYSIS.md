# VLM-Diff 竞品分析(2026-11 实测更新版)

> 本文取代 v0.6.0 版竞品分析。所有外部情报于 2026-11 通过实时抓取核实(见文末"核实方法与时间")。核心结论:**Percy/Applitools 都在向 AI 靠拢,但没有一家把 DOM 结构当作 diff 引擎的 ground truth——这个位置仍然只有我们占着。**

---

## 一、赛道格局(2026-11 实况)

```
                    差异检测的"真相来源"
                    结构证据(DOM) │  纯像素/视觉
   AI 增强    高  │   [空位]      │  Applitools(AI过滤)
      ↑          │   vlm-diff ←──┤  Percy(AI 在外围)
                 │   (唯一)       │  Chromatic
   传统规则  低  │               │  BackstopJS/Lost Pixel/reg-suit
                 └───────────────┴──────────────
```

**关键判断**:竞品都在"用 AI 过滤像素噪声"或"用 AI 包装工作流",**没有一家把 DOM 结构作为差异检测的 ground truth**。这是结构性差异,不是功能差异——它们的架构里根本没有 DOM 通道。

---

## 二、逐家实测对比

### Percy(BrowserStack)— 最大在位者

| 维度 | 它们 | 我们 |
|---|---|---|
| 真相来源 | 纯像素 diff | **DOM ground truth + 像素兜底** |
| AI 在哪 | 工作流外围("AI Agents" 是 BrowserStack 全家桶菜单,**不在 diff 引擎里**) | **核心不用 AI**(确定性),AI 只在 DOM 看不见的 2.9% 兜底 |
| 误报 | 高(纯像素 AA 噪声) | **0%**(42 无变化对,CI 上界 8.4%) |
| 解释 | "N 个像素变了" | **自然语言 + DOM 原始值证据** |
| 归因 | 无 | **`why` 命令:哪条 CSS 规则赢了、为什么、改哪行** |
| 无障碍 | 有单独的 a11y 产品线(与视觉 diff 分离) | **确定性 a11y 内建**(对比度 + alt/aria 删除) |
| 成本 | $149–899/月 订阅 | **约 $0–5/千次**(97.1% 区域零 token) |
| 多浏览器 | ✅ 云渲染矩阵 | ❌ 仅 Chromium |
| 团队协作 | ✅ dashboard/审批 | ❌ 本地 review 命令 |

**Percy 的真实威胁**:云渲染农场 + 基线管理 + 审批流 + 品牌。**它没有回答"为什么变了"的能力**——diff 输出是像素遮罩,不含原因。

### Applitools — 技术最强的对手

| 维度 | 它们 | 我们 |
|---|---|---|
| AI 态度 | **公开反对 "LLM as comparator"**(怕 flaky),但有 Visual AI 过滤 | 我们同意它们的谨慎——**所以 97% 不用模型** |
| MCP | 有 MCP server,但**只是接它云 Eyes 的桥**(`eyes_setup_project`/`eyes_fetch_visual_results`),diff 仍在云端 | **本地 MCP = diff 引擎本身**,结构化 verdict + 标注图 image block |
| 误报处理 | AI 过滤(黑盒) | DOM 抑制(可证明) |
| 可解释 | 框出区域,无原因 | 原因 + 证据 + CSS 归因 |

**Applitools 是最接近的对手,但它的 AI 是"过滤噪声",我们的结构是"从 DOM 直接读出答案"。** 一个在猜什么不重要,一个在读什么变了。

### Chromatic — Storybook 绑定

| 维度 | 它们 | 我们 |
|---|---|---|
| 目标用户 | Storybook 组件库 | **任意 web 页面**(不限框架/工具链) |
| 检测 | 组件级像素快照 | 页面级 + DOM 结构 |
| 适用面 | 窄(必须 Storybook) | 宽(任何能渲染的页面) |

**Chromatic 是"组件库的视觉回归",我们是"任意页面的视觉验证"。** 不同市场,不是直接竞争。

### 开源像素工具(BackstopJS / Lost Pixel / reg-suit)

| 工具 | 状态(2026-11 实测) | 定位 |
|---|---|---|
| BackstopJS | 活跃(pushed 2026-10,7.2k stars) | 纯像素,高误报,无语义 |
| Lost Pixel | 半停滞(pushed 2026-04,1.7k stars) | 纯像素 |
| reg-suit | 活跃(pushed 2026-11,1.3k stars) | 像素 + 云存储,无 AI |

**这批工具证明了两件事**:① "免费像素 diff"需求真实存在且持续;② 它们全部停留在"有没有变",没有一个能回答"为什么变/该不该担心"。这是我们的生存空间。

---

## 三、我们独有、它们结构上做不出的

1. **DOM 作为 ground truth** —— 97.1% 区域的答案可证明正确(来自计算样式,不是模型猜的)。它们没有 DOM 通道。
2. **零 token 确定性描述** —— "背景色蓝→红,证据 rgb(37,99,235)→rgb(220,38,38)"。成本结构上它们做不到(每次对比都烧云资源/订阅)。
3. **CSS 归因(`why`)** —— 哪条规则赢了、为什么、改哪行。**这是诊断,不是报告。**
4. **确定性无障碍** —— alt/aria 删除(像素零变化)只有我们能抓;WCAG 对比度纯数学。
5. **agent 原生闭环** —— MCP 返回结构化 verdict + 标注图,agent 能"看见"并直接改代码。它们的 MCP 是云服务的桥。

## 四、我们诚实输掉的

1. **多浏览器矩阵** —— Percy/Applitools 云渲染 Firefox/Safari/WebKit;我们仅 Chromium。这是基础设施差距,短期补不上。
2. **团队协作面** —— 无 dashboard、无云审批、无历史趋势云存储。
3. **规模与托管** —— 无 TB 级截图库、无托管服务。
4. **真实页面验证规模** —— 我们的证据多在合成 fixture + 24 个对局场景;Percy 有十年真实流量。
5. **生态成熟度** —— npm 月下载 233、GitHub 0 star。它们的品牌即护城河。

---

## 五、战略结论

**不做**:和 Percy 正面刚 dashboard、抢 Storybook 用户、做泛 QA 平台、追多浏览器云渲染。

**要做**:把"agent 时代的视觉验证层"做深——
- **对 agent**:`snapshot_url → diff_screenshots → why` 是"改完 UI 看一眼对不对、不对就改哪行"的完整闭环;
- **对 CI**:Action 是"PR 自动带严重度评论"的门禁;
- **对人**:evidence + CSS 归因 + 成本日志让它成为"敢信"的结果。

**一句话**:Percy 卖"人看 dashboard 管理回归",Applitools 卖"AI 帮你过滤噪声",**我们卖"agent 和 CI 自动验证回归、且每个结论都带可核查的证据"**——前两者的 AI 在过滤噪声,我们的 AI 只处理 DOM 看不见的那 2.9%。

---

## 核实方法与时间(2026-11)

- Percy/BrowserStack:`browserstack.com/percy`、`/percy/ai-agents`、定价页实时抓取。确认 "AI Agents" 是 BrowserStack 全家桶菜单项,**Percy diff 引擎本身无 DOM/AI 结构化检测**。
- Applitools:官方博客 + MCP server 文档。确认其 MCP 是云 Eyes 的桥接,diff 在云端。
- Chromatic:定价页确认 Storybook 绑定 + 按 snapshot 计费。
- 开源工具:GitHub API 实测 pushed 时间戳 + star 数(BackstopJS 7.2k / Lost Pixel 1.7k / reg-suit 1.3k)。
- 我方数据:`results/router-replay.json`(97.1% 确定性)、`results/percy-bakeoff.json`(24/24 真实页面)、`npm`/`github` 分发数据实时拉取。
