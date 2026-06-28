import type { OpenStuDatabase } from "../adapters/database"
import { expandSourceInputs, parseSource } from "../adapters/sources"

export interface ImportResult {
  input: string
  status: "imported" | "failed"
  title?: string
  chunks?: number
  warnings?: string[]
  error?: string
}

export class SourceService {
  constructor(private readonly database: OpenStuDatabase) {}

  async import(
    courseId: string,
    inputs: string[],
    onProgress: (message: string) => void = () => {},
    signal?: AbortSignal,
  ): Promise<ImportResult[]> {
    const results: ImportResult[] = []
    const expanded: string[] = []
    for (const input of inputs) {
      try {
        expanded.push(...expandSourceInputs([input]))
      } catch (error) {
        results.push({ input, status: "failed", error: error instanceof Error ? error.message : String(error) })
      }
    }
    for (const input of expanded) {
      try {
        onProgress(`正在导入 ${input}`)
        const parsed = await parseSource(input, signal)
        const sourceId = this.database.addSource(courseId, parsed)
        this.database.replaceChunks(sourceId, courseId, parsed.chunks)
        this.database.recordEvent(courseId, undefined, "source_imported", { sourceId, trust: parsed.metadata.trust })
        results.push({
          input,
          status: "imported",
          title: parsed.title,
          chunks: parsed.chunks.length,
          warnings: parsed.warnings,
        })
      } catch (error) {
        results.push({ input, status: "failed", error: error instanceof Error ? error.message : String(error) })
      }
    }
    return results
  }
}
