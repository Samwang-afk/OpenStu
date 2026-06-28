import { afterEach, describe, expect, test } from "bun:test"
import { OpenStuDatabase } from "../src/adapters/database"

let database: OpenStuDatabase | undefined

afterEach(() => database?.close())

describe("OpenStuDatabase", () => {
  test("persists course, messages, chunks and progress", () => {
    database = new OpenStuDatabase(":memory:")
    const course = database.createCourse("CIE Physics")
    database.updateCourseBrief(course.id, { objective: "pass-exam", sourceScope: "official-first" }, 1)
    database.setCourseMode(course.id, "first")

    const session = database.createSession(course.id, "first")
    database.saveMessage(session, "user", "解释电磁感应")
    database.saveMessage(session, "assistant", "磁通量变化会产生感应电动势。")

    const source = database.addSource(course.id, {
      kind: "text",
      uri: "notes.txt",
      title: "Physics notes",
      contentHash: "hash-1",
    })
    database.replaceChunks(source, course.id, [
      { ordinal: 0, locator: "section 1", text: "电磁感应定律说明磁通量变化与感应电动势有关。" },
    ])

    database.saveTopicProgress(course.id, "电磁感应", {
      topicId: "topic-1",
      stage: 1,
      attemptCount: 1,
      mastery: "familiar",
      hintLevel: 0,
    })

    expect(database.getCourse(course.id)?.mode).toBe("first")
    expect(database.listMessages(session).map((message) => message.role)).toEqual(["user", "assistant"])
    expect(database.searchChunks(course.id, "磁感")[0]?.locator).toBe("section 1")
    expect(database.searchChunks(course.id, "请解释电磁感应为什么发生")[0]?.locator).toBe("section 1")
    expect(database.listTopicProgress(course.id)[0]?.mastery).toBe("familiar")
  })

  test("deduplicates sources by content hash", () => {
    database = new OpenStuDatabase(":memory:")
    const course = database.createCourse("Course")
    const source = { kind: "text", uri: "a.txt", title: "A", contentHash: "same" }
    expect(database.addSource(course.id, source)).toBe(database.addSource(course.id, source))
  })

  test("persists themes and preserves topic progress across replanning", () => {
    database = new OpenStuDatabase(":memory:")
    const course = database.createCourse("Course")
    database.updateStylePreference(course.id, "theme", "violet")
    database.replacePlan(course.id, [{ title: "动力学", description: "v1", prerequisites: [] }])
    const topic = database.listPlan(course.id)[0]!
    database.saveTopicProgress(course.id, topic.title, {
      topicId: topic.id,
      stage: 2,
      attemptCount: 3,
      mastery: "familiar",
      hintLevel: 0,
    })
    database.replacePlan(course.id, [{ title: "动力学", description: "v2", prerequisites: [] }])
    expect(database.getStylePreferences(course.id).theme).toBe("violet")
    expect(database.listPlan(course.id)[0]?.id).toBe(topic.id)
    expect(database.listPlan(course.id)[0]?.stage).toBe(2)
  })
})
