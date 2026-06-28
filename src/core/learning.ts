import type {
  AssessmentRubric,
  DiagnosisCandidate,
  Mastery,
  TopicProgress,
  TutorMode,
  ValidatedDiagnosis,
} from "./types"

export const REVIEW_INTERVAL_DAYS = [1, 3, 7, 14, 30] as const
export const MIN_DIAGNOSIS_CONFIDENCE = 0.75

export function masteryFor(stage: number, attemptCount: number): Mastery {
  if (attemptCount === 0) return "unseen"
  if (stage === 0) return "learning"
  if (stage <= 2) return "familiar"
  return "mastered"
}

export function validateDiagnosis(
  candidate: DiagnosisCandidate,
  rubric: AssessmentRubric,
  answer: string,
  currentStage: number,
): { valid: true; diagnosis: ValidatedDiagnosis } | { valid: false; reason: string } {
  if (candidate.topicId !== rubric.topicId || candidate.rubricId !== rubric.id) {
    return { valid: false, reason: "诊断与当前题目不匹配" }
  }
  if (candidate.confidence < MIN_DIAGNOSIS_CONFIDENCE) {
    return { valid: false, reason: `诊断置信度低于 ${MIN_DIAGNOSIS_CONFIDENCE}` }
  }
  if (!candidate.evidenceQuotes.some((quote) => quote.length > 0 && answer.includes(quote))) {
    return { valid: false, reason: "诊断没有引用学生原回答" }
  }

  const reason =
    candidate.correctness === "correct"
      ? candidate.hintLevel === 0
        ? "correct_no_hint"
        : "correct_with_hint"
      : candidate.correctness
  const toStage =
    reason === "correct_no_hint"
      ? Math.min(currentStage + 1, 4)
      : reason === "correct_with_hint"
        ? currentStage
        : reason === "partial"
          ? Math.max(currentStage - 1, 0)
          : 0

  return {
    valid: true,
    diagnosis: {
      ...candidate,
      expectedAnswerSummary: rubric.expectedAnswerSummary,
      stateChange: { fromStage: currentStage, toStage, reason },
    },
  }
}

export function nextReviewAt(stage: number, deadline: string | undefined, now = new Date()): string {
  const baseMs = REVIEW_INTERVAL_DAYS[stage] * 86_400_000
  let delayMs = baseMs
  if (deadline) {
    const target = new Date(deadline)
    if (!Number.isNaN(target.getTime())) {
      const horizonMs = target.getTime() - now.getTime()
      if (horizonMs <= 0) return now.toISOString()
      delayMs = Math.min(baseMs, horizonMs / Math.max(REVIEW_INTERVAL_DAYS.length - stage, 1))
    }
  }
  return new Date(now.getTime() + delayMs).toISOString()
}

export function applyDiagnosis(
  current: TopicProgress,
  diagnosis: ValidatedDiagnosis,
  mode: TutorMode,
  deadline?: string,
  now = new Date(),
): TopicProgress {
  if (mode === "ask" || mode === "noob") return current

  const stage = diagnosis.stateChange.toStage
  const attemptCount = current.attemptCount + 1

  return {
    ...current,
    stage,
    attemptCount,
    mastery: masteryFor(stage, attemptCount),
    dueAt: nextReviewAt(stage, deadline, now),
    lastResult: diagnosis.correctness,
    misconception: diagnosis.misconception,
    hintLevel: diagnosis.hintLevel,
  }
}
