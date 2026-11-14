const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { initState, loadState, loadContext } = require('../lib/state');
const { getTemplate } = require('../lib/promptEngine');
const { parseMaxRetries, runVerificationCommand, buildSelfHealingPrompt } = require('../lib/verify');

const cli = path.join(__dirname, '..', 'bin', 'cli.js');

function runCli(args, cwd, env = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, BUILD_WITH_AI_NO_COPY: '1', ...env }
  });
  assert.ifError(result.error);
  result.output = `${result.stdout || ''}${result.stderr || ''}`;
  return result;
}

function freshProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildwithai-verify-'));
  const template = getTemplate('web-app');
  initState(
    {
      projectName: 'Verify Demo',
      templateId: 'web-app',
      templateTitle: template.title,
      experienceLevel: 'Beginner',
      projectIdea: 'Verify the closed-loop retry',
      totalSteps: template.steps.length
    },
    dir
  );
  // check.js fails while the step file still contains the BROKEN marker.
  fs.writeFileSync(
    path.join(dir, 'check.js'),
    "const fs = require('fs');\n" +
      'try {\n' +
      "  process.exit(fs.readFileSync('src/app.js', 'utf8').includes('BROKEN') ? 1 : 0);\n" +
      '} catch {\n' +
      '  process.exit(1);\n' +
      '}\n',
    'utf8'
  );
  return dir;
}

function mockAiPreload(dir, replies) {
  const bodies = replies.map((content) => JSON.stringify({ choices: [{ message: { content } }] }));
  const preload = path.join(dir, 'mock-ai.js');
  const source =
    `const responses = ${JSON.stringify(bodies)};\n` +
    'let callIndex = 0;\n' +
    'globalThis.fetch = async () => ({\n' +
    '  ok: true,\n' +
    '  text: async () => responses[Math.min(callIndex++, responses.length - 1)]\n' +
    '});\n';
  fs.writeFileSync(preload, source, 'utf8');
  return preload;
}

function runWithMockAi(args, dir, preload) {
  return spawnSync(process.execPath, ['--require', preload, cli, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, BUILD_WITH_AI_NO_COPY: '1' }
  });
}

const brokenReply = [
  'First attempt — still broken.',
  '',
  '```src/app.js',
  '// BROKEN',
  "throw new Error('not implemented');",
  '```',
  '',
  '```decisions',
  '{"database": "MySQL"}',
  '```',
  ''
].join('\n');

const fixedReply = [
  'Fixed the implementation.',
  '',
  '```src/app.js',
  "console.log('fixed');",
  '```',
  '',
  '```decisions',
  '{"database": "PostgreSQL"}',
  '```',
  ''
].join('\n');

function runTests() {
  // --max-retries parsing.
  assert.strictEqual(parseMaxRetries(undefined), 2, 'Omitted retries default to 2');
  assert.strictEqual(parseMaxRetries('0'), 0, 'Zero retries is allowed');
  assert.strictEqual(parseMaxRetries('3'), 3);
  assert.strictEqual(parseMaxRetries(1), 1);
  assert.throws(() => parseMaxRetries('abc'), /Invalid --max-retries/);
  assert.throws(() => parseMaxRetries('-1'), /Invalid --max-retries/);
  assert.throws(() => parseMaxRetries('1.5'), /Invalid --max-retries/);
  console.log('  ✔ --max-retries parsing rejects bad values.');

  // Verification command runner.
  let verification = runVerificationCommand(`"${process.execPath}" -e "process.exit(0)"`);
  assert.strictEqual(verification.ok, true);
  assert.strictEqual(verification.exitCode, 0);
  verification = runVerificationCommand(`"${process.execPath}" -e "console.error('boom'); process.exit(3)"`);
  assert.strictEqual(verification.ok, false);
  assert.strictEqual(verification.exitCode, 3);
  assert(verification.output.includes('boom'), 'Failure output is captured');
  verification = runVerificationCommand('definitely-not-a-real-command-xyz');
  assert.strictEqual(verification.ok, false, 'A missing command fails instead of crashing');
  verification = runVerificationCommand(`"${process.execPath}" -e "setTimeout(() => {}, 30000)"`, process.cwd(), {
    timeoutMs: 200
  });
  assert.strictEqual(verification.ok, false);
  assert.strictEqual(verification.timedOut, true);
  console.log('  ✔ Verification commands report pass, failure, missing commands and timeouts.');

  // The self-healing prompt carries what the model needs to fix the code.
  const prompt = buildSelfHealingPrompt({
    command: 'npm test',
    verification: { exitCode: 1, output: 'TypeError: undefined is not a function', timedOut: false },
    stepNum: 2,
    totalSteps: 5
  });
  assert(prompt.includes('npm test'), 'Prompt names the failing command');
  assert(prompt.includes('exit'), 'Prompt reports the failure');
  assert(prompt.includes('TypeError'), 'Prompt includes the captured output');
  assert(prompt.includes('step 2 of 5'), 'Prompt names the step');
  console.log('  ✔ The self-healing prompt carries the command, exit code and output.');

  // End to end: a failing first attempt is healed by the retry, and only
  // the passing attempt's decisions are recorded.
  const dir = freshProject();
  try {
    const preload = mockAiPreload(dir, [brokenReply, fixedReply]);
    const result = runWithMockAi(
      ['next', '--run', '--provider', 'ollama', '--verify', 'node check.js', '--max-retries', '2'],
      dir,
      preload
    );
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.strictEqual(result.status, 0, output);
    assert(output.includes('Verification failed'), 'The failed first attempt is reported');
    assert(output.includes('Verification passed'), 'The passing retry is reported');
    assert.strictEqual(
      fs.readFileSync(path.join(dir, 'src', 'app.js'), 'utf8'),
      "console.log('fixed');",
      'The retried file content wins'
    );
    const state = loadState(dir);
    assert.strictEqual(state.currentStep, 2, 'The step advances after the passing retry');
    assert.deepStrictEqual(state.completedSteps, [1]);
    const context = loadContext(dir);
    assert.strictEqual(context.decisions.database, 'PostgreSQL', 'Only the passing attempt records decisions');
    console.log('  ✔ A failed verification triggers a self-healing retry and the step advances.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // End to end: exhausted retries leave the step open — never advanced on
  // failing code — with the last attempt's files on disk for review.
  const stuckDir = freshProject();
  try {
    const preload = mockAiPreload(stuckDir, [brokenReply]);
    const result = runWithMockAi(
      ['next', '--run', '--provider', 'ollama', '--verify', 'node check.js', '--max-retries', '1'],
      stuckDir,
      preload
    );
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.notStrictEqual(result.status, 0, 'Exhausted retries must fail the command');
    assert(output.includes('was NOT advanced'), 'The failure explains the step was not advanced');
    assert(output.includes('undo'), 'The failure points at the rollback path');
    const state = loadState(stuckDir);
    assert.strictEqual(state.currentStep, 1, 'The step stays open');
    assert.deepStrictEqual(state.completedSteps, []);
    const context = loadContext(stuckDir);
    assert.strictEqual(context.decisions.database, undefined, 'Failed attempts record no decisions');
    assert(
      fs.readFileSync(path.join(stuckDir, 'src', 'app.js'), 'utf8').includes('BROKEN'),
      'The last attempt files stay on disk for review'
    );
    assert(fs.existsSync(path.join(stuckDir, '.buildwithai', 'snapshots', 'step-01.json')), 'Undo snapshot exists');
    console.log('  ✔ Exhausted retries fail without advancing, recording decisions, or losing the snapshot.');
  } finally {
    fs.rmSync(stuckDir, { recursive: true, force: true });
  }

  // --verify without --run is ignored with a warning, not an error.
  const plainDir = freshProject();
  try {
    const result = runCli(['next', '--verify', 'node check.js'], plainDir);
    assert.strictEqual(result.status, 0, result.output);
    assert(result.output.includes('--verify only applies with --run'), 'The ignored flag is explained');
    assert.strictEqual(loadState(plainDir).currentStep, 1, 'Nothing advances');
    console.log('  ✔ --verify without --run warns and is ignored.');
  } finally {
    fs.rmSync(plainDir, { recursive: true, force: true });
  }

  // An invalid --max-retries fails fast with guidance.
  const badDir = freshProject();
  try {
    const preload = mockAiPreload(badDir, [fixedReply]);
    const result = runWithMockAi(
      ['next', '--run', '--provider', 'ollama', '--verify', 'node check.js', '--max-retries', 'abc'],
      badDir,
      preload
    );
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    assert.notStrictEqual(result.status, 0, 'Invalid --max-retries must fail');
    assert(output.includes('Invalid --max-retries'), 'The failure names the bad value');
    console.log('  ✔ Invalid --max-retries fails fast.');
  } finally {
    fs.rmSync(badDir, { recursive: true, force: true });
  }

  console.log('Verification loop tests passed.');
}

runTests();
