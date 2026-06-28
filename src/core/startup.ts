import type { CourseRecord, PlanTopic, SourceRecord } from "../adapters/database"

export interface StartupState {
  courses: Array<{ id: string; name: string }>
  selectedCourse: CourseRecord | null
  planTopics: PlanTopic[]
  sources: SourceRecord[]
  now?: Date
}

export type StartupDecision = StartupDirectMessage | StartupOptionBox

export interface StartupDirectMessage {
  type: "message"
  content: string
}

export interface StartupOptionBox {
  type: "choice"
  message: string
  options: StartupOption[]
}

export interface StartupOption {
  label: string
  value: string
  recommended?: boolean
}

export function decideStartup(state: StartupState): StartupDecision {
  const now = state.now ?? new Date()

  if (!state.selectedCourse) {
    return noCourseSelected(state.courses)
  }

  const hasMaterials = state.sources.length > 0
  const hasPlan = state.planTopics.length > 0

  if (!hasMaterials && !hasPlan) {
    return noMaterialsOrPlan()
  }

  if (hasMaterials && !hasPlan) {
    return hasMaterialsButNoPlan()
  }

  if (hasPlan) {
    return handlePlanState(state.planTopics, now, state.selectedCourse.brief)
  }

  return { type: "message", content: "What would you like to study today?" }
}

function noCourseSelected(courses: Array<{ id: string; name: string }>): StartupDecision {
  const options: StartupOption[] = []
  if (courses.length > 0) {
    options.push({ label: "Open recent course", value: "open_recent", recommended: true })
    options.push({ label: "Create course", value: "create_course" })
    options.push({ label: "Import materials", value: "import_materials" })
  } else {
    options.push({ label: "Create course", value: "create_course", recommended: true })
    options.push({ label: "Import materials", value: "import_materials" })
  }
  return {
    type: "choice",
    message: "What are we studying?",
    options,
  }
}

function noMaterialsOrPlan(): StartupDecision {
  return {
    type: "choice",
    message: "This subject has no materials or learning path yet.",
    options: [
      { label: "Add materials", value: "add_materials", recommended: true },
      { label: "Rough starter plan", value: "rough_plan" },
      { label: "Ask a question", value: "ask_question" },
    ],
  }
}

function hasMaterialsButNoPlan(): StartupDecision {
  return {
    type: "choice",
    message: "I have materials for this subject, but no learning path yet.",
    options: [
      { label: "Make plan", value: "make_plan", recommended: true },
      { label: "Start anyway", value: "start_anyway" },
      { label: "Add more materials", value: "add_materials" },
    ],
  }
}

function handlePlanState(
  planTopics: PlanTopic[],
  now: Date,
  brief: CourseRecord["brief"],
): StartupDecision {
  const deadlineClose = isDeadlineClose(brief.deadline)

  if (deadlineClose) {
    return {
      type: "choice",
      message: "The exam is close. High-yield review is more useful than rebuilding the whole plan right now.",
      options: [
        { label: "Start exam review", value: "exam_review", recommended: true },
        { label: "Continue normally", value: "continue_normally" },
        { label: "Review weak points", value: "review_weak" },
      ],
    }
  }

  const nowIso = now.toISOString()
  const dueTopics = planTopics.filter(
    (topic) =>
      topic.status !== "done" &&
      topic.attemptCount > 0 &&
      topic.dueAt &&
      topic.dueAt <= nowIso,
  )

  if (dueTopics.length > 0) {
    const count = dueTopics.length
    const weakest = dueTopics.sort((a, b) => a.stage - b.stage)[0]
    return {
      type: "message",
      content: `You have ${count} thing${count > 1 ? "s" : ""} due before continuing ${weakest.title}. I'll start with the weaker one.\n\nPress Enter to start.`,
    }
  }

  const nextTopic = planTopics.find((topic) => topic.status !== "done")
  if (nextTopic) {
    return {
      type: "message",
      content: `Continue with ${nextTopic.title}. I'll start with one quick question to check the prerequisite.\n\nPress Enter to start.`,
    }
  }

  return {
    type: "message",
    content: "All planned topics are done. What would you like to review or study next?",
  }
}

export function isDeadlineClose(deadline: string | undefined): boolean {
  if (!deadline || deadline === "no-deadline") return false
  return deadline === "within-7-days"
}
