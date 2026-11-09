/**
 * Shared handling of a model's reply to a step prompt, used by `next --run`
 * and the MCP `execute_step_sampled` tool: parse file blocks and decisions,
 * write files safely, record decisions, save history and advance the step.
 */

const { saveState, saveContext, saveHistory } = require('./state');
const { setByPath } = require('./contextBuilder');
const {
  parseFileBlocks,
  findTruncatedFileBlocks,
  parseDecisionsBlock,
  resolveTargetPath,
  writeFileBlocks
} = require('./aiClient');

/**
 * Parses a step response without touching the filesystem.
 * @param {string} cwd Project directory.
 * @param {string} response Model reply text.
 * @param {string[]} [targetFiles] Declared target files for the step.
 * @returns {{
 *   blocks: Array<{path: string, content: string}>,
 *   applicable: Array<{block: {path: string, content: string}, absolute: string}>,
 *   unsafe: string[],
 *   truncated: string[],
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

  // Blocks without a closing fence are truncated and never written (#213).
  const truncated = findTruncatedFileBlocks(response, targetFiles).map((block) => block.path);

  let decisions = {};
  let decisionsError = null;
  try {
    decisions = parseDecisionsBlock(response);
  } catch (err) {
    decisionsError = err.message;
  }

  return { blocks, applicable, unsafe, truncated, decisions, decisionsError };
}

/**
 * Applies a planned step response: writes files (unless `writeFiles` is
 * false), records decisions into context.json under the `decisions.`
 * namespace (#226), saves the response to history/step-XX.md and advances
 * state.json past `stepNum`. Blocks that fail the syntax check are skipped
 * unless `force` is set (#213).
 * @param {object} params
 * @param {string} params.cwd
 * @param {object} params.state Loaded state.json; mutated and saved.
 * @param {object} params.context Loaded context.json; mutated and saved when decisions are recorded.
 * @param {number} params.stepNum Step being completed.
 * @param {string} params.response Model reply text, saved to history.
 * @param {ReturnType<typeof planStepResponse>} params.plan
 * @param {boolean} [params.writeFiles=true] False discards file blocks (e.g. rejected in review).
 * @param {boolean} [params.force=false] Write blocks that fail the syntax check anyway.
 * @returns {{
 *   writes: ReturnType<typeof writeFileBlocks>,
 *   files: Array<{path: string, created: boolean, validationError: string|null}>,
 *   invalid: Array<{path: string, reason: string}>,
 *   recorded: string[],
 *   historyPath: string,
 *   nextStep: number
 * }}
 */
function applyStepResponse({ cwd, state, context, stepNum, response, plan, writeFiles = true, force = false }) {
  const writes =
    writeFiles && plan.applicable.length > 0
      ? writeFileBlocks(
          cwd,
          plan.applicable.map((entry) => entry.block),
          { force }
        )
      : [];
  const files = writes
    .filter((result) => result.written)
    .map((result) => ({ path: result.path, created: result.created, validationError: result.validationError }));
  const invalid = writes
    .filter((result) => !result.written && result.skipped)
    .map((result) => ({ path: result.path, reason: result.skipped }));

  // Models often omit the `decisions.` prefix; store every key under it (#226).
  const recorded = [];
  for (const [key, value] of Object.entries(plan.decisions)) {
    if (typeof key !== 'string' || !key.trim()) continue;
    const targetKey = key.startsWith('decisions.') ? key : `decisions.${key}`;
    if (setByPath(context, targetKey, value)) {
      recorded.push(targetKey);
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

  return { writes, files, invalid, recorded, historyPath, nextStep: state.currentStep };
}

module.exports = { planStepResponse, applyStepResponse };
