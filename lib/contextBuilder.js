const UNSAFE_PATH_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

/**
 * Splits a dot-notation path into keys. Returns null when any key could reach
 * the object prototype chain, so callers can refuse the whole path.
 * @param {string} path
 * @returns {string[]|null}
 */
function parsePath(path) {
  const keys = path.trim().split('.');
  return keys.some((key) => UNSAFE_PATH_KEYS.has(key)) ? null : keys;
}

/**
 * Gets a nested value from an object using dot notation.
 * Paths containing `__proto__`, `prototype` or `constructor` return undefined.
 * @param {object} obj
 * @param {string} path
 * @returns {any}
 */
function getByPath(obj, path) {
  if (!obj || !path) return undefined;
  const keys = parsePath(path);
  if (!keys) return undefined;
  let current = obj;
  for (const key of keys) {
    if (current === undefined || current === null) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

/**
 * Sets a nested value on an object using dot notation.
 * Paths containing `__proto__`, `prototype` or `constructor` are ignored and leave obj unchanged.
 * @param {object} obj
 * @param {string} path
 * @param {any} value
 * @returns {boolean} Whether the value was stored; false when the path was rejected or empty
 */
function setByPath(obj, path, value) {
  if (!obj || !path) return false;
  const keys = parsePath(path);
  if (!keys) return false;
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] === undefined || current[key] === null || typeof current[key] !== 'object') {
      current[key] = {};
    }
    current = current[key];
  }
  current[keys[keys.length - 1]] = value;
  return true;
}

/**
 * Recursively flattens an object to dot-notation key-value pairs.
 * @param {object} obj
 * @param {string} prefix
 * @returns {Record<string, any>}
 */
function flattenObject(obj, prefix = '') {
  const result = {};
  if (!obj || typeof obj !== 'object') return result;

  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(result, flattenObject(value, newKey));
    } else {
      result[newKey] = value;
    }
  }
  return result;
}

/**
 * Formats context into Markdown for CONTEXT.md
 * @param {object} context
 * @param {object} state
 * @returns {string}
 */
function formatContextAsMarkdown(context, state = {}) {
  const lines = [];
  lines.push('# Project Context & Architecture Decisions');
  lines.push('');
  lines.push(`> Automatically generated from \`.buildwithai/context.json\` on ${new Date().toISOString()}`);
  lines.push('');

  if (state.projectName) {
    lines.push(`- **Project Name:** ${state.projectName}`);
  }
  if (state.templateTitle) {
    lines.push(`- **Template:** ${state.templateTitle} (${state.templateId || 'custom'})`);
  }
  if (state.experienceLevel) {
    lines.push(`- **Experience Level:** ${state.experienceLevel}`);
  }
  if (state.projectIdea) {
    lines.push(`- **Project Idea:** ${state.projectIdea}`);
  }
  lines.push('');

  const sections = Object.keys(context || {});
  if (sections.length === 0) {
    lines.push('_No decisions recorded yet._');
    return lines.join('\n');
  }

  for (const section of sections) {
    const title = section.charAt(0).toUpperCase() + section.slice(1);
    lines.push(`## ${title}`);
    lines.push('');
    const val = context[section];
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      for (const [k, v] of Object.entries(val)) {
        const itemLabel = k.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => str.toUpperCase());
        if (typeof v === 'object') {
          lines.push(`### ${itemLabel}`);
          lines.push('```json');
          lines.push(JSON.stringify(v, null, 2));
          lines.push('```');
        } else {
          lines.push(`- **${itemLabel}:** ${v}`);
        }
      }
    } else {
      lines.push(`${val}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim() + '\n';
}

module.exports = {
  getByPath,
  setByPath,
  flattenObject,
  formatContextAsMarkdown
};
