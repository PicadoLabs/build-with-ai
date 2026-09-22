const path = require('path');
const inquirer = require('inquirer');
const pc = require('picocolors');
const { loadTemplates, getTemplate, loadCustomTemplate, loadRemoteTemplate } = require('./promptEngine');
const { isInitialized, initState } = require('./state');
const logger = require('./logger');

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
    const { confirmOverwrite } = await inquirer.prompt([
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

  // If we are overwriting (either via --force or confirmation), clean up the old state
  if (isInitialized(cwd)) {
    const { resetProject } = require('./state');
    resetProject(cwd);
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
        return;
      }
      logger.success(`Loaded remote template: "${customTemplate.title}" (${customTemplate.stepCount} steps)`);
    } else {
      customTemplate = loadCustomTemplate(tplArg);
      if (!customTemplate) {
        logger.error(`Custom template file not found or invalid JSON: ${tplArg}`);
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
    const answers = await inquirer.prompt([
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
        validate: (input) => input.trim().length > 0 ? true : 'Project name cannot be empty.'
      },
      {
        type: 'input',
        name: 'projectIdea',
        message: 'One-line project idea / problem description:',
        default: 'A minimal application that solves a real user problem.',
        validate: (input) => input.trim().length > 0 ? true : 'Project idea cannot be empty.'
      }
    ]);

    const totalSteps = selectedTemplate.stepCount;
    initState({
      projectName: answers.projectName.trim(),
      templateId: selectedTemplateId,
      templateTitle: selectedTemplate.title,
      experienceLevel: answers.experienceLevel,
      projectIdea: answers.projectIdea.trim(),
      totalSteps
    }, cwd);

    console.log();
    logger.success(pc.bold(`Initialized "${answers.projectName}" with custom template successfully!`));
    console.log(pc.dim(`Created .buildwithai/ directory (state.json, context.json, history/)`));
    console.log();
    console.log(pc.cyan('Next step: Run ') + pc.bold(pc.green('npx build-with-ai next')) + pc.cyan(' to generate your first prompt.'));
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

  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'templateId',
      message: 'Select project type / template:',
      choices: templates.map(t => ({
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
      validate: (input) => input.trim().length > 0 ? true : 'Project name cannot be empty.'
    },
    {
      type: 'input',
      name: 'projectIdea',
      message: 'One-line project idea / problem description:',
      default: 'A minimal web application that solves a real user problem.',
      validate: (input) => input.trim().length > 0 ? true : 'Project idea cannot be empty.'
    }
  ]);

  selectedTemplate = getTemplate(answers.templateId);
  const totalSteps = selectedTemplate ? selectedTemplate.stepCount : 0;

  initState({
    projectName: answers.projectName.trim(),
    templateId: answers.templateId,
    templateTitle: selectedTemplate ? selectedTemplate.title : answers.templateId,
    experienceLevel: answers.experienceLevel,
    projectIdea: answers.projectIdea.trim(),
    totalSteps
  }, cwd);

  console.log();
  logger.success(pc.bold(`Initialized "${answers.projectName}" successfully!`));
  console.log(pc.dim(`Created .buildwithai/ directory (state.json, context.json, history/)`));
  console.log();
  console.log(pc.cyan('Next step: Run ') + pc.bold(pc.green('npx build-with-ai next')) + pc.cyan(' to generate your first prompt.'));
  console.log();
}

module.exports = {
  runInit
};
