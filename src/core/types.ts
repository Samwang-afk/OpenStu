export const MODES = ["plan", "first", "review", "noob", "ask"] as const
export const THEMES = ["cyan", "violet", "amber"] as const

export type TutorMode = (typeof MODES)[number]
export type VisualTheme = (typeof THEMES)[number]
export type Mastery = "unseen" | "learning" | "familiar" | "mastered"
export type AskResponseStyle = "direct" | "socratic"
export type Correctness = "incorrect" | "partial" | "correct"
export type StateChangeReason =
  | "correct_no_hint"
  | "correct_with_hint"
  | "partial"
  | "incorrect"
  | "noob_exposure"

export interface ClarificationOption {
  label: string
  value: string
}

export interface ClarificationRequest {
  field: keyof CourseBrief
  question: string
  reason: string
  options: ClarificationOption[]
  recommendedValue: string
}

export interface CourseBrief {
  objective?: string
  level?: string
  deadline?: string
  sourceScope?: string
  examScope?: string
}

export interface AssessmentRubric {
  id: string
  topicId: string
  question: string
  questionType: "recall" | "application" | "transfer" | "prerequisite_probe"
  expectedAnswerSummary: string
  criteria: string[]
  schemaVersion: number
}

export interface DiagnosisCandidate {
  topicId: string
  rubricId: string
  correctness: Correctness
  hintLevel: 0 | 1 | 2
  confidence: number
  observedAnswerSummary: string
  diagnosisReason: string
  evidenceQuotes: string[]
  misconception?: string
}

export interface ValidatedDiagnosis extends DiagnosisCandidate {
  expectedAnswerSummary: string
  stateChange: {
    fromStage: number
    toStage: number
    reason: StateChangeReason
  }
}

export interface Citation {
  sourceId: string
  chunkId: string
  locator: string
  sourceTitle?: string
}

export interface TopicProgress {
  topicId: string
  stage: number
  attemptCount: number
  mastery: Mastery
  dueAt?: string
  lastResult?: Correctness
  misconception?: string
  hintLevel: 0 | 1 | 2
}

export interface SourceChunk {
  id: string
  sourceId: string
  courseId: string
  ordinal: number
  locator: string
  text: string
  contentHash: string
}

export interface SearchResult extends SourceChunk {
  sourceTitle: string
}

export interface PresentationStyle {
  theme: VisualTheme
  sequence: string
  verbosity: string
  stepSize: string
  challenge: string
  analogyDensity: string
}

export type SourceTrust = "official" | "instructor" | "institution" | "textbook" | "third_party" | "unknown"

export interface SourceMetadata {
  trust: SourceTrust
  courseVersion?: string
  institution?: string
  term?: string
}
