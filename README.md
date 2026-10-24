<p align="center">
  <img src="assets/logo.webp" alt="Otus Logo" width="140" />
</p>

<h1 align="center">Otus (鸺鹠)</h1>

<p align="center">
  <strong>超轻量 macOS 原生后台静默记录与晚间个人折腾日记生成器</strong><br>
  <em>剥离臃肿宿主 · 纯粹原生 Headless · 零外部 NPM 依赖 · 单进程常驻</em>
</p>

---

## 🌟 为什么做 Otus？

Otus 的初衷源于对开发者日常技术探索与专注心流记录的真实渴望：**白天后台无感静默记录开发轨迹与技术攻坚，晚间自动生成一份详实的第一人称“个人折腾日记”与 180 槽位 GitHub 绿阶心流矩阵**。

桌面伴侣软件 Alma 提供了极富创意的记录与复盘理念，但在日常使用中，官方应用往往捆绑了庞大的 Electron 渲染框架、聊天界面、长驻子进程与可观的资源开销。**Otus 将其软件中这套最具价值的“后台静默记录与日终折腾复盘”核心链路独立抽取出来，基于 macOS 原生技术栈进行了彻底的重新实现——算是一种吸收、借鉴与极简重构。**

我们彻底舍弃了前端重型外壳与无谓开销，做到了真正的 **0 外部 NPM 依赖**、**常驻内存 ~22MB**（实测 5 个进程合计，主 daemon 仅 8MB）、**待机 CPU 0.0%**。

---

## 🏗️ 核心架构与技术实现

| 核心模块 | 设计定位 | Otus 原生实现细节 |
| :--- | :--- | :--- |
| **持久化存储** | SQLite 5 表时序模型 | `activity_sessions` / `activity_snapshots` / `activity_ocr_frames` / `activity_events` / `activity_summaries`，基于 Node 原生 `node:sqlite`（开启 WAL 与 `busy_timeout=5000`），**0 外部 NPM 依赖** |
| **事件感知** | 低开销系统事件监听 | 原生 Swift 编译二进制（`otus-input-monitor`），通过 Cocoa Global Monitor 捕获按键停顿、点击、窗口焦点切换与锁屏休眠；内置 30s 前台 App 定期采样（见「长任务活跃判定」） |
| **屏幕捕获与判重** | 三级差分过滤微变静止帧 | 原生 `screencapture -x -C` 静音抓拍 + **三级判重**：① MD5 全等快筛 → ② 32-bin 归一化灰度直方图巴氏距离（<5% 视为静止）→ ③ 160×90 内存缩略图像素容差比对（<2% 视为静止）。判重用独立缩略图，与落盘分辨率无关 |
| **离线 OCR** | 本地光学识别 | Apple Vision 框架精准离线 OCR，含**相似度 0.9 去重**（同一画面多帧只留一条，避免重复喂 LLM 浪费 token） |
| **窗口标题采集** | 浏览器 + 原生 App 双通道 | 浏览器走常驻 AppleScript 读活跃标签 URL 与标题；非浏览器应用通过独立的 `OtusWindowTitle.app`（AXTitle，按需请求不轮询）读取前台窗口标题，含失败退避与进程自愈 |
| **长任务活跃判定** | 人不动也算在干活 | 三路激活任一成立即视为活跃：① 真实键鼠输入 → ② 画面发生实质变化后 2 分钟窗口内 → ③ 前台为任务型 App 白名单（AI Agent / IDE / 终端等）。解决「盯着 Agent 长跑任务但不动鼠标，会话被反复切断」 |
| **微会话切分** | 异步切分与实体抽取 | 异步状态机会话切分 + 质量前置门槛（过短、过疏的会话直接跳过不烧 token）+ 相邻碎片合并，精准提取 Project、Topics、Highlights 与结构化 Entities（PR/Issue/Commit/Repos/Versions） |
| **切换质量分析** | 区分「回访」与「探索」 | 统计 `revisitSwitches`（切回本次已用过的 App，属工具链切换）与 `newAppSwitches`（首次进入新 App，属探索/打断），避免多 App 协作的高频切换被误判成注意力碎片化 |
| **日终复盘引擎** | 数学聚类 + LLM 叙事 | **HAC 凝聚层次聚类**（average linkage，`cutDistance` 0.62 即相似度 ≈0.38 倾向同簇）+ **TF-IDF 向量**，簇内要点用 **MMR 边际相关性**去重；LLM 不可用时回退字符 bigram Jaccard。全程遵循防幻觉 Hard Rules |
| **心流热力图** | 全天 180 格心流矩阵 | 完整渲染 07:00–22:00（15×12=180 格）GitHub 绿阶心流矩阵、小时专注雷达与任务占比图 |
| **磁盘生命周期** | 三级轮转与容量兜底 | **hot** 1 天保留原图（2560 宽 / 质量 55，实测均值约 250KB/张）→ **warm** 7 天后重压至 1280×720@40 → **cold** 30 天后重压至 640×360@30 → 超期删文件保留 OCR 文本。容量超 **10GiB** 时按时间从旧到新清理至 **7.5GiB** 水位，结构化元数据永久归档 SQLite |

---

## 📦 下载与安装 (macOS)

### 方式 1：下载预编译 DMG 安装包（推荐）

1. 前往 [GitHub Releases](https://github.com/DavidLam-oss/otus/releases) 下载最新的 `Otus-Installer.dmg`（实测 ~17MB，解压后应用约 18MB）；
2. 双击打开镜像，将 `Otus.app` 拖入 `Applications`（应用程序）文件夹；
3. 从 Launchpad 或「应用程序」中启动 Otus，即可在 macOS 顶部菜单栏看到常驻夜枭图标。

> [!IMPORTANT]
> **关于 macOS Gatekeeper 安全门禁与权限授予说明：**
>
> 由于开源项目未购买苹果年费开发者证书，macOS 首次打开可能会提示「无法打开，因为无法验证开发者」或「已损坏」。这是 macOS 对未签名开源软件的默认安全策略，请按以下指引正常开启：
>
> 1. **首次绕过 Gatekeeper**：
>    - **访达右键打开（最简）**：在「访达」->「应用程序」中，**按住 Control 键点按（或右键）`Otus.app` -> 选择【打开】**，在弹出的系统确认框中点击【打开】即可。后续系统将永久信任，双击即可直接秒开；
>    - **或终端极客一键**：在终端执行以下命令直接移除隔离标记：
>      ```bash
>      xattr -cr /Applications/Otus.app
>      ```
> 2. **系统权限授予（屏幕录制与辅助功能）**：
>    首次启动时，系统会提示授权，请在「系统设置 -> 隐私与安全性」中开启：
>    - **屏幕录制**：用于后台静默定期抓拍微会话与离线 OCR（图像仅在本地内存与 SQLite 处理，绝不上报）；
>    - **辅助功能**：用于感知应用焦点切换、按键停顿与空闲检测，以及读取前台窗口标题（AXTitle）。
>
>    *(注：macOS 权限是与应用 Bundle ID `com.davidlin.otus` 绑定的，未签名完全不影响权限的正常获取与持久化。`OtusWindowTitle.app` 是 Otus 的子进程，会继承主应用的辅助功能授权，无需在权限列表中单独勾选)*

---

### 方式 2：从源码快速上手与本地构建

#### 环境要求

- macOS 13+ (Apple Silicon / Intel)
- **Node.js >= 26**（主路径强依赖原生 `node:sqlite` 与 `--experimental-strip-types`）

#### 基础命令行调用

```bash
# 1. 查看当前守护进程状态与今日统计
./bin/otus status

# 2. 单次测试当前屏幕抓拍与 Apple Vision OCR
./bin/otus test-capture

# 3. 运行未分析会话的微会话处理
./bin/otus analyze

# 4. 实时查看今日个人折腾日记（终端 Markdown 渲染）
./bin/otus report

# 5. 导出并自动在浏览器中打开今日 180 槽位 GitHub 绿阶心流报告
./bin/otus export

# 6. 打开最近一次导出的 HTML 报告
./bin/otus open-latest

# 7. 回填存量会话的行为信号（新增信号字段后对历史数据生效）
./bin/otus recompute-signals 30
```

---

## ⚙️ 后台常驻与自启 (launchd)

通过 macOS 原生 `launchd` 进行守护，重启自动拉起，崩溃自动恢复，无任何前台窗口干扰：

```bash
# 一键安装为后台静默守护服务
./scripts/install.sh

# 查看服务运行状态
./bin/otus status

# 卸载后台守护服务
./scripts/uninstall.sh
```

### 自动报告生成机制 (Scheduled Reporting)

- **晚间定点复盘**：每天 23:50 后台自动生成当天的全天折腾日记与心流图，并推送系统通知提醒（每天仅自动触发 1 次，完整收纳晚间下班后的全部个人折腾，避免提早总结遗漏深夜活动）；
- **次日开机补漏**：若前一晚在 23:50 前提早合盖离线，次日开机或唤醒后 5 秒内自动在后台补齐昨日报告，永不遗漏；
- **随时主动生成**：菜单栏点击【查看今日折腾日记】、终端运行 `./bin/otus report` 或 `./bin/otus export` 随时按需查看最新进展。

---

## 🔑 LLM 模型与网关配置

Otus 支持任意兼容 OpenAI 协议的接口（包括本地 Ollama、DeepSeek、OpenAI、SiliconFlow 或 Magpie 网关）。具备完善的离线启发式分析兜底（未配置任何 API 亦可 100% 正常运行）。

### 1. 菜单栏图形化配置 (GUI)

点击菜单栏夜枭图标 -> 选择【偏好设置...】，即可在弹出的原生偏好面板中一键选择提供商预设（Magpie / DeepSeek / Ollama / OpenAI / 自定义），并直接进行接口连通性测试。支持为深度复盘模型单独配置独立的 API 地址与密钥。

### 2. 命令行快速配置 (`otus config`)

无需手动修改环境变量，直接通过命令行配置并持久化到 `~/.otus/config.json`：

```bash
# 查看当前生效配置
otus config

# 示例 1: 使用 DeepSeek
otus config set url https://api.deepseek.com/v1
otus config set key sk-your-key
otus config set analysis deepseek-chat
otus config set report deepseek-chat

# 示例 2: 使用本地 100% 离线 Ollama
otus config set url http://127.0.0.1:11434/v1
otus config set key ollama
otus config set analysis qwen2.5:7b
otus config set report qwen2.5:14b

# 示例 3: 使用官方 OpenAI
otus config set url https://api.openai.com/v1
otus config set key sk-proj-xxx
otus config set analysis gpt-4o-mini
otus config set report gpt-4o
```

### 3. 配置文件与环境变量优先级

1. **环境变量**（最高优先级，适合容器与临时调试）：`OTUS_LLM_URL` / `OTUS_LLM_KEY` / `OTUS_ANALYSIS_MODEL` / `OTUS_REPORT_MODEL`
2. **本地配置**：`~/.otus/config.json`
3. **默认网关**：未配置时默认连接本机 Magpie 网关 (`http://127.0.0.1:3425/v1`)，连接失败自动无缝降级为**本地离线启发式引擎**，零报错。

---

## 🤖 与 AI 结对编程助手联动 (Agent Skill)

除了自动生成的静态日终报告，Otus 还在仓库中内置了标准的 AI Agent Skill（位于 [`.agents/skills/otus-journal/`](.agents/skills/otus-journal/SKILL.md)）。

如果你使用支持 Agent 技能规范的 AI 编程助手（如 Google Antigravity、Claude Code、Cursor 等），AI 可以直接读取你本地的 Otus SQLite 数据库，像真人搭档一样理解你当天的研发轨迹，并进行**双向交互式技术复盘**：

### 常用提问姿势：

- 💬 **全天回顾**：*“我今天干了些啥？”* / *“生成今天的技术复盘”*
- 💬 **昨日追溯**：*“昨天我折腾了什么？”* / *“回顾昨天的日报”*
- 💬 **专项排查**：*“我今天在调试某个报错时是怎么解决的？帮我总结排坑笔记”*
- 💬 **心流洞察**：*“我今天最专注的时间段是哪个？时间都去哪了？”*

AI 会遵循标准的设计规范，自动为你渲染符合 Apple HIG 风格的日终心流报告，或以第一人称 Markdown 技术手记进行自由复盘。

---

## 🛠️ 参与开发

```bash
# 类型检查（首次需装类型依赖，不会写进 package.json 的 dependencies）
npm i --no-save --no-package-lock typescript@5 @types/node@22
npm run typecheck

# 改完代码后同步到已安装的 Otus.app 并重启 daemon（会自动重建 Swift 二进制）
./scripts/sync.sh
```

开发约定与架构约束详见 [`AGENTS.md`](AGENTS.md)。

---

## 📄 License

MIT © David Lin
