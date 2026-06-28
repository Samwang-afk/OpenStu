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
  test("shows only the current mode above the large composer", async () => {
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
    expect(frame).toContain("● PLAN")
    expect(frame).not.toContain("First  Review")
    expect(frame.indexOf("● PLAN")).toBeLessThan(frame.indexOf("输入消息或 /help"))

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
})
