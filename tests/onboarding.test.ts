import { describe, expect, test } from "bun:test"
import { OpenStuDatabase, type CourseRecord, type SourceRecord } from "../src/adapters/database"
import type { SourceService } from "../src/core/source-service"

describe("Onboarding: create and switch courses", () => {
  let database: OpenStuDatabase | undefined

  test("create course persists and appears in course list", () => {
    database = new OpenStuDatabase(":memory:")
    const course = database.createCourse("New Subject")
    expect(course.name).toBe("New Subject")
    expect(database.getCourse(course.id)?.name).toBe("New Subject")
    expect(database.listCourses()).toHaveLength(1)
    database.close()
  })

  test("switch course selects correct course by name", () => {
    database = new OpenStuDatabase(":memory:")
    const physics = database.createCourse("Physics")
    database.createCourse("Chemistry")
    const target = database.listCourses().find((c) => c.name.toLowerCase() === "physics".toLowerCase())
    expect(target?.id).toBe(physics.id)
    expect(target?.name).toBe("Physics")
    database.close()
  })

  test("switch course by index works", () => {
    database = new OpenStuDatabase(":memory:")
    database.createCourse("First Course")
    database.createCourse("Second Course")
    const courses = database.listCourses()
    expect(courses[0].name).toBeDefined()
    expect(courses[1].name).toBeDefined()
    expect(courses[0].id).not.toBe(courses[1].id)
    database.close()
  })

  test("add source to course imports correctly", async () => {
    database = new OpenStuDatabase(":memory:")
    const course = database.createCourse("Physics")
    const sourceId = database.addSource(course.id, {
      kind: "text",
      uri: "test.md",
      title: "Test Notes",
      contentHash: "hash-abc",
    })
    database.replaceChunks(sourceId, course.id, [
      { ordinal: 0, locator: "p1", text: "Newton's laws of motion." },
    ])
    const sources = database.listSources(course.id)
    expect(sources).toHaveLength(1)
    expect(sources[0].title).toBe("Test Notes")
    const chunks = database.searchChunks(course.id, "Newton", 3)
    expect(chunks).toHaveLength(1)
    database.close()
  })
})
