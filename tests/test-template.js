const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildTemplateScaffold, scaffoldTemplateFile, lintTemplateData, lintTemplateFile } = require('../lib/template');
const { validateTemplate } = require('../lib/validator');

const cli = path.join(__dirname, '..', 'bin', 'cli.js');
const templatesDir = path.join(__dirname, '..', 'templates');

function runCli(cwd, args = []) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 10000,
    env: { ...process.env, BUILD_WITH_AI_BRANCH_SCOPED: '0' }
  });
  assert.ifError(result.error);
  return result;
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function clone(data) {
  return JSON.parse(JSON.stringify(data));
}

function runTests() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buildwithai-template-'));

  try {
    console.log('▶ Test: template new scaffolds a valid, lintable template');
    const scaffold = buildTemplateScaffold('my-workflow');
    assert.strictEqual(scaffold.id, 'my-workflow');
    assert.strictEqual(scaffold.type, 'my-workflow');
    assert.strictEqual(scaffold.title, 'My Workflow');
    assert.strictEqual(scaffold.steps.length, 3);
    assert.deepStrictEqual(
      scaffold.steps.map((step) => step.phase),
      ['Discovery', 'Requirements', 'Tech Stack']
    );
    assert.deepStrictEqual(validateTemplate(scaffold), { valid: true, errors: [] });
    assert.deepStrictEqual(lintTemplateData(scaffold), { valid: true, errors: [] });

    const workDir = path.join(root, 'scaffold');
    fs.mkdirSync(workDir);
    const { filePath } = scaffoldTemplateFile('my-workflow', workDir);
    assert.strictEqual(filePath, path.join(workDir, 'my-workflow.json'));
    assert.ok(fs.existsSync(filePath), 'Scaffold file is written');
    assert.deepStrictEqual(lintTemplateFile(filePath), { valid: true, errors: [] });
    assert.throws(() => scaffoldTemplateFile('my-workflow', workDir), /already exists/);
    for (const badName of ['My Template', 'my_template', 'UPPER', '', 'has space']) {
      assert.throws(() => buildTemplateScaffold(badName), /kebab-case/, `"${badName}" must be rejected`);
    }
    console.log('  ✔ Scaffold passes schema + lint, refuses bad names and overwrites.');

    console.log('\n▶ Test: template lint flags schema errors and missing fields');
    const missingTitle = clone(scaffold);
    delete missingTitle.title;
    assert.match(lintTemplateData(missingTitle).errors.join('\n'), /missing required string field: "title"/);
    const missingDescription = clone(scaffold);
    delete missingDescription.description;
    assert.match(
      lintTemplateData(missingDescription).errors.join('\n'),
      /missing required string field: "description"/
    );
    const missingType = clone(scaffold);
    delete missingType.type;
    assert.match(lintTemplateData(missingType).errors.join('\n'), /missing required string field: "type"/);
    const noSteps = clone(scaffold);
    noSteps.steps = [];
    assert.strictEqual(lintTemplateData(noSteps).valid, false);
    assert.match(lintTemplateData(null).errors.join('\n'), /must be a JSON object/);
    console.log('  ✔ Missing title, description, type, and steps are flagged.');

    console.log('\n▶ Test: template lint flags duplicate step ids and numbers');
    const dupIds = clone(scaffold);
    dupIds.steps[1].id = dupIds.steps[0].id;
    assert.match(lintTemplateData(dupIds).errors.join('\n'), /Duplicate step id/);
    const dupNumbers = clone(scaffold);
    dupNumbers.steps[1].id = 'step-01-mvp-scope';
    assert.match(lintTemplateData(dupNumbers).errors.join('\n'), /Duplicate step number 01/);
    console.log('  ✔ Duplicate step ids and duplicate step numbers are flagged.');

    console.log('\n▶ Test: template lint flags non-kebab-case ids and missing per-step fields');
    const badTemplateId = clone(scaffold);
    badTemplateId.id = 'My Workflow';
    assert.match(lintTemplateData(badTemplateId).errors.join('\n'), /Template id must be kebab-case/);
    const badStepId = clone(scaffold);
    badStepId.steps[0].id = 'Step_One';
    assert.match(lintTemplateData(badStepId).errors.join('\n'), /Step "Step_One" id must be kebab-case/);
    for (const field of ['title', 'phase', 'goal']) {
      const missing = clone(scaffold);
      delete missing.steps[0][field];
      assert.match(
        lintTemplateData(missing).errors.join('\n'),
        new RegExp(`missing required string field: "${field}"`)
      );
    }
    console.log('  ✔ Non-kebab-case ids and missing title/phase/goal are flagged.');

    console.log('\n▶ Test: template lint flags unfulfilled requirements and placeholders');
    const badRequires = clone(scaffold);
    badRequires.steps[1].requires = ['decisions.neverWritten'];
    assert.match(
      lintTemplateData(badRequires).errors.join('\n'),
      /requires "decisions\.neverWritten" which is never written/
    );
    const badPlaceholder = clone(scaffold);
    badPlaceholder.steps[1].prompt = 'Use {{decisions.ghost}} here.';
    assert.match(
      lintTemplateData(badPlaceholder).errors.join('\n'),
      /uses placeholder "\{\{decisions\.ghost\}\}" which is never written/
    );
    console.log('  ✔ Unfulfilled requires and unresolvable placeholders are flagged.');

    console.log('\n▶ Test: template lint reports file errors with locations');
    const brokenDir = path.join(root, 'broken');
    fs.mkdirSync(brokenDir);
    const brokenPath = path.join(brokenDir, 'broken.json');
    fs.writeFileSync(brokenPath, '{\n  "steps": [\n', 'utf8');
    const invalidJson = lintTemplateFile(brokenPath);
    assert.strictEqual(invalidJson.valid, false);
    assert.match(invalidJson.errors.join('\n'), /broken\.json:line \d+: Invalid JSON/);
    const missing = lintTemplateFile(path.join(brokenDir, 'missing.json'));
    assert.strictEqual(missing.valid, false);
    assert.match(missing.errors.join('\n'), /Cannot read file/);
    const badFile = path.join(brokenDir, 'bad.json');
    writeJson(badFile, dupNumbers);
    const badResult = lintTemplateFile(badFile);
    assert.strictEqual(badResult.valid, false);
    assert.match(badResult.errors.join('\n'), /bad\.json:line \d+: Duplicate step number 01/);
    console.log('  ✔ Invalid JSON, missing files, and lint errors carry file:line locations.');

    console.log('\n▶ Test: template lint passes every shipped template');
    const shipped = fs.readdirSync(templatesDir).filter((f) => f.endsWith('.json') && f !== 'index.json');
    assert.ok(shipped.length >= 11, `Expected at least 11 shipped templates, found ${shipped.length}`);
    for (const file of shipped) {
      const result = lintTemplateFile(path.join(templatesDir, file));
      assert.strictEqual(result.valid, true, `${file} must pass lint: ${result.errors.join('; ')}`);
    }
    console.log(`  ✔ All ${shipped.length} shipped templates pass lint.`);

    console.log('\n▶ Test: template new and lint CLI commands');
    const cliDir = path.join(root, 'cli');
    fs.mkdirSync(cliDir);
    let result = runCli(cliDir, ['template', 'new', 'demo-flow']);
    assert.strictEqual(result.status, 0, `template new failed: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Template scaffolded/);
    assert.ok(fs.existsSync(path.join(cliDir, 'demo-flow.json')), 'CLI writes demo-flow.json');
    result = runCli(cliDir, ['template', 'lint', 'demo-flow.json']);
    assert.strictEqual(result.status, 0, `template lint failed: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /Template is valid/);

    result = runCli(cliDir, ['template', 'new', 'Bad_Name']);
    assert.strictEqual(result.status, 1, 'template new must reject a non-kebab-case name');
    assert.match(result.stdout + result.stderr, /kebab-case/);
    result = runCli(cliDir, ['template', 'new', 'demo-flow']);
    assert.strictEqual(result.status, 1, 'template new must refuse to overwrite');
    assert.match(result.stdout + result.stderr, /already exists/);
    writeJson(path.join(cliDir, 'bad.json'), dupNumbers);
    result = runCli(cliDir, ['template', 'lint', 'bad.json']);
    assert.strictEqual(result.status, 1, 'template lint must fail on a broken file');
    assert.match(result.stdout + result.stderr, /Duplicate step number 01/);
    result = runCli(cliDir, ['template', 'lint', 'nope.json']);
    assert.strictEqual(result.status, 1, 'template lint must fail on a missing file');
    console.log('  ✔ CLI scaffolds, lints, and fails cleanly on bad input.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

runTests();
console.log('\nTemplate authoring tests passed.');
