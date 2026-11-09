const fs = require('fs');
const path = require('path');
const pc = require('picocolors');
const { loadState, loadContext, getAllHistory, isInitialized, getStorageDir } = require('./state');
const { getTemplate } = require('./promptEngine');
const { formatContextAsMarkdown } = require('./contextBuilder');
const { safePrompt } = require('./ui');
const logger = require('./logger');

/**
 * Setup instructions per project runtime, so the exported README matches the
 * stack instead of always assuming Node.js (issue #196). Detection order:
 * explicit template id/title first, then the recorded backend, framework,
 * runtime and frontend decision strings.
 */
const SETUP_INSTRUCTIONS = {
  node: {
    prerequisites: ['Node.js (>= 18)', 'npm / pnpm / yarn'],
    steps: [
      '# Install dependencies',
      'npm install',
      '',
      '# Setup environment',
      'cp .env.example .env',
      '',
      '# Run development server',
      'npm run dev'
    ]
  },
  python: {
    prerequisites: ['Python (>= 3.10)', 'pip'],
    steps: [
      '# Create and activate a virtual environment',
      'python -m venv venv',
      'source venv/bin/activate',
      '',
      '# Install dependencies',
      'pip install -r requirements.txt',
      '',
      '# Setup environment',
      'cp .env.example .env',
      '',
      '# Run development server',
      'uvicorn main:app --reload'
    ]
  },
  flutter: {
    prerequisites: ['Flutter SDK', 'Dart SDK (bundled with Flutter)'],
    steps: ['# Install dependencies', 'flutter pub get', '', '# Run the app', 'flutter run']
  }
};

/**
 * Detects the project runtime for setup instructions.
 * @param {object} state
 * @param {object} context
 * @returns {'node' | 'python' | 'flutter'}
 */
function detectSetupRuntime(state, context) {
  const d = (context && context.decisions) || {};
  const haystack = [
    state && state.templateId,
    state && state.templateTitle,
    d.backendStack,
    d.framework,
    d.runtime,
    d.frontendStack
  ]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  if (/\bflutter\b|\bdart\b/.test(haystack)) return 'flutter';
  if (haystack.includes('fastapi') || haystack.includes('python')) return 'python';
  return 'node';
}

/**
 * Generates README.md content deterministically from state and context.
 * @param {object} state
 * @param {object} context
 * @returns {string}
 */
function generateReadme(state, context) {
  const p = context.project || {};
  const d = context.decisions || {};

  const lines = [];
  lines.push(`# ${state.projectName || p.name || 'My Project'}`);
  lines.push('');
  lines.push(`> ${p.idea || state.projectIdea || 'Built with AI guided workflows.'}`);
  lines.push('');

  if (d.coreValueProp) {
    lines.push('## Overview');
    lines.push(d.coreValueProp);
    lines.push('');
  }

  if (d.mvpFeatures) {
    lines.push('## Key Features');
    if (typeof d.mvpFeatures === 'string') {
      lines.push(d.mvpFeatures);
    } else if (Array.isArray(d.mvpFeatures)) {
      for (const item of d.mvpFeatures) {
        lines.push(`- ${item}`);
      }
    }
    lines.push('');
  }

  lines.push('## Tech Stack');
  lines.push(`- **Frontend:** ${d.frontendStack || d.framework || 'Standard Web Stack'}`);
  lines.push(`- **Backend:** ${d.backendStack || d.runtime || 'Node.js'}`);
  lines.push(`- **Database:** ${d.database || 'Relational / Document DB'}`);
  // Templates write auth under different keys (authProvider,
  // authImplementation, authModule); fall back through them so the tech
  // stack summary never drops the authentication decision (#195).
  const auth = d.authStrategy || d.authProvider || d.authImplementation || d.authModule || d.auth;
  if (auth) {
    lines.push(`- **Authentication:** ${auth}`);
  }
  if (d.deploymentPlatform) {
    lines.push(`- **Hosting:** ${d.deploymentPlatform}`);
  }
  lines.push('');

  if (d.apiEndpoints) {
    lines.push('## API Endpoints');
    lines.push(typeof d.apiEndpoints === 'string' ? d.apiEndpoints : JSON.stringify(d.apiEndpoints, null, 2));
    lines.push('');
  }

  const setup = SETUP_INSTRUCTIONS[detectSetupRuntime(state, context)];
  lines.push('## Getting Started');
  lines.push('### Prerequisites');
  for (const prereq of setup.prerequisites) {
    lines.push(`- ${prereq}`);
  }
  lines.push('');
  lines.push('### Installation & Setup');
  lines.push('```bash');
  lines.push('# Clone repository');
  lines.push(`git clone <repo-url>`);
  lines.push(`cd ${state.projectName || 'project'}`);
  lines.push('');
  for (const step of setup.steps) {
    lines.push(step);
  }
  lines.push('```');
  lines.push('');

  if (d.portfolioPitch) {
    lines.push('## Portfolio & Architecture Highlights');
    lines.push(d.portfolioPitch);
    lines.push('');
  }

  lines.push('---');
  lines.push('Guided and documented using [build-with-ai](https://github.com/PicadoLabs/build-with-ai).');
  lines.push('');

  return lines.join('\n');
}

/**
 * Generates BUILD_LOG.md content from history, state, and context.
 * @param {object} state
 * @param {object} context
 * @param {Array<{ step: number, filename: string, content: string }>} historyItems
 * @param {object} template
 * @returns {string}
 */
function generateBuildLog(state, context, historyItems, template) {
  const lines = [];
  lines.push(`# Build Log: ${state.projectName || 'Project'}`);
  lines.push('');
  lines.push(`- **Template:** ${state.templateTitle || state.templateId || 'Unknown'}`);
  lines.push(`- **Started At:** ${state.startedAt || 'N/A'}`);
  lines.push(`- **Exported At:** ${new Date().toISOString()}`);
  lines.push(
    `- **Completed Steps:** ${state.completedSteps ? state.completedSteps.length : 0} of ${state.totalSteps || 0}`
  );
  lines.push('');
  lines.push('---');
  lines.push('');

  if (historyItems.length === 0) {
    lines.push('_No step responses recorded in history yet._');
    return lines.join('\n');
  }

  const stepsMap = template && template.steps ? new Map(template.steps.map((s, idx) => [idx + 1, s])) : new Map();

  for (const item of historyItems) {
    const stepInfo = stepsMap.get(item.step);
    const title = stepInfo ? `${stepInfo.title} (${stepInfo.phase || 'General'})` : `Step ${item.step}`;
    lines.push(`## Step ${item.step}: ${title}`);
    if (stepInfo && stepInfo.goal) {
      lines.push(`> **Goal:** ${stepInfo.goal}`);
      lines.push('');
    }
    lines.push('### Saved Output / Notes:');
    lines.push(item.content.trim());
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

function recordedValueLines(value) {
  if (value === undefined || value === null || value === '') return ['_Not recorded yet._'];
  if (Array.isArray(value)) {
    return value.length > 0
      ? value.map((item) => `- ${typeof item === 'string' ? item : JSON.stringify(item)}`)
      : ['_Not recorded yet._'];
  }
  if (typeof value === 'object') return ['```json', JSON.stringify(value, null, 2), '```'];
  return [String(value)];
}

/**
 * Creates a structural project overview from recorded decisions only.
 * Missing architectural details are explicitly identified rather than invented.
 */
function generateArchitecture(state, context) {
  const p = context.project || {};
  const d = context.decisions || {};
  const lines = [
    `# Architecture: ${state.projectName || p.name || 'My Project'}`,
    '',
    '_Generated from `.buildwithai/context.json` by build-with-ai._',
    '',
    '## Overview',
    ...recordedValueLines(p.idea || state.projectIdea),
    '',
    '## Technology stack',
    `- **Frontend:** ${d.frontendStack || d.framework || 'Not recorded yet'}`,
    `- **Backend:** ${d.backendStack || d.runtime || 'Not recorded yet'}`,
    `- **Database:** ${d.database || 'Not recorded yet'}`,
    '',
    '## Components and service boundaries',
    ...recordedValueLines(d.serviceBoundaries || d.services || d.systemArchitecture || d.architecture),
    '',
    '## Data models',
    ...recordedValueLines(d.dataModels || d.databaseModels || d.databaseSchema || d.schema),
    ''
  ];

  if (d.apiEndpoints || d.integrations) {
    lines.push('## APIs and integrations');
    lines.push(...recordedValueLines(d.apiEndpoints || d.integrations));
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Creates agent-facing project guidance without guessing commands or style rules.
 */
function generateAgentInstructions(state, context) {
  const p = context.project || {};
  const d = context.decisions || {};
  const lines = [
    `# Agent instructions: ${state.projectName || p.name || 'My Project'}`,
    '',
    '_Generated from `.buildwithai/context.json` by build-with-ai._',
    '',
    '## Project overview',
    ...recordedValueLines(p.idea || state.projectIdea),
    '',
    '## Testing commands'
  ];

  const commands = [
    ['Test', d.testCommands || d.testCommand || d.testingCommands],
    ['Lint', d.lintCommand],
    ['Build', d.buildCommand]
  ];
  let hasCommands = false;
  for (const [label, value] of commands) {
    if (value === undefined || value === null || value === '') continue;
    hasCommands = true;
    lines.push(`### ${label}`);
    lines.push(...recordedValueLines(value));
    lines.push('');
  }
  if (!hasCommands) {
    lines.push('_No commands recorded. Check the project scripts or CI configuration before testing._');
    lines.push('');
  }

  lines.push('## Coding and style rules');
  lines.push(...recordedValueLines(d.codingStyle || d.styleGuide || d.codeStyle || d.stylingRules));
  lines.push('');
  lines.push('## Restricted paths');
  lines.push('- Do not modify `.buildwithai/.env`, credential files, or `.git/`.');
  const restricted = d.disallowedPaths || d.restrictedPaths || d.doNotEdit;
  if (restricted !== undefined && restricted !== null && restricted !== '') {
    lines.push(...recordedValueLines(restricted));
  }
  lines.push('');
  lines.push('## Working guidelines');
  lines.push('- Follow the existing project conventions and verify changes before committing.');
  lines.push('- Preserve user-authored files unless explicitly instructed to replace them.');
  lines.push('');
  return lines.join('\n');
}

function targetExists(targetPath) {
  try {
    fs.lstatSync(targetPath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function writeGeneratedFile(targetPath, content, force) {
  if (!force && targetExists(targetPath)) {
    logger.warn(`${path.basename(targetPath)} already exists; preserving it (use --force to overwrite).`);
    return false;
  }
  fs.writeFileSync(targetPath, content, 'utf8');
  return true;
}

function availableReadmeFallback(outputDir) {
  const firstChoice = path.join(outputDir, 'README.ai.md');
  if (!fs.existsSync(firstChoice)) return firstChoice;

  let suffix = 2;
  let candidate = path.join(outputDir, `README.ai-${suffix}.md`);
  while (fs.existsSync(candidate)) {
    suffix += 1;
    candidate = path.join(outputDir, `README.ai-${suffix}.md`);
  }
  return candidate;
}

async function resolveReadmePath(outputDir, options = {}) {
  const readmePath = path.join(outputDir, 'README.md');
  if (options.force || !fs.existsSync(readmePath)) return readmePath;

  const fallbackPath = availableReadmeFallback(outputDir);
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY);
  if (!interactive) {
    logger.warn(`README.md already exists; writing ${path.basename(fallbackPath)} instead.`);
    return fallbackPath;
  }

  const { action } = await (options.prompt || safePrompt)([
    {
      type: 'list',
      name: 'action',
      message: 'README.md already exists. What should export do?',
      choices: [
        { name: 'Overwrite README.md', value: 'overwrite' },
        { name: `Save as ${path.basename(fallbackPath)}`, value: 'fallback' },
        { name: 'Cancel', value: 'cancel' }
      ]
    }
  ]);

  if (action === 'cancel') {
    logger.info('Export cancelled; existing README.md was preserved.');
    return null;
  }
  return action === 'fallback' ? fallbackPath : readmePath;
}

/**
 * Runs the export process and generates README.md, BUILD_LOG.md, CONTEXT.md,
 * ARCHITECTURE.md, and AGENTS.md.
 * CONTEXT.md lives in the project root storage directory (`.buildwithai/CONTEXT.md`)
 * unless a custom `outDir` is given, in which case it is written directly into
 * the output directory so no redundant `.buildwithai` directory is created (#149).
 * @param {string} [cwd=process.cwd()]
 * @param {object} [options={}]
 * @param {boolean} [options.dryRun=false] - If true, report the files that would be written without writing them.
 * @param {string} [options.outDir] Output directory, resolved relative to cwd.
 * @returns {Promise<false|string[]|undefined>} Paths written on success, false when the project state
 *   cannot be loaded, undefined for a dry run or a cancelled export.
 */
async function runExport(cwd = process.cwd(), options = {}) {
  const { dryRun = false } = options;

  if (!isInitialized(cwd)) {
    logger.error('No active project found to export. Run `npx build-with-ai init` first.');
    return;
  }

  const state = loadState(cwd);
  if (!state) {
    logger.error(
      'Cannot export documentation without valid project state. Restore .buildwithai/state.json from a backup.'
    );
    return false;
  }
  const context = loadContext(cwd);
  const historyItems = getAllHistory(cwd);
  const template = getTemplate(state.templateId, cwd);
  const outputDir = path.resolve(cwd, options.outDir || '.');

  // Compute target paths up front — used for both dry-run reporting and real writes.
  const readmePath = path.join(outputDir, 'README.md');
  const buildLogPath = path.join(outputDir, 'BUILD_LOG.md');
  const architecturePath = path.join(outputDir, 'ARCHITECTURE.md');
  const agentsPath = path.join(outputDir, 'AGENTS.md');
  // A custom outDir is an export artifact directory, not a project root: keep
  // the project state clean by writing CONTEXT.md directly into it instead of
  // creating a redundant `<outDir>/.buildwithai` directory (#149).
  const customOutDir = Boolean(options.outDir);
  const contextMdPath = customOutDir
    ? path.join(outputDir, 'CONTEXT.md')
    : path.join(getStorageDir(outputDir), 'CONTEXT.md');

  if (dryRun) {
    const previewReadmePath =
      !options.force && fs.existsSync(readmePath) ? availableReadmeFallback(outputDir) : readmePath;
    console.log();
    console.log(pc.bold(pc.cyan('Dry run — the following files would be generated:')));
    console.log(`  ${pc.dim('•')} ${path.relative(cwd, previewReadmePath)}`);
    console.log(`  ${pc.dim('•')} ${path.relative(cwd, buildLogPath)}`);
    console.log(`  ${pc.dim('•')} ${path.relative(cwd, contextMdPath)}`);
    for (const target of [architecturePath, agentsPath]) {
      const note = !options.force && targetExists(target) ? ' (exists; will be preserved)' : '';
      console.log(`  ${pc.dim('•')} ${path.relative(cwd, target)}${note}`);
    }
    console.log();
    console.log(pc.dim('No files were created or changed.'));
    console.log();
    return;
  }

  fs.mkdirSync(path.dirname(contextMdPath), { recursive: true });

  // 1. Export README.md, or a safe fallback when it already exists.
  const targetReadmePath = await resolveReadmePath(outputDir, options);
  if (!targetReadmePath) return;
  const readmeContent = generateReadme(state, context);
  fs.writeFileSync(targetReadmePath, readmeContent, 'utf8');

  // 2. Export BUILD_LOG.md
  const buildLogContent = generateBuildLog(state, context, historyItems, template);
  fs.writeFileSync(buildLogPath, buildLogContent, 'utf8');

  // 3. Export CONTEXT.md (into .buildwithai/ for project-root exports,
  // directly into the custom output directory otherwise)
  const contextMdContent = formatContextAsMarkdown(context, state);
  fs.writeFileSync(contextMdPath, contextMdContent, 'utf8');

  // 4. Export agent and architecture guidance only when absent or explicitly forced.
  const written = [targetReadmePath, buildLogPath, contextMdPath];
  if (writeGeneratedFile(architecturePath, generateArchitecture(state, context), options.force)) {
    written.push(architecturePath);
  }
  if (writeGeneratedFile(agentsPath, generateAgentInstructions(state, context), options.force)) {
    written.push(agentsPath);
  }

  console.log();
  logger.success('Documentation exported successfully!');
  console.log();
  console.log(`  ${pc.green('✔')} ${pc.bold(path.basename(targetReadmePath))} (Project summary & setup guide)`);
  console.log(`  ${pc.green('✔')} ${pc.bold('BUILD_LOG.md')} (Full step-by-step history log)`);
  console.log(
    `  ${pc.green('✔')} ${pc.bold(customOutDir ? 'CONTEXT.md' : '.buildwithai/CONTEXT.md')} (Decisions markdown view)`
  );
  if (written.includes(architecturePath)) console.log('  ARCHITECTURE.md (Architecture and data model overview)');
  if (written.includes(agentsPath)) console.log('  AGENTS.md (Agent build and editing guidance)');
  console.log();
  return written;
}

module.exports = {
  runExport,
  generateReadme,
  generateBuildLog,
  generateArchitecture,
  generateAgentInstructions,
  availableReadmeFallback,
  resolveReadmePath
};
