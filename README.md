# OpenStu

Local-first AI learning TUI. Ask questions, get answers grounded in your own study materials.

**Alpha v0.1.0** — core Q&A loop with source citations. Planning, formal assessment, and spaced review are not yet stabilized.

## Quick Start

Requires [Bun](https://bun.sh/) >= 1.3:

```powershell
git clone https://github.com/Samwang-afk/OpenStu.git
cd OpenStu
bun install
bun run dev
```

Build a standalone executable:

```powershell
bun run build
.\dist\openstu.exe
```

Or install globally:

```powershell
bun run install:local
openstu
```

## Alpha Scope

OpenStu Alpha lets you:

1. Create a subject (Ctrl+X → Create subject)
2. Add study materials — Markdown, TXT, PDF, DOCX, PPTX, web pages
3. Configure an AI provider (Ctrl+X → Configure provider)
4. Ask questions and receive answers grounded in your materials
5. See source citations when materials are relevant

## Basic Workflow

```powershell
# Launch
bun run dev

# 1. Create a subject
#    Ctrl+X → Create subject → type "Physics" → Enter

# 2. Add materials
#    Ctrl+X → Add materials → type "./notes.pdf" → Enter

# 3. Configure provider
#    Ctrl+X → Configure provider → select provider → follow prompts

# 4. Ask a question
#    Type "Explain Newton's laws" → Enter

# Answers include source citations when materials are relevant:
#   Sources:
#   [1] Physics notes · 第 3 页
```

### No course? Start with a question.

You can ask questions without a subject selected. The assistant answers directly without material context.

## Provider Setup

### Via TUI (Ctrl+X → Configure provider)

Supported providers: OpenAI-compatible (OpenAI, DeepSeek, etc.), Anthropic, Google Gemini, Ollama.

The in-app setup walks through: provider → model name → base URL (if needed) → API key.

- **API key entered in TUI**: masked during entry (not echoed), used for the current session, not persisted to disk.
- **Persistent API keys**: set via environment variables (see below).

Press Esc at any step to cancel setup.

### Via environment variables

```powershell
$env:OPENSTU_PROVIDER = "openai-compatible"
$env:OPENSTU_MODEL = "deepseek-chat"
$env:OPENAI_BASE_URL = "https://api.deepseek.com/v1"
$env:OPENAI_API_KEY = "your-key"
```

Supported providers and their env vars:

| Provider | Key env var | Optional base URL |
|----------|------------|-------------------|
| `openai-compatible` | `OPENAI_API_KEY` | `OPENAI_BASE_URL` |
| `anthropic` | `ANTHROPIC_API_KEY` | — |
| `google` | `GOOGLE_GENERATIVE_AI_API_KEY` | — |
| `ollama` | — | `OLLAMA_BASE_URL` (default: `http://localhost:11434/v1`) |

### Via config.json

Provider, model, and base URL can be saved without credentials in `config.json`:

```json
{
  "model": {
    "provider": "ollama",
    "model": "qwen3:8b",
    "baseURL": "http://localhost:11434/v1"
  }
}
```

Location: `%APPDATA%\openstu` (Windows), `~/Library/Application Support/openstu` (macOS), `~/.config/openstu` (Linux). Set `OPENSTU_CONFIG` to override.

## Main Controls

| Key | Action |
|-----|--------|
| Ctrl+X | Open Action Palette (create subject, add materials, configure provider, etc.) |
| Enter | Send message or select highlighted option |
| Shift+Enter | New line |
| Ctrl+C | Cancel current generation |
| Esc | Close palette, option box, or cancel onboarding flow |

Slash commands (`/help`, `/course`, `/add`, `/model`, `/style`, `/progress`, `/sources`, `/quit`) are available but Ctrl+X is the recommended primary interface.

## Alpha Safety Note

- **Ordinary Ask does not update mastery, stage, or learning progress.** All Q&A is read-only with respect to learning state.
- Formal assessment and diagnosis features exist in the codebase but are **not part of the Alpha experience.** They are hidden behind the old mode system and are not validated for production use.
- All data stays in a local SQLite database. No accounts, no cloud sync, no telemetry.

## Supported Material Types

Markdown, TXT, PDF, DOCX, PPTX, and public static web pages. Scanned PDFs, OCR, audio/video, and login-protected pages are out of scope.

## Known Limitations (Alpha)

- **No persistent API key storage.** Keys entered in the TUI are session-only. Use environment variables for persistence.
- **No planning UI.** Internal planning logic exists but is not exposed through the new Action Palette UX. Use `/mode plan` or the old mode system if needed.
- **No formal assessment or diagnosis in Alpha UX.** Assessment and review flows are accessible via `/mode first` and `/mode review` but are not part of the default interface.
- **No sidebars.** All context (progress, sources, weak points) is accessed through commands or the Action Palette.
- **No spaced repetition scheduling in the Alpha UX.**
- **CJK source retrieval falls back to substring search** when FTS5 trigram/unicode61 tokenizers are unavailable.
- **Windows-only build tested.** macOS and Linux untested in this Alpha.

## Development

```powershell
bun install
bun run typecheck
bun test
bun run build
```

License: MIT.
