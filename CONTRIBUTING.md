# Contributing to build-with-ai

Thank you for your interest in contributing to **build-with-ai**! A terminal workflow CLI that guides you through building apps step-by-step with your favorite AI web interfaces.

build-with-ai is maintained under the **PicadoLabs** organization ([https://github.com/PicadoLabs](https://github.com/PicadoLabs)).

---

## Table of Contents
1. [Code of Conduct](#1-code-of-conduct)
2. [Prerequisites](#2-prerequisites)
3. [Local Setup & Installation](#3-local-setup--installation)
4. [Testing & Quality Verification](#4-testing--quality-verification)
5. [Submitting Pull Requests](#5-submitting-pull-requests)
6. [Template Authoring Guide](#6-template-authoring-guide)

---

## 1. Code of Conduct
All contributors and maintainers are expected to adhere to the [Code of Conduct](CODE_OF_CONDUCT.md). Please report unacceptable behavior to [picadolabs@gmail.com](mailto:picadolabs@gmail.com).

## 2. Prerequisites
- Node.js 16+

## 3. Local Setup & Installation
1. Clone the repo.
2. `cd build-with-ai`
3. `npm install`
4. `npm link` (optional, to test CLI locally)

## 4. Testing & Quality Verification
Before submitting a pull request, ensure all tests pass:
`npm test` or `npm run test:all`

## 5. Submitting Pull Requests
1. Fork the repository.
2. Create a feature branch (`git checkout -b feature/my-new-feature`).
3. Commit your changes (`git commit -am 'Add some feature'`).
4. Push to the branch (`git push origin feature/my-new-feature`).
5. Create a new Pull Request.

## 6. Template Authoring Guide

Templates are the core of `build-with-ai`, guiding the zero-API state machine. When creating or modifying templates in the `templates/` directory, please adhere to the following rules:

### Template JSON Schema
A template is a JSON file conforming to a specific structure. The standard structure is:
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
Templates run linearly and pass data using a context object. 
- **`requires`**: An array of context keys the step needs to function properly. The prompt will only execute if these keys exist in the context state.
- **`writes`**: An array of keys this step expects the user or subsequent state parsing to fulfill. 

### Interpolation Placeholders
You can inject context values dynamically into the prompts using double curly brace syntax. 
For example: `{{project.name}}` or `{{decisions.framework}}`. Ensure that any variable you interpolate is guaranteed to exist (e.g., via previous `writes` or the initial project setup).

### Validation and Testing
When adding a new template, you must ensure it does not break the core CLI. Run the full test suite locally before opening a pull request:
```bash
npm run test:all
```
If your template introduces new context keys, ensure they do not conflict with core system variables.

### Strict No-Emoji Rule
We strictly follow a maintainer OSS standard. **Do not use emojis** in template descriptions, prompt text, or inside this repository's codebase and documentation. Keep the tone clean, professional, and entirely text-based.
