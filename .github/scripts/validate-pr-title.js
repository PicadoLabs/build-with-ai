#!/usr/bin/env node

/**
 * Validates PR titles against Conventional Commits and ensures
 * zero emojis are used in adherence to repository guidelines.
 */

const title = process.argv[2] || process.env.PR_TITLE || '';

if (!title.trim()) {
  console.error('Error: PR title is empty or missing.');
  process.exit(1);
}

console.log(`Validating PR title: "${title}"`);

// Check for emojis
const emojiRegex = /[\p{Extended_Pictographic}\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
if (emojiRegex.test(title)) {
  console.error('\n[Validation Error] PR title contains emojis.');
  console.error('Repository policy strictly bans emojis in PR titles, commit messages, code, and documentation.');
  process.exit(1);
}

// Check for Conventional Commits pattern
const conventionalRegex = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9_\-/]+\))?: .+/;
if (!conventionalRegex.test(title)) {
  console.error('\n[Validation Error] PR title does not conform to Conventional Commits standard.');
  console.error('Format: <type>(<scope>): <subject>');
  console.error('Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert');
  console.error('Example: feat(export): add export rules support\n');
  process.exit(1);
}

console.log('PR title passed all validation checks.');
process.exit(0);
