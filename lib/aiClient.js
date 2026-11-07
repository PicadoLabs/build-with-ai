/**
 * BYOK autonomous execution engine.
 *
 * Zero-dependency AI client (native Node `fetch` only) that lets developers
 * with their own API keys — or a local LLM — run workflow steps autonomously
 * instead of copy/pasting prompts between the CLI and a chat window.
 *
 * Supported providers:
 *   - OpenAI-compatible chat completions: openai, deepseek, groq, together,
 *     ollama (and any local vLLM at http://localhost:11434/v1)
 *   - Anthropic Messages API: anthropic (Claude Haiku family)
 *   - Google Gemini API: gemini (Gemini 3.x family)
 *   - jev: JEV native endpoint (OpenAI-compatible; needs JEV_BASE_URL)
 *
 * API keys resolve in this order:
 *   1. explicit `--api-key` flag,
 *   2. environment variables (`<PROVIDER>_API_KEY`, e.g. `OPENAI_API_KEY`),
 *   3. `.buildwithai/.env` (gitignored; `KEY=VALUE` per line).
 *
 * Model and base URL can be overridden per provider with
 * `<PROVIDER>_MODEL` / `<PROVIDER>_BASE_URL` (or the --model/--base-url flags).
 *
 * Used by: `npx build-with-ai next --run [--review]`
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const pc = require('picocolors');

const PROVIDERS = {
  openai: {
    kind: 'openai',
    envPrefix: 'OPENAI',
    defaultBaseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    needsKey: true
  },
  deepseek: {
    kind: 'openai',
    envPrefix: 'DEEPSEEK',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
    needsKey: true
  },
  groq: {
    kind: 'openai',
    envPrefix: 'GROQ',
    defaultBaseUrl: 'https://api.groq.com/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    needsKey: true
  },
  together: {
    kind: 'openai',
    envPrefix: 'TOGETHER',
    defaultBaseUrl: 'https://api.together.xyz/v1',
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo',
    needsKey: true
  },
  ollama: {
    kind: 'openai',
    envPrefix: 'OLLAMA',
    defaultBaseUrl: 'http://localhost:11434/v1',
    defaultModel: 'llama3.1',
    needsKey: false
  },
  anthropic: {
    kind: 'anthropic',
    envPrefix: 'ANTHROPIC',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-haiku-5-5',
    needsKey: true
  },
  gemini: {
    kind: 'gemini',
    envPrefix: 'GEMINI',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-3.8-flash',
    needsKey: true
  },
  jev: {
    kind: 'openai',
    envPrefix: 'JEV',
    defaultBaseUrl: null,
    defaultModel: 'jev-standard',
    needsKey: true
  }
};

const DEFAULT_PROVIDER = 'openai';
const DOTENV_FILE = '.env';
const STORAGE_DIR = '.buildwithai';

/**
 * Parses a minimal dotenv file (`KEY=VALUE` per line, `#` comments,
 * optional surrounding quotes). Never throws: a missing or unreadable
 * file yields an empty object.
 * @param {string} [cwd]
 * @returns {Record<string, string>}
 */
function loadDotEnv(cwd = process.cwd()) {
  const dotenvPath = path.join(cwd, STORAGE_DIR, DOTENV_FILE);
  const values = {};
  let raw;
  try {
    raw = fs.readFileSync(dotenvPath, 'utf8');
  } catch {
    return values;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key) values[key] = value;
  }
  return values;
}

/**
 * Resolves the provider configuration for an autonomous run.
 * Precedence: explicit options > environment variables > `.buildwithai/.env`.
 * @param {object} [options]
 * @param {string} [options.provider]
 * @param {string} [options.apiKey]
 * @param {string} [options.baseUrl]
 * @param {string} [options.model]
 * @param {string|number} [options.contextWindow] Context window override in tokens (#215).
 * @param {string} [options.cwd]
 * @returns {{provider: string, kind: string, apiKey: string|null, baseUrl: string, model: string, needsKey: boolean,
 *   contextWindow: number|null}}
 */
function resolveProviderConfig(options = {}) {
  const cwd = options.cwd || process.cwd();
  const dotenv = loadDotEnv(cwd);

  const pick = (name) => {
    if (options[name] !== undefined && options[name] !== null && options[name] !== '') {
      return options[name];
    }
    return undefined;
  };

  const providerName = (pick('provider') || process.env.BUILD_WITH_AI_PROVIDER || dotenv.PROVIDER || DEFAULT_PROVIDER)
    .toString()
    .toLowerCase();
  const provider = PROVIDERS[providerName];
  if (!provider) {
    throw new Error(`Unknown provider "${providerName}". Supported: ${Object.keys(PROVIDERS).join(', ')}.`);
  }

  const env = process.env;
  const apiKey =
    pick('apiKey') || env[`${provider.envPrefix}_API_KEY`] || dotenv[`${provider.envPrefix}_API_KEY`] || null;
  const baseUrl =
    pick('baseUrl') ||
    env[`${provider.envPrefix}_BASE_URL`] ||
    dotenv[`${provider.envPrefix}_BASE_URL`] ||
    provider.defaultBaseUrl;
  const model =
    pick('model') ||
    env[`${provider.envPrefix}_MODEL`] ||
    dotenv[`${provider.envPrefix}_MODEL`] ||
    provider.defaultModel;

  if (!baseUrl) {
    throw new Error(
      `Provider "${providerName}" needs a base URL: pass --base-url or set ${provider.envPrefix}_BASE_URL.`
    );
  }

  // Optional context window override for token budget warnings (#215),
  // with the same precedence as the other settings.
  const contextWindowVar = `${provider.envPrefix}_CONTEXT_WINDOW`;
  const contextWindowSources = [
    ['--context-window', pick('contextWindow')],
    [contextWindowVar, env[contextWindowVar]],
    [`${contextWindowVar} in .buildwithai/.env`, dotenv[contextWindowVar]]
  ];
  const [contextWindowSource, rawContextWindow] = contextWindowSources.find(
    ([, value]) => value !== undefined && value !== null && String(value).trim() !== ''
  ) || [null, null];
  let contextWindow = null;
  if (rawContextWindow !== null) {
    const text = String(rawContextWindow).trim();
    contextWindow = /^\d+$/.test(text) ? Number(text) : NaN;
    if (!Number.isSafeInteger(contextWindow) || contextWindow <= 0) {
      throw Object.assign(
        new Error(
          `Invalid context window "${rawContextWindow}" from ${contextWindowSource}: use a positive whole number of tokens.`
        ),
        { code: 'INVALID_CONTEXT_WINDOW' }
      );
    }
  }

  return {
    provider: providerName,
    kind: provider.kind,
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    needsKey: provider.needsKey,
    envPrefix: provider.envPrefix,
    contextWindow
  };
}

/**
 * Reads a fetch Response as JSON, tolerating empty bodies.
 */
async function readJsonBody(res) {
  const text = await res.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`);
  }
}

function fetchWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetchImpl(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

/** OpenAI reasoning models (o1/o3) reject a custom temperature. */
function isOpenAIReasoningModel(model) {
  return typeof model === 'string' && /^o[13](?:-|$)/i.test(model);
}

async function chatOpenAICompatible(config, messages, fetchImpl, timeoutMs) {
  const headers = { 'content-type': 'application/json' };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  const payload = {
    model: config.model,
    messages: messages.map(({ role, content }) => ({ role, content }))
  };
  if (!isOpenAIReasoningModel(config.model)) payload.temperature = 0.2;
  const res = await fetchWithTimeout(
    fetchImpl,
    `${config.baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    },
    timeoutMs
  );
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Chat completions request failed (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await readJsonBody(res);
  const text = data?.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error('Chat completions response had no message content.');
  return text;
}

async function chatAnthropic(config, messages, fetchImpl, timeoutMs) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const rest = messages.filter((m) => m.role !== 'system').map(({ role, content }) => ({ role, content }));
  const body = { model: config.model, max_tokens: 4096, messages: rest };
  if (system) body.system = system;
  const res = await fetchWithTimeout(
    fetchImpl,
    `${config.baseUrl}/messages`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.apiKey || '',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    },
    timeoutMs
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Anthropic request failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await readJsonBody(res);
  const text = Array.isArray(data?.content)
    ? data.content
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text)
        .join('')
    : '';
  if (!text) throw new Error('Anthropic response had no text content.');
  return text;
}

async function chatGemini(config, messages, fetchImpl, timeoutMs) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map(({ role, content }) => ({
      role: role === 'assistant' ? 'model' : 'user',
      parts: [{ text: content }]
    }));
  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const res = await fetchWithTimeout(
    fetchImpl,
    `${config.baseUrl}/models/${encodeURIComponent(config.model)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-goog-api-key': config.apiKey || ''
      },
      body: JSON.stringify(body)
    },
    timeoutMs
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Gemini request failed (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  const data = await readJsonBody(res);
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts) ? parts.map((part) => (part && part.text) || '').join('') : '';
  if (!text) throw new Error('Gemini response had no text content.');
  return text;
}

/**
 * Sends chat messages to the configured provider and returns the
 * assistant's text. Uses the global fetch (Node >= 18); pass
 * `fetchImpl` to stub the network in tests.
 * @param {{kind: string, baseUrl: string, model: string, apiKey: string|null}} config
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} [options]
 * @param {Function} [options.fetchImpl]
 * @param {number} [options.timeoutMs]
 * @returns {Promise<string>}
 */
async function chatCompletion(config, messages, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('No fetch implementation available. Node >= 18 provides a global fetch.');
  }
  const timeoutMs = options.timeoutMs || 120000;
  switch (config.kind) {
    case 'openai':
      return chatOpenAICompatible(config, messages, fetchImpl, timeoutMs);
    case 'anthropic':
      return chatAnthropic(config, messages, fetchImpl, timeoutMs);
    case 'gemini':
      return chatGemini(config, messages, fetchImpl, timeoutMs);
    default:
      throw new Error(`Unsupported provider kind "${config.kind}".`);
  }
}

const FENCE_OPEN_RE = /^```([^\n`]+)[ \t]*$/;
const FENCE_CLOSE_RE = /^```[ \t]*$/;

/**
 * Info strings that are syntax-highlighting language names rather than file
 * paths. Models sprinkle explanatory snippets (```javascript, ```bash, ...)
 * into responses; without this guard `writeFileBlocks` creates files named
 * `javascript`, `bash`, ... in the project root (#134).
 */
const FENCE_LANGUAGE_NAMES = new Set([
  'javascript',
  'js',
  'jsx',
  'typescript',
  'ts',
  'tsx',
  'json',
  'bash',
  'sh',
  'shell',
  'python',
  'py',
  'html',
  'css',
  'sql',
  'yaml',
  'yml',
  'markdown',
  'md',
  'diff',
  'console',
  'terminal',
  'text',
  'txt'
]);

/**
 * File extensions a bare (separator-less) fence info string may carry while
 * still being a plausible file path, e.g. ```package.json.
 */
const FENCE_PATH_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.json',
  '.jsonc',
  '.md',
  '.mdx',
  '.txt',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.env',
  '.html',
  '.css',
  '.scss',
  '.svg',
  '.py',
  '.rb',
  '.php',
  '.go',
  '.rs',
  '.java',
  '.sh',
  '.sql',
  '.xml',
  '.csv'
]);

/**
 * Decides whether a fence info string is meant as a file path. Language
 * tags and the decisions block never are. Otherwise the info string must
 * be a declared target file, look path-like (contain a separator), or
 * carry a recognized file extension.
 * @param {string} info
 * @param {string[]} [targetFiles] declared target files for the step
 * @returns {boolean}
 */
function isFileBlockTarget(info, targetFiles) {
  const lowered = info.toLowerCase();
  if (lowered === 'decisions' || FENCE_LANGUAGE_NAMES.has(lowered)) return false;
  if (Array.isArray(targetFiles) && targetFiles.includes(info)) return true;
  if (info.includes('/') || info.includes('\\')) return true;
  const dot = info.lastIndexOf('.');
  if (dot >= 0 && dot < info.length - 1 && FENCE_PATH_EXTENSIONS.has(info.slice(dot).toLowerCase())) return true;
  return false;
}

/**
 * Resolves a fence info string to the file path it names, or null when the
 * fence is not a file block. A language tag before the path
 * (```javascript src/app.js) is stripped and the path that follows is used
 * (#184); a language tag alone (```javascript, ```bash, ...) or an info
 * string that does not look like a file path is not a file block (#134).
 * @param {string} rawInfo
 * @param {string[]} [targetFiles] declared target files for the step
 * @returns {string|null}
 */
function fenceInfoToPath(rawInfo, targetFiles) {
  const infoParts = rawInfo.trim().split(/\s+/);
  // A language tag before the path (```javascript src/app.js) is not the
  // path itself; the token that follows it is (#184).
  const info =
    infoParts.length > 1 && FENCE_LANGUAGE_NAMES.has(infoParts[0].toLowerCase()) ? infoParts[1] : infoParts[0];
  return isFileBlockTarget(info, targetFiles) ? info : null;
}

/**
 * Scans a model response line by line for fenced file blocks. A block ends
 * at a bare closing fence, or — when the model never emits one — at the
 * next opening fence or the end of the response; that unterminated block
 * is truncated and reported separately instead of being written (#213).
 * Scanning line by line (rather than matching a closing fence anywhere in
 * the text) also keeps a truncated block from swallowing the block that
 * follows it: previously the truncated block's content ran up to the next
 * block's opening fence, which was consumed as its closing fence, so the
 * partial content was written and the following file was lost.
 * @param {string} text
 * @param {string[]} [targetFiles] declared target files for the step
 * @returns {{blocks: Array<{path: string, content: string}>, truncated: Array<{path: string}>}}
 */
function scanFileBlocks(text, targetFiles) {
  const byPath = new Map();
  const truncated = [];
  let current = null;
  const closeCurrent = (terminated) => {
    if (!current) return;
    const filePath = fenceInfoToPath(current.rawInfo, targetFiles);
    if (filePath) {
      if (terminated) {
        byPath.set(filePath, { path: filePath, content: current.lines.join('\n') });
      } else {
        truncated.push({ path: filePath });
      }
    }
    current = null;
  };
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (current) {
      if (FENCE_CLOSE_RE.test(line)) {
        closeCurrent(true);
        continue;
      }
      const open = FENCE_OPEN_RE.exec(line);
      if (open) {
        // A new fence before a closing fence means the open block is
        // truncated; it is dropped and the new block starts cleanly.
        closeCurrent(false);
        current = { rawInfo: open[1], lines: [] };
        continue;
      }
      current.lines.push(line);
    } else {
      const open = FENCE_OPEN_RE.exec(line);
      if (open) current = { rawInfo: open[1], lines: [] };
    }
  }
  closeCurrent(false);
  return { blocks: Array.from(byPath.values()), truncated };
}

/**
 * Parses fenced file blocks from a model response. Convention (sent in the
 * system prompt): each file is a fenced block whose info string is the
 * project-relative path, e.g. ```src/app.js ... ```. Models often emit the
 * path after a syntax-highlighting language tag (```javascript src/app.js);
 * the leading tag is stripped and the path that follows is used (#184).
 * Fences whose info string is a syntax-highlighting language tag alone
 * (```javascript, ```bash, ...) or that do not look like file paths are
 * skipped so they are never written to the project root (#134). A
 * ```decisions block is skipped here (see parseDecisionsBlock). When a
 * path repeats, the last block wins. CRLF line endings are normalized to
 * LF so Windows-style responses do not leave a trailing \r in the file
 * content (#184). Blocks without a closing fence are truncated and are
 * dropped here — never written — see findTruncatedFileBlocks (#213).
 * @param {string} text
 * @param {string[]} [targetFiles] declared target files for the step
 * @returns {Array<{path: string, content: string}>}
 */
function parseFileBlocks(text, targetFiles) {
  return scanFileBlocks(text, targetFiles).blocks;
}

/**
 * Returns the file blocks in a model response that lack a closing fence.
 * Callers warn about these (and count them as skipped) instead of writing
 * partial content to disk (#213).
 * @param {string} text
 * @param {string[]} [targetFiles] declared target files for the step
 * @returns {Array<{path: string}>}
 */
function findTruncatedFileBlocks(text, targetFiles) {
  return scanFileBlocks(text, targetFiles).truncated;
}

const JS_SYNTAX_EXTENSIONS = new Set(['.js', '.mjs', '.cjs']);

/**
 * Syntax-checks content with Node's own parser: the content is written to
 * a temporary file carrying the block's extension and checked with
 * `node --check`. A `.js` block is tried as both CommonJS and ESM, since
 * either module system is legitimate in a `.js` file. Returns the first
 * parser error line when both attempts fail.
 * @param {string} content
 * @param {string} ext file extension (lowercase, with leading dot)
 * @returns {{valid: boolean, error: string|null}}
 */
function nodeSyntaxCheck(content, ext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildwithai-syntax-'));
  try {
    const candidates = ext === '.js' ? ['.js', '.mjs'] : [ext];
    let lastError = 'syntax error';
    for (const candidate of candidates) {
      const file = path.join(dir, `check${candidate}`);
      fs.writeFileSync(file, content, 'utf8');
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
      if (result.status === 0) return { valid: true, error: null };
      const output = `${result.stderr || ''}\n${result.stdout || ''}`.trim();
      if (output) lastError = output.split('\n')[0];
    }
    return { valid: false, error: lastError };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Syntax-checks Python content with `py_compile` in a temporary directory.
 * When python3 is not installed the check is skipped (valid, with
 * `skipped` set) rather than blocking the write, since the tool cannot
 * verify what it cannot run.
 * @param {string} content
 * @returns {{valid: boolean, error: string|null, skipped: string|null}}
 */
function pythonSyntaxCheck(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildwithai-syntax-'));
  try {
    const file = path.join(dir, 'check.py');
    fs.writeFileSync(file, content, 'utf8');
    const pythonCommand = process.platform === 'win32' ? 'python' : 'python3';
    const result = spawnSync(pythonCommand, ['-m', 'py_compile', file], { encoding: 'utf8' });
    if (result.error) return { valid: true, error: null, skipped: 'python3 not available' };
    if (result.status === 0) return { valid: true, error: null, skipped: null };
    const output = `${result.stderr || ''}\n${result.stdout || ''}`.trim();
    return { valid: false, error: output ? output.split('\n').pop() : 'syntax error', skipped: null };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Sanity-checks a parsed file block's syntax before it is written to disk
 * (#213). JSON blocks go through JSON.parse; JavaScript blocks through
 * `node --check`; Python blocks through `py_compile` when python3 is
 * available. Other extensions (including .jsx/.tsx, which need a
 * transpiler rather than a plain parser) are not checked and always pass.
 * @param {{path: string, content: string}} block
 * @returns {{valid: boolean, error: string|null, skipped: string|null}}
 */
function validateBlockContent(block) {
  const ext = path.extname(block.path).toLowerCase();
  if (ext === '.json') {
    try {
      JSON.parse(block.content);
    } catch (err) {
      return { valid: false, error: `invalid JSON: ${err.message}`, skipped: null };
    }
    return { valid: true, error: null, skipped: null };
  }
  if (JS_SYNTAX_EXTENSIONS.has(ext)) return { ...nodeSyntaxCheck(block.content, ext), skipped: null };
  if (ext === '.py') return pythonSyntaxCheck(block.content);
  return { valid: true, error: null, skipped: null };
}

const DECISIONS_FENCE_RE = /```decisions[ \t]*\r?\n([\s\S]*?)```/i;

/**
 * Parses the ```decisions JSON block from a model response.
 * @param {string} text
 * @returns {Record<string, unknown>} decisions object, or {} when absent
 */
function parseDecisionsBlock(text) {
  DECISIONS_FENCE_RE.lastIndex = 0;
  const match = DECISIONS_FENCE_RE.exec(text);
  if (!match) return {};
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch (err) {
    throw new Error(`Could not parse the decisions JSON block: ${err.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('The decisions block must be a JSON object mapping keys to values.');
  }
  return parsed;
}

/**
 * Resolves a model-proposed file path to an absolute path inside the
 * project. Returns null for unsafe paths (absolute paths, `..` escapes,
 * empty paths, null bytes), for paths into reserved top-level
 * directories (`.git`, `.buildwithai`, `node_modules`, `.githooks`,
 * `.github`) that a model must never write to, and for the root `.env`
 * file (`.env.example` and other dotfiles still resolve).
 * @param {string} cwd
 * @param {string} targetPath
 * @returns {string|null}
 */
function resolveTargetPath(cwd, targetPath) {
  if (!targetPath || typeof targetPath !== 'string' || targetPath.includes('\0')) {
    return null;
  }
  if (path.isAbsolute(targetPath)) return null;
  const absolute = path.resolve(cwd, path.normalize(targetPath));
  const relative = path.relative(cwd, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  // A model must never write into version control, project state, or
  // installed packages: a planted `.git/hooks/*` script would run on the
  // next commit, and `.buildwithai/*` holds the workflow's own state.
  // `.githooks/*` is wired up as the repo's hooks path (`prepare` sets
  // `core.hooksPath` to it), so it is code execution too, and
  // `.github/workflows/*` would let a model tamper with CI. The root
  // `.env` holds developer credentials; `.env.example` stays writable
  // since it carries no secrets.
  const topLevel = relative.split(path.sep)[0];
  if (
    topLevel === '.git' ||
    topLevel === '.buildwithai' ||
    topLevel === 'node_modules' ||
    topLevel === '.githooks' ||
    topLevel === '.github'
  ) {
    return null;
  }
  if (relative === '.env') {
    return null;
  }
  return absolute;
}

/**
 * Writes parsed file blocks into the project directory, creating parent
 * directories as needed. Unsafe paths are skipped, never written, and so
 * are blocks that fail the syntax check — unless `options.force` is set
 * (`next --run --force`), in which case the block is written anyway and
 * the validation error is reported on the result (#213).
 * @param {string} cwd
 * @param {Array<{path: string, content: string}>} blocks
 * @param {object} [options]
 * @param {boolean} [options.force=false] write syntactically invalid blocks anyway
 * @returns {Array<{path: string, absolute: string|null, created: boolean, written: boolean, skipped: string|null, validationError: string|null}>}
 */
function writeFileBlocks(cwd, blocks, options = {}) {
  const force = options.force === true;
  return blocks.map((block) => {
    const absolute = resolveTargetPath(cwd, block.path);
    if (!absolute) {
      return {
        path: block.path,
        absolute: null,
        created: false,
        written: false,
        skipped: 'unsafe path (outside the project directory)',
        validationError: null
      };
    }
    const validation = validateBlockContent(block);
    if (!validation.valid && !force) {
      return {
        path: block.path,
        absolute,
        created: false,
        written: false,
        skipped: `invalid syntax: ${validation.error} (use --force to write anyway)`,
        validationError: validation.error
      };
    }
    const existed = fs.existsSync(absolute);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, block.content, 'utf8');
    return {
      path: block.path,
      absolute,
      created: !existed,
      written: true,
      skipped: null,
      validationError: validation.valid ? null : validation.error
    };
  });
}

/**
 * Minimal line diff (LCS) used by `--review` to preview proposed changes.
 * Returns null when the inputs are too large for a detailed diff.
 */
function diffLines(oldLines, newLines) {
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > 250000) return null;
  const lengths = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i][j] =
        oldLines[i] === newLines[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ type: ' ', text: oldLines[i] });
      i++;
      j++;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      ops.push({ type: '-', text: oldLines[i] });
      i++;
    } else {
      ops.push({ type: '+', text: newLines[j] });
      j++;
    }
  }
  while (i < n) ops.push({ type: '-', text: oldLines[i++] });
  while (j < m) ops.push({ type: '+', text: newLines[j++] });
  return ops;
}

/**
 * Renders a colored unified-style diff of a proposed file change.
 * @param {string} oldText current file content ('' for new files)
 * @param {string} newText proposed content
 * @param {object} [options]
 * @param {boolean} [options.color=true]
 * @returns {string}
 */
function renderDiff(oldText, newText, options = {}) {
  const color = options.color !== false;
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const ops = diffLines(oldLines, newLines);
  const paint = (type, text) => {
    if (!color) return `${type} ${text}`;
    if (type === '-') return pc.red(`- ${text}`);
    if (type === '+') return pc.green(`+ ${text}`);
    return pc.dim(`  ${text}`);
  };
  if (!ops) {
    return color ? pc.yellow('(file too large for a detailed diff)') : '(file too large for a detailed diff)';
  }
  // Collapse long unchanged runs so reviews stay readable.
  const CONTEXT = 3;
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.type === ' ') return;
    for (let k = Math.max(0, index - CONTEXT); k <= Math.min(ops.length - 1, index + CONTEXT); k++) {
      keep[k] = true;
    }
  });
  const lines = [];
  let skipped = false;
  ops.forEach((op, index) => {
    if (op.type === ' ' && !keep[index]) {
      if (!skipped) {
        lines.push(color ? pc.dim('  ...') : '  ...');
        skipped = true;
      }
      return;
    }
    skipped = false;
    lines.push(paint(op.type, op.text));
  });
  return lines.join('\n');
}

/**
 * Builds the system prompt for an autonomous step run: it tells the model
 * to answer with fenced file blocks plus a decisions JSON block.
 */
function buildRunSystemPrompt({ stepNum, totalSteps, targetFiles }) {
  const targets =
    targetFiles && targetFiles.length > 0
      ? targetFiles.map((f) => `  - ${f}`).join('\n')
      : '  (none declared for this step)';
  return [
    'You are an autonomous coding agent implementing one step of a software project.',
    `This is step ${stepNum} of ${totalSteps}. Implement exactly what the user's step prompt asks for — no more, no less.`,
    '',
    'Reply with this structure and nothing else outside it:',
    '1. One fenced code block per file to create or update. The info string after the opening fence MUST be the',
    '   project-relative file path (e.g. ```src/app.js). Put the complete new file content inside.',
    '2. Optionally, one ```decisions block with a JSON object mapping dot-notation decision keys to values',
    '   discovered while implementing (e.g. ```decisions\\n{ "decisions.database": "PostgreSQL" }\\n```).',
    '',
    'Rules:',
    '- Only write files inside the project directory. Never use absolute paths or ".." segments.',
    '- Target files for this step:',
    targets,
    '- Keep prose outside the blocks to a short summary (2-4 lines).'
  ].join('\n');
}

function buildArchitectSystemPrompt({ stepNum, totalSteps, targetFiles, context }) {
  const targets =
    targetFiles && targetFiles.length > 0
      ? targetFiles.map((file) => `  - ${file}`).join('\n')
      : '  (none declared for this step)';

  return [
    'You are the Architect Agent in a multi-agent software development pipeline.',
    `This is step ${stepNum} of ${totalSteps}.`,
    '',
    'Your responsibilities:',
    '1. Analyze the user task.',
    '2. Validate the supplied context.json structure.',
    '3. Define the required data contracts.',
    '4. Identify the files needed for implementation.',
    '5. Create an implementation plan for the Coder Agent.',
    '',
    'Context validation rules:',
    '- The root must be an object.',
    '- project, if present, must be an object.',
    '- decisions, if present, must be an object.',
    '- project may contain name, type, templateId, templateTitle, experienceLevel and idea.',
    '- decisions may contain dynamically collected project decisions.',
    '',
    'Actual context.json:',
    JSON.stringify(context, null, 2),
    '',
    'Declared target files:',
    targets,
    '',
    'Do not write source code or claim to have written files.',
    'Return ONLY valid JSON. Do not use Markdown fences or additional prose.',
    'Use exactly this JSON structure:',
    '{',
    '  "contextValid": true,',
    '  "contextErrors": [],',
    '  "dataContracts": [],',
    '  "targetFiles": [],',
    '  "implementationPlan": []',
    '}',
    'The targetFiles array must contain only files from the declared target files.'
  ].join('\n');
}

function buildCoderSystemPrompt({ targetFiles, architecture }) {
  const targets =
    targetFiles && targetFiles.length > 0
      ? targetFiles.map((file) => `  - ${file}`).join('\n')
      : '  (none declared for this step)';

  return [
    'You are the Coder Agent in a multi-agent software development pipeline.',
    'Implement the task using the architecture and data contracts supplied by the Architect Agent.',
    'Generate complete file contents, not partial snippets.',
    'Only generate files that are declared as target files.',
    'Do not claim that files have been written.',
    '',
    'Architecture plan:',
    architecture,
    '',
    'Target files:',
    targets,
    '',
    'Reply using the required file-block format:',
    'One fenced code block per file, with the project-relative file path immediately after the opening fence.',
    'Keep any summary outside the file blocks short.'
  ].join('\n');
}

// Defines the security and code-quality checks the Reviewer Agent must perform.
function buildReviewerSystemPrompt() {
  return [
    'You are the Reviewer Agent in a multi-agent coding pipeline.',
    'Review the Coder Agent output and the Architect plan.',
    'Check for path traversal, absolute paths, unsafe destinations, exposed secrets, unhandled exceptions and implementation errors.',
    'Check that generated files match the declared target files.',
    'Do not modify code or write files.',
    'Return ONLY valid JSON without markdown fences:',
    '{',
    '  "approved": true,',
    '  "issues": []',
    '}',
    'Set approved to false if any blocking issue exists.',
    'Never approve if you cannot confidently complete the security review.'
  ].join('\n');
}

// Runs Architect, Coder and Reviewer sequentially, validating every file before allowing it to be written.
async function runArchitectCoderPipeline({
  providerConfig,
  resolvedPrompt,
  stepNum,
  totalSteps,
  targetFiles,
  context,
  fetchImpl
}) {
  const cwd = process.cwd();
  const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

  if (!isPlainObject(context)) {
    throw new Error('Invalid context.json: root must be an object.');
  }

  if (Object.prototype.hasOwnProperty.call(context, 'project') && !isPlainObject(context.project)) {
    throw new Error('Invalid context.json: project must be an object.');
  }

  if (Object.prototype.hasOwnProperty.call(context, 'decisions') && !isPlainObject(context.decisions)) {
    throw new Error('Invalid context.json: decisions must be an object.');
  }
  if (!Array.isArray(targetFiles) || targetFiles.length === 0) {
    throw new Error('Pipeline requires declared target files.');
  }

  const normalizeTarget = (file) => {
    const normalized = path.normalize(file.replace(/[\\/]/g, path.sep)).replace(/\\/g, '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
  };

  const declaredTargets = new Set();

  for (const file of targetFiles) {
    if (typeof file !== 'string' || !resolveTargetPath(cwd, file)) {
      throw new Error(`Unsafe declared target file: ${file}`);
    }
    declaredTargets.add(normalizeTarget(file));
  }

  const architectSystem = buildArchitectSystemPrompt({
    stepNum,
    totalSteps,
    targetFiles,
    context
  });

  const architecture = await chatCompletion(
    providerConfig,
    [
      { role: 'system', content: architectSystem },
      { role: 'user', content: resolvedPrompt }
    ],
    { fetchImpl }
  );

  let architecturePlan;
  try {
    architecturePlan = JSON.parse(architecture);
  } catch (error) {
    throw new Error(`Architect output is invalid JSON: ${error.message}`);
  }

  if (
    !architecturePlan ||
    typeof architecturePlan !== 'object' ||
    architecturePlan.contextValid !== true ||
    !Array.isArray(architecturePlan.contextErrors) ||
    architecturePlan.contextErrors.length > 0 ||
    !Array.isArray(architecturePlan.dataContracts) ||
    !Array.isArray(architecturePlan.targetFiles) ||
    !Array.isArray(architecturePlan.implementationPlan)
  ) {
    throw new Error(
      `Architect rejected the context or returned an invalid plan: ${(architecturePlan?.contextErrors || []).join('; ')}`
    );
  }

  if (
    architecturePlan.targetFiles.length === 0 ||
    architecturePlan.targetFiles.some(
      (file) => typeof file !== 'string' || !declaredTargets.has(normalizeTarget(file)) || !resolveTargetPath(cwd, file)
    )
  ) {
    throw new Error('Architect selected an undeclared or unsafe target file.');
  }

  const allowedTargets = architecturePlan.targetFiles;

  const coderSystem = buildCoderSystemPrompt({
    targetFiles: allowedTargets,
    architecture: JSON.stringify(architecturePlan, null, 2)
  });

  const coderResponse = await chatCompletion(
    providerConfig,
    [
      { role: 'system', content: coderSystem },
      {
        role: 'user',
        content: `Original task:\n${resolvedPrompt}\n\nImplement the architecture plan.`
      }
    ],
    { fetchImpl }
  );

  const truncatedBlocks = findTruncatedFileBlocks(coderResponse, allowedTargets);
  if (truncatedBlocks.length > 0) {
    throw new Error('Coder output contains incomplete file blocks.');
  }

  const blocks = parseFileBlocks(coderResponse, allowedTargets);

  if (blocks.length === 0) {
    throw new Error('Coder did not generate any valid file blocks.');
  }

  for (const block of blocks) {
    if (
      !allowedTargets.some((file) => normalizeTarget(file) === normalizeTarget(block.path)) ||
      !resolveTargetPath(cwd, block.path)
    ) {
      throw new Error(`Coder generated an undeclared or unsafe file: ${block.path}`);
    }
  }

  const reviewerSystem = buildReviewerSystemPrompt();

  const reviewerResponse = await chatCompletion(
    providerConfig,
    [
      { role: 'system', content: reviewerSystem },
      {
        role: 'user',
        content: [
          `Architecture plan:\n${JSON.stringify(architecturePlan, null, 2)}`,
          `Declared target files:\n${allowedTargets.join('\n')}`,
          `Generated code:\n${coderResponse}`
        ].join('\n\n')
      }
    ],
    { fetchImpl }
  );

  let review;
  try {
    review = JSON.parse(reviewerResponse);
  } catch (error) {
    throw new Error(`Reviewer output is invalid JSON: ${error.message}`);
  }

  if (
    !review ||
    typeof review !== 'object' ||
    review.approved !== true ||
    !Array.isArray(review.issues) ||
    review.issues.length > 0
  ) {
    const issues = Array.isArray(review?.issues)
      ? review.issues.join('; ')
      : 'Invalid review response or approval not granted.';

    throw new Error(`Reviewer rejected the generated code: ${issues}`);
  }

  return {
    architecture: architecturePlan,
    coderResponse,
    review
  };
}
module.exports = {
  PROVIDERS,
  DEFAULT_PROVIDER,
  loadDotEnv,
  resolveProviderConfig,
  chatCompletion,
  parseFileBlocks,
  findTruncatedFileBlocks,
  validateBlockContent,
  parseDecisionsBlock,
  resolveTargetPath,
  writeFileBlocks,
  renderDiff,
  buildRunSystemPrompt,
  runArchitectCoderPipeline
};
