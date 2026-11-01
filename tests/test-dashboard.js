const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { initState, loadState, saveState, saveContext, saveHistory } = require('../lib/state');
const { getTemplate } = require('../lib/promptEngine');
const { buildDashboardData, buildPhaseTree, buildDecisionRows } = require('../lib/dashboard');

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

async function runTests() {
  await testDataBuilder();
  console.log('\nAll dashboard tests passed.');
}

runTests().catch((err) => {
  console.error('Dashboard test failed:', err);
  process.exit(1);
});
