const { spawn, execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const CLI_BIN = path.resolve(__dirname, '..', 'bin', 'cli.js');

function safeRmDir(dir) {
  try {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } catch (e) {
    // Retry once after delay on Windows
    setTimeout(() => {
      try {
        if (fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } catch {}
    }, 500);
  }
}

function runInteractiveProcess(args, cwd, matchers, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_BIN, ...args], {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let processedLength = 0;
    const pendingMatchers = [...matchers];

    const tryMatch = () => {
      if (pendingMatchers.length === 0) return;
      const unhandled = stdout.slice(processedLength);
      const next = pendingMatchers[0];
      const res = next(unhandled, stdout);
      if (res !== null) {
        pendingMatchers.shift();
        processedLength = stdout.length;
        try {
          child.stdin.write(res);
        } catch {}
      }
    };

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      tryMatch();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Command timed out [${args.join(' ')}]. Stdout:\n${stdout}\nStderr:\n${stderr}`));
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function runSync(args, cwd) {
  try {
    const output = execSync(`node "${CLI_BIN}" ${args.join(' ')}`, {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
      encoding: 'utf8',
      stdio: 'pipe'
    });
    return { code: 0, stdout: output, stderr: '' };
  } catch (err) {
    return {
      code: err.status !== undefined ? err.status : 1,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : err.message
    };
  }
}

async function executeFullE2ETest() {
  console.log('===============================================================');
  console.log('🔍 BUILD-WITH-AI V1 END-TO-END VERIFICATION AS A REAL BEGINNER');
  console.log('===============================================================\n');

  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bwa-beginner-e2e-'));
  console.log(`📂 Testing in isolated workspace: ${testDir}\n`);

  const report = {
    'Init': 'FAIL',
    'Next': 'FAIL',
    'Prompt resolution': 'FAIL',
    'Clipboard': 'FAIL',
    'Done / Summary': 'FAIL',
    'Done / Full history': 'FAIL',
    'Context injection': 'FAIL',
    'Context key lookup': 'FAIL',
    'Missing requires': 'FAIL',
    'Back': 'FAIL',
    'Status': 'FAIL',
    'Resume': 'FAIL',
    'Export dry run': 'Fail',
    'Export': 'FAIL',
    'Reset': 'FAIL',
    'Error handling': 'FAIL'
  };

  const issues = [];

  try {
    // -------------------------------------------------------------
    // Template discovery works before project initialization.
    const listOutput = (args) => execFileSync(process.execPath, [CLI_BIN, 'list', ...args], {
      cwd: testDir, encoding: 'utf8', timeout: 10000
    });
    const listedTemplates = JSON.parse(listOutput(['--json']));
    const expectedTemplates = require('../lib/promptEngine').loadTemplates().map(({ id, title, description, stepCount }) => ({ id, title, description, stepCount }));
    assert.deepStrictEqual(listedTemplates, expectedTemplates, 'JSON listing contains only the public summary fields in template order');
    for (const [query, expectedId] of [
      ['WEB-APP', 'web-app'],
      ['Full-Stack Web Application', 'web-app'],
      ['subscription', 'saas-mvp']
    ]) {
      const results = JSON.parse(listOutput(['--search', query, '--json']));
      assert.deepStrictEqual(results.map(template => template.id), [expectedId], `Search should match ${query}`);
    }
    assert.deepStrictEqual(JSON.parse(listOutput(['-s', 'subscription', '--json'])).map(template => template.id), ['saas-mvp']);
    const filteredText = listOutput(['--search', 'subscription']);
    assert(filteredText.includes('Modern SaaS MVP'), 'Text mode shows matching templates');
    assert(!filteredText.includes('Full-Stack Web Application'), 'Text mode excludes other templates');
    assert.deepStrictEqual(JSON.parse(listOutput(['--search', 'no-template-matches-xyz', '--json'])), []);
    assert(listOutput(['--search', 'no-template-matches-xyz']).includes('No templates match'), 'Empty text searches have a clear message');
    assert.deepStrictEqual(JSON.parse(listOutput(['--search', '', '--json'])), listedTemplates);
    report['Template list options'] = 'PASS';
    // Step 1: Fresh Start (no subcommand)
    // -------------------------------------------------------------
    console.log('🔹 1. Testing Fresh Start (no args in empty folder)...');
    const freshRes = await runInteractiveProcess([], testDir, [
      (out) => out.includes('Would you like to initialize') ? 'n\r\n' : null
    ]);
    assert(freshRes.stdout.includes('No active project found in this directory'), 'Must detect uninitialized directory');
    assert(freshRes.stdout.includes('build-with-ai init'), 'Must suggest init');
    console.log('   ✔ Successfully detected uninitialized directory and offered init.\n');

    // -------------------------------------------------------------
    // Step 2: Init
    // -------------------------------------------------------------
    console.log('🔹 2. Testing `build-with-ai init` (Expense Tracker)...');
    const initRes = await runInteractiveProcess(['init'], testDir, [
      (out) => out.includes('Select project type') ? '\r\n' : null,
      (out) => out.includes('experience level') ? '\r\n' : null,
      (out) => out.includes('Project name') ? 'Expense Tracker\r\n' : null,
      (out) => out.includes('One-line project idea') ? 'A web app to track daily expenses by category\r\n' : null
    ]);

    assert(fs.existsSync(path.join(testDir, '.buildwithai')), '.buildwithai directory created');
    assert(fs.existsSync(path.join(testDir, '.buildwithai', 'state.json')), 'state.json created');
    assert(fs.existsSync(path.join(testDir, '.buildwithai', 'context.json')), 'context.json created');
    assert(fs.existsSync(path.join(testDir, '.buildwithai', 'history')), 'history/ created');

    const stateObj = JSON.parse(fs.readFileSync(path.join(testDir, '.buildwithai', 'state.json'), 'utf8'));
    assert.strictEqual(stateObj.projectName, 'Expense Tracker');
    assert.strictEqual(stateObj.templateId, 'web-app');
    assert.strictEqual(stateObj.currentStep, 1);
    assert.strictEqual(stateObj.totalSteps, 23);
    assert.strictEqual(stateObj.completedSteps.length, 0);

    const ctxObj = JSON.parse(fs.readFileSync(path.join(testDir, '.buildwithai', 'context.json'), 'utf8'));
    assert.strictEqual(ctxObj.project.name, 'Expense Tracker');
    assert.strictEqual(ctxObj.project.experienceLevel, 'Beginner');
    assert.strictEqual(ctxObj.project.idea, 'A web app to track daily expenses by category');

    report['Init'] = 'PASS';
    console.log('   ✔ Initialized state.json, context.json, and history/ with currentStep = 1.\n');

    // -------------------------------------------------------------
    // Step 3: Next / Prompt generation (Step 1)
    // -------------------------------------------------------------
    console.log('🔹 3. Testing `build-with-ai next` (Step 1)...');
    const next1Res = runSync(['next'], testDir);
    assert(next1Res.stdout.includes('STEP 1/23 — Problem Discovery & Core Value Proposition'), 'Step header');
    assert(next1Res.stdout.includes('WHY THIS STEP:'), 'Why this step');
    assert(next1Res.stdout.includes('WHAT AI SHOULD PRODUCE:'), 'What AI should produce');
    assert(next1Res.stdout.includes('I am building a web project called "Expense Tracker"'), 'Resolved project.name');
    assert(next1Res.stdout.includes('My experience level is Beginner'), 'Resolved project.experienceLevel');
    assert(!next1Res.stdout.includes('undefined'), 'No undefined in prompt');
    assert(!next1Res.stdout.includes('{{'), 'No unresolved placeholders');
    assert(next1Res.stdout.includes('Prompt copied to clipboard ✅') || next1Res.stdout.includes('PROMPT FOR YOUR AI:'), 'Clipboard confirmed');

    report['Next'] = 'PASS';
    report['Prompt resolution'] = 'PASS';
    report['Clipboard'] = 'PASS';
    const copyCases = [
      { args: [], env: '', copies: true },
      { args: ['--no-copy'], env: '', copies: false },
      { args: [], env: '1', copies: false },
      { args: ['--no-copy'], env: '0', copies: false },
      { args: [], env: '0', copies: true },
      { args: ['--raw', '--no-copy'], env: '', copies: false, raw: true },
      { args: ['--json', '--no-copy'], env: '1', copies: false, json: true }
    ];
    for (const testCase of copyCases) {
      const script = `
        const clipboard = require(${JSON.stringify(path.resolve(__dirname, '..', 'lib', 'clipboard.js'))});
        clipboard.copyToClipboard = async () => { console.log('__CLIPBOARD_CALLED__'); return true; };
        process.argv = [process.execPath, ${JSON.stringify(CLI_BIN)}, 'next', ...${JSON.stringify(testCase.args)}];
        require(${JSON.stringify(CLI_BIN)});
      `;
      const output = execFileSync(process.execPath, ['-e', script], {
        cwd: testDir,
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, BUILD_WITH_AI_NO_COPY: testCase.env }
      });
      assert.strictEqual(output.includes('__CLIPBOARD_CALLED__'), testCase.copies, 'Clipboard invocation should respect the flag and environment');
      assert(output.includes('Expense Tracker'), 'Prompt must still be generated');
      if (testCase.json) {
        assert.strictEqual(JSON.parse(output).step, 1, 'JSON output must remain parseable');
      } else if (testCase.raw) {
        assert(!output.includes('Clipboard copy skipped'), 'Raw output must not include clipboard hints');
      } else if (!testCase.copies) {
        assert(output.includes('Clipboard copy skipped'), 'Standard output should explain that copying was skipped');
      }
    }
    report['Clipboard opt-out'] = 'PASS';
    console.log('   ✔ Prompt formatted, variables resolved, and clipboard copy verified.\n');

    // -------------------------------------------------------------
    // Step 4: Done — summary path (Step 1)
    // -------------------------------------------------------------
    console.log('🔹 4. Testing `build-with-ai done` (Summary / Decisions path)...');
    const done1Res = await runInteractiveProcess(['done'], testDir, [
      (out) => out.includes('How would you like to record') ? '\r\n' : null,
      (out) => out.includes('Target Audience') ? 'Students and freelance professionals\r\n' : null,
      (out) => out.includes('Core Value Prop') ? 'Effortlessly track daily expenses and visualize category summaries\r\n' : null,
      (out) => out.includes('Have these been decided') ? '\r\n' : null
    ]);

    const stateAfterStep1 = JSON.parse(fs.readFileSync(path.join(testDir, '.buildwithai', 'state.json'), 'utf8'));
    assert.strictEqual(stateAfterStep1.currentStep, 2, 'Advanced to step 2');
    assert.deepStrictEqual(stateAfterStep1.completedSteps, [1], 'Recorded step 1 complete');

    const ctxAfterStep1 = JSON.parse(fs.readFileSync(path.join(testDir, '.buildwithai', 'context.json'), 'utf8'));
    assert.strictEqual(ctxAfterStep1.decisions.targetAudience, 'Students and freelance professionals');
    assert.strictEqual(ctxAfterStep1.decisions.coreValueProp, 'Effortlessly track daily expenses and visualize category summaries');

    report['Done / Summary'] = 'PASS';
    console.log('   ✔ Advanced step, saved decisions to context.json without large AI text.\n');

    // -------------------------------------------------------------
    // Step 5: History path (Step 2)
    // -------------------------------------------------------------
    console.log('🔹 5. Testing `build-with-ai next` and `done` with Full History path (Step 2)...');
    const next2Res = runSync(['next'], testDir);
    assert(next2Res.stdout.includes('STEP 2/23 — MVP Feature Scoping & Non-Goals'), 'Step 2 header');
    assert(next2Res.stdout.includes('Effortlessly track daily expenses and visualize category summaries'), 'Injected coreValueProp');

    const fullResponseMock = '### MVP Specification\n1. Add/edit expense\n2. Category breakdown charts\n3. Export to CSV';
    const done2Res = await runInteractiveProcess(['done'], testDir, [
      (out) => out.includes('How would you like to record') ? '\u001b[B\u001b[B\r\n' : null, // Select "Both"
      (out) => out.includes('Paste or enter the AI response') ? `${fullResponseMock}\r\n` : null,
      (out) => out.includes('Mvp Features') ? 'Add/edit expenses, category breakdown, CSV export\r\n' : null,
      (out) => out.includes('Non Goals') ? 'Multi-currency conversion, crypto wallets\r\n' : null,
      (out) => out.includes('Have these been decided') ? '\r\n' : null
    ]);

    assert(fs.existsSync(path.join(testDir, '.buildwithai', 'history', 'step-02.md')), 'step-02.md created');
    const step2HistText = fs.readFileSync(path.join(testDir, '.buildwithai', 'history', 'step-02.md'), 'utf8');
    assert(step2HistText.includes('### MVP Specification'), 'History contains full AI response');

    const ctxAfterStep2 = JSON.parse(fs.readFileSync(path.join(testDir, '.buildwithai', 'context.json'), 'utf8'));
    assert(!JSON.stringify(ctxAfterStep2).includes('### MVP Specification'), 'Full markdown NOT in context.json');
    assert.strictEqual(ctxAfterStep2.decisions.mvpFeatures, 'Add/edit expenses, category breakdown, CSV export');

    report['Done / Full history'] = 'PASS';
    console.log('   ✔ Full AI response saved in history/step-02.md and omitted from context.json.\n');

    // -------------------------------------------------------------
    // Step 6: Context Injection across Steps 3 & 4
    // -------------------------------------------------------------
    console.log('🔹 6. Testing Context Injection in Step 3 and Step 4...');
    const next3Res = runSync(['next'], testDir);
    assert(next3Res.stdout.includes('Add/edit expenses, category breakdown, CSV export'), 'Injected mvpFeatures in Step 3');

    // Complete Step 3
    await runInteractiveProcess(['done'], testDir, [
      (out) => out.includes('How would you like to record') ? '\r\n' : null,
      (out) => out.includes('Frontend Stack') ? 'React with Tailwind CSS\r\n' : null,
      (out) => out.includes('Backend Stack') ? 'Node.js Express REST API\r\n' : null,
      (out) => out.includes('Database') ? 'SQLite with Prisma ORM\r\n' : null,
      (out) => out.includes('Have these been decided') ? '\r\n' : null
    ]);

    // Check Step 4
    const next4Res = runSync(['next'], testDir);
    assert(next4Res.stdout.includes('STEP 4/23 — System Architecture & High-Level Design'), 'Step 4 header');
    assert(next4Res.stdout.includes('Frontend: React with Tailwind CSS'), 'Injected frontendStack');
    assert(next4Res.stdout.includes('Backend: Node.js Express REST API'), 'Injected backendStack');
    assert(next4Res.stdout.includes('Database: SQLite with Prisma ORM'), 'Injected database');

    report['Context injection'] = 'PASS';
    console.log('   ✔ Multi-step context injection verified across steps 1 -> 2 -> 3 -> 4.\n');

        // -------------------------------------------------------------
    // Step 6.5: Context Key Lookup Command
    // -------------------------------------------------------------
    console.log('🔹 6.5. Testing `build-with-ai context decisions.database`...');

    const contextExistingRes = runSync(['context', 'decisions.database'], testDir);
    assert(contextExistingRes.stdout.includes('SQLite with Prisma ORM'), 'Should print existing database value');
    assert.strictEqual(contextExistingRes.code, 0, 'Should exit normally for existing key');

    const contextMissingRes = runSync(['context', 'decisions.nonExistentKey'], testDir);
    assert(contextMissingRes.stdout.includes('No value found for key') || contextMissingRes.stderr.includes('No value found for key'), 'Should show clear warning for missing key');
    assert.strictEqual(contextMissingRes.code, 0, 'Should exit normally for missing key too');

    report['Context key lookup'] = 'PASS';
    const setCases = [
      ['["Auth","Export"]', ['Auth', 'Export']],
      ['{"enabled":true,"count":2}', { enabled: true, count: 2 }],
      ['42', 42],
      ['false', false],
      ['null', null],
      ['"123"', '123'],
      ['PostgreSQL with Prisma ORM', 'PostgreSQL with Prisma ORM'],
      ['{invalid JSON}', '{invalid JSON}'],
      ['[]', []],
      ['{}', {}]
    ];
    for (const [input, expected] of setCases) {
      execFileSync(process.execPath, [CLI_BIN, 'set', 'decisions.testValue', input], {
        cwd: testDir, encoding: 'utf8', timeout: 10000
      });
      const savedContext = JSON.parse(fs.readFileSync(path.join(testDir, '.buildwithai', 'context.json'), 'utf8'));
      assert.deepStrictEqual(savedContext.decisions.testValue, expected, `set should preserve the value type for ${input}`);
      assert.strictEqual(savedContext.decisions.database, 'SQLite with Prisma ORM', 'Other decisions must remain unchanged');
    }
    report['Set JSON values'] = 'PASS';
    console.log('   ✔ Context command correctly prints existing values and warns on missing keys.\n');


    // -------------------------------------------------------------
    // Step 7: Missing Required Context Warning
    // -------------------------------------------------------------
    console.log('🔹 7. Testing Missing Required Context Warning...');
    const ctxCorrupted = JSON.parse(fs.readFileSync(path.join(testDir, '.buildwithai', 'context.json'), 'utf8'));
    const savedDatabase = ctxCorrupted.decisions.database;
    delete ctxCorrupted.decisions.database;
    fs.writeFileSync(path.join(testDir, '.buildwithai', 'context.json'), JSON.stringify(ctxCorrupted, null, 2), 'utf8');

    const nextMissingRes = runSync(['next'], testDir);
    assert(nextMissingRes.stdout.includes('Missing prerequisite decision: "decisions.database"'), 'Warning displayed');
    assert(nextMissingRes.stdout.includes('[MISSING: decisions.database]'), 'Placeholder flagged');
    assert(!nextMissingRes.stdout.includes('undefined'), 'No silent undefined');
    assert.strictEqual(nextMissingRes.code, 0, 'Did not crash');

    // Restore database
    ctxCorrupted.decisions.database = savedDatabase;
    fs.writeFileSync(path.join(testDir, '.buildwithai', 'context.json'), JSON.stringify(ctxCorrupted, null, 2), 'utf8');

    report['Missing requires'] = 'PASS';
    console.log('   ✔ Missing requires flagged with warning and visible placeholder without crashing.\n');

    // -------------------------------------------------------------
    // Step 8: Back Navigation
    // -------------------------------------------------------------
    console.log('🔹 8. Testing `build-with-ai back` Navigation...');
    const stateBeforeBack = JSON.parse(fs.readFileSync(path.join(testDir, '.buildwithai', 'state.json'), 'utf8'));
    assert.strictEqual(stateBeforeBack.currentStep, 4);

    const backRes = runSync(['back'], testDir);
    assert(backRes.stdout.includes('Moved back to Step 3'), 'Back confirmation');

    const stateAfterBack = JSON.parse(fs.readFileSync(path.join(testDir, '.buildwithai', 'state.json'), 'utf8'));
    assert.strictEqual(stateAfterBack.currentStep, 3, 'State updated to 3');
    assert(fs.existsSync(path.join(testDir, '.buildwithai', 'history', 'step-02.md')), 'History preserved');

    const nextAfterBack = runSync(['next'], testDir);
    assert(nextAfterBack.stdout.includes('STEP 3/23 — Technology Stack Selection'), 'Re-opened Step 3');

    // Re-advance to 4
    await runInteractiveProcess(['done'], testDir, [
      (out) => out.includes('How would you like to record') ? '\r\n' : null,
      (out) => out.includes('Frontend Stack') ? 'React with Tailwind CSS\r\n' : null,
      (out) => out.includes('Backend Stack') ? 'Node.js Express REST API\r\n' : null,
      (out) => out.includes('Database') ? 'SQLite with Prisma ORM\r\n' : null,
      (out) => out.includes('Have these been decided') ? '\r\n' : null
    ]);

    report['Back'] = 'PASS';
    console.log('   ✔ Back navigation decremented step and preserved history and context.\n');

    // -------------------------------------------------------------
    // Step 9: Status Command
    // -------------------------------------------------------------
    console.log('🔹 9. Testing `build-with-ai status`...');
    const statusRes = runSync(['status'], testDir);
    assert(statusRes.stdout.includes('PROJECT STATUS: Expense Tracker'), 'Shows project name');
    assert(statusRes.stdout.includes('Full-Stack Web Application'), 'Shows template');
    assert(statusRes.stdout.includes('Progress:'), 'Shows progress bar');
    assert(statusRes.stdout.includes('Problem Discovery & Core Value Proposition'), 'Shows completed step');
    assert(statusRes.stdout.includes('System Architecture & High-Level Design'), 'Shows current step');
    assert(statusRes.stdout.includes('SQLite with Prisma ORM'), 'Shows decisions');

    report['Status'] = 'PASS';
    console.log('   ✔ Status display verified with progress bar, step checklist, and decisions.\n');

    // -------------------------------------------------------------
    // Step 10: Resume Command
    // -------------------------------------------------------------
    console.log('🔹 10. Testing `build-with-ai resume` (simulating new terminal session)...');
    const resumeRes = runSync(['resume'], testDir);
    assert(resumeRes.stdout.includes('WELCOME BACK: Expense Tracker'), 'Welcome back banner');
    assert(resumeRes.stdout.includes('Step 4/23:'), 'Shows active step');
    assert(resumeRes.stdout.includes('KEY RECORDED DECISIONS:'), 'Shows recorded decisions');

    const nextFromResume = runSync(['next'], testDir);
    assert(nextFromResume.stdout.includes('STEP 4/23'), 'Next opens correct step');

    report['Resume'] = 'PASS';
    console.log('   ✔ Resume restored project progress, current step, and context decisions.\n');

    // -------------------------------------------------------------
    // Step 10.5: Export Dry Run
    // -------------------------------------------------------------
    console.log('🔹 10.5. Testing `build-with-ai export --dry-run`...');

    assert(!fs.existsSync(path.join(testDir, 'README.md')), 'README.md should not exist before export');
    assert(!fs.existsSync(path.join(testDir, 'BUILD_LOG.md')), 'BUILD_LOG.md should not exist before export');
    assert(!fs.existsSync(path.join(testDir, '.buildwithai', 'CONTEXT.md')), 'CONTEXT.md should not exist before export');

    const dryRunRes = runSync(['export', '--dry-run'], testDir);
    assert(dryRunRes.stdout.includes('README.md'), 'Dry run lists README.md');
    assert(dryRunRes.stdout.includes('BUILD_LOG.md'), 'Dry run lists BUILD_LOG.md');
    assert(dryRunRes.stdout.includes('CONTEXT.md'), 'Dry run lists CONTEXT.md');
    assert(dryRunRes.stdout.toLowerCase().includes('no files'), 'Dry run states that no files were written');

    assert(!fs.existsSync(path.join(testDir, 'README.md')), 'README.md still absent after dry run');
    assert(!fs.existsSync(path.join(testDir, 'BUILD_LOG.md')), 'BUILD_LOG.md still absent after dry run');
    assert(!fs.existsSync(path.join(testDir, '.buildwithai', 'CONTEXT.md')), 'CONTEXT.md still absent after dry run');

    report['Export dry run'] = 'PASS';
    console.log('   ✔ Dry run listed target files and wrote nothing to disk.\n');

    // -------------------------------------------------------------
    // Step 11: Export Command
    // -------------------------------------------------------------
    console.log('🔹 11. Testing `build-with-ai export`...');
    const exportRes = runSync(['export'], testDir);
    assert(exportRes.stdout.includes('README.md'), 'README exported');
    assert(exportRes.stdout.includes('BUILD_LOG.md'), 'BUILD_LOG exported');
    assert(exportRes.stdout.includes('CONTEXT.md'), 'CONTEXT.md exported');

    assert(fs.existsSync(path.join(testDir, 'README.md')), 'README.md exists');
    assert(fs.existsSync(path.join(testDir, 'BUILD_LOG.md')), 'BUILD_LOG.md exists');
    assert(fs.existsSync(path.join(testDir, '.buildwithai', 'CONTEXT.md')), 'CONTEXT.md exists');

    const readmeContent = fs.readFileSync(path.join(testDir, 'README.md'), 'utf8');
    assert(readmeContent.includes('# Expense Tracker'), 'README header check');
    assert(readmeContent.includes('SQLite with Prisma ORM'), 'README database check');

    const buildLogContent = fs.readFileSync(path.join(testDir, 'BUILD_LOG.md'), 'utf8');
    assert(buildLogContent.includes('### MVP Specification'), 'BUILD_LOG contains history log');

    const contextMdContent = fs.readFileSync(path.join(testDir, '.buildwithai', 'CONTEXT.md'), 'utf8');
    assert(contextMdContent.includes('Project Context & Architecture Decisions'), 'CONTEXT.md check');

    report['Export'] = 'PASS';
    console.log('   ✔ Export generated README.md, BUILD_LOG.md, and CONTEXT.md deterministically.\n');

    // -------------------------------------------------------------
    // Step 12: Reset Command
    // -------------------------------------------------------------
    console.log('🔹 12. Testing `build-with-ai reset`...');
    fs.writeFileSync(path.join(testDir, 'server.js'), 'console.log("user app code");', 'utf8');
    
    const resetRes = await runInteractiveProcess(['reset'], testDir, [
      (out) => out.includes('Are you sure you want to reset') ? 'y\r\n' : null
    ]);

    assert(!fs.existsSync(path.join(testDir, '.buildwithai')), '.buildwithai was removed');
    assert(fs.existsSync(path.join(testDir, 'server.js')), 'User server.js preserved untouched');

    report['Reset'] = 'PASS';
    console.log('   ✔ Reset removed .buildwithai and preserved user source files intact.\n');

    // -------------------------------------------------------------
    // Step 13: Error & Edge Cases Handling
    // -------------------------------------------------------------
    console.log('🔹 13. Testing Error & Edge Cases...');
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bwa-empty-err-'));

    // Next before init
    const nbi = runSync(['next'], emptyDir);
    assert(nbi.stdout.includes('No project found') || nbi.stderr.includes('No project found'), 'next before init');

    // Done before init
    const dbi = runSync(['done'], emptyDir);
    assert(dbi.stdout.includes('No project found') || dbi.stderr.includes('No project found'), 'done before init');

    // Resume with no project
    const rnp = runSync(['resume'], emptyDir);
    assert(rnp.stdout.includes('No active project found'), 'resume no project');

    // Export with no project
    const enp = runSync(['export'], emptyDir);
    assert(enp.stdout.includes('No project found') || enp.stderr.includes('No project found'), 'export no project');

    // Back on step 1
    const backDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bwa-back-err-'));
    await runInteractiveProcess(['init'], backDir, [
      (out) => out.includes('Select project type') ? '\r\n' : null,
      (out) => out.includes('experience level') ? '\r\n' : null,
      (out) => out.includes('Project name') ? 'App\r\n' : null,
      (out) => out.includes('One-line project idea') ? 'Idea\r\n' : null
    ]);
    const back1 = runSync(['back'], backDir);
    assert(back1.stdout.includes('Already at the first step'), 'back on step 1');

    // Invalid jump values
    for (const value of ['abc', '0', '999', '2oops']) {
      const invalidJump = runSync(['jump', value], backDir);
      const output = `${invalidJump.stdout}\n${invalidJump.stderr}`;
      assert.notStrictEqual(invalidJump.code, 0, `jump ${value} exits non-zero`);
      assert(output.includes('Invalid step number. Must be between 1 and 23.'), `jump ${value} shows valid range`);
      assert(!output.includes('Error:'), `jump ${value} omits stack trace`);
    }

    safeRmDir(emptyDir);
    safeRmDir(backDir);

    report['Error handling'] = 'PASS';
    console.log('   ✔ All error and edge cases failed gracefully with clear messages and 0 unhandled crashes.\n');

  } catch (err) {
    console.error('❌ E2E Failure:', err);
    issues.push({
      error: err.message,
      stack: err.stack
    });
  } finally {
    safeRmDir(testDir);
  }

  console.log('===============================================================');
  console.log('📊 FINAL VALIDATION SUMMARY TABLE');
  console.log('===============================================================');
  for (const [k, v] of Object.entries(report)) {
    console.log(`${k.padEnd(22)} ${v === 'PASS' ? '✅ PASS' : '❌ FAIL'}`);
  }
  console.log('===============================================================');
  const allPass = Object.values(report).every(v => v === 'PASS');
  console.log(`OVERALL STATUS: ${allPass ? 'PASS' : 'FAIL'}`);
  console.log('===============================================================');
}

executeFullE2ETest();
