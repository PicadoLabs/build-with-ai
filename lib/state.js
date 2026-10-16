const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { randomBytes } = require('crypto');
const logger = require('./logger');

const DIR_NAME = '.buildwithai';
const STATE_FILE = 'state.json';
const CONTEXT_FILE = 'context.json';
const HISTORY_DIR = 'history';
const SNAPSHOTS_DIR = 'snapshots';
const BRANCHES_DIR = 'branches';
const BRANCH_SCOPED_ENV_VAR = 'BUILD_WITH_AI_BRANCH_SCOPED';

const RENAME_RETRYABLE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_ATTEMPTS = 3;
const RENAME_RETRY_DELAY_MS = 20;

/**
 * Renames a file, retrying briefly when the destination is locked. On Windows an antivirus scanner,
 * search indexer or editor can hold the file for a few milliseconds and fail the rename with EPERM,
 * EBUSY or EACCES. Any other error, or a lock that does not clear, is thrown.
 * @param {string} from
 * @param {string} to
 */
function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (attempt >= RENAME_ATTEMPTS || !RENAME_RETRYABLE_CODES.has(error.code)) throw error;
      // Pause this thread without spinning; the CLI saves synchronously.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RENAME_RETRY_DELAY_MS * attempt);
    }
  }
}

function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const contents = JSON.stringify(value, null, 2);
    fs.writeFileSync(temporaryPath, contents, { encoding: 'utf8', flag: 'wx' });
    // Renaming within the same directory replaces the destination only after a complete write.
    renameWithRetry(temporaryPath, filePath);
  } catch (error) {
    if (error.code !== 'EEXIST') {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        // Preserve the original failure if cleanup is also unavailable.
      }
    }
    throw new Error(`Unable to save ${filePath}: ${error.message}`);
  }
}

/**
 * Returns true when branch-scoped storage is enabled via
 * BUILD_WITH_AI_BRANCH_SCOPED=1 (or "true").
 * @returns {boolean}
 */
function isBranchScopedEnabled() {
  const value = (process.env[BRANCH_SCOPED_ENV_VAR] || '').trim().toLowerCase();
  return value === '1' || value === 'true';
}

/**
 * Detects the current git branch for cwd. Returns null when git is not
 * installed, cwd is not inside a git repository, or HEAD is detached, so
 * callers can fall back to the default shared storage.
 * @param {string} [cwd=process.cwd()]
 * @returns {string|null}
 */
function getCurrentGitBranch(cwd = process.cwd()) {
  try {
    // symbolic-ref resolves the branch even before the first commit, and
    // fails on detached HEAD, unlike rev-parse --abbrev-ref.
    const branch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return branch || null;
  } catch {
    return null;
  }
}

/**
 * Sanitizes a git branch name into a single safe directory segment.
 * `feature/auth` becomes `feature-auth`, so branch names can never escape
 * the branches directory via path separators or parent references.
 * Returns null when nothing safe remains.
 * @param {string} branch
 * @returns {string|null}
 */
function sanitizeBranchName(branch) {
  const segment = String(branch || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^\.+|\.+$/g, '');
  return segment === '' ? null : segment;
}

/**
 * Gets the absolute path to .buildwithai in current working directory.
 * When branch scoping is enabled and a git branch is detected, returns the
 * branch-isolated directory instead (<cwd>/.buildwithai/branches/<branch>),
 * keeping state.json, context.json and history/ per branch.
 * @param {string} [cwd=process.cwd()]
 * @returns {string}
 */
function getStorageDir(cwd = process.cwd()) {
  if (isBranchScopedEnabled()) {
    const branchDir = sanitizeBranchName(getCurrentGitBranch(cwd));
    if (branchDir) {
      return path.join(cwd, DIR_NAME, BRANCHES_DIR, branchDir);
    }
  }
  return path.join(cwd, DIR_NAME);
}

/**
 * Checks if the current directory has been initialized with build-with-ai.
 * @param {string} [cwd=process.cwd()]
 * @returns {boolean}
 */
function isInitialized(cwd = process.cwd()) {
  const statePath = path.join(getStorageDir(cwd), STATE_FILE);
  return fs.existsSync(statePath);
}

/**
 * Initializes the .buildwithai directory and base state/context files.
 * @param {object} params
 * @param {string} params.projectName
 * @param {string} params.templateId
 * @param {string} params.templateTitle
 * @param {string} params.experienceLevel
 * @param {string} params.projectIdea
 * @param {number} params.totalSteps
 * @param {string} [cwd=process.cwd()]
 */
function initState(
  { projectName, templateId, templateTitle, experienceLevel, projectIdea, totalSteps },
  cwd = process.cwd()
) {
  const dir = getStorageDir(cwd);
  const historyDir = path.join(dir, HISTORY_DIR);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true });
  }

  const state = {
    projectName,
    templateId,
    templateTitle,
    experienceLevel,
    projectIdea,
    currentStep: 1,
    totalSteps: totalSteps || 0,
    completedSteps: [],
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const initialContext = {
    project: {
      name: projectName,
      type: templateId,
      experienceLevel,
      idea: projectIdea
    },
    decisions: {}
  };

  writeJsonAtomic(path.join(dir, STATE_FILE), state);
  writeJsonAtomic(path.join(dir, CONTEXT_FILE), initialContext);
  return state;
}

/**
 * Loads state.json
 * @param {string} [cwd=process.cwd()]
 * @returns {object|null}
 */
function loadState(cwd = process.cwd()) {
  const statePath = path.join(getStorageDir(cwd), STATE_FILE);
  if (!fs.existsSync(statePath)) return null;
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    logger.error(
      `Unable to read ${statePath}. Check file permissions and restore valid JSON from a backup. ${error.message}`
    );
    return null;
  }
}

/**
 * Saves state.json
 * @param {object} state
 * @param {string} [cwd=process.cwd()]
 */
function saveState(state, cwd = process.cwd()) {
  const dir = getStorageDir(cwd);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  state.updatedAt = new Date().toISOString();
  writeJsonAtomic(path.join(dir, STATE_FILE), state);
}

/**
 * Loads context.json
 * @param {string} [cwd=process.cwd()]
 * @returns {object}
 */
function loadContext(cwd = process.cwd()) {
  const contextPath = path.join(getStorageDir(cwd), CONTEXT_FILE);
  if (!fs.existsSync(contextPath)) return {};
  try {
    const raw = fs.readFileSync(contextPath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    logger.error(
      `Unable to read ${contextPath}. Check file permissions and restore valid JSON from a backup. ${error.message}`
    );
    return {};
  }
}

/**
 * Saves context.json
 * @param {object} context
 * @param {string} [cwd=process.cwd()]
 */
function saveContext(context, cwd = process.cwd()) {
  const dir = getStorageDir(cwd);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  writeJsonAtomic(path.join(dir, CONTEXT_FILE), context);
}

/**
 * Saves AI response to history/step-XX.md
 * @param {number} stepNum
 * @param {string} content
 * @param {string} [cwd=process.cwd()]
 */
function saveHistory(stepNum, content, cwd = process.cwd()) {
  const historyDir = path.join(getStorageDir(cwd), HISTORY_DIR);
  if (!fs.existsSync(historyDir)) {
    fs.mkdirSync(historyDir, { recursive: true });
  }
  const padded = String(stepNum).padStart(2, '0');
  const filename = `step-${padded}.md`;
  const filePath = path.join(historyDir, filename);
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

/**
 * Loads specific step history if it exists
 * @param {number} stepNum
 * @param {string} [cwd=process.cwd()]
 * @returns {string|null}
 */
function loadHistory(stepNum, cwd = process.cwd()) {
  const padded = String(stepNum).padStart(2, '0');
  const filePath = path.join(getStorageDir(cwd), HISTORY_DIR, `step-${padded}.md`);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * Loads all history files sorted by step number.
 * @param {string} [cwd=process.cwd()]
 * @returns {Array<{ step: number, filename: string, content: string, modifiedAt: string }>}
 */
function getAllHistory(cwd = process.cwd()) {
  const historyDir = path.join(getStorageDir(cwd), HISTORY_DIR);
  if (!fs.existsSync(historyDir)) return [];
  const files = fs.readdirSync(historyDir).filter((f) => f.startsWith('step-') && f.endsWith('.md'));

  return files
    .map((file) => {
      const match = file.match(/step-(\d+)\.md/);
      const step = match ? parseInt(match[1], 10) : 0;
      const content = fs.readFileSync(path.join(historyDir, file), 'utf8');
      const modifiedAt = fs.statSync(path.join(historyDir, file)).mtime.toISOString();
      return { step, filename: file, content, modifiedAt };
    })
    .sort((a, b) => a.step - b.step);
}

/**
 * Resets the project by removing .buildwithai directory.
 * @param {string} [cwd=process.cwd()]
 */
function resetProject(cwd = process.cwd()) {
  const dir = getStorageDir(cwd);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  }
  return false;
}

/**
 * Gets the absolute path of the snapshots directory. Because it is derived
 * from getStorageDir(), snapshots are automatically isolated per branch when
 * BUILD_WITH_AI_BRANCH_SCOPED=1.
 * @param {string} [cwd=process.cwd()]
 * @returns {string}
 */
function getSnapshotsDir(cwd = process.cwd()) {
  return path.join(getStorageDir(cwd), SNAPSHOTS_DIR);
}

/**
 * Saves an atomic snapshot of state.json and context.json for a step, taken
 * before the step's decisions are recorded so `undo` can restore the exact
 * pre-step state.
 * @param {number} stepNum
 * @param {string} [cwd=process.cwd()]
 * @returns {string|null} Snapshot file path, or null when there is no state to snapshot.
 */
function saveSnapshot(stepNum, cwd = process.cwd()) {
  const state = loadState(cwd);
  if (!state) return null;
  const context = loadContext(cwd);
  const dir = getSnapshotsDir(cwd);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const padded = String(stepNum).padStart(2, '0');
  const filePath = path.join(dir, `step-${padded}.json`);
  writeJsonAtomic(filePath, {
    step: stepNum,
    createdAt: new Date().toISOString(),
    state,
    context
  });
  return filePath;
}

/**
 * Loads a snapshot for a step.
 * @param {number} stepNum
 * @param {string} [cwd=process.cwd()]
 * @returns {{ step: number, createdAt: string, state: object, context: object }|null}
 */
function loadSnapshot(stepNum, cwd = process.cwd()) {
  const padded = String(stepNum).padStart(2, '0');
  const filePath = path.join(getSnapshotsDir(cwd), `step-${padded}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    const snapshot = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!snapshot || typeof snapshot !== 'object' || !snapshot.state || !snapshot.context) return null;
    return snapshot;
  } catch {
    return null;
  }
}

/**
 * Lists available snapshots sorted by step number, ascending.
 * @param {string} [cwd=process.cwd()]
 * @returns {Array<{ step: number, filePath: string }>}
 */
function listSnapshots(cwd = process.cwd()) {
  const dir = getSnapshotsDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((file) => {
      const match = file.match(/^step-(\d+)\.json$/);
      return match ? { step: parseInt(match[1], 10), filePath: path.join(dir, file) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.step - b.step);
}

/**
 * Deletes a step's snapshot file.
 * @param {number} stepNum
 * @param {string} [cwd=process.cwd()]
 * @returns {boolean}
 */
function deleteSnapshot(stepNum, cwd = process.cwd()) {
  const padded = String(stepNum).padStart(2, '0');
  const filePath = path.join(getSnapshotsDir(cwd), `step-${padded}.json`);
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

/**
 * Undoes the most recently snapshotted step: restores state.json (step
 * counter back to the snapshotted step, step removed from completedSteps)
 * and context.json (decisions as they were before that step), removes the
 * step's history file, and consumes the snapshot.
 * @param {string} [cwd=process.cwd()]
 * @returns {{ step: number }|null} The undone step, or null when no snapshot exists.
 */
function undoLastStep(cwd = process.cwd()) {
  const snapshots = listSnapshots(cwd);
  while (snapshots.length > 0) {
    const { step } = snapshots.pop();
    const snapshot = loadSnapshot(step, cwd);
    if (!snapshot) {
      // Corrupt or unreadable snapshot: consume it so undo can fall back to
      // the previous one instead of getting stuck.
      deleteSnapshot(step, cwd);
      continue;
    }

    const restoredState = { ...snapshot.state };
    restoredState.currentStep = step;
    restoredState.completedSteps = (restoredState.completedSteps || []).filter((s) => s !== step);
    saveState(restoredState, cwd);
    saveContext(snapshot.context, cwd);

    const padded = String(step).padStart(2, '0');
    const historyPath = path.join(getStorageDir(cwd), HISTORY_DIR, `step-${padded}.md`);
    if (fs.existsSync(historyPath)) {
      fs.unlinkSync(historyPath);
    }

    deleteSnapshot(step, cwd);
    return { step };
  }
  return null;
}

module.exports = {
  getStorageDir,
  isBranchScopedEnabled,
  getCurrentGitBranch,
  sanitizeBranchName,
  isInitialized,
  initState,
  loadState,
  saveState,
  loadContext,
  saveContext,
  saveHistory,
  loadHistory,
  getAllHistory,
  resetProject,
  getSnapshotsDir,
  saveSnapshot,
  loadSnapshot,
  listSnapshots,
  deleteSnapshot,
  undoLastStep
};
