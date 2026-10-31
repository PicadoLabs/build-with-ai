# Changelog

All notable changes to `build-with-ai` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.4.0] - 2026-10-29

### Added
- **BYOK Autonomous Execution Engine (`next --run`):** Opt-in autonomous model execution supporting OpenAI, Anthropic, Gemini, DeepSeek, Groq, Together, and local Ollama. Generates file diff previews with `--review`, parses generated files and decisions, writes changes safely, and automatically gitignores `.buildwithai/.env`.
- **Native Model Context Protocol (MCP) Stdio Server (`mcp`):** Exposes `get_workflow_status`, `get_active_prompt`, `complete_step`, and `get_context` tools via standard JSON-RPC 2.0 stdio protocol for AI editor agents (Cursor, Windsurf, Claude Code) and Claude Desktop.
- **Undo Snapshots & Rollback (`undo`):** Pre-step snapshots stored in `.buildwithai/snapshots/` enable rolling back step counters, restoring previous `context.json` decisions, and deleting step history files.
- **Editor Rules Synchronization (`export --rules`):** Exports and synchronizes recorded architectural decisions into `.cursorrules`, `.cursor/rules/project-decisions.mdc`, `.windsurfrules`, `CLAUDE.md`, and `.github/copilot-instructions.md`, preserving custom instructions outside the managed block.
- **Interactive Configuration Editor (`config`):** Interactive key picker and editor to browse and update stored decisions with automatic JSON parsing and validation.
- **Community Template Registry Search (`search`):** Query remote community templates from registry and initialize projects with single-click workflow templates.
- **Branch-Scoped Storage (`BUILD_WITH_AI_BRANCH_SCOPED=1`):** Optional environment flag to isolate project state, context, and history per git branch under `.buildwithai/branches/<branch-name>/`.
- **Pre-Flight Target Files Verification:** Soft check on step target files and git status changes during `done`.
- **Heuristic Clipboard Decisions Parsing (`done --from-clipboard`):** Automatically extract structured decisions directly from clipboard responses.
- **Model Capability Aliasing (`models`):** Dynamic model capability mappings and command to inspect recommended models for engineering tasks.

### Changed
- **Safe Interactive Prompts (`safePrompt`):** Replaced direct prompt handling with graceful SIGINT / Ctrl+C cancellation exiting with code 130.
- **Workspace Template Persistence:** Custom local and remote templates persist to `.buildwithai/template.json` for offline resolution across all commands.
- **Export Conflict Safety:** Safeguards existing `README.md` on export by offering `README.ai.md` fallback unless `--force` is supplied.
- **Windows Console Glyphs:** Added UTF-8 detection and ASCII fallback glyphs for legacy Windows CMD consoles.
- **CI & Label Taxonomy:** Migrated PR auto-labeler to scoped taxonomy (`type:*`, `area:*`, `priority:*`, `status:*`).

### Fixed
- **Language-Tagged Markdown Fences Parsing:** Normalized CRLF and permitted language identifiers on code fences in `parseFileBlocks` (#184, #204).
- **Security Path Traversal Restrictions:** Blocked autonomous model writes to `.git`, `.buildwithai`, `node_modules`, and parent directories (#179).
- **Unprefixed Decisions Parsing:** Supported unprefixed and nested keys in autonomous decision blocks (#177, #202).
- **CLI Cancel Exit Codes:** Ensured proper non-zero exit codes on user cancellations and custom template fetch aborts (#194, #200).
- **Step Snapshot Cleanup:** Reverted context decisions and cleaned pending snapshots on step cancellations and validation failures (#167, #176).
- **Completed Steps Deduplication:** Fixed progress bar calculation by deduplicating completed step counts (#163, #178).
- **Atomic File Writes on Windows:** Added retry logic for transient Windows file locks during atomic JSON updates (#86).
- **Context Path Security:** Prevented prototype pollution in context builder helpers (#82).

---

## [1.3.0] - 2026-10-03

### Added
- **Electron Desktop App Template:** Added full 12-step desktop application workflow template (`templates/electron-app.json`) covering IPC, Vite, React, and electron-builder.
- **Automated Template Schema & DAG Validator:** Zero-dependency template and Context DAG validation engine (`lib/validator.js`) ensuring contract safety.
- **CI/CD Static Analysis Pipeline:** Added ESLint and Prettier automated checks across Node 18, 20, and 22 in GitHub Actions (`.github/workflows/ci.yml`).
- **Automated GitHub Release Drafting:** Integrated tag-based automated release and changelog drafting workflow (`.github/workflows/release.yml`).
- **Custom Template Documentation:** Added explicit usage examples for local and remote JSON templates via `--template <path|url>`.

### Fixed
- **Hero Templates Variable Contract:** Audited and resolved missing global variable prerequisites across all built-in hero templates.
- **Resume Edge Cases:** Hardened `build-with-ai resume` handling for completed workflows and unreadable state files.
- **Remote Loading Reliability:** Ensured network timeout and stream error recovery on remote template fetching.

---

## [1.2.0] - 2026-09-19

### Added
- **Discord Bot Workflow:** Added comprehensive 12-step guided template (`templates/discord-bot.json`).
- **History Inspection Command:** Added `build-with-ai history [stepNumber]` to inspect recorded step markdown files with ISO timestamps.
- **Status Metrics Dashboard:** Enriched `build-with-ai status` with Time Elapsed, Last Updated age, Decisions Count, and Export Readiness.
- **Export Enhancements:** Added `--out-dir` / `-o` custom output directory support and `--dry-run` non-destructive preview mode.
- **Template Discovery:** Added `build-with-ai list --search <query>` and `list --json`.
- **Clipboard Controls:** Added `--no-copy` opt-out and non-interactive `next --raw` / `next --json`.

### Changed
- **Atomic Persistence:** Upgraded state and context persistence in `lib/state.js` to use atomic temp-file write and rename (`writeJsonAtomic`).
- **CI Reliability:** Enhanced test runner to strictly exit with non-zero status code on E2E assertion failures.
- **License:** Updated project licensing to Apache License 2.0.

---

## [1.1.1] - 2026-08-29

### Changed
- Standardized project licensing under Apache License 2.0.
- Redesigned documentation and repository URLs to align with PicadoLabs ecosystem.
- Normalized repository line endings via `.gitattributes`.
- Verified and updated documentation assets for open-source registry readiness.

---

## [1.1.0] - 2026-08-29

### Added
- **New CLI Commands:**
  - `build-with-ai context [key]`: Inspect all recorded decisions or look up a specific dot-notation key.
  - `build-with-ai set <key> <value>`: Modify any decision directly in `context.json` on the fly.
  - `build-with-ai jump [stepNumber]`: Jump directly to any step number with an interactive step picker fallback.
  - `build-with-ai next --raw`: Output only the prompt string for piping directly into other CLI utilities or scripts.
  - `build-with-ai next --json`: Output structured JSON data of the active step.
- **Enhanced Step Banners:**
  - Added `PHASE`, `RECOMMENDED AI`, and `TARGET FILES` fields to step displays for clearer developer guidance.
- **Custom Template Loading:**
  - Added `--template <path-or-url>` flag to `init` command, supporting local `.json` files and remote HTTPS URLs.
- **5 New Workflow Templates:**
  - `saas-mvp.json` (15 steps): Modern SaaS with Next.js 14, Supabase, Stripe, and Resend.
  - `mobile-app.json` (15 steps): Cross-platform mobile development with React Native, Expo Router, and EAS Build.
  - `flutter-app.json` (16 steps): Cross-platform mobile development with Flutter, Dart, and Supabase/Firebase.
  - `chrome-extension.json` (12 steps): Browser extensions using Manifest V3, Vite, and React.
  - `ai-agent.json` (14 steps): AI Agent & RAG Pipeline with LangChain, vector databases, and FastAPI/Express.
- **Open Source Governance:**
  - Added GitHub Actions CI multi-OS testing matrix (`ubuntu`, `macos`, `windows`).
  - Added issue templates, PR template, Dependabot, Code of Conduct, and Security policy.

### Changed
- Upgraded root interactive menu to include `context` and `jump` quick actions.
- Enriched `web-app.json` (23 steps) and `rest-api.json` (10 steps) with `targetFiles` and `recommendedAI` metadata.

---

## [1.0.2] - 2026-08-25

### Changed
- Packaging and documentation polish for npm publication readiness.
- Fixed clipboard fallback handler to support both ESM and CommonJS exports.
- Stripped extraneous logging and emojis for cleaner terminal display.

---

## [1.0.0] - 2026-08-25

### Added
- Initial release of `build-with-ai`.
- Zero-API, local-first workflow engine.
- 10 core commands: `init`, `next`, `done`, `back`, `status`, `resume`, `export`, `list`, `reset`, and root interactive launcher.
- Automatic context injection with dot-notation placeholders (`{{decisions.database}}`).
- Full-Stack Web App (`web-app.json`) and Backend REST API (`rest-api.json`) templates.
- Markdown documentation generator (`export` for `README.md`, `BUILD_LOG.md`, `CONTEXT.md`).

