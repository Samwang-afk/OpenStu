#!/usr/bin/env bun
import { basename, extname } from "node:path"
import { OpenStuDatabase } from "./adapters/database"
import { TutorModel } from "./adapters/model"
import { TutorService } from "./core/tutor"
import { SourceService } from "./core/source-service"
import { runTui } from "./tui/app"

const { courseName, sources } = parseArguments(Bun.argv.slice(2))
const database = new OpenStuDatabase()

try {
  const existing = courseName
    ? database.listCourses().find((course) => course.name.toLowerCase() === courseName.toLowerCase())
    : database.listCourses()[0]
  const inferredName = courseName || inferCourseName(sources) || "New Course"
  const course = existing ?? database.createCourse(inferredName)
  const sessionId = database.createSession(course.id, course.mode)
  const notices: string[] = []
  const model = new TutorModel()
  if (model.config) {
    try {
      await model.checkCapabilities()
    } catch (error) {
      notices.push(error instanceof Error ? error.message : String(error))
    }
  } else {
    notices.push("尚未连接模型。输入 /model 在界面内配置。")
  }
  const tutor = new TutorService(database, model)
  const sourceService = new SourceService(database)

  if (sources.length) {
    const results = await sourceService.import(course.id, sources)
    notices.push(
      ...results.map((result) =>
        result.status === "imported"
          ? `已导入 ${result.title}（${result.chunks} 个片段）`
          : `导入失败 ${result.input}：${result.error}`,
      ),
    )
  }

  await runTui(
    {
      database,
      tutor,
      model,
      sourceService,
      initialCourse: course,
      initialSessionId: sessionId,
      initialNotices: notices,
    },
    () => database.close(),
  )
} catch (error) {
  database.close()
  throw error
}

function parseArguments(args: string[]): { courseName?: string; sources: string[] } {
  const sources: string[] = []
  let courseName: string | undefined
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--course") {
      courseName = args[++index]
    } else if (args[index] === "--help" || args[index] === "-h") {
      console.log("用法：openstu [--course <名称>] [文件|目录|URL]...")
      process.exit(0)
    } else if (args[index] === "--version" || args[index] === "-v") {
      console.log("0.1.0")
      process.exit(0)
    } else {
      sources.push(args[index])
    }
  }
  return { courseName, sources }
}

function inferCourseName(sources: string[]): string | undefined {
  const first = sources[0]
  if (!first) return undefined
  if (/^https?:\/\//i.test(first)) return new URL(first).hostname
  return basename(first, extname(first))
}
