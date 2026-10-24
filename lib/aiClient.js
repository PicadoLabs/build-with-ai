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
 *   - Anthropic Messages API: anthropic (Claude 4.6 family)
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
const path = require('path');
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
    defaultModel: 'claude-haiku-4-6',
    needsKey: true
  },
  gemini: {
    kind: 'gemini',
    envPrefix: 'GEMINI',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.5-flash',
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
 * @param {string} [options.cwd]
 * @returns {{provider: string, kind: string, apiKey: string|null, baseUrl: string, model: string, needsKey: boolean}}
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

  return {
    provider: providerName,
    kind: provider.kind,
    apiKey,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model,
    needsKey: provider.needsKey,
    envPrefix: provider.envPrefix
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

async function chatOpenAICompatible(config, messages, fetchImpl, timeoutMs) {
  const headers = { 'content-type': 'application/json' };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  const res = await fetchWithTimeout(
    fetchImpl,
    `${config.baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model,
        messages: messages.map(({ role, content }) => ({ role, content })),
        temperature: 0.2
      })
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

const FILE_FENCE_RE = /```([^\s`]+)[ \t]*\r?\n([\s\S]*?)```/g;

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
 * Parses fenced file blocks from a model response. Convention (sent in the
 * system prompt): each file is a fenced block whose info string is the
 * project-relative path, e.g. ```src/app.js ... ```. Fences whose info
 * string is a syntax-highlighting language tag (```javascript, ```bash,
 * ...) or that do not look like file paths are skipped so they are never
 * written to the project root (#134). A ```decisions block is skipped here
 * (see parseDecisionsBlock). When a path repeats, the last block wins.
 * @param {string} text
 * @param {string[]} [targetFiles] declared target files for the step
 * @returns {Array<{path: string, content: string}>}
 */
function parseFileBlocks(text, targetFiles) {
  const byPath = new Map();
  FILE_FENCE_RE.lastIndex = 0;
  let match;
  while ((match = FILE_FENCE_RE.exec(text)) !== null) {
    const info = match[1].trim();
    if (!isFileBlockTarget(info, targetFiles)) continue;
    const content = match[2].replace(/\n$/, '');
    byPath.set(info, { path: info, content });
  }
  return Array.from(byPath.values());
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
 * empty paths, null bytes).
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
  return absolute;
}

/**
 * Writes parsed file blocks into the project directory, creating parent
 * directories as needed. Unsafe paths are skipped, never written.
 * @param {string} cwd
 * @param {Array<{path: string, content: string}>} blocks
 * @returns {Array<{path: string, absolute: string|null, created: boolean, written: boolean, skipped: string|null}>}
 */
function writeFileBlocks(cwd, blocks) {
  return blocks.map((block) => {
    const absolute = resolveTargetPath(cwd, block.path);
    if (!absolute) {
      return {
        path: block.path,
        absolute: null,
        created: false,
        written: false,
        skipped: 'unsafe path (outside the project directory)'
      };
    }
    const existed = fs.existsSync(absolute);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, block.content, 'utf8');
    return { path: block.path, absolute, created: !existed, written: true, skipped: null };
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

module.exports = {
  PROVIDERS,
  DEFAULT_PROVIDER,
  loadDotEnv,
  resolveProviderConfig,
  chatCompletion,
  parseFileBlocks,
  parseDecisionsBlock,
  resolveTargetPath,
  writeFileBlocks,
  renderDiff,
  buildRunSystemPrompt
};
