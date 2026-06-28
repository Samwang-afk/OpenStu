import { afterEach, describe, expect, test } from "bun:test"
import { OpenStuDatabase } from "../src/adapters/database"
import type { ModelCapabilities, ReplyRequest, TutorModelPort } from "../src/adapters/model"
import type { AssessmentRubric, Citation } from "../src/core/types"
import { TutorService } from "../src/core/tutor"

class CapturingTutorModel implements TutorModelPort {
  replies: ReplyRequest[] = []
  readonly config = { provider: "ollama" as const, model: "test", baseURL: "http://localhost" }
  readonly capabilities: ModelCapabilities = { streaming: true, structuredOutput: true, toolCalling: false, jsonSchema: true, local: true }

  async streamReply(request: ReplyRequest, onDelta: (text: string) => void): Promise<string> {
    this.replies.push(request)
    const text = `${request.mode} reply`
    onDelta(text)
    return text
  }

  async createRubric(input: { topicId: string; question: string; questionType: AssessmentRubric["questionType"] }) {
    return { id: crypto.randomUUID(), topicId: input.topicId, question: input.question, questionType: input.questionType, expectedAnswerSummary: "ok", criteria: ["ok"], schemaVersion: 1 }
  }

  async diagnose(input: { rubric: AssessmentRubric; answer: string }) {
    return { topicId: input.rubric.topicId, rubricId: input.rubric.id, correctness: "correct" as const, hintLevel: 0 as const, confidence: 0.9, observedAnswerSummary: "ok", diagnosisReason: "ok", evidenceQuotes: [input.answer] }
  }

  async extractPlan() {
    return { topics: [{ title: "Test Topic", description: "desc", prerequisites: [] }] }
  }
}

let database: OpenStuDatabase | undefined
afterEach(() => database?.close())

describe("Materials retrieval and citations", () => {
  test("Ask with retrieved chunks returns citations with sourceTitle", async () => {
    database = new OpenStuDatabase(":memory:")
    const course = database.createCourse("Physics")
    const session = database.createSession(course.id, "ask")
    const sourceId = database.addSource(course.id, { kind: "text", uri: "notes.txt", title: "Physics Notes", contentHash: "hash-1" })
    database.replaceChunks(sourceId, course.id, [{ ordinal: 0, locator: "section 1", text: "Newton's laws of motion describe the relationship between force and acceleration." }])
    const model = new CapturingTutorModel()
    const tutor = new TutorService(database, model)

    const result = await tutor.handleTurn({ courseId: course.id, sessionId: session, mode: "ask", text: "What are Newton's laws?", onDelta() {} })

    expect(result.citations.length).toBeGreaterThan(0)
    expect(result.citations[0].sourceTitle).toBe("Physics Notes")
    expect(result.citations[0].locator).toBe("section 1")
    expect(result.citations[0].sourceId).toBe(sourceId)
  })

  test("no retrieved chunks → no citations in result", async () => {
    database = new OpenStuDatabase(":memory:")
    const course = database.createCourse("Physics")
    const session = database.createSession(course.id, "ask")
    const model = new CapturingTutorModel()
    const tutor = new TutorService(database, model)

    const result = await tutor.handleTurn({ courseId: course.id, sessionId: session, mode: "ask", text: "What is quantum gravity?", onDelta() {} })

    expect(result.citations).toHaveLength(0)
  })

  test("citations reference only actual retrieved chunk IDs", async () => {
    database = new OpenStuDatabase(":memory:")
    const course = database.createCourse("Physics")
    const session = database.createSession(course.id, "ask")
    const sourceId = database.addSource(course.id, { kind: "text", uri: "notes.txt", title: "Notes", contentHash: "hash-2" })
    database.replaceChunks(sourceId, course.id, [{ ordinal: 0, locator: "p1", text: "Electromagnetic induction occurs when a changing magnetic field produces an electric current." }])
    const model = new CapturingTutorModel()
    const tutor = new TutorService(database, model)

    const result = await tutor.handleTurn({ courseId: course.id, sessionId: session, mode: "ask", text: "Explain electromagnetic induction.", onDelta() {} })

    expect(result.citations.length).toBeGreaterThan(0)
    for (const c of result.citations) {
      expect(c.sourceId).toBe(sourceId)
      expect(c.chunkId).toBeTruthy()
      const chunk = database.searchChunks(course.id, "electromagnetic").find((s) => s.id === c.chunkId)
      expect(chunk).toBeDefined()
    }
  })

  test("Ask does not mutate learning state even with citations", async () => {
    database = new OpenStuDatabase(":memory:")
    const course = database.createCourse("Physics")
    const session = database.createSession(course.id, "ask")
    const sourceId = database.addSource(course.id, { kind: "text", uri: "notes.txt", title: "Notes", contentHash: "hash-3" })
    database.replaceChunks(sourceId, course.id, [{ ordinal: 0, locator: "p1", text: "Force equals mass times acceleration." }])
    database.saveTopicProgress(course.id, "Forces", { topicId: "t1", stage: 2, attemptCount: 3, mastery: "familiar", hintLevel: 0 })
    const model = new CapturingTutorModel()
    const tutor = new TutorService(database, model)

    const before = database.listTopicProgress(course.id)
    await tutor.handleTurn({ courseId: course.id, sessionId: session, mode: "ask", text: "What is force?", onDelta() {} })
    const after = database.listTopicProgress(course.id)

    for (let i = 0; i < before.length; i++) {
      expect(after[i].stage).toBe(before[i].stage)
      expect(after[i].attemptCount).toBe(before[i].attemptCount)
      expect(after[i].mastery).toBe(before[i].mastery)
    }
  })

  test("sources are passed to model prompt when retrieved", async () => {
    database = new OpenStuDatabase(":memory:")
    const course = database.createCourse("Physics")
    const session = database.createSession(course.id, "ask")
    const sourceId = database.addSource(course.id, { kind: "text", uri: "notes.txt", title: "Thermo", contentHash: "hash-4" })
    database.replaceChunks(sourceId, course.id, [{ ordinal: 0, locator: "ch1", text: "The second law of thermodynamics states that entropy always increases." }])
    const model = new CapturingTutorModel()
    const tutor = new TutorService(database, model)

    await tutor.handleTurn({ courseId: course.id, sessionId: session, mode: "ask", text: "thermodynamics", onDelta() {} })

    expect(model.replies.length).toBeGreaterThan(0)
    expect(model.replies[0].sources.length).toBeGreaterThan(0)
    expect(model.replies[0].sources[0].sourceTitle).toBe("Thermo")
    expect(model.replies[0].sources[0].text).toContain("entropy")
  })

  test("Ask still completes when searchChunks returns empty", async () => {
    database = new OpenStuDatabase(":memory:")
    const course = database.createCourse("Physics")
    const session = database.createSession(course.id, "ask")
    const model = new CapturingTutorModel()
    const tutor = new TutorService(database, model)

    const result = await tutor.handleTurn({ courseId: course.id, sessionId: session, mode: "ask", text: "random stuff", onDelta() {} })

    expect(result.text).toBeTruthy()
    expect(result.citations).toHaveLength(0)
    expect(model.replies[0].sources).toHaveLength(0)
  })

  test("Ask with course scopes retrieval to that course only", async () => {
    database = new OpenStuDatabase(":memory:")
    const physics = database.createCourse("Physics")
    const chem = database.createCourse("Chemistry")
    const session = database.createSession(physics.id, "ask")

    const psId = database.addSource(physics.id, { kind: "text", uri: "p.txt", title: "Physics Src", contentHash: "hp" })
    database.replaceChunks(psId, physics.id, [{ ordinal: 0, locator: "p1", text: "Newton derived universal gravitation." }])
    const csId = database.addSource(chem.id, { kind: "text", uri: "c.txt", title: "Chem Src", contentHash: "hc" })
    database.replaceChunks(csId, chem.id, [{ ordinal: 0, locator: "c1", text: "Bond angles depend on hybridization." }])

    const model = new CapturingTutorModel()
    const tutor = new TutorService(database, model)

    const result = await tutor.handleTurn({ courseId: physics.id, sessionId: session, mode: "ask", text: "Newton gravitation bond", onDelta() {} })

    expect(result.citations.length).toBeGreaterThan(0)
    for (const c of result.citations) {
      expect(c.sourceTitle).not.toBe("Chem Src")
    }
  })

  test("searchChunks throws → Ask completes with empty sources and does not mutate learning state", async () => {
    database = new OpenStuDatabase(":memory:")
    const course = database.createCourse("Physics")
    const session = database.createSession(course.id, "ask")
    const sourceId = database.addSource(course.id, { kind: "text", uri: "notes.txt", title: "Notes", contentHash: "hash-crash" })
    database.replaceChunks(sourceId, course.id, [{ ordinal: 0, locator: "p1", text: "Force equals mass times acceleration." }])
    database.saveTopicProgress(course.id, "Forces", { topicId: "t1", stage: 2, attemptCount: 3, mastery: "familiar", hintLevel: 0 })
    const model = new CapturingTutorModel()
    const tutor = new TutorService(database, model)
    const before = database.listTopicProgress(course.id)
    ;(database as any).searchChunks = () => { throw new Error("FTS corrupted") }

    const result = await tutor.handleTurn({ courseId: course.id, sessionId: session, mode: "ask", text: "What is force?", onDelta() {} })

    expect(result.text).toBeTruthy()
    expect(result.citations).toHaveLength(0)
    const after = database.listTopicProgress(course.id)
    for (let i = 0; i < before.length; i++) {
      expect(after[i].stage).toBe(before[i].stage)
      expect(after[i].attemptCount).toBe(before[i].attemptCount)
      expect(after[i].mastery).toBe(before[i].mastery)
    }
  })
})
