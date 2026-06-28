import { OfficeParser, type OfficeChunk } from "officeparser"
import { createHash } from "node:crypto"
import { readdirSync, statSync } from "node:fs"
import { basename, extname, join, resolve } from "node:path"
import type { SourceMetadata } from "../core/types"

export const CHUNK_SIZE = 1500
export const CHUNK_OVERLAP = 150
const MAX_SOURCE_BYTES = 100 * 1024 * 1024
const SUPPORTED_EXTENSIONS = new Set([".md", ".txt", ".pdf", ".docx", ".pptx"])

export interface ParsedChunk {
  ordinal: number
  locator: string
  text: string
}

export interface ParsedSource {
  kind: "text" | "pdf" | "docx" | "pptx" | "web"
  uri: string
  title: string
  contentHash: string
  metadata: SourceMetadata
  chunks: ParsedChunk[]
  warnings: string[]
}

export function expandSourceInputs(inputs: string[]): string[] {
  const expanded: string[] = []
  for (const input of inputs) {
    if (/^https?:\/\//i.test(input)) {
      expanded.push(input)
      continue
    }
    const path = resolve(input)
    if (!statSafe(path)) throw new Error(`资料不存在：${input}`)
    if (statSync(path).isDirectory()) {
      walk(path, expanded)
    } else if (SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase())) expanded.push(path)
    else throw new Error(`不支持的资料格式：${extname(path) || "无扩展名"}`)
  }
  return expanded
}

export async function parseSource(input: string, signal?: AbortSignal): Promise<ParsedSource> {
  return /^https?:\/\//i.test(input) ? parseWebSource(input, signal) : parseFileSource(resolve(input))
}

export function chunkText(text: string, locatorPrefix = "文本"): ParsedChunk[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
  if (!normalized) return []
  const characters = [...normalized]
  const chunks: ParsedChunk[] = []
  let start = 0
  while (start < characters.length) {
    let end = Math.min(start + CHUNK_SIZE, characters.length)
    if (end < characters.length) {
      const window = characters.slice(start, end).join("")
      const boundary = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("。"), window.lastIndexOf(". "))
      if (boundary > CHUNK_SIZE / 2) end = start + boundary + 1
    }
    chunks.push({
      ordinal: chunks.length,
      locator: `${locatorPrefix} ${start + 1}-${end}`,
      text: characters.slice(start, end).join("").trim(),
    })
    if (end === characters.length) break
    start = Math.max(end - CHUNK_OVERLAP, start + 1)
  }
  return chunks.filter((chunk) => chunk.text.length > 0)
}

async function parseFileSource(path: string): Promise<ParsedSource> {
  const file = Bun.file(path)
  if (file.size > MAX_SOURCE_BYTES) throw new Error(`资料超过 100 MB：${basename(path)}`)
  const bytes = new Uint8Array(await file.arrayBuffer())
  const extension = extname(path).toLowerCase()
  const contentHash = sha256(bytes)

  if (extension === ".md" || extension === ".txt") {
    const text = new TextDecoder().decode(bytes)
    return {
      kind: "text",
      uri: path,
      title: basename(path),
      contentHash,
      metadata: { trust: "unknown" },
      chunks: chunkText(text),
      warnings: [],
    }
  }

  const ast = await OfficeParser.parseOffice(path, {
    ocr: false,
    extractAttachments: false,
    ignoreSlideMasters: true,
  })
  const result = await ast.to("chunks", {
    chunksConfig: {
      strategy: "document-structure",
      splitBy: extension === ".pptx" ? "slide" : extension === ".pdf" ? "page" : "heading",
      maxChunkSize: CHUNK_SIZE,
      tableSplitStrategy: "row",
    },
  })
  const officeChunks = result.value as OfficeChunk[]
  if (officeChunks.length === 0) {
    throw new Error(`没有提取到文字；扫描 PDF 暂不支持 OCR：${basename(path)}`)
  }

  return {
    kind: extension.slice(1) as ParsedSource["kind"],
    uri: path,
    title: String(ast.metadata.title || basename(path)),
    contentHash,
    metadata: { trust: "unknown" },
    chunks: officeChunks.map((chunk, ordinal) => ({
      ordinal,
      locator: officeLocator(chunk, ordinal),
      text: chunk.text.trim(),
    })),
    warnings: [...ast.warnings, ...result.messages].map((warning) => warning.message),
  }
}

async function parseWebSource(url: string, signal?: AbortSignal): Promise<ParsedSource> {
  const response = await fetch(url, {
    signal: signal ?? AbortSignal.timeout(20_000),
    headers: { "user-agent": "OpenStu/0.1 (+https://github.com/openstu/openstu)" },
  })
  if (!response.ok) throw new Error(`网页下载失败：HTTP ${response.status}`)
  const declaredSize = Number(response.headers.get("content-length") || 0)
  if (declaredSize > MAX_SOURCE_BYTES) throw new Error("网页内容超过 100 MB")
  const html = await response.text()
  if (new TextEncoder().encode(html).byteLength > MAX_SOURCE_BYTES) throw new Error("网页内容超过 100 MB")

  const extracted = await extractHtml(html)
  const text = extracted.text
  const chunks = chunkText(text, "网页段落")
  if (chunks.length === 0) throw new Error("网页没有可读取的正文")

  return {
    kind: "web",
    uri: url,
    title: extracted.title || new URL(url).hostname,
    contentHash: sha256(new TextEncoder().encode(text)),
    metadata: inferWebMetadata(url),
    chunks,
    warnings: [],
  }
}

function inferWebMetadata(url: string): SourceMetadata {
  const host = new URL(url).hostname.toLowerCase()
  if (/(^|\.)gov(\.|$)/.test(host)) return { trust: "official" }
  if (/(^|\.)(edu|ac)(\.|$)/.test(host) || /\.(edu|ac\.[a-z]{2})$/.test(host)) {
    return { trust: "institution", institution: host }
  }
  return { trust: "unknown" }
}

async function extractHtml(html: string): Promise<{ title: string; text: string }> {
  let title = ""
  const text: string[] = []
  const rewriter = new HTMLRewriter()
    .on("script, style, noscript, svg", {
      element(element) {
        element.remove()
      },
    })
    .on("title", {
      text(chunk) {
        title += chunk.text
      },
    })
    .on("body", {
      text(chunk) {
        const value = chunk.text.replace(/\s+/g, " ").trim()
        if (value) text.push(value)
      },
    })
  await rewriter.transform(new Response(html)).text()
  return { title: title.trim(), text: text.join("\n") }
}

function officeLocator(chunk: OfficeChunk, ordinal: number): string {
  if (chunk.metadata.pageNumber) return `第 ${chunk.metadata.pageNumber} 页`
  if (chunk.metadata.slideNumber) return `第 ${chunk.metadata.slideNumber} 张幻灯片`
  if (chunk.metadata.closestHeading) return chunk.metadata.closestHeading
  if (chunk.startIndex !== undefined && chunk.endIndex !== undefined) {
    return `字符 ${chunk.startIndex + 1}-${chunk.endIndex}`
  }
  return `片段 ${ordinal + 1}`
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex")
}

function walk(directory: string, output: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) walk(path, output)
    else if (SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) output.push(path)
  }
}

function statSafe(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}
