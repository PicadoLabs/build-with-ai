const fs = require('fs');
const http = require('http');
const path = require('path');
const { randomBytes, timingSafeEqual } = require('crypto');
const { isInitialized, loadState, loadContext, getAllHistory, isBranchScopedEnabled } = require('./state');
const { getTemplate } = require('./promptEngine');
const { flattenObject } = require('./contextBuilder');
const { buildStatusSummary } = require('./status');
const { runExport } = require('./export');
const { runRulesExport } = require('./rules');

const DEFAULT_PHASE = 'General';
const DEFAULT_PORT = 3721;
const HOST = '127.0.0.1';
const ALLOWED_HOSTNAMES = new Set(['localhost', '127.0.0.1']);
const ASSET_DIR = path.join(__dirname, 'dashboard');
const TOKEN_PLACEHOLDER = '__DASHBOARD_TOKEN__';
const TOKEN_HEADER = 'x-dashboard-token';
const MAX_BODY_BYTES = 1024;
const DEFAULT_EXPORTERS = {
  // Never prompt from the server: an existing README.md gets a fallback name.
  docs: (cwd) => runExport(cwd, { interactive: false }),
  rules: (cwd) => runRulesExport(cwd)
};
const ASSETS = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' }
};
const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
};

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

/**
 * Returns true when the Host header names this machine. Rejecting any other
 * host blocks DNS-rebinding pages from reading the project through the API.
 * @param {string|undefined} hostHeader
 * @returns {boolean}
 */
function isAllowedHost(hostHeader) {
  if (!hostHeader) return false;
  try {
    return ALLOWED_HOSTNAMES.has(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}

function send(res, statusCode, body, contentType) {
  res.writeHead(statusCode, { ...SECURITY_HEADERS, 'Content-Type': contentType });
  res.end(body);
}

function sendJson(res, statusCode, payload) {
  send(res, statusCode, JSON.stringify(payload), 'application/json; charset=utf-8');
}

function tokensMatch(expected, received) {
  if (typeof received !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      // Keep draining an oversized body without buffering it, so the 413
      // response can still be delivered on the open connection.
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large.'), { statusCode: 413 }));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('Request body must be valid JSON.'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Handles POST /api/export. Only the dashboard page knows the per-server
 * token, so other sites cannot trigger file writes through the browser.
 */
async function handleExport(req, res, { cwd, token, exporters, busy }) {
  const origin = req.headers.origin;
  if (origin && !isAllowedHost(origin.replace(/^https?:\/\//, ''))) {
    sendJson(res, 403, { error: 'Forbidden origin.' });
    return;
  }
  if (!tokensMatch(token, req.headers[TOKEN_HEADER])) {
    sendJson(res, 403, { error: 'Missing or invalid dashboard token. Reload the page.' });
    return;
  }
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
    sendJson(res, 415, { error: 'Content-Type must be application/json.' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, error.statusCode || 400, { error: error.message });
    return;
  }

  const target = body && body.target;
  if (!Object.prototype.hasOwnProperty.call(exporters, target)) {
    sendJson(res, 400, { error: 'Export target must be "docs" or "rules".' });
    return;
  }
  if (busy.value) {
    sendJson(res, 409, { error: 'Another export is still running.' });
    return;
  }

  busy.value = true;
  try {
    const result = await exporters[target](cwd);
    if (!Array.isArray(result)) {
      sendJson(res, 500, { error: 'Export failed. Check the terminal running `build-with-ai ui` for details.' });
      return;
    }
    sendJson(res, 200, { target, files: result.map((file) => path.relative(cwd, file) || file) });
  } catch (error) {
    sendJson(res, 500, { error: `Export failed: ${error.message}` });
  } finally {
    busy.value = false;
  }
}

/**
 * Creates (but does not start) the dashboard HTTP server for a project.
 * @param {object} [options]
 * @param {string} [options.cwd=process.cwd()] Project directory to read.
 * @param {string} [options.token] Export token; a random one is generated by default.
 * @param {object} [options.exporters] Export handlers keyed by target, overridable in tests.
 * @returns {http.Server}
 */
function createDashboardServer({ cwd = process.cwd(), token, exporters = DEFAULT_EXPORTERS } = {}) {
  const exportToken = token || randomBytes(32).toString('hex');
  const busy = { value: false };

  const server = http.createServer((req, res) => {
    if (!isAllowedHost(req.headers.host)) {
      sendJson(res, 403, { error: 'Forbidden host.' });
      return;
    }

    const { pathname } = new URL(req.url, 'http://localhost');

    if (pathname === '/api/export') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        sendJson(res, 405, { error: 'Method not allowed.' });
        return;
      }
      handleExport(req, res, { cwd, token: exportToken, exporters, busy });
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendJson(res, 405, { error: 'Method not allowed.' });
      return;
    }

    if (pathname === '/api/project') {
      try {
        const data = buildDashboardData(cwd);
        if (!data) {
          sendJson(res, 404, { error: 'No project found. Run `npx build-with-ai init` first.' });
          return;
        }
        sendJson(res, 200, data);
      } catch (error) {
        sendJson(res, 500, { error: `Unable to read project: ${error.message}` });
      }
      return;
    }

    const asset = Object.prototype.hasOwnProperty.call(ASSETS, pathname) ? ASSETS[pathname] : null;
    if (asset) {
      fs.readFile(path.join(ASSET_DIR, asset.file), (error, contents) => {
        if (error) {
          sendJson(res, 500, { error: 'Dashboard asset is missing.' });
          return;
        }
        const body =
          asset.file === 'index.html' ? contents.toString('utf8').replace(TOKEN_PLACEHOLDER, exportToken) : contents;
        send(res, 200, body, asset.type);
      });
      return;
    }

    sendJson(res, 404, { error: 'Not found.' });
  });
  server.dashboardToken = exportToken;
  return server;
}

/**
 * Starts the dashboard server on 127.0.0.1.
 * @param {object} [options]
 * @param {string} [options.cwd=process.cwd()]
 * @param {number} [options.port=3721] Use 0 for a random free port.
 * @param {object} [options.exporters] Export handlers, overridable in tests.
 * @returns {Promise<{ server: http.Server, url: string }>}
 */
function startDashboardServer({ cwd = process.cwd(), port = DEFAULT_PORT, exporters } = {}) {
  const server = createDashboardServer({ cwd, exporters });
  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(`Port ${port} is already in use. Try another one with --port <number>.`));
        return;
      }
      reject(error);
    });
    server.listen(port, HOST, () => {
      const { port: actualPort } = server.address();
      resolve({ server, url: `http://localhost:${actualPort}` });
    });
  });
}

module.exports = {
  DEFAULT_PORT,
  buildPhaseTree,
  buildDecisionRows,
  buildDashboardData,
  isAllowedHost,
  createDashboardServer,
  startDashboardServer
};
