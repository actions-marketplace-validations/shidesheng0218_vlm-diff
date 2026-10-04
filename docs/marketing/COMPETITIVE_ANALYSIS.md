# VLM-Diff 竞品深度对比分析（v0.6.0 实况版）

> 本文取代 2026-08 的旧版（当时项目还是无 CLI 的研究原型）。以下全部基于 v0.5.2/v0.6.0 的真实能力：npm 已发布、MCP 出图像、GitHub Action 已上架可用、属性感知与无障碍层已落地。

## 一、赛道格局：三类玩家 + 一个空位

```
                     确定性/可验证
                      高 ↑        │
   商业 SaaS    Percy ──┐         │  ┌── vlm-diff（agent 验证层）
  (Percy/Applitools/    │         │  │   唯一同时占据右上角的：
   Chromatic)           │         │  │   DOM ground truth +
  ──────────────────────┤         │  │   agent 原生 + 成本治理
   开源像素工具          │         │  │
  (BackstopJS/Lost-     │         │  │
   pixel/reg-suit)      │         │  │
                        │         │  │
                      低 └─────────┼──┘
                      人驱动 CI    └──→  agent 驱动工作流
```

**结构判断**：Percy/Applitools/Chromatic 把视觉回归做成"给人看的 QA 仪表盘"；DiffShot-AI 把 AI 用来"分析代码变化"。**"agent 工作流里调用的本地视觉验证层"是空位**——vlm-diff 是唯一卡进去的。

## 二、逐维度对比（v0.6.0 实况）

| 维度 | Percy | Applitools | Chromatic | 开源像素工具 | **vlm-diff** |
|---|---|---|---|---|---|
| **误报率** | 高（纯像素 AA 噪声） | 中（AI 过滤但黑盒） | 高 | 高 | **0%**（42 no-change 对，CI [0, 8.4%]） |
| **召回（细微变化）** | 高（靠误报换） | 中高 | 高 | 中 | **100%**（151/151 变化对） |
| **可解释性** | "123 像素变了" | 框但无原因 | 组件高亮 | 像素遮罩 | **自然语言 + DOM 证据** |
| **严重度分级** | 无 | 无 | 无 | 无 | **breaking/moderate/cosmetic**（0 token） |
| **无障碍回归** | 无 | 无 | 无 | 无 | **WCAG 对比度 + alt/aria 删除检测（确定性）** |
| **弱模型鲁棒性** | N/A | N/A | N/A | N/A | **实测验证**（弱模型 raw 0% 召回时，分层臂仍 100%/0%/91.2%） |
| **成本（千次对比）** | $149–399/月 | $299–899/月 | $149–599/月 | 免费（自建） | **约 $1–5**（97.1% 区域零 token，643/662，来源 results/router-replay.json） |
| **成本可观测** | 订阅内不可见 | 同 | 同 | 无 | **每次调用记 fn/token/成本/延迟** |
| **agent 原生** | 无 | MCP 只是接 Eyes 云的桥 | 无 | 无 | **本地 MCP = diff 引擎本身，图像+结构化返回** |
| **CI/Action** | ✅ 成熟 | ✅ | ✅ | 部分 | ✅ composite Action（真实 PR 验证） |
| **baseline 管理** | ✅ 审批流 | ✅ | ✅ | 弱 | ✅ init/baseline/check/**review**/trends |
| **多浏览器** | ✅ 云渲染矩阵 | ✅ | ✅ | 手动 | ❌ Chromium only |
| **企业功能** | 团队/权限/趋势 | ✅ | ✅ | 无 | ❌ 无 dashboard/协作 |
| **安装** | SDK 集成 | SDK 集成 | Storybook 绑定 | 手动 | **`npm i -g vlm-diff`** |

## 三、只有我们能做的（护城河）

1. **DOM 作 ground truth 的确定性层**：97.1% 区域的答案可证明正确（来自 DOM 计算样式，不是模型猜的；来源：results/router-replay.json，643/662 区域）。
2. **evidence 贯穿**：每条描述带 DOM 字段与 before/after 原始值——可核查，不是可相信。
3. **agent 验证闭环**：MCP 返回**结构化 verdict + 标注图 image 块**；Applitools 的 MCP 只是接它云服务的桥（`eyes_setup_project`/`eyes_fetch_visual_results` 这类），diff 仍发生在它家云端；我们本地、零遥测、确定性。
4. **确定性无障碍层**：WCAG 对比度纯数学 + alt/aria 删除检测——视觉回归工具里没人做。
5. **成本治理成体系**：分层路由 + 输出上限 + 预算闸门 + 按调用记账。
6. **学术级可复现**：193 对数据集 + 四臂 + 盲评人工校准 + CI/McNemar/bootstrap 全开源。

## 四、诚实的输面

1. **多浏览器矩阵**：Percy/Applitools 云渲染 Firefox/Safari/WebKit；我们 Chromium only。
2. **企业协作面**：无 dashboard、审批权限、SLA、历史趋势云存储（本地 trends 有，云端没有）。
3. **规模**：无 TB 级截图库、无托管基础设施。
4. **非 DOM 内容**：Canvas 游戏/WebGL/视频——DOM 信号失效处只剩像素+VLM 兜底。
5. **生态成熟度**：npm 下载量几乎为零、Marketplace 未上架、无第三方背书（详见采纳现状）。

## 五、采纳现状（2026-09-20 实测）

- npm `vlm-diff`：上周 13 次下载 / 近月 31 次（含自验与 CI 注水，真实外部用户≈0）
- GitHub：0 stars / 0 forks；近 14 天 8 次页面浏览（掘金/dev.to 文章导流）
- **结论：产品就绪，分发未启动。** 缺口不在产品能力，在没人知道它存在（HN 帖子、Marketplace 勾选、MCP registry 都还没做）。

## 六、战略结论

**不做**：和 Percy 正面刚 dashboard、抢 Storybook 用户、做泛 QA 平台。

**要做**：把"agent 时代的视觉验证层"做深——
- 对 agent：`snapshot_url → diff_screenshots` 是"改完 UI 看一眼对不对"的那个调用；
- 对 CI：Action 是"PR 自动带 severity 评论"的那个门禁；
- 对人：evidence + 成本日志 + 无障碍信号让它成为"敢信"的结果。

一句话：**Percy 卖"人看 dashboard 管理回归"，我们卖"agent 和 CI 自动验证回归"**——两个时代的产品，胜算全押在后者。
