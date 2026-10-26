/**
 * Heuristic decision parsing for the `done --from-clipboard` workflow.
 *
 * AI responses pasted from the clipboard are free-form markdown, so exact
 * key paths cannot be expected. A structured ```decisions JSON block is
 * checked first (#145); values for keys it covers are taken verbatim.
 * Remaining keys fall back to tolerant line-based patterns, e.g.:
 *
 *   Database: PostgreSQL
 *   - Database: PostgreSQL
 *   **Database**: PostgreSQL
 *   decisions.database = PostgreSQL
 *   decisions.database: "PostgreSQL"
 *
 * Matching is case-insensitive and ignores bullets, headings, bold markers,
 * and quotes around the value. Keys that cannot be found are reported as
 * missing so the caller can prompt for them manually.
 */

const { parseDecisionsBlock } = require('./aiClient');
const { getByPath } = require('./contextBuilder');

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Normalizes a `writes` key (e.g. "decisions.deploymentPlatform") to the
 * human-readable field name ("deployment platform") used for matching.
 * @param {string} writeKey
 * @returns {string}
 */
function normalizeFieldName(writeKey) {
  return String(writeKey)
    .replace(/^decisions\./, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Builds a regex fragment for a normalized field name that tolerates
 * flexible whitespace between words.
 * @param {string} fieldName
 * @returns {string}
 */
function fieldPattern(fieldName) {
  return escapeRegExp(fieldName).replace(/\s+/g, '\\s+');
}

/**
 * Strips markdown/bold/quote wrapping from an extracted raw value.
 * @param {string} raw
 * @returns {string}
 */
function cleanValue(raw) {
  let value = String(raw).trim();
  // Strip one layer of common wrappers: **bold**, `code`, "quotes", 'quotes'
  for (let i = 0; i < 2; i += 1) {
    const next = value
      .replace(/^\*\*(.+)\*\*$/, '$1')
      .replace(/^`(.+)`$/, '$1')
      .replace(/^"(.+)"$/, '$1')
      .replace(/^'(.+)'$/, '$1')
      .trim();
    if (next === value) break;
    value = next;
  }
  return value;
}

/**
 * Tries to extract a single decision field's value from the response lines.
 * @param {string[]} lines
 * @param {string} fieldName Normalized field name (lowercase)
 * @returns {string|null} The extracted value, or null when not found
 */
function extractFieldValue(lines, fieldName) {
  const field = fieldPattern(fieldName);
  const patterns = [
    // **Field**: value / - **Field**: value / ## **Field**: value
    new RegExp(`^\\s*(?:[-*]\\s+|#{1,6}\\s+)?\\*\\*${field}\\*\\*\\s*[:=]\\s*(.+?)\\s*$`, 'i'),
    // Field: value / - Field: value / ## Field = value
    new RegExp(`^\\s*(?:[-*]\\s+|#{1,6}\\s+)?${field}\\s*[:=]\\s*(.+?)\\s*$`, 'i'),
    // decisions.field = value
    new RegExp(`^\\s*decisions\\.${field}\\s*[:=]\\s*(.+?)\\s*$`, 'i')
  ];
  for (const line of lines) {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        const value = cleanValue(match[1]);
        if (value) return value;
      }
    }
  }
  return null;
}

/**
 * Case-insensitive variant of {@link getByPath}: walks a dot-notation path
 * matching each segment case-insensitively. Unsafe segments (those that
 * could reach the object prototype chain) refuse the whole path, matching
 * `getByPath`'s behaviour.
 * @param {Record<string, unknown>} block
 * @param {string} path
 * @returns {unknown} The nested value, or undefined when not present
 */
function lookupPathCaseInsensitive(block, path) {
  const segments = String(path).split('.');
  let current = block;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined;
    const lowered = segment.toLowerCase();
    if (lowered === '__proto__' || lowered === 'prototype' || lowered === 'constructor') {
      return undefined;
    }
    let found = false;
    for (const key of Object.keys(current)) {
      if (key.toLowerCase() === lowered) {
        current = current[key];
        found = true;
        break;
      }
    }
    if (!found) return undefined;
  }
  return current;
}

/**
 * Looks up a `writes` key in a parsed ```decisions JSON block. LLMs
 * routinely emit the field without the redundant `decisions.` prefix or as
 * a nested object, so keys are matched in order: exact key, nested
 * dot-notation path, unprefixed key, then case-insensitive variants of
 * each of those.
 * @param {Record<string, unknown>} block
 * @param {string} writeKey
 * @returns {unknown} The block value, or undefined when not present
 */
function lookupBlockValue(block, writeKey) {
  if (Object.prototype.hasOwnProperty.call(block, writeKey)) {
    return block[writeKey];
  }
  const nested = getByPath(block, writeKey);
  if (nested !== undefined) return nested;
  const unprefixed = writeKey.replace(/^decisions\./, '');
  if (unprefixed !== writeKey && Object.prototype.hasOwnProperty.call(block, unprefixed)) {
    return block[unprefixed];
  }
  const lowered = writeKey.toLowerCase();
  for (const key of Object.keys(block)) {
    if (key.toLowerCase() === lowered) return block[key];
  }
  const nestedLower = lookupPathCaseInsensitive(block, writeKey);
  if (nestedLower !== undefined) return nestedLower;
  const unprefixedLower = unprefixed.toLowerCase();
  for (const key of Object.keys(block)) {
    if (key.toLowerCase() === unprefixedLower) return block[key];
  }
  return undefined;
}

/**
 * Heuristically extracts decision values for a step's `writes` keys from
 * free-form markdown text. A ```decisions JSON block is checked first and
 * takes precedence for the keys it covers; remaining keys fall back to
 * line-by-line pattern matching.
 * @param {string} text The raw AI response text
 * @param {string[]} writeKeys The step's `writes` keys (e.g. ["decisions.database"])
 * @returns {{ found: Record<string, string>, missing: string[] }}
 */
function parseDecisions(text, writeKeys) {
  const keys = Array.isArray(writeKeys) ? writeKeys : [];
  if (typeof text !== 'string' || !text.trim()) {
    return { found: {}, missing: [...keys] };
  }
  // Structured ```decisions JSON block takes precedence (#145). A malformed
  // block is ignored so clipboard pastes still get heuristic parsing.
  let blockValues = null;
  try {
    const block = parseDecisionsBlock(text);
    if (Object.keys(block).length > 0) blockValues = block;
  } catch (err) {
    blockValues = null;
  }
  const lines = text.split(/\r?\n/);
  const found = {};
  const missing = [];
  for (const writeKey of keys) {
    const blockValue = blockValues ? lookupBlockValue(blockValues, writeKey) : undefined;
    if (blockValue !== undefined && blockValue !== null) {
      found[writeKey] = typeof blockValue === 'string' ? blockValue : JSON.stringify(blockValue);
      continue;
    }
    const value = extractFieldValue(lines, normalizeFieldName(writeKey));
    if (value !== null) {
      found[writeKey] = value;
    } else {
      missing.push(writeKey);
    }
  }
  return { found, missing };
}

module.exports = {
  parseDecisions,
  normalizeFieldName,
  cleanValue
};
