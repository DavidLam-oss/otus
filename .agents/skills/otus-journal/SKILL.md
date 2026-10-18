---
name: otus-journal
description: >-
  Generate, inspect, and analyze developer daily tinkering journals and focus flow reports from Otus activity records.
  Use this skill whenever the user asks about their day or recent activities ("今天干了些啥", "看看今天的日报", "生成今日报告", "回顾昨天的折腾", "我今天做了什么", "个人折腾日记", "打工日记", "what did I do today", "recap my day", "otus report", "时间去哪了").
  Follows Alma's sample-based visual constraint and supports both structured HTML report generation and freestyle technical debriefs.
---

# Otus 个人折腾日记技能 (Otus Journal Skill)

本技能用于为开发者生成基于 **Otus (鸺鹠)** 本地静默屏幕与窗口活动记录的可视化日报、心流分析与深度技术复盘。

---

## 核心设计约束 (Visual Contract & Sample)

> [!IMPORTANT]
> **严禁脱离模板生成散乱 HTML**。
> 本技能遵循 Alma 的 **Sample-based 视觉约束机制**，所有 HTML 产物必须严格遵循 [references/sample.html](./references/sample.html) 规范：
> 1. **全天心流热力矩阵**：07:00–22:00 共 180 个 5 分钟正方形切片，GitHub 绿阶与动态主题光谱双模式；
> 2. **等高容器布局**：“时间去哪了”（Top 10 主题分类）与“全天时间线”容器高度严格固定为 **520px**，内嵌细滚动条；
> 3. **极简单行时间线**：严格单行流式排版 `[时间 HH:mm]` + `[时长 badge]` + `[精炼中文标题]` + `[主题标签 pill]`，严禁在行内堆砌多行原始 OCR 代码块；
> 4. **视觉色盘**：Apple HIG 深邃磨砂黑 `#0D1117` / `#151B23`，冷白文字高光与鼠尾草冷绿荧光（Sage Glow）`#A3E635`。

---

## 何时触发本技能

当用户提出以下需求时触发：
- **全天活动复盘**：“我今天都干啥了”、“今天做了什么”、“生成今日报告”、“查看今天的心流”；
- **昨日与历史回顾**：“昨天我折腾了什么？”、“看看昨天的日报”、“回顾 2026-10-17”；
- **专项技术挖掘**：“我今天在调试某个插件时遇到了什么报错？是怎么修好的？”、“帮我把今天的折腾写成一篇公众号技术手记”；
- **效率与节律分析**：“我今天最专注的时间段是哪个？”、“时间都去哪了？”。

---

## 工作流模式

根据用户意图，支持两种响应模式：

### 模式 A：快速生成 / 刷新 HTML 可视化报告

当用户要求“生成日报 / 可视化今天 / 查看报告”时：

```bash
# 生成当天并立即在浏览器中打开
otus export

# 强制重新聚类与总结当天
otus export --force

# 生成或查看昨天的报告
otus export yesterday

# 生成指定日期的报告
otus export 2026-10-17
```

**输出规则**：
- 告知用户报告生成的落盘路径（默认位于 `~/.otus/reports/YYYY-MM-DD.html`）；
- 摘录顶部的核心 KPI 数据（全天活跃专注分钟数、实质折腾会话数、核心聚类主题数、Top App）；
- 提醒用户可以在浏览器中交互查看（点击主题条可联动热力图同频染色，时间线支持独立滚动）。

---

### 模式 B：对话内 AI Freestyle 深度复盘与定制输出

当用户在对话中想要直接了解折腾细节、撰写周报、排查历史问题或沉淀博客手记时，**给予 AI 充分的自由发挥空间**：

#### 1. 读取底层活动数据与 OCR 细节

使用 Node CLI 或直接查询本地 SQLite 数据库获取高保真上下文：

```bash
# 1. 打印结构化 Markdown 复盘手记
otus report [today|yesterday|YYYY-MM-DD]

# 2. 查询今日活动会话与 OCR 关键词 (SQLite)
sqlite3 ~/.otus/data.db "
  SELECT s.id, time(s.started_at/1000, 'unixepoch', 'localtime'), 
         (s.duration_ms/60000) || 'm', s.analysis_title, s.project
  FROM sessions s
  WHERE s.analysis_status = 'analyzed'
    AND date(s.started_at/1000, 'unixepoch', 'localtime') = date('now', 'localtime')
  ORDER BY s.started_at ASC;
"

# 3. 检索特定项目的 OCR 细节与排错记录
sqlite3 ~/.otus/data.db "
  SELECT o.window_title, substr(o.ocr_text, 1, 200)
  FROM ocr_records o
  WHERE o.ocr_text LIKE '%error%' OR o.ocr_text LIKE '%failed%'
  ORDER BY o.captured_at DESC LIMIT 10;
"
```

#### 2. Freestyle 复盘框架与组织原则

组织回答时，避免单调的时间报时流水账（如“10:01 你打开了终端，10:05 你切到了 Chrome”），必须采用**资深全栈架构师视角**的技术复盘：

1. **今日折腾画像 (Tinkering Narrative)**：
   用生动自然的第一人称/对话口吻，提炼今天最核心的 1~2 条技术攻坚主线（如：“今天上午的核心精力全部砸在 Obsidian 微信排版插件的发布降级上，下午则转战 Otus 菜单栏与报告布局调优”）。
2. **项目深度攻坚 (Thematic Deep Dive)**：
   针对重点项目，梳理：
   - **技术背景与目标**：想实现什么功能；
   - **踩坑排查实录**：屏幕 OCR 中捕捉到的核心报错、配置问题或异常堆栈；
   - **架构与代码决策**：最终采取了何种修复路径（如：“增加直连降级通道”、“剔除 lockscreen 噪声”）。
3. **心流与节律洞察 (Flow Rhythm)**：
   指出最长连续专注块（如：“07:06–08:24 持续 78 分钟的高密度深潜”），以及是否存在高频上下文切换。
4. **定制衍生输出 (按需)**：
   如果用户要求发公众号、写周报或沉淀知识库，直接将上述提取的技术干货整理为对应格式。

---

## 模板占位符对照（针对自建生成器）

如需脱离 CLI 脚本直接基于 [sample.html](./references/sample.html) 组装 HTML，请替换模板内以下占位符：

| 占位符 | 说明与格式 |
| :--- | :--- |
| `<!--__DATE__-->` | 当前日期字符串，格式 `YYYY-MM-DD` |
| `<!--__OTUS_HEAD_AND_STATS__-->` | 顶部标题与 4 枚 KPI 指标卡 HTML |
| `<!--__OTUS_STREAK_BOX__-->` | 右侧折腾信噪比与心流指示卡 HTML |
| `<!--__OTUS_THEMATIC_DEEP_DIVE__-->` | AI Freestyle 撰写的 Markdown 深度复盘渲染后的 HTML |
| `/*__OTUS_TOPIC_CSS__*/` | 动态主题的色值样式（如 `.topic.t-otus { ... }`） |
| `/*__OTUS_LABELS__*/ {}` | 主题字典 JSON：`{ "otus": ["Otus 研发", "t-otus", "#58a6ff"] }` |
| `/*__OTUS_RAW_SLOTS__*/ []` | 活跃切片数组：`[[hour, minute, durationMinutes], ...]` |
| `/*__OTUS_TL_DATA__*/ []` | 4 元组时间线数据：`[["07:06", "1m", "标题", "主题key"], ...]` |
| `/*__OTUS_THEMES__*/ []` | Top 10 主题时长数组：`[["主题名", 分钟, "#颜色", "key"], ...]` |

---

## 常用运维排查

- **检查后台服务状态**：`otus status`
- **打开最新一份报告**：`otus open-latest`
- **后台停止 / 启动**：`otus stop` / `otus daemon`
- **查看归档目录**：`open ~/.otus/reports`
