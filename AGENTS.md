# AGENTS.md · Guidelines for AI Agents & Future Sessions

Welcome to **Otus (鸺鹠)**! This document provides crucial context, architectural constraints, and brand identity rules for all AI assistants, subagents, and automated workflows operating in this codebase.

---

## 1. Brand Identity & Visual Assets (定版规范 · 勿擅自修改)

> [!IMPORTANT]
> **官方 Logo 与视觉资产已经定版**。除非用户明确下达更换 Logo 的指令，否则**绝不**重新生成、覆盖或替换以下资产。

| 资产文件 | 用途与规范 | 规格说明 |
| :--- | :--- | :--- |
| **`assets/AppIcon.png`** | **唯一官方定版 Logo / App Icon** | 1024×1024 像素，严格遵循 Apple HIG 规范的 824px Squircle（超椭圆）与外围 100% 透明 Alpha 通道，内嵌原生高斯阴影。用于所有应用图标、头像、宣传图角标。 |
| **`assets/logo-source.jpg`** | **原版高清母稿** | 1024×1024 高分辨率未裁切母稿，供后续制作宣传海报、全屏背景、Banner 或衍生宣传物料时提取素材。 |
| **`assets/template.html`** | **日终心流报告模板** | 1:1 复刻 Alma 的 180 格（07:00–22:00）GitHub 绿阶心流矩阵与任务雷达图。 |

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
3. **1:1 对标 Alma 核心机制**：
   - **会话切分与总结**：采用 Jaccard 相似度 $\ge 0.18$ 聚类，严格遵循 Alma 原版 Hard Rules Prompt；
   - **隐私保护**：入库与调用 LLM 前必须经过 `src/redactor.ts`（脱敏 API Key、私钥、Token）；
   - **图像判重**：截图经 `sips` 压缩至 1280px + 质量 40，并通过 `native/img-diff.swift`（32-bin 归一化灰度直方图 + 巴氏距离）过滤 $<5\%$ 的微变静止帧；
   - **系统休眠**：监听 `willSleep` / `didWake` 广播，合盖自动闭合会话，唤醒干净重置。
4. **macOS 合规打包**：
   - 应用托管在 `/Applications/Otus.app`；
   - 声明 `com.davidlin.otus` 与 `LSUIElement=true`，系统级常驻后台且不占 Dock 栏；
   - 权限由 `native/perms-check.swift` 统一检测与引导。

---

## 3. 文档与维护规范

- 所有过程设计文档、调研规划和临时笔记统一存放于 `docs/` 目录；
- `docs/` 必须保留在 `.gitignore` 中，避免污染 Git 提交历史。
