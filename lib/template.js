/**
 * Template authoring: scaffolding (`template new`) and strict linting
 * (`template lint`) for workflow template JSON files.
 *
 * Scaffolding produces a boilerplate template that passes the linter. The
 * linter layers authoring checks on top of the existing schema and
 * dependency validation in lib/validator.js (validateTemplate): template and
 * step ids must be kebab-case (the naming convention every shipped template
 * uses), step numbers must not repeat, and the metadata and per-step fields
 * authors are expected to fill in must be present. It deliberately does not
 * enforce `stepCount` (several shipped templates omit it; the loader
 * recomputes it) or kebab-case decision keys (shipped templates use
 * camelCase keys such as decisions.frontendStack; placeholder dependency
 * resolution is covered by validateTemplate instead).
 */

const fs = require('fs');
const path = require('path');
const { validateTemplate } = require('./validator');

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const STEP_NUMBER = /^step-(\d+)-/;

function isKebabCase(value) {
  return typeof value === 'string' && KEBAB_CASE.test(value);
}

/**
 * Turns a kebab-case template name into a display title.
 * @param {string} name
 * @returns {string}
 */
function titleFromName(name) {
  return name
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Builds a boilerplate template object: required metadata, a three-step
 * example workflow (Discovery, Requirements, Tech Stack) whose prompts use
 * only project placeholders and decisions written by earlier steps, and
 * phase definitions on every step.
 * @param {string} name Kebab-case template name.
 * @returns {object} Template object that passes lintTemplateData.
 */
function buildTemplateScaffold(name) {
  if (!isKebabCase(name)) {
    throw new Error(`Template name "${name}" must be kebab-case (lowercase letters, digits, and hyphens).`);
  }
  const title = titleFromName(name);
  return {
    id: name,
    type: name,
    title,
    description: `A workflow template for ${title.toLowerCase()}. Replace the example steps with your own.`,
    stepCount: 3,
    steps: [
      {
        id: 'step-01-discovery',
        phase: 'Discovery',
        title: 'Problem Discovery & Core Value Proposition',
        goal: 'Clarify the target user, the pain point, and the core outcome the product achieves.',
        requires: ['project.name', 'project.idea', 'project.experienceLevel'],
        writes: ['decisions.targetAudience', 'decisions.coreValueProp'],
        expectedOutput: 'A concise problem statement, primary user persona, and clear unique value proposition.',
        recommendedAI: 'Claude 3.5 Sonnet / GPT-4o',
        targetFiles: [],
        prompt:
          'I am building a project called "{{project.name}}".\nThe concept is: {{project.idea}}.\nMy experience level is {{project.experienceLevel}}.\n\nHelp me define the target audience and the core value proposition:\n1. Define the primary target audience and user persona.\n2. Summarize the core pain point this user faces today.\n3. Formulate a crisp 2-sentence value proposition.'
      },
      {
        id: 'step-02-mvp-scope',
        phase: 'Requirements',
        title: 'MVP Feature Scoping & Non-Goals',
        goal: 'Separate essential must-have features from nice-to-have items to keep the initial scope focused.',
        requires: ['decisions.coreValueProp', 'project.name'],
        writes: ['decisions.mvpFeatures', 'decisions.nonGoals'],
        expectedOutput: 'A prioritized list of 3-5 core MVP user stories and an explicit list of non-goals.',
        recommendedAI: 'Claude 3.5 Sonnet / GPT-4o',
        targetFiles: [],
        prompt:
          'Based on our core value proposition:\n"{{decisions.coreValueProp}}"\n\nHelp me define the minimum viable product (MVP) scope for "{{project.name}}":\n1. List exactly 3 to 5 non-negotiable MVP features.\n2. List 3 to 5 features that are tempting but should explicitly be NON-GOALS for V1.'
      },
      {
        id: 'step-03-tech-stack',
        phase: 'Tech Stack',
        title: 'Technology Stack Selection',
        goal: 'Choose maintainable technologies tailored to the developer experience level.',
        requires: ['decisions.mvpFeatures', 'project.experienceLevel'],
        writes: ['decisions.frontendStack', 'decisions.backendStack', 'decisions.database'],
        expectedOutput: 'Selected frontend framework, backend framework/runtime, database, and hosting targets.',
        recommendedAI: 'Claude 3.5 Sonnet / GPT-4o',
        targetFiles: [],
        prompt:
          'Our MVP features are:\n{{decisions.mvpFeatures}}\n\nRecommend a technology stack for "{{project.name}}" (experience level: {{project.experienceLevel}}):\n1. Frontend framework and styling solution.\n2. Backend framework/runtime.\n3. Database and hosting targets.'
      }
    ]
  };
}

/**
 * Writes the scaffold for `name` to `<name>.json` in cwd. Refuses to
 * overwrite an existing file.
 * @param {string} name Kebab-case template name.
 * @param {string} [cwd=process.cwd()]
 * @returns {{ filePath: string, template: object }}
 */
function scaffoldTemplateFile(name, cwd = process.cwd()) {
  const template = buildTemplateScaffold(name);
  const filePath = path.join(cwd, `${name}.json`);
  if (fs.existsSync(filePath)) {
    throw new Error(`Template file already exists: ${filePath}. Pick a different name or remove it first.`);
  }
  fs.writeFileSync(filePath, `${JSON.stringify(template, null, 2)}\n`, 'utf8');
  return { filePath, template };
}

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

function stepLine(text, stepId) {
  if (typeof stepId !== 'string') return 1;
  const encoded = JSON.stringify(stepId);
  const match = new RegExp(`"id"\\s*:\\s*${encoded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).exec(text);
  return match ? lineAt(text, match.index) : 1;
}

/**
 * Strict authoring checks on a parsed template object: the existing schema
 * and dependency validation, plus kebab-case ids, duplicate step numbers,
 * and required metadata / per-step fields.
 * @param {object} data Parsed template JSON.
 * @returns {{ valid: boolean, errors: string[] }}
 */
function lintTemplateData(data) {
  const errors = [];
  const validation = validateTemplate(data);
  errors.push(...validation.errors);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { valid: false, errors };
  }

  // Effective id: `id` wins, `type` is the loader fallback (several shipped
  // templates carry only `type`).
  const effectiveId = typeof data.id === 'string' && data.id.trim() ? data.id : data.type;
  if (typeof effectiveId !== 'string' || !isKebabCase(effectiveId)) {
    errors.push('Template id must be kebab-case (lowercase letters, digits, and hyphens).');
  }
  if (typeof data.type !== 'string' || !data.type.trim()) {
    errors.push('Template missing required string field: "type"');
  }
  if (typeof data.description !== 'string' || !data.description.trim()) {
    errors.push('Template missing required string field: "description"');
  }

  if (Array.isArray(data.steps)) {
    const seenNumbers = new Map();
    data.steps.forEach((step, index) => {
      if (!step || typeof step !== 'object') return;
      const label = `Step "${step.id || index}"`;
      if (typeof step.id !== 'string' || !isKebabCase(step.id)) {
        errors.push(`${label} id must be kebab-case (lowercase letters, digits, and hyphens).`);
      }
      const numberMatch = typeof step.id === 'string' ? STEP_NUMBER.exec(step.id) : null;
      if (numberMatch) {
        const number = numberMatch[1];
        if (seenNumbers.has(number)) {
          errors.push(`Duplicate step number ${number}: steps "${seenNumbers.get(number)}" and "${step.id}" share it.`);
        } else {
          seenNumbers.set(number, step.id);
        }
      }
      if (typeof step.title !== 'string' || !step.title.trim()) {
        errors.push(`${label} missing required string field: "title"`);
      }
      if (typeof step.phase !== 'string' || !step.phase.trim()) {
        errors.push(`${label} missing required string field: "phase"`);
      }
      if (typeof step.goal !== 'string' || !step.goal.trim()) {
        errors.push(`${label} missing required string field: "goal"`);
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Lints a template JSON file, reporting errors as `file:line: message`.
 * @param {string} filePath
 * @param {string} [cwd=process.cwd()]
 * @returns {{ valid: boolean, errors: string[] }}
 */
function lintTemplateFile(filePath, cwd = process.cwd()) {
  const resolved = path.resolve(cwd, filePath);
  let text;
  try {
    text = fs.readFileSync(resolved, 'utf8');
  } catch (error) {
    return { valid: false, errors: [`${resolved}:line 1: Cannot read file: ${error.message}`] };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return {
      valid: false,
      errors: [`${resolved}:line ${jsonErrorLine(text, error)}: Invalid JSON: ${error.message}`]
    };
  }
  const { valid, errors } = lintTemplateData(data);
  const located = errors.map((message) => {
    const stepMatch = /Step "([^"]+)"/.exec(message);
    const line = stepMatch ? stepLine(text, stepMatch[1]) : 1;
    return `${resolved}:line ${line}: ${message}`;
  });
  return { valid, errors: located };
}

module.exports = {
  buildTemplateScaffold,
  scaffoldTemplateFile,
  lintTemplateData,
  lintTemplateFile,
  isKebabCase
};
