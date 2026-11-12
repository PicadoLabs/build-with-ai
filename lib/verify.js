/**
 * Closed-loop verification for `next --run` (#214).
 *
 * After the model writes a step's files, an optional `--verify <command>`
 * runs (e.g. `npm test`) to prove the new code actually works before the
 * step is recorded as complete. When the command fails, the failure output
 * is sent back to the model as a self-healing prompt and the step is
 * retried, up to `--max-retries` times. When retries run out the step is
 * left open — never advanced on failing code — so the developer can fix
 * the check by hand.
 */

const { spawnSync } = require('child_process');

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_VERIFY_TIMEOUT_MS = 60000;
const MAX_VERIFICATION_OUTPUT_CHARS = 8000;

/**
 * Parses the `--max-retries` value: a non-negative whole number, defaulting
 * to {@link DEFAULT_MAX_RETRIES} when omitted. Throws on anything else so
 * a typo fails fast instead of silently disabling retries.
 * @param {string|number|undefined} value
 * @param {number} [defaultValue=DEFAULT_MAX_RETRIES]
 * @returns {number}
 */
function parseMaxRetries(value, defaultValue = DEFAULT_MAX_RETRIES) {
  if (value === undefined || value === null || String(value).trim() === '') return defaultValue;
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`Invalid --max-retries "${value}": use a non-negative whole number.`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid --max-retries "${value}": use a non-negative whole number.`);
  }
  return parsed;
}

/**
 * Runs a verification command in `cwd` and captures its output.
 * @param {string} command Shell command to run (e.g. `npm test`).
 * @param {string} [cwd=process.cwd()]
 * @param {object} [options]
 * @param {number} [options.timeoutMs=DEFAULT_VERIFY_TIMEOUT_MS]
 * @returns {{ ok: boolean, exitCode: number|null, output: string, timedOut: boolean }}
 */
function runVerificationCommand(command, cwd = process.cwd(), options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_VERIFY_TIMEOUT_MS;
  const result = spawnSync(command, {
    shell: true,
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024
  });
  let output = `${result.stdout || ''}${result.stderr || ''}`;
  if (result.error) {
    output += result.error.message;
  }
  if (output.length > MAX_VERIFICATION_OUTPUT_CHARS) {
    output = `${output.slice(0, MAX_VERIFICATION_OUTPUT_CHARS)}\n... (output truncated)`;
  }
  return {
    ok: result.status === 0 && !result.error,
    exitCode: result.status,
    output,
    timedOut: result.error ? result.error.code === 'ETIMEDOUT' : false
  };
}

/**
 * Builds the self-healing prompt sent to the model after a failed
 * verification run: the failing command, its exit code, and the captured
 * output, plus an instruction to reply with complete corrected file
 * blocks in the same format as the original step response.
 * @param {object} params
 * @param {string} params.command The verification command that failed.
 * @param {{ exitCode: number|null, output: string, timedOut: boolean }} params.verification
 * @param {number} params.stepNum Step being retried.
 * @param {number} params.totalSteps Total steps in the template.
 * @returns {string}
 */
function buildSelfHealingPrompt({ command, verification, stepNum, totalSteps }) {
  const lines = [
    `The code you just wrote for step ${stepNum} of ${totalSteps} failed verification.`,
    '',
    `Verification command: \`${command}\``,
    verification.timedOut
      ? 'Result: the command timed out.'
      : `Result: exited with code ${verification.exitCode === null ? 'unknown' : verification.exitCode}.`,
    '',
    'Output:',
    '```',
    verification.output.trim() === '' ? '(no output)' : verification.output,
    '```',
    '',
    'Fix the problem and reply with the complete corrected file blocks in the same format as before ' +
      '(one fenced block per file, full file content — not a patch), plus a ```decisions block if any ' +
      'decisions changed. Do not explain the failure; just provide the corrected implementation.'
  ];
  return lines.join('\n');
}

module.exports = {
  DEFAULT_MAX_RETRIES,
  DEFAULT_VERIFY_TIMEOUT_MS,
  MAX_VERIFICATION_OUTPUT_CHARS,
  parseMaxRetries,
  runVerificationCommand,
  buildSelfHealingPrompt
};
