const { countUniqueCompletedSteps } = require('./ui');

/**
 * Builds the machine-readable project status shared by `status --json` and
 * the local dashboard, so both report identical progress numbers.
 * @param {object} state Parsed state.json.
 * @param {object} context Parsed context.json.
 * @param {object|null} template Resolved template, when available.
 * @returns {object}
 */
function buildStatusSummary(state, context = {}, template = null) {
  const totalSteps = template && Array.isArray(template.steps) ? template.steps.length : state.totalSteps || 0;
  const completedCount = countUniqueCompletedSteps(state.completedSteps, totalSteps);

  return {
    projectName: state.projectName,
    templateId: state.templateId,
    templateTitle: state.templateTitle || state.templateId,
    experienceLevel: state.experienceLevel,
    projectIdea: state.projectIdea,
    startedAt: state.startedAt || null,
    updatedAt: state.updatedAt || null,
    currentStep: state.currentStep || 1,
    totalSteps,
    completedSteps: state.completedSteps || [],
    completedCount,
    progressPercent: totalSteps > 0 ? Math.round((completedCount / totalSteps) * 100) : 0,
    exportReady: totalSteps > 0 && completedCount === totalSteps,
    decisions: context.decisions || {}
  };
}

module.exports = { buildStatusSummary };
