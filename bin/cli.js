#!/usr/bin/env node
const fs = require('fs');
const { fetchRegistry, filterTemplates } = require('../lib/registry');
const { Command } = require('commander');
const pc = require('picocolors');

const {
  isInitialized,
  loadState,
  saveState,
  loadContext,
  saveContext,
  saveHistory,
  getAllHistory,
  resetProject,
  saveSnapshot,
  loadSnapshot,
  deleteSnapshot,
  undoLastStep
} = require('../lib/state');
const { loadTemplates, getTemplate, resolveStepPrompt } = require('../lib/promptEngine');
const { setByPath, getByPath, flattenObject } = require('../lib/contextBuilder');
const { runConfigEditor, formatEditorValue } = require('../lib/configEditor');
const { copyToClipboard, readFromClipboard } = require('../lib/clipboard');
const { parseDecisions } = require('../lib/decisionParser');
const {
  displayStep,
  renderProgressBar,
  displayBanner,
  formatElapsedTime,
  printTargetFileTips,
  getGitChangedFiles,
  safePrompt
} = require('../lib/ui');
const { runInit } = require('../lib/init');
const { runResume } = require('../lib/resume');
const { runExport } = require('../lib/export');
const { runRulesExport } = require('../lib/rules');
const logger = require('../lib/logger');

const program = new Command();

const { getMappings } = require('../lib/models');

program
  .command('models')
  .description('Display active AI model capability mappings')
  .action(() => {
    const mappings = getMappings();
    console.log('\nActive Capability Mappings:\n');
    console.table(
      Object.entries(mappings).map(([alias, model]) => ({
        'Capability Alias': alias,
        'Mapped Model(s)': model
      }))
    );
  });

program
  .name('build-with-ai')
  .description('A minimal, zero-API CLI guiding developers through building software projects with AI.')
  .version(require('../package.json').version);

program
  .command('mcp')
  .description('Start a native Model Context Protocol (MCP) stdio server exposing the workflow as tools.')
  .action(() => {
    const { runMcpServer } = require('../lib/mcp');
    runMcpServer().catch((err) => {
      process.stderr.write(`MCP server error: ${err && err.message ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
  });

program
  .command('history [stepNumber]')
  .description('List recorded step logs or display the full markdown for a step.')
  .option('--json', 'Output history entries as JSON')
  .action((stepNumber, options) => {
    if (!isInitialized()) {
      logger.error('No project found in this directory. Run `npx build-with-ai init` first.');
      process.exit(1);
    }
    if (
      stepNumber !== undefined &&
      (!/^\d+$/.test(stepNumber) || !Number.isSafeInteger(Number(stepNumber)) || Number(stepNumber) < 1)
    ) {
      logger.error('Step number must be a positive integer. Example: `npx build-with-ai history 2`.');
      process.exit(1);
    }
    const history = getAllHistory();
    if (options.json) {
      if (stepNumber !== undefined) {
        const entry = history.find((item) => item.step === Number(stepNumber));
        if (!entry) {
          logger.error(
            `No recorded history for step ${stepNumber}. Run \`npx build-with-ai history\` to list available logs.`
          );
          process.exit(1);
        }
        console.log(JSON.stringify(entry, null, 2));
        return;
      }
      console.log(JSON.stringify(history, null, 2));
      return;
    }
    if (stepNumber !== undefined) {
      const entry = history.find((item) => item.step === Number(stepNumber));
      if (!entry) {
        logger.error(
          `No recorded history for step ${stepNumber}. Run \`npx build-with-ai history\` to list available logs.`
        );
        process.exit(1);
      }
      process.stdout.write(entry.content);
      return;
    }
    if (history.length === 0) {
      console.log('No recorded step history yet. Complete a step with `npx build-with-ai done` first.');
      return;
    }
    for (const entry of history) {
      console.log(`${entry.filename}  ${entry.modifiedAt}`);
    }
  });

// ─────────────────────────────────────────────────
// 1. `init` command
// ─────────────────────────────────────────────────
program
  .command('init')
  .description('Initialize a new AI-guided project workflow in the current directory.')
  .option('-f, --force', 'Force re-initialization if project already exists')
  .option('-t, --template <path-or-url>', 'Load a custom template from a local file path or remote HTTPS URL')
  .option('--rules', 'Sync editor rule files (.cursorrules, .windsurfrules, CLAUDE.md) from context.json after init')
  .action(async (options) => {
    await runInit(options);
    if (options.rules) {
      if (!isInitialized()) return;
      if ((await runRulesExport(process.cwd(), {})) === false) process.exitCode = 1;
    }
  });

// ─────────────────────────────────────────────────
// BYOK autonomous step runner (#108)
// ─────────────────────────────────────────────────
// Dispatches the current step's prompt to the developer's own AI provider,
// writes the returned file blocks into the project, records any decisions,
// saves the raw response to history, and advances the workflow — without
// the copy/paste round-trip. Default `next` behavior is untouched.
async function runAutonomousStep({ state, context, totalSteps, currentStepNum, resolvedPrompt, targetFiles, options }) {
  const {
    resolveProviderConfig,
    chatCompletion,
    parseFileBlocks,
    parseDecisions,
    resolveTargetPath,
    writeFileBlocks,
    renderDiff,
    buildRunSystemPrompt
  } = require('../lib/aiClient');

  let providerConfig;
  try {
    providerConfig = resolveProviderConfig({
      provider: options.provider,
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      model: options.model
    });
  } catch (err) {
    logger.error(err.message);
    process.exit(1);
  }

  if (providerConfig.needsKey && !providerConfig.apiKey) {
    logger.error(
      `No API key for provider "${providerConfig.provider}". ` +
        `Pass --api-key, set ${providerConfig.envPrefix}_API_KEY, ` +
        `or add ${providerConfig.envPrefix}_API_KEY=<key> to .buildwithai/.env (gitignored).`
    );
    process.exit(1);
  }

  console.log();
  logger.info(
    `Autonomous run: step ${currentStepNum}/${totalSteps} via ${providerConfig.provider} (${providerConfig.model}).`
  );

  const system = buildRunSystemPrompt({
    stepNum: currentStepNum,
    totalSteps,
    targetFiles
  });

  let response;
  try {
    response = await chatCompletion(providerConfig, [
      { role: 'system', content: system },
      { role: 'user', content: resolvedPrompt }
    ]);
  } catch (err) {
    logger.error(`AI request failed: ${err.message}`);
    process.exit(1);
  }

  // 1. File blocks → preview (with --review) → safe write.
  const blocks = parseFileBlocks(response);
  let written = 0;
  let skipped = 0;
  if (blocks.length === 0) {
    logger.warn('The AI response contained no file blocks.');
  } else {
    const applicable = [];
    for (const block of blocks) {
      const absolute = resolveTargetPath(process.cwd(), block.path);
      if (!absolute) {
        skipped++;
        logger.warn(`Skipping unsafe path "${block.path}" (outside the project directory).`);
        continue;
      }
      applicable.push({ block, absolute });
    }

    let apply = true;
    if (options.review && applicable.length > 0) {
      console.log();
      console.log(pc.bold(pc.cyan('Proposed changes:')));
      for (const { block, absolute } of applicable) {
        const oldText = fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8') : '';
        console.log();
        console.log(pc.bold(`--- ${block.path}${oldText ? '' : ' (new file)'}`));
        console.log(renderDiff(oldText, block.content));
      }
      console.log();
      ({ apply } = await safePrompt([
        { type: 'confirm', name: 'apply', message: 'Apply these file changes?', default: true }
      ]));
    }

    if (apply) {
      for (const result of writeFileBlocks(
        process.cwd(),
        applicable.map((entry) => entry.block)
      )) {
        if (result.written) {
          written++;
          logger.success(`${result.created ? 'Created' : 'Updated'} ${result.path}`);
        }
      }
    } else {
      console.log(pc.dim('File changes discarded.'));
    }
  }

  // 2. Decisions → context.
  const recorded = [];
  try {
    const decisions = parseDecisions(response);
    for (const [key, value] of Object.entries(decisions)) {
      if (typeof key === 'string' && key.trim() && setByPath(context, key, value)) {
        recorded.push(key);
      }
    }
    if (recorded.length > 0) {
      saveContext(context);
    }
  } catch (err) {
    logger.warn(err.message);
  }

  // 3. History + advance, like `done` does.
  saveHistory(currentStepNum, response);
  if (!state.completedSteps.includes(currentStepNum)) {
    state.completedSteps.push(currentStepNum);
  }
  state.currentStep = currentStepNum + 1;
  saveState(state);

  console.log();
  logger.success(
    `Step ${currentStepNum} complete: ${written} file(s) written` +
      (skipped > 0 ? `, ${skipped} skipped` : '') +
      (recorded.length > 0 ? `, ${recorded.length} decision(s) recorded` : '') +
      `. Advanced to step ${state.currentStep}/${totalSteps}.`
  );
}

// ─────────────────────────────────────────────────
// 2. `next` command
// ─────────────────────────────────────────────────
program
  .command('next')
  .description('Generate and copy the prompt for the current step.')
  .option('--raw', 'Print only the raw prompt string (useful for piping to other tools)')
  .option('--json', 'Print the full step data as JSON')
  .option('--no-copy', 'Skip copying the prompt to the clipboard')
  .option(
    '--run',
    'BYOK autonomous mode: send the step prompt to your AI provider, write the returned files, and advance'
  )
  .option(
    '--provider <name>',
    'AI provider for --run: openai, anthropic, gemini, deepseek, groq, together, ollama, jev'
  )
  .option('--api-key <key>', 'API key for --run (overrides env vars and .buildwithai/.env)')
  .option('--model <model>', 'Model id override for --run')
  .option('--base-url <url>', 'API base URL override for --run')
  .option('--review', 'With --run: show a colored diff of the proposed file changes and confirm before applying')
  .action(async (options) => {
    if (!isInitialized()) {
      logger.error('No project found in this directory. Run `npx build-with-ai init` first.');
      process.exit(1);
    }

    const state = loadState();
    const context = loadContext();
    const template = getTemplate(state.templateId);

    if (!template) {
      logger.error(
        `Template "${state.templateId}" not found. Run \`npx build-with-ai list\` to view available templates.`
      );
      process.exit(1);
    }

    const totalSteps = template.steps ? template.steps.length : 0;
    const currentStepNum = state.currentStep || 1;

    if (currentStepNum > totalSteps) {
      if (options.raw) {
        console.log('');
        return;
      }
      console.log();
      logger.success(pc.bold('All steps in this template are complete!'));
      console.log();
      console.log(
        pc.cyan('Run ') +
          pc.bold(pc.green('npx build-with-ai export')) +
          pc.cyan(' to generate your README, BUILD_LOG, and CONTEXT documentation.')
      );
      console.log();
      return;
    }

    const currentStep = template.steps[currentStepNum - 1];
    const { resolvedPrompt, warnings, targetFiles, recommendedAI } = resolveStepPrompt(currentStep, context);

    // BYOK autonomous mode: dispatch the prompt to the model, apply the
    // returned file blocks + decisions, and advance (#108)
    if (options.run) {
      await runAutonomousStep({
        state,
        context,
        totalSteps,
        currentStepNum,
        resolvedPrompt,
        targetFiles,
        options
      });
      return;
    }

    // --json mode
    if (options.json) {
      const output = {
        step: currentStepNum,
        totalSteps,
        title: currentStep.title,
        phase: currentStep.phase || '',
        goal: currentStep.goal,
        expectedOutput: currentStep.expectedOutput,
        recommendedAI,
        targetFiles,
        warnings,
        prompt: resolvedPrompt
      };
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    // --raw mode: print only the prompt string
    if (options.raw) {
      console.log(resolvedPrompt);
      return;
    }

    // Standard display
    displayStep({
      stepNum: currentStepNum,
      totalSteps,
      title: currentStep.title,
      phase: currentStep.phase || '',
      goal: currentStep.goal,
      expectedOutput: currentStep.expectedOutput,
      prompt: resolvedPrompt,
      warnings,
      targetFiles,
      recommendedAI
    });

    const skipCopy = options.copy === false || process.env.BUILD_WITH_AI_NO_COPY === '1';
    const copied = skipCopy ? false : await copyToClipboard(resolvedPrompt);
    console.log();
    if (skipCopy) {
      console.log(pc.dim('Clipboard copy skipped.'));
    } else if (copied) {
      console.log(pc.green(pc.bold('Prompt copied to clipboard')));
    } else {
      console.log(pc.yellow('Copy the prompt above and paste it into your AI assistant.'));
    }
    console.log();
    console.log(pc.dim('When done with your AI conversation, run: ') + pc.bold(pc.cyan('npx build-with-ai done')));
    console.log();
  });

// ─────────────────────────────────────────────────
// 3. `done` command
// ─────────────────────────────────────────────────
program
  .command('done')
  .description('Record AI decisions/response for the current step and advance.')
  .option('--from-clipboard', 'Read the AI response from the system clipboard and auto-extract decisions')
  .option('--auto', 'Alias for --from-clipboard')
  .action(async (options) => {
    if (!isInitialized()) {
      logger.error('No project found in this directory. Run `npx build-with-ai init` first.');
      process.exit(1);
    }

    const state = loadState();
    const context = loadContext();
    const template = getTemplate(state.templateId);

    if (!template) {
      logger.error(`Template "${state.templateId}" not found.`);
      process.exit(1);
    }

    const totalSteps = template.steps ? template.steps.length : 0;
    const currentStepNum = state.currentStep || 1;

    if (currentStepNum > totalSteps) {
      logger.info('All steps have already been completed.');
      console.log(
        pc.cyan('Run ') + pc.bold(pc.green('npx build-with-ai export')) + pc.cyan(' to generate documentation.')
      );
      return;
    }

    const currentStep = template.steps[currentStepNum - 1];
    const stepWrites = Array.isArray(currentStep.writes) ? currentStep.writes : [];

    console.log('\n' + pc.bold(pc.cyan(`Completing Step ${currentStepNum}/${totalSteps}: ${currentStep.title}`)));
    console.log();

    // Snapshot state.json + context.json BEFORE this step's decisions are
    // recorded, so `npx build-with-ai undo` can restore the exact pre-step
    // state (#115). Removed again below if the user declines to advance.
    saveSnapshot(currentStepNum);

    // Soft, non-blocking nudge: warn if the step's declared target files
    // have not been created in the workspace yet.
    const missingTargets = printTargetFileTips(currentStep.targetFiles);

    // Pre-flight verification (#112): compare the git working tree against
    // the step's target files. Missing targets get an explicit warning and
    // the developer can keep the step open instead of advancing.
    if (missingTargets.length > 0) {
      const declaredTargets = Array.isArray(currentStep.targetFiles) ? currentStep.targetFiles : [];
      const changed = getGitChangedFiles();
      if (changed) {
        const touched = declaredTargets.filter((entry) => typeof entry === 'string' && changed.has(entry));
        if (touched.length > 0) {
          console.log(pc.dim(` Changed in git: ${touched.map((entry) => `"${entry}"`).join(', ')}`));
        }
      }
      for (const entry of missingTargets) {
        console.log(pc.yellow(`Warning: Target file "${entry}" was not found in the workspace.`));
      }
      console.log();
      const { advanceAnyway } = await safePrompt([
        {
          type: 'confirm',
          name: 'advanceAnyway',
          message: 'Some target files are missing. Advance to the next step anyway?',
          default: false
        }
      ]);
      if (!advanceAnyway) {
        deleteSnapshot(currentStepNum);
        console.log(
          pc.dim('Keeping the current step open. Create the missing files, then run `npx build-with-ai done` again.')
        );
        return;
      }
    }

    // --from-clipboard / --auto (#111): read the AI response straight from the
    // system clipboard, save the full markdown to history/, and heuristically
    // extract the step's decision keys. Falls back to interactive prompts when
    // the clipboard is empty or unreadable.
    const useClipboard = Boolean(options.fromClipboard || options.auto);
    let clipboardText = null;
    if (useClipboard) {
      clipboardText = await readFromClipboard();
      if (clipboardText) {
        const savedPath = saveHistory(currentStepNum, clipboardText);
        logger.success(`Saved clipboard response to ${savedPath}`);
      } else {
        console.log(pc.yellow('Could not read any text from the clipboard. Falling back to interactive prompts.'));
      }
    }

    if (clipboardText) {
      const { found, missing } = parseDecisions(clipboardText, stepWrites);
      const extractedKeys = Object.keys(found);

      if (extractedKeys.length > 0) {
        console.log();
        console.log(pc.bold(pc.green('Extracted decisions from clipboard:')));
        for (const writeKey of extractedKeys) {
          const keyLabel = writeKey
            .replace(/^decisions\./, '')
            .replace(/([A-Z])/g, ' $1')
            .replace(/^./, (str) => str.toUpperCase());
          console.log(`  ${pc.dim('•')} ${pc.bold(keyLabel)}: ${found[writeKey]}`);
          setByPath(context, writeKey, found[writeKey]);
        }
        saveContext(context);
        logger.success('Saved decisions to context.json');
      } else {
        console.log();
        console.log(pc.yellow('No decision values could be detected in the clipboard text.'));
      }

      if (missing.length > 0) {
        console.log();
        console.log(pc.bold(pc.yellow('The following decisions were not detected — please enter them manually:')));
        for (const writeKey of missing) {
          const keyLabel = writeKey
            .replace(/^decisions\./, '')
            .replace(/([A-Z])/g, ' $1')
            .replace(/^./, (str) => str.toUpperCase());
          const { val } = await safePrompt([
            {
              type: 'input',
              name: 'val',
              message: `Decision for "${keyLabel}" (${writeKey}):`,
              default: ''
            }
          ]);
          if (val && val.trim()) {
            setByPath(context, writeKey, val.trim());
          }
        }
        saveContext(context);
        logger.success('Saved decisions to context.json');
      } else if (stepWrites.length === 0) {
        const { generalDecision } = await safePrompt([
          {
            type: 'input',
            name: 'generalDecision',
            message: 'Summary / decision for this step:',
            default: ''
          }
        ]);
        if (generalDecision && generalDecision.trim()) {
          setByPath(context, `decisions.${currentStep.id.replace(/-/g, '_')}`, generalDecision.trim());
        }
        saveContext(context);
        logger.success('Saved decisions to context.json');
      }
    } else {
      const { recordChoice } = await safePrompt([
        {
          type: 'list',
          name: 'recordChoice',
          message: 'How would you like to record the result of this step?',
          choices: [
            { name: 'Enter short summary / decisions (Recommended for context injection)', value: 'decisions' },
            { name: 'Paste full AI response (Saves raw markdown to history/)', value: 'full' },
            { name: 'Both (Enter decisions AND save full AI response)', value: 'both' },
            { name: 'Skip saving details (Just mark step complete)', value: 'skip' }
          ]
        }
      ]);

      // Full AI response
      if (recordChoice === 'full' || recordChoice === 'both') {
        // Multi-line-safe editor when the clipboard read failed: pasting large
        // AI responses into single-line terminal prompts can truncate text.
        const { fullResponse } = await safePrompt([
          {
            type: useClipboard ? 'editor' : 'input',
            name: 'fullResponse',
            message: 'Paste or enter the AI response (summary or key notes):',
            default: ''
          }
        ]);

        if (fullResponse && fullResponse.trim()) {
          const savedPath = saveHistory(currentStepNum, fullResponse.trim());
          logger.success(`Saved response to ${savedPath}`);
        }
      }

      // Decisions input
      if (recordChoice === 'decisions' || recordChoice === 'both') {
        console.log();
        console.log(pc.bold(pc.yellow('Recording key decisions for future step prompts:')));

        if (stepWrites.length > 0) {
          for (const writeKey of stepWrites) {
            const keyLabel = writeKey
              .replace(/^decisions\./, '')
              .replace(/([A-Z])/g, ' $1')
              .replace(/^./, (str) => str.toUpperCase());
            const { val } = await safePrompt([
              {
                type: 'input',
                name: 'val',
                message: `Decision for "${keyLabel}" (${writeKey}):`,
                default: ''
              }
            ]);
            if (val && val.trim()) {
              setByPath(context, writeKey, val.trim());
            }
          }
        } else {
          const { generalDecision } = await safePrompt([
            {
              type: 'input',
              name: 'generalDecision',
              message: 'Summary / decision for this step:',
              default: ''
            }
          ]);
          if (generalDecision && generalDecision.trim()) {
            setByPath(context, `decisions.${currentStep.id.replace(/-/g, '_')}`, generalDecision.trim());
          }
        }

        saveContext(context);
        logger.success('Saved decisions to context.json');
      }
    }

    // Soft-check confirmation
    if (stepWrites.length > 0) {
      console.log();
      console.log(pc.bold('Expected outcomes for this step:'));
      for (const w of stepWrites) {
        const label = w
          .replace(/^decisions\./, '')
          .replace(/([A-Z])/g, ' $1')
          .replace(/^./, (str) => str.toUpperCase());
        console.log(`  ${pc.dim('•')} ${label}`);
      }
      console.log();

      const { confirmDecision } = await safePrompt([
        {
          type: 'list',
          name: 'confirmDecision',
          message: 'Have these been decided?',
          choices: [
            { name: 'Yes, continue', value: 'yes' },
            { name: 'Not yet', value: 'not_yet' },
            { name: 'Review later', value: 'later' }
          ]
        }
      ]);
      if (confirmDecision !== 'yes') {
        const snapshot = loadSnapshot(currentStepNum);
        if (snapshot && snapshot.context) {
          saveContext(snapshot.context);
        }
        deleteSnapshot(currentStepNum);
        console.log(
          pc.dim(
            confirmDecision === 'later'
              ? 'Keeping the current step open. Revisit these decisions, then run `npx build-with-ai done` again.'
              : 'Keeping the current step open. Decide the remaining outcomes, then run `npx build-with-ai done` again.'
          )
        );
        return;
      }
    }

    // Mark step complete and advance
    if (!state.completedSteps.includes(currentStepNum)) {
      state.completedSteps.push(currentStepNum);
    }
    state.currentStep = currentStepNum + 1;
    saveState(state);

    console.log();
    logger.success(pc.bold(`Step ${currentStepNum} completed! Advanced to Step ${state.currentStep}/${totalSteps}.`));
    console.log();

    if (state.currentStep <= totalSteps) {
      console.log(
        pc.cyan('Next: Run ') + pc.bold(pc.green('npx build-with-ai next')) + pc.cyan(' to generate the next prompt.')
      );
    } else {
      console.log(pc.green('All workflow steps completed!'));
      console.log(
        pc.cyan('Run ') +
          pc.bold(pc.green('npx build-with-ai export')) +
          pc.cyan(' to generate README.md and documentation.')
      );
    }
    console.log();
  });

// ─────────────────────────────────────────────────
// 4. `back` command
// ─────────────────────────────────────────────────
program
  .command('back')
  .description('Move back to the previous step without deleting history.')
  .action(() => {
    if (!isInitialized()) {
      logger.error('No project found in this directory.');
      process.exit(1);
    }

    const state = loadState();
    const current = state.currentStep || 1;

    if (current <= 1) {
      logger.warn('Already at the first step (Step 1). Cannot go further back.');
      return;
    }

    const prev = current - 1;
    state.currentStep = prev;
    state.completedSteps = (state.completedSteps || []).filter((s) => s !== prev);
    saveState(state);

    console.log();
    logger.success(`Moved back to Step ${prev}.`);
    console.log(pc.dim('History and recorded decisions were preserved.'));
    console.log(pc.cyan('Run ') + pc.bold(pc.green('npx build-with-ai next')) + pc.cyan(' to view this step prompt.'));
    console.log();
  });

// ─────────────────────────────────────────────────
// `undo` command — NEW in V1.4 (#115)
// ─────────────────────────────────────────────────
program
  .command('undo')
  .description('Undo the last completed step, restoring its state and context decisions.')
  .action(() => {
    if (!isInitialized()) {
      logger.error('No project found in this directory. Run `npx build-with-ai init` first.');
      process.exit(1);
    }

    const result = undoLastStep();

    if (!result) {
      console.log();
      logger.warn('Nothing to undo — no step snapshots found in .buildwithai/snapshots/.');
      console.log(
        pc.dim('Snapshots are saved automatically each time a step is completed with `npx build-with-ai done`.')
      );
      console.log();
      return;
    }

    console.log();
    logger.success(`Undone Step ${result.step}: restored the step counter and its context decisions.`);
    console.log(pc.dim("The step's history file was removed."));
    console.log(pc.cyan('Run ') + pc.bold(pc.green('npx build-with-ai next')) + pc.cyan(' to redo the step.'));
    console.log();
  });

// ─────────────────────────────────────────────────
// 5. `jump` command — NEW in V1.1
// ─────────────────────────────────────────────────
program
  .command('jump [stepNumber]')
  .description('Jump directly to any step number (preserves history and context).')
  .action(async (stepNumber) => {
    if (!isInitialized()) {
      logger.error('No project found in this directory. Run `npx build-with-ai init` first.');
      process.exit(1);
    }

    const state = loadState();
    const template = getTemplate(state.templateId);
    const totalSteps = template ? template.steps.length : state.totalSteps || 0;

    let target;

    if (stepNumber !== undefined) {
      target = Number(stepNumber);
    } else {
      // Interactive step picker
      if (!template || !template.steps) {
        logger.error('Template not found. Cannot list steps.');
        process.exit(1);
      }
      const { picked } = await safePrompt([
        {
          type: 'list',
          name: 'picked',
          message: 'Select a step to jump to:',
          choices: template.steps.map((s, idx) => {
            const num = idx + 1;
            const isDone = (state.completedSteps || []).includes(num);
            const isCurrent = state.currentStep === num;
            const icon = isDone ? pc.green('✔') : isCurrent ? pc.cyan('➤') : pc.dim('○');
            return {
              name: `${icon} Step ${num}: ${s.title} [${s.phase || 'General'}]`,
              value: num
            };
          })
        }
      ]);
      target = picked;
    }

    if (!Number.isInteger(target) || target < 1 || target > totalSteps) {
      logger.error(`Invalid step number. Must be between 1 and ${totalSteps}.`);
      process.exit(1);
    }

    state.currentStep = target;
    saveState(state);

    console.log();
    logger.success(`Jumped to Step ${target}/${totalSteps}.`);
    console.log(pc.dim('History and context decisions are intact.'));
    console.log(
      pc.cyan('Run ') + pc.bold(pc.green('npx build-with-ai next')) + pc.cyan(" to generate this step's prompt.")
    );
    console.log();
  });

// ─────────────────────────────────────────────────
// 6. `context` command — NEW in V1.1
// ─────────────────────────────────────────────────
program
  .command('context [key]')
  .description('View recorded context decisions. Optionally pass a dot-notation key to look up a specific value.')
  .action((key) => {
    if (!isInitialized()) {
      logger.error('No project found in this directory. Run `npx build-with-ai init` first.');
      process.exit(1);
    }

    const context = loadContext();

    if (key) {
      const val = getByPath(context, key);
      if (val === undefined || val === null) {
        logger.warn(`No value found for key "${key}" in context.json.`);
      } else {
        console.log();
        console.log(`${pc.bold(pc.cyan(key))}: ${typeof val === 'object' ? JSON.stringify(val, null, 2) : val}`);
        console.log();
      }
      return;
    }

    // Show all decisions
    const flat = flattenObject(context);
    const entries = Object.entries(flat);

    console.log();
    console.log(pc.bold(pc.cyan('RECORDED CONTEXT DECISIONS:')));
    console.log(pc.dim('─'.repeat(55)));

    if (entries.length === 0) {
      console.log(pc.dim('No decisions recorded yet. Run `npx build-with-ai done` after completing a step.'));
    } else {
      for (const [k, v] of entries) {
        const valStr = typeof v === 'object' ? JSON.stringify(v) : String(v);
        const truncated = valStr.length > 90 ? valStr.substring(0, 87) + '...' : valStr;
        console.log(`  ${pc.dim('•')} ${pc.bold(k)}: ${truncated}`);
      }
    }
    console.log();
    console.log(pc.dim('Tip: Use `npx build-with-ai set <key> <value>` to update any decision.'));
    console.log();
  });

// ─────────────────────────────────────────────────
// 7. `set` command — NEW in V1.1
// ─────────────────────────────────────────────────
program
  .command('set <key> <value>')
  .description('Update a context.json decision by dot-notation key (e.g. set decisions.database "PostgreSQL").')
  .action((key, value) => {
    if (!isInitialized()) {
      logger.error('No project found in this directory. Run `npx build-with-ai init` first.');
      process.exit(1);
    }

    const context = loadContext();
    const prev = getByPath(context, key);
    let parsedValue = value;
    try {
      parsedValue = JSON.parse(value);
    } catch {
      // Ordinary text and invalid JSON remain strings.
    }
    if (!setByPath(context, key, parsedValue)) {
      logger.error(
        `Cannot set "${key}": the key is empty or contains a reserved segment ("__proto__", "prototype" or "constructor").`
      );
      process.exit(1);
    }
    saveContext(context);

    console.log();
    if (prev !== undefined && prev !== null && prev !== '') {
      logger.success(`Updated "${key}"`);
      console.log(`  ${pc.dim('Before:')} ${pc.dim(typeof prev === 'object' ? JSON.stringify(prev) : String(prev))}`);
      console.log(`  ${pc.bold('After: ')} ${pc.green(value)}`);
    } else {
      logger.success(`Set "${key}" = "${value}"`);
    }
    console.log();
  });

// ─────────────────────────────────────────────────
// `config` command — interactive context editor
// ─────────────────────────────────────────────────
program
  .command('config')
  .description('Interactively browse and edit recorded context decisions.')
  .action(async () => {
    if (!isInitialized()) {
      logger.error('No project found in this directory. Run `npx build-with-ai init` first.');
      process.exit(1);
    }

    // Non-interactive fallback: point at the headless equivalents instead of hanging on a prompt.
    if (!process.stdin.isTTY) {
      logger.error(
        'The config editor needs an interactive terminal. Use `npx build-with-ai context` to view decisions or `npx build-with-ai set <key> <value>` to update one.'
      );
      process.exit(1);
    }

    const context = loadContext();
    const result = await runConfigEditor({
      context,
      inquirer: { prompt: safePrompt },
      save: (updated) => saveContext(updated)
    });

    console.log();
    if (result.updated) {
      logger.success(`Updated "${result.key}"`);
      console.log(`  ${pc.dim('Before:')} ${pc.dim(formatEditorValue(result.before))}`);
      console.log(`  ${pc.bold('After: ')} ${pc.green(formatEditorValue(result.after))}`);
    } else if (result.reason === 'empty') {
      console.log(pc.dim('No decisions recorded yet. Run `npx build-with-ai done` after completing a step.'));
    } else if (result.reason === 'unchanged') {
      console.log(pc.dim(`"${result.key}" unchanged — no save needed.`));
    } else {
      console.log(pc.dim('Edit cancelled — nothing changed.'));
    }
    console.log();
  });

// ─────────────────────────────────────────────────
// 8. `status` command
// ─────────────────────────────────────────────────
program
  .command('status')
  .description('Display project progress, step status list, and recorded decisions.')
  .option('--json', 'Output project status as JSON')
  .action((options) => {
    if (!isInitialized()) {
      logger.error('No project found in this directory. Run `npx build-with-ai init` first.');
      process.exit(1);
    }

    const state = loadState();
    const context = loadContext();
    const template = getTemplate(state.templateId);

    const totalSteps = template ? template.steps.length : state.totalSteps || 0;
    const currentStepNum = state.currentStep || 1;
    const completedList = state.completedSteps || [];
    const completedSteps = new Set(
      completedList.filter((step) => Number.isInteger(step) && step >= 1 && step <= totalSteps)
    );
    const exportReady = totalSteps > 0 && completedSteps.size === totalSteps;
    const decisions = context.decisions || {};

    if (options.json) {
      const output = {
        projectName: state.projectName,
        templateId: state.templateId,
        templateTitle: state.templateTitle || state.templateId,
        experienceLevel: state.experienceLevel,
        projectIdea: state.projectIdea,
        startedAt: state.startedAt || null,
        updatedAt: state.updatedAt || null,
        currentStep: currentStepNum,
        totalSteps,
        completedSteps: completedList,
        completedCount: completedSteps.size,
        progressPercent: totalSteps > 0 ? Math.round((completedSteps.size / totalSteps) * 100) : 0,
        exportReady,
        decisions
      };
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    console.log();
    console.log(pc.bold(pc.cyan(`PROJECT STATUS: ${state.projectName}`)));
    console.log(pc.dim('─'.repeat(55)));
    console.log(`${pc.bold('Template:')} ${state.templateTitle || state.templateId}`);
    console.log(`${pc.bold('Experience:')} ${state.experienceLevel}`);
    console.log(`${pc.bold('Idea:')} ${state.projectIdea}`);
    console.log(`${pc.bold('Progress:')} ${renderProgressBar(completedList.length, totalSteps)}`);
    const now = Date.now();
    const updatedAge = formatElapsedTime(state.updatedAt, now);
    console.log(`${pc.bold('Time Elapsed:')} ${formatElapsedTime(state.startedAt, now)}`);
    console.log(`${pc.bold('Last Updated:')} ${updatedAge === 'Unknown' ? updatedAge : `${updatedAge} ago`}`);
    console.log(`${pc.bold('Decisions Count:')} ${Object.keys(flattenObject(context.decisions || {})).length}`);
    console.log(`${pc.bold('Export Readiness:')} ${exportReady ? 'Ready' : 'In progress'}`);
    console.log();

    if (template && template.steps) {
      console.log(pc.bold('WORKFLOW STEPS:'));
      template.steps.forEach((step, idx) => {
        const stepNum = idx + 1;
        let prefix;
        let titleFormatted;

        if (completedList.includes(stepNum)) {
          prefix = pc.green('  ✔');
          titleFormatted = pc.dim(`${stepNum}. ${step.title} [${step.phase || 'General'}]`);
        } else if (stepNum === currentStepNum) {
          prefix = pc.cyan('  ➤');
          titleFormatted = pc.bold(pc.cyan(`${stepNum}. ${step.title} [${step.phase || 'General'}] (Current)`));
        } else {
          prefix = pc.dim('  ○');
          titleFormatted = pc.dim(`${stepNum}. ${step.title} [${step.phase || 'General'}]`);
        }
        console.log(`${prefix} ${titleFormatted}`);
      });
      console.log();
    }

    const entries = Object.entries(decisions);
    if (entries.length > 0) {
      console.log(pc.bold(pc.magenta('RECORDED DECISIONS:')));
      for (const [k, v] of entries) {
        const label = k.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => str.toUpperCase());
        const valStr = typeof v === 'object' ? JSON.stringify(v) : String(v);
        console.log(`  ${pc.dim('•')} ${pc.bold(label)}: ${valStr}`);
      }
      console.log();
    }

    console.log(pc.dim('Tip: Use `npx build-with-ai set <key> <value>` to update any recorded decision.'));
    console.log();
  });

// ─────────────────────────────────────────────────
// 9. `resume` command
// ─────────────────────────────────────────────────
program
  .command('resume')
  .description('Resume workflow and show a welcome-back overview.')
  .action(() => {
    runResume();
  });

// ─────────────────────────────────────────────────
// 10. `export` command
// ─────────────────────────────────────────────────
program
  .command('export')
  .description('Export README.md, BUILD_LOG.md, and .buildwithai/CONTEXT.md (or editor rule files with --rules).')
  .option(
    '--rules',
    'Sync editor rule files (.cursorrules, .cursor/rules/project-decisions.mdc, .windsurfrules, CLAUDE.md, .github/copilot-instructions.md) from context.json'
  )
  .option('--dry-run', 'Show which files would be generated without writing them')
  .option('-o, --out-dir <path>', 'Write documentation to a custom output directory')
  .option('-f, --force', 'Overwrite an existing README.md')
  .action(async (options) => {
    if (!isInitialized()) {
      logger.error('No project found in this directory. Run `npx build-with-ai init` first.');
      process.exit(1);
    }
    if (options.rules) {
      if ((await runRulesExport(process.cwd(), options)) === false) process.exitCode = 1;
      return;
    }
    if ((await runExport(process.cwd(), options)) === false) process.exitCode = 1;
  });

// ─────────────────────────────────────────────────
// 11. `list` command
// ─────────────────────────────────────────────────
program
  .command('list')
  .description('List all available project templates and their step counts.')
  .option('-s, --search <query>', 'Filter templates by ID, title, or description')
  .option('--json', 'Print template summaries as a JSON array')
  .action((options) => {
    const query = (options.search || '').toLowerCase();
    const templates = loadTemplates().filter(
      (template) =>
        !query ||
        [template.id, template.title, template.description].some((value) => String(value).toLowerCase().includes(query))
    );
    if (options.json) {
      console.log(
        JSON.stringify(
          templates.map(({ id, title, description, stepCount }) => ({
            id,
            title,
            description,
            stepCount
          })),
          null,
          2
        )
      );
      return;
    }
    console.log();
    console.log(pc.bold(pc.cyan('AVAILABLE TEMPLATES:')));
    console.log(pc.dim('─'.repeat(55)));

    if (templates.length === 0) {
      console.log(
        pc.yellow(
          options.search ? `No templates match "${options.search}".` : 'No templates found in templates directory.'
        )
      );
      return;
    }

    templates.forEach((tpl, idx) => {
      console.log(`${pc.bold(`${idx + 1}. ${tpl.title}`)} (${pc.green(`${tpl.stepCount} steps`)})`);
      console.log(`   ${pc.dim('Type / ID:')} ${pc.cyan(tpl.id)}`);
      if (tpl.description) {
        console.log(`   ${pc.dim('Description:')} ${tpl.description}`);
      }
      console.log();
    });

    console.log(pc.dim('Tip: Use `npx build-with-ai init --template <path-or-url>` to load a custom template.'));
    console.log();
  });

// ─────────────────────────────────────────────────
// 12. `reset` command
// ─────────────────────────────────────────────────
program
  .command('reset')
  .description('Reset the .buildwithai state for the current project (never touches user code).')
  .action(async () => {
    if (!isInitialized()) {
      logger.info('No .buildwithai configuration found in this directory.');
      return;
    }

    const { confirmReset } = await safePrompt([
      {
        type: 'confirm',
        name: 'confirmReset',
        message: pc.yellow('Are you sure you want to reset and delete all .buildwithai progress in this directory?'),
        default: false
      }
    ]);

    if (!confirmReset) {
      logger.info('Reset cancelled.');
      return;
    }

    resetProject();
    logger.success('Reset .buildwithai directory. Source files were not touched.');
    console.log();
  });
// ─────────────────────────────────────────────────
// `search` command
// ─────────────────────────────────────────────────
program
  .command('search [keyword]')
  .description('Search community templates from the remote registry.')
  .action(async (keyword) => {
    let templates;
    try {
      templates = await fetchRegistry();
    } catch (err) {
      if (err.name === 'AbortError') {
        console.log(pc.red('Registry request timed out after 5 seconds.'));
      } else if (err.status) {
        console.log(pc.red(`Registry request failed with status ${err.status}.`));
      } else {
        console.log(pc.red('Could not reach the registry. Check your internet connection.'));
      }
      return;
    }

    const matches = filterTemplates(templates, keyword);

    if (matches.length === 0) {
      console.log(pc.yellow(keyword ? `No templates match "${keyword}".` : 'No templates found in the registry.'));
      return;
    }

    console.log();
    console.log(pc.bold(pc.cyan('COMMUNITY TEMPLATES:')));
    console.log(pc.dim('─'.repeat(55)));
    matches.forEach((tpl, idx) => {
      console.log(`${pc.bold(`${idx + 1}. ${tpl.title}`)} (${pc.green(`${tpl.stepCount ?? '?'} steps`)})`);
      console.log(`   ${pc.dim('ID:')} ${pc.cyan(tpl.id)}`);
      console.log(`   ${pc.dim('Author:')} ${tpl.author || 'Unknown'}`);
      if (tpl.description) {
        console.log(`   ${pc.dim('Description:')} ${tpl.description}`);
      }
      console.log();
    });

    if (!process.stdin.isTTY) return;

    let chosen = matches[0];
    if (matches.length > 1) {
      const { templateId } = await safePrompt([
        {
          type: 'list',
          name: 'templateId',
          message: 'Select a template:',
          choices: [
            ...matches.map((t) => ({ name: `${t.title} (${t.id})`, value: t.id })),
            { name: 'Cancel', value: null }
          ]
        }
      ]);
      if (!templateId) return;
      chosen = matches.find((t) => t.id === templateId);
    }

    const { confirmInit } = await safePrompt([
      {
        type: 'confirm',
        name: 'confirmInit',
        message: `Would you like to initialize with "${chosen.title}"?`,
        default: false
      }
    ]);

    if (confirmInit) {
      if (!chosen.url) {
        console.log(pc.red('This template has no download URL in the registry.'));
        return;
      }
      await runInit({ template: chosen.url });
    }
  });

// ─────────────────────────────────────────────────
// Default action (no subcommand provided)
// ─────────────────────────────────────────────────
program.action(async () => {
  displayBanner();
  console.log();

  if (isInitialized()) {
    const state = loadState();
    const template = getTemplate(state.templateId);
    const totalSteps = template ? template.steps.length : state.totalSteps || 0;
    const completedCount = Array.isArray(state.completedSteps) ? state.completedSteps.length : 0;

    console.log(`${pc.bold('Active Project:')} ${pc.cyan(state.projectName || 'Current Project')}`);
    console.log(`${pc.bold('Progress:')} ${renderProgressBar(completedCount, totalSteps)}`);
    console.log();

    const { nextAction } = await safePrompt([
      {
        type: 'list',
        name: 'nextAction',
        message: 'What would you like to do?',
        choices: [
          { name: 'Generate current step prompt (next)', value: 'next' },
          { name: 'View / edit context decisions (context)', value: 'context' },
          { name: 'Jump to a specific step (jump)', value: 'jump' },
          { name: 'Resume overview (resume)', value: 'resume' },
          { name: 'View detailed project status (status)', value: 'status' },
          { name: 'Export documentation (export)', value: 'export' },
          { name: 'Exit', value: 'exit' }
        ]
      }
    ]);

    if (nextAction === 'next') {
      const currentStepNum = state.currentStep || 1;
      if (currentStepNum > totalSteps) {
        logger.success('All steps completed! Run `export` to generate documentation.');
        return;
      }
      const currentStep = template.steps[currentStepNum - 1];
      const context = loadContext();
      const { resolvedPrompt, warnings, targetFiles, recommendedAI } = resolveStepPrompt(currentStep, context);

      displayStep({
        stepNum: currentStepNum,
        totalSteps,
        title: currentStep.title,
        phase: currentStep.phase || '',
        goal: currentStep.goal,
        expectedOutput: currentStep.expectedOutput,
        prompt: resolvedPrompt,
        warnings,
        targetFiles,
        recommendedAI
      });

      const copied = await copyToClipboard(resolvedPrompt);
      console.log();
      if (copied) {
        console.log(pc.green(pc.bold('Prompt copied to clipboard')));
      } else {
        console.log(pc.yellow('Copy the prompt above and paste it into your AI assistant.'));
      }
      console.log();
      console.log(pc.dim('When done, run: ') + pc.bold(pc.cyan('npx build-with-ai done')));
      console.log();
    } else if (nextAction === 'context') {
      const context = loadContext();
      const flat = flattenObject(context);
      const entries = Object.entries(flat);
      console.log();
      console.log(pc.bold(pc.cyan('RECORDED CONTEXT DECISIONS:')));
      console.log(pc.dim('─'.repeat(55)));
      if (entries.length === 0) {
        console.log(pc.dim('No decisions recorded yet.'));
      } else {
        for (const [k, v] of entries) {
          const valStr = typeof v === 'object' ? JSON.stringify(v) : String(v);
          const truncated = valStr.length > 90 ? valStr.substring(0, 87) + '...' : valStr;
          console.log(`  ${pc.dim('•')} ${pc.bold(k)}: ${truncated}`);
        }
      }
      console.log();
      console.log(pc.dim('Use `npx build-with-ai set <key> <value>` to update any decision.'));
      console.log();
    } else if (nextAction === 'jump') {
      if (!template || !template.steps) {
        logger.error('Template not found.');
        return;
      }
      const { picked } = await safePrompt([
        {
          type: 'list',
          name: 'picked',
          message: 'Select a step to jump to:',
          choices: template.steps.map((s, idx) => {
            const num = idx + 1;
            const isDone = (state.completedSteps || []).includes(num);
            const isCurrent = state.currentStep === num;
            const icon = isDone ? pc.green('✔') : isCurrent ? pc.cyan('➤') : pc.dim('○');
            return {
              name: `${icon} Step ${num}: ${s.title} [${s.phase || 'General'}]`,
              value: num
            };
          })
        }
      ]);
      state.currentStep = picked;
      saveState(state);
      logger.success(`Jumped to Step ${picked}/${totalSteps}.`);
      console.log(
        pc.cyan('Run ') + pc.bold(pc.green('npx build-with-ai next')) + pc.cyan(" to generate this step's prompt.")
      );
      console.log();
    } else if (nextAction === 'resume') {
      runResume();
    } else if (nextAction === 'status') {
      const context = loadContext();
      console.log();
      console.log(pc.bold(pc.cyan(`PROJECT STATUS: ${state.projectName}`)));
      console.log(pc.dim('─'.repeat(55)));
      console.log(`${pc.bold('Template:')} ${state.templateTitle || state.templateId}`);
      console.log(`${pc.bold('Experience:')} ${state.experienceLevel}`);
      console.log(`${pc.bold('Idea:')} ${state.projectIdea}`);
      console.log(`${pc.bold('Progress:')} ${renderProgressBar(completedCount, totalSteps)}`);
      const decisions = context.decisions || {};
      const entries = Object.entries(decisions);
      if (entries.length > 0) {
        console.log();
        console.log(pc.bold(pc.magenta('RECORDED DECISIONS:')));
        for (const [k, v] of entries) {
          const label = k.replace(/([A-Z])/g, ' $1').replace(/^./, (str) => str.toUpperCase());
          const valStr = typeof v === 'object' ? JSON.stringify(v) : String(v);
          console.log(`  ${pc.dim('•')} ${pc.bold(label)}: ${valStr}`);
        }
      }
      console.log();
    } else if (nextAction === 'export') {
      if ((await runExport()) === false) process.exitCode = 1;
    }
  } else {
    console.log(pc.yellow('No active project found in this directory.'));
    const { startInit } = await safePrompt([
      {
        type: 'confirm',
        name: 'startInit',
        message: 'Would you like to initialize a new project with build-with-ai now?',
        default: true
      }
    ]);

    if (startInit) {
      await runInit();
    } else {
      console.log();
      console.log(pc.dim('You can run ') + pc.bold('npx build-with-ai init') + pc.dim(' whenever you are ready!'));
      console.log();
    }
  }
});

program.parseAsync(process.argv).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
