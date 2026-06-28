import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CHUNK_OVERLAP, CHUNK_SIZE, chunkText, parseSource } from "../src/adapters/sources"

let temporaryDirectory: string | undefined

afterEach(() => {
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true })
  temporaryDirectory = undefined
})

describe("source ingestion", () => {
  test("chunks text with bounded overlap", () => {
    const chunks = chunkText("物理。".repeat(800))
    expect(chunks.length).toBeGreaterThan(1)
    expect([...chunks[0].text].length).toBeLessThanOrEqual(CHUNK_SIZE)
    expect([...chunks[0].text].slice(-CHUNK_OVERLAP).join("")).toBe(
      [...chunks[1].text].slice(0, CHUNK_OVERLAP).join(""),
    )
  })

  test("parses a local UTF-8 text file", async () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "openstu-"))
    const path = join(temporaryDirectory, "notes.txt")
    await Bun.write(path, "第一章 电磁感应\n磁通量变化会产生感应电动势。")
    const source = await parseSource(path)
    expect(source.kind).toBe("text")
    expect(source.chunks[0].text).toContain("磁通量")
    expect(source.contentHash).toHaveLength(64)
  })

  test("extracts readable text from a static web page", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response("<html><head><title>Physics</title></head><body><article><h1>Forces</h1><p>Force equals mass times acceleration.</p></article></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      })) as unknown as typeof fetch
    try {
      const source = await parseSource("https://example.test/physics")
      expect(source.kind).toBe("web")
      expect(source.title).toContain("Physics")
      expect(source.chunks[0].text).toContain("acceleration")
      expect(source.metadata.trust).toBe("unknown")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
