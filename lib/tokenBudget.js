/**
 * Token budget estimation for step prompts (#215).
 *
 * Estimates are heuristic (~4 characters per token for English prose) and
 * meant for advisory warnings only: code, non-English text and unusual
 * tokenizers can use noticeably more tokens per character.
 */

const CHARS_PER_TOKEN = 4;
const WARNING_THRESHOLD = 0.75;

/**
 * Known context windows by model id, checked in order (first match wins).
 * Values are deliberately conservative; when a model is not listed the
 * provider default applies. Override with --context-window or
 * <PREFIX>_CONTEXT_WINDOW when your model differs.
 */
const MODEL_CONTEXT_WINDOWS = [
  { pattern: /^gpt-4\.1/, tokens: 1000000 },
  { pattern: /^gpt-4o/, tokens: 128000 },
  { pattern: /^gpt-4-turbo/, tokens: 128000 },
  { pattern: /^gpt-4(-\d|$)/, tokens: 8192 },
  { pattern: /^gpt-3\.5-turbo/, tokens: 16385 },
  { pattern: /^o1-(mini|preview)/, tokens: 128000 },
  { pattern: /^o[134](-|$)/, tokens: 200000 },
  { pattern: /^claude/, tokens: 200000 },
  { pattern: /^gemini-1\.0|^gemini-pro$/, tokens: 32768 },
  { pattern: /^gemini/, tokens: 1000000 },
  { pattern: /^deepseek/, tokens: 64000 },
  { pattern: /llama-?3\.[123]/, tokens: 128000 },
  { pattern: /mixtral-8x7b/, tokens: 32768 }
];

/**
 * Provider fallbacks when the model is not in MODEL_CONTEXT_WINDOWS.
 * Ollama is fixed regardless of model: its OpenAI-compatible endpoint uses
 * the server's num_ctx setting, which is usually far below the model's
 * native window and silently truncates longer prompts.
 */
const PROVIDER_CONTEXT_WINDOWS = {
  openai: 128000,
  anthropic: 200000,
  gemini: 1000000,
  deepseek: 64000,
  ollama: 8192
};

const MODEL_INDEPENDENT_PROVIDERS = new Set(['ollama']);

/**
 * Estimates the token count of a string.
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Resolves the context window for a provider/model pair.
 * @param {object} params
 * @param {string} [params.provider]
 * @param {string} [params.model]
 * @param {number|null} [params.override] Explicit window from options or env.
 * @returns {{ tokens: number|null, source: 'override'|'model'|'provider-default'|'unknown' }}
 */
function resolveContextWindow({ provider, model, override } = {}) {
  if (Number.isInteger(override) && override > 0) {
    return { tokens: override, source: 'override' };
  }
  const providerName = String(provider || '').toLowerCase();
  if (!MODEL_INDEPENDENT_PROVIDERS.has(providerName)) {
    // Hosted ids are often namespaced ("meta-llama/Llama-3.3-70B"), so match
    // against the last path segment as well as the full id.
    const id = String(model || '').toLowerCase();
    const candidates = [id, id.split('/').pop()];
    const known = MODEL_CONTEXT_WINDOWS.find(({ pattern }) => candidates.some((value) => pattern.test(value)));
    if (known) return { tokens: known.tokens, source: 'model' };
  }
  if (Object.prototype.hasOwnProperty.call(PROVIDER_CONTEXT_WINDOWS, providerName)) {
    return { tokens: PROVIDER_CONTEXT_WINDOWS[providerName], source: 'provider-default' };
  }
  return { tokens: null, source: 'unknown' };
}

/**
 * Builds a token budget for a prompt sent to a provider/model.
 * @param {object} params
 * @param {string} params.prompt Resolved step prompt (user message).
 * @param {string} [params.systemPrompt] System prompt sent alongside it.
 * @param {string} [params.provider]
 * @param {string} [params.model]
 * @param {number|null} [params.contextWindow] Explicit window override.
 * @returns {{
 *   promptTokens: number,
 *   systemTokens: number,
 *   totalTokens: number,
 *   provider: string|null,
 *   model: string|null,
 *   contextWindow: number|null,
 *   contextWindowSource: string,
 *   percentOfContext: number|null,
 *   threshold: number,
 *   status: 'ok'|'warning'|'overflow'|'unknown'
 * }}
 */
function buildTokenBudget({ prompt, systemPrompt = '', provider, model, contextWindow } = {}) {
  const promptTokens = estimateTokens(prompt);
  const systemTokens = estimateTokens(systemPrompt);
  const totalTokens = promptTokens + systemTokens;
  const window = resolveContextWindow({ provider, model, override: contextWindow });

  let percentOfContext = null;
  let status = 'unknown';
  if (window.tokens) {
    percentOfContext = Math.round((totalTokens / window.tokens) * 1000) / 10;
    if (totalTokens >= window.tokens) status = 'overflow';
    else if (totalTokens >= window.tokens * WARNING_THRESHOLD) status = 'warning';
    else status = 'ok';
  }

  return {
    promptTokens,
    systemTokens,
    totalTokens,
    provider: provider || null,
    model: model || null,
    contextWindow: window.tokens,
    contextWindowSource: window.source,
    percentOfContext,
    threshold: WARNING_THRESHOLD,
    status
  };
}

/**
 * Formats an advisory warning for a budget, or returns null when none is due.
 * @param {ReturnType<typeof buildTokenBudget>} budget
 * @param {object} [options]
 * @param {string} [options.envPrefix] Provider env prefix for the override hint (e.g. "OLLAMA").
 * @returns {string|null}
 */
function formatBudgetWarning(budget, { envPrefix } = {}) {
  if (!budget || (budget.status !== 'warning' && budget.status !== 'overflow')) return null;

  const usage =
    `~${budget.totalTokens.toLocaleString('en-US')} tokens is ${budget.percentOfContext}% of the ` +
    `${budget.contextWindow.toLocaleString('en-US')}-token context window of ${budget.model || 'the model'}`;
  const headline =
    budget.status === 'overflow'
      ? `The prompt likely exceeds the context window: ${usage}. The model may truncate or reject it.`
      : `The prompt is close to the context window: ${usage}.`;

  const hints = [];
  if (budget.provider === 'ollama') {
    hints.push("Ollama's limit is the server num_ctx setting; raise it for this model if your hardware allows.");
  }
  hints.push(
    'Consider shortening long decisions with `build-with-ai set` or using a model with a larger context window.'
  );
  if (budget.contextWindowSource !== 'override') {
    const variable = envPrefix ? `${envPrefix}_CONTEXT_WINDOW` : '<PROVIDER>_CONTEXT_WINDOW';
    hints.push(`If the real window differs, pass --context-window <tokens> or set ${variable}.`);
  }
  return `${headline} ${hints.join(' ')}`;
}

module.exports = {
  CHARS_PER_TOKEN,
  WARNING_THRESHOLD,
  estimateTokens,
  resolveContextWindow,
  buildTokenBudget,
  formatBudgetWarning
};
