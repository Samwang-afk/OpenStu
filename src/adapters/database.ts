import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type {
  Citation,
  AssessmentRubric,
  CourseBrief,
  DiagnosisCandidate,
  SearchResult,
  SourceMetadata,
  SourceChunk,
  TopicProgress,
  TutorMode,
  ValidatedDiagnosis,
  PresentationStyle,
} from "../core/types"
import { masteryFor } from "../core/learning"

interface CourseRow {
  id: string
  name: string
  objective: string | null
  current_level: string | null
  deadline: string | null
  source_scope: string | null
  exam_scope: string | null
  mode: TutorMode
  clarification_count: number
  plan_version: number
}

export interface CourseRecord {
  id: string
  name: string
  brief: CourseBrief
  mode: TutorMode
  clarificationCount: number
  planVersion: number
}

export interface MessageRecord {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  citations: Citation[]
  learningEvidence: boolean
  status: "complete" | "canceled" | "error"
  createdAt: string
}

export interface SessionState {
  pendingClarification?: import("../core/types").ClarificationRequest
  clarificationCount?: number
  clarificationMode?: TutorMode
  awaitingTopicId?: string
  awaitingRubricId?: string
  firstPhase?: "probe" | "assessment"
  learningMode?: "first" | "review"
  pendingAskQuestion?: string
  sourceSearchOffered?: boolean
}

export interface PlanTopic {
  id: string
  title: string
  description: string
  status: "pending" | "active" | "done"
  stage: number
  attemptCount: number
  dueAt?: string
  lastResult?: import("../core/types").Correctness
  hasPrerequisites: boolean
}

export interface SourceRecord {
  id: string
  kind: string
  uri: string
  title: string
  status: string
  metadata: SourceMetadata
}

export type StylePreferences = PresentationStyle

export function defaultDatabasePath(): string {
  const base =
    process.platform === "win32"
      ? process.env.APPDATA || join(homedir(), "AppData", "Roaming")
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support")
        : process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  return join(base, "openstu", "openstu.db")
}

export class OpenStuDatabase {
  readonly db: Database
  readonly ftsMode: "trigram" | "unicode61" | "substring"
  private readonly hasUnicodeFts: boolean

  constructor(path = defaultDatabasePath()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    this.db.run("PRAGMA foreign_keys = ON")
    if (path !== ":memory:") this.db.run("PRAGMA journal_mode = WAL")
    this.migrate()
    const search = this.createSearchIndexes()
    this.ftsMode = search.mode
    this.hasUnicodeFts = search.unicode
  }

  close(): void {
    this.db.close()
  }

  private migrate(): void {
    const apply = this.db.transaction(() => {
      this.db.run("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)")
      let version = this.db.query<{ version: number }, []>("SELECT version FROM schema_version LIMIT 1").get()?.version ?? 0
      if (version < 1) {
        this.db.run(`
        CREATE TABLE courses (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          objective TEXT,
          current_level TEXT,
          deadline TEXT,
          source_scope TEXT,
          exam_scope TEXT,
          mode TEXT NOT NULL DEFAULT 'plan',
          clarification_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE sources (
          id TEXT PRIMARY KEY,
          course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          uri TEXT NOT NULL,
          title TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          status TEXT NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          UNIQUE(course_id, content_hash)
        );
        CREATE TABLE chunks (
          id TEXT PRIMARY KEY,
          source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
          course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL,
          locator TEXT NOT NULL,
          text TEXT NOT NULL
        );
        CREATE TABLE topics (
          id TEXT PRIMARY KEY,
          course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          review_step INTEGER NOT NULL DEFAULT 0,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_review_at TEXT,
          last_seen_at TEXT,
          misconception TEXT,
          hint_level INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE topic_dependencies (
          topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
          prerequisite_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
          PRIMARY KEY(topic_id, prerequisite_id)
        );
        CREATE TABLE plan_items (
          id TEXT PRIMARY KEY,
          course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
          topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
          ordinal INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          scheduled_for TEXT
        );
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
          mode TEXT NOT NULL,
          clarification_json TEXT NOT NULL DEFAULT '{}',
          started_at TEXT NOT NULL,
          ended_at TEXT
        );
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          citations_json TEXT NOT NULL DEFAULT '[]',
          learning_evidence INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE TABLE attempts (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
          answer TEXT NOT NULL,
          correctness TEXT NOT NULL,
          hint_level INTEGER NOT NULL,
          diagnosis_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE style_preferences (
          course_id TEXT PRIMARY KEY REFERENCES courses(id) ON DELETE CASCADE,
          sequence TEXT NOT NULL DEFAULT 'balanced',
          verbosity TEXT NOT NULL DEFAULT 'normal',
          step_size TEXT NOT NULL DEFAULT 'medium',
          challenge TEXT NOT NULL DEFAULT 'balanced',
          analogy_density TEXT NOT NULL DEFAULT 'medium'
        );
      `)
        this.db.run("DELETE FROM schema_version")
        this.db.run("INSERT INTO schema_version VALUES (1)")
        version = 1
      }

      if (version < 2) {
        this.db.run("ALTER TABLE courses ADD COLUMN plan_version INTEGER NOT NULL DEFAULT 0")
        this.db.run("ALTER TABLE chunks ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''")
        this.db.run("UPDATE chunks SET content_hash = id WHERE content_hash = ''")
        this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS chunks_source_hash ON chunks(source_id, content_hash)")
        this.db.run("ALTER TABLE topics ADD COLUMN topic_key TEXT")
        this.db.run("UPDATE topics SET topic_key = lower(trim(title)) WHERE topic_key IS NULL")
        this.db.run("ALTER TABLE topics ADD COLUMN version INTEGER NOT NULL DEFAULT 1")
        this.db.run("ALTER TABLE topics ADD COLUMN archived INTEGER NOT NULL DEFAULT 0")
        this.db.run("ALTER TABLE topics ADD COLUMN last_result TEXT")
        this.db.run("CREATE INDEX IF NOT EXISTS topics_course_key ON topics(course_id, topic_key)")
        this.db.run("ALTER TABLE plan_items ADD COLUMN plan_version INTEGER NOT NULL DEFAULT 0")
        this.db.run("ALTER TABLE messages ADD COLUMN status TEXT NOT NULL DEFAULT 'complete'")
        this.db.run("ALTER TABLE attempts ADD COLUMN rubric_id TEXT")
        this.db.run("ALTER TABLE attempts ADD COLUMN confidence REAL")
        this.db.run("ALTER TABLE attempts ADD COLUMN diagnosis_schema_version INTEGER NOT NULL DEFAULT 1")
        this.db.run("ALTER TABLE attempts ADD COLUMN provider TEXT")
        this.db.run("ALTER TABLE attempts ADD COLUMN model TEXT")
        this.db.run("ALTER TABLE attempts ADD COLUMN prompt_version TEXT")
        this.db.run("ALTER TABLE attempts ADD COLUMN validated INTEGER NOT NULL DEFAULT 0")
        this.db.run("ALTER TABLE attempts ADD COLUMN rejection_reason TEXT")
        this.db.run("ALTER TABLE attempts ADD COLUMN from_stage INTEGER")
        this.db.run("ALTER TABLE attempts ADD COLUMN to_stage INTEGER")
        this.db.run("ALTER TABLE attempts ADD COLUMN state_change_reason TEXT")
        this.db.run("ALTER TABLE style_preferences ADD COLUMN theme TEXT NOT NULL DEFAULT 'cyan'")
        this.db.run(`
          CREATE TABLE rubrics (
            id TEXT PRIMARY KEY,
            topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
            question TEXT NOT NULL,
            question_type TEXT NOT NULL,
            expected_answer_summary TEXT NOT NULL,
            criteria_json TEXT NOT NULL,
            schema_version INTEGER NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE TABLE noob_exposures (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
            topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL
          );
          CREATE TABLE learning_events (
            id TEXT PRIMARY KEY,
            course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
            session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
            type TEXT NOT NULL,
            payload_json TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL
          );
        `)
        this.db.run("DELETE FROM schema_version")
        this.db.run("INSERT INTO schema_version VALUES (2)")
      }
    })
    apply()
  }

  private createSearchIndexes(): { mode: "trigram" | "unicode61" | "substring"; unicode: boolean } {
    try {
      this.db.run("DROP TABLE IF EXISTS chunks_fts")
    } catch {}
    let unicode = false
    let trigram = false
    try {
      this.db.run("CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts_unicode USING fts5(chunk_id UNINDEXED, course_id UNINDEXED, text, tokenize='unicode61')")
      unicode = true
    } catch {}
    try {
      this.db.run("CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts_trigram USING fts5(chunk_id UNINDEXED, course_id UNINDEXED, text, tokenize='trigram')")
      trigram = true
    } catch {}
    for (const table of [unicode && "chunks_fts_unicode", trigram && "chunks_fts_trigram"].filter(Boolean) as string[]) {
      this.db.run(`DELETE FROM ${table}`)
      this.db.run(`INSERT INTO ${table} (chunk_id, course_id, text) SELECT id, course_id, text FROM chunks`)
    }
    return { mode: trigram ? "trigram" : unicode ? "unicode61" : "substring", unicode }
  }

  createCourse(name: string): CourseRecord {
    const id = crypto.randomUUID()
    const now = new Date().toISOString()
    this.db
      .query("INSERT INTO courses (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(id, name, now, now)
    this.db.query("INSERT INTO style_preferences (course_id) VALUES (?)").run(id)
    return this.getCourse(id)!
  }

  getCourse(id: string): CourseRecord | undefined {
    const row = this.db.query<CourseRow, [string]>("SELECT * FROM courses WHERE id = ?").get(id)
    return row ? this.mapCourse(row) : undefined
  }

  listCourses(): CourseRecord[] {
    return this.db
      .query<CourseRow, []>("SELECT * FROM courses ORDER BY updated_at DESC")
      .all()
      .map((row) => this.mapCourse(row))
  }

  updateCourseBrief(id: string, brief: CourseBrief, clarificationCount?: number): void {
    this.db
      .query(`
        UPDATE courses SET objective = ?, current_level = ?, deadline = ?, source_scope = ?, exam_scope = ?,
          clarification_count = COALESCE(?, clarification_count), updated_at = ? WHERE id = ?
      `)
      .run(
        brief.objective ?? null,
        brief.level ?? null,
        brief.deadline ?? null,
        brief.sourceScope ?? null,
        brief.examScope ?? null,
        clarificationCount ?? null,
        new Date().toISOString(),
        id,
      )
  }

  setCourseMode(id: string, mode: TutorMode): void {
    this.db
      .query("UPDATE courses SET mode = ?, updated_at = ? WHERE id = ?")
      .run(mode, new Date().toISOString(), id)
  }

  createSession(courseId: string, mode: TutorMode): string {
    const id = crypto.randomUUID()
    this.db
      .query("INSERT INTO sessions (id, course_id, mode, started_at) VALUES (?, ?, ?, ?)")
      .run(id, courseId, mode, new Date().toISOString())
    return id
  }

  getSessionState(sessionId: string): SessionState {
    const row = this.db
      .query<{ clarification_json: string }, [string]>("SELECT clarification_json FROM sessions WHERE id = ?")
      .get(sessionId)
    return row ? JSON.parse(row.clarification_json) : {}
  }

  setSessionState(sessionId: string, state: SessionState): void {
    this.db.query("UPDATE sessions SET clarification_json = ? WHERE id = ?").run(JSON.stringify(state), sessionId)
  }

  setSessionMode(sessionId: string, mode: TutorMode): void {
    this.db.query("UPDATE sessions SET mode = ? WHERE id = ?").run(mode, sessionId)
  }

  saveMessage(
    sessionId: string,
    role: MessageRecord["role"],
    content: string,
    citations: Citation[] = [],
    learningEvidence = false,
    status: MessageRecord["status"] = "complete",
  ): string {
    const id = crypto.randomUUID()
    this.db
      .query(`
        INSERT INTO messages (id, session_id, role, content, citations_json, learning_evidence, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(id, sessionId, role, content, JSON.stringify(citations), learningEvidence ? 1 : 0, status, new Date().toISOString())
    return id
  }

  listMessages(sessionId: string): MessageRecord[] {
    const rows = this.db
      .query<{
        id: string
        role: MessageRecord["role"]
        content: string
        citations_json: string
        learning_evidence: number
        status: MessageRecord["status"]
        created_at: string
      }, [string]>("SELECT * FROM messages WHERE session_id = ? ORDER BY created_at, rowid")
      .all(sessionId)
    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      citations: JSON.parse(row.citations_json),
      learningEvidence: row.learning_evidence === 1,
      status: row.status,
      createdAt: row.created_at,
    }))
  }

  listSources(courseId: string): SourceRecord[] {
    return this.db
      .query<{
        id: string
        kind: string
        uri: string
        title: string
        status: string
        metadata_json: string
      }, [string]>("SELECT id, kind, uri, title, status, metadata_json FROM sources WHERE course_id = ? ORDER BY created_at")
      .all(courseId)
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        uri: row.uri,
        title: row.title,
        status: row.status,
        metadata: { trust: "unknown", ...JSON.parse(row.metadata_json) },
      }))
  }

  getStylePreferences(courseId: string): StylePreferences {
    const row = this.db
      .query<{
        theme: import("../core/types").VisualTheme
        sequence: string
        verbosity: string
        step_size: string
        challenge: string
        analogy_density: string
      }, [string]>("SELECT * FROM style_preferences WHERE course_id = ?")
      .get(courseId)
    return {
      theme: row?.theme ?? "cyan",
      sequence: row?.sequence ?? "balanced",
      verbosity: row?.verbosity ?? "normal",
      stepSize: row?.step_size ?? "medium",
      challenge: row?.challenge ?? "balanced",
      analogyDensity: row?.analogy_density ?? "medium",
    }
  }

  updateStylePreference(courseId: string, key: keyof StylePreferences, value: string): void {
    const columns: Record<keyof StylePreferences, string> = {
      theme: "theme",
      sequence: "sequence",
      verbosity: "verbosity",
      stepSize: "step_size",
      challenge: "challenge",
      analogyDensity: "analogy_density",
    }
    this.db.query(`UPDATE style_preferences SET ${columns[key]} = ? WHERE course_id = ?`).run(value, courseId)
  }

  addSource(
    courseId: string,
    input: { kind: string; uri: string; title: string; contentHash: string; metadata?: Partial<SourceMetadata> },
  ): string {
    const existing = this.db
      .query<{ id: string }, [string, string]>("SELECT id FROM sources WHERE course_id = ? AND content_hash = ?")
      .get(courseId, input.contentHash)
    if (existing) return existing.id
    const id = crypto.randomUUID()
    this.db
      .query(`
        INSERT INTO sources (id, course_id, kind, uri, title, content_hash, status, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'ready', ?, ?)
      `)
      .run(
        id,
        courseId,
        input.kind,
        input.uri,
        input.title,
        input.contentHash,
        JSON.stringify({ trust: "unknown", ...input.metadata }),
        new Date().toISOString(),
      )
    return id
  }

  replaceChunks(
    sourceId: string,
    courseId: string,
    chunks: Array<Omit<SourceChunk, "id" | "sourceId" | "courseId" | "contentHash"> & { contentHash?: string }>,
  ): void {
    const replace = this.db.transaction(() => {
      if (this.hasUnicodeFts) this.db.query("DELETE FROM chunks_fts_unicode WHERE chunk_id IN (SELECT id FROM chunks WHERE source_id = ?)").run(sourceId)
      if (this.ftsMode === "trigram") this.db.query("DELETE FROM chunks_fts_trigram WHERE chunk_id IN (SELECT id FROM chunks WHERE source_id = ?)").run(sourceId)
      this.db.query("DELETE FROM chunks WHERE source_id = ?").run(sourceId)
      const insert = this.db.query("INSERT INTO chunks (id, source_id, course_id, ordinal, locator, text, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)")
      const insertUnicode = this.hasUnicodeFts ? this.db.query("INSERT INTO chunks_fts_unicode (chunk_id, course_id, text) VALUES (?, ?, ?)") : undefined
      const insertTrigram = this.ftsMode === "trigram" ? this.db.query("INSERT INTO chunks_fts_trigram (chunk_id, course_id, text) VALUES (?, ?, ?)") : undefined
      for (const chunk of chunks) {
        const id = crypto.randomUUID()
        insert.run(id, sourceId, courseId, chunk.ordinal, chunk.locator, chunk.text, chunk.contentHash ?? hashText(chunk.text))
        insertUnicode?.run(id, courseId, chunk.text)
        insertTrigram?.run(id, courseId, chunk.text)
      }
    })
    replace()
  }

  searchChunks(courseId: string, query: string, limit = 6): SearchResult[] {
    const normalized = query.trim()
    if (!normalized) return []
    const isCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(normalized)
    const searchMode = isCjk ? (this.ftsMode === "trigram" ? "trigram" : undefined) : this.hasUnicodeFts ? "unicode61" : undefined
    if (searchMode && !(searchMode === "trigram" && [...normalized].length < 3)) {
      const match = ftsQuery(normalized, searchMode)
      const table = searchMode === "trigram" ? "chunks_fts_trigram" : "chunks_fts_unicode"
      try {
        return this.db
          .query<SearchResult, [string, string, number]>(`
            SELECT c.id, c.source_id AS sourceId, c.course_id AS courseId, c.ordinal, c.locator, c.text,
              c.content_hash AS contentHash,
              s.title AS sourceTitle
            FROM ${table} f JOIN chunks c ON c.id = f.chunk_id JOIN sources s ON s.id = c.source_id
            WHERE f.course_id = ? AND ${table} MATCH ? ORDER BY rank LIMIT ?
          `)
          .all(courseId, match, limit)
      } catch {}
    }

    return this.db
      .query<SearchResult, [string, string, number]>(`
        SELECT c.id, c.source_id AS sourceId, c.course_id AS courseId, c.ordinal, c.locator, c.text,
          c.content_hash AS contentHash,
          s.title AS sourceTitle
        FROM chunks c JOIN sources s ON s.id = c.source_id
        WHERE c.course_id = ? AND lower(c.text) LIKE lower(?) ORDER BY c.ordinal LIMIT ?
      `)
      .all(courseId, `%${normalized}%`, limit)
  }

  saveTopicProgress(courseId: string, title: string, progress: TopicProgress): void {
    this.db
      .query(`
        INSERT INTO topics (id, course_id, title, topic_key, review_step, attempt_count, next_review_at, last_seen_at, misconception, hint_level, last_result)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET review_step = excluded.review_step, attempt_count = excluded.attempt_count,
          next_review_at = excluded.next_review_at, last_seen_at = excluded.last_seen_at,
          misconception = excluded.misconception, hint_level = excluded.hint_level, last_result = excluded.last_result
      `)
      .run(
        progress.topicId,
        courseId,
        title,
        topicKey(title),
        progress.stage,
        progress.attemptCount,
        progress.dueAt ?? null,
        new Date().toISOString(),
        progress.misconception ?? null,
        progress.hintLevel,
        progress.lastResult ?? null,
      )
  }

  replacePlan(
    courseId: string,
    topics: Array<{ title: string; description: string; prerequisites: string[] }>,
  ): void {
    const replace = this.db.transaction(() => {
      const currentVersion = this.getCourse(courseId)?.planVersion ?? 0
      const planVersion = currentVersion + 1
      this.db.query("UPDATE courses SET plan_version = ?, updated_at = ? WHERE id = ?").run(planVersion, new Date().toISOString(), courseId)
      this.db.query("DELETE FROM topic_dependencies WHERE topic_id IN (SELECT id FROM topics WHERE course_id = ?)").run(courseId)
      this.db.query("UPDATE topics SET archived = 1 WHERE course_id = ?").run(courseId)

      const ids = new Map<string, string>()
      const findTopic = this.db.query<{ id: string }, [string, string]>("SELECT id FROM topics WHERE course_id = ? AND topic_key = ? LIMIT 1")
      const insertTopic = this.db.query("INSERT INTO topics (id, course_id, title, description, topic_key) VALUES (?, ?, ?, ?, ?)")
      const updateTopic = this.db.query("UPDATE topics SET title = ?, description = ?, version = version + 1, archived = 0 WHERE id = ?")
      const insertPlan = this.db.query("INSERT INTO plan_items (id, course_id, topic_id, ordinal, plan_version) VALUES (?, ?, ?, ?, ?)")
      topics.forEach((topic, ordinal) => {
        const key = topicKey(topic.title)
        const existing = findTopic.get(courseId, key)
        const id = existing?.id ?? crypto.randomUUID()
        if (existing) updateTopic.run(topic.title, topic.description, id)
        else insertTopic.run(id, courseId, topic.title, topic.description, key)
        ids.set(topic.title, id)
        insertPlan.run(crypto.randomUUID(), courseId, id, ordinal, planVersion)
      })

      const insertDependency = this.db.query("INSERT OR IGNORE INTO topic_dependencies (topic_id, prerequisite_id) VALUES (?, ?)")
      for (const topic of topics) {
        const topicId = ids.get(topic.title)!
        for (const prerequisite of topic.prerequisites) {
          const prerequisiteId = ids.get(prerequisite)
          if (prerequisiteId) insertDependency.run(topicId, prerequisiteId)
        }
      }
    })
    replace()
  }

  listPlan(courseId: string): PlanTopic[] {
    return this.db
      .query<{
        id: string
        title: string
        description: string
        status: PlanTopic["status"]
        stage: number
        attempt_count: number
        due_at: string | null
        last_result: PlanTopic["lastResult"] | null
        has_prerequisites: number
      }, [string]>(`
        SELECT t.id, t.title, t.description, p.status, t.review_step AS stage, t.attempt_count,
          t.next_review_at AS due_at, t.last_result,
          EXISTS(SELECT 1 FROM topic_dependencies d WHERE d.topic_id = t.id) AS has_prerequisites
        FROM plan_items p JOIN topics t ON t.id = p.topic_id JOIN courses c ON c.id = p.course_id
        WHERE p.course_id = ? AND p.plan_version = c.plan_version ORDER BY p.ordinal
      `)
      .all(courseId)
      .map((row) => ({
        id: row.id,
        title: row.title,
        description: row.description,
        status: row.status,
        stage: row.stage,
        attemptCount: row.attempt_count,
        dueAt: row.due_at ?? undefined,
        lastResult: row.last_result ?? undefined,
        hasPrerequisites: row.has_prerequisites === 1,
      }))
  }

  nextTopic(courseId: string, mode: "first" | "review", now = new Date()): PlanTopic | undefined {
    const topics = this.listPlan(courseId)
    if (mode === "first") return topics.find((topic) => topic.status !== "done")
    return (
      topics.find((topic) => topic.attemptCount > 0 && topic.dueAt && topic.dueAt <= now.toISOString()) ??
      topics.filter((topic) => topic.attemptCount > 0).sort((a, b) => a.stage - b.stage)[0]
    )
  }

  markPlanItem(topicId: string, status: PlanTopic["status"]): void {
    this.db
      .query("UPDATE plan_items SET status = ? WHERE topic_id = ? AND plan_version = (SELECT max(plan_version) FROM plan_items WHERE topic_id = ?)")
      .run(status, topicId, topicId)
  }

  saveRubric(rubric: AssessmentRubric): void {
    this.db
      .query(`
        INSERT OR REPLACE INTO rubrics
          (id, topic_id, question, question_type, expected_answer_summary, criteria_json, schema_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        rubric.id,
        rubric.topicId,
        rubric.question,
        rubric.questionType,
        rubric.expectedAnswerSummary,
        JSON.stringify(rubric.criteria),
        rubric.schemaVersion,
        new Date().toISOString(),
      )
  }

  getRubric(id: string): AssessmentRubric | undefined {
    const row = this.db
      .query<{
        id: string
        topic_id: string
        question: string
        question_type: AssessmentRubric["questionType"]
        expected_answer_summary: string
        criteria_json: string
        schema_version: number
      }, [string]>("SELECT * FROM rubrics WHERE id = ?")
      .get(id)
    return row
      ? {
          id: row.id,
          topicId: row.topic_id,
          question: row.question,
          questionType: row.question_type,
          expectedAnswerSummary: row.expected_answer_summary,
          criteria: JSON.parse(row.criteria_json),
          schemaVersion: row.schema_version,
        }
      : undefined
  }

  recordDiagnosis(input: {
    courseId: string
    sessionId: string
    topicTitle: string
    answer: string
    diagnosis: ValidatedDiagnosis
    progress: TopicProgress
    provider?: string
    model?: string
    completePlanItem: boolean
  }): void {
    this.db.transaction(() => {
      this.saveMessage(input.sessionId, "user", input.answer, [], true)
      this.saveTopicProgress(input.courseId, input.topicTitle, input.progress)
      this.insertAttempt(input.sessionId, input.answer, input.diagnosis, true, undefined, input.provider, input.model)
      if (input.completePlanItem) this.markPlanItem(input.diagnosis.topicId, "done")
      this.recordEvent(input.courseId, input.sessionId, "diagnosis_validated", input.diagnosis.stateChange)
    })()
  }

  recordRejectedDiagnosis(input: {
    courseId: string
    sessionId: string
    answer: string
    diagnosis: DiagnosisCandidate
    reason: string
    provider?: string
    model?: string
  }): void {
    this.db.transaction(() => {
      this.saveMessage(input.sessionId, "user", input.answer)
      this.insertAttempt(input.sessionId, input.answer, input.diagnosis, false, input.reason, input.provider, input.model)
      this.recordEvent(input.courseId, input.sessionId, "attempt_submitted", { validated: false, reason: input.reason })
    })()
  }

  recordNoobExposure(courseId: string, sessionId: string, content: string, topicId?: string): void {
    this.db.transaction(() => {
      this.db
        .query("INSERT INTO noob_exposures (id, session_id, topic_id, content, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(crypto.randomUUID(), sessionId, topicId ?? null, content, new Date().toISOString())
      this.recordEvent(courseId, sessionId, "attempt_submitted", { reason: "noob_exposure", topicId })
    })()
  }

  recordEvent(courseId: string, sessionId: string | undefined, type: string, payload: object = {}): void {
    this.db
      .query("INSERT INTO learning_events (id, course_id, session_id, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(crypto.randomUUID(), courseId, sessionId ?? null, type, JSON.stringify(payload), new Date().toISOString())
  }

  private insertAttempt(
    sessionId: string,
    answer: string,
    diagnosis: DiagnosisCandidate | ValidatedDiagnosis,
    validated: boolean,
    rejectionReason?: string,
    provider?: string,
    model?: string,
  ): void {
    const stateChange = "stateChange" in diagnosis ? diagnosis.stateChange : undefined
    this.db
      .query(`
        INSERT INTO attempts
          (id, session_id, topic_id, answer, correctness, hint_level, diagnosis_json, rubric_id, confidence,
           diagnosis_schema_version, provider, model, prompt_version, validated, rejection_reason,
           from_stage, to_stage, state_change_reason, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?, 'diagnosis-v2', ?, ?, ?, ?, ?, ?)
      `)
      .run(
        crypto.randomUUID(),
        sessionId,
        diagnosis.topicId,
        answer,
        diagnosis.correctness,
        diagnosis.hintLevel,
        JSON.stringify(diagnosis),
        diagnosis.rubricId,
        diagnosis.confidence,
        provider ?? null,
        model ?? null,
        validated ? 1 : 0,
        rejectionReason ?? null,
        stateChange?.fromStage ?? null,
        stateChange?.toStage ?? null,
        stateChange?.reason ?? null,
        new Date().toISOString(),
      )
  }

  listTopicProgress(courseId: string): TopicProgress[] {
    return this.db
      .query<{
        id: string
        review_step: number
        attempt_count: number
        next_review_at: string | null
        last_result: TopicProgress["lastResult"] | null
        misconception: string | null
        hint_level: 0 | 1 | 2
      }, [string]>("SELECT * FROM topics WHERE course_id = ? ORDER BY next_review_at")
      .all(courseId)
      .map((row) => ({
        topicId: row.id,
        stage: row.review_step,
        attemptCount: row.attempt_count,
        mastery: masteryFor(row.review_step, row.attempt_count),
        dueAt: row.next_review_at ?? undefined,
        lastResult: row.last_result ?? undefined,
        misconception: row.misconception ?? undefined,
        hintLevel: row.hint_level,
      }))
  }

  private mapCourse(row: CourseRow): CourseRecord {
    return {
      id: row.id,
      name: row.name,
      mode: row.mode,
      clarificationCount: row.clarification_count,
      planVersion: row.plan_version,
      brief: {
        objective: row.objective ?? undefined,
        level: row.current_level ?? undefined,
        deadline: row.deadline ?? undefined,
        sourceScope: row.source_scope ?? undefined,
        examScope: row.exam_scope ?? undefined,
      },
    }
  }
}

function topicKey(title: string): string {
  return title.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " ")
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}

function ftsQuery(query: string, mode: "trigram" | "unicode61"): string {
  const escaped = (value: string) => `"${value.replaceAll('"', '""')}"`
  if (mode === "unicode61") {
    const terms = query.match(/[\p{L}\p{N}]{2,}/gu) ?? [query]
    return [...new Set(terms)].slice(0, 12).map(escaped).join(" OR ")
  }
  const terms: string[] = []
  for (const token of query.match(/[a-z\d]{3,}|[\p{Script=Han}]{3,}/giu) ?? []) {
    const characters = [...token]
    if (/^[\p{Script=Han}]+$/u.test(token)) {
      for (let index = 0; index <= characters.length - 3; index++) terms.push(characters.slice(index, index + 3).join(""))
    } else terms.push(token)
  }
  return (terms.length ? [...new Set(terms)].slice(0, 12) : [query]).map(escaped).join(" OR ")
}
