const { isInitialized, loadState, loadContext, getAllHistory, isBranchScopedEnabled } = require('./state');
const { getTemplate } = require('./promptEngine');
const { flattenObject } = require('./contextBuilder');
const { buildStatusSummary } = require('./status');

const DEFAULT_PHASE = 'General';

/**
 * Classifies a step as completed, current or pending.
 * @param {number} stepNum
 * @param {object} summary Output of buildStatusSummary().
 * @returns {'completed'|'current'|'pending'}
 */
function stepStatus(stepNum, summary) {
  if (summary.completedSteps.includes(stepNum)) return 'completed';
  if (stepNum === summary.currentStep) return 'current';
  return 'pending';
}

/**
 * Groups template steps by phase, preserving the template's step order.
 * @param {object|null} template
 * @param {object} summary Output of buildStatusSummary().
 * @returns {Array<{ name: string, completedCount: number, total: number, steps: object[] }>}
 */
function buildPhaseTree(template, summary) {
  if (!template || !Array.isArray(template.steps)) return [];

  const phases = [];
  const byName = new Map();
  template.steps.forEach((step, idx) => {
    const number = idx + 1;
    const name = step.phase || DEFAULT_PHASE;
    let phase = byName.get(name);
    if (!phase) {
      phase = { name, completedCount: 0, total: 0, steps: [] };
      byName.set(name, phase);
      phases.push(phase);
    }
    const status = stepStatus(number, summary);
    phase.total += 1;
    if (status === 'completed') phase.completedCount += 1;
    phase.steps.push({
      number,
      id: step.id || `step-${number}`,
      title: step.title || `Step ${number}`,
      goal: step.goal || '',
      status
    });
  });
  return phases;
}

/**
 * Maps each `decisions.*` key a step declares in `writes` to that step, so
 * the decision explorer can show and filter by where a decision came from.
 * @param {object|null} template
 * @returns {Map<string, { step: number, phase: string }>}
 */
function buildDecisionSources(template) {
  const sources = new Map();
  if (!template || !Array.isArray(template.steps)) return sources;
  template.steps.forEach((step, idx) => {
    for (const key of Array.isArray(step.writes) ? step.writes : []) {
      if (typeof key !== 'string' || !key.startsWith('decisions.')) continue;
      const decisionKey = key.slice('decisions.'.length);
      if (!sources.has(decisionKey)) sources.set(decisionKey, { step: idx + 1, phase: step.phase || DEFAULT_PHASE });
    }
  });
  return sources;
}

/**
 * Flattens recorded decisions into rows for the decision explorer. Nested
 * keys inherit the source of their top-level decision.
 * @param {object} decisions
 * @param {object|null} template
 * @returns {Array<{ key: string, value: any, step: number|null, phase: string|null }>}
 */
function buildDecisionRows(decisions, template) {
  const sources = buildDecisionSources(template);
  return Object.entries(flattenObject(decisions || {})).map(([key, value]) => {
    const source = sources.get(key) || sources.get(key.split('.')[0]) || null;
    return { key, value, step: source ? source.step : null, phase: source ? source.phase : null };
  });
}

/**
 * Collects everything the dashboard renders from the active project.
 * @param {string} [cwd=process.cwd()]
 * @returns {object|null} Null when no valid project exists in cwd.
 */
function buildDashboardData(cwd = process.cwd()) {
  if (!isInitialized(cwd)) return null;
  const state = loadState(cwd);
  if (!state) return null;

  const context = loadContext(cwd);
  const template = getTemplate(state.templateId, cwd);
  const summary = buildStatusSummary(state, context, template);
  const stepTitles = template && Array.isArray(template.steps) ? template.steps.map((s) => s.title) : [];

  return {
    generatedAt: new Date().toISOString(),
    branchScoped: isBranchScopedEnabled(),
    status: summary,
    phases: buildPhaseTree(template, summary),
    decisions: buildDecisionRows(summary.decisions, template),
    history: getAllHistory(cwd).map((item) => ({
      step: item.step,
      title: stepTitles[item.step - 1] || `Step ${item.step}`,
      filename: item.filename,
      modifiedAt: item.modifiedAt,
      content: item.content
    }))
  };
}

module.exports = {
  buildPhaseTree,
  buildDecisionRows,
  buildDashboardData
};
