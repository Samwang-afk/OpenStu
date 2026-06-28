import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { OpenStuDatabase } from "../src/adapters/database"
import type { TutorModel } from "../src/adapters/model"
import type { SourceService } from "../src/core/source-service"
import type { TutorService } from "../src/core/tutor"
import { OpenStuApp } from "../src/tui/app"

let database: OpenStuDatabase | undefined

afterEach(() => database?.close())

describe("OpenStu TUI", () => {
  test("renders minimal layout with status line, conversation, and input box", async () => {
    database = new OpenStuDatabase(":memory:")
    const course = database.createCourse("Physics")
    const session = database.createSession(course.id, "plan")
    const setup = await testRender(
      () => (
        <OpenStuApp
          database={database!}
          tutor={{} as TutorService}
          model={{ config: { provider: "ollama", model: "test" } } as TutorModel}
          sourceService={{} as SourceService}
          initialCourse={course}
          initialSessionId={session}
        />
      ),
      { width: 50, height: 16 },
    )
    await setup.renderOnce()
    await setup.flush()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("OpenStu")
    expect(frame).toContain("Physics")
    expect(frame).not.toContain("● PLAN")
    expect(frame).not.toContain("Tab / Shift+Tab 切换模式")
    expect(frame).toContain("Ctrl+X")

    setup.renderer.destroy()
  })

  test("shows No Subject and offline when launched without a course", async () => {
    database = new OpenStuDatabase(":memory:")
    const setup = await testRender(
      () => (
        <OpenStuApp
          database={database!}
          tutor={{} as TutorService}
          model={{ connected: false, capabilities: { streaming: false, structuredOutput: false } } as TutorModel}
          sourceService={{} as SourceService}
          initialCourse={null}
          initialSessionId={null}
        />
      ),
      { width: 50, height: 16 },
    )
    await setup.renderOnce()
    await setup.flush()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("OpenStu")
    expect(frame).toContain("No Subject")
    expect(frame).toContain("offline")
    expect(frame).not.toContain("● PLAN")

    setup.renderer.destroy()
  })

  test("starts the in-app model setup when no provider is configured", async () => {
    database = new OpenStuDatabase(":memory:")
    const course = database.createCourse("Physics")
    const session = database.createSession(course.id, "plan")
    const setup = await testRender(
      () => (
        <OpenStuApp
          database={database!}
          tutor={{} as TutorService}
          model={{ connected: false, capabilities: { streaming: false, structuredOutput: false } } as TutorModel}
          sourceService={{} as SourceService}
          initialCourse={course}
          initialSessionId={session}
        />
      ),
      { width: 70, height: 20 },
    )
    await setup.renderOnce()
    await setup.flush()
    expect(setup.captureCharFrame()).toContain("未连接 · /model")
    setup.renderer.destroy()
  })

  test("renders markdown without exposing its syntax", async () => {
    database = new OpenStuDatabase(":memory:")
    const course = database.createCourse("Physics")
    const session = database.createSession(course.id, "ask")
    const setup = await testRender(
      () => (
        <OpenStuApp
          database={database!}
          tutor={{} as TutorService}
          model={{ connected: true, config: { provider: "ollama", model: "test" } } as TutorModel}
          sourceService={{} as SourceService}
          initialCourse={course}
          initialSessionId={session}
          initialNotices={["**bold**"]}
        />
      ),
      { width: 70, height: 20 },
    )

    await setup.renderOnce()
    await setup.waitForVisualIdle()
    const frame = setup.captureCharFrame()
    expect(frame).toContain("bold")
    expect(frame).not.toContain("**bold**")
    setup.renderer.destroy()
  })
})
