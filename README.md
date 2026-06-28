# OpenStu

Local-first AI learning CLI for course planning, first-pass learning, spaced review, exam cramming, and source-grounded questions.

## Run

Requires [Bun](https://bun.sh/) for development:

```powershell
bun install
bun run dev -- --course "CIE A-Level Physics" .\materials
```

Or build a standalone executable:

```powershell
bun run build
.\dist\openstu.exe --course "CIE A-Level Physics"
```

Install the standalone executable for direct use from a new terminal:

```powershell
bun run install:local
openstu
```

`openstu` reopens the most recent course. Files, directories, and public URLs can be passed as positional arguments.

## Models

When no configured provider is available, OpenStu opens normally and asks you to enter `/model`. The in-app setup accepts a temporary API key that is masked and never written to disk. Environment variables remain the persistent option:

```powershell
$env:OPENSTU_PROVIDER="openai-compatible"
$env:OPENSTU_MODEL="deepseek-chat"
$env:OPENAI_BASE_URL="https://api.deepseek.com/v1"
$env:OPENAI_API_KEY="..."
```

Supported providers and keys:

- `openai-compatible`: `OPENAI_API_KEY`, optional `OPENAI_BASE_URL`
- `anthropic`: `ANTHROPIC_API_KEY`
- `google`: `GOOGLE_GENERATIVE_AI_API_KEY` or `GOOGLE_API_KEY`
- `ollama`: optional `OLLAMA_BASE_URL`, default `http://localhost:11434/v1`

Model settings may also be stored without credentials in `config.json`:

```json
{
  "model": {
    "provider": "ollama",
    "model": "qwen3:8b",
    "baseURL": "http://localhost:11434/v1"
  }
}
```

The file is located under `%APPDATA%\openstu` on Windows, `~/Library/Application Support/openstu` on macOS, and `$XDG_CONFIG_HOME/openstu` or `~/.config/openstu` on Linux. Set `OPENSTU_CONFIG` to override the path.

## Modes

The mode bar stays directly above the composer. Use `Tab` and `Shift+Tab` to cycle:

- `Plan`: clarify the goal and draft a route; enter `确认计划` to persist it.
- `First`: teach the next planned topic and diagnose the answer.
- `Review`: select due or weak topics using 1/3/7/14/30-day intervals.
- `Noob`: short-term, simplified exam coverage without claiming mastery.
- `Ask`: source-grounded free questions; conceptual questions default to Socratic guidance.

Only the current mode is shown above the three-line composer. Press Enter to send and Shift+Enter for a new line. Switch the built-in color theme with `/style theme=cyan`, `/style theme=violet`, or `/style theme=amber`. Terminal fonts are controlled by the terminal; Cascadia Mono is recommended on Windows.

## Commands

```text
/course                    list courses
/course new <name>         create and switch course
/add <path|directory|URL>  import material
/add search <course>       search official-source candidates with Tavily
/mode <mode>               switch mode
/sources                   list imported sources
/progress                  show plan and review stages
/style [key=value]         inspect or update presentation preferences
/model                     show or connect a model
/help                      show help
/quit                      exit
```

Set `TAVILY_API_KEY` for official-source search. Search results are never imported automatically; review a candidate and confirm it with `/add <URL>`.

## Data and privacy

Course data, extracted text, messages, plans, and progress remain in a local SQLite database. API keys are read only from environment variables. There is no account, cloud sync, or telemetry.

Supported material types are Markdown, TXT, PDF, DOCX, PPTX, and public static web pages. Scanned PDFs, OCR, audio/video, and login-protected pages are intentionally out of scope.

## Development

```powershell
bun run typecheck
bun test
bun run build
```

License: MIT.
