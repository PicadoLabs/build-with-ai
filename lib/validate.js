const fs = require('fs');
const path = require('path');
const { getStorageDir, STATE_FILE, CONTEXT_FILE, TEMPLATE_FILE } = require('./state');
const { getTemplate } = require('./promptEngine');
const { validateTemplate } = require('./validator');
const { flattenObject } = require('./contextBuilder');

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function lineAt(text, position) {
  return text.slice(0, position).split('\n').length;
}

function jsonErrorLine(text, error) {
  const match = /position (\d+)/.exec(error.message);
  if (match) return lineAt(text, Number(match[1]));
  const location = /line (\d+) column \d+/.exec(error.message);
  if (location) return Number(location[1]);
  return /end of JSON/i.test(error.message) ? lineAt(text, text.length) : 1;
}

function readJson(file, errors) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    errors.push(`${file}:line 1: Cannot read file: ${error.message}`);
    return null;
  }

  try {
    return { data: JSON.parse(text), text };
  } catch (error) {
    errors.push(`${file}:line ${jsonErrorLine(text, error)}: Invalid JSON: ${error.message}`);
    return null;
  }
}

function stepLine(text, step) {
  if (!step || typeof step.id !== 'string') return 1;
  const encoded = JSON.stringify(step.id);
  const match = new RegExp(`"id"\\s*:\\s*${encoded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).exec(text);
  return match ? lineAt(text, match.index) : 1;
}

function templateErrorLine(text, template, message) {
  const steps = template && Array.isArray(template.steps) ? template.steps : [];
  const namedStep = /Step "([^"]+)"/.exec(message);
  if (namedStep) {
    return stepLine(
      text,
      steps.find((step) => step && step.id === namedStep[1])
    );
  }
  const indexedStep = /Step at index (\d+)/.exec(message);
  if (indexedStep) return stepLine(text, steps[Number(indexedStep[1])]);
  return 1;
}

function isMissing(value) {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

function recordedValue(context, key) {
  let value = context;
  for (const segment of key.split('.')) {
    if (!segment || UNSAFE_KEYS.has(segment) || !value || typeof value !== 'object' || !Object.hasOwn(value, segment)) {
      return undefined;
    }
    value = value[segment];
  }
  return value;
}

/**
 * Validates an optional template file and the current project without changing its state.
 * @param {{ template?: string }} options
 * @param {string} cwd
 * @returns {boolean} Whether validation succeeded
 */
function runValidate(options = {}, cwd = process.cwd()) {
  const errors = [];
  const storage = getStorageDir(cwd);
  const statePath = path.join(storage, STATE_FILE);
  const contextPath = path.join(storage, CONTEXT_FILE);
  const workspaceTemplatePath = path.join(storage, TEMPLATE_FILE);
  const hasState = fs.existsSync(statePath);

  if (!hasState && !options.template) {
    errors.push('No project found in this directory. Run `npx build-with-ai init` first, or use `--template <path>`.');
  }

  const stateRecord = hasState ? readJson(statePath, errors) : null;
  const contextRecord = hasState ? readJson(contextPath, errors) : null;
  const state = stateRecord && stateRecord.data;
  const context = contextRecord && contextRecord.data;

  if (stateRecord && (!state || typeof state !== 'object' || Array.isArray(state))) {
    errors.push(`${statePath}:line 1: Project state must be an object.`);
  }
  if (contextRecord && (!context || typeof context !== 'object' || Array.isArray(context))) {
    errors.push(`${contextPath}:line 1: Project context must be an object.`);
  }

  let templateRecord = null;
  let templatePath = null;
  if (options.template) {
    templatePath = path.resolve(cwd, options.template);
    templateRecord = readJson(templatePath, errors);
  } else if (hasState && fs.existsSync(workspaceTemplatePath)) {
    templatePath = workspaceTemplatePath;
    templateRecord = readJson(templatePath, errors);
  } else if (state && typeof state.templateId === 'string') {
    const template = getTemplate(state.templateId, cwd);
    if (template) {
      templatePath = `template "${state.templateId}"`;
      templateRecord = { data: template, text: '' };
    } else {
      errors.push(`${statePath}:line 1: Cannot resolve template "${state.templateId}".`);
    }
  }

  if (hasState && state && (!state.templateId || typeof state.templateId !== 'string')) {
    errors.push(`${statePath}:line 1: Missing templateId.`);
  }

  const template = templateRecord && templateRecord.data;
  if (templateRecord) {
    const validation = validateTemplate(template);
    for (const message of validation.errors) {
      errors.push(`${templatePath}:line ${templateErrorLine(templateRecord.text, template, message)}: ${message}`);
    }
  }

  if (hasState && state && template && Array.isArray(template.steps)) {
    const current = state.currentStep;
    if (!Number.isInteger(current) || current < 1 || current > template.steps.length + 1) {
      errors.push(`${statePath}:line 1: currentStep must be between 1 and ${template.steps.length + 1}.`);
    } else if (context && typeof context === 'object' && !Array.isArray(context)) {
      for (let i = 0; i < Math.min(current, template.steps.length); i++) {
        const step = template.steps[i];
        if (!step || !Array.isArray(step.requires)) continue;
        for (const key of step.requires) {
          if (typeof key === 'string' && isMissing(recordedValue(context, key))) {
            errors.push(`${contextPath}:line 1: Step ${i + 1} ("${step.id}") requires missing context key "${key}".`);
          }
        }
      }
    }
  }

  if (context && template && Array.isArray(template.steps) && context.decisions) {
    const declared = new Set(template.steps.flatMap((step) => (step && Array.isArray(step.writes) ? step.writes : [])));
    const customKeys = Object.keys(flattenObject(context.decisions)).filter((key) => {
      const fullKey = `decisions.${key}`;
      return ![...declared].some(
        (written) => written === fullKey || fullKey.startsWith(`${written}.`) || written.startsWith(`${fullKey}.`)
      );
    });
    if (customKeys.length > 0) {
      console.log(`Info: ${customKeys.length} custom decision(s) recorded outside template writes.`);
    }
  }

  if (errors.length > 0) {
    console.error('Validation failed:');
    for (const error of errors) console.error(`  ${error}`);
    return false;
  }

  console.log('Validation passed.');
  return true;
}

module.exports = { runValidate };
