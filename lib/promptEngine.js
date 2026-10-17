const fs = require('fs');
const path = require('path');
const { getByPath, flattenObject } = require('./contextBuilder');
const { validateTemplate } = require('./validator');
const { resolveModel } = require('./models');
const logger = require('./logger');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const REMOTE_TEMPLATE_TIMEOUT_MS = 10_000;

/**
 * Loads all available template JSON files.
 * @returns {Array<{ id, type, title, description, stepCount, steps }>}
 */
function loadTemplates() {
  if (!fs.existsSync(TEMPLATES_DIR)) {
    return [];
  }
  const files = fs.readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith('.json') && f !== 'index.json');
  // Prioritize web-app as the primary template
  files.sort((a, b) => {
    if (a === 'web-app.json') return -1;
    if (b === 'web-app.json') return 1;
    return a.localeCompare(b);
  });
  const templates = [];

  for (const file of files) {
    try {
      const fullPath = path.join(TEMPLATES_DIR, file);
      const raw = fs.readFileSync(fullPath, 'utf8');
      const data = JSON.parse(raw);

      const validation = validateTemplate(data);
      if (!validation.valid) {
        logger.error(`Template "${file}" is invalid:`);
        validation.errors.forEach((e) => logger.error(`  - ${e}`));
        continue;
      }

      const id = path.basename(file, '.json');
      templates.push({
        id,
        type: data.type || id,
        title: data.title || id,
        description: data.description || '',
        stepCount: Array.isArray(data.steps) ? data.steps.length : 0,
        steps: data.steps || []
      });
    } catch {
      // Ignore parse errors or other fs errors
    }
  }

  return templates;
}

/**
 * Loads a template from a custom local file path.
 * @param {string} filePath
 * @returns {object|null}
 */
function loadCustomTemplate(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(resolved, 'utf8');
    const data = JSON.parse(raw);

    const validation = validateTemplate(data);
    if (!validation.valid) {
      logger.error(`Custom template at "${filePath}" is invalid:`);
      validation.errors.forEach((e) => logger.error(`  - ${e}`));
      return null;
    }

    const id = path.basename(resolved, '.json');
    return {
      id,
      type: data.type || id,
      title: data.title || id,
      description: data.description || '',
      stepCount: Array.isArray(data.steps) ? data.steps.length : 0,
      steps: data.steps || []
    };
  } catch (err) {
    logger.error(`Error loading custom template: ${err.message}`);
    return null;
  }
}

/**
 * Fetches a template from a remote HTTPS URL.
 * Network errors, non-2xx statuses, empty or invalid JSON responses, and timeouts resolve as
 * a failed load so initialization can continue safely.
 * @param {string} url
 * @returns {Promise<object|null>}
 */
function loadRemoteTemplate(url) {
  return new Promise((resolve) => {
    const https = require('https');
    const http = require('http');
    const client = url.startsWith('https') ? https : http;
    let settled = false;
    let timeoutHandle;

    const finish = (template) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      resolve(template);
    };

    const request = client.get(url, (res) => {
      res.on('error', () => finish(null));
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        finish(null);
        return;
      }
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);

          const validation = validateTemplate(parsed);
          if (!validation.valid) {
            logger.error(`Remote template from "${url}" is invalid:`);
            validation.errors.forEach((e) => logger.error(`  - ${e}`));
            finish(null);
            return;
          }

          // Use the URL path only so query strings and fragments never leak into the id.
          const id = new URL(url).pathname.split('/').pop().replace('.json', '') || 'custom';
          finish({
            id,
            type: parsed.type || id,
            title: parsed.title || id,
            description: parsed.description || '',
            stepCount: Array.isArray(parsed.steps) ? parsed.steps.length : 0,
            steps: parsed.steps || []
          });
        } catch (err) {
          logger.error(`Error parsing remote template: ${err.message}`);
          finish(null);
        }
      });
    });

    request.on('error', () => finish(null));
    timeoutHandle = setTimeout(() => {
      finish(null);
      request.destroy();
    }, REMOTE_TEMPLATE_TIMEOUT_MS);
  });
}

/**
 * Gets a specific template by id or type.
 * @param {string} templateId
 * @returns {object|null}
 */
function getTemplate(templateId) {
  const templates = loadTemplates();
  return templates.find((t) => t.id === templateId || t.type === templateId) || null;
}

/**
 * Canonical architectural decision keys anchored in every generated prompt.
 * Each maps a `decisions.<key>` context path to a human-readable label.
 */
const CONTRACT_DECISION_KEYS = [
  { key: 'framework', label: 'Primary Framework' },
  { key: 'database', label: 'Database / ORM' },
  { key: 'auth', label: 'Authentication' }
];

/**
 * Renders a recorded decision value for the contract block.
 * Returns null when the value is missing/empty so missing decision
 * variables are omitted cleanly — never "undefined" or placeholder markers.
 * @param {*} value
 * @returns {string|null}
 */
function formatContractValue(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object') {
    const rendered = JSON.stringify(value);
    if (rendered === '{}' || rendered === '[]') return null;
    return rendered;
  }
  const text = String(value).trim();
  return text ? text : null;
}

/**
 * Builds the immutable architectural contract block from every decision
 * recorded in context.json (all previous `step.writes`).
 *
 * The block pins the choices the developer already made so AI models do not
 * drift to substitutes (e.g. MongoDB/Mongoose instead of PostgreSQL/Prisma)
 * in later steps. Returns an empty string when no decisions are recorded.
 *
 * @param {object} context
 * @returns {string} The contract markdown block, or '' when there is nothing to anchor
 */
function buildArchitecturalContract(context = {}) {
  const decisions = context && typeof context.decisions === 'object' && context.decisions ? context.decisions : {};
  const flat = flattenObject(decisions);
  const defined = Object.entries(flat).filter(([, value]) => formatContractValue(value) !== null);
  if (defined.length === 0) return '';

  const lines = ['### STRICT ARCHITECTURAL CONSTRAINTS (DO NOT ALTER)'];

  const project = context && typeof context.project === 'object' && context.project ? context.project : {};
  const projectName = typeof project.name === 'string' ? project.name.trim() : '';
  const experienceLevel = typeof project.experienceLevel === 'string' ? project.experienceLevel.trim() : '';
  if (projectName) {
    lines.push(`- Project: ${projectName}${experienceLevel ? ` (Level: ${experienceLevel})` : ''}`);
  }

  const used = new Set();
  for (const { key, label } of CONTRACT_DECISION_KEYS) {
    const value = formatContractValue(getByPath(decisions, key));
    if (value !== null) {
      lines.push(`- ${label}: ${value}`);
      used.add(key);
    }
  }

  // Dynamically gather every other recorded decision (all previous step.writes)
  for (const [key, raw] of defined) {
    if (used.has(key)) continue;
    const value = formatContractValue(raw);
    if (value === null) continue;
    const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => str.toUpperCase());
    lines.push(`- ${label}: ${value}`);
  }

  lines.push(
    'Strict Requirement: Adhere to these exact choices. Do NOT substitute or introduce alternative libraries.'
  );
  return lines.join('\n');
}

/**
 * Resolves prompt placeholders, checks `requires` dependencies, and exposes
 * optional targetFiles and recommendedAI from the step definition.
 *
 * @param {object} step
 * @param {object} context
 * @returns {{ resolvedPrompt, warnings, missingKeys, targetFiles, recommendedAI, architecturalContract }}
 */
function resolveStepPrompt(step, context = {}) {
  const warnings = [];
  const missingKeys = [];
  const requires = Array.isArray(step.requires) ? step.requires : [];

  // Check required keys
  for (const reqKey of requires) {
    const val = getByPath(context, reqKey);
    if (val === undefined || val === null || val === '') {
      missingKeys.push(reqKey);
      warnings.push(`Missing prerequisite decision: "${reqKey}" is not recorded in context.json`);
    }
  }

  // Regex to match {{key.path}} or {{ key.path }}; identifiers may contain hyphens, e.g. {{decisions.api-key}}
  const placeholderRegex = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;
  let resolvedPrompt = step.prompt || '';

  resolvedPrompt = resolvedPrompt.replace(placeholderRegex, (match, keyPath) => {
    const value = getByPath(context, keyPath);
    if (value !== undefined && value !== null && value !== '') {
      if (typeof value === 'object') {
        return JSON.stringify(value);
      }
      return String(value);
    }

    if (!missingKeys.includes(keyPath)) {
      missingKeys.push(keyPath);
      warnings.push(`Unresolved placeholder: "${keyPath}" has no value in context.json`);
    }
    return `[MISSING: ${keyPath}]`;
  });

  // Extract optional step metadata and resolve model capability alias
  const targetFiles = Array.isArray(step.targetFiles) ? step.targetFiles : [];
  const rawAI = typeof step.recommendedAI === 'string' ? step.recommendedAI : '';
  const recommendedAI = rawAI ? resolveModel(rawAI) : '';

  // Immutable architectural contract anchoring (#109): pin every recorded
  // decision at the top of the prompt so later steps cannot drift to
  // substitute libraries. The block only appears when decisions exist.
  const architecturalContract = buildArchitecturalContract(context);
  const anchoredPrompt = architecturalContract ? `${architecturalContract}\n\n${resolvedPrompt}` : resolvedPrompt;

  return {
    resolvedPrompt: anchoredPrompt.trim(),
    warnings,
    missingKeys,
    targetFiles,
    recommendedAI,
    architecturalContract
  };
}

module.exports = {
  loadTemplates,
  loadCustomTemplate,
  loadRemoteTemplate,
  getTemplate,
  resolveStepPrompt,
  buildArchitecturalContract
};
