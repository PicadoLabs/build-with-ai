/**
 * Native Model Context Protocol (MCP) stdio server.
 *
 * Exposes the build-with-ai workflow to AI-native editors (Cursor, Windsurf,
 * Claude Code, Claude Desktop) as MCP tools over JSON-RPC 2.0 on stdio,
 * following the MCP specification (newline-delimited JSON-RPC messages).
 *
 * IMPORTANT: stdout carries only JSON-RPC messages. All diagnostics go to
 * stderr so editor MCP clients never see corrupted frames.
 *
 * Run with: `npx build-with-ai mcp`
 */

const readline = require('readline');
const {
  isInitialized,
  initState,
  loadState,
  saveState,
  loadContext,
  saveContext,
  saveHistory,
  saveSnapshot
} = require('./state');
const { getTemplate, resolveStepPrompt } = require('./promptEngine');
const { getByPath, setByPath, flattenObject } = require('./contextBuilder');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_NAME = 'build-with-ai';

function packageVersion() {
  try {
    return require('../package.json').version;
  } catch {
    return '0.0.0';
  }
}

function diag(message) {
  process.stderr.write(`${message}\n`);
}

const TOOL_DEFINITIONS = [
  {
    name: 'get_workflow_status',
    description:
      'Returns the current workflow step, total steps, progress percentage, completed steps, and recorded decisions.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'get_active_prompt',
    description: 'Returns the fully interpolated prompt, target files, and recommended AI for the current step.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'complete_step',
    description:
      'Records decisions, optionally saves the AI response markdown to history/, and advances to the next step.',
    inputSchema: {
      type: 'object',
      properties: {
        decisions: {
          type: 'object',
          description: 'Decision key/values to record (dot-notation paths, e.g. {"decisions.database": "PostgreSQL"}).',
          additionalProperties: true
        },
        response: {
          type: 'string',
          description: 'Full AI response markdown for this step; saved to history/step-XX.md.'
        }
      },
      additionalProperties: false
    }
  },
  {
    name: 'get_context',
    description: 'Returns the current context.json. Optionally pass a dot-notation key to look up one value.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Dot-notation key to look up (e.g. "decisions.database").' }
      },
      additionalProperties: false
    }
  }
];

function toolResult(text) {
  return { content: [{ type: 'text', text }] };
}

function toolError(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

function workflowStatus(cwd) {
  const state = loadState(cwd);
  const context = loadContext(cwd);
  const template = getTemplate(state.templateId);
  const totalSteps = template ? template.steps.length : state.totalSteps || 0;
  const completedSteps = Array.isArray(state.completedSteps) ? state.completedSteps : [];
  const currentStepNum = state.currentStep || 1;
  return {
    projectName: state.projectName,
    templateId: state.templateId,
    currentStep: currentStepNum,
    totalSteps,
    completedSteps,
    progressPercent: totalSteps > 0 ? Math.round((completedSteps.length / totalSteps) * 100) : 0,
    allStepsComplete: totalSteps > 0 && currentStepNum > totalSteps,
    decisions: context.decisions || {}
  };
}

function activePrompt(cwd) {
  const state = loadState(cwd);
  const context = loadContext(cwd);
  const template = getTemplate(state.templateId);
  const totalSteps = template ? template.steps.length : state.totalSteps || 0;
  const currentStepNum = state.currentStep || 1;
  if (!template || currentStepNum > totalSteps) {
    return { completed: true, message: 'All workflow steps are complete. Run `npx build-with-ai export`.' };
  }
  const step = template.steps[currentStepNum - 1];
  const { resolvedPrompt, warnings, targetFiles, recommendedAI } = resolveStepPrompt(step, context);
  return {
    completed: false,
    step: currentStepNum,
    totalSteps,
    title: step.title,
    phase: step.phase || '',
    goal: step.goal,
    expectedOutput: step.expectedOutput,
    prompt: resolvedPrompt,
    targetFiles,
    recommendedAI,
    warnings
  };
}

function completeStep(cwd, args) {
  const params = args && typeof args === 'object' ? args : {};
  const state = loadState(cwd);
  const context = loadContext(cwd);
  const template = getTemplate(state.templateId);
  const totalSteps = template ? template.steps.length : state.totalSteps || 0;
  const currentStepNum = state.currentStep || 1;

  if (!template || currentStepNum > totalSteps) {
    return toolError('All workflow steps are already complete. Nothing to advance.');
  }

  if (params.decisions !== undefined && (typeof params.decisions !== 'object' || params.decisions === null)) {
    return toolError('"decisions" must be an object mapping dot-notation keys to values.');
  }

  // Snapshot state.json + context.json BEFORE this step's decisions are
  // recorded, so `npx build-with-ai undo` can roll back steps completed via
  // the MCP complete_step tool (#136). Mirrors the CLI `done` command.
  saveSnapshot(currentStepNum, cwd);

  const recorded = [];
  const decisions = params.decisions || {};
  for (const [key, value] of Object.entries(decisions)) {
    if (typeof key !== 'string' || !key.trim()) {
      return toolError('Decision keys must be non-empty strings.');
    }
    if (!setByPath(context, key, value)) {
      return toolError(
        `Cannot record decision "${key}": the key is empty or contains a reserved segment ("__proto__", "prototype" or "constructor").`
      );
    }
    recorded.push(key);
  }
  if (recorded.length > 0) {
    saveContext(context, cwd);
  }

  let historyPath = null;
  if (typeof params.response === 'string' && params.response.trim()) {
    historyPath = saveHistory(currentStepNum, params.response.trim(), cwd);
  }

  if (!state.completedSteps.includes(currentStepNum)) {
    state.completedSteps.push(currentStepNum);
  }
  state.currentStep = currentStepNum + 1;
  saveState(state, cwd);

  const summary = {
    completedStep: currentStepNum,
    advancedToStep: state.currentStep,
    totalSteps,
    recordedDecisions: recorded,
    historyPath
  };
  return toolResult(JSON.stringify(summary, null, 2));
}

function handleToolsCall(cwd, params) {
  if (!params || typeof params.name !== 'string') {
    return toolError('Missing required "name" parameter for tools/call.');
  }
  const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};

  switch (params.name) {
    case 'get_workflow_status':
      return toolResult(JSON.stringify(workflowStatus(cwd), null, 2));
    case 'get_active_prompt':
      return toolResult(JSON.stringify(activePrompt(cwd), null, 2));
    case 'complete_step':
      return completeStep(cwd, args);
    case 'get_context': {
      const context = loadContext(cwd);
      if (typeof args.key === 'string' && args.key.trim()) {
        const value = getByPath(context, args.key);
        if (value === undefined || value === null) {
          return toolError(`No value found for key "${args.key}" in context.json.`);
        }
        return toolResult(typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value));
      }
      const flat = flattenObject(context);
      return toolResult(JSON.stringify({ raw: context, flattened: flat }, null, 2));
    }
    default:
      return toolError(`Unknown tool "${params.name}".`);
  }
}

/**
 * Handles one JSON-RPC request object. Returns the response object, or null
 * for notifications (which must not receive a response).
 * @param {object} request
 * @param {string} cwd
 * @returns {object|null}
 */
function handleRequest(request, cwd) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const { id, method, params } = request;
  const isNotification = id === undefined || id === null;

  const respond = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result });
  const respondError = (code, message) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message } });

  if (typeof method !== 'string') {
    return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }

  // Notifications never produce a response.
  if (isNotification) {
    return null;
  }

  try {
    switch (method) {
      case 'initialize':
        return respond({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: packageVersion() }
        });
      case 'ping':
        return respond({});
      case 'tools/list':
        return respond({ tools: TOOL_DEFINITIONS });
      case 'tools/call':
        if (!isInitialized(cwd)) {
          return respond(toolError('No project found in this directory. Run `npx build-with-ai init` first.'));
        }
        return respond(handleToolsCall(cwd, params));
      default:
        return respondError(-32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return respondError(-32603, `Internal error: ${err && err.message ? err.message : String(err)}`);
  }
}

/**
 * Runs the MCP stdio server. Resolves when stdin closes.
 * @param {object} [options]
 * @param {NodeJS.ReadableStream} [options.stdin]
 * @param {NodeJS.WritableStream} [options.stdout]
 * @param {string} [options.cwd]
 * @returns {Promise<void>}
 */
function runMcpServer({ stdin = process.stdin, stdout = process.stdout, cwd = process.cwd() } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stdin, crlfDelay: Infinity });

    const write = (message) => {
      stdout.write(`${JSON.stringify(message)}\n`);
    };

    rl.on('line', (line) => {
      const text = line.trim();
      if (!text) return;
      let request;
      try {
        request = JSON.parse(text);
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      let response;
      try {
        response = handleRequest(request, cwd);
      } catch (err) {
        response = {
          jsonrpc: '2.0',
          id: request && request.id !== undefined ? request.id : null,
          error: { code: -32603, message: `Internal error: ${err && err.message ? err.message : String(err)}` }
        };
      }
      if (response) write(response);
    });

    rl.on('close', () => resolve());
    stdin.on('error', (err) => {
      diag(`MCP server stdin error: ${err && err.message ? err.message : String(err)}`);
      resolve();
    });
  });
}

module.exports = {
  runMcpServer,
  handleRequest,
  TOOL_DEFINITIONS,
  PROTOCOL_VERSION,
  // Re-exported for tests
  initState,
  workflowStatus,
  activePrompt
};
