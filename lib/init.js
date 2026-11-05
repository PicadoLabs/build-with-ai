const fs = require('fs');
const path = require('path');
const pc = require('picocolors');
const { loadTemplates, loadCustomTemplate, loadRemoteTemplate } = require('./promptEngine');
const { isInitialized, initState, resetProject } = require('./state');
const logger = require('./logger');
const { safePrompt } = require('./ui');

const EXPERIENCE_LEVELS = ['Beginner', 'Intermediate', 'Experienced'];
const DEFAULT_TEMPLATE_ID = 'web-app';
const DEFAULT_EXPERIENCE_LEVEL = 'Intermediate';
const DEFAULT_PROJECT_IDEA = 'A minimal web application that solves a real user problem.';

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
 * Resolves a --template value for initialization.
 * Precedence: remote URL, then path-like local file, then built-in ID.
 *
 * @param {string|undefined} templateArg
 * @param {Array<object>} templates
 * @returns {Promise<{ template: object|null, customTemplate: object|null, templateId: string|null, error: string|null }>}
 */
async function resolveTemplateForInit(templateArg, templates) {
  if (templateArg === undefined) {
    const template = findBuiltinTemplate(DEFAULT_TEMPLATE_ID, templates);
    if (!template) {
      return {
        template: null,
        customTemplate: null,
        templateId: null,
        error: formatUnknownTemplateError(DEFAULT_TEMPLATE_ID, templates)
      };
    }
    return { template, customTemplate: null, templateId: template.id, error: null };
  }

  if (typeof templateArg !== 'string' || !templateArg.trim()) {
    return {
      template: null,
      customTemplate: null,
      templateId: null,
      error: 'Template value cannot be empty. Pass a built-in template ID, a local JSON path, or an HTTPS URL.'
    };
  }

  const kind = classifyTemplateArgument(templateArg);

  if (kind === 'remote') {
    console.log(pc.dim(`Fetching custom template from: ${templateArg} ...`));
    const customTemplate = await loadRemoteTemplate(templateArg);
    if (!customTemplate) {
      return {
        template: null,
        customTemplate: null,
        templateId: null,
        error: 'Failed to load remote template. Check the URL and try again.'
      };
    }
    logger.success(`Loaded remote template: "${customTemplate.title}" (${customTemplate.stepCount} steps)`);
    return { template: customTemplate, customTemplate, templateId: customTemplate.id, error: null };
  }

  if (kind === 'file') {
    const customTemplate = loadCustomTemplate(templateArg);
    if (!customTemplate) {
      return {
        template: null,
        customTemplate: null,
        templateId: null,
        error: `Custom template file not found or invalid JSON: ${templateArg}`
      };
    }
    logger.success(`Loaded local template: "${customTemplate.title}" (${customTemplate.stepCount} steps)`);
    return { template: customTemplate, customTemplate, templateId: customTemplate.id, error: null };
  }

  const template = findBuiltinTemplate(templateArg, templates);
  if (!template) {
    return {
      template: null,
      customTemplate: null,
      templateId: null,
      error: formatUnknownTemplateError(templateArg, templates)
    };
  }
  logger.success(`Using built-in template: "${template.title}" (${template.stepCount} steps)`);
  return { template, customTemplate: null, templateId: template.id, error: null };
}

/**
 * Initializes a project without prompting.
 * Missing values fall back to documented defaults only when --yes is set.
 * Explicitly supplied empty values still fail validation.
 *
 * @param {object} options
 * @param {string} cwd
 * @param {Array<object>} templates
 * @returns {Promise<void>}
 */
async function runNonInteractiveInit(options, cwd, templates) {
  const resolved = await resolveTemplateForInit(options.template, templates);
  if (resolved.error) {
    logger.error(resolved.error);
    process.exitCode = 1;
    return;
  }

  const missing = [];
  if (options.template === undefined) missing.push('--template');
  if (options.name === undefined) missing.push('--name');
  if (options.level === undefined) missing.push('--level');
  if (options.idea === undefined) missing.push('--idea');

  if (!options.yes && missing.length > 0) {
    logger.error(
      `Non-interactive init is missing required values: ${missing.join(', ')}. ` +
        'Provide them explicitly or pass --yes to use the defaults.'
    );
    process.exitCode = 1;
    return;
  }

  const projectName = options.name === undefined ? path.basename(cwd) || 'my-project' : options.name;
  const projectIdea = options.idea === undefined ? DEFAULT_PROJECT_IDEA : options.idea;
  const experienceLevel = options.level === undefined ? DEFAULT_EXPERIENCE_LEVEL : options.level;

  const validation = validateInitInputs({ projectName, projectIdea, experienceLevel });
  if (!validation.valid) {
    for (const error of validation.errors) {
      logger.error(error);
    }
    process.exitCode = 1;
    return;
  }

  const { projectName: name, projectIdea: idea, experienceLevel: level } = validation.values;
  const { template, customTemplate, templateId } = resolved;

  if (isInitialized(cwd)) {
    resetProject(cwd);
  }
  initState(
    {
      projectName: name,
      templateId,
      templateTitle: template.title,
      experienceLevel: level,
      projectIdea: idea,
      totalSteps: template.stepCount,
      customTemplate: customTemplate || undefined
    },
    cwd
  );

  console.log();
  logger.success(pc.bold(`Initialized "${name}" ${customTemplate ? 'with custom template ' : ''}successfully!`));
  console.log(
    pc.dim(
      customTemplate
        ? 'Created .buildwithai/ directory (state.json, context.json, template.json, history/)'
        : 'Created .buildwithai/ directory (state.json, context.json, history/)'
    )
  );
  console.log();
  console.log(
    pc.cyan('Next step: Run ') +
      pc.bold(pc.green('npx build-with-ai next')) +
      pc.cyan(' to generate your first prompt.')
  );
  console.log();
}

/**
 * Runs the project initialization flow.
 * Prompts interactively unless --yes, a complete flag set, or the CLI's
 * non-interactive terminal hint tells it to resolve everything from options.
 *
 * @param {object} [options]
 * @param {boolean} [options.force]
 * @param {string} [options.template] - Built-in template ID, local JSON path, or HTTPS URL
 * @param {boolean} [options.yes] - Never prompt; use defaults for missing values
 * @param {string} [options.name] - Project name
 * @param {string} [options.level] - Beginner, Intermediate, or Experienced
 * @param {string} [options.idea] - One-line project idea
 * @param {boolean} [options.nonInteractive] - Internal CLI hint for a non-TTY stdin
 * @param {string} [cwd=process.cwd()]
 */
async function runInit(options = {}, cwd = process.cwd()) {
  const templates = loadTemplates();

  const hasAnyValue =
    options.template !== undefined ||
    options.name !== undefined ||
    options.level !== undefined ||
    options.idea !== undefined;
  const hasAllValues =
    options.template !== undefined &&
    options.name !== undefined &&
    options.level !== undefined &&
    options.idea !== undefined;
  const nonInteractive = Boolean(options.yes) || hasAllValues || (Boolean(options.nonInteractive) && hasAnyValue);
  const providedLevel = normalizeExperienceLevel(options.level);

  if (!nonInteractive && options.level !== undefined && !providedLevel) {
    logger.error(`Invalid experience level "${options.level}". Use Beginner, Intermediate, or Experienced.`);
    process.exitCode = 1;
    return;
  }

  if (isInitialized(cwd) && !options.force) {
    if (nonInteractive) {
      logger.error(
        'Project is already initialized in this directory. Pass --force to re-initialize non-interactively.'
      );
      process.exitCode = 1;
      return;
    }
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

  if (nonInteractive) {
    await runNonInteractiveInit(options, cwd, templates);
    return;
  }

  // Resolve an explicitly supplied template for the interactive wizard.
  let customTemplate = null;
  let preselectedTemplate = null;
  if (options.template !== undefined) {
    const resolved = await resolveTemplateForInit(options.template, templates);
    if (resolved.error) {
      logger.error(resolved.error);
      process.exitCode = 1;
      return;
    }
    customTemplate = resolved.customTemplate;
    preselectedTemplate = resolved.template;
  }

  let selectedTemplate;
  let selectedTemplateId;

  if (customTemplate) {
    // Custom template is pre-selected - skip the selection list
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
        ],
        ...(providedLevel ? { default: providedLevel } : {})
      },
      {
        type: 'input',
        name: 'projectName',
        message: 'Project name:',
        default: options.name !== undefined ? options.name : defaultProjectName,
        validate: (input) => (input.trim().length > 0 ? true : 'Project name cannot be empty.')
      },
      {
        type: 'input',
        name: 'projectIdea',
        message: 'One-line project idea / problem description:',
        default: options.idea !== undefined ? options.idea : 'A minimal application that solves a real user problem.',
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
  if (templates.length === 0) {
    logger.error('No project templates found in templates directory.');
    return;
  }

  const defaultProjectName = path.basename(cwd) || 'my-project';
  const questions = [];

  if (!preselectedTemplate) {
    questions.push({
      type: 'list',
      name: 'templateId',
      message: 'Select project type / template:',
      choices: templates.map((t) => ({
        name: `${t.title} (${t.stepCount} steps) - ${pc.dim(t.description)}`,
        value: t.id
      }))
    });
  }

  questions.push(
    {
      type: 'list',
      name: 'experienceLevel',
      message: 'What is your coding experience level?',
      choices: [
        { name: 'Beginner (New to coding, want detailed step-by-step guidance)', value: 'Beginner' },
        { name: 'Intermediate (Familiar with programming concepts, need structure)', value: 'Intermediate' },
        { name: 'Experienced (Looking for rapid architecture and validation prompts)', value: 'Experienced' }
      ],
      ...(providedLevel ? { default: providedLevel } : {})
    },
    {
      type: 'input',
      name: 'projectName',
      message: 'Project name:',
      default: options.name !== undefined ? options.name : defaultProjectName,
      validate: (input) => (input.trim().length > 0 ? true : 'Project name cannot be empty.')
    },
    {
      type: 'input',
      name: 'projectIdea',
      message: 'One-line project idea / problem description:',
      default: options.idea !== undefined ? options.idea : DEFAULT_PROJECT_IDEA,
      validate: (input) => (input.trim().length > 0 ? true : 'Project idea cannot be empty.')
    }
  );

  const answers = await safePrompt(questions);

  selectedTemplate = preselectedTemplate || findBuiltinTemplate(answers.templateId, templates);
  if (!selectedTemplate) {
    logger.error(formatUnknownTemplateError(answers.templateId, templates));
    process.exitCode = 1;
    return;
  }
  selectedTemplateId = selectedTemplate.id;
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
