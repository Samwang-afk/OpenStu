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
import type { StartupDecision, StartupOptionBox } from "../core/startup"
import { classifyAskResponseStyle } from "../core/clarification"
import { ACTION_REGISTRY, type ActionDefinition, isActionAvailable } from "./actions"

interface DisplayMessage {
  id: string
  role: MessageRecord["role"]
  content: () => string
  setContent: (content: string) => void
}

interface ModelSetup {
  step: "provider" | "model" | "baseURL" | "key"
  config: Partial<ModelConfig>
}

interface OnboardingFlow {
  type: "create_subject" | "switch_subject" | "add_materials"
}

export interface AppProps {
  database: OpenStuDatabase
  tutor: TutorService
  model: TutorModel
  sourceService: SourceService
  initialCourse: CourseRecord | null
  initialSessionId: string | null
  initialNotices?: string[]
  initialDecision?: StartupDecision | null
}

interface PaletteAction {
  label: string
  handler: () => void
}

function createDisplayMessage(
  role: DisplayMessage["role"],
  initialContent: string,
  id: string = crypto.randomUUID(),
): DisplayMessage {
  const [content, setContent] = createSignal(initialContent)
  return { id, role, content, setContent }
}

export function OpenStuApp(props: AppProps) {
  const renderer = useRenderer()
  let composer: TextareaRenderable | undefined
  const syntaxStyle = SyntaxStyle.fromStyles({
    default: {},
    markup: {},
    "markup.heading": { bold: true },
    "markup.strong": { bold: true },
    "markup.italic": { italic: true },
    "markup.link": { underline: true },
  })
  onCleanup(() => syntaxStyle.destroy())

  const [course, setCourse] = createSignal<CourseRecord | null>(props.initialCourse)
  const [sessionId, setSessionId] = createSignal<string | null>(props.initialSessionId)
  const [mode, setMode] = createSignal<TutorMode>(props.initialCourse?.mode ?? "ask")
  const [draft, setDraft] = createSignal("")
  const [style, setStyle] = createSignal(
    props.initialCourse ? props.database.getStylePreferences(props.initialCourse.id) : FALLBACK_STYLE,
  )
  const [modelSetup, setModelSetup] = createSignal<ModelSetup>()
  const [onboardingFlow, setOnboardingFlow] = createSignal<OnboardingFlow>()
  const [modelRevision, setModelRevision] = createSignal(0)
  const [generating, setGenerating] = createSignal(false)
  const [notice, setNotice] = createSignal("Ctrl+X Actions · Enter 发送 · Shift+Enter 换行")
  const [abortController, setAbortController] = createSignal<AbortController>()
  const [messages, setMessages] = createSignal<DisplayMessage[]>([
    ...(props.initialNotices ?? []).map((content) => createDisplayMessage("system", content)),
    ...(props.initialSessionId ? props.database.listMessages(props.initialSessionId).map(({ id, role, content }) => createDisplayMessage(role, content, id)) : []),
  ])

  const [paletteOpen, setPaletteOpen] = createSignal(false)
  const [paletteFilter, setPaletteFilter] = createSignal("")
  const [paletteIndex, setPaletteIndex] = createSignal(0)

  const [startupChoice, setStartupChoice] = createSignal<StartupOptionBox | null>(
    props.initialDecision?.type === "choice" ? props.initialDecision : null,
  )
  const [startupChoiceIndex, setStartupChoiceIndex] = createSignal(0)
  const [pendingDefaultAction, setPendingDefaultAction] = createSignal<string | null>(
    props.initialDecision?.type === "message" ? (props.initialDecision.defaultAction ?? null) : null,
  )

  const palette = () => PALETTES[style().theme]
  const modelView = () => {
    modelRevision()
    return props.model.config
  }

  const statusOnline = () => props.model.connected
  const subjectDisplay = () => (course() ? course()!.name : "No Subject")

  onMount(() => {
    composer?.focus()
    if (props.initialDecision?.type === "message") {
      appendMessage("system", props.initialDecision.content)
    }
  })

  const changeMode = (direction: -1 | 1) => {
    if (!course()) return
    const result = switchMode(mode(), direction, generating())
    if (!result.changed) {
      setNotice(result.notice!)
      return
    }
    setMode(result.mode)
    props.database.setCourseMode(course()!.id, result.mode)
    props.database.setSessionMode(sessionId()!, result.mode)
    props.database.recordEvent(course()!.id, sessionId()!, "mode_switched", { mode: result.mode })
    setNotice(`已切换到 ${modeLabel(result.mode)} 模式`)
  }

  const paletteHandler = (action: ActionDefinition): (() => void) => {
    const context = { hasCourse: !!course(), hasCourses: props.database.listCourses().length > 0 }
    if (!isActionAvailable(action, context)) {
      return () => {
        closePalette()
        appendMessage("system", "请先创建或选择一个课程，然后才能使用此功能。")
      }
    }
    switch (action.id) {
      case "switch_course": return () => { closePalette(); startSwitchSubjectFlow() }
      case "create_course": return () => { closePalette(); startCreateSubjectFlow() }
      case "add_materials": return () => { closePalette(); startAddMaterialsFlow() }
      case "configure_provider": return () => { closePalette(); void startModelSetup() }
      case "view_progress": return () => { closePalette(); viewProgressAction() }
      case "view_sources": return () => { closePalette(); viewSourcesAction() }
      case "make_plan": return () => { closePalette(); planAction() }
      case "exam_review": return () => { closePalette(); examReviewAction() }
      case "change_style": return () => { closePalette(); changeStyleAction() }
      case "help": return () => { closePalette(); appendMessage("system", HELP) }
      case "quit": return () => renderer.destroy()
      default: return () => {}
    }
  }

  const getPaletteActions = (): PaletteAction[] =>
    ACTION_REGISTRY.map((action) => ({ label: action.label, handler: paletteHandler(action) }))

  const filteredActions = () => {
    const filter = paletteFilter().toLowerCase()
    const all = getPaletteActions()
    if (!filter) return all
    return all.filter((action) => action.label.toLowerCase().includes(filter))
  }

  const closePalette = () => {
    setPaletteOpen(false)
    setPaletteFilter("")
    setPaletteIndex(0)
  }

  const openPalette = () => {
    setPaletteOpen(true)
    setPaletteFilter("")
    setPaletteIndex(0)
  }

  const executePaletteAction = (index: number) => {
    const actions = filteredActions()
    if (index >= 0 && index < actions.length) {
      actions[index].handler()
    }
  }

  const switchSubjectAction = () => {
    const courses = props.database.listCourses()
    if (!courses.length) {
      appendMessage("system", "还没有任何课程。使用 Ctrl+X → Create subject 创建一个。")
      return
    }
    appendMessage("system", courses.map((c) => `- ${c.name}${c.id === (course()?.id ?? "") ? "（当前）" : ""}`).join("\n"))
    appendMessage("system", "输入 /course <名称> 切换课程。")
  }

  const createSubjectAction = () => {
    appendMessage("system", "输入 /course new <名称> 创建新课程。")
  }

  const addMaterialsAction = () => {
    if (!course()) {
      const courses = props.database.listCourses()
      if (courses.length > 0) {
        appendMessage("system", "请先选择一个课程，然后再导入资料。输入 /course <名称> 切换课程。")
      } else {
        appendMessage("system", "还没有课程。请先输入 /course new <名称> 创建课程，然后再导入资料。")
      }
      return
    }
    appendMessage("system", "输入 /add <文件路径或 URL> 导入学习资料。")
  }

  const viewProgressAction = () => {
    if (!course()) {
      appendMessage("system", "请先创建或选择一个课程。")
      return
    }
    const topics = props.database.listPlan(course()!.id)
    appendMessage(
      "system",
      topics.length
        ? topics.map((topic, index) => `${index + 1}. [${topic.status}] ${topic.title} · 阶段 ${topic.stage}${topic.dueAt ? ` · ${topic.dueAt.slice(0, 10)}` : ""}`).join("\n")
        : "还没有已确认的计划。在 Plan 模式下输入问题，AI 生成路线后输入“确认计划”保存。",
    )
  }

  const viewSourcesAction = () => {
    if (!course()) {
      appendMessage("system", "请先创建或选择一个课程。")
      return
    }
    const sources = props.database.listSources(course()!.id)
    appendMessage("system", sources.length ? sources.map((source) => `- ${source.title} · ${source.kind} · ${source.metadata.trust}\n  ${source.uri}`).join("\n") : "还没有资料。使用 Ctrl+X → Add materials 导入。")
  }

  const planAction = () => {
    if (!course()) {
      appendMessage("system", "请先创建或选择一个课程。")
      return
    }
    setMode("plan")
    props.database.setCourseMode(course()!.id, "plan")
    props.database.setSessionMode(sessionId()!, "plan")
    appendMessage("system", "已进入 Plan 模式。描述学习目标，AI 将生成学习路线。完成后输入“确认计划”保存。")
  }

  const examReviewAction = () => {
    if (!course()) {
      appendMessage("system", "请先创建或选择一个课程。")
      return
    }
    setMode("noob")
    props.database.setCourseMode(course()!.id, "noob")
    props.database.setSessionMode(sessionId()!, "noob")
    appendMessage("system", "已进入考前突击模式。描述考试范围和时间，AI 将优先覆盖高频考点。")
  }

  const changeStyleAction = () => {
    if (!course()) {
      appendMessage("system", "请先创建或选择一个课程。")
      return
    }
    appendMessage("system", `当前主题：${style().theme}。使用 /style theme=<cyan|violet|amber> 切换。`)
  }

  const startCreateSubjectFlow = () => {
    setOnboardingFlow({ type: "create_subject" })
    appendMessage("system", "创建新课程")
    appendMessage("system", "输入课程名称，按 Enter 确认。按 Esc 取消。")
    setNotice("创建课程 · 输入名称")
  }

  const startSwitchSubjectFlow = () => {
    setOnboardingFlow({ type: "switch_subject" })
    const courses = props.database.listCourses()
    if (!courses.length) {
      appendMessage("system", "还没有任何课程。请先创建课程。")
      setOnboardingFlow(undefined)
      return
    }
    appendMessage("system", "切换课程")
    appendMessage("system", courses.map((c, i) => `${i + 1}. ${c.name}${c.id === (course()?.id ?? "") ? "（当前）" : ""}`).join("\n"))
    appendMessage("system", "输入序号或课程名称，按 Enter 确认。按 Esc 取消。")
    setNotice("切换课程 · 选择或输入名称")
  }

  const startAddMaterialsFlow = () => {
    if (!course()) {
      const courses = props.database.listCourses()
      if (courses.length > 0) {
        appendMessage("system", "请先选择一个课程，然后再导入资料。按 Ctrl+X → Switch subject 切换。")
      } else {
        appendMessage("system", "还没有课程。请先按 Ctrl+X → Create subject 创建课程。")
      }
      return
    }
    setOnboardingFlow({ type: "add_materials" })
    appendMessage("system", "导入学习资料")
    appendMessage("system", "粘贴文件路径或 URL，按 Enter 导入。按 Esc 取消。")
    setNotice("导入资料 · 输入路径或 URL")
  }

  const executeDefaultAction = (action: string) => {
    switch (action) {
      case "review_due": {
        if (!course()) return
        setMode("review")
        props.database.setCourseMode(course()!.id, "review")
        props.database.setSessionMode(sessionId()!, "review")
        appendMessage("system", "已进入 Review 模式。将开始复习到期知识点。")
        break
      }
      case "continue_learning": {
        if (!course()) return
        setMode("first")
        props.database.setCourseMode(course()!.id, "first")
        props.database.setSessionMode(sessionId()!, "first")
        appendMessage("system", "已进入 First 模式。继续学习下一个计划知识点。")
        break
      }
      case "exam_review": {
        if (!course()) return
        setMode("noob")
        props.database.setCourseMode(course()!.id, "noob")
        props.database.setSessionMode(sessionId()!, "noob")
        appendMessage("system", "已进入考前突击模式。描述考试范围和时间，AI 将优先覆盖高频考点。")
        break
      }
    }
  }

  const executeStartupChoice = () => {
    const choice = startupChoice()
    if (!choice) return
    const option = choice.options[startupChoiceIndex()]
    if (!option) return
    setStartupChoice(null)
    switch (option.value) {
      case "open_recent": {
        const courses = props.database.listCourses()
        if (courses[0]) {
          const nextSession = props.database.createSession(courses[0].id, courses[0].mode)
          setCourse(courses[0])
          setSessionId(nextSession)
          setMode(courses[0].mode)
          setStyle(props.database.getStylePreferences(courses[0].id))
          setMessages([createDisplayMessage("system", `已进入课程：${courses[0].name}`)])
        }
        break
      }
      case "create_course":
        appendMessage("system", "输入 /course new <名称> 创建新课程。")
        break
      case "import_materials":
      case "add_materials":
        if (!course()) {
          const courses = props.database.listCourses()
          if (courses.length > 0) {
            appendMessage("system", "请先选择一个课程，然后再导入资料。输入 /course <名称> 切换课程。")
          } else {
            appendMessage("system", "还没有课程。请先输入 /course new <名称> 创建课程，然后再导入资料。")
          }
          return
        }
        appendMessage("system", "输入 /add <文件路径或 URL> 导入学习资料。")
        break
      case "rough_plan":
      case "make_plan":
        if (!course()) {
          appendMessage("system", "请先创建或选择一个课程。")
          return
        }
        setMode("plan")
        props.database.setCourseMode(course()!.id, "plan")
        props.database.setSessionMode(sessionId()!, "plan")
        appendMessage("system", "已进入 Plan 模式。描述学习目标，AI 将生成学习路线。完成后输入“确认计划”保存。")
        break
      case "ask_question":
      case "start_anyway":
      case "continue_normally":
        break
      case "exam_review":
        if (!course()) {
          appendMessage("system", "请先创建或选择一个课程。")
          return
        }
        setMode("noob")
        props.database.setCourseMode(course()!.id, "noob")
        props.database.setSessionMode(sessionId()!, "noob")
        appendMessage("system", "已进入考前突击模式。描述考试范围和时间，AI 将优先覆盖高频考点。")
        break
      case "review_weak":
        if (!course()) {
          appendMessage("system", "请先创建或选择一个课程。")
          return
        }
        setMode("review")
        props.database.setCourseMode(course()!.id, "review")
        props.database.setSessionMode(sessionId()!, "review")
        appendMessage("system", "已进入 Review 模式。将开始复习弱项和到期知识点。")
        break
    }
  }

  useKeyboard((key) => {
    if (key.ctrl && key.name === "x") {
      key.preventDefault()
      if (startupChoice()) setStartupChoice(null)
      if (onboardingFlow()) setOnboardingFlow(undefined)
      paletteOpen() ? closePalette() : openPalette()
      return
    }

    if (paletteOpen()) {
      if (key.name === "escape") {
        key.preventDefault()
        closePalette()
        return
      }
      if (key.name === "up") {
        key.preventDefault()
        setPaletteIndex((current) => Math.max(0, current - 1))
        return
      }
      if (key.name === "down") {
        key.preventDefault()
        setPaletteIndex((current) => Math.min(filteredActions().length - 1, current + 1))
        return
      }
      if (key.name === "return" || key.name === "kpenter") {
        key.preventDefault()
        executePaletteAction(paletteIndex())
        return
      }
      if (key.name === "backspace") {
        key.preventDefault()
        setPaletteFilter((current) => current.slice(0, -1))
        setPaletteIndex(0)
        return
      }
      if (key.name === "tab") {
        key.preventDefault()
        key.stopPropagation()
        return
      }
      if (typeof key.name === "string" && key.name.length === 1 && !key.ctrl && !key.meta) {
        key.preventDefault()
        setPaletteFilter((current) => current + key.name)
        setPaletteIndex(0)
        return
      }
      return
    }

    if (startupChoice()) {
      if (key.name === "escape") {
        key.preventDefault()
        setStartupChoice(null)
        return
      }
      if (key.name === "left") {
        key.preventDefault()
        setStartupChoiceIndex((current) => Math.max(0, current - 1))
        return
      }
      if (key.name === "right") {
        key.preventDefault()
        const choices = startupChoice()?.options ?? []
        setStartupChoiceIndex((current) => Math.min(choices.length - 1, current + 1))
        return
      }
      if (key.name === "return" || key.name === "kpenter") {
        const hasInput = (composer?.plainText ?? "").trim().length > 0
        if (hasInput) {
          setStartupChoice(null)
          return
        }
        key.preventDefault()
        executeStartupChoice()
        return
      }
      if (key.name === "tab") {
        key.preventDefault()
        key.stopPropagation()
        return
      }
    }

    if (key.name === "return" || key.name === "kpenter") {
      const hasInput = (composer?.plainText ?? "").trim().length > 0
      if (!hasInput) {
        const action = pendingDefaultAction()
        if (action) {
          key.preventDefault()
          setPendingDefaultAction(null)
          executeDefaultAction(action)
          void submit("开始")
          return
        }
      }
    }

    if (key.name === "escape" && onboardingFlow()) {
      key.preventDefault()
      setOnboardingFlow(undefined)
      setNotice("已取消")
      return
    }

    if (key.name === "escape" && modelSetup()) {
      key.preventDefault()
      setModelSetup(undefined)
      appendMessage("system", "已取消模型配置。")
      setNotice("已取消模型配置")
      return
    }

    if (key.name === "tab") {
      key.preventDefault()
      key.stopPropagation()
      if (!course()) return
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
    setMessages((current) => [...current, createDisplayMessage(role, content, id)])
    return id
  }

  const updateMessage = (id: string, content: string) => {
    messages().find((message) => message.id === id)?.setContent(content)
  }

  const handleOnboardingInput = async (text: string) => {
    const flow = onboardingFlow()
    if (!flow) return

    if (flow.type === "create_subject") {
      setOnboardingFlow(undefined)
      const name = text.trim()
      if (!name) {
        appendMessage("system", "课程名称不能为空。")
        return
      }
      const newCourse = props.database.createCourse(name)
      const nextSession = props.database.createSession(newCourse.id, newCourse.mode)
      setCourse(newCourse)
      setSessionId(nextSession)
      setMode(newCourse.mode)
      setStyle(props.database.getStylePreferences(newCourse.id))
      setMessages([createDisplayMessage("system", `已创建并进入课程：${newCourse.name}`)])
      setNotice("课程已创建")
      return
    }

    if (flow.type === "switch_subject") {
      setOnboardingFlow(undefined)
      const courses = props.database.listCourses()
      const input = text.trim()
      const indexMatch = /^\d+$/.test(input)
      const target = indexMatch
        ? courses[Number.parseInt(input) - 1]
        : courses.find((c) => c.name.toLowerCase() === input.toLowerCase())
      if (!target) {
        appendMessage("system", "找不到匹配的课程。请检查名称或序号。")
        return
      }
      const nextSession = props.database.createSession(target.id, target.mode)
      setCourse(target)
      setSessionId(nextSession)
      setMode(target.mode)
      setStyle(props.database.getStylePreferences(target.id))
      setMessages([createDisplayMessage("system", `已进入课程：${target.name}`)])
      setNotice("已切换课程")
      return
    }

    if (flow.type === "add_materials") {
      setOnboardingFlow(undefined)
      if (!course()) return
      const input = text.trim()
      setGenerating(true)
      setNotice("正在导入…")
      try {
        const results = await props.sourceService.import(course()!.id, [input], setNotice)
        appendMessage(
          "system",
          results.map((result) => result.status === "imported" ? `已导入 ${result.title}（${result.chunks} 个片段）` : `导入失败 ${result.input}：${result.error}`).join("\n"),
        )
        setNotice("导入完成")
        const imported = results.some((r) => r.status === "imported")
        if (imported && course()) {
          const hasPlan = props.database.listPlan(course()!.id).length > 0
          if (!hasPlan) {
            appendMessage("system", "资料已导入，现在可以创建学习计划了。按 Ctrl+X → Make plan / Replan 开始。")
          }
        }
      } finally {
        setGenerating(false)
      }
      return
    }
  }

  const directAsk = async (text: string) => {
    if (!props.model.config || !props.model.connected) {
      appendMessage("system", "尚未配置模型。按 Ctrl+X → Configure provider 开始连接。")
      return
    }
    appendMessage("user", text)
    const assistantId = appendMessage("assistant", "")
    const controller = new AbortController()
    setAbortController(controller)
    setGenerating(true)
    setNotice("Ask 正在生成…")
    let streamed = ""
    try {
      const result = await props.model.streamReply(
        {
          mode: "ask",
          input: text,
          courseName: "General",
          brief: {},
          history: [],
          sources: [],
          askStyle: classifyAskResponseStyle(text),
          style: style(),
          signal: controller.signal,
        },
        (delta) => {
          streamed += delta
          updateMessage(assistantId, streamed)
        },
      )
      updateMessage(assistantId, result)
      setNotice("回答完成")
    } catch (error) {
      const cancelled = controller.signal.aborted
      updateMessage(assistantId, cancelled ? `${streamed}\n\n[已取消]`.trim() : `错误：${formatError(error)}`)
      setNotice(cancelled ? "已取消" : "请求失败")
    } finally {
      setGenerating(false)
      setAbortController(undefined)
    }
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
    if (onboardingFlow()) {
      await handleOnboardingInput(text)
      return
    }

    if (!course()) {
      if (mode() === "ask") {
        await directAsk(text)
        return
      }
      appendMessage("system", "还没有选择课程。按 Ctrl+X 创建或选择一个课程。")
      return
    }

    appendMessage("user", text)
    const assistantId = appendMessage("assistant", "")
    const controller = new AbortController()
    setAbortController(controller)
    setGenerating(true)
    setNotice(`${modeLabel(mode())} 正在生成…`)
    let streamed = ""
    try {
      const result = await props.tutor.handleTurn({
        courseId: course()!.id,
        sessionId: sessionId()!,
        mode: mode(),
        text,
        signal: controller.signal,
        onDelta(delta) {
          streamed += delta
          updateMessage(assistantId, streamed)
        },
      })
      updateMessage(assistantId, result.text)
      if (result.notice) appendMessage("system", result.notice)
      setNotice(result.citations.length ? `引用 ${result.citations.length} 个资料片段` : "回答完成")
    } catch (error) {
      const cancelled = controller.signal.aborted
      updateMessage(assistantId, cancelled ? `${streamed}\n\n[已取消]`.trim() : `错误：${formatError(error)}`)
      setNotice(cancelled ? "已取消当前回答，学习状态未更新" : "请求失败，学习状态未更新")
    } finally {
      setGenerating(false)
      setAbortController(undefined)
    }
  }

  const startModelSetup = async () => {
    setModelSetup({ step: "provider", config: {} })
    appendMessage(
      "system",
      "选择模型服务：\n1. OpenAI-compatible（OpenAI、DeepSeek 等）\n2. Anthropic\n3. Google Gemini\n4. Ollama（本地）\n\n输入序号或名称，按 Esc 取消。",
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
      setNotice("模型连接失败；Ctrl+X → Configure provider 重试")
    } finally {
      setGenerating(false)
    }
  }

  const handleCommand = async (text: string) => {
    const [command, ...parts] = text.slice(1).split(/\s+/)
    const argument = parts.join(" ").trim()
    if (command === "quit" || command === "exit") return renderer.destroy()
    if (command === "help") {
      appendMessage("system", HELP)
      return
    }
    if (command === "mode") {
      if (!course()) {
        appendMessage("system", "请先创建或选择一个课程。")
        return
      }
      const requested = argument.toLowerCase() as TutorMode
      if (!MODES.includes(requested)) {
        appendMessage("system", `可用模式：${MODES.join(", ")}`)
        return
      }
      setMode(requested)
      props.database.setCourseMode(course()!.id, requested)
      props.database.setSessionMode(sessionId()!, requested)
      props.database.recordEvent(course()!.id, sessionId()!, "mode_switched", { mode: requested })
      setNotice(`已切换到 ${modeLabel(requested)} 模式`)
      return
    }
    if (command === "course") {
      handleCourseCommand(argument)
      return
    }
    if (command === "sources") {
      if (!course()) {
        appendMessage("system", "请先创建或选择一个课程。")
        return
      }
      const sources = props.database.listSources(course()!.id)
      appendMessage("system", sources.length ? sources.map((source) => `- ${source.title} · ${source.kind} · ${source.metadata.trust}\n  ${source.uri}`).join("\n") : "还没有资料。使用 /add <路径或 URL> 导入。")
      return
    }
    if (command === "progress") {
      if (!course()) {
        appendMessage("system", "请先创建或选择一个课程。")
        return
      }
      const topics = props.database.listPlan(course()!.id)
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
        void startModelSetup()
      } else {
        const config = props.model.config
        appendMessage(
          "system",
          `当前模型：${config.provider}/${config.model}${config.baseURL ? `\n${config.baseURL}` : ""}\nconnected=${props.model.connected} · streaming=${props.model.capabilities.streaming} · structuredOutput=${props.model.capabilities.structuredOutput}${props.model.lastError ? `\n${props.model.lastError}` : ""}\nCtrl+X → Configure provider 可重新连接。`,
        )
      }
      return
    }
    if (command === "add") {
      await handleAddCommand(argument)
      return
    }
    appendMessage("system", `未知命令：/${command}\n按 Ctrl+X 或输入 /help 查看帮助。`)
  }

  const handleCourseCommand = (argument: string) => {
    if (!argument) {
      appendMessage("system", props.database.listCourses().map((item) => `- ${item.name}${item.id === (course()?.id ?? "") ? "（当前）" : ""}`).join("\n"))
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
    setMessages([createDisplayMessage("system", `已进入课程：${next.name}`)])
  }

  const handleStyleCommand = (argument: string) => {
    if (!course()) {
      appendMessage("system", "请先创建或选择一个课程。")
      return
    }
    const currentStyle = props.database.getStylePreferences(course()!.id)
    if (!argument) {
      appendMessage("system", Object.entries(currentStyle).map(([key, value]) => `${key}=${value}`).join("\n"))
      return
    }
    const [key, value] = argument.split("=", 2)
    if (!value || !(key in currentStyle)) {
      appendMessage("system", "格式：/style <theme|sequence|verbosity|stepSize|challenge|analogyDensity>=<值>")
      return
    }
    if (key === "theme" && !THEMES.includes(value as VisualTheme)) {
      appendMessage("system", `可用主题：${THEMES.join(", ")}`)
      return
    }
    props.database.updateStylePreference(course()!.id, key as keyof StylePreferences, value)
    setStyle(props.database.getStylePreferences(course()!.id))
    appendMessage("system", `已更新 ${key}=${value}`)
  }

  const handleAddCommand = async (argument: string) => {
    if (!argument) {
      appendMessage("system", "格式：/add <文件、目录或 URL>；联网搜索：/add search <课程名>")
      return
    }
    if (!course()) {
      appendMessage("system", "请先创建或选择一个课程。")
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
      const results = await props.sourceService.import(course()!.id, [argument], setNotice)
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
        <text fg={palette().accent}><strong>OpenStu</strong> · {subjectDisplay()}</text>
        <text fg={statusOnline() ? "#79c99e" : "#e06c75"}>
          {statusOnline() ? "●" : "●"} {modelView() ? `${modelView()!.provider}/${modelView()!.model}` : (course() ? "未连接 · /model" : "offline")}
        </text>
      </box>

      <scrollbox flexGrow={1} stickyScroll stickyStart="bottom" border borderStyle="rounded" borderColor={palette().border} padding={1}>
        <For each={messages()}>
          {(message) => (
            <box flexDirection="column" marginBottom={1}>
              <text fg={message.role === "user" ? palette().user : message.role === "assistant" ? palette().accent : palette().muted}>
                <strong>{message.role === "user" ? "You" : message.role === "assistant" ? "OpenStu" : "System"}</strong>
              </text>
              <Show when={message.content()} fallback={<text fg={palette().muted}>…</text>}>
                <markdown
                  content={message.content()}
                  fg={palette().text}
                  streaming
                  syntaxStyle={syntaxStyle}
                />
              </Show>
            </box>
          )}
        </For>
      </scrollbox>

      <box flexDirection="column">
        <Show when={paletteOpen()} fallback={<text />}>
          <box border borderStyle="rounded" borderColor={palette().accent} padding={1} minHeight={14} marginBottom={1}>
            <text fg={palette().accent}><strong>Actions</strong>  {paletteFilter() ? `· "${paletteFilter()}"` : "· type to filter"}</text>
            <box height={1} />
            <For each={filteredActions()}>
              {(action, index) => (
                <box flexDirection="row">
                  <text fg={index() === paletteIndex() ? palette().accent : palette().text}>
                    {index() === paletteIndex() ? "> " : "  "}{action.label}
                  </text>
                </box>
              )}
            </For>
            <Show when={filteredActions().length === 0} fallback={<text />}>
              <text fg={palette().muted}>No matching actions</text>
            </Show>
          </box>
        </Show>
        <Show when={startupChoice() != null} fallback={<text />}>
          <box flexDirection="column" marginBottom={1}>
            <text fg={palette().accent}><strong>OpenStu</strong></text>
            <box height={1} />
            <text fg={palette().text}>{startupChoice()?.message ?? ""}</text>
            <box height={1} />
            <box flexDirection="row" gap={2}>
              <For each={startupChoice()?.options ?? []}>
                {(option, index) => (
                  <text fg={index() === startupChoiceIndex() ? palette().accent : palette().text}>
                    {index() === startupChoiceIndex() ? "[" : " "}{option.label}{index() === startupChoiceIndex() ? "]" : " "}
                  </text>
                )}
              </For>
            </box>
            <box height={1} />
            <text fg={palette().muted}>Or type your question…</text>
          </box>
        </Show>
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
              if (!course()) return
              changeMode(key.shift ? -1 : 1)
            }}
            keyBindings={COMPOSER_KEY_BINDINGS}
            placeholder={modelSetup()?.step === "key" ? "粘贴 API Key（不会回显）" : onboardingFlow()?.type === "add_materials" ? "粘贴文件路径或 URL…" : onboardingFlow()?.type === "create_subject" ? "输入课程名称…" : onboardingFlow()?.type === "switch_subject" ? "输入序号或课程名称…" : generating() ? "生成中，Ctrl+C 取消…" : "输入消息或按 Ctrl+X"}
            placeholderColor={palette().muted}
            backgroundColor={palette().inputBackground}
            focusedBackgroundColor={palette().inputBackground}
            textColor={modelSetup()?.step === "key" ? palette().inputBackground : palette().text}
            focusedTextColor={modelSetup()?.step === "key" ? palette().inputBackground : palette().text}
            focused={!generating() && !paletteOpen()}
            width="100%"
            height={3}
          />
        </box>
        <Show when={paletteOpen()} fallback={<text fg={palette().muted}>{notice()}</text>}>
          <text fg={palette().muted}>Esc 关闭 · ↑↓ 选择 · Enter 执行 · 直接输入过滤</text>
        </Show>
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

const FALLBACK_STYLE: StylePreferences = {
  theme: "cyan",
  sequence: "balanced",
  verbosity: "normal",
  stepSize: "medium",
  challenge: "balanced",
  analogyDensity: "medium",
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

const HELP = `OpenStu · 快捷帮助

主要操作：
  Ctrl+X — 打开 Actions 面板（切换课程、创建课程、导入资料、配置模型等）
  Enter  — 发送消息
  Shift+Enter — 换行
  Ctrl+C — 取消当前生成
  Esc   — 关闭面板

命令：
  /course                  — 列出课程
  /course new <名称>        — 新建课程
  /add <路径或 URL>         — 导入资料
  /add search <课程名>      — 搜索官方资料候选
  /mode <plan|first|review|noob|ask> — 切换模式
  /sources                  — 查看资料
  /progress                 — 查看学习计划
  /style theme=<cyan|violet|amber> — 切换主题
  /style [键=值]            — 查看或修改呈现偏好
  /model                    — 查看或连接模型
  /help                     — 查看帮助
  /quit                     — 退出`
