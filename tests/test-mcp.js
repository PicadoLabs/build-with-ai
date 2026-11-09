const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { PassThrough } = require('stream');

const {
  createMcpSession,
  isResponseMessage,
  parseSamplingResult,
  runMcpServer,
  SAMPLED_TOOL_DEFINITION
} = require('../lib/mcp');
const { initState, loadState, saveState, loadContext, loadHistory, getSnapshotsDir } = require('../lib/state');
const { getTemplate } = require('../lib/promptEngine');

const TOOL = SAMPLED_TOOL_DEFINITION.name;
const GOOD_REPLY = [
  'Implemented the step.',
  '```src/sampled.js',
  'export const ok = true;',
  '```',
  '```../escape.js',
  'nope',
  '```',
  '```decisions',
  '{ "decisions.database": "PostgreSQL" }',
  '```'
].join('\n');

function textResult(text, extra = {}) {
  return {
    result: { role: 'assistant', model: 'host-model', stopReason: 'endTurn', content: { type: 'text', text }, ...extra }
  };
}

function createProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildwithai-mcp-sampling-'));
  const template = getTemplate('saas-mvp');
  initState(
    {
      projectName: 'Sampling Demo',
      templateId: 'saas-mvp',
      templateTitle: template.title,
      experienceLevel: 'Beginner',
      projectIdea: 'A demo',
      totalSteps: template.steps.length
    },
    dir
  );
  return dir;
}

/**
 * Fake MCP host: drives runMcpServer over in-memory streams and answers the
 * server's sampling/createMessage requests with onSample(request).
 * onSample may return { result }, { error }, or undefined to never answer.
 */
async function startHost(cwd, { sampling = true, onSample = () => textResult(GOOD_REPLY), requestTimeoutMs } = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const done = runMcpServer({ stdin: input, stdout: output, cwd, requestTimeoutMs });
  const waiters = new Map();
  const samplingRequests = [];
  let nextId = 1;
  const send = (message) => input.write(`${JSON.stringify(message)}\n`);

  readline.createInterface({ input: output }).on('line', async (line) => {
    const message = JSON.parse(line);
    if (message.method === 'sampling/createMessage') {
      samplingRequests.push(message);
      const reply = await onSample(message);
      if (reply) send({ jsonrpc: '2.0', id: message.id, ...reply });
      return;
    }
    const waiter = waiters.get(message.id);
    if (waiter) {
      waiters.delete(message.id);
      waiter(message);
    }
  });

  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiters.set(id, resolve);
      send({ jsonrpc: '2.0', id, method, params });
    });

  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: sampling ? { sampling: {} } : {},
    clientInfo: { name: 'fake-host', version: '0.0.0' }
  });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  return {
    samplingRequests,
    request,
    callTool: async (args = {}) => (await request('tools/call', { name: TOOL, arguments: args })).result,
    listTools: async () => (await request('tools/list', {})).result.tools.map((tool) => tool.name),
    close: async () => {
      input.end();
      await done;
    }
  };
}

function snapshotExists(dir, step) {
  return fs.existsSync(path.join(getSnapshotsDir(dir), `step-${String(step).padStart(2, '0')}.json`));
}

async function testSessionRouting() {
  console.log('▶ Test: MCP session request routing');

  assert.strictEqual(isResponseMessage({ jsonrpc: '2.0', id: 1, result: {} }), true);
  assert.strictEqual(isResponseMessage({ jsonrpc: '2.0', id: 'a', error: { code: 1, message: 'x' } }), true);
  assert.strictEqual(isResponseMessage({ jsonrpc: '2.0', id: 1, method: 'ping' }), false);
  assert.strictEqual(isResponseMessage({ jsonrpc: '2.0', id: null, error: {} }), false);
  assert.strictEqual(isResponseMessage({ jsonrpc: '2.0', id: 1 }), false);
  assert.strictEqual(isResponseMessage([1]), false);
  console.log('  ✔ Responses are told apart from requests and notifications.');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildwithai-mcp-session-'));
  const sent = [];
  const session = createMcpSession({ cwd: dir, write: (message) => sent.push(message) });
  try {
    const ping = await session.handleMessage({ jsonrpc: '2.0', id: 7, method: 'ping' });
    assert.deepStrictEqual(ping, { jsonrpc: '2.0', id: 7, result: {} }, 'Client requests are still answered');
    assert.strictEqual(await session.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);

    const first = session.sendRequest('test/one', { a: 1 });
    const second = session.sendRequest('test/two', {});
    assert.strictEqual(sent.length, 2);
    assert.strictEqual(sent[0].method, 'test/one');
    assert.deepStrictEqual(sent[0].params, { a: 1 });
    assert.notStrictEqual(sent[0].id, sent[1].id, 'Each outgoing request gets a unique id');
    assert.strictEqual(session.pendingCount(), 2);

    // Answer out of order: responses are matched by id, not position.
    assert.strictEqual(
      await session.handleMessage({ jsonrpc: '2.0', id: sent[1].id, error: { code: -1, message: 'User denied' } }),
      null
    );
    await assert.rejects(second, /client rejected test\/two: User denied/);
    await session.handleMessage({ jsonrpc: '2.0', id: sent[0].id, result: { ok: true } });
    assert.deepStrictEqual(await first, { ok: true });
    assert.strictEqual(session.pendingCount(), 0);

    assert.strictEqual(await session.handleMessage({ jsonrpc: '2.0', id: 'unknown', result: {} }), null);
    console.log('  ✔ Outgoing requests resolve or reject from matching responses, in any order.');

    await assert.rejects(session.sendRequest('test/slow', {}, { timeoutMs: 20 }), /did not answer test\/slow/);
    assert.strictEqual(session.pendingCount(), 0, 'Timed out requests are removed');
    console.log('  ✔ Unanswered requests time out.');

    const orphan = session.sendRequest('test/orphan', {});
    session.close();
    await assert.rejects(orphan, /closed before the client answered test\/orphan/);
    await assert.rejects(session.sendRequest('test/late', {}), /connection is closed/);
    assert.strictEqual(session.pendingCount(), 0);
    console.log('  ✔ Closing the session rejects outstanding and new requests.');
  } finally {
    session.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testParseSamplingResult() {
  console.log('\n▶ Test: Sampling result parsing');
  assert.deepStrictEqual(parseSamplingResult(textResult('hi').result), {
    text: 'hi',
    model: 'host-model',
    stopReason: 'endTurn'
  });
  assert.strictEqual(
    parseSamplingResult({
      content: [
        { type: 'text', text: 'a' },
        { type: 'image', data: 'x' },
        { type: 'text', text: 'b' }
      ]
    }).text,
    'a\nb',
    'Arrays of content blocks join their text blocks'
  );
  assert.throws(() => parseSamplingResult({ content: { type: 'image', data: 'x' } }), /without text content/);
  assert.throws(() => parseSamplingResult(null), /empty sampling result/);
  console.log('  ✔ Text replies are extracted and non-text replies are rejected.');
}

async function testCapabilityNegotiation() {
  console.log('\n▶ Test: Sampling capability negotiation');
  const dir = createProject();
  try {
    const plain = await startHost(dir, { sampling: false });
    assert.ok(!(await plain.listTools()).includes(TOOL), 'Tool is hidden from clients without sampling');
    const refused = await plain.callTool();
    assert.strictEqual(refused.isError, true);
    assert.match(refused.content[0].text, /does not support sampling.*get_active_prompt/s);
    assert.strictEqual(plain.samplingRequests.length, 0, 'No sampling request is sent');
    await plain.close();

    const capable = await startHost(dir);
    assert.ok((await capable.listTools()).includes(TOOL), 'Tool is listed for clients with sampling');
    await capable.close();
    console.log('  ✔ execute_step_sampled is offered only to clients that declare sampling.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildwithai-mcp-sampling-empty-'));
  try {
    const host = await startHost(emptyDir);
    const result = await host.callTool();
    assert.strictEqual(result.isError, true);
    assert.match(result.content[0].text, /No project found/);
    await host.close();
    console.log('  ✔ An uninitialized directory returns a helpful error.');
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
}

async function testSampledStep() {
  console.log('\n▶ Test: execute_step_sampled applies the host reply');
  const dir = createProject();
  try {
    const host = await startHost(dir);
    const result = await host.callTool({ maxTokens: 1234 });
    assert.ok(!result.isError, result.content[0].text);
    const summary = JSON.parse(result.content[0].text);

    const [sampleRequest] = host.samplingRequests;
    assert.strictEqual(host.samplingRequests.length, 1);
    assert.strictEqual(sampleRequest.params.maxTokens, 1234);
    assert.strictEqual(sampleRequest.params.includeContext, 'none');
    assert.match(sampleRequest.params.systemPrompt, /step 1 of \d+/);
    assert.match(sampleRequest.params.messages[0].content.text, /Sampling Demo/);
    assert.deepStrictEqual(
      sampleRequest.params.modelPreferences.hints.map((hint) => hint.name),
      ['Claude 3.5 Sonnet', 'GPT-4o'],
      'recommendedAI is split into model hints'
    );
    console.log('  ✔ The sampling request carries the step prompt, system prompt, maxTokens and model hints.');

    assert.strictEqual(summary.completedStep, 1);
    assert.strictEqual(summary.advancedToStep, 2);
    assert.strictEqual(summary.model, 'host-model');
    assert.deepStrictEqual(summary.filesWritten, [{ path: 'src/sampled.js', created: true, validationError: null }]);
    assert.deepStrictEqual(summary.skippedUnsafePaths, ['../escape.js']);
    assert.deepStrictEqual(summary.recordedDecisions, ['decisions.database']);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'src', 'sampled.js'), 'utf8'), 'export const ok = true;');
    assert.ok(!fs.existsSync(path.join(dir, '..', 'escape.js')), 'Unsafe paths are never written');
    assert.strictEqual(loadContext(dir).decisions.database, 'PostgreSQL');
    assert.strictEqual(loadState(dir).currentStep, 2);
    assert.strictEqual(loadHistory(1, dir), GOOD_REPLY);
    assert.ok(snapshotExists(dir, 1), 'An undo snapshot is saved');
    await host.close();
    console.log('  ✔ Files, decisions, history, snapshot and step advancement are applied.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testWriteGuards() {
  console.log('\n▶ Test: execute_step_sampled applies the next --run write guards');
  const guardedReply = [
    '```src/bad.js',
    'function ( {',
    '```',
    '```src/fine.js',
    'module.exports = 1;',
    '```',
    '```decisions',
    '{ "framework": "Express" }',
    '```',
    '```src/cut.js',
    'const partial = 1;'
  ].join('\n');
  const dir = createProject();
  try {
    const host = await startHost(dir, { onSample: () => textResult(guardedReply) });
    const preview = JSON.parse((await host.callTool({ dryRun: true })).content[0].text);
    assert.deepStrictEqual(preview.skippedTruncatedPaths, ['src/cut.js'], 'Dry runs report truncated blocks');

    const result = await host.callTool();
    assert.ok(!result.isError, result.content[0].text);
    const summary = JSON.parse(result.content[0].text);
    assert.deepStrictEqual(
      summary.filesWritten.map((file) => file.path),
      ['src/fine.js']
    );
    assert.deepStrictEqual(summary.skippedTruncatedPaths, ['src/cut.js']);
    assert.strictEqual(summary.skippedInvalidFiles.length, 1);
    assert.strictEqual(summary.skippedInvalidFiles[0].path, 'src/bad.js');
    assert.match(summary.skippedInvalidFiles[0].reason, /invalid syntax/);
    assert.ok(!fs.existsSync(path.join(dir, 'src', 'bad.js')), 'Invalid syntax is never written over MCP');
    assert.ok(!fs.existsSync(path.join(dir, 'src', 'cut.js')), 'Truncated blocks are never written over MCP');
    assert.deepStrictEqual(summary.recordedDecisions, ['decisions.framework'], 'Decisions are namespaced');
    assert.strictEqual(loadContext(dir).decisions.framework, 'Express');
    await host.close();
    console.log('  ✔ Truncated blocks, invalid syntax and decision namespacing match next --run.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testDryRunAndValidation() {
  console.log('\n▶ Test: execute_step_sampled dry run and argument validation');
  const dir = createProject();
  try {
    const host = await startHost(dir);
    for (const args of [{ maxTokens: 0 }, { maxTokens: 1.5 }, { maxTokens: 999999 }, { dryRun: 'yes' }]) {
      const invalid = await host.callTool(args);
      assert.strictEqual(invalid.isError, true, `Rejects ${JSON.stringify(args)}`);
    }
    assert.strictEqual(host.samplingRequests.length, 0, 'Invalid arguments never reach the client');

    const preview = await host.callTool({ dryRun: true });
    const body = JSON.parse(preview.content[0].text);
    assert.strictEqual(body.dryRun, true);
    assert.deepStrictEqual(body.files, ['src/sampled.js']);
    assert.deepStrictEqual(body.decisions, { 'decisions.database': 'PostgreSQL' });
    assert.strictEqual(body.response, GOOD_REPLY);
    assert.ok(!fs.existsSync(path.join(dir, 'src')), 'Dry run writes no files');
    assert.strictEqual(loadState(dir).currentStep, 1, 'Dry run does not advance');
    assert.strictEqual(loadContext(dir).decisions.database, undefined, 'Dry run records no decisions');
    assert.ok(!snapshotExists(dir, 1), 'Dry run takes no snapshot');
    await host.close();
    console.log('  ✔ Invalid arguments are rejected and dry runs change nothing.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function testFailures() {
  console.log('\n▶ Test: execute_step_sampled failure handling');
  const cases = [
    {
      name: 'client error',
      options: { onSample: () => ({ error: { code: -1, message: 'User rejected sampling request' } }) },
      expected: /Sampling failed: The client rejected sampling\/createMessage: User rejected/
    },
    {
      name: 'non-text reply',
      options: { onSample: () => ({ result: { role: 'assistant', content: { type: 'image', data: 'x' } } }) },
      expected: /without text content/
    },
    {
      name: 'timeout',
      options: { onSample: () => undefined, requestTimeoutMs: 50 },
      expected: /did not answer sampling\/createMessage/
    },
    {
      name: 'workflow moved while generating',
      options: {
        onSample: (request) => {
          const cwd = request.__cwd;
          const state = loadState(cwd);
          state.currentStep = 2;
          state.completedSteps = [1];
          saveState(state, cwd);
          return textResult(GOOD_REPLY);
        }
      },
      expected: /moved off step 1/
    }
  ];

  for (const testCase of cases) {
    const dir = createProject();
    try {
      const onSample = testCase.options.onSample;
      const host = await startHost(dir, {
        ...testCase.options,
        onSample: (request) => onSample(Object.assign(request, { __cwd: dir }))
      });
      const result = await host.callTool();
      assert.strictEqual(result.isError, true, `${testCase.name} is an error`);
      assert.match(result.content[0].text, testCase.expected);
      assert.ok(!fs.existsSync(path.join(dir, 'src')), `${testCase.name} writes no files`);
      assert.ok(!snapshotExists(dir, 1), `${testCase.name} leaves no snapshot`);
      assert.strictEqual(loadContext(dir).decisions.database, undefined, `${testCase.name} records nothing`);
      await host.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log('  ✔ Client errors, non-text replies, timeouts and stale steps change nothing.');

  const dir = createProject();
  try {
    let release;
    const host = await startHost(dir, {
      onSample: () =>
        new Promise((resolve) => {
          release = () => resolve(textResult(GOOD_REPLY));
        })
    });
    const first = host.callTool();
    while (host.samplingRequests.length === 0) await new Promise((resolve) => setImmediate(resolve));
    const second = await host.callTool();
    assert.strictEqual(second.isError, true);
    assert.match(second.content[0].text, /still running/);
    release();
    assert.ok(!(await first).isError, 'The first call completes');
    assert.strictEqual(host.samplingRequests.length, 1, 'Only one sampling request is sent');
    assert.strictEqual(loadState(dir).currentStep, 2, 'The step advances exactly once');
    await host.close();
    console.log('  ✔ Concurrent calls are refused while a sampled step is running.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const closeDir = createProject();
  try {
    const host = await startHost(closeDir, { onSample: () => undefined });
    const pendingCall = host.callTool();
    while (host.samplingRequests.length === 0) await new Promise((resolve) => setImmediate(resolve));
    await host.close();
    const result = await Promise.race([pendingCall, new Promise((resolve) => setTimeout(() => resolve('hung'), 1000))]);
    assert.notStrictEqual(result, 'hung', 'Closing stdin settles the pending tool call');
    assert.strictEqual(loadState(closeDir).currentStep, 1);
    console.log('  ✔ Closing the connection mid-sampling shuts down cleanly without changes.');
  } finally {
    fs.rmSync(closeDir, { recursive: true, force: true });
  }
}

let completed = false;
// A pending promise with nothing keeping the event loop alive would end the
// process early with exit code 0; treat that as a failure.
process.on('exit', (code) => {
  if (!completed && code === 0) {
    console.error('MCP tests exited before finishing.');
    process.exitCode = 1;
  }
});

async function runTests() {
  await testSessionRouting();
  await testParseSamplingResult();
  await testCapabilityNegotiation();
  await testSampledStep();
  await testWriteGuards();
  await testDryRunAndValidation();
  await testFailures();
  completed = true;
  console.log('\nAll MCP tests passed.');
}

runTests().catch((err) => {
  console.error('MCP test failed:', err);
  process.exit(1);
});
