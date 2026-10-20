<!--
Thank you for contributing to build-with-ai!

Before opening this PR:
1. Ensure your PR title follows Conventional Commits format:
   <type>(<scope>): <short description in lowercase, imperative mood>
   Examples:
     feat(export): add export rules support
     fix(undo): handle empty history gracefully
     docs: update contributing guide
2. Strictly NO EMOJIS in PR titles, commit messages, code, or comments.
3. Link the associated issue if one exists.
-->

## Description
Provide a concise summary of the changes introduced by this pull request and the rationale behind them.

## Related Issue
Fixes #

## Type of Change
- [ ] Bug fix (non-breaking change fixing an issue)
- [ ] New feature (non-breaking change adding functionality)
- [ ] Refactor (non-breaking code restructuring without behavioral change)
- [ ] Performance improvement
- [ ] Documentation update (guides, docstrings, or markdown files)
- [ ] CI / Workflow / Build configuration
- [ ] Breaking change (fix or feature that changes existing CLI behavior or stored schema)

## Architectural & Technical Details
Describe any relevant design decisions, tradeoffs considered, or state storage impacts.

## Pre-Submission Verification Checklist
Please verify each of the following before submitting:
- [ ] PR title adheres to Conventional Commits standard (`<type>(<scope>): <description>`).
- [ ] Strictly NO emojis are present in the PR title, commits, code, or documentation.
- [ ] `npm run lint` passes with 0 errors and 0 warnings.
- [ ] `npm run format:check` passes with no formatting discrepancies.
- [ ] `npm test` passes all unit tests.
- [ ] `npm run test:e2e` passes the full end-to-end beginner verification workflow.
- [ ] New functionality is covered with unit or end-to-end tests where applicable.
