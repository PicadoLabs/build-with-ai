const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { mergeContextObjects, mergeContextFiles, setupGitMergeDriver } = require('../lib/mergeDriver');

const cli = path.join(__dirname, '..', 'bin', 'cli.js');

function runCli(args, cwd) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
    env: { ...process.env, BUILD_WITH_AI_NO_COPY: '1' }
  });
  assert.ifError(result.error);
  // Combine both streams: logger.success/info/warn go to stdout, errors to stderr.
  result.output = `${result.stdout || ''}${result.stderr || ''}`;
  return result;
}

function runTests() {
  // Independent additions on both sides merge; the result still parses.
  const base = {
    project: { name: 'Demo', type: 'web-app' },
    decisions: { database: 'PostgreSQL' }
  };
  const ours = {
    project: { name: 'Demo', type: 'web-app' },
    decisions: { database: 'PostgreSQL', frontendStack: 'Next.js' }
  };
  const theirs = {
    project: { name: 'Demo', type: 'web-app' },
    decisions: { database: 'PostgreSQL', deploymentPlatform: 'Vercel' }
  };
  let result = mergeContextObjects(base, ours, theirs);
  assert.deepStrictEqual(result.conflicts, []);
  assert.strictEqual(result.merged.decisions.frontendStack, 'Next.js');
  assert.strictEqual(result.merged.decisions.deploymentPlatform, 'Vercel');
  assert.strictEqual(result.merged.decisions.database, 'PostgreSQL');
  assert.strictEqual(result.merged.mergeConflicts, undefined, 'No mergeConflicts key without conflicts');
  console.log('  ✔ Independent additions on both sides merge cleanly.');

  // The same change on both sides is kept once.
  result = mergeContextObjects(
    base,
    { ...base, decisions: { database: 'MySQL' } },
    { ...base, decisions: { database: 'MySQL' } }
  );
  assert.deepStrictEqual(result.conflicts, []);
  assert.strictEqual(result.merged.decisions.database, 'MySQL');
  console.log('  ✔ Identical changes on both sides are kept once.');

  // A one-sided change is taken; the untouched side does not override it.
  result = mergeContextObjects(base, ours, base);
  assert.strictEqual(result.merged.decisions.frontendStack, 'Next.js');
  result = mergeContextObjects(base, base, theirs);
  assert.strictEqual(result.merged.decisions.deploymentPlatform, 'Vercel');
  console.log('  ✔ One-sided changes are taken.');

  // Nested objects merge key by key.
  result = mergeContextObjects(
    { decisions: { auth: { provider: 'Clerk' } } },
    { decisions: { auth: { provider: 'Clerk', strategy: 'NextAuth.js' } } },
    { decisions: { auth: { provider: 'Auth0' } } }
  );
  assert.deepStrictEqual(result.conflicts, []);
  assert.strictEqual(result.merged.decisions.auth.provider, 'Auth0');
  assert.strictEqual(result.merged.decisions.auth.strategy, 'NextAuth.js');
  console.log('  ✔ Nested objects merge key by key.');

  // A key changed differently on both sides is a conflict: ours is kept
  // and both values are recorded in mergeConflicts.
  result = mergeContextObjects(
    { decisions: { database: 'PostgreSQL' } },
    { decisions: { database: 'MySQL' } },
    { decisions: { database: 'SQLite' } }
  );
  assert.strictEqual(result.conflicts.length, 1);
  assert.strictEqual(result.conflicts[0].key, 'decisions.database');
  assert.strictEqual(result.conflicts[0].ours, 'MySQL');
  assert.strictEqual(result.conflicts[0].theirs, 'SQLite');
  assert.strictEqual(result.merged.decisions.database, 'MySQL');
  assert.strictEqual(result.merged.mergeConflicts.length, 1);
  assert.strictEqual(result.merged.mergeConflicts[0].key, 'decisions.database');
  assert.strictEqual(JSON.parse(JSON.stringify(result.merged)).decisions.database, 'MySQL');
  console.log('  ✔ Conflicting keys keep ours and record both values in mergeConflicts.');

  // When both conflicting values carry a timestamp, the newer one wins.
  result = mergeContextObjects(
    { decisions: { database: { value: 'PostgreSQL', updatedAt: '2026-11-01T00:00:00.000Z' } } },
    { decisions: { database: { value: 'MySQL', updatedAt: '2026-11-10T00:00:00.000Z' } } },
    { decisions: { database: { value: 'SQLite', updatedAt: '2026-11-05T00:00:00.000Z' } } }
  );
  assert.deepStrictEqual(result.conflicts, []);
  assert.strictEqual(result.merged.decisions.database.value, 'MySQL');
  result = mergeContextObjects(
    { decisions: { database: { value: 'PostgreSQL', updatedAt: '2026-11-01T00:00:00.000Z' } } },
    { decisions: { database: { value: 'MySQL', updatedAt: '2026-11-02T00:00:00.000Z' } } },
    { decisions: { database: { value: 'SQLite', updatedAt: '2026-11-09T00:00:00.000Z' } } }
  );
  assert.deepStrictEqual(result.conflicts, []);
  assert.strictEqual(result.merged.decisions.database.value, 'SQLite');
  console.log('  ✔ Conflicting timestamped values resolve to the newer one.');

  // An exact timestamp tie is still a conflict.
  result = mergeContextObjects(
    { decisions: { database: { value: 'PostgreSQL', updatedAt: '2026-11-01T00:00:00.000Z' } } },
    { decisions: { database: { value: 'MySQL', updatedAt: '2026-11-10T00:00:00.000Z' } } },
    { decisions: { database: { value: 'SQLite', updatedAt: '2026-11-10T00:00:00.000Z' } } }
  );
  assert.strictEqual(result.conflicts.length, 1);
  console.log('  ✔ Equal timestamps on differing values stay a conflict.');

  // Arrays merge as whole values: one-sided change is taken, a two-sided
  // change is a conflict rather than an element-wise guess.
  result = mergeContextObjects({ list: [1, 2] }, { list: [1, 2, 3] }, { list: [1, 2] });
  assert.deepStrictEqual(result.conflicts, []);
  assert.deepStrictEqual(result.merged.list, [1, 2, 3]);
  result = mergeContextObjects({ list: [1, 2] }, { list: [1, 2, 3] }, { list: [1, 2, 4] });
  assert.strictEqual(result.conflicts.length, 1);
  assert.deepStrictEqual(result.merged.list, [1, 2, 3]);
  console.log('  ✔ Arrays merge as whole values.');

  // Deleting a key on one side while the other side leaves it alone drops
  // it; deleting while the other side changes it is a conflict.
  result = mergeContextObjects({ a: 1, b: 2 }, { a: 1 }, { a: 1, b: 2 });
  assert.strictEqual(result.merged.b, undefined);
  result = mergeContextObjects({ a: 1, b: 2 }, { a: 1 }, { a: 1, b: 3 });
  assert.strictEqual(result.conflicts.length, 1);
  console.log('  ✔ Deletions merge, and delete-vs-change is a conflict.');

  // CLI: merge-driver merges three files, writes the result back to the
  // current file, and reports conflicts without breaking JSON.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildwithai-merge-driver-'));
  try {
    const writeJson = (name, value) => {
      const filePath = path.join(dir, name);
      fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      return filePath;
    };
    const basePath = writeJson('base.json', base);
    const oursPath = writeJson('ours.json', ours);
    const theirsPath = writeJson('theirs.json', theirs);
    let run = runCli(['merge-driver', basePath, oursPath, theirsPath], dir);
    assert.strictEqual(run.status, 0, run.output);
    const merged = JSON.parse(fs.readFileSync(oursPath, 'utf8'));
    assert.strictEqual(merged.decisions.frontendStack, 'Next.js');
    assert.strictEqual(merged.decisions.deploymentPlatform, 'Vercel');
    assert(run.output.includes('cleanly'), 'Clean merge is reported');

    // The conflict case: the merged file parses and carries mergeConflicts.
    const conflictOurs = writeJson('conflict-ours.json', { decisions: { database: 'MySQL' } });
    const conflictTheirs = writeJson('conflict-theirs.json', { decisions: { database: 'SQLite' } });
    const conflictBase = writeJson('conflict-base.json', { decisions: { database: 'PostgreSQL' } });
    run = runCli(['merge-driver', conflictBase, conflictOurs, conflictTheirs], dir);
    assert.strictEqual(run.status, 0, run.output);
    const conflictMerged = JSON.parse(fs.readFileSync(conflictOurs, 'utf8'));
    assert.strictEqual(conflictMerged.decisions.database, 'MySQL');
    assert.strictEqual(conflictMerged.mergeConflicts[0].theirs, 'SQLite');
    assert(run.output.includes('decisions.database'), 'Conflict is logged');
    console.log('  ✔ merge-driver merges files and logs conflicts.');

    // An unparseable input fails instead of writing a broken file.
    const brokenPath = path.join(dir, 'broken.json');
    fs.writeFileSync(brokenPath, '{ not json', 'utf8');
    run = runCli(['merge-driver', basePath, brokenPath, theirsPath], dir);
    assert.notStrictEqual(run.status, 0, 'Unparseable input must fail');
    assert.strictEqual(fs.readFileSync(brokenPath, 'utf8'), '{ not json');
    console.log('  ✔ merge-driver fails cleanly on unparseable input.');

    // mergeContextFiles treats a missing ancestor as an empty object
    // (git passes /dev/null when the file was added on both sides).
    const added = mergeContextFiles(path.join(dir, 'does-not-exist.json'), oursPath, theirsPath);
    assert.strictEqual(added.merged.decisions.frontendStack, 'Next.js');
    assert.strictEqual(added.merged.decisions.deploymentPlatform, 'Vercel');
    console.log('  ✔ A missing ancestor file is treated as empty.');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // CLI: git-setup registers the driver and the .gitattributes entry, and
  // running it twice never duplicates the attribute.
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildwithai-git-setup-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    let run = runCli(['git-setup'], repoDir);
    assert.strictEqual(run.status, 0, run.output);
    assert.strictEqual(
      execFileSync('git', ['config', 'merge.buildwithai.driver'], { cwd: repoDir, encoding: 'utf8' }).trim(),
      'npx build-with-ai merge-driver %O %A %B'
    );
    assert.strictEqual(
      execFileSync('git', ['config', 'merge.buildwithai.name'], { cwd: repoDir, encoding: 'utf8' }).trim(),
      'build-with-ai context.json merge driver'
    );
    const attributes = fs.readFileSync(path.join(repoDir, '.gitattributes'), 'utf8');
    assert(attributes.includes('.buildwithai/context.json merge=buildwithai'));

    run = runCli(['git-setup'], repoDir);
    assert.strictEqual(run.status, 0, run.output);
    const attributesAgain = fs.readFileSync(path.join(repoDir, '.gitattributes'), 'utf8');
    assert.strictEqual(
      attributesAgain.split('\n').filter((line) => line.trim() === '.buildwithai/context.json merge=buildwithai')
        .length,
      1,
      'git-setup must be idempotent'
    );

    // An existing .gitattributes without a trailing newline is preserved.
    fs.writeFileSync(path.join(repoDir, '.gitattributes'), '*.log text', 'utf8');
    const direct = setupGitMergeDriver(repoDir);
    assert.strictEqual(direct.attributesAdded, true);
    assert(fs.readFileSync(path.join(repoDir, '.gitattributes'), 'utf8').includes('*.log text\n.buildwithai'));
    console.log('  ✔ git-setup registers the driver and stays idempotent.');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }

  // git-setup outside a git repository fails with guidance.
  const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'buildwithai-git-setup-plain-'));
  try {
    const run = runCli(['git-setup'], plainDir);
    assert.notStrictEqual(run.status, 0, 'git-setup outside a repo must fail');
    assert(run.output.includes('git repository'), 'Failure explains the missing repo');
    console.log('  ✔ git-setup fails cleanly outside a git repository.');
  } finally {
    fs.rmSync(plainDir, { recursive: true, force: true });
  }

  console.log('Merge driver tests passed.');
}

runTests();
