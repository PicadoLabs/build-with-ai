const pc = require('picocolors');
const { loadState, loadContext, isInitialized } = require('./state');
const { getTemplate } = require('./promptEngine');
const { renderProgressBar, displayKeyValueTable } = require('./ui');
const logger = require('./logger');

/**
 * Displays a welcome back / resume dashboard.
 * @param {string} [cwd=process.cwd()]
 */
function runResume(cwd = process.cwd()) {
  if (!isInitialized(cwd)) {
    logger.warn('No active project found in this directory.');
    console.log(pc.cyan('Run ') + pc.bold(pc.green('npx build-with-ai init')) + pc.cyan(' to get started!'));
    return;
  }

  const state = loadState(cwd);
  if (!state) {
    logger.error('Failed to load project state. The state.json file may be missing or corrupted.');
    process.exit(1);
  }
  
  const context = loadContext(cwd);
  const template = getTemplate(state.templateId);

  const totalSteps = template ? template.stepCount : state.totalSteps || 0;
  const currentStepNum = state.currentStep || 1;
  const completedCount = Array.isArray(state.completedSteps) ? state.completedSteps.length : 0;

  let currentStepTitle = 'Workflow Completed!';
  let currentStepPhase = 'Done';
  let currentStepGoal = 'All template steps have been completed.';

  if (template && template.steps && currentStepNum <= totalSteps) {
    const stepObj = template.steps[currentStepNum - 1];
    if (stepObj) {
      currentStepTitle = stepObj.title;
      currentStepPhase = stepObj.phase || 'General';
      currentStepGoal = stepObj.goal;
    }
  }

  console.log();
  console.log(pc.bold(pc.bgCyan(pc.black(` WELCOME BACK: ${state.projectName || 'Project'} `))));
  console.log();
  console.log(`${pc.bold('Template:')} ${state.templateTitle || state.templateId || 'Unknown'} (${state.experienceLevel || 'Beginner'})`);
  console.log(`${pc.bold('Progress:')} ${renderProgressBar(completedCount, totalSteps)}`);
  console.log();

  console.log(pc.bold(pc.yellow('CURRENT FOCUS:')));
  if (currentStepNum <= totalSteps) {
    console.log(`  ${pc.bold(`Step ${currentStepNum}/${totalSteps}:`)} ${pc.cyan(currentStepTitle)} ${pc.dim(`[Phase: ${currentStepPhase}]`)}`);
    console.log(`  ${pc.dim('Goal:')} ${currentStepGoal}`);
  } else {
    console.log(`  ${pc.green('✔ All steps completed! You can run ')}${pc.bold('npx build-with-ai export')}${pc.green(' to generate project documentation.')}`);
  }

  // Key decisions summary
  const decisions = context.decisions || {};
  const decisionEntries = Object.entries(decisions);
  if (decisionEntries.length > 0) {
    console.log();
    console.log(pc.bold(pc.magenta('KEY RECORDED DECISIONS:')));
    for (const [k, v] of decisionEntries.slice(0, 8)) {
      const label = k.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
      const valStr = typeof v === 'object' ? JSON.stringify(v) : String(v);
      const truncated = valStr.length > 80 ? valStr.substring(0, 77) + '...' : valStr;
      console.log(`  ${pc.dim('•')} ${pc.bold(label)}: ${truncated}`);
    }
    if (decisionEntries.length > 8) {
      console.log(`  ${pc.dim(`... and ${decisionEntries.length - 8} more decisions recorded.`)}`);
    }
  }

  console.log();
  if (currentStepNum <= totalSteps) {
    console.log(pc.cyan('Continue building: Run ') + pc.bold(pc.green('npx build-with-ai next')) + pc.cyan(' to generate the current prompt.'));
  } else {
    console.log(pc.cyan('Project complete: Run ') + pc.bold(pc.green('npx build-with-ai export')) + pc.cyan(' to create documentation.'));
  }
  console.log();
}

module.exports = {
  runResume
};

