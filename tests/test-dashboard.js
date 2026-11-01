const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const { initState, loadState, saveState, saveContext, saveHistory } = require('../lib/state');
const { getTemplate } = require('../lib/promptEngine');
const {
  buildDashboardData,
  buildPhaseTree,
  buildDecisionRows,
  isAllowedHost,
  startDashboardServer,
  openBrowser
} = require('../lib/dashboard');
const { EventEmitter } = require('events');

function createProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildwithai-dashboard-'));
  const template = getTemplate('saas-mvp');
  initState(
    {
      projectName: 'Dashboard Demo',
      templateId: 'saas-mvp',
      templateTitle: template.title,
      experienceLevel: 'Intermediate',
      projectIdea: 'A demo project for the dashboard',
      totalSteps: template.steps.length
    },
    dir
  );
  const state = loadState(dir);
  state.completedSteps = [1, 2];
  state.currentStep = 3;
  saveState(state, dir);
  saveContext(
    {
      project: { name: 'Dashboard Demo' },
      decisions: {
        targetCustomer: 'Indie developers',
        mvpFeatures: ['auth', 'billing'],
        frontendStack: { framework: 'Next.js', styling: 'Tailwind' },
        customNote: 'Recorded by hand'
      }
    },
    dir
  );
  saveHistory(1, '# Discovery\n\nTarget indie developers.', dir);
  saveHistory(2, '# Scope\n\n- auth\n- billing', dir);
  return { dir, template };
}

async function testDataBuilder() {
  console.log('▶ Test: Dashboard data builder');

  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildwithai-dashboard-empty-'));
  try {
    assert.strictEqual(buildDashboardData(emptyDir), null, 'Uninitialized directory yields null');
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }

  const { dir, template } = createProject();
  try {
    const data = buildDashboardData(dir);
    assert.ok(data, 'Initialized project yields dashboard data');
    assert.strictEqual(data.status.projectName, 'Dashboard Demo');
    assert.strictEqual(data.status.totalSteps, template.steps.length);
    assert.strictEqual(data.status.completedCount, 2);
    assert.strictEqual(data.status.currentStep, 3);

    const allSteps = data.phases.flatMap((phase) => phase.steps);
    assert.strictEqual(allSteps.length, template.steps.length, 'Phase tree contains every step');
    assert.deepStrictEqual(
      allSteps.map((step) => step.number),
      template.steps.map((_, idx) => idx + 1),
      'Phase tree keeps template order'
    );
    assert.strictEqual(allSteps[0].status, 'completed');
    assert.strictEqual(allSteps[2].status, 'current');
    assert.strictEqual(allSteps[3].status, 'pending');
    assert.strictEqual(data.phases[0].name, template.steps[0].phase);
    assert.strictEqual(data.phases[0].completedCount, 1);
    console.log('  ✔ Status and phase tree reflect state.json and the template.');

    const byKey = Object.fromEntries(data.decisions.map((row) => [row.key, row]));
    assert.strictEqual(byKey.targetCustomer.step, 1, 'Decision is tagged with the step that writes it');
    assert.strictEqual(byKey.targetCustomer.phase, template.steps[0].phase);
    assert.deepStrictEqual(byKey.mvpFeatures.value, ['auth', 'billing'], 'Array decisions stay intact');
    assert.strictEqual(byKey['frontendStack.framework'].value, 'Next.js', 'Nested decisions are flattened');
    assert.strictEqual(byKey['frontendStack.framework'].step, 3, 'Nested keys inherit their parent source');
    assert.strictEqual(byKey.customNote.step, null, 'Unknown decisions have no source step');
    console.log('  ✔ Decisions are flattened and tagged with their source step.');

    assert.deepStrictEqual(
      data.history.map((item) => item.step),
      [1, 2]
    );
    assert.strictEqual(data.history[0].title, template.steps[0].title);
    assert.ok(data.history[1].content.includes('- billing'));
    console.log('  ✔ History items include step titles and archived content.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  assert.deepStrictEqual(buildPhaseTree(null, {}), [], 'Missing template yields an empty phase tree');
  assert.deepStrictEqual(
    buildDecisionRows({ a: 1 }, null),
    [{ key: 'a', value: 1, step: null, phase: null }],
    'Decisions render without a template'
  );
  console.log('  ✔ Missing templates are handled gracefully.');
}

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function testServerRoutes() {
  console.log('\n▶ Test: Dashboard server routes');

  assert.strictEqual(isAllowedHost('localhost:3721'), true);
  assert.strictEqual(isAllowedHost('127.0.0.1:3721'), true);
  assert.strictEqual(isAllowedHost('evil.example:3721'), false);
  assert.strictEqual(isAllowedHost('localhost.evil.example'), false);
  assert.strictEqual(isAllowedHost(undefined), false);
  console.log('  ✔ Host allowlist accepts only local hostnames.');

  const { dir } = createProject();
  const { server, url } = await startDashboardServer({ cwd: dir, port: 0 });
  try {
    const page = await request(`${url}/`);
    assert.strictEqual(page.status, 200);
    assert.ok(page.headers['content-type'].startsWith('text/html'));
    assert.ok(page.headers['content-security-policy'].includes("default-src 'self'"));
    console.log('  ✔ GET / serves the dashboard page with a content security policy.');

    const api = await request(`${url}/api/project`);
    assert.strictEqual(api.status, 200);
    assert.strictEqual(api.headers['cache-control'], 'no-store');
    assert.strictEqual(JSON.parse(api.body).status.projectName, 'Dashboard Demo');
    console.log('  ✔ GET /api/project returns project data.');

    const rebinding = await request(`${url}/api/project`, { headers: { Host: 'attacker.example' } });
    assert.strictEqual(rebinding.status, 403, 'Foreign Host header is rejected');
    console.log('  ✔ Requests with a foreign Host header are rejected.');

    assert.strictEqual((await request(`${url}/missing`)).status, 404);
    assert.strictEqual((await request(`${url}/../package.json`)).status, 404);
    assert.strictEqual((await request(`${url}/api/project`, { method: 'DELETE' })).status, 405);
    console.log('  ✔ Unknown paths return 404 and unsupported methods return 405.');

    fs.rmSync(path.join(dir, '.buildwithai'), { recursive: true, force: true });
    const missing = await request(`${url}/api/project`);
    assert.strictEqual(missing.status, 404, 'Removed project returns 404');
    assert.ok(JSON.parse(missing.body).error.includes('init'));
    console.log('  ✔ A missing project returns a helpful 404.');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const { server: blocker } = await startDashboardServer({ cwd: os.tmpdir(), port: 0 });
  try {
    const busyPort = blocker.address().port;
    await assert.rejects(startDashboardServer({ port: busyPort }), /already in use.*--port/);
    console.log('  ✔ A busy port fails with a --port hint.');
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
  }
}

async function testExportEndpoint() {
  console.log('\n▶ Test: Dashboard export endpoint');

  const { dir } = createProject();
  const calls = [];
  const exporters = {
    docs: async (cwd) => {
      calls.push('docs');
      return [path.join(cwd, 'README.md'), path.join(cwd, 'BUILD_LOG.md')];
    },
    rules: async () => {
      calls.push('rules');
      return false;
    }
  };
  const { server, url } = await startDashboardServer({ cwd: dir, port: 0, exporters });
  const token = server.dashboardToken;
  const post = (body, headers = {}) =>
    request(`${url}/api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Dashboard-Token': token, ...headers },
      body: JSON.stringify(body)
    });

  try {
    const page = await request(`${url}/`);
    assert.ok(page.body.includes(`content="${token}"`), 'Page embeds the export token');
    assert.ok(!page.body.includes('__DASHBOARD_TOKEN__'), 'Token placeholder is replaced');
    assert.match(token, /^[a-f0-9]{64}$/);
    console.log('  ✔ The served page embeds a random per-server token.');

    assert.strictEqual((await post({ target: 'docs' }, { 'X-Dashboard-Token': '' })).status, 403);
    assert.strictEqual((await post({ target: 'docs' }, { 'X-Dashboard-Token': 'a'.repeat(64) })).status, 403);
    assert.strictEqual((await post({ target: 'docs' }, { Origin: 'http://evil.example' })).status, 403);
    assert.strictEqual((await post({ target: 'docs' }, { 'Content-Type': 'text/plain' })).status, 415);
    assert.deepStrictEqual(calls, [], 'Rejected requests never run an export');
    console.log('  ✔ Missing tokens, wrong tokens, foreign origins and non-JSON bodies are rejected.');

    assert.strictEqual((await post({ target: 'everything' })).status, 400);
    assert.strictEqual((await post('x'.repeat(2048))).status, 413);
    assert.strictEqual((await request(`${url}/api/export`)).status, 405);
    console.log('  ✔ Unknown targets, oversized bodies and GET requests are rejected.');

    const docs = await post({ target: 'docs' }, { Origin: url });
    assert.strictEqual(docs.status, 200);
    assert.deepStrictEqual(JSON.parse(docs.body), { target: 'docs', files: ['README.md', 'BUILD_LOG.md'] });
    console.log('  ✔ A valid request runs the export and returns project-relative paths.');

    const rules = await post({ target: 'rules' });
    assert.strictEqual(rules.status, 500, 'A failed export reports an error');
    assert.ok(JSON.parse(rules.body).error.includes('terminal'));
    assert.deepStrictEqual(calls, ['docs', 'rules']);
    console.log('  ✔ A failed export returns a 500 with a pointer to the terminal output.');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testOpenBrowser() {
  console.log('\n▶ Test: Browser opener');

  const fakeSpawn = (event) => {
    const calls = [];
    const impl = (command, args) => {
      calls.push([command, args]);
      const child = new EventEmitter();
      child.unref = () => {};
      process.nextTick(() => child.emit(event, event === 'error' ? new Error('ENOENT') : undefined));
      return child;
    };
    return { calls, impl };
  };

  const url = 'http://localhost:3721';
  for (const [platform, command, args] of [
    ['darwin', 'open', [url]],
    ['linux', 'xdg-open', [url]],
    ['win32', 'cmd', ['/c', 'start', '""', url]]
  ]) {
    const { calls, impl } = fakeSpawn('spawn');
    assert.strictEqual(await openBrowser(url, { platform, spawnImpl: impl }), true);
    assert.deepStrictEqual(calls, [[command, args]], `${platform} uses ${command}`);
  }
  console.log('  ✔ Uses open, xdg-open or start depending on the platform.');

  const missing = fakeSpawn('error');
  assert.strictEqual(await openBrowser(url, { platform: 'linux', spawnImpl: missing.impl }), false);
  const throwing = () => {
    throw new Error('spawn failed');
  };
  assert.strictEqual(await openBrowser(url, { platform: 'linux', spawnImpl: throwing }), false);
  console.log('  ✔ A missing or failing opener resolves to false instead of crashing.');
}

async function runTests() {
  await testDataBuilder();
  await testServerRoutes();
  await testExportEndpoint();
  await testOpenBrowser();
  console.log('\nAll dashboard tests passed.');
}

runTests().catch((err) => {
  console.error('Dashboard test failed:', err);
  process.exit(1);
});
