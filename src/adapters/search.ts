export interface WebSearchCandidate {
  title: string
  url: string
  content: string
  publishedDate?: string
  sourceTrust: "official" | "institution" | "third_party" | "unknown"
  courseVersion?: string
  institution?: string
  term?: string
}

export async function searchOfficialSources(
  query: string,
  apiKey = process.env.TAVILY_API_KEY,
  signal?: AbortSignal,
): Promise<WebSearchCandidate[]> {
  if (!apiKey) throw new Error("未配置 TAVILY_API_KEY；请改用 /add <URL> 手动导入")
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    signal: signal ?? AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: `${query} official syllabus`,
      search_depth: "basic",
      max_results: 8,
      include_answer: false,
      include_raw_content: false,
    }),
  })
  if (!response.ok) throw new Error(`Tavily 搜索失败：HTTP ${response.status}`)
  const body = (await response.json()) as { results?: WebSearchCandidate[] }
  return (body.results ?? [])
    .filter((result) => /^https?:\/\//i.test(result.url))
    .map((result) => ({ ...result, ...candidateMetadata(result.url) }))
}

function candidateMetadata(url: string): Pick<WebSearchCandidate, "sourceTrust" | "institution"> {
  const host = new URL(url).hostname.toLowerCase()
  if (/(^|\.)gov(\.|$)/.test(host)) return { sourceTrust: "official", institution: host }
  if (/(^|\.)(edu|ac)(\.|$)/.test(host) || /\.(edu|ac\.[a-z]{2})$/.test(host)) {
    return { sourceTrust: "institution", institution: host }
  }
  return { sourceTrust: "unknown", institution: undefined }
}
