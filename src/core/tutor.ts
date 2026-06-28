import { applyClarificationDefaults, answerClarification, classifyAskResponseStyle, isAmbiguousAsk, nextClarification } from "./clarification"
import { applyDiagnosis, masteryFor, validateDiagnosis } from "./learning"
import type { AssessmentRubric, Citation, DiagnosisCandidate, SearchResult, TopicProgress, TutorMode } from "./types"
import { OpenStuDatabase, type PlanTopic } from "../adapters/database"
import type { TutorModelPort } from "../adapters/model"
import { searchOfficialSources } from "../adapters/search"

export interface TurnResult {
  text: string
  citations: Citation[]
  notice?: string
}

export class TutorService {
  constructor(
    private readonly database: OpenStuDatabase,
    private readonly model: TutorModelPort,
  ) {}

  async handleTurn(input: {
    courseId: string
    sessionId: string
    mode: TutorMode
    text: string
    signal?: AbortSignal
    onDelta: (text: string) => void
  }): Promise<TurnResult> {
    const course = this.database.getCourse(input.courseId)
    if (!course) throw new Error("课程不存在")
    const state = this.database.getSessionState(input.sessionId)
    const learningAnswer = Boolean(
      state.awaitingTopicId &&
        state.awaitingRubricId &&
        state.firstPhase === "assessment" &&
        state.learningMode === input.mode &&
        (input.mode === "first" || input.mode === "review"),
    )

    if (!learningAnswer) this.database.saveMessage(input.sessionId, "user", input.text)

    if (state.clarificationMode !== input.mode) {
      delete state.pendingClarification
      delete state.pendingAskQuestion
      state.clarificationCount = 0
      state.clarificationMode = input.mode
      this.database.setSessionState(input.sessionId, state)
    }

    if (input.mode === "ask") {
      if (state.pendingAskQuestion) {
        input.text = `${state.pendingAskQuestion}\n澄清：${input.text}`
        delete state.pendingAskQuestion
        this.database.setSessionState(input.sessionId, state)
      } else if (isAmbiguousAsk(input.text)) {
        state.pendingAskQuestion = input.text
        this.database.setSessionState(input.sessionId, state)
        return this.saveNotice(
          input.sessionId,
          "你指的是哪一部分？\n\n1. 当前知识点\n2. 导师上一条回答\n3. 已导入资料中的内容\n\n可回复序号或直接补充说明。",
        )
      }
    }

    if (state.pendingClarification) {
      const brief =
        input.text.trim().toLowerCase() === "defaults"
          ? applyClarificationDefaults(course.brief)
          : answerClarification(course.brief, state.pendingClarification, input.text.trim())
      const count = (state.clarificationCount ?? 0) + 1
      state.clarificationCount = count
      this.database.updateCourseBrief(course.id, brief)
      delete state.pendingClarification
      this.database.setSessionState(input.sessionId, state)
      const next = input.text.trim().toLowerCase() === "defaults" ? undefined : nextClarification(input.mode, brief, count)
      if (next) return this.askClarification(input.sessionId, state, next)
      course.brief = brief
      input.text = `请根据已确认条件，为 ${course.name} 生成学习路线。`
    } else {
      const clarification = nextClarification(input.mode, course.brief, state.clarificationCount ?? 0)
      if (clarification) return this.askClarification(input.sessionId, state, clarification)
    }

    if (input.mode === "plan" && /^(确认计划|confirm plan|accept plan)$/i.test(input.text.trim())) {
      const draft = [...this.database.listMessages(input.sessionId)]
        .reverse()
        .find((message) => message.role === "assistant" && message.status === "complete")
      if (!draft) return this.saveNotice(input.sessionId, "还没有可确认的计划。")
      const plan = await this.model.extractPlan(draft.content, input.signal)
      this.database.replacePlan(course.id, plan.topics)
      this.database.recordEvent(course.id, input.sessionId, "plan_confirmed", { topics: plan.topics.length })
      clearLearningState(state)
      this.database.setSessionState(input.sessionId, state)
      return this.saveNotice(input.sessionId, `计划已保存，共 ${plan.topics.length} 个知识点。按 Tab 切到 First 开始学习。`)
    }

    if (
      input.mode === "plan" &&
      process.env.TAVILY_API_KEY &&
      course.brief.sourceScope !== "local-only" &&
      this.database.listSources(course.id).length === 0 &&
      !state.sourceSearchOffered
    ) {
      state.sourceSearchOffered = true
      this.database.setSessionState(input.sessionId, state)
      try {
        const candidates = await searchOfficialSources(course.name, process.env.TAVILY_API_KEY, input.signal)
        if (candidates.length) {
          return this.saveNotice(
            input.sessionId,
            `找到以下候选，尚未导入。核对后使用 /add <URL> 确认：\n\n${candidates
              .map((candidate, index) => {
                const meta = [candidate.sourceTrust, candidate.institution, candidate.courseVersion, candidate.term, candidate.publishedDate].filter(Boolean).join(" · ")
                return `${index + 1}. ${candidate.title}\n${meta}\n${candidate.url}\n${candidate.content}`
              })
              .join("\n\n")}`,
          )
        }
      } catch (error) {
        return this.saveNotice(input.sessionId, `官方资料搜索失败：${errorMessage(error)}\n可使用 /add <URL> 手动导入后继续。`)
      }
    }

    let topic: PlanTopic | undefined
    let diagnosisNotice: string | undefined
    let feedbackOnly = false
    let createRubric = false
    let firstFlow: "probe" | "teach-check" | undefined

    if (input.mode === "first" || input.mode === "review") {
      topic = state.awaitingTopicId
        ? this.database.listPlan(course.id).find((item) => item.id === state.awaitingTopicId)
        : this.database.nextTopic(course.id, input.mode)
      if (!topic) {
        clearLearningState(state)
        this.database.setSessionState(input.sessionId, state)
        return this.saveNotice(
          input.sessionId,
          input.mode === "first" ? "当前没有待学知识点，请先在 Plan 模式生成并确认计划。" : "当前没有到期或已学习的知识点可复习。",
        )
      }

      if (!state.awaitingTopicId) {
        state.awaitingTopicId = topic.id
        state.learningMode = input.mode
        state.firstPhase = input.mode === "first" && topic.hasPrerequisites ? "probe" : "assessment"
        this.database.markPlanItem(topic.id, "active")
        firstFlow = state.firstPhase === "probe" ? "probe" : "teach-check"
        createRubric = state.firstPhase === "assessment"
      } else if (state.firstPhase === "probe" && input.mode === "first") {
        state.firstPhase = "assessment"
        firstFlow = "teach-check"
        createRubric = true
      } else if (learningAnswer) {
        const rubric = this.database.getRubric(state.awaitingRubricId!)
        if (!rubric) {
          this.database.saveMessage(input.sessionId, "user", input.text)
          diagnosisNotice = "评分标准已丢失，本轮不更新进度。"
        } else {
          diagnosisNotice = await this.diagnoseAndRecord(course.id, input.sessionId, course.brief.deadline, topic, rubric, input.text, input.mode, input.signal)
        }
        feedbackOnly = true
        clearLearningState(state)
      }
      this.database.setSessionState(input.sessionId, state)
    }

    const query = topic ? `${topic.title} ${input.text}` : input.text
    let sources: SearchResult[] = []
    try {
      sources = this.database.searchChunks(course.id, query)
    } catch (error) {
      input.onDelta("")
    }
    const citations: Citation[] = sources.map((source) => ({ sourceId: source.sourceId, chunkId: source.id, locator: source.locator, sourceTitle: source.sourceTitle }))
    const history = this.database.listMessages(input.sessionId).map(({ role, content }) => ({ role, content }))
    let streamed = ""
    let text: string
    try {
      text = await this.model.streamReply(
        {
          mode: input.mode,
          input: input.text,
          courseName: course.name,
          brief: course.brief,
          history,
          sources,
          topic: topic ? { title: topic.title, description: topic.description, stage: topic.stage } : undefined,
          firstFlow,
          feedbackOnly,
          askStyle: input.mode === "ask" ? classifyAskResponseStyle(input.text) : undefined,
          style: this.database.getStylePreferences(course.id),
          signal: input.signal,
        },
        (delta) => {
          streamed += delta
          input.onDelta(delta)
        },
      )
    } catch (error) {
      this.database.saveMessage(
        input.sessionId,
        "assistant",
        streamed || (input.signal?.aborted ? "" : errorMessage(error)),
        citations,
        false,
        input.signal?.aborted ? "canceled" : "error",
      )
      throw error
    }
    this.database.saveMessage(input.sessionId, "assistant", text, citations)
    if (input.mode === "noob") this.database.recordNoobExposure(course.id, input.sessionId, text, topic?.id)

    if (createRubric && topic) {
      if (this.model.capabilities?.structuredOutput === false) {
        clearLearningState(state)
        diagnosisNotice = "当前模型不支持可靠的结构化诊断；这道题可练习，但不会更新进度。"
      } else {
        try {
          const questionType: AssessmentRubric["questionType"] = topic.stage >= 2 ? "transfer" : input.mode === "review" ? "recall" : "application"
          const rubric = await this.model.createRubric({ topicId: topic.id, topicTitle: topic.title, question: text, questionType, signal: input.signal })
          this.database.saveRubric(rubric)
          state.awaitingRubricId = rubric.id
        } catch (error) {
          clearLearningState(state)
          diagnosisNotice = `评分标准生成失败，本题不计入进度：${errorMessage(error)}`
        }
      }
      this.database.setSessionState(input.sessionId, state)
    }

    return { text, citations, notice: diagnosisNotice }
  }

  private async diagnoseAndRecord(
    courseId: string,
    sessionId: string,
    deadline: string | undefined,
    topic: PlanTopic,
    rubric: AssessmentRubric,
    answer: string,
    mode: "first" | "review",
    signal?: AbortSignal,
  ): Promise<string | undefined> {
    const candidate = await this.diagnoseWithRetry(rubric, answer, signal)
    if (!candidate) {
      this.database.saveMessage(sessionId, "user", answer)
      return "诊断失败，本轮回答已保留但学习进度未更新。"
    }
    const checked = validateDiagnosis(candidate, rubric, answer, topic.stage)
    if (!checked.valid) {
      this.database.recordRejectedDiagnosis({
        courseId,
        sessionId,
        answer,
        diagnosis: candidate,
        reason: checked.reason,
        provider: this.model.config?.provider,
        model: this.model.config?.model,
      })
      return `诊断未通过校验，学习进度未更新：${checked.reason}`
    }
    const current: TopicProgress = {
      topicId: topic.id,
      stage: topic.stage,
      attemptCount: topic.attemptCount,
      mastery: masteryFor(topic.stage, topic.attemptCount),
      dueAt: topic.dueAt,
      lastResult: topic.lastResult,
      hintLevel: 0,
    }
    const progress = applyDiagnosis(current, checked.diagnosis, mode, deadline)
    this.database.recordDiagnosis({
      courseId,
      sessionId,
      topicTitle: topic.title,
      answer,
      diagnosis: checked.diagnosis,
      progress,
      provider: this.model.config?.provider,
      model: this.model.config?.model,
      completePlanItem: mode === "first" && checked.diagnosis.stateChange.reason === "correct_no_hint",
    })
    return `诊断置信度 ${Math.round(checked.diagnosis.confidence * 100)}%；阶段 ${topic.stage} → ${progress.stage}。`
  }

  private async diagnoseWithRetry(
    rubric: AssessmentRubric,
    answer: string,
    signal?: AbortSignal,
  ): Promise<DiagnosisCandidate | undefined> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.model.diagnose({ rubric, answer, signal })
      } catch (error) {
        if (signal?.aborted) throw error
      }
    }
    return undefined
  }

  private askClarification(
    sessionId: string,
    state: ReturnType<OpenStuDatabase["getSessionState"]>,
    request: NonNullable<ReturnType<typeof nextClarification>>,
  ): TurnResult {
    state.pendingClarification = request
    this.database.setSessionState(sessionId, state)
    const options = request.options
      .map((option, index) => `${index + 1}. ${option.label}${option.value === request.recommendedValue ? "（推荐）" : ""}`)
      .join("\n")
    const text = `${request.question}\n${request.reason}\n\n${options}\n\n可回复选项值、自由描述，或输入 defaults 接受推荐默认值。`
    this.database.saveMessage(sessionId, "assistant", text)
    return { text, citations: [] }
  }

  private saveNotice(sessionId: string, text: string): TurnResult {
    this.database.saveMessage(sessionId, "assistant", text)
    return { text, citations: [] }
  }
}

function clearLearningState(state: ReturnType<OpenStuDatabase["getSessionState"]>): void {
  delete state.awaitingTopicId
  delete state.awaitingRubricId
  delete state.firstPhase
  delete state.learningMode
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
