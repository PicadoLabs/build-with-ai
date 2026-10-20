# Contributing to build-with-ai

Thank you for your interest in contributing to **build-with-ai**! A minimal, zero-API terminal workflow CLI that guides developers through building software step-by-step with any AI web interface or assistant.

build-with-ai is maintained under the **PicadoLabs** organization (https://github.com/PicadoLabs).

---

## Table of Contents
1. [Code of Conduct](#1-code-of-conduct)
2. [Design Principles](#2-design-principles)
3. [Prerequisites & Local Setup](#3-prerequisites--local-setup)
4. [Verification & Quality Commands](#4-verification--quality-commands)
5. [Commit Message Standards (Conventional Commits)](#5-commit-message-standards-conventional-commits)
6. [Submitting Pull Requests](#6-submitting-pull-requests)
7. [Template Authoring Guide](#7-template-authoring-guide)
8. [Strict No-Emoji Policy](#8-strict-no-emoji-policy)

---

## 1. Code of Conduct
All contributors and maintainers are expected to adhere to professional open-source standards and maintain a respectful, welcoming environment. Please report unacceptable behavior to picadolabs@gmail.com.

---

## 2. Design Principles
- **Zero API Keys**: The CLI operates completely without requiring external API keys, third-party cloud connections, or billable model endpoints.
- **Local & Branch-Scoped State**: Project decisions and step progress remain on the developer's machine inside `.buildwithai/` and adapt cleanly across git branches.
- **Copy-Paste First**: Step prompts are formatted cleanly and copied directly to the system clipboard for immediate paste into any AI chat interface (ChatGPT, Claude, Gemini, DeepSeek, local LLMs).
- **Deterministic & Backward Compatible**: CLI state and template parsing must remain reliable and never introduce breaking schema changes to existing `.buildwithai/` folders.

---

## 3. Prerequisites & Local Setup
- **Node.js**: Node 18 LTS or newer (tested against Node 18.x, 20.x, and 22.x).
- **npm**: npm 8 or newer.
- **Git**: Installed and configured.

### Quick Start
```bash
# 1. Clone your fork
git clone https://github.com/<your-username>/build-with-ai.git
cd build-with-ai

# 2. Install dependencies (automatically activates local git hooks via prepare script)
npm ci

# 3. Configure the commit message template (recommended)
git config commit.template .gitmessage

# 4. Optional: Link the CLI globally for manual testing
npm link
```

### Local Git Hooks
This repository provides zero-dependency git hooks inside `.githooks/`:
- `pre-commit`: Automatically runs `npm run format:check` and `npm run lint` before committing.
- `commit-msg`: Validates that the commit message conforms to Conventional Commits and contains zero emojis.

Hooks are activated automatically on `npm ci` or `npm install`. You can manually re-enable them anytime with:
```bash
npm run prepare
```

---

## 4. Verification & Quality Commands
Every pull request must pass all quality checks prior to review. Run these commands locally before submitting changes:

```bash
# Check code formatting (Prettier)
npm run format:check

# Automatically fix code formatting discrepancies
npm run format

# Run ESLint static analysis
npm run lint

# Automatically fix autofixable ESLint issues
npm run lint:fix

# Run unit tests
npm test

# Run the complete end-to-end beginner verification suite
npm run test:e2e

# Run all test suites in sequence
npm run test:all
```

---

## 5. Commit Message Standards (Conventional Commits)
We enforce the Conventional Commits specification across all commits and PR titles.

### Commit Format
```text
<type>(<scope>): <subject>
```

- **Type** (required): Must be in lowercase.
- **Scope** (optional): Noun describing the subsystem affected, enclosed in parentheses (e.g., `cli`, `state`, `templates`, `export`, `config`, `rules`, `tests`).
- **Subject** (required): Imperative mood, lowercase, no ending period, maximum 72 characters, **no emojis**.

### Allowed Types
| Type | Description |
| :--- | :--- |
| `feat` | Adds a new feature or CLI command |
| `fix` | Fixes a bug or resolves an edge-case failure |
| `docs` | Documentation updates (README, guides, comments) |
| `style` | Formatting or styling changes that do not affect code logic |
| `refactor` | Code reorganization without changing external behavior or API |
| `perf` | Changes that improve execution or memory performance |
| `test` | Adding missing tests or refactoring test suites |
| `build` | Changes to build processes, packaging, or npm dependencies |
| `ci` | Changes to GitHub Actions workflows or automated scripts |
| `chore` | Maintenance tasks, gitignore updates, auxiliary scripts |
| `revert` | Reverts a previous commit |

### Good Commit Examples
- `feat(export): add export rules command for cursor and copilot`
- `fix(undo): handle empty history directory gracefully`
- `docs: update template authoring guide in contributing guide`
- `ci: add e2e test verification step to workflow`

### Bad Commit Examples
- `Fixed stuff` (missing type, capitalized, vague)
- `feat: [emoji] add fancy new spinner` (violates strict no-emoji policy)
- `Update README.md` (missing conventional type prefix)

---

## 6. Submitting Pull Requests
1. **Create a branch**:
   Use descriptive branch names:
   - `feature/export-rules`
   - `fix/undo-empty-history`
   - `docs/contributing-guide`
2. **Make focused changes**:
   Keep commits modular and self-contained with conventional commit messages.
3. **Run local verification**:
   Ensure `npm run format:check`, `npm run lint`, and `npm run test:all` all pass cleanly.
4. **Push and open a PR**:
   - Give the PR a Conventional Commit title (e.g., `feat(export): add rule synchronization`).
   - Fill out all sections in the PR template (`.github/pull_request_template.md`).
   - Link the relevant issue (e.g., `Fixes #125`).

---

## 7. Template Authoring Guide
Templates define guided workflows in the `templates/` directory.

### Template JSON Schema
```json
{
  "name": "Template Name",
  "description": "Short description of the template.",
  "prompts": [
    {
      "id": "step-id",
      "text": "The actual prompt text sent to the user...",
      "requires": ["context_key_1"],
      "writes": ["context_key_2"]
    }
  ]
}
```

### Context Contracts (`requires` and `writes`)
- **`requires`**: Context keys mandatory for the step to execute. If missing, the CLI warns the user and inserts visible fallback placeholders.
- **`writes`**: Context keys this step saves into `context.json`.

### Interpolation Placeholders
Use double curly brace syntax (e.g. `{{project.name}}` or `{{decisions.framework}}`).

---

## 8. Strict No-Emoji Policy
We enforce a strict **no-emoji policy** across this repository:
- No emojis in source code or CLI terminal outputs.
- No emojis in commit messages or pull request titles.
- No emojis in documentation, templates, or markdown files.
- No emojis in GitHub issue comments or review notes.

Keep all communication, code, and documentation clean, professional, and accessible.
