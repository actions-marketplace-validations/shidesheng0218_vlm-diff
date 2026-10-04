> **数据快照：v0.1（39 对）** — 文中数字（92% 召回、39 对等）为初版测量。最新数据：193 对、变更对 151/151 检出、0/42 误报（离线回放）、97.1% 区域零 token 确定性作答、90.2% 降本 — 以 README 为准。

# 发布行动计划

## 📋 当前状态（2026-08-13）

✅ **已完成**
- [x] Git 仓库初始化，3 次提交
- [x] 推送到 GitHub: https://github.com/shidesheng0218/vlm-diff
- [x] arXiv 论文草稿（paper/vlm-diff.tex）
- [x] HN 发帖模板（hn-post.md）
- [x] 快速开始指南（QUICKSTART.md）

⚠️ **未完成**
- [ ] Demo 脚本（让别人能一键跑起来）
- [ ] API 验证（OpenAI/Anthropic 都还没跑通）
- [ ] HTML 报告生成器
- [ ] 社区推广（HN/Reddit/Twitter）

---

## 🎯 接下来 3 步（优先级排序）

### 第 1 步：让 Demo 能跑起来（1-2 小时）

**为什么**：HN 用户会 clone 下来试，如果跑不起来，不会有人关注。

**要做的事**：

1. **创建 demo 脚本**
   ```bash
   # 新建 scripts/demo-generate.ts
   # 生成 3 个 fixture 的 before/after 截图 + DOM JSON
   
   # 新建 scripts/demo-detect.ts
   # 读取截图，跑 Stage 1（deterministic detection）
   # 不调 VLM（避免 API key 问题）
   # 输出：检测到 36/36 变化，0/3 误报
   ```

2. **在 package.json 添加命令**
   ```json
   {
     "scripts": {
       "demo:generate": "tsx scripts/demo-generate.ts",
       "demo:detect": "tsx scripts/demo-detect.ts",
       "demo:full": "tsx scripts/demo-full.ts"  // 需要 API key
     }
   }
   ```

3. **测试完整流程**
   ```bash
   npm install
   npm run demo:generate  # 应该生成 data/demo/ 文件夹
   npm run demo:detect    # 应该输出检测结果
   ```

**我现在帮你做这一步吗？**（回复"做"我就开始写代码）

---

### 第 2 步：发布到 Hacker News（15 分钟）

**时机**：Demo 能跑通后立即发

**操作步骤**：

1. 访问 https://news.ycombinator.com/submit

2. 填写表单：
   - **Title**: `VLM-Diff: UI visual regression testing with DOM ground truth (92% recall, 0% FP)`
   - **URL**: `https://github.com/shidesheng0218/vlm-diff`

3. 发布后 5 分钟内，在评论区补充：
   ```
   Author here! Quick context:
   
   This is a research prototype showing that DOM structure + VLM 
   classification outperforms naive "send two screenshots to GPT" 
   approaches for UI regression testing.
   
   Key result: 92% recall with 0% false positives on no-change pairs 
   (confirmed on real data). The deterministic layer filters out 
   anti-aliasing noise that plagues pixel-diff tools.
   
   The VLM classification part is still pending API validation 
   (predicted 75-82% accuracy based on VLM-SubtleBench baselines).
   
   Would love feedback on:
   - Should I productize this (CLI + CI integration)?
   - Or keep it as an academic benchmark?
   - Anyone using Percy/Applitools want to compare?
   
   5-min quick start: https://github.com/shidesheng0218/vlm-diff/blob/master/QUICKSTART.md
   ```

**最佳发帖时间**（北京时间）：
- 今晚 23:00-01:00（美国西海岸早上 8-10am）
- 明早 08:00-10:00（美国西海岸下午 5-7pm，下班时间）

---

### 第 3 步：根据反馈决定方向（1-3 天后）

**场景 A：很多人感兴趣（>100 upvotes，>20 评论）**

行动：
1. 做 CLI 工具（`npx vlm-diff compare before.png after.png`）
2. 写 CI 集成文档（GitHub Actions）
3. 开 Discord/Slack 社区
4. 考虑 SaaS 商业化

**场景 B：学术界关注（有人引用、要数据集）**

行动：
1. 补完 API 验证实验
2. 扩充数据集到 100 pairs
3. 投 Workshop（CVPR/WACV）
4. 联系相关作者（VLM-SubtleBench/OmniDiff）

**场景 C：没什么反响（<50 upvotes）**

行动：
1. 在简历上加一行"开源项目"
2. 继续做下一个项目
3. 或者换个角度推广（Reddit r/webdev, Twitter）

---

## 📊 预期时间线

```
今天（8/13）
  └─ 完成 Demo 脚本（1-2h）
  └─ 测试完整流程（30min）

今晚 23:00
  └─ 发布 HN

明天（8/14）
  └─ 监控 HN 评论，及时回复
  └─ 如果上首页，准备应对流量

后天（8/15）
  └─ 根据反馈决定：
      • 产品化路线
      • 学术研究路线
      • 或搁置
```

---

## ✅ 你现在的决策点

**立即要做的**：

1. **我先帮你写 Demo 脚本**（让 `npm run demo:detect` 能跑）
   - 回复"做"我就开始

2. **你决定发布时机**：
   - 今晚 23:00 发 HN？
   - 还是等 Demo 完全跑通再说？

3. **API key 问题**：
   - 要不要现在再试一次 Anthropic API？
   - 或者先发布，Demo 只跑 Stage 1（不需要 API）

**我的建议**：先做 Demo 脚本，确保别人 clone 下来能看到结果，然后今晚发 HN。

你想怎么做？
