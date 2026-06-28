import { afterEach, describe, expect, test } from "bun:test"
import { OpenStuDatabase } from "../src/adapters/database"
import type { ModelCapabilities, ReplyRequest, TutorModelPort } from "../src/adapters/model"
import type { AssessmentRubric } from "../src/core/types"
import { TutorService } from "../src/core/tutor"

class FakeTutorModel implements TutorModelPort {
  replies: ReplyRequest[] = []
  readonly config = { provider: "ollama" as const, model: "test", baseURL: "http://localhost" }
  readonly capabilities: ModelCapabilities = { streaming: true, structuredOutput: true, toolCalling: false, jsonSchema: true, local: true }

  async streamReply(request: ReplyRequest, onDelta: (text: string) => void): Promise<string> {
    this.replies.push(request)
    const text = request.mode === "plan" ? "1. 力与运动\n2. 能量守恒\n\n输入“确认计划”保存。" : `${request.mode} reply`
    onDelta(text)
    return text
  }

  async createRubric(input: { topicId: string; question: string; questionType: AssessmentRubric["questionType"] }) {
    return {
      id: crypto.randomUUID(),
      topicId: input.topicId,
      question: input.question,
      questionType: input.questionType,
      expectedAnswerSummary: "正确回答",
      criteria: ["回答核心概念"],
      schemaVersion: 1,
    }
  }

  async diagnose(input: { rubric: AssessmentRubric; answer: string }) {
    return {
      topicId: input.rubric.topicId,
      rubricId: input.rubric.id,
      correctness: "correct" as const,
      hintLevel: 0 as const,
      confidence: 0.95,
      observedAnswerSummary: "回答正确",
      diagnosisReason: "符合 rubric",
      evidenceQuotes: [input.answer],
    }
  }

  async extractPlan() {
    return {
      topics: [
        { title: "力与运动", description: "牛顿定律", prerequisites: [] },
        { title: "能量守恒", description: "功和能", prerequisites: ["力与运动"] },
      ],
    }
  }
}

let database: OpenStuDatabase | undefined

afterEach(() => database?.close())

describe("TutorService flow", () => {
  test("persists Plan, First, Ask and Review without treating Ask as evidence", async () => {
    database = new OpenStuDatabase(":memory:")
    const course = database.createCourse("Physics")
    const session = database.createSession(course.id, "plan")
    const model = new FakeTutorModel()
    const tutor = new TutorService(database, model)
    const turn = (mode: "plan" | "first" | "review" | "noob" | "ask", text: string) =>
      tutor.handleTurn({ courseId: course.id, sessionId: session, mode, text, onDelta() {} })

    expect((await turn("plan", "开始")).text).toContain("最想达成")
    expect((await turn("plan", "defaults")).text).toContain("确认计划")
    expect((await turn("plan", "确认计划")).text).toContain("2 个知识点")

    expect((await turn("first", "开始学习")).text).toBe("first reply")
    await turn("first", "力等于质量乘加速度")
    expect(database.listTopicProgress(course.id).find((topic) => topic.attemptCount === 1)).toBeDefined()

    const attemptsBeforeAsk = database.listTopicProgress(course.id).reduce((sum, topic) => sum + topic.attemptCount, 0)
    expect((await turn("ask", "为什么力会改变速度？")).text).toBe("ask reply")
    expect(database.listTopicProgress(course.id).reduce((sum, topic) => sum + topic.attemptCount, 0)).toBe(attemptsBeforeAsk)
    expect(model.replies.at(-1)?.askStyle).toBe("socratic")
    expect((await turn("ask", "这个？")).text).toContain("你指的是")
    expect((await turn("ask", "导师上一条回答")).text).toBe("ask reply")

    database.db.query("UPDATE topics SET next_review_at = ? WHERE course_id = ?").run("2020-01-01T00:00:00.000Z", course.id)
    expect((await turn("review", "开始复习")).text).toBe("review reply")
    await turn("review", "F=ma")
    expect(database.listTopicProgress(course.id).reduce((sum, topic) => sum + topic.attemptCount, 0)).toBe(2)
  })

  test("stores interrupted assistant output as canceled without learning evidence", async () => {
    database = new OpenStuDatabase(":memory:")
    const course = database.createCourse("Physics")
    const session = database.createSession(course.id, "ask")
    const model = new FakeTutorModel()
    const controller = new AbortController()
    model.streamReply = async (_request, onDelta) => {
      onDelta("partial")
      controller.abort()
      throw new Error("aborted")
    }
    const tutor = new TutorService(database, model)
    await expect(
      tutor.handleTurn({ courseId: course.id, sessionId: session, mode: "ask", text: "定义是什么？", signal: controller.signal, onDelta() {} }),
    ).rejects.toThrow("aborted")
    const messages = database.listMessages(session)
    expect(messages.at(-1)?.status).toBe("canceled")
    expect(messages.some((message) => message.learningEvidence)).toBe(false)
  })
})
