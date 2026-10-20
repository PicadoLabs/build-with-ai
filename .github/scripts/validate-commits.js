#!/usr/bin/env node

/**
 * Validates all commits in a PR branch range against Conventional Commits
 * and the strict zero-emoji policy.
 */

const { execSync } = require('child_process');

const baseRef = process.env.BASE_REF || 'main';
const targetRef = `origin/${baseRef}`;

let commitLogOutput = '';
try {
  commitLogOutput = execSync(`git log --no-merges --format="%H%x09%s" ${targetRef}..HEAD`, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore']
  }).trim();
} catch {
  // If targetRef is not directly available, fallback to HEAD~1..HEAD or HEAD
  try {
    commitLogOutput = execSync('git log --no-merges -n 10 --format="%H%x09%s"', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore']
    }).trim();
  } catch {
    console.log('Unable to query git log range; skipping branch commit list check.');
    process.exit(0);
  }
}

if (!commitLogOutput) {
  console.log('No branch-specific commits detected in range. Skipping.');
  process.exit(0);
}

const lines = commitLogOutput.split('\n').filter((l) => l.trim().length > 0);
console.log(`Validating ${lines.length} commit(s) in branch:`);

const emojiRegex = /[\p{Extended_Pictographic}\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
const conventionalRegex = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9_\-/]+\))?: .+/;

let errors = 0;

for (const line of lines) {
  const [hash, subject] = line.split('\t');
  const shortHash = hash ? hash.substring(0, 7) : 'unknown';

  if (!subject) continue;

  // Skip merge commits
  if (subject.startsWith('Merge ') || subject.startsWith('Revert ')) {
    console.log(`  [skip] ${shortHash} ${subject} (merge/revert commit)`);
    continue;
  }

  // Check emoji
  if (emojiRegex.test(subject)) {
    console.error(`  [FAIL] ${shortHash} ${subject}`);
    console.error('         Error: Commit subject contains prohibited emoji characters.');
    errors++;
    continue;
  }

  // Check conventional commit format
  if (!conventionalRegex.test(subject)) {
    console.error(`  [FAIL] ${shortHash} ${subject}`);
    console.error('         Error: Commit subject must follow Conventional Commits standard.');
    console.error('         Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert');
    errors++;
    continue;
  }

  console.log(`  [pass] ${shortHash} ${subject}`);
}

if (errors > 0) {
  console.error(`\nValidation failed: ${errors} commit(s) do not meet repository standards.`);
  console.error('Please reword commits using: git rebase -i');
  process.exit(1);
}

console.log('\nAll branch commits passed validation checks successfully.');
process.exit(0);
