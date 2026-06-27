# OpenStu：个性化 AI 学习 CLI

## Summary

OpenStu 是面向大学生和成年自学者的开源 TUI 学习工具。它保留 Plan、First、Review、Noob、Ask 五种模式、本地资料、官方资料搜索、多模型接入和本地 SQLite，核心卖点是可审计、可拒绝的动态诊断，而不是单次模型判断。

技术栈采用 Bun、TypeScript、OpenTUI/Solid、Vercel AI SDK 和 SQLite。开发流程中的阶段统一称为 implementation phase，避免与产品内 Plan mode 混淆。

## Interaction and Modes

输入区固定显示当前模式和三行输入框：

```text
● FIRST                         Tab 切换模式
╭────────────────────────────────────╮
│ 输入消息…                           │
│                                    │
│                                    │
╰────────────────────────────────────╯
```

- 模式徽章始终位于输入框正上方，只显示当前模式并使用主题色高亮。
- `Tab` 向前切换，`Shift+Tab` 反向切换。
- 输入框使用三行 textarea；`Enter` 发送，`Shift+Enter` 换行。
- 生成过程中禁止切换，提示先按 `Ctrl+C` 取消。
- 切换模式保留输入草稿、对话、资料和课程状态。
- 模式切换只记录事件，不直接改变学习阶段。
- 顶栏使用绿色或红色圆点显示模型连接状态。
- TUI 使用圆角边框、粗体徽章和克制的主题色。字体由终端控制，推荐 Cascadia Mono；应用不声称能够设置终端字体。

五种模式：

- `Plan`：澄清目标并生成可确认的学习路线。重新规划复用稳定知识点，不删除已有进度。
- `First`：有前置知识时先做预测或直觉题，再微讲解和检查；无前置知识时先微讲解再检查。
- `Review`：优先选择到期或薄弱知识点；阶段较高时使用迁移题，而非只做原句回忆。
- `Noob`：考前救急，以极简语言覆盖高价值考点。接触记录单独保存，不影响正式学习状态。
- `Ask`：课程内自由问答，不推进计划、不安排复习、不修改学习状态。

Ask 对概念理解、推导和解题优先使用苏格拉底式追问；对定义、事实、资料位置和操作问题直接回答。Ask 对话会保存，但不作为学习证据。

## Clarification Gate

参照 `ask-questions-if-underspecified` 实现内部 `request_clarification`，不引入额外 Agent。

- `Plan` 在搜索和生成路线前检查目标、当前水平、考试或截止时间及资料范围。
- `Noob` 在考试范围或剩余时间不明确时触发。
- `Ask` 仅在不同解释会产生明显不同答案时触发。
- `First/Review` 已有明确计划时不主动追问。
- 每次显示一个问题，提供 2–3 个互斥选项、推荐默认值和简短理由。
- 用户可输入 `defaults` 接受剩余推荐值。
- 最多连续询问三个问题；非关键缺失项采用明确展示的默认假设。
- 关键问题未回答前，不搜索、不写计划、不更新学习状态。
- 澄清状态持久化，重启后可以继续。

## Model Onboarding and Capabilities

无可用模型时不静默回退到 Ollama。TUI 进入模型配置状态，说明缺失项和连接错误。

`/model` 向导支持选择 provider、model、base URL，并以遮罩方式输入 API Key。通过界面输入的密钥只保存在当前进程内；长期配置仍使用环境变量，密钥不写入 SQLite 或配置文件。配置成功后立即重建模型客户端并执行能力检查。

```ts
interface ModelCapabilities {
  streaming: boolean
  structuredOutput: boolean
  toolCalling: boolean
  jsonSchema: boolean
  local: boolean
}
```

- provider 必须显式创建；不使用字符串模型 ID 触发默认 Gateway。
- OpenAI-compatible 使用 `createOpenAICompatible`。
- Anthropic 和 Google 使用各自 provider 包。
- Ollama 作为 OpenAI-compatible 本地端点接入，但能力以实际探测结果为准。
- 普通 Ask 可在只有 streaming 时运行。
- Plan 确认和诊断更新要求 structured output；能力不足时允许继续聊天，但明确禁止更新学习状态。
- `/model` 显示当前 provider、model、base URL、能力矩阵和最近连接错误。

## Assessments and Dynamic Diagnosis

每道会影响学习状态的检查题必须先持久化 rubric，再接收学生回答。rubric 包含稳定 ID、题型、预期答案摘要和评分条件，避免模型在看到回答后改变标准。

```ts
type Correctness = "incorrect" | "partial" | "correct"
type StateChangeReason =
  | "correct_no_hint"
  | "correct_with_hint"
  | "partial"
  | "incorrect"
  | "noob_exposure"

interface AssessmentRubric {
  id: string
  topicId: string
  questionType: "recall" | "application" | "transfer" | "prerequisite_probe"
  expectedAnswerSummary: string
  criteria: string[]
  schemaVersion: number
}

interface DiagnosisCandidate {
  topicId: string
  rubricId: string
  correctness: Correctness
  hintLevel: 0 | 1 | 2
  confidence: number
  observedAnswerSummary: string
  diagnosisReason: string
  evidenceQuotes: string[]
  misconception?: string
}

interface ValidatedDiagnosis extends DiagnosisCandidate {
  expectedAnswerSummary: string
  stateChange: {
    fromStage: number
    toStage: number
    reason: StateChangeReason
  }
}
```

程序只接受同时满足以下条件的诊断：

- `confidence >= 0.75`。
- topic 和 rubric 与当前待答题一致。
- 至少一条 evidence quote 是学生原回答的精确子串。
- correctness、hintLevel 和字段结构通过 schema 校验。
- 当前模型通过 structured output 能力检查。

不通过的诊断保存为无效审计记录，但不更新学习状态。模型只输出诊断事实；程序计算并保存 state change：

- 无提示正确：阶段加一，最高为 4。
- 提示后正确：阶段不变。
- 部分正确：阶段减一，最低为 0。
- 错误：阶段归零。
- Noob：只写 exposure，不进入正式诊断转换。

## Progress and Review Scheduling

数据库只保存 `stage`、`attemptCount`、`lastResult` 和 `dueAt`。Mastery 不入库，按以下规则派生：

```ts
attemptCount === 0 ? "unseen"
  : stage === 0 ? "learning"
  : stage <= 2 ? "familiar"
  : "mastered"
```

stage 必须满足 `0 <= stage <= 4`。默认间隔仍为 1/3/7/14/30 天，但 dueAt 采用 deadline-aware 调整：

1. 取得当前阶段默认间隔。
2. 将剩余时间按剩余检查点均分。
3. 使用二者中较短的间隔。
4. dueAt 不得晚于 deadline；deadline 缺失时使用默认间隔，已过期时标记为立即到期。

阶段 2 及以上优先安排 application 或 transfer 题。只答对结论但理由违反 rubric 时不得判为无提示正确。

## State Changes, Transactions, and Cancellation

不引入完整事件溯源。现有纯函数 reducer 负责计算状态；数据库事务负责原子提交；`learning_events` 只作为审计日志。

正式回答成功时，在一个事务内完成：

1. 保存用户回答并标记为学习证据。
2. 保存与既有 rubric 关联的验证后 diagnosis。
3. 更新 topic stage、lastResult 和 dueAt。
4. 更新 plan item 状态。
5. 追加 `diagnosis_validated` 事件。

低置信度或无效诊断只保存非学习证据回答、无效 diagnosis 和拒绝原因。Ask 与 Noob 不进入正式事务路径。

流式回答先保存在内存中。完成后才保存 complete assistant message。按 `Ctrl+C` 取消时保存已显示文本为 canceled message，不写诊断、不更新 topic、不形成学习证据。模型错误和限流遵循同一边界。

## Plan Stability and Data Model

SQLite v2 迁移增加：

- `rubrics`：题目评分标准和 schema version。
- `noob_exposures`：独立的 Noob 接触记录。
- `learning_events`：source_imported、plan_confirmed、attempt_submitted、diagnosis_validated、mode_switched、replan_requested。
- message status：complete、canceled、error。
- attempt audit：diagnosis schema version、provider、model、prompt version、validated 和拒绝原因。
- topic：稳定 `topicKey`、topic version、stage 约束、lastResult 和 dueAt。
- chunk：content hash 和去重约束。

topicKey 由课程内规范化标题生成。重新确认 Plan 时对相同 topicKey 执行 upsert，保留学习进度；移出新计划的知识点只归档，不删除历史。plan version 每次确认递增。

Mastery 始终在读取时派生，避免与 stage 产生矛盾状态。

## Sources and Retrieval

```ts
type SourceTrust =
  | "official"
  | "instructor"
  | "institution"
  | "textbook"
  | "third_party"
  | "unknown"

interface SourceMetadata {
  trust: SourceTrust
  courseVersion?: string
  institution?: string
  term?: string
}
```

- MD/TXT 直接读取；PDF、DOCX、PPTX 使用 officeparser；静态网页使用 fetch 和正文提取。
- source content hash 防止重复导入，chunk hash 防止重复片段。
- 切块优先保留标题层级、页码或幻灯片号、小节、围栏代码块、公式附近文本和完整表格，再以约 1500 字符作为上限并保留少量重叠。
- 解析失败按文件隔离，不影响同批其他资料。
- Tavily 候选展示 trust、域名、日期、courseVersion、institution、term 和摘要；用户确认后才导入。
- 网页内容始终作为不可信输入，不能修改系统行为。
- FTS5 同时维护 trigram 和 unicode61 索引，按查询文字选择：CJK 走 trigram，其他语言走 unicode61；trigram 不可用时 CJK 直接退化为本地 substring。

## Presentation Preferences

`/style` 管理的是交互舒适度，不是学习类型。系统不得声称用户是“例子型”“视觉型”等学习者。

内置三套视觉主题并按课程持久化：

- `cyan`：青色，默认主题。
- `violet`：紫色。
- `amber`：琥珀色。

使用 `/style theme=cyan|violet|amber` 切换。主题只改变强调色、边框和状态颜色，不改变学习策略。

- 低风险呈现偏好可以一键确认。
- 学习策略、掌握度和复习规则变化必须显示理由并由用户确认。
- 同一建议可选择本课程不再询问。
- 建议可以基于可观察行为，例如连续三次在长解释后跳过作答，但不能推断固定学习风格。

## CLI and Installation

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

Windows 本地安装构建独立可执行文件到 `%USERPROFILE%\.bun\bin\openstu.exe`。该目录已位于用户 PATH。安装完成必须通过全新进程执行 `cmd.exe /d /c "openstu --version"` 和 `cmd.exe /d /c "openstu --help"`。

发布仍保留 Windows、macOS、Linux 构建。Windows 终端兼容性至少覆盖 Windows Terminal、PowerShell、cmd 和 VS Code terminal；macOS/Linux CI 分别进行原生构建和二进制 smoke test。

## Test Plan

- 五模式顺序、Tab/Shift+Tab、常驻当前模式徽章、生成中禁止切换和草稿保留。
- 三套主题、只显示当前模式、三行输入框、Enter 发送和 Shift+Enter 换行。
- 澄清门触发条件、三问上限和 `defaults`。
- Ask direct/socratic 分类及不更新学习状态。
- v1 到 v2 数据迁移、stage 约束、Mastery 派生、重排 Plan 后进度保留。
- deadline-aware 调度、迁移题选择和 Noob exposure 隔离。
- 取消、模型错误、限流和无效诊断均不产生状态更新。
- MD/TXT/PDF/DOCX/PPTX 解析、结构切块、引用、source/chunk 去重、CJK 检索和损坏文件隔离。
- provider 显式创建、无模型配置状态、TUI 临时密钥、能力不足时禁止诊断更新。
- 诊断 fixture 覆盖：表达差但正确、部分正确、猜对结论但理由错误、提示后正确、中英文混答、自信胡说和无效 evidence quote。
- 假模型和临时 SQLite 完成 Plan → First → Ask → Review → 重启恢复。
- 类型检查、`bun test`、独立二进制构建及新 CMD 全局命令 smoke test。

## Implementation Order

1. 恢复可用性：全局 `openstu` 命令、模型配置向导、连接和能力错误提示。
2. 修复状态污染：SQLite v2、事务边界、取消语义、Mastery 派生、Noob 隔离和稳定 topic。
3. 强化学习核心：持久 rubric、诊断验证、First 分阶段流程和 deadline-aware Review。
4. 强化资料系统：source metadata、结构切块、chunk hash 和 CJK fallback。
5. 补齐诊断质量、迁移、取消、集成、终端和发布测试。

## Assumptions

- 保留现有五模式、Tavily、DOCX/PPTX、Ollama、多课程和全平台二进制，不缩减功能。
- 项目名和二进制名为 `openstu`，许可证为 MIT。
- 不包含 OCR、音视频、登录网页、向量数据库、多 Agent、云同步或默认遥测。
- API Key 仅来自环境变量或当前 TUI 进程内存，不持久化。
