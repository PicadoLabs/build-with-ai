/**
 * Three-way merge for `.buildwithai/context.json` (#219).
 *
 * When two branches both touch context.json, git's default merge leaves
 * conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) inside the file, which
 * breaks JSON parsing and renders every CLI command unusable until the
 * developer hand-edits the file. This driver merges the JSON structurally
 * instead:
 *
 * - Keys changed on one side only are taken from that side.
 * - Keys changed identically on both sides are kept once.
 * - Keys changed differently on both sides are a conflict: when both
 *   values carry a timestamp (`updatedAt`, `timestamp`, `createdAt` or
 *   `time`) the newer one wins; otherwise the ours value is kept and the
 *   conflict is recorded in the merged file under `mergeConflicts` and
 *   logged, so nothing is silently lost and the file still parses.
 *
 * The driver follows the git merge-driver contract: it is invoked as
 * `merge-driver %O %A %B` (ancestor, current, other) and writes the merged
 * result back into %A, exiting 0 when the file merged (even with logged
 * conflicts) and 1 only when the inputs cannot be read or parsed.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const GITATTRIBUTES_LINE = '.buildwithai/context.json merge=buildwithai';
const TIMESTAMP_KEYS = ['updatedAt', 'timestamp', 'createdAt', 'time'];

/**
 * Order-insensitive deep equality for JSON values.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && deepEqual(a[key], b[key]));
}

/**
 * Returns true for plain JSON objects (not arrays, not null).
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Extracts a comparable timestamp (milliseconds since epoch) from a value,
 * when the value is an object carrying one of the known timestamp fields as
 * an ISO string or an epoch number. Returns null when no usable timestamp
 * is present.
 * @param {unknown} value
 * @returns {number|null}
 */
function getTimestamp(value) {
  if (!isPlainObject(value)) return null;
  for (const key of TIMESTAMP_KEYS) {
    const raw = value[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      // Epoch seconds are common too; anything below 1e12 is seconds.
      return raw < 1e12 ? raw * 1000 : raw;
    }
    if (typeof raw === 'string' && raw.trim() !== '') {
      const parsed = Date.parse(raw);
      if (!Number.isNaN(parsed)) return parsed;
    }
  }
  return null;
}

/**
 * Three-way merges JSON values. `keyPath` is the dotted path of the value
 * being merged, used to label conflicts.
 * @param {unknown} base Ancestor value (or undefined when the key is new).
 * @param {unknown} ours Current-branch value.
 * @param {unknown} theirs Other-branch value.
 * @param {string} [keyPath='']
 * @returns {{ merged: unknown, conflicts: Array<{ key: string, ours: unknown, theirs: unknown }> }}
 */
function mergeValues(base, ours, theirs, keyPath = '') {
  if (deepEqual(ours, theirs)) return { merged: ours, conflicts: [] };
  if (deepEqual(ours, base)) return { merged: theirs, conflicts: [] };
  if (deepEqual(theirs, base)) return { merged: ours, conflicts: [] };

  // Both sides changed the same key differently. When both values carry a
  // timestamp the newer one wins as a whole — checked before recursing, so
  // a timestamped record is never split key by key. An exact tie is still
  // a conflict, since the values differ and neither is newer.
  const oursTime = getTimestamp(ours);
  const theirsTime = getTimestamp(theirs);
  if (oursTime !== null && theirsTime !== null && oursTime !== theirsTime) {
    return { merged: oursTime > theirsTime ? ours : theirs, conflicts: [] };
  }

  if (isPlainObject(ours) && isPlainObject(theirs) && isPlainObject(base)) {
    const merged = {};
    const conflicts = [];
    const keys = new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)]);
    for (const key of keys) {
      const childPath = keyPath ? `${keyPath}.${key}` : key;
      const result = mergeValues(base[key], ours[key], theirs[key], childPath);
      if (result.merged !== undefined) merged[key] = result.merged;
      conflicts.push(...result.conflicts);
    }
    return { merged, conflicts };
  }

  return { merged: ours, conflicts: [{ key: keyPath || '(root)', ours, theirs }] };
}

/**
 * Three-way merges three context.json objects. Conflicts are recorded in
 * the merged result under `mergeConflicts` (each entry carries the dotted
 * key plus both values) so the disagreement survives in the file instead
 * of being silently dropped; the list is empty/absent when nothing
 * conflicted.
 * @param {object} base Ancestor context.
 * @param {object} ours Current-branch context.
 * @param {object} theirs Other-branch context.
 * @returns {{ merged: object, conflicts: Array<{ key: string, ours: unknown, theirs: unknown }> }}
 */
function mergeContextObjects(base, ours, theirs) {
  const { merged, conflicts } = mergeValues(base || {}, ours || {}, theirs || {});
  const result = isPlainObject(merged) ? { ...merged } : {};
  if (conflicts.length > 0) {
    result.mergeConflicts = conflicts;
  }
  return { merged: result, conflicts };
}

/**
 * Reads a JSON file, treating a missing or empty file as an empty object
 * (git passes /dev/null or an empty temp file for the ancestor when a file
 * was added on both sides).
 * @param {string} filePath
 * @returns {object}
 */
function readJsonFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw new Error(`Unable to read ${filePath}: ${error.message}`);
  }
  if (raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) {
      throw new Error(`Expected a JSON object in ${filePath}.`);
    }
    return parsed;
  } catch (error) {
    throw new Error(`Unable to parse ${filePath} as JSON: ${error.message}`);
  }
}

/**
 * Merges three context.json files (ancestor, current, other) and returns
 * the merged object plus any conflicts.
 * @param {string} basePath
 * @param {string} oursPath
 * @param {string} theirsPath
 * @returns {{ merged: object, conflicts: Array<{ key: string, ours: unknown, theirs: unknown }> }}
 */
function mergeContextFiles(basePath, oursPath, theirsPath) {
  const base = readJsonFile(basePath);
  const ours = readJsonFile(oursPath);
  const theirs = readJsonFile(theirsPath);
  return mergeContextObjects(base, ours, theirs);
}

/**
 * Configures the merge driver for the git repository in `cwd`:
 * registers `merge.buildwithai.driver` in .git/config and adds the
 * `.buildwithai/context.json merge=buildwithai` attribute (idempotent —
 * an existing entry is never duplicated).
 * @param {string} [cwd=process.cwd()]
 * @returns {{ driver: string, attributesPath: string, attributesAdded: boolean }}
 */
function setupGitMergeDriver(cwd = process.cwd()) {
  const driver = 'npx build-with-ai merge-driver %O %A %B';
  try {
    execFileSync('git', ['config', 'merge.buildwithai.name', 'build-with-ai context.json merge driver'], {
      cwd,
      stdio: 'ignore'
    });
    execFileSync('git', ['config', 'merge.buildwithai.driver', driver], { cwd, stdio: 'ignore' });
  } catch (error) {
    throw new Error(`Unable to configure the git merge driver (is this a git repository?): ${error.message}`);
  }

  const attributesPath = path.join(cwd, '.gitattributes');
  let attributesAdded = false;
  let existing = '';
  try {
    existing = fs.readFileSync(attributesPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Unable to read ${attributesPath}: ${error.message}`);
  }
  const lines = existing.split('\n');
  if (!lines.some((line) => line.trim() === GITATTRIBUTES_LINE)) {
    const prefix = existing === '' || existing.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(attributesPath, `${existing}${prefix}${GITATTRIBUTES_LINE}\n`, 'utf8');
    attributesAdded = true;
  }
  return { driver, attributesPath, attributesAdded };
}

module.exports = {
  GITATTRIBUTES_LINE,
  deepEqual,
  getTimestamp,
  mergeValues,
  mergeContextObjects,
  mergeContextFiles,
  readJsonFile,
  setupGitMergeDriver
};
