const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { initState, getStorageDir, saveState, saveContext } = require('../lib/state');

const cli = path.join(__dirname, '..', 'bin', 'cli.js');

function runValidate(cwd, args = []) {
  const result = spawnSync(process.execPath, [cli, 'validate', ...args], {
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

function makeTemplate() {
  return {
    id: 'test-workflow',
    title: 'Validation Test Workflow',
    steps: [
      {
        id: 'first',
        prompt: 'Set up {{project.name}}',
        requires: ['project.name'],
        writes: ['decisions.framework']
      },
      {
        id: 'second',
        prompt: 'Use {{decisions.framework}}',
        requires: ['decisions.framework'],
        writes: ['decisions.ready']
      }
    ]
  };
}

function expectFailure(result, expected) {
  assert.strictEqual(result.status, 1, `Expected validation failure, got: ${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout + result.stderr, expected);
  assert.doesNotMatch(result.stderr, /ERR_USE_AFTER_CLOSE|TypeError:/);
}

function runTests() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'buildwithai-validate-'));
  const template = makeTemplate();

  try {
    const standalone = path.join(root, 'standalone');
    fs.mkdirSync(standalone);
    const templatePath = path.join(standalone, 'custom-template.json');
    writeJson(templatePath, template);

    let result = runValidate(standalone, ['--template', templatePath]);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Validation passed/);
    assert(!fs.existsSync(path.join(standalone, '.buildwithai')), 'Standalone validation must not initialize state');

    result = runValidate(standalone);
    expectFailure(result, /No project found|not initialized/i);

    const projectDir = path.join(root, 'project');
    fs.mkdirSync(projectDir);
    initState(
      {
        projectName: 'Test Project',
        templateId: 'test-workflow',
        templateTitle: template.title,
        experienceLevel: 'Beginner',
        projectIdea: 'Testing',
        totalSteps: template.steps.length,
        customTemplate: template
      },
      projectDir
    );

    const storage = getStorageDir(projectDir);
    const statePath = path.join(storage, 'state.json');
    const contextPath = path.join(storage, 'context.json');
    const originalState = fs.readFileSync(statePath, 'utf8');
    const originalContext = fs.readFileSync(contextPath, 'utf8');

    // Future requirements do not require recorded decisions yet.
    result = runValidate(projectDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Validation passed/);
    assert.strictEqual(fs.readFileSync(statePath, 'utf8'), originalState);
    assert.strictEqual(fs.readFileSync(contextPath, 'utf8'), originalContext);

    const state = JSON.parse(originalState);
    state.currentStep = 2;
    saveState(state, projectDir);
    result = runValidate(projectDir);
    expectFailure(result, /Step 2.*decisions\.framework/);

    const context = JSON.parse(originalContext);
    context.decisions.framework = 'React';
    context.decisions.customChoice = 'Allowed';
    saveContext(context, projectDir);
    result = runValidate(projectDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /Info: 1 custom decision/);
    assert.match(result.stdout, /Validation passed/);

    context.decisions.framework = '   ';
    saveContext(context, projectDir);
    result = runValidate(projectDir);
    expectFailure(result, /Step 2.*decisions\.framework/);

    writeJson(contextPath, { project: context.project, decisions: { framework: false } });
    result = runValidate(projectDir);
    assert.strictEqual(result.status, 0, result.stdout + result.stderr, 'False is a recorded value, not missing');

    fs.writeFileSync(contextPath, '{ broken JSON', 'utf8');
    result = runValidate(projectDir);
    expectFailure(result, /context\.json.*line\s+1/i);
    saveContext(context, projectDir);

    fs.writeFileSync(statePath, '{ broken JSON', 'utf8');
    result = runValidate(projectDir);
    expectFailure(result, /state\.json.*line\s+1/i);
    saveState(state, projectDir);

    const storedTemplatePath = path.join(storage, 'template.json');
    fs.writeFileSync(storedTemplatePath, '{ incomplete template', 'utf8');
    result = runValidate(projectDir);
    expectFailure(result, /template\.json.*Invalid JSON/i);
    writeJson(storedTemplatePath, template);

    const inheritedKeyTemplate = makeTemplate();
    inheritedKeyTemplate.steps[0].writes.push('decisions.toString');
    inheritedKeyTemplate.steps[1].requires = ['decisions.toString'];
    writeJson(storedTemplatePath, inheritedKeyTemplate);
    saveContext({ project: context.project, decisions: {} }, projectDir);
    result = runValidate(projectDir);
    expectFailure(result, /Step 2.*decisions\.toString/);
    writeJson(storedTemplatePath, template);

    const invalid = makeTemplate();
    invalid.steps[1].requires = ['decisions.neverProduced'];
    writeJson(templatePath, invalid);
    result = runValidate(standalone, ['--template', templatePath]);
    expectFailure(result, /Step.*second.*decisions\.neverProduced/);
    assert.match(result.stderr, /custom-template\.json:line (?!1:)\d+: Step "second"/);

    const cycle = makeTemplate();
    cycle.steps[0].requires = ['decisions.ready'];
    writeJson(templatePath, cycle);
    result = runValidate(standalone, ['--template', templatePath]);
    expectFailure(result, /Step.*first.*decisions\.ready/);

    fs.writeFileSync(templatePath, '{\n  "steps": [\n', 'utf8');
    result = runValidate(standalone, ['--template', templatePath]);
    expectFailure(result, /custom-template\.json.*line\s+\d+/i);

    result = runValidate(standalone, ['--template', path.join(standalone, 'missing.json')]);
    expectFailure(result, /missing\.json/i);

    console.log('Project and template validation tests passed.');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

runTests();
