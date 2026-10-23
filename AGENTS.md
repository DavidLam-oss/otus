# AGENTS.md · Guidelines for AI Agents & Future Sessions

Welcome to **Otus (鸺鹠)**! This document provides crucial context, architectural constraints, and brand identity rules for all AI assistants, subagents, and automated workflows operating in this codebase.

---

## 1. Brand Identity & Visual Assets (定版规范 · 勿擅自修改)

> [!IMPORTANT]
> **官方 Logo 与视觉资产已经定版**。除非用户明确下达更换 Logo 的指令，否则**绝不**重新生成、覆盖或替换以下资产。

| 资产文件 | 用途与规范 | 规格说明 |
| :--- | :--- | :--- |
| **`assets/AppIcon.png`** | **唯一官方定版 Logo / App Icon** | 1024×1024 像素，严格遵循 Apple HIG 规范的 824px Squircle（超椭圆）与外围 100% 透明 Alpha 通道，内嵌原生高斯阴影。用于所有应用图标、头像、宣传图角标。 |
| **`assets/logo.webp`** | **Web / README 高性能轻量 Logo** | 512×512 像素，仅 28KB 高性能 WebP，保留完整透明通道与柔和投影，供 GitHub README 与网页端毫秒级秒开渲染。 |
| **`assets/logo-source.jpg`** | **原版高清母稿** | 1024×1024 高分辨率未裁切母稿，供后续制作宣传海报、全屏背景、Banner 或衍生宣传物料时提取素材。 |
| **`assets/template.html`** | **日终心流报告模板** | 标准 180 格（07:00–22:00）GitHub 绿阶心流矩阵与任务雷达图。 |

### 品牌设计语言（Design System）
- **核心符号**：黄金分割几何雷达与同心圆声纳构成的极简夜枭（象征深夜全天候静默守护的极客助手）；
- **核心色盘**：
  - **主底色**：深邃磨砂黑 `#0D1117` / `#151B23`；
  - **线条高光**：冷白金属质感 `#E2E8F0` / `#CBD5E1`；
  - **环境微光**：极简鼠尾草冷绿荧光（Sage Glow）`#A3E635` / `#86EFAC`；
- **排版定位**：“个人折腾日记”（专注于独立开发、技术探索与折腾记录，非打工汇报）。

---

## 2. 核心架构与工程约束

1. **零 Electron · 极致轻量**：
   - 必须保持纯 Headless 运行，不得引入任何前端渲染框架或浏览器窗口宿主；
   - 内存占用控制在 ~40MB 级别，待机 CPU 0.0%。
2. **纯粹原生技术栈**：
   - **运行时**：Node.js 26+，启用 `--experimental-strip-types`；
   - **数据库**：原生 `node:sqlite`（开启 `journal_mode=WAL` 与 `busy_timeout=5000`）；
   - **依赖原则**：**0 外部 NPM 依赖**（`package.json` 中无 `dependencies`）；
   - **macOS 底层交互**：采用独立 Swift 脚本（`native/*.swift`），由构建脚本编译为独立二进制执行。
3. **高保真记录与总结机制**：
   - **会话切分与总结**：主路径为 **HAC 凝聚层次聚类 + TF-IDF 向量**（`clusterCutDistance` 0.62，
     相似度 ≈0.38 以上倾向同簇），主题内要点用 **MMR 边际相关性**去重；
     LLM 不可用时回退到字符 bigram Jaccard。全程严格遵循防幻觉 Hard Rules 约束体系；
   - **隐私保护**：入库与调用 LLM 前必须经过 `src/redactor.ts`（脱敏 API Key、私钥、Token）；
   - **图像判重**：截图经 `sips` 压缩至 2560px + 质量 55（对齐 Alma，实测均值约 250KB/张，
     随画面复杂度在 48KB–643KB 间波动），并通过 `native/img-diff.swift`（32-bin 归一化灰度直方图
     + 巴氏距离）过滤 $<5\%$ 的微变静止帧；判重用独立的 160×90 内存缩略图，与落盘分辨率无关；
   - **三级存储轮转**（对齐 Alma）：hot 1 天保留原图 → warm 7 天后重压至 1280×720@40 →
     cold 30 天后重压至 640×360@30 → 超期删文件保留 OCR 文本；
     容量超 10GiB 时按时间从旧到新清理至 7.5GiB 水位（8053063680 字节，与 Alma 一致）；
   - **系统休眠**：监听 `willSleep` / `didWake` 广播，合盖自动闭合会话，唤醒干净重置。
4. **macOS 合规打包**：
   - 应用托管在 `/Applications/Otus.app`；
   - 声明 `com.davidlin.otus` 与 `LSUIElement=true`，系统级常驻后台且不占 Dock 栏；
   - 权限由 `native/perms-check.swift` 统一检测与引导。

---

## 3. LLM 提示词工程规范（硬性约束）

> [!IMPORTANT]
> **提示词不是规则清单。** 每遇到一个新错判就往提示词里加一条「不要 XXX」，
> 是最容易失控的反模式：规则互相冲突、模型抓不住重点、token 成本无限上涨。

### 3.1 唯一判据原则

给 LLM 的每个提示词，都必须先回答一个问题：**这段内容真正要判断的单一标准是什么？**
把它放在最前面，用一句话说清。其余所有规则都必须是这条标准的**派生**，而不是并列的新规则。

Otus 里已有的判据：

| 提示词 | 唯一判据 | 状态 |
| :--- | :--- | :--- |
| `OTUS_ANALYZER_SYSTEM_PROMPT` | 用户**实际产出了什么** | ✅ 已写入提示词 |
| `OTUS_THEME_SYSTEM_PROMPT` | 用户**实际产出了什么** | ✅ 已写入提示词 |
| `OTUS_NARRATIVE_SYSTEM_PROMPT` | 忠实叙述事实，不加工 | ✅ 已写入（措辞为「严格的事实边界」） |
| `OTUS_INSIGHTS_SYSTEM_PROMPT` | 只基于给定事实做推断 | ⚠️ 未写入，待补 |

`OTUS_INSIGHTS_SYSTEM_PROMPT` 目前的口吻要求（「犀利、直击要害」）与 3.5 第 3 条
「不做人格或效率评判」**存在冲突**，尚未解决。补判据时要一并处理：
判据应是「用户今天实际怎么用工具的」，而不是「用户今天效率如何」。

### 3.2 用示例替代规则堆叠

**一个正反对照示例 ≈ 4 条否定规则**，且效果通常更好，因为示例能让模型同时看到
「什么是对的」和「几种错误长什么样」。

新增规则前先自问：**能不能用一个示例说清？** 能，就用示例。

### 3.3 三条反模式（严禁）

1. **禁止「不要 XXX」式的否定规则堆叠**。若已有 3 条以上同源否定规则，说明该重构了。
2. **禁止为单个历史案例加规则**。先判断它是「判据没写清」还是「判据错了」，
   修正判据本身，而不是打补丁。
3. **禁止让提示词只增不减**。每次改动都要看字符数变化，只涨不降要给出理由。

### 3.4 规模上限与体检

- 单条 system prompt **不超过 2500 字符**；
- 「字符数」的统计口径：从 `const XXX_PROMPT = \`` 到闭合反引号之间的全部内容
  （含 JSON 输出格式段）。**不设 schema 豁免** —— schema 也是 token 成本，
  且模型同样要理解它，把它排除在预算外等于自欺欺人；
- 超过时优先做**压缩重写**，不是拆分；
- 每次修改提示词后，用下方命令体检，并把字符数变化写进 commit message：

```bash
node --experimental-strip-types -e '
const fs=require("fs");
for (const f of ["src/analyzer.ts","src/summarizer.ts"]) {
  const s=fs.readFileSync(f,"utf8");
  // 只匹配 OTUS_ 前缀的 system prompt，避免误统计同名的普通常量
  const re=/const (OTUS_\w*PROMPT) = `([\s\S]*?)`;/g; let m;
  while((m=re.exec(s))) console.log(`${m[1]}: ${m[2].split("\n").length} 行 / ${m[2].length} 字符`);
}'
```

**当前基线**（2026-10-24 更新，`recompute` 后实测）：

| 提示词 | 行数 | 字符 | 唯一判据 |
| :--- | ---: | ---: | :--- |
| `OTUS_ANALYZER_SYSTEM_PROMPT` | 68 | 2363 | 实际产出了什么 |
| `OTUS_THEME_SYSTEM_PROMPT` | 49 | 1447 | 实际产出了什么 |
| `OTUS_NARRATIVE_SYSTEM_PROMPT` | 18 | 633 | 忠实叙述事实，不加工 |
| `OTUS_INSIGHTS_SYSTEM_PROMPT` | 18 | 448 | ⚠️ 待补（见 3.1 说明） |

### 3.5 改动提示词后的验证流程

1. **类型检查通过**：`npm run typecheck`（即 `tsc -p tsconfig.json`）。
   需要先装类型依赖（不进 `package.json` 的 dependencies，`node_modules` 已被 gitignore）：
   `npm i --no-save --no-package-lock typescript@5 @types/node@22`
   唯一的已知噪音：`src/store.ts` 里 `bun:sqlite` 缺类型声明（历史遗留，未使用）；
2. 用真实数据跑一次 `otus report today --force`，人工核对主题名与叙述是否准确；
3. 特别检查是否出现评判性结论（如「没干正事」「注意力被切碎」）——
   报告只陈述事实与产出，不做人格或效率评判；
4. 更新 3.4 的基线表。

---

## 4. 文档与维护规范

- 所有过程设计文档、调研规划和临时笔记统一存放于 `docs/` 目录；
- `docs/` 必须保留在 `.gitignore` 中，避免污染 Git 提交历史。
