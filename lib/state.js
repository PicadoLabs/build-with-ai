const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');
const logger = require('./logger');

const DIR_NAME = '.buildwithai';
const STATE_FILE = 'state.json';
const CONTEXT_FILE = 'context.json';
const HISTORY_DIR = 'history';

function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const contents = JSON.stringify(value, null, 2);
    fs.writeFileSync(temporaryPath, contents, { encoding: 'utf8', flag: 'wx' });
    // Renaming within the same directory replaces the destination only after a complete write.
    fs.renameSync(temporaryPath, filePath);
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
 * Gets the absolute path to .buildwithai in current working directory.
 * @param {string} [cwd=process.cwd()]
 * @returns {string}
 */
function getStorageDir(cwd = process.cwd()) {
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
function initState({ projectName, templateId, templateTitle, experienceLevel, projectIdea, totalSteps }, cwd = process.cwd()) {
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
    logger.error(`Unable to read ${statePath}. Check file permissions and restore valid JSON from a backup. ${error.message}`);
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
    logger.error(`Unable to read ${contextPath}. Check file permissions and restore valid JSON from a backup. ${error.message}`);
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
  const files = fs.readdirSync(historyDir).filter(f => f.startsWith('step-') && f.endsWith('.md'));
  files.sort();

  return files.map(file => {
    const match = file.match(/step-(\d+)\.md/);
    const step = match ? parseInt(match[1], 10) : 0;
    const content = fs.readFileSync(path.join(historyDir, file), 'utf8');
    const modifiedAt = fs.statSync(path.join(historyDir, file)).mtime.toISOString();
    return { step, filename: file, content, modifiedAt };
  });
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

module.exports = {
  getStorageDir,
  isInitialized,
  initState,
  loadState,
  saveState,
  loadContext,
  saveContext,
  saveHistory,
  loadHistory,
  getAllHistory,
  resetProject
};
