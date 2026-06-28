import { describe, expect, test } from "bun:test"
import { ACTION_REGISTRY, filterActions, isActionAvailable } from "../src/tui/actions"

describe("ACTION_REGISTRY", () => {
  test("has exactly 11 actions", () => {
    expect(ACTION_REGISTRY).toHaveLength(11)
  })

  test("contains all required action IDs", () => {
    const ids = ACTION_REGISTRY.map((a) => a.id)
    expect(ids).toContain("switch_course")
    expect(ids).toContain("create_course")
    expect(ids).toContain("add_materials")
    expect(ids).toContain("configure_provider")
    expect(ids).toContain("view_progress")
    expect(ids).toContain("view_sources")
    expect(ids).toContain("make_plan")
    expect(ids).toContain("exam_review")
    expect(ids).toContain("change_style")
    expect(ids).toContain("help")
    expect(ids).toContain("quit")
  })

  test("course-less actions do not require course", () => {
    const courseLess = ["switch_course", "create_course", "configure_provider", "help", "quit"]
    for (const id of courseLess) {
      const action = ACTION_REGISTRY.find((a) => a.id === id)
      expect(action?.requiresCourse).toBe(false)
    }
  })

  test("course-required actions require course", () => {
    const requiresCourse = ["add_materials", "view_progress", "view_sources", "make_plan", "exam_review", "change_style"]
    for (const id of requiresCourse) {
      const action = ACTION_REGISTRY.find((a) => a.id === id)
      expect(action?.requiresCourse).toBe(true)
    }
  })
})

describe("filterActions", () => {
  test("returns all actions when filter is empty", () => {
    expect(filterActions(ACTION_REGISTRY, "")).toHaveLength(11)
  })

  test("filters by label substring case-insensitively", () => {
    const results = filterActions(ACTION_REGISTRY, "plan")
    expect(results).toHaveLength(1)
    expect(results[0].id).toBe("make_plan")
  })

  test("filters by partial match", () => {
    const results = filterActions(ACTION_REGISTRY, "view")
    expect(results).toHaveLength(3)
    expect(results.map((a) => a.id)).toContain("view_progress")
    expect(results.map((a) => a.id)).toContain("view_sources")
    expect(results.map((a) => a.id)).toContain("exam_review")
  })

  test("returns empty when no match", () => {
    expect(filterActions(ACTION_REGISTRY, "zzz_nonexistent")).toHaveLength(0)
  })

  test("does not mutate the original registry", () => {
    const copy = [...ACTION_REGISTRY]
    filterActions(ACTION_REGISTRY, "help")
    expect(ACTION_REGISTRY).toEqual(copy)
  })
})

describe("isActionAvailable", () => {
  test("course-less actions always available", () => {
    expect(isActionAvailable({ id: "help", label: "Help", requiresCourse: false }, { hasCourse: false, hasCourses: false })).toBe(true)
  })

  test("course-required actions available when course selected", () => {
    expect(isActionAvailable({ id: "view_progress", label: "View progress", requiresCourse: true }, { hasCourse: true, hasCourses: true })).toBe(true)
  })

  test("course-required actions unavailable when no course", () => {
    expect(isActionAvailable({ id: "view_progress", label: "View progress", requiresCourse: true }, { hasCourse: false, hasCourses: true })).toBe(false)
  })
})
