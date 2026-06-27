# OpenStu：个性化 AI 学习 CLI

## Summary

OpenStu 是面向大学生和成年自学者的开源 TUI 学习工具，支持本地课程资料、官方资料联网检索、个性化诊断和五种学习模式。

技术栈采用 Bun、TypeScript、OpenTUI/Solid、Vercel AI SDK 和本地 SQLite。

## Interaction and Modes

输入区固定为两层：

```text
Plan · First · Review · Noob · Ask
┌──────────────────────────────┐
│ 输入消息…                     │
└──────────────────────────────┘
```

- 模式栏始终位于输入框正上方，当前模式反色高亮。
- `Tab` 向前切换，`Shift+Tab` 反向切换。
- 生成过程中禁止切换，提示用户先按 `Ctrl+C` 取消。
- 切换模式保留输入草稿、对话、资料和课程状态。

五种模式：

- `Plan`：澄清目标并生成可确认的学习路线。
- `First`：首次学习下一个知识点，讲解后立即检查理解。
- `Review`：按薄弱点和 1/3/7/14/30 天间隔复习。
- `Noob`：考前救急，以极简语言快速覆盖高价值考点，不虚增掌握度。
- `Ask`：课程内自由问答，不推进计划、不安排复习、不修改掌握度。

Ask 自动选择回答方式：

- 概念理解、推导、解题：优先苏格拉底式追问。
- 定义、事实、资料位置、操作问题：直接回答。
- Ask 对话会保存，但不作为学习成绩证据。

## Clarification Gate

参照 GitHub Gist `ask-questions-if-underspecified` 实现内部 `request_clarification`，不引入额外 Agent。

- `Plan` 在搜索和生成路线前检查目标、当前水平、考试/截止时间及资料范围。
- `Noob` 在考试范围或剩余时间不明确时触发。
- `Ask` 仅在不同解释会导致明显不同答案时触发。
- `First/Review` 已有明确计划时不主动追问。
- 每次显示一个问题，提供 2–3 个互斥选项、推荐默认值和简短理由。
- 用户可输入 `defaults` 接受剩余推荐值。
- 最多连续询问三个问题；非关键缺失项采用明确展示的默认假设。
- 关键问题未回答前，不搜索、不写计划、不更新学习状态。
- 澄清状态持久化，重启后可以继续。

## Core Interfaces

```ts
type TutorMode = "plan" | "first" | "review" | "noob" | "ask"
type Mastery = "unseen" | "learning" | "familiar" | "mastered"
type AskResponseStyle = "direct" | "socratic"

interface ClarificationRequest {
  question: string
  reason: string
  options: Array<{ label: string; value: string }>
  recommendedValue: string
}

interface Diagnosis {
  topicId: string
  correctness: "incorrect" | "partial" | "correct"
  hintLevel: 0 | 1 | 2
  misconception?: string
  evidence: string
}

interface Citation {
  sourceId: string
  chunkId: string
  locator: string
}
```

模型负责讲解、出题、回答风格选择和结构化诊断；程序负责模式权限、澄清限制、掌握度更新及复习调度。

## Architecture and Data

- `src/tui`：OpenTUI/Solid 界面、输入框、常驻模式栏和流式输出。
- `src/core`：模式状态机、澄清门、学习引擎和复习算法。
- `src/adapters`：模型、SQLite、资料解析、网页获取和 Tavily 搜索。

资料处理：

- MD/TXT 直接读取。
- PDF、DOCX、PPTX 使用 `officeparser`。
- 静态网页使用 `fetch` 和正文提取。
- 按章节、页码或幻灯片切块，约 1500 字符，重叠 150 字符。
- 使用 SQLite FTS5；trigram 不可用时退化为本地子串检索。

`Plan` 使用 Tavily BYOK 搜索官方 syllabus。候选来源必须由用户确认后导入；网页内容视为不可信输入，不能修改系统行为。

密钥只读取环境变量；课程、资料、对话、澄清状态、诊断和呈现偏好全部保存在本机 SQLite。

## CLI

- `openstu`
- `openstu <文件|目录|URL>...`
- `/course`
- `/add`
- `/mode`
- `/sources`
- `/progress`
- `/style`
- `/model`
- `/help`
- `/quit`

## Test Plan

- 验证五模式顺序、Tab/Shift+Tab、常驻模式栏、生成中禁止切换及草稿保留。
- 验证各模式下澄清门应触发和不应触发的场景，以及三问上限和 `defaults`。
- 验证 Ask 的 direct/socratic 分类和不更新掌握度约束。
- 验证掌握度转换、复习间隔和 Noob 不提升掌握度。
- 验证资料解析、引用、中英文检索及损坏文件隔离。
- 使用假模型和临时 SQLite 完成 Plan → First → Ask → Review → 重启恢复。
- CI 运行类型检查、`bun test`，并构建 Windows、macOS、Linux 独立二进制。

## Assumptions

- 项目名和二进制名为 `openstu`，许可证为 MIT。
- 不包含 OCR、音视频、登录网页、向量数据库、多 Agent、云同步或默认遥测。
