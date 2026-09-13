const fs = require('fs');
const path = require('path');
const pc = require('picocolors');
const { loadState, loadContext, getAllHistory, isInitialized, getStorageDir } = require('./state');
const { getTemplate } = require('./promptEngine');
const { formatContextAsMarkdown } = require('./contextBuilder');
const logger = require('./logger');

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
  if (d.authStrategy) {
    lines.push(`- **Authentication:** ${d.authStrategy}`);
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

  lines.push('## Getting Started');
  lines.push('### Prerequisites');
  lines.push('- Node.js (>= 18)');
  lines.push('- npm / pnpm / yarn');
  lines.push('');
  lines.push('### Installation & Setup');
  lines.push('```bash');
  lines.push('# Clone repository');
  lines.push(`git clone <repo-url>`);
  lines.push(`cd ${state.projectName || 'project'}`);
  lines.push('');
  lines.push('# Install dependencies');
  lines.push('npm install');
  lines.push('');
  lines.push('# Setup environment');
  lines.push('cp .env.example .env');
  lines.push('');
  lines.push('# Run development server');
  lines.push('npm run dev');
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
  lines.push(`- **Completed Steps:** ${state.completedSteps ? state.completedSteps.length : 0} of ${state.totalSteps || 0}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  if (historyItems.length === 0) {
    lines.push('_No step responses recorded in history yet._');
    return lines.join('\n');
  }

  const stepsMap = (template && template.steps) ? new Map(template.steps.map((s, idx) => [idx + 1, s])) : new Map();

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

/**
 * Runs the export process and generates README.md, BUILD_LOG.md, and .buildwithai/CONTEXT.md.
 * @param {string} [cwd=process.cwd()]
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] - If true, report the files that would be written without writing them.
 */
function runExport(cwd = process.cwd(), options = {}) {
  const { dryRun = false } = options;

  if (!isInitialized(cwd)) {
    logger.error('No active project found to export. Run `npx build-with-ai init` first.');
    return;
  }

  const state = loadState(cwd);
  const context = loadContext(cwd);
  const historyItems = getAllHistory(cwd);
  const template = getTemplate(state.templateId);

  // Compute target paths up front — used for both dry-run reporting and real writes.
  const readmePath = path.join(cwd, 'README.md');
  const buildLogPath = path.join(cwd, 'BUILD_LOG.md');
  const contextMdPath = path.join(getStorageDir(cwd), 'CONTEXT.md');

  if (dryRun) {
    console.log();
    console.log(pc.bold(pc.cyan('Dry run — the following files would be generated:')));
    console.log(`  ${pc.dim('•')} ${path.relative(cwd, readmePath)}`);
    console.log(`  ${pc.dim('•')} ${path.relative(cwd, buildLogPath)}`);
    console.log(`  ${pc.dim('•')} ${path.relative(cwd, contextMdPath)}`);
    console.log();
    console.log(pc.dim('No files were created or changed.'));
    console.log();
    return;
  }

  // 1. Export README.md
  const readmeContent = generateReadme(state, context);
  fs.writeFileSync(readmePath, readmeContent, 'utf8');

  // 2. Export BUILD_LOG.md
  const buildLogContent = generateBuildLog(state, context, historyItems, template);
  fs.writeFileSync(buildLogPath, buildLogContent, 'utf8');

  // 3. Export .buildwithai/CONTEXT.md
  const contextMdContent = formatContextAsMarkdown(context, state);
  fs.writeFileSync(contextMdPath, contextMdContent, 'utf8');

  console.log();
  logger.success('Documentation exported successfully!');
  console.log();
  console.log(`  ${pc.green('✔')} ${pc.bold('README.md')} (Project summary & setup guide)`);
  console.log(`  ${pc.green('✔')} ${pc.bold('BUILD_LOG.md')} (Full step-by-step history log)`);
  console.log(`  ${pc.green('✔')} ${pc.bold('.buildwithai/CONTEXT.md')} (Decisions markdown view)`);
  console.log();
}

module.exports = {
  runExport,
  generateReadme,
  generateBuildLog
};

