#!/usr/bin/env node

/**
 * Validates a commit message against Conventional Commits standard
 * and enforces the strict zero-emoji policy.
 */

const fs = require('fs');

const commitMsgFile = process.argv[2];

if (!commitMsgFile || !fs.existsSync(commitMsgFile)) {
  console.error('Error: Commit message file not found.');
  process.exit(1);
}

const rawContent = fs.readFileSync(commitMsgFile, 'utf8');

// Strip comment lines starting with #
const lines = rawContent
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith('#'));

if (lines.length === 0) {
  console.error('Error: Commit message is empty.');
  process.exit(1);
}

const subject = lines[0];

// 1. Emoji check
const emojiRegex = /[\p{Extended_Pictographic}\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;
if (emojiRegex.test(rawContent)) {
  console.error('\n[Validation Error] Commit message contains emojis.');
  console.error('Repository policy strictly bans emojis in commit messages, PR titles, code, and documentation.');
  process.exit(1);
}

// Ignore merge commits or automated version bumps if any
if (subject.startsWith('Merge ') || subject.startsWith('Revert "')) {
  process.exit(0);
}

// 2. Conventional Commits format check
const conventionalRegex = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9_\-/]+\))?: .+/;
if (!conventionalRegex.test(subject)) {
  console.error('\n[Validation Error] Invalid commit message format:');
  console.error(`  "${subject}"\n`);
  console.error('Commit messages must follow the Conventional Commits specification:');
  console.error('  <type>(<scope>): <subject>');
  console.error('Allowed types: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert');
  console.error('Example: feat(export): add export rules support\n');
  process.exit(1);
}

// 3. Subject length check
if (subject.length > 72) {
  console.error('\n[Validation Error] Commit subject line exceeds 72 characters:');
  console.error(`  Length: ${subject.length} characters (max: 72)`);
  process.exit(1);
}

process.exit(0);
