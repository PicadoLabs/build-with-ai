const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execSync } = require('child_process');
const {
  isInitialized,
  initState,
  loadState,
  saveState,
  loadContext,
  saveContext,
  saveHistory,
  loadHistory,
  getAllHistory,
  resetProject,
  getStorageDir
} = require('../lib/state');

const {
  loadTemplates,
  loadRemoteTemplate,
  getTemplate,
  resolveStepPrompt
} = require('../lib/promptEngine');

const {
  getByPath,
  setByPath,
  flattenObject,
  formatContextAsMarkdown
} = require('../lib/contextBuilder');

const {
  runExport,
  generateReadme,
  generateBuildLog
} = require('../lib/export');

const { copyToClipboard } = require('../lib/clipboard');

async function runIsolatedClipboardFallback(moduleSource) {
  const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'buildwithai-clipboard-'));
  const helperDir = path.join(isolatedRoot, 'lib');
  const helperPath = path.join(helperDir, 'clipboard.js');

  try {
    fs.mkdirSync(helperDir, { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'lib', 'clipboard.js'), helperPath);

    if (moduleSource !== null) {
      const moduleDir = path.join(isolatedRoot, 'node_modules', 'clipboardy');
      fs.mkdirSync(moduleDir, { recursive: true });
      fs.writeFileSync(path.join(moduleDir, 'package.json'), JSON.stringify({
        name: 'clipboardy',
        version: '0.0.0',
        main: 'index.js'
      }), 'utf8');
      fs.writeFileSync(path.join(moduleDir, 'index.js'), moduleSource, 'utf8');
    }

    const isolatedHelper = require(helperPath);
    return await isolatedHelper.copyToClipboard('fallback test');
  } finally {
    delete require.cache[helperPath];
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
  }
}

async function runTests() {
  const { formatElapsedTime } = require('../lib/ui');
  const metricsNow = Date.parse('2026-01-03T12:00:00Z');
  for (const [minutes, expected] of [
    [0, 'less than a minute'], [1, '1 min'], [2, '2 mins'],
    [60, '1 hr'], [85, '1 hr 25 mins'], [120, '2 hrs'],
    [1440, '1 day'], [2880, '2 days'], [-10, 'less than a minute']
  ]) {
    assert.strictEqual(formatElapsedTime(new Date(metricsNow - minutes * 60000).toISOString(), metricsNow), expected);
  }
  for (const value of [undefined, null, '', 'invalid', 0]) {
    assert.strictEqual(formatElapsedTime(value, metricsNow), 'Unknown');
  }
  // Context paths: preserve existing dot-separator semantics and value types.
  const deepContext = {};
  setByPath(deepContext, 'decisions.auth.oauth.providers.google.clientId', 'client-123');
  assert.deepStrictEqual(deepContext, {
    decisions: { auth: { oauth: { providers: { google: { clientId: 'client-123' } } } } }
  });
  assert.strictEqual(getByPath(deepContext, 'decisions.auth.oauth.providers.google.clientId'), 'client-123');
  assert.strictEqual(getByPath(deepContext, 'decisions.auth.oauth.providers.missing.clientId'), undefined);

  for (const parent of [undefined, null, 'old', 42, false]) {
    const nested = { decisions: { auth: parent, database: 'SQLite' } };
    setByPath(nested, 'decisions.auth.clientId', 'new');
    assert.deepStrictEqual(nested, { decisions: { auth: { clientId: 'new' }, database: 'SQLite' } });
  }
  for (const value of ['', false, 0, null]) {
    const nested = {};
    setByPath(nested, 'decisions.value', value);
    assert.strictEqual(getByPath(nested, 'decisions.value'), value);
    assert.deepStrictEqual(flattenObject(nested), { 'decisions.value': value });
  }

  const specialKeys = { 'a.b': 'literal', a: { b: 'nested' } };
  assert.strictEqual(getByPath(specialKeys, 'a.b'), 'nested', 'Dots are path separators, not literal key lookups');
  setByPath(specialKeys, 'a.b', 'updated');
  assert.deepStrictEqual(specialKeys, { 'a.b': 'literal', a: { b: 'updated' } });
  setByPath(specialKeys, ' settings.oauth-provider.client_id@prod ', 'key');
  assert.strictEqual(getByPath(specialKeys, ' settings.oauth-provider.client_id@prod '), 'key');
  assert.deepStrictEqual(flattenObject({ 'a.b': 'literal' }), { 'a.b': 'literal' });

  const arrayValue = [{ enabled: false }, ['nested', 0]];
  const flattenInput = { decisions: { options: { retries: 0 }, providers: arrayValue, empty: {} } };
  assert.deepStrictEqual(flattenObject(flattenInput), {
    'decisions.options.retries': 0,
    'decisions.providers': [{ enabled: false }, ['nested', 0]]
  });
  assert.strictEqual(flattenObject(flattenInput)['decisions.providers'], arrayValue, 'Nested arrays remain intact');
  assert.deepStrictEqual(flattenObject({ options: { enabled: false } }, 'project'), {
    'project.options.enabled': false
  });
  assert.deepStrictEqual(flattenInput, {
    decisions: { options: { retries: 0 }, providers: [{ enabled: false }, ['nested', 0]], empty: {} }
  }, 'Flattening does not mutate its input');
  for (const emptyInput of [null, undefined, '', 0, false, {}]) {
    assert.deepStrictEqual(flattenObject(emptyInput), {});
  }
  assert.strictEqual(getByPath({ decisions: null }, 'decisions.auth'), undefined);
  assert.strictEqual(getByPath({}, ''), undefined);
  const unchanged = { name: 'project' };
  setByPath(unchanged, '', 'ignored');
  assert.deepStrictEqual(unchanged, { name: 'project' });
  console.log('Context path edge cases passed.');

  const remoteData = { type: 'remote-test', title: 'Remote test', steps: [{ id: 'first' }] };
  const responses = [
    { status: 200, body: JSON.stringify(remoteData), valid: true },
    { status: 201, body: JSON.stringify(remoteData), valid: true },
    { status: 404, body: JSON.stringify(remoteData) },
    { status: 500, body: JSON.stringify(remoteData) },
    { status: 302, body: JSON.stringify(remoteData) },
    { status: 204, body: '' },
    { status: 200, body: '' },
    { status: 200, body: '   ' },
    { status: 200, body: '{broken' }
  ];
  const server = http.createServer((req, res) => {
    const response = responses[Number(req.url.slice(1).replace('.json', ''))];
    res.writeHead(response.status, { 'Content-Type': 'application/json', 'Connection': 'close' });
    res.end(response.body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    for (const [index, response] of responses.entries()) {
      const result = await loadRemoteTemplate(`http://127.0.0.1:${server.address().port}/${index}.json`);
      if (response.valid) {
        assert.deepStrictEqual(result, {
          id: String(index), ...remoteData, description: '', stepCount: 1
        });
      } else {
        assert.strictEqual(result, null, `HTTP ${response.status} with body ${JSON.stringify(response.body)} must fail to load`);
      }
    }
    assert(getTemplate('web-app'), 'Local templates remain available after failed remote loads');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  console.log('🧪 Starting build-with-ai Test Suite...\n');

  // Test 1: Template Loading & Verification
  console.log('▶ Test 1: Templates Loading');
  const templates = loadTemplates();
  assert(templates.length >= 2, 'Should load at least 2 templates');
  
  const webAppTemplate = getTemplate('web-app');
  assert(webAppTemplate !== null, 'web-app template must exist');
  assert(webAppTemplate.stepCount >= 20, `web-app template should have >= 20 steps, found ${webAppTemplate.stepCount}`);
  assert(webAppTemplate.steps[0].id === 'step-01-discovery', 'Step 1 should be discovery');
  assert(Array.isArray(webAppTemplate.steps[0].requires), 'Step 1 requires must be array');
  assert(Array.isArray(webAppTemplate.steps[0].writes), 'Step 1 writes must be array');

  const flutterAppTemplate = getTemplate('flutter-app');
  assert(flutterAppTemplate !== null, 'flutter-app template must exist');
  assert(flutterAppTemplate.stepCount >= 10 && flutterAppTemplate.stepCount <= 20, `flutter-app template should have 10-20 steps, found ${flutterAppTemplate.stepCount}`);
  assert(flutterAppTemplate.steps[0].id === 'step-01-discovery', 'Flutter Step 1 should be discovery');
  assert(Array.isArray(flutterAppTemplate.steps[0].requires), 'Flutter Step 1 requires must be array');
  assert(Array.isArray(flutterAppTemplate.steps[0].writes), 'Flutter Step 1 writes must be array');
  console.log('  ✔ Templates loaded successfully with dynamic step counts.');

  // Remote templates must fail in bounded time when the server stalls.
  console.log('\n▶ Remote Template Timeout');
  const https = require('https');
  const originalHttpsGet = https.get;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  let configuredTimeout;
  let requestDestroyed = false;
  let errorHandler;

  https.get = () => ({
    on(event, handler) {
      if (event === 'error') errorHandler = handler;
      return this;
    },
    destroy() {
      requestDestroyed = true;
      if (errorHandler) errorHandler(new Error('request timed out'));
    }
  });
  global.setTimeout = (onTimeout, timeoutMs) => {
    configuredTimeout = timeoutMs;
    setImmediate(onTimeout);
    return 1;
  };
  global.clearTimeout = () => {};

  try {
    const didNotResolve = Symbol('did-not-resolve');
    const remoteTemplate = await Promise.race([
      loadRemoteTemplate('https://example.test/stalled-template.json'),
      new Promise(resolve => originalSetTimeout(() => resolve(didNotResolve), 100))
    ]);
    assert.notStrictEqual(remoteTemplate, didNotResolve, 'Stalled request should resolve within its configured timeout');
    assert.strictEqual(remoteTemplate, null, 'Timed-out remote template should fail to load');
    assert(configuredTimeout > 0, 'Remote request should configure a positive timeout');
    assert(configuredTimeout <= 10_000, 'Remote request timeout should remain short');
    assert.strictEqual(requestDestroyed, true, 'Timed-out request should be destroyed');
    assert(getTemplate('web-app') !== null, 'Built-in templates should remain usable after a remote timeout');
  } finally {
    https.get = originalHttpsGet;
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  }
  console.log('  ✔ Stalled remote template fails cleanly without blocking local templates.');

  // Create isolated temp workspace
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildwithai-test-'));
  console.log(`\n▶ Test 2: State & Storage Management in ${tempDir}`);
  
  assert.strictEqual(isInitialized(tempDir), false, 'Should not be initialized yet');

  // Init project
  const state = initState({
    projectName: 'Expense Tracker',
    templateId: 'web-app',
    templateTitle: 'Full-Stack Web Application',
    experienceLevel: 'Beginner',
    projectIdea: 'A minimalist expense tracker for freelancers',
    totalSteps: webAppTemplate.stepCount
  }, tempDir);

  assert.strictEqual(isInitialized(tempDir), true, 'Should now be initialized');
  assert.strictEqual(state.currentStep, 1, 'Current step should start at 1');
  assert.strictEqual(state.completedSteps.length, 0, 'Completed steps should be empty');

  // Check initial context
  const context = loadContext(tempDir);
  assert.strictEqual(context.project.name, 'Expense Tracker');
  assert.strictEqual(context.project.type, 'web-app');
  assert.strictEqual(context.project.experienceLevel, 'Beginner');
  assert.strictEqual(context.project.idea, 'A minimalist expense tracker for freelancers');
  console.log('  ✔ State and initial context initialized correctly.');

  // Test 3: Prompt Engine Resolution for Step 1
  console.log('\n▶ Test 3: Prompt Resolution for Step 1');
  const step1 = webAppTemplate.steps[0];
  const res1 = resolveStepPrompt(step1, context);
  assert(res1.resolvedPrompt.includes('Expense Tracker'), 'Prompt must contain resolved project name');
  assert(res1.resolvedPrompt.includes('Beginner'), 'Prompt must contain resolved experience level');
  assert.strictEqual(res1.warnings.length, 0, 'Step 1 has all required keys in initial context');
  console.log('  ✔ Step 1 prompt interpolated without warnings.');

  // Test 4: Clipboard copying
  console.log('\n▶ Test 4: Safe Clipboard Copy');
  const missingClipboard = await runIsolatedClipboardFallback(null);
  assert.strictEqual(missingClipboard, false, 'Missing clipboard module should return false');

  const unsupportedClipboard = await runIsolatedClipboardFallback('module.exports = {};\n');
  assert.strictEqual(unsupportedClipboard, false, 'Clipboard module without write methods should return false');

  const copied = await copyToClipboard(res1.resolvedPrompt);
  console.log(`  ✔ Clipboard fallbacks returned false without crashing (environment copy result: ${copied}).`);

  // Test 5: Simulating Step 1 Completion (`done`)
  console.log('\n▶ Test 5: Simulating Step 1 Completion');
  setByPath(context, 'decisions.targetAudience', 'Freelancers and digital nomads');
  setByPath(context, 'decisions.coreValueProp', 'Instantly capture receipts and categorize expenses with zero friction.');
  saveContext(context, tempDir);

  saveHistory(1, '# Step 1 AI Response\n\nTarget Persona: Freelancer Alex\nPain Point: Loses receipts at tax time.\nValue Prop: Single-click receipt categorization.', tempDir);

  const loadedHist1 = loadHistory(1, tempDir);
  assert(loadedHist1.includes('Freelancer Alex'), 'History file must contain raw response');

  state.completedSteps.push(1);
  state.currentStep = 2;
  saveState(state, tempDir);

  const updatedState = loadState(tempDir);
  assert.strictEqual(updatedState.currentStep, 2);
  assert.deepStrictEqual(updatedState.completedSteps, [1]);
  console.log('  ✔ Step 1 saved to history, context updated, state advanced to 2.');

  // Test 6: Step 2 and Step 3 Resolution with Context Injection
  console.log('\n▶ Test 6: Context Injection into Step 2');
  const step2 = webAppTemplate.steps[1];
  const res2 = resolveStepPrompt(step2, context);
  assert(res2.resolvedPrompt.includes('Instantly capture receipts'), 'Step 2 must inject decisions.coreValueProp from step 1');
  console.log('  ✔ Step 2 prompt correctly received context from Step 1.');

  // Simulate Step 2 Completion
  setByPath(context, 'decisions.mvpFeatures', ['Receipt upload', 'Category breakdown dashboard', 'CSV export']);
  saveContext(context, tempDir);
  state.completedSteps.push(2);
  state.currentStep = 3;
  saveState(state, tempDir);

  // Step 3 requires tech stack
  console.log('\n▶ Test 7: Context Injection into Step 3 & 4');
  setByPath(context, 'decisions.frontendStack', 'Next.js 14 + Tailwind CSS');
  setByPath(context, 'decisions.backendStack', 'Next.js App Router API');
  setByPath(context, 'decisions.database', 'PostgreSQL with Prisma');
  saveContext(context, tempDir);

  const step4 = webAppTemplate.steps[3];
  const res4 = resolveStepPrompt(step4, context);
  assert(res4.resolvedPrompt.includes('Next.js 14 + Tailwind CSS'), 'Step 4 prompt has frontendStack');
  assert(res4.resolvedPrompt.includes('PostgreSQL with Prisma'), 'Step 4 prompt has database');
  console.log('  ✔ Multi-step context injection verified end-to-end.');

  // Test 8: Missing Requires Warning Check
  console.log('\n▶ Test 8: Missing Requires Warning Detection');
  const emptyContext = { project: { name: 'Test' } };
  const resMissing = resolveStepPrompt(step4, emptyContext);
  assert(resMissing.warnings.length > 0, 'Should detect missing required keys');
  assert(resMissing.missingKeys.includes('decisions.database'), 'Should identify missing database key');
  assert(resMissing.resolvedPrompt.includes('[MISSING: decisions.database]'), 'Should flag missing placeholder cleanly');
  console.log('  ✔ Missing requirements flagged cleanly without silent undefined injection.');

  // Test 9: `back` Command Logic
  console.log('\n▶ Test 9: Back Navigation');
  const stepBeforeBack = state.currentStep;
  state.currentStep = Math.max(1, state.currentStep - 1);
  state.completedSteps = state.completedSteps.filter(s => s !== state.currentStep);
  saveState(state, tempDir);

  const stateAfterBack = loadState(tempDir);
  assert.strictEqual(stateAfterBack.currentStep, stepBeforeBack - 1, 'Current step should decrement');
  assert(fs.existsSync(path.join(tempDir, '.buildwithai', 'history', 'step-01.md')), 'History file must NOT be deleted on back');
  console.log('  ✔ Back command moved step back while preserving history.');

  // Restore step for export test
  state.currentStep = 3;
  saveState(state, tempDir);

  // Test 10: Export Documentation
  console.log('\n▶ Test 10: Export (README.md, BUILD_LOG.md, CONTEXT.md)');
  runExport(tempDir);

  assert(fs.existsSync(path.join(tempDir, 'README.md')), 'README.md must be generated');
  assert(fs.existsSync(path.join(tempDir, 'BUILD_LOG.md')), 'BUILD_LOG.md must be generated');
  assert(fs.existsSync(path.join(tempDir, '.buildwithai', 'CONTEXT.md')), 'CONTEXT.md must be generated');

  const readmeContent = fs.readFileSync(path.join(tempDir, 'README.md'), 'utf8');
  assert(readmeContent.includes('Expense Tracker'), 'README must contain project name');
  assert(readmeContent.includes('Next.js 14 + Tailwind CSS'), 'README must contain chosen frontend');
  assert(readmeContent.includes('PostgreSQL with Prisma'), 'README must contain chosen database');

  const buildLogContent = fs.readFileSync(path.join(tempDir, 'BUILD_LOG.md'), 'utf8');
  assert(buildLogContent.includes('Freelancer Alex'), 'BUILD_LOG must contain raw step history');

  const contextMdContent = fs.readFileSync(path.join(tempDir, '.buildwithai', 'CONTEXT.md'), 'utf8');
  assert(contextMdContent.includes('Project Context & Architecture Decisions'), 'CONTEXT.md header check');
  console.log('  ✔ All export files generated with deterministic content.');

  // Test 11: Reset Project
  console.log('\n▶ Test 11: Reset Project (.buildwithai cleanup)');
  // Create a dummy user source file to make sure it is not touched
  fs.writeFileSync(path.join(tempDir, 'my-source-code.js'), 'console.log("hello")', 'utf8');
  
  resetProject(tempDir);
  assert.strictEqual(isInitialized(tempDir), false, 'Storage should be wiped');
  assert.strictEqual(fs.existsSync(getStorageDir(tempDir)), false, '.buildwithai dir removed');
  assert.strictEqual(fs.existsSync(path.join(tempDir, 'my-source-code.js')), true, 'User code preserved intact');
  console.log('  ✔ Reset cleaned .buildwithai and preserved user source files.');

// Test 12: Malformed Template JSON handling and graceful skipping
  console.log('\n Test 12: Malformed Template JSON handling');
  const projectTemplatesDir = path.join(__dirname, '..', 'templates');
  
  const badTemplatePath = path.join(projectTemplatesDir, 'bad-template.json');
  const validTemplatePath = path.join(projectTemplatesDir, 'web-app.json');
  
  // Temporarily write a malformed JSON file into the project templates directory
  fs.writeFileSync(badTemplatePath, '{ malformed json content', 'utf8');
  
  try {
    // Load templates, ensuring loadTemplates encounters the bad JSON and continues safely
    const loadedTemplates = loadTemplates();
    
    // Check whether the corrupted template was excluded and a valid template still loads
    const hasBad = loadedTemplates.some(t => t.id === 'bad-template');
    const hasGood = loadedTemplates.some(t => t.id === 'web-app');
    
    assert.strictEqual(hasBad, false, 'Malformed template must be ignored');
    assert.strictEqual(hasGood, true, 'Valid templates must still load');
    console.log('  ✔ Malformed templates handled gracefully without crashing.');
  } finally {
    // Ensure the temporary bad template file is always removed, even if assertions fail
    if (fs.existsSync(badTemplatePath)) {
      fs.unlinkSync(badTemplatePath);
    }
  }
// Test 12: --version CLI Flag
 console.log('\n▶ Test 12: --version CLI Flag');
  const cliPath = path.join(__dirname, '..', 'bin', 'cli.js');
  const pkg = require('../package.json');

  const versionOutput = execSync(`node "${cliPath}" --version`).toString().trim();
  assert.strictEqual(versionOutput, pkg.version, `--version should print ${pkg.version}, got ${versionOutput}`);
  console.log('  ✔ --version flag prints correct version and exits successfully.');

  // Cleanup temp dir
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('\n🎉 ALL TESTS PASSED SUCCESSFULLY! ✅\n');
}

runTests().catch(err => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
