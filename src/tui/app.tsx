import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { render, useKeyboard, useRenderer } from "@opentui/solid"
import { SyntaxStyle, type TextareaRenderable } from "@opentui/core"
import { MODES, THEMES, type TutorMode, type VisualTheme } from "../core/types"
import { modeLabel, switchMode } from "../core/modes"
import type { CourseRecord, MessageRecord, OpenStuDatabase, StylePreferences } from "../adapters/database"
import { defaultModel, type ModelConfig, type ModelProvider, type TutorModel } from "../adapters/model"
import type { TutorService } from "../core/tutor"
import type { SourceService } from "../core/source-service"
import { searchOfficialSources } from "../adapters/search"

interface DisplayMessage {
  id: string
  role: MessageRecord["role"]
  content: string
}

interface ModelSetup {
  step: "provider" | "model" | "baseURL" | "key"
  config: Partial<ModelConfig>
}

export interface AppProps {
  database: OpenStuDatabase
  tutor: TutorService
  model: TutorModel
  sourceService: SourceService
  initialCourse: CourseRecord
  initialSessionId: string
  initialNotices?: string[]
}

export function OpenStuApp(props: AppProps) {
  const renderer = useRenderer()
  let composer: TextareaRenderable | undefined
  const syntaxStyle = SyntaxStyle.create()
  onCleanup(() => syntaxStyle.destroy())
  const [course, setCourse] = createSignal(props.initialCourse)
  const [sessionId, setSessionId] = createSignal(props.initialSessionId)
  const [mode, setMode] = createSignal<TutorMode>(props.initialCourse.mode)
  const [draft, setDraft] = createSignal("")
  const [style, setStyle] = createSignal(props.database.getStylePreferences(props.initialCourse.id))
  const [modelSetup, setModelSetup] = createSignal<ModelSetup>()
  const [modelRevision, setModelRevision] = createSignal(0)
  const [generating, setGenerating] = createSignal(false)
  const [notice, setNotice] = createSignal("Tab 切换模式 · Ctrl+D 退出")
  const [abortController, setAbortController] = createSignal<AbortController>()
  const [messages, setMessages] = createSignal<DisplayMessage[]>([
    ...(props.initialNotices ?? []).map((content) => ({ id: crypto.randomUUID(), role: "system" as const, content })),
    ...props.database.listMessages(props.initialSessionId).map(({ id, role, content }) => ({ id, role, content })),
  ])
  const palette = () => PALETTES[style().theme]
  const modelView = () => {
    modelRevision()
    return props.model.config
  }
  onMount(() => composer?.focus())

  const changeMode = (direction: -1 | 1) => {
    const result = switchMode(mode(), direction, generating())
    if (!result.changed) {
      setNotice(result.notice!)
      return
    }
    setMode(result.mode)
    props.database.setCourseMode(course().id, result.mode)
    props.database.setSessionMode(sessionId(), result.mode)
    props.database.recordEvent(course().id, sessionId(), "mode_switched", { mode: result.mode })
    setNotice(`已切换到 ${modeLabel(result.mode)} 模式`)
  }

  useKeyboard((key) => {
    if (key.name === "tab") {
      key.preventDefault()
      key.stopPropagation()
      changeMode(key.shift ? -1 : 1)
    }
    if (key.ctrl && key.name === "c" && generating()) {
      key.preventDefault()
      abortController()?.abort()
      setNotice("已取消当前回答")
    }
    if (key.ctrl && key.name === "d") {
      key.preventDefault()
      renderer.destroy()
    }
  })

  const appendMessage = (role: DisplayMessage["role"], content: string, id = crypto.randomUUID()) => {
    setMessages((current) => [...current, { id, role, content }])
    return id
  }

  const updateMessage = (id: string, content: string) => {
    setMessages((current) => current.map((message) => (message.id === id ? { ...message, content } : message)))
  }

  const submit = async (value: string) => {
    const text = value.trim()
    if (!text || generating()) return
    setDraft("")
    if (text.startsWith("/")) {
      await handleCommand(text)
      return
    }
    if (modelSetup()) {
      await handleModelSetup(text)
      return
    }

    appendMessage("user", text)
    const assistantId = appendMessage("assistant", "")
    const controller = new AbortController()
    setAbortController(controller)
    setGenerating(true)
    setNotice(`${modeLabel(mode())} 正在生成…`)
    let streamed = ""
    let streamTimer: ReturnType<typeof setTimeout> | undefined
    const flushStream = () => {
      streamTimer = undefined
      updateMessage(assistantId, streamed)
    }
    try {
      const result = await props.tutor.handleTurn({
        courseId: course().id,
        sessionId: sessionId(),
        mode: mode(),
        text,
        signal: controller.signal,
        onDelta(delta) {
          streamed += delta
          streamTimer ??= setTimeout(flushStream, 80)
        },
      })
      if (streamTimer) clearTimeout(streamTimer)
      updateMessage(assistantId, result.text)
      if (result.notice) appendMessage("system", result.notice)
      setNotice(result.citations.length ? `引用 ${result.citations.length} 个资料片段` : "回答完成")
    } catch (error) {
      const cancelled = controller.signal.aborted
      if (streamTimer) clearTimeout(streamTimer)
      updateMessage(assistantId, cancelled ? `${streamed}\n\n[已取消]`.trim() : `错误：${formatError(error)}`)
      setNotice(cancelled ? "已取消当前回答，学习状态未更新" : "请求失败，学习状态未更新")
    } finally {
      setGenerating(false)
      setAbortController(undefined)
    }
  }

  const startModelSetup = () => {
    setModelSetup({ step: "provider", config: {} })
    appendMessage(
      "system",
      "选择模型服务：\n1. OpenAI-compatible（OpenAI、DeepSeek 等）\n2. Anthropic\n3. Google Gemini\n4. Ollama（本地）\n\n输入序号或名称；输入 /model cancel 取消。",
    )
    setNotice("模型配置 · 选择 provider")
  }

  const handleModelSetup = async (text: string) => {
    const setup = modelSetup()
    if (!setup) return
    if (setup.step === "provider") {
      const provider = parseProvider(text)
      if (!provider) {
        appendMessage("system", "无法识别 provider，请输入 1–4 或 provider 名称。")
        return
      }
      setModelSetup({ step: "model", config: { provider, model: defaultModel(provider) } })
      appendMessage("system", `输入模型名，或输入 default 使用 ${defaultModel(provider)}。`)
      setNotice("模型配置 · 模型名")
      return
    }

    const provider = setup.config.provider!
    if (setup.step === "model") {
      const model = text.toLowerCase() === "default" ? defaultModel(provider) : text
      const config = { ...setup.config, model }
      if (provider === "openai-compatible" || provider === "ollama") {
        const defaultURL = provider === "ollama" ? "http://localhost:11434/v1" : "https://api.openai.com/v1"
        setModelSetup({ step: "baseURL", config })
        appendMessage("system", `输入 API Base URL，或输入 default 使用 ${defaultURL}。`)
        setNotice("模型配置 · Base URL")
      } else {
        setModelSetup({ step: "key", config })
        appendMessage("system", "粘贴 API Key。输入内容会隐藏，且只保存在当前进程内。")
        setNotice("模型配置 · 临时 API Key")
      }
      return
    }

    if (setup.step === "baseURL") {
      const defaultURL = provider === "ollama" ? "http://localhost:11434/v1" : "https://api.openai.com/v1"
      const baseURL = text.toLowerCase() === "default" ? defaultURL : text
      if (!isHttpURL(baseURL)) {
        appendMessage("system", "Base URL 必须是 http:// 或 https:// 地址。")
        return
      }
      const config = { ...setup.config, baseURL }
      if (provider === "ollama") await finishModelSetup(config as ModelConfig)
      else {
        setModelSetup({ step: "key", config })
        appendMessage("system", "粘贴 API Key。输入内容会隐藏，且只保存在当前进程内。")
        setNotice("模型配置 · 临时 API Key")
      }
      return
    }

    await finishModelSetup(setup.config as ModelConfig, text)
  }

  const finishModelSetup = async (config: ModelConfig, apiKey?: string) => {
    setModelSetup(undefined)
    setGenerating(true)
    setNotice("正在连接并检查模型能力…")
    try {
      props.model.configure(config, apiKey)
      const capabilities = await props.model.checkCapabilities()
      setModelRevision((value) => value + 1)
      appendMessage(
        "system",
        `模型已连接：${config.provider}/${config.model}\nstreaming=${capabilities.streaming} · structuredOutput=${capabilities.structuredOutput} · jsonSchema=${capabilities.jsonSchema}${capabilities.structuredOutput ? "" : "\n当前模型可聊天，但诊断和计划确认不会更新状态。"}`,
      )
      setNotice("模型已连接")
    } catch (error) {
      setModelRevision((value) => value + 1)
      appendMessage("system", formatError(error))
      setNotice("模型连接失败；输入 /model 重试")
    } finally {
      setGenerating(false)
    }
  }

  const handleCommand = async (text: string) => {
    const [command, ...parts] = text.slice(1).split(/\s+/)
    const argument = parts.join(" ").trim()
    if (command === "quit") return renderer.destroy()
    if (command === "help") {
      appendMessage("system", HELP)
      return
    }
    if (command === "mode") {
      const requested = argument.toLowerCase() as TutorMode
      if (!MODES.includes(requested)) {
        appendMessage("system", `可用模式：${MODES.join(", ")}`)
        return
      }
      setMode(requested)
      props.database.setCourseMode(course().id, requested)
      props.database.setSessionMode(sessionId(), requested)
      props.database.recordEvent(course().id, sessionId(), "mode_switched", { mode: requested })
      setNotice(`已切换到 ${modeLabel(requested)} 模式`)
      return
    }
    if (command === "course") {
      handleCourseCommand(argument)
      return
    }
    if (command === "sources") {
      const sources = props.database.listSources(course().id)
      appendMessage("system", sources.length ? sources.map((source) => `- ${source.title} · ${source.kind} · ${source.metadata.trust}\n  ${source.uri}`).join("\n") : "还没有资料。使用 /add <路径或 URL> 导入。")
      return
    }
    if (command === "progress") {
      const topics = props.database.listPlan(course().id)
      appendMessage(
        "system",
        topics.length
          ? topics.map((topic, index) => `${index + 1}. [${topic.status}] ${topic.title} · 阶段 ${topic.stage}${topic.dueAt ? ` · ${topic.dueAt.slice(0, 10)}` : ""}`).join("\n")
          : "还没有已确认的计划。",
      )
      return
    }
    if (command === "style") {
      handleStyleCommand(argument)
      return
    }
    if (command === "model") {
      if (argument === "cancel") {
        setModelSetup(undefined)
        setNotice("已取消模型配置")
      } else if (!props.model.config || argument === "setup") {
        startModelSetup()
      } else {
        const config = props.model.config
        appendMessage(
          "system",
          `当前模型：${config.provider}/${config.model}${config.baseURL ? `\n${config.baseURL}` : ""}\nconnected=${props.model.connected} · streaming=${props.model.capabilities.streaming} · structuredOutput=${props.model.capabilities.structuredOutput}${props.model.lastError ? `\n${props.model.lastError}` : ""}\n输入 /model setup 重新配置。`,
        )
      }
      return
    }
    if (command === "add") {
      await handleAddCommand(argument)
      return
    }
    appendMessage("system", `未知命令：/${command}\n输入 /help 查看帮助。`)
  }

  const handleCourseCommand = (argument: string) => {
    if (!argument) {
      appendMessage("system", props.database.listCourses().map((item) => `- ${item.name}${item.id === course().id ? "（当前）" : ""}`).join("\n"))
      return
    }
    const isNew = argument.startsWith("new ")
    const name = isNew ? argument.slice(4).trim() : argument
    const next = isNew
      ? props.database.createCourse(name)
      : props.database.listCourses().find((item) => item.name.toLowerCase() === name.toLowerCase())
    if (!next) {
      appendMessage("system", `找不到课程：${name}。使用 /course new <名称> 创建。`)
      return
    }
    const nextSession = props.database.createSession(next.id, next.mode)
    setCourse(next)
    setSessionId(nextSession)
    setMode(next.mode)
    setStyle(props.database.getStylePreferences(next.id))
    setMessages([{ id: crypto.randomUUID(), role: "system", content: `已进入课程：${next.name}` }])
  }

  const handleStyleCommand = (argument: string) => {
    const style = props.database.getStylePreferences(course().id)
    if (!argument) {
      appendMessage("system", Object.entries(style).map(([key, value]) => `${key}=${value}`).join("\n"))
      return
    }
    const [key, value] = argument.split("=", 2)
    if (!value || !(key in style)) {
      appendMessage("system", "格式：/style <theme|sequence|verbosity|stepSize|challenge|analogyDensity>=<值>")
      return
    }
    if (key === "theme" && !THEMES.includes(value as VisualTheme)) {
      appendMessage("system", `可用主题：${THEMES.join(", ")}`)
      return
    }
    props.database.updateStylePreference(course().id, key as keyof StylePreferences, value)
    setStyle(props.database.getStylePreferences(course().id))
    appendMessage("system", `已更新 ${key}=${value}`)
  }

  const handleAddCommand = async (argument: string) => {
    if (!argument) {
      appendMessage("system", "格式：/add <文件、目录或 URL>；联网搜索：/add search <课程名>")
      return
    }
    if (argument.startsWith("search ")) {
      try {
        setNotice("正在搜索官方资料…")
        const candidates = await searchOfficialSources(argument.slice(7))
        appendMessage(
          "system",
          candidates.length
            ? `候选资料尚未导入，请核对后使用 /add <URL> 确认：\n\n${candidates.map((candidate, index) => `${index + 1}. ${candidate.title}\n${[candidate.sourceTrust, candidate.institution, candidate.courseVersion, candidate.term, candidate.publishedDate].filter(Boolean).join(" · ")}\n${candidate.url}\n${candidate.content}`).join("\n\n")}`
            : "没有找到候选资料。",
        )
      } catch (error) {
        appendMessage("system", `搜索失败：${formatError(error)}`)
      } finally {
        setNotice("搜索完成")
      }
      return
    }

    setGenerating(true)
    try {
      const results = await props.sourceService.import(course().id, [argument], setNotice)
      appendMessage(
        "system",
        results.map((result) => result.status === "imported" ? `已导入 ${result.title}（${result.chunks} 个片段）` : `导入失败 ${result.input}：${result.error}`).join("\n"),
      )
    } finally {
      setGenerating(false)
      setNotice("导入完成")
    }
  }

  return (
    <box flexDirection="column" width="100%" height="100%" padding={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={palette().accent}><strong>OpenStu</strong> · {course().name}</text>
        <text fg={props.model.connected ? "#79c99e" : "#e06c75"}>
          {props.model.connected ? "●" : "●"} {modelView() ? `${modelView()!.provider}/${modelView()!.model}` : "未连接 · /model"}
        </text>
      </box>

      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" border borderStyle="rounded" borderColor={palette().border} padding={1}>
        <For each={messages()}>
          {(message) => (
            <box flexDirection="column" marginBottom={1}>
              <text fg={message.role === "user" ? palette().user : message.role === "assistant" ? palette().accent : palette().muted}>
                <strong>{message.role === "user" ? "You" : message.role === "assistant" ? "OpenStu" : "System"}</strong>
              </text>
              <Show when={message.content} fallback={<text fg={palette().muted}>…</text>}>
                <markdown content={message.content} conceal={false} syntaxStyle={syntaxStyle} />
              </Show>
            </box>
          )}
        </For>
      </scrollbox>

      <box flexDirection="column">
        <box flexDirection="row" justifyContent="space-between">
          <text fg={palette().badgeText} bg={palette().accent}>
            <strong>{` ● ${modeLabel(mode()).toUpperCase()} `}</strong>
          </text>
          <text fg={palette().muted}>Tab / Shift+Tab 切换模式</text>
        </box>
        <box border borderStyle="rounded" borderColor={palette().border} paddingLeft={1} paddingRight={1} height={5} marginTop={1}>
          <textarea
            ref={(value) => {
              composer = value
            }}
            initialValue=""
            onContentChange={() => setDraft(composer?.plainText ?? "")}
            onSubmit={() => {
              const value = composer?.plainText ?? ""
              composer?.clear()
              void submit(value)
            }}
            onKeyDown={(key) => {
              if (key.name !== "tab") return
              key.preventDefault()
              key.stopPropagation()
              changeMode(key.shift ? -1 : 1)
            }}
            keyBindings={COMPOSER_KEY_BINDINGS}
            placeholder={modelSetup()?.step === "key" ? "粘贴 API Key（不会保存）" : generating() ? "生成中，Ctrl+C 取消…" : "输入消息或 /help"}
            placeholderColor={palette().muted}
            backgroundColor={palette().inputBackground}
            focusedBackgroundColor={palette().inputBackground}
            textColor={modelSetup()?.step === "key" ? palette().inputBackground : palette().text}
            focusedTextColor={modelSetup()?.step === "key" ? palette().inputBackground : palette().text}
            focused={!generating()}
            width="100%"
            height={3}
          />
        </box>
        <text fg={palette().muted}>{notice()} · Enter 发送 · Shift+Enter 换行</text>
      </box>
    </box>
  )
}

export async function runTui(props: AppProps, onDestroy?: () => void): Promise<void> {
  await render(() => <OpenStuApp {...props} />, { exitOnCtrlC: false, targetFps: 30, onDestroy })
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const COMPOSER_KEY_BINDINGS: Array<{
  name: string
  shift?: boolean
  action: "submit" | "newline"
}> = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "kpenter", shift: true, action: "newline" },
]

const PALETTES: Record<
  VisualTheme,
  { accent: string; border: string; muted: string; text: string; user: string; badgeText: string; inputBackground: string }
> = {
  cyan: {
    accent: "#65d5c7",
    border: "#3a776f",
    muted: "#778190",
    text: "#cbd2dc",
    user: "#eed49f",
    badgeText: "#071814",
    inputBackground: "#0d1117",
  },
  violet: {
    accent: "#b7a5ff",
    border: "#66599c",
    muted: "#7f8292",
    text: "#d2d0df",
    user: "#f0c6c6",
    badgeText: "#130c2b",
    inputBackground: "#101018",
  },
  amber: {
    accent: "#efbd73",
    border: "#87683b",
    muted: "#857c70",
    text: "#d7d0c5",
    user: "#9fd3c7",
    badgeText: "#231506",
    inputBackground: "#14110d",
  },
}

function parseProvider(value: string): ModelProvider | undefined {
  const normalized = value.trim().toLowerCase()
  return {
    "1": "openai-compatible",
    openai: "openai-compatible",
    "openai-compatible": "openai-compatible",
    "2": "anthropic",
    anthropic: "anthropic",
    "3": "google",
    google: "google",
    gemini: "google",
    "4": "ollama",
    ollama: "ollama",
  }[normalized] as ModelProvider | undefined
}

function isHttpURL(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

const HELP = `/course — 列出课程
/course new <名称> — 新建课程
/add <路径或 URL> — 导入资料
/add search <课程名> — 搜索官方资料候选
/mode <plan|first|review|noob|ask> — 切换模式
/sources — 查看资料
/progress — 查看学习计划
/style theme=<cyan|violet|amber> — 切换主题
/style [键=值] — 查看或修改呈现偏好
/model — 查看或连接模型
/model setup — 重新连接模型
/help — 查看帮助
/quit — 退出`
