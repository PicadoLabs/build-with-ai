# build-with-ai

<div align="center">

<pre>
  ____  _   _ ___ _     ____      __        _____ _____ _   _          _    ___ 
 | __ )| | | |_ _| |   |  _ \     \ \      / /_ _|_   _| | | |        / \  |_ _|
 |  _ \| | | || || |   | | | |     \ \ /\ / / | |  | | | |_| |       / _ \  | | 
 | |_) | |_| || || |___| |_| |      \ V  V /  | |  | | |  _  |      / ___ \ | | 
 |____/ \___/|___|_____|____/        \_/\_/  |___| |_| |_| |_|     /_/   \_\___|
</pre>

**Deterministic, context-aware prompt engine for building complete software projects with any AI.**

[![npm version](https://img.shields.io/npm/v/build-with-ai.svg?style=flat-square&color=3b82f6)](https://www.npmjs.com/package/build-with-ai)
[![npm downloads](https://img.shields.io/npm/dt/build-with-ai.svg?style=flat-square&color=10b981&label=downloads)](https://www.npmjs.com/package/build-with-ai)
[![CI](https://img.shields.io/github/actions/workflow/status/PicadoLabs/build-with-ai/ci.yml?branch=main&style=flat-square&label=ci)](https://github.com/PicadoLabs/build-with-ai/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg?style=flat-square)](LICENSE)
[![Node >= 18](https://img.shields.io/badge/node-%3E%3D18.0.0-f59e0b.svg?style=flat-square)](https://nodejs.org)
[![Zero API Keys](<https://img.shields.io/badge/AI_API-None_(100%25_local)-8b5cf6.svg?style=flat-square>)](README.md)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=flat-square)](CONTRIBUTING.md)

```bash
npx build-with-ai
```

[Quickstart](#quickstart) &bull; [Workflow](#the-4-step-workflow) &bull; [Templates](#available-templates) &bull; [Non-Interactive Init](#non-interactive-initialization) &bull; [CLI Reference](#cli-reference) &bull; [Autonomous Mode](#byok-autonomous-mode) &bull; [MCP Server](#model-context-protocol-mcp) &bull; [Contributing](CONTRIBUTING.md)

</div>

---

## Why build-with-ai?

Prompting an AI model to "build an entire app" typically breaks down in three ways:

1. **The Blank Canvas Problem**: Monolithic prompts produce hallucinated schemas and unmaintainable code dumps.
2. **Context Drift**: In long conversations, AI forgets early database designs, auth models, and naming standards.
3. **Skipped Foundations**: Models jump to frontend polish before data models, contracts, and error handling exist.

`build-with-ai` solves this by breaking application development into structured, sequential engineering phases. It records decisions in a local `context.json` file and automatically injects them into downstream prompts (`{{decisions.key}}`).

### Key Principles

- **Zero API Keys & Zero Cost**: Runs 100% locally in your terminal. Works out of the box with web UIs (ChatGPT, Claude), IDEs (Cursor, Windsurf), or local LLMs (Ollama).
- **Universal Compatibility**: Generates tailored prompts for any AI model without vendor lock-in.
- **Non-Destructive**: State is maintained exclusively inside `.buildwithai/` and never alters your application code unexpectedly.
- **AI Editor Ready**: Ships with a native Model Context Protocol (MCP) server and automatic editor rules synchronization (`.cursorrules`, `CLAUDE.md`, etc.).

---

## Quickstart

Run directly without prior installation:

```bash
npx build-with-ai
```

Or install globally:

```bash
npm install -g build-with-ai
```

Initialize your workspace:

```bash
npx build-with-ai init
```

---

## The 4-Step Workflow

```mermaid
graph LR
    A["1. init"] --> B["2. next"]
    B --> C["3. AI Implementation"]
    C --> D["4. done"]
    D --> B
    D --> E["5. export"]
```

### 1. Initialize (`init`)

Select a technology template, your experience level, and a project summary:

```bash
npx build-with-ai init
```

For CI, Docker, devcontainers, and coding agents, pass the values as flags instead of answering
prompts:

```bash
npx build-with-ai init -y --template web-app --name "AutomatedApp"
```

See [Non-Interactive Initialization](#non-interactive-initialization) for defaults, exit codes, and
re-initialization.

### 2. Generate Prompt (`next`)

Formats the active phase requirements, identifies target files, and copies the context-injected prompt to your clipboard:

```bash
npx build-with-ai next
```

### 3. Record Decisions (`done`)

Paste the prompt into your AI tool, review the generated code, and record architectural decisions:

```bash
npx build-with-ai done
```

You can also parse decisions directly from the clipboard:

```bash
npx build-with-ai done --from-clipboard
```

### 4. Export & Sync Rules (`export`)

Export clean Markdown documentation and sync your project decisions across editor rule files:

```bash
npx build-with-ai export
npx build-with-ai export --rules
```

---

## Available Templates

`build-with-ai` ships with 11 production-ready workflow templates:

| Template ID        | Name                         | Steps | Core Stack                                                   |
| :----------------- | :--------------------------- | :---: | :----------------------------------------------------------- |
| `web-app`          | Full-Stack Web Application   |  23   | Next.js / React, Tailwind CSS, Prisma, PostgreSQL            |
| `saas-mvp`         | Modern SaaS MVP              |  15   | Next.js App Router, Supabase, Stripe, Resend                 |
| `rest-api`         | Backend REST API Service     |  10   | Node.js, Fastify / Express, PostgreSQL, Zod                  |
| `fastapi-backend`  | Python FastAPI Microservices |  12   | Python 3.11+, FastAPI, Pydantic v2, SQLAlchemy 2.0, Alembic  |
| `mobile-app`       | Cross-Platform Mobile App    |  15   | React Native, Expo Router, NativeWind, EAS Build             |
| `flutter-app`      | Flutter Mobile Application   |  16   | Flutter 3.x, Dart, Riverpod / BLoC, Clean Architecture       |
| `electron-app`     | Electron Desktop Application |  12   | Electron, Vite, React, IPC Handlers, electron-builder        |
| `chrome-extension` | Chrome Browser Extension     |  12   | Manifest V3, Vite, React, Shadow DOM                         |
| `ai-agent`         | AI Agent & RAG Pipeline      |  14   | LangChain / LlamaIndex, Vector DB, FastAPI / Express         |
| `ai-orchestration` | Multi-Agent Orchestration    |  14   | LangGraph / CrewAI, AutoGen, Vector DB, Telemetry            |
| `discord-bot`      | Discord Bot Workflow         |  12   | Node.js, discord.js v14, Slash Commands, SQLite / PostgreSQL |

### Custom, Remote, and Built-in Templates

Load team-specific or custom templates from a local file or HTTPS URL, or pick a built-in one by
ID:

```bash
# Built-in template by ID
npx build-with-ai init --template saas-mvp

# Local JSON template
npx build-with-ai init --template ./custom-template.json

# Remote HTTPS template
npx build-with-ai init --template https://raw.githubusercontent.com/org/repo/main/template.json

# Discover community templates
npx build-with-ai search saas
```

When a value could be read more than one way, URLs win over paths and paths win over IDs. Custom
templates are persisted to `.buildwithai/template.json` and work fully offline for all subsequent
commands.

---

## Non-Interactive Initialization

`init` can run with zero prompts. Supply the values as flags and the wizard is skipped entirely:
stdin is never read, so a closed or piped stream cannot block the command.

```bash
npx build-with-ai init -y --template web-app --name "AutomatedApp"
```

### Flags

| Flag                         | Description                                                                |
| :--------------------------- | :------------------------------------------------------------------------- |
| `-y, --yes`                  | Never prompt. Missing values fall back to the defaults below.              |
| `--template <id\|path\|url>` | Built-in template ID, local JSON path, or HTTP(S) URL.                     |
| `--name <string>`            | Project name.                                                              |
| `--level <level>`            | `Beginner`, `Intermediate`, or `Experienced` (case-insensitive).           |
| `--idea <string>`            | One-line project idea or problem description.                              |
| `-f, --force`                | Re-initialize an existing project. Required for a non-interactive re-init. |

### Defaults under `--yes`

| Value            | Default                                                      |
| :--------------- | :----------------------------------------------------------- |
| Template         | `web-app`                                                    |
| Project name     | Name of the current directory                                |
| Experience level | `Intermediate`                                               |
| Project idea     | `A minimal web application that solves a real user problem.` |

`--yes` fills **missing** values only. An explicitly empty value such as `--name ""` is rejected by
validation instead of being replaced by a default.

### Template resolution

`--template` accepts three kinds of value, resolved in this order:

1. An `http://` or `https://` URL is downloaded and persisted to `.buildwithai/template.json`.
2. A value that exists on disk, contains a path separator, starts with `.`, or ends in `.json` is
   loaded as a local template file.
3. Anything else is treated as a built-in template ID, such as `saas-mvp`.

### Re-initialization

A non-interactive run refuses to overwrite an existing workflow unless `--force` is passed:

```bash
npx build-with-ai init -y --force --template saas-mvp --name "My App"
```

Nothing is written until the template loads and every value validates, so a failed re-init leaves
the existing `.buildwithai/` state untouched.

### Exit codes

| Code | Meaning                                                                                      |
| :--: | :------------------------------------------------------------------------------------------- |
| `0`  | Project initialized.                                                                         |
| `1`  | Missing or invalid values, unknown template, failed template download, or a blocked re-init. |

An interactive terminal still gets the original wizard: supplied flags prefill the matching
prompts, and omitted values are asked. If stdin is not a terminal and only _some_ flags are passed,
the command fails with the list of missing flags instead of waiting for input.

### CI example

```yaml
- name: Initialize build-with-ai
  run: npx build-with-ai init -y --template web-app --name "${{ github.event.repository.name }}"
```

---

## CLI Reference

### Core Workflow

| Command                             | Description                                                                        |
| :---------------------------------- | :--------------------------------------------------------------------------------- |
| `npx build-with-ai`                 | Interactive launcher. Shows progress or initiates setup wizard.                    |
| `npx build-with-ai init`            | Initialize a project: interactive wizard, or flags plus `--yes` for headless runs. |
| `npx build-with-ai init -y --force` | Re-initialize non-interactively, replacing existing state.                         |
| `npx build-with-ai next`            | Generate and copy the current step prompt to the clipboard.                        |
| `npx build-with-ai next --run`      | BYOK autonomous mode: send prompt directly to AI provider.                         |
| `npx build-with-ai done`            | Record step decisions, archive step logs, and advance to next step.                |
| `npx build-with-ai undo`            | Roll back most recent step, restore context snapshot, and prune history.           |
| `npx build-with-ai back`            | Step back to previous step without removing recorded context.                      |
| `npx build-with-ai jump [step]`     | Navigate directly to a specific step number.                                       |

### Context & Configuration

| Command                                        | Description                                                                                |
| :--------------------------------------------- | :----------------------------------------------------------------------------------------- |
| `npx build-with-ai status`                     | Display progress bar, completed steps, and active decisions.                               |
| `npx build-with-ai context [key]`              | Inspect recorded decisions or retrieve a specific dot-notation path.                       |
| `npx build-with-ai set <key> <value>`          | Update a decision in `context.json` directly from the CLI.                                 |
| `npx build-with-ai validate`                   | Check project state, template dependencies, and required decisions without changing files. |
| `npx build-with-ai validate --template <path>` | Validate a local template file, even before project initialization.                        |
| `npx build-with-ai config`                     | Interactive key-picker to browse and edit decisions.                                       |
| `npx build-with-ai history [step]`             | Inspect archived AI responses and step logs.                                               |
| `npx build-with-ai resume`                     | Summary dashboard displaying active state and recommended next action.                     |
| `npx build-with-ai ui`                         | Open a local browser dashboard for progress, phases, decisions, history, and exports.      |
| `npx build-with-ai git-setup`                  | Register the git merge driver for `.buildwithai/context.json` in this repository.          |
| `npx build-with-ai merge-driver %O %A %B`      | Three-way merge for `context.json` (invoked by git; writes the merged result to `%A`).     |

### Documentation & Editor Rules

| Command                              | Description                                                                                          |
| :----------------------------------- | :--------------------------------------------------------------------------------------------------- |
| `npx build-with-ai export`           | Generate `README.md`, `BUILD_LOG.md`, `.buildwithai/CONTEXT.md`, `ARCHITECTURE.md`, and `AGENTS.md`. |
| `npx build-with-ai export --rules`   | Sync decisions to `.cursorrules`, `CLAUDE.md`, `.windsurfrules`, and Copilot.                        |
| `npx build-with-ai export --dry-run` | Preview the export paths without writing any files.                                                  |
| `npx build-with-ai export --force`   | Overwrite existing `README.md`, `ARCHITECTURE.md`, and `AGENTS.md`.                                  |
| `npx build-with-ai reset`            | Clean `.buildwithai/` state while preserving project source code.                                    |
| `npx build-with-ai mcp`              | Launch Model Context Protocol (MCP) stdio server.                                                    |

The architecture export summarizes the recorded stack, service boundaries, and data models.
The agent instructions export includes recorded testing commands, style rules, and restricted
paths. Missing decisions are identified instead of being filled with guessed settings.
Existing `AGENTS.md` and `ARCHITECTURE.md` files are preserved unless you use `--force`.

---

## Advanced Capabilities

### BYOK Autonomous Mode

Bring Your Own Key or use local Ollama to bypass copy-pasting. The CLI executes the step prompt, writes returned code files into your workspace, updates `context.json`, and advances the phase:

```bash
export OPENAI_API_KEY=sk-...
npx build-with-ai next --run

# Preview git-style diffs before files are written
npx build-with-ai next --run --review

# Use a local model with Ollama (no API key required)
npx build-with-ai next --run --provider ollama
```

Supported providers: `openai`, `anthropic`, `gemini`, `deepseek`, `groq`, `together`, `ollama`.

#### Token Budget Warnings

Before sending a step, `next --run` estimates the prompt size (about 4 characters per token, counting the step prompt and the system prompt) and compares it with the model's context window. At 75% of the window it logs an advisory warning, and past 100% it warns that the model may truncate or reject the prompt. The run is never blocked.

```bash
# See the estimate without running anything (tokenBudget field)
npx build-with-ai next --json

# Tell build-with-ai the real window when the built-in estimate is wrong
npx build-with-ai next --run --provider ollama --context-window 32768
```

Context windows come from a conservative built-in table of known models, with a default per provider. Ollama always assumes 8192 tokens, because its OpenAI-compatible endpoint is limited by the server's `num_ctx` setting rather than the model's full window. Override the window with `--context-window`, the `<PROVIDER>_CONTEXT_WINDOW` environment variable (for example `OLLAMA_CONTEXT_WINDOW=32768`), or the same key in `.buildwithai/.env`. Providers whose hosted models vary (`groq`, `together`, `jev`) report an unknown window and skip the warning unless the model is recognized or overridden.

### Git Merge Driver for context.json

When two branches both touch `.buildwithai/context.json`, a plain git merge leaves conflict markers inside the JSON, which breaks parsing and renders every CLI command unusable. Register the custom merge driver once per repository and git merges the file structurally instead:

```bash
npx build-with-ai git-setup
```

This sets `merge.buildwithai.driver` in `.git/config` and adds `.buildwithai/context.json merge=buildwithai` to `.gitattributes`. From then on, merging branches with independent additions to `context.json` completes without syntax errors: keys changed on one side only are taken from that side, identical changes are kept once, and conflicting keys resolve to the newer timestamped value when both sides carry one. Any remaining conflict keeps the current-branch value, is logged, and is recorded under `mergeConflicts` in the merged file — the file always stays valid JSON.

### Model Context Protocol (MCP)

Start a native stdio MCP server to let AI coding tools drive the workflow:

```bash
npx build-with-ai mcp
```

Add to your editor configuration (`.cursor/mcp.json` or `claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "build-with-ai": {
      "command": "npx",
      "args": ["build-with-ai", "mcp"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

Exposed tools: `get_workflow_status`, `get_active_prompt`, `complete_step`, and `get_context`. Steps completed via MCP automatically create safe rollback snapshots.

Exposed prompts: `build-with-ai` (the current step, available as `/build-with-ai` in editors that support MCP prompts) and `step-1` through `step-N` for every step in the template.

Exposed resources: `buildwithai://context`, the project's `context.json` (tech stack and recorded decisions), which editors can attach to the agent's context window.

#### Zero-Key Execution with MCP Sampling

If your editor supports MCP sampling, build-with-ai can generate a step with the editor's own model, so no API key is needed. When the client declares the `sampling` capability, the server also lists an `execute_step_sampled` tool that:

1. Sends the current step prompt to the editor through `sampling/createMessage`, with the step's recommended models as hints.
2. Applies the reply the same way as `next --run`: writes file blocks inside the project (unsafe paths, truncated blocks and files that fail the syntax check are skipped and reported), records the `decisions` block under `decisions.`, saves history, and advances the step.
3. Saves an undo snapshot first, so `npx build-with-ai undo` rolls the step back.

Pass `{ "dryRun": true }` to preview the proposed files and decisions without changing anything, or `maxTokens` to cap the reply length. Editors usually ask you to approve each sampling request; build-with-ai waits up to 5 minutes, configurable with `BUILD_WITH_AI_SAMPLING_TIMEOUT_MS`. Clients without sampling support do not see the tool and can keep using `get_active_prompt` and `complete_step`.

### Local Browser Dashboard

For larger templates, inspect the whole project in your browser instead of the terminal:

```bash
npx build-with-ai ui

# Use another port, or skip opening the browser automatically
npx build-with-ai ui --port 4000 --no-open
```

The dashboard is served by Node's built-in `http` module at `http://127.0.0.1:3721` and shows:

- A progress bar and a workflow phase tree with completed, current, and pending steps
- A decision explorer with search and phase filters
- A history viewer for archived `history/step-XX.md` responses
- One-click buttons to export documentation and sync editor rules

It listens on `127.0.0.1` only, refreshes automatically as you run `done` in another terminal, and never overwrites an existing `README.md` (it writes `README.ai.md` instead). Press `Ctrl+C` to stop it.

### Editor Rules Synchronization

Keep your AI coding assistant anchored to the project's architectural decisions:

```bash
npx build-with-ai export --rules
```

Updates:

- `.cursorrules` and `.cursor/rules/project-decisions.mdc`
- `.windsurfrules`
- `CLAUDE.md`
- `.github/copilot-instructions.md`

All user instructions outside the managed `<!-- BUILD-WITH-AI:START -->` block are preserved.

Optionally, configure exported decisions in `.buildwithai/rules.config.json`:

```json
{
  "includeKeys": ["decisions.database", "decisions.auth"],
  "excludeKeys": ["decisions.scratchNotes"]
}
```

Both keys are optional; `includeKeys` selects decisions, `excludeKeys` removes them, and exclusions take precedence. Without this file, all decisions are exported.

### Branch-Scoped Storage

To isolate state across git branches, enable branch scoping:

```bash
export BUILD_WITH_AI_BRANCH_SCOPED=1
```

State is isolated under `.buildwithai/branches/<branch-name>/`, ensuring feature branches do not collide.

---

## Storage Architecture

All state is self-contained inside your project's `.buildwithai/` directory:

```text
my-project/
├── .buildwithai/
│   ├── state.json        # Progress tracking and current step pointer
│   ├── context.json      # Structured architectural decisions (single source of truth)
│   ├── template.json     # Persisted template (for offline execution)
│   ├── snapshots/        # Step snapshots for non-destructive undo/rollback
│   ├── CONTEXT.md        # Formatted markdown view of decisions
│   └── history/          # Historical step responses (step-01.md, step-02.md, ...)
├── src/                  # User application code (never touched by CLI)
├── README.md             # Generated on export
└── BUILD_LOG.md          # Generated on export
```

---

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) for details on development setup, template specifications, and pull request guidelines.

Please review our [Code of Conduct](CODE_OF_CONDUCT.md).

---

## Security

To report security vulnerabilities, consult our [Security Policy](SECURITY.md) or contact [picadolabs@gmail.com](mailto:picadolabs@gmail.com).

---

## Maintainer

- **Maintainer:** [Vardhman Gupta](https://github.com/Kaap10)
- **Organization:** [PicadoLabs](https://github.com/PicadoLabs)
- **Contact:** [picadolabs@gmail.com](mailto:picadolabs@gmail.com)

---

## License

Licensed under the [Apache License 2.0](LICENSE).

Copyright &copy; 2026 [PicadoLabs](https://picadolabs.me).
