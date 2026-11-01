/**
 * Shared handling of a model's reply to a step prompt, used by `next --run`
 * and the MCP `execute_step_sampled` tool: parse file blocks and decisions,
 * write files safely, record decisions, save history and advance the step.
 */

const { saveState, saveContext, saveHistory } = require('./state');
const { setByPath } = require('./contextBuilder');
const { parseFileBlocks, parseDecisionsBlock, resolveTargetPath, writeFileBlocks } = require('./aiClient');

/**
 * Parses a step response without touching the filesystem.
 * @param {string} cwd Project directory.
 * @param {string} response Model reply text.
 * @param {string[]} [targetFiles] Declared target files for the step.
 * @returns {{
 *   blocks: Array<{path: string, content: string}>,
 *   applicable: Array<{block: {path: string, content: string}, absolute: string}>,
 *   unsafe: string[],
 *   decisions: Record<string, unknown>,
 *   decisionsError: string|null
 * }}
 */
function planStepResponse(cwd, response, targetFiles) {
  const blocks = parseFileBlocks(response, targetFiles);
  const applicable = [];
  const unsafe = [];
  for (const block of blocks) {
    const absolute = resolveTargetPath(cwd, block.path);
    if (absolute) {
      applicable.push({ block, absolute });
    } else {
      unsafe.push(block.path);
    }
  }

  let decisions = {};
  let decisionsError = null;
  try {
    decisions = parseDecisionsBlock(response);
  } catch (err) {
    decisionsError = err.message;
  }

  return { blocks, applicable, unsafe, decisions, decisionsError };
}

/**
 * Applies a planned step response: writes files (unless `writeFiles` is
 * false), records decisions into context.json, saves the response to
 * history/step-XX.md and advances state.json past `stepNum`.
 * @param {object} params
 * @param {string} params.cwd
 * @param {object} params.state Loaded state.json; mutated and saved.
 * @param {object} params.context Loaded context.json; mutated and saved when decisions are recorded.
 * @param {number} params.stepNum Step being completed.
 * @param {string} params.response Model reply text, saved to history.
 * @param {ReturnType<typeof planStepResponse>} params.plan
 * @param {boolean} [params.writeFiles=true] False discards file blocks (e.g. rejected in review).
 * @returns {{
 *   files: Array<{path: string, created: boolean}>,
 *   recorded: string[],
 *   historyPath: string,
 *   nextStep: number
 * }}
 */
function applyStepResponse({ cwd, state, context, stepNum, response, plan, writeFiles = true }) {
  const files = [];
  if (writeFiles && plan.applicable.length > 0) {
    for (const result of writeFileBlocks(
      cwd,
      plan.applicable.map((entry) => entry.block)
    )) {
      if (result.written) files.push({ path: result.path, created: result.created });
    }
  }

  const recorded = [];
  for (const [key, value] of Object.entries(plan.decisions)) {
    if (typeof key === 'string' && key.trim() && setByPath(context, key, value)) {
      recorded.push(key);
    }
  }
  if (recorded.length > 0) {
    saveContext(context, cwd);
  }

  const historyPath = saveHistory(stepNum, response, cwd);
  if (!Array.isArray(state.completedSteps)) state.completedSteps = [];
  if (!state.completedSteps.includes(stepNum)) {
    state.completedSteps.push(stepNum);
  }
  state.currentStep = stepNum + 1;
  saveState(state, cwd);

  return { files, recorded, historyPath, nextStep: state.currentStep };
}

module.exports = { planStepResponse, applyStepResponse };
