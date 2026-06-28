import { describe, expect, test } from "bun:test"
import {
  answerClarification,
  applyClarificationDefaults,
  classifyAskResponseStyle,
  MAX_CLARIFICATION_QUESTIONS,
  nextClarification,
  validateClarification,
} from "../src/core/clarification"
import { applyDiagnosis, nextReviewAt, validateDiagnosis } from "../src/core/learning"
import { switchMode } from "../src/core/modes"
import type { AssessmentRubric, DiagnosisCandidate, TopicProgress, ValidatedDiagnosis } from "../src/core/types"
import { loadModelConfig } from "../src/adapters/model"

describe("mode switching", () => {
  test("cycles in both directions and blocks while generating", () => {
    expect(switchMode("plan", 1, false).mode).toBe("first")
    expect(switchMode("plan", -1, false).mode).toBe("ask")
    expect(switchMode("review", 1, true)).toEqual({
      mode: "review",
      changed: false,
      notice: "先按 Ctrl+C 取消当前回答",
    })
  })
})

test("does not silently fall back to Ollama without configuration", () => {
  expect(loadModelConfig({ OPENSTU_CONFIG: "Z:\\missing-openstu-config.json" } as NodeJS.ProcessEnv)).toBeUndefined()
})

describe("clarification gate", () => {
  test("asks one valid question and stops after three", () => {
    const question = nextClarification("plan", {}, 0)!
    expect(question.field).toBe("objective")
    expect(validateClarification(question)).toBe(true)
    expect(nextClarification("plan", {}, MAX_CLARIFICATION_QUESTIONS)).toBeUndefined()
    expect(nextClarification("review", {}, 0)).toBeUndefined()
  })

  test("accepts defaults and fills remaining optional context", () => {
    const question = nextClarification("plan", {}, 0)!
    const answered = answerClarification({}, question, "defaults")
    expect(answered.objective).toBe(question.recommendedValue)
    expect(applyClarificationDefaults(answered).sourceScope).toBe("official-first")
    expect(answerClarification({}, question, "1").objective).toBe("pass-exam")
  })

  test("classifies direct and socratic Ask prompts", () => {
    expect(classifyAskResponseStyle("电磁感应的定义是什么？")).toBe("direct")
    expect(classifyAskResponseStyle("为什么线圈转动会产生电流？")).toBe("socratic")
  })
})

describe("learning progress", () => {
  const unseen: TopicProgress = {
    topicId: "topic-1",
    stage: 0,
    attemptCount: 0,
    mastery: "unseen",
    hintLevel: 0,
  }
  const rubric: AssessmentRubric = {
    id: "rubric-1",
    topicId: "topic-1",
    question: "牛顿第二定律是什么？",
    questionType: "recall",
    expectedAnswerSummary: "合力等于质量乘加速度",
    criteria: ["说明 F=ma"],
    schemaVersion: 1,
  }
  const candidate: DiagnosisCandidate = {
    topicId: "topic-1",
    rubricId: "rubric-1",
    correctness: "correct",
    hintLevel: 0,
    confidence: 0.9,
    observedAnswerSummary: "给出了公式",
    diagnosisReason: "符合评分条件",
    evidenceQuotes: ["F=ma"],
  }

  test("advances on an unassisted correct answer", () => {
    const checked = validateDiagnosis(candidate, rubric, "答案是 F=ma", unseen.stage)
    expect(checked.valid).toBe(true)
    const result = applyDiagnosis(
      unseen,
      (checked as { valid: true; diagnosis: ValidatedDiagnosis }).diagnosis,
      "first",
      undefined,
      new Date("2026-06-27T00:00:00.000Z"),
    )
    expect(result.stage).toBe(1)
    expect(result.mastery).toBe("familiar")
    expect(result.dueAt).toBe("2026-06-30T00:00:00.000Z")
  })

  test("does not mutate mastery in Ask or Noob", () => {
    const diagnosis: ValidatedDiagnosis = {
      ...candidate,
      expectedAnswerSummary: rubric.expectedAnswerSummary,
      stateChange: { fromStage: 0, toStage: 1, reason: "correct_no_hint" },
    }
    expect(applyDiagnosis(unseen, diagnosis, "ask")).toBe(unseen)
    expect(applyDiagnosis(unseen, diagnosis, "noob")).toBe(unseen)
  })

  test("rejects low-confidence or fabricated evidence and compresses reviews before a deadline", () => {
    expect(validateDiagnosis({ ...candidate, confidence: 0.5 }, rubric, "答案是 F=ma", 0).valid).toBe(false)
    expect(validateDiagnosis({ ...candidate, evidenceQuotes: ["不存在"] }, rubric, "答案是 F=ma", 0).valid).toBe(false)
    const due = nextReviewAt(4, "2026-06-28T00:00:00.000Z", new Date("2026-06-27T00:00:00.000Z"))
    expect(due).toBe("2026-06-28T00:00:00.000Z")
  })
})
