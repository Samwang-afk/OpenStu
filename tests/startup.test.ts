import { describe, expect, test } from "bun:test"
import { decideStartup, isDeadlineClose, type StartupState } from "../src/core/startup"
import type { CourseRecord, PlanTopic, SourceRecord } from "../src/adapters/database"

const now = new Date("2026-06-27T12:00:00.000Z")

function makeCourse(overrides: Partial<CourseRecord> = {}): CourseRecord {
  return {
    id: "course-1",
    name: "Physics",
    brief: { deadline: "no-deadline" },
    mode: "plan",
    clarificationCount: 0,
    planVersion: 0,
    ...overrides,
  }
}

function makePlanTopic(overrides: Partial<PlanTopic> = {}): PlanTopic {
  return {
    id: "topic-1",
    title: "Kinematics",
    description: "Basic motion",
    status: "pending",
    stage: 0,
    attemptCount: 0,
    hasPrerequisites: false,
    ...overrides,
  }
}

function makeSource(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: "src-1",
    kind: "text",
    uri: "notes.txt",
    title: "Physics notes",
    status: "ready",
    metadata: { trust: "unknown" },
    ...overrides,
  }
}

describe("isDeadlineClose", () => {
  test("returns false for undefined or no-deadline", () => {
    expect(isDeadlineClose(undefined)).toBe(false)
    expect(isDeadlineClose("no-deadline")).toBe(false)
  })

  test("returns true for within-7-days", () => {
    expect(isDeadlineClose("within-7-days")).toBe(true)
  })

  test("returns false for within-30-days", () => {
    expect(isDeadlineClose("within-30-days")).toBe(false)
  })

  test("returns true for a date 2 days away", () => {
    const ref = new Date("2026-06-25T12:00:00.000Z")
    expect(isDeadlineClose("2026-06-27", ref)).toBe(true)
  })

  test("returns true for ISO datetime within 7 days", () => {
    const ref = new Date("2026-06-25T12:00:00.000Z")
    expect(isDeadlineClose("2026-07-01T00:00:00.000Z", ref)).toBe(true)
  })

  test("returns false for a date more than 7 days away", () => {
    const ref = new Date("2026-06-25T12:00:00.000Z")
    expect(isDeadlineClose("2026-07-10", ref)).toBe(false)
  })

  test("returns false for invalid date strings", () => {
    expect(isDeadlineClose("not-a-date", new Date("2026-06-25T12:00:00.000Z"))).toBe(false)
    expect(isDeadlineClose("", new Date("2026-06-25T12:00:00.000Z"))).toBe(false)
  })

  test("returns false for past dates", () => {
    const ref = new Date("2026-06-25T12:00:00.000Z")
    expect(isDeadlineClose("2026-06-20", ref)).toBe(false)
  })
})

describe("decideStartup", () => {
  test("no course selected → choice with create/import options", () => {
    const state: StartupState = {
      courses: [],
      selectedCourse: null,
      planTopics: [],
      sources: [],
      now,
    }
    const decision = decideStartup(state)
    expect(decision.type).toBe("choice")
    if (decision.type === "choice") {
      expect(decision.message).toContain("What are we studying")
      expect(decision.options).toHaveLength(2)
      expect(decision.options[0].value).toBe("create_course")
      expect(decision.options[1].value).toBe("import_materials")
    }
  })

  test("no course but recent courses exist → includes open_recent with recommendation", () => {
    const state: StartupState = {
      courses: [{ id: "c1", name: "Math" }],
      selectedCourse: null,
      planTopics: [],
      sources: [],
      now,
    }
    const decision = decideStartup(state)
    expect(decision.type).toBe("choice")
    if (decision.type === "choice") {
      expect(decision.options).toHaveLength(3)
      expect(decision.options[0].value).toBe("open_recent")
      expect(decision.options[0].recommended).toBe(true)
      expect(decision.options[1].value).toBe("create_course")
    }
  })

  test("course selected with no materials and no plan", () => {
    const state: StartupState = {
      courses: [],
      selectedCourse: makeCourse(),
      planTopics: [],
      sources: [],
      now,
    }
    const decision = decideStartup(state)
    expect(decision.type).toBe("choice")
    if (decision.type === "choice") {
      expect(decision.message).toContain("no materials or learning path")
      expect(decision.options).toHaveLength(3)
      expect(decision.options[0].value).toBe("add_materials")
      expect(decision.options[0].recommended).toBe(true)
      expect(decision.options[1].value).toBe("rough_plan")
      expect(decision.options[2].value).toBe("ask_question")
    }
  })

  test("course selected with materials but no plan", () => {
    const state: StartupState = {
      courses: [],
      selectedCourse: makeCourse(),
      planTopics: [],
      sources: [makeSource()],
      now,
    }
    const decision = decideStartup(state)
    expect(decision.type).toBe("choice")
    if (decision.type === "choice") {
      expect(decision.message).toContain("no learning path yet")
      expect(decision.options).toHaveLength(3)
      expect(decision.options[0].value).toBe("make_plan")
      expect(decision.options[0].recommended).toBe(true)
      expect(decision.options[1].value).toBe("start_anyway")
      expect(decision.options[2].value).toBe("add_materials")
    }
  })

  test("course has plan and due reviews → direct message recommending review", () => {
    const state: StartupState = {
      courses: [],
      selectedCourse: makeCourse(),
      planTopics: [
        makePlanTopic({
          id: "t1",
          title: "Waves",
          status: "active",
          stage: 1,
          attemptCount: 1,
          dueAt: new Date("2026-06-26T12:00:00.000Z").toISOString(),
        }),
        makePlanTopic({
          id: "t2",
          title: "Optics",
          status: "pending",
          stage: 0,
          attemptCount: 1,
          dueAt: new Date("2026-06-25T12:00:00.000Z").toISOString(),
        }),
      ],
      sources: [],
      now,
    }
    const decision = decideStartup(state)
    expect(decision.type).toBe("message")
    if (decision.type === "message") {
      expect(decision.content).toContain("due before continuing")
      expect(decision.content).toContain("Optics")
      expect(decision.defaultAction).toBe("review_due")
    }
  })

  test("course has plan and no due reviews → direct message to continue", () => {
    const state: StartupState = {
      courses: [],
      selectedCourse: makeCourse(),
      planTopics: [
        makePlanTopic({
          id: "t1",
          title: "Mechanics",
          status: "pending",
          stage: 0,
          attemptCount: 0,
        }),
      ],
      sources: [],
      now,
    }
    const decision = decideStartup(state)
    expect(decision.type).toBe("message")
    if (decision.type === "message") {
      expect(decision.content).toContain("Continue with")
      expect(decision.content).toContain("Mechanics")
      expect(decision.content).toContain("Press Enter to start")
      expect(decision.defaultAction).toBe("continue_learning")
    }
  })

  test("deadline is close → exam rescue choice", () => {
    const state: StartupState = {
      courses: [],
      selectedCourse: makeCourse({ brief: { deadline: "within-7-days" } }),
      planTopics: [
        makePlanTopic({ id: "t1", title: "EM", status: "pending" }),
      ],
      sources: [],
      now,
    }
    const decision = decideStartup(state)
    expect(decision.type).toBe("choice")
    if (decision.type === "choice") {
      expect(decision.message).toContain("exam is close")
      expect(decision.options[0].value).toBe("exam_review")
      expect(decision.options[0].recommended).toBe(true)
      expect(decision.options[1].value).toBe("continue_normally")
      expect(decision.options[2].value).toBe("review_weak")
    }
  })

  test("course with plan, no due, no next pending → fallback message", () => {
    const state: StartupState = {
      courses: [],
      selectedCourse: makeCourse(),
      planTopics: [
        makePlanTopic({ id: "t1", title: "Done Topic", status: "done" }),
      ],
      sources: [],
      now,
    }
    const decision = decideStartup(state)
    expect(decision.type).toBe("message")
    if (decision.type === "message") {
      expect(decision.content).toContain("All planned topics are done")
    }
  })

  test("due topics sorted by weakest (lowest stage) first", () => {
    const state: StartupState = {
      courses: [],
      selectedCourse: makeCourse(),
      planTopics: [
        makePlanTopic({
          id: "t1",
          title: "Strong Topic",
          status: "active",
          stage: 3,
          attemptCount: 2,
          dueAt: new Date("2026-06-20T00:00:00.000Z").toISOString(),
        }),
        makePlanTopic({
          id: "t2",
          title: "Weak Topic",
          status: "active",
          stage: 0,
          attemptCount: 1,
          dueAt: new Date("2026-06-26T00:00:00.000Z").toISOString(),
        }),
      ],
      sources: [],
      now,
    }
    const decision = decideStartup(state)
    expect(decision.type).toBe("message")
    if (decision.type === "message") {
      expect(decision.content).toContain("Weak Topic")
    }
  })

  test("does not count 'done' topics as due", () => {
    const state: StartupState = {
      courses: [],
      selectedCourse: makeCourse(),
      planTopics: [
        makePlanTopic({
          id: "t1",
          title: "Done Topic",
          status: "done",
          attemptCount: 2,
          dueAt: new Date("2026-06-20T00:00:00.000Z").toISOString(),
        }),
        makePlanTopic({
          id: "t2",
          title: "Active Topic",
          status: "pending",
          attemptCount: 0,
        }),
      ],
      sources: [],
      now,
    }
    const decision = decideStartup(state)
    expect(decision.type).toBe("message")
    if (decision.type === "message") {
      expect(decision.content).toContain("Continue with Active Topic")
    }
  })
})
