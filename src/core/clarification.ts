import type { ClarificationRequest, CourseBrief, TutorMode } from "./types"

export const MAX_CLARIFICATION_QUESTIONS = 3

const PLAN_QUESTIONS: ClarificationRequest[] = [
  {
    field: "objective",
    question: "这次学习最想达成什么结果？",
    reason: "目标决定课程范围和完成标准。",
    options: [
      { label: "通过考试", value: "pass-exam" },
      { label: "系统掌握", value: "master-course" },
      { label: "解决具体问题", value: "solve-problem" },
    ],
    recommendedValue: "master-course",
  },
  {
    field: "level",
    question: "你目前对这门课的熟悉程度？",
    reason: "起点决定讲解步幅和是否需要前置内容。",
    options: [
      { label: "零基础", value: "beginner" },
      { label: "学过一部分", value: "intermediate" },
      { label: "已有基础", value: "advanced" },
    ],
    recommendedValue: "beginner",
  },
  {
    field: "deadline",
    question: "是否有考试或完成期限？",
    reason: "期限决定计划密度和复习节奏。",
    options: [
      { label: "一周内", value: "within-7-days" },
      { label: "一个月内", value: "within-30-days" },
      { label: "没有固定期限", value: "no-deadline" },
    ],
    recommendedValue: "no-deadline",
  },
  {
    field: "sourceScope",
    question: "资料来源采用什么范围？",
    reason: "来源范围影响内容权威性和搜索边界。",
    options: [
      { label: "官方资料优先", value: "official-first" },
      { label: "只用已导入资料", value: "local-only" },
      { label: "官方与公开资料", value: "official-and-public" },
    ],
    recommendedValue: "official-first",
  },
]

const NOOB_QUESTIONS: ClarificationRequest[] = [
  {
    field: "examScope",
    question: "这次要突击哪场考试或哪些章节？",
    reason: "Noob 模式必须先确定取舍范围。",
    options: [
      { label: "整门课程", value: "whole-course" },
      { label: "最近章节", value: "recent-topics" },
      { label: "只看高频考点", value: "high-yield-only" },
    ],
    recommendedValue: "high-yield-only",
  },
  PLAN_QUESTIONS[2],
]

const DEFAULTS: Required<CourseBrief> = {
  objective: "master-course",
  level: "beginner",
  deadline: "no-deadline",
  sourceScope: "official-first",
  examScope: "high-yield-only",
}

export function nextClarification(
  mode: TutorMode,
  brief: CourseBrief,
  questionsAsked: number,
): ClarificationRequest | undefined {
  if (questionsAsked >= MAX_CLARIFICATION_QUESTIONS) return undefined
  const candidates = mode === "plan" ? PLAN_QUESTIONS : mode === "noob" ? NOOB_QUESTIONS : []
  return candidates.find((question) => !brief[question.field])
}

export function applyClarificationDefaults(brief: CourseBrief): Required<CourseBrief> {
  return {
    objective: brief.objective ?? DEFAULTS.objective,
    level: brief.level ?? DEFAULTS.level,
    deadline: brief.deadline ?? DEFAULTS.deadline,
    sourceScope: brief.sourceScope ?? DEFAULTS.sourceScope,
    examScope: brief.examScope ?? DEFAULTS.examScope,
  }
}

export function answerClarification(
  brief: CourseBrief,
  request: ClarificationRequest,
  answer: string,
): CourseBrief {
  const option = request.options.find(
    (candidate, index) => candidate.value === answer || candidate.label === answer || String(index + 1) === answer,
  )
  const value = answer === "defaults" ? request.recommendedValue : option?.value ?? answer
  return { ...brief, [request.field]: value }
}

export function validateClarification(request: ClarificationRequest): boolean {
  return (
    request.options.length >= 2 &&
    request.options.length <= 3 &&
    request.options.some((option) => option.value === request.recommendedValue)
  )
}

export function classifyAskResponseStyle(question: string): "direct" | "socratic" {
  const direct = /(?:是什么|定义|在哪|哪里|列出|何时|谁|怎么设置|how to (?:configure|install)|what is|where is|define)/i
  return direct.test(question.trim()) ? "direct" : "socratic"
}

export function isAmbiguousAsk(question: string): boolean {
  return /^(?:这个|它|这部分|为什么|怎么做|why|how|what about this)[？?。.\s]*$/i.test(question.trim())
}
