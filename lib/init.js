const fs = require('fs');
const path = require('path');
const pc = require('picocolors');
const { loadTemplates, getTemplate, loadCustomTemplate, loadRemoteTemplate } = require('./promptEngine');
const { isInitialized, initState, resetProject } = require('./state');
const logger = require('./logger');
const { safePrompt } = require('./ui');

const EXPERIENCE_LEVELS = ['Beginner', 'Intermediate', 'Experienced'];
const DEFAULT_TEMPLATE_ID = 'web-app';
const DEFAULT_EXPERIENCE_LEVEL = 'Intermediate';
const DEFAULT_PROJECT_IDEA = 'A minimal web application that solves a real user problem';

/**
 * Normalizes an experience level to its canonical label.
 * Comparison is case-insensitive so `beginner` and `BEGINNER` both work.
 *
 * @param {unknown} value
 * @returns {'Beginner'|'Intermediate'|'Experienced'|null} canonical label or null
 */
function normalizeExperienceLevel(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return EXPERIENCE_LEVELS.find((level) => level.toLowerCase() === trimmed.toLowerCase()) || null;
}
/**
 * Classifies a --template value without loading it.
 * Remote URLs are checked first so they cannot be mistaken for paths.
 * A value is treated as a file when it exists, contains a path separator,
 * starts with a dot, or ends in .json.
 *
 * @param {unknown} value
 * @param {string} [cwd=process.cwd()] base directory for the existence check
 * @returns {'remote'|'file'|'id'|null} the value kind, or null when unusable
 */
function classifyTemplateArgument(value, cwd = process.cwd()) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return 'remote';
  if (
    fs.existsSync(path.resolve(cwd, trimmed)) ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.startsWith('.') ||
    /\.json$/i.test(trimmed)
  ) {
    return 'file';
  }
  return 'id';
}

/**
 * Finds a built-in template by id or type.
 * Unlike getTemplate(), this never consults the workspace template, so
 * re-initialization cannot silently pick up a stale .buildwithai copy.
 *
 * @param {unknown} templateId
 * @param {Array<object>} templates
 * @returns {object|null}
 */
function findBuiltinTemplate(templateId, templates) {
  if (typeof templateId !== 'string') return null;
  const trimmed = templateId.trim();
  if (!trimmed) return null;
  return (templates || []).find((template) => template.id === trimmed || template.type === trimmed) || null;
}

/**
 * Builds the error shown when --template does not match a built-in ID.
 *
 * @param {unknown} templateId
 * @param {Array<object>} templates
 * @returns {string}
 */
function formatUnknownTemplateError(templateId, templates) {
  const available = (templates || []).map((template) => template.id).join(', ');
  return `Unknown template "${String(templateId)}". Available templates: ${available || 'none'}.`;
}

/**
 * Validates and trims the initialization values that do not depend on a
 * template. Level matching is case-insensitive and returns a canonical label.
 *
 * @param {object} [inputs]
 * @param {unknown} [inputs.projectName]
 * @param {unknown} [inputs.projectIdea]
 * @param {unknown} [inputs.experienceLevel]
 * @returns {{ valid: boolean, errors: string[], values: object }}
 */
function validateInitInputs({ projectName, projectIdea, experienceLevel } = {}) {
  const errors = [];
  const name = typeof projectName === 'string' ? projectName.trim() : '';
  const idea = typeof projectIdea === 'string' ? projectIdea.trim() : '';
  const level = normalizeExperienceLevel(experienceLevel);

  if (!name) {
    errors.push('Project name cannot be empty. Pass --name "<name>".');
  }
  if (!idea) {
    errors.push('Project idea cannot be empty. Pass --idea "<idea>".');
  }
  if (!level) {
    const received = typeof experienceLevel === 'string' ? experienceLevel.trim() : '';
    errors.push(
      received
        ? `Invalid experience level "${received}". Use Beginner, Intermediate, or Experienced.`
        : 'Experience level is required. Use Beginner, Intermediate, or Experienced.'
    );
  }

  return {
    valid: errors.length === 0,
    errors,
    values: {
      projectName: name,
      projectIdea: idea,
      experienceLevel: level
    }
  };
}

/**
 * Runs the interactive project initialization wizard.
 * @param {object} [options]
 * @param {boolean} [options.force]
 * @param {string} [options.template] - Local path or remote URL to a custom template JSON
 * @param {string} [cwd=process.cwd()]
 */
async function runInit(options = {}, cwd = process.cwd()) {
  if (isInitialized(cwd) && !options.force) {
    logger.warn('Project is already initialized in this directory (.buildwithai exists).');
    const { confirmOverwrite } = await safePrompt([
      {
        type: 'confirm',
        name: 'confirmOverwrite',
        message: 'Do you want to re-initialize and reset the current workflow?',
        default: false
      }
    ]);
    if (!confirmOverwrite) {
      logger.info('Initialization cancelled.');
      return;
    }
  }

  // Handle custom template loading
  let customTemplate = null;
  if (options.template) {
    const tplArg = options.template;
    if (tplArg.startsWith('http://') || tplArg.startsWith('https://')) {
      console.log(pc.dim(`Fetching custom template from: ${tplArg} ...`));
      customTemplate = await loadRemoteTemplate(tplArg);
      if (!customTemplate) {
        logger.error('Failed to load remote template. Check the URL and try again.');
        process.exitCode = 1;
        return;
      }
      logger.success(`Loaded remote template: "${customTemplate.title}" (${customTemplate.stepCount} steps)`);
    } else {
      customTemplate = loadCustomTemplate(tplArg);
      if (!customTemplate) {
        logger.error(`Custom template file not found or invalid JSON: ${tplArg}`);
        process.exitCode = 1;
        return;
      }
      logger.success(`Loaded local template: "${customTemplate.title}" (${customTemplate.stepCount} steps)`);
    }
  }

  let selectedTemplate;
  let selectedTemplateId;

  if (customTemplate) {
    // Custom template is pre-selected — skip the selection list
    selectedTemplate = customTemplate;
    selectedTemplateId = customTemplate.id;

    const defaultProjectName = path.basename(cwd) || 'my-project';
    const answers = await safePrompt([
      {
        type: 'list',
        name: 'experienceLevel',
        message: 'What is your coding experience level?',
        choices: [
          { name: 'Beginner (New to coding, want detailed step-by-step guidance)', value: 'Beginner' },
          { name: 'Intermediate (Familiar with programming concepts, need structure)', value: 'Intermediate' },
          { name: 'Experienced (Looking for rapid architecture and validation prompts)', value: 'Experienced' }
        ]
      },
      {
        type: 'input',
        name: 'projectName',
        message: 'Project name:',
        default: defaultProjectName,
        validate: (input) => (input.trim().length > 0 ? true : 'Project name cannot be empty.')
      },
      {
        type: 'input',
        name: 'projectIdea',
        message: 'One-line project idea / problem description:',
        default: 'A minimal application that solves a real user problem.',
        validate: (input) => (input.trim().length > 0 ? true : 'Project idea cannot be empty.')
      }
    ]);

    const totalSteps = selectedTemplate.stepCount;
    // Discard the old state only now that the new one is ready to write.
    if (isInitialized(cwd)) {
      resetProject(cwd);
    }
    initState(
      {
        projectName: answers.projectName.trim(),
        templateId: selectedTemplateId,
        templateTitle: selectedTemplate.title,
        experienceLevel: answers.experienceLevel,
        projectIdea: answers.projectIdea.trim(),
        totalSteps,
        // Persist the custom template in the workspace so later commands
        // (next, done, status, ...) can resolve it without the original
        // file or URL (#133).
        customTemplate: customTemplate
      },
      cwd
    );

    console.log();
    logger.success(pc.bold(`Initialized "${answers.projectName}" with custom template successfully!`));
    console.log(pc.dim(`Created .buildwithai/ directory (state.json, context.json, template.json, history/)`));
    console.log();
    console.log(
      pc.cyan('Next step: Run ') +
        pc.bold(pc.green('npx build-with-ai next')) +
        pc.cyan(' to generate your first prompt.')
    );
    console.log();
    return;
  }

  // Built-in template selection
  const templates = loadTemplates();
  if (templates.length === 0) {
    logger.error('No project templates found in templates directory.');
    return;
  }

  const defaultProjectName = path.basename(cwd) || 'my-project';

  const answers = await safePrompt([
    {
      type: 'list',
      name: 'templateId',
      message: 'Select project type / template:',
      choices: templates.map((t) => ({
        name: `${t.title} (${t.stepCount} steps) - ${pc.dim(t.description)}`,
        value: t.id
      }))
    },
    {
      type: 'list',
      name: 'experienceLevel',
      message: 'What is your coding experience level?',
      choices: [
        { name: 'Beginner (New to coding, want detailed step-by-step guidance)', value: 'Beginner' },
        { name: 'Intermediate (Familiar with programming concepts, need structure)', value: 'Intermediate' },
        { name: 'Experienced (Looking for rapid architecture and validation prompts)', value: 'Experienced' }
      ]
    },
    {
      type: 'input',
      name: 'projectName',
      message: 'Project name:',
      default: defaultProjectName,
      validate: (input) => (input.trim().length > 0 ? true : 'Project name cannot be empty.')
    },
    {
      type: 'input',
      name: 'projectIdea',
      message: 'One-line project idea / problem description:',
      default: 'A minimal web application that solves a real user problem.',
      validate: (input) => (input.trim().length > 0 ? true : 'Project idea cannot be empty.')
    }
  ]);

  selectedTemplate = getTemplate(answers.templateId);
  const totalSteps = selectedTemplate ? selectedTemplate.stepCount : 0;

  // Discard the old state only now that the new one is ready to write.
  if (isInitialized(cwd)) {
    resetProject(cwd);
  }
  initState(
    {
      projectName: answers.projectName.trim(),
      templateId: answers.templateId,
      templateTitle: selectedTemplate ? selectedTemplate.title : answers.templateId,
      experienceLevel: answers.experienceLevel,
      projectIdea: answers.projectIdea.trim(),
      totalSteps
    },
    cwd
  );

  console.log();
  logger.success(pc.bold(`Initialized "${answers.projectName}" successfully!`));
  console.log(pc.dim(`Created .buildwithai/ directory (state.json, context.json, history/)`));
  console.log();
  console.log(
    pc.cyan('Next step: Run ') +
      pc.bold(pc.green('npx build-with-ai next')) +
      pc.cyan(' to generate your first prompt.')
  );
  console.log();
}

module.exports = {
  runInit,
  EXPERIENCE_LEVELS,
  DEFAULT_TEMPLATE_ID,
  DEFAULT_EXPERIENCE_LEVEL,
  DEFAULT_PROJECT_IDEA,
  normalizeExperienceLevel,
  classifyTemplateArgument,
  findBuiltinTemplate,
  formatUnknownTemplateError,
  validateInitInputs
};
