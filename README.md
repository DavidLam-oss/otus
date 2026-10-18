<p align="center">
  <img src="assets/logo.webp" alt="Otus Logo" width="140" />
</p>

<h1 align="center">Otus (鸺鹠)</h1>

<p align="center">
  <strong>1:1 复刻 Alma 核心架构的超轻量 macOS 后台静默记录与晚间个人折腾日记生成器</strong><br>
  <em>剥离臃肿宿主 · 纯粹原汁原味 · 零外部 NPM 依赖 · 单进程常驻</em>
</p>

---

## 🌟 为什么做 Otus？

Alma 是一款非常出色的桌面 AI 伴侣，其最打动人心的功能莫过于：**白天后台无感静默记录动态，晚间自动生成一份详实的第一人称“个人折腾日记”与 GitHub 绿阶心流矩阵**。

但在日常使用中，官方客户端捆绑了繁重的 Electron 渲染框架、聊天界面、长驻子进程与高耗电。**Otus 的目标是：彻底剥离其臃肿的宿主外壳，100% 忠实复刻 Alma 原生验证可行的底层记录与总结链路，跑出一个干净、极简、无负担的基线版本。**

---

## 🏗️ 核心架构与 1:1 对标

| 核心组件 | 对标 Alma 实现 | Otus 原生实现细节 |
| :--- | :--- | :--- |
| **持久化存储** | SQLite 5 表关系模型 | `activity_sessions` / `snapshots` / `ocr_frames` / `events` / `summaries`，基于 Node 26 原生 `node:sqlite`，**0 外部依赖** |
| **事件感知** | `alma-input-monitor` | 原生 Swift 编译二进制，通过 Cocoa Global Monitor 捕获按键停顿、点击、应用焦点切换与锁屏 |
| **屏幕捕获与 OCR** | `alma-ocr` | 原生 `screencapture -x -C` 静音抓拍 + 图像哈希判重 + Apple Vision 框架精准离线 OCR |
| **浏览器穿透** | `alma-browser-tab` | 原生常驻 AppleScript 进程，毫秒级读取 Chrome、Safari 等活跃标签 URL 与页面标题 |
| **微会话分析** | `ActivityAnalyzer` | 异步状态机会话切分，采用 Alma 原版 Prompt 提取 Project、Topics、Highlights 与结构化 Entities（PR/Issue/Commit） |
| **日终报告引擎** | `ActivitySummarizer` | **零 Token 本地 Jaccard 聚类算法**（相似度 $\ge 0.18$）生成结构化 Markdown 骨架 + 严苛防幻觉 Hard Rules 润色 |
| **心流热力图** | `template.html` | 完整复刻 07:00–22:00（15×12=180 格）GitHub 绿阶心流矩阵、小时专注雷达与任务占比图 |
| **磁盘生命周期** | `ActivityRotator` | 自动轮转管理快照存储，定期释放过期大图，元数据永久归档 SQLite |

---

## 📦 下载与安装 (macOS)

### 方式 1：下载预编译 DMG 安装包（推荐）

1. 前往 [GitHub Releases](https://github.com/DavidLam-oss/otus/releases) 下载最新的 `Otus-Installer.dmg`（仅 ~6MB）；
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
>    - **辅助功能**：用于感知应用焦点切换、按键停顿与空闲检测。
>    *(注：macOS 权限是与应用 Bundle ID `com.davidlin.otus` 绑定的，未签名完全不影响权限的正常获取与持久化)*

---

### 方式 2：从源码快速上手与本地构建

### 环境要求
- macOS 13+ (Apple Silicon / Intel)
- Node.js >= 22 (推荐 Node 26，内置 `node:sqlite` 与 `--experimental-strip-types`)

### 基础命令行调用

```bash
# 1. 查看当前守护进程状态与今日统计
./bin/otus status

# 2. 单次测试当前屏幕抓拍与 Apple Vision OCR
./bin/otus test-capture

# 3. 运行未分析会话的微小结处理
./bin/otus analyze

# 4. 实时查看今日个人折腾日记（终端 Markdown 渲染）
./bin/otus report

# 5. 导出并自动在浏览器中打开今日 180 槽位 GitHub 绿阶心流报告
./bin/otus export
```

---

## ⚙️ 后台常驻与自启 (launchd)

通过 macOS 原生 `launchd` 进行守护，重启自动拉起，崩溃自动恢复，无任何前台窗口干扰：

```bash
# 一键安装为后台静默守护服务
./scripts/install.sh

# 查看服务运行状态
./bin/otus status

# 卸载后台服务
./scripts/uninstall.sh
```

---

## 🔑 LLM 模型与网关配置

Otus 支持任意兼容 OpenAI 协议的接口（包括本地 Ollama、DeepSeek、OpenAI、SiliconFlow 或 Magpie 网关）。具备完善的离线启发式分析兜底（未配置任何 API 亦可 100% 正常运行）。

### 1. 菜单栏图形化配置 (GUI)

点击菜单栏夜枭图标 -> 选择【偏好设置...】，即可在弹出的原生偏好面板中一键选择提供商预设（Magpie / DeepSeek / Ollama / OpenAI / 自定义），并直接进行接口连通性测试。

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

### 2. 配置文件与环境变量优先级

1. **环境变量**（最高优先级，适合容器与临时调试）：`OTUS_LLM_URL` / `OTUS_LLM_KEY` / `OTUS_ANALYSIS_MODEL` / `OTUS_REPORT_MODEL`
2. **本地配置**：`~/.otus/config.json`
3. **默认网关**：未配置时默认连接本机 Magpie 网关 (`http://127.0.0.1:3425/v1`)，连接失败自动无缝降级为**本地离线启发式引擎**，零报错。

---

## 📄 License
MIT © David Lin
