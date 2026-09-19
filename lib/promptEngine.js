const fs = require('fs');
const path = require('path');
const { getByPath } = require('./contextBuilder');

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
  const files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json'));
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
      // Ignore malformed templates
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
    const id = path.basename(resolved, '.json');
    return {
      id,
      type: data.type || id,
      title: data.title || id,
      description: data.description || '',
      stepCount: Array.isArray(data.steps) ? data.steps.length : 0,
      steps: data.steps || []
    };
  } catch {
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
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const id = url.split('/').pop().replace('.json', '') || 'custom';
          finish({
            id,
            type: parsed.type || id,
            title: parsed.title || id,
            description: parsed.description || '',
            stepCount: Array.isArray(parsed.steps) ? parsed.steps.length : 0,
            steps: parsed.steps || []
          });
        } catch {
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
  return templates.find(t => t.id === templateId || t.type === templateId) || null;
}

/**
 * Resolves prompt placeholders, checks `requires` dependencies, and exposes
 * optional targetFiles and recommendedAI from the step definition.
 *
 * @param {object} step
 * @param {object} context
 * @returns {{ resolvedPrompt, warnings, missingKeys, targetFiles, recommendedAI }}
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

  // Regex to match {{key.path}} or {{ key.path }}
  const placeholderRegex = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
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

  // Extract optional step metadata
  const targetFiles = Array.isArray(step.targetFiles) ? step.targetFiles : [];
  const recommendedAI = typeof step.recommendedAI === 'string' ? step.recommendedAI : '';

  return {
    resolvedPrompt: resolvedPrompt.trim(),
    warnings,
    missingKeys,
    targetFiles,
    recommendedAI
  };
}

module.exports = {
  loadTemplates,
  loadCustomTemplate,
  loadRemoteTemplate,
  getTemplate,
  resolveStepPrompt
};
