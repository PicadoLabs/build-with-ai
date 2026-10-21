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
 * Looks up a `writes` key in a parsed ```decisions JSON block. Keys are
 * matched exactly first, then case-insensitively for tolerance.
 * @param {Record<string, unknown>} block
 * @param {string} writeKey
 * @returns {unknown} The block value, or undefined when not present
 */
function lookupBlockValue(block, writeKey) {
  if (Object.prototype.hasOwnProperty.call(block, writeKey)) {
    return block[writeKey];
  }
  const lowered = writeKey.toLowerCase();
  for (const key of Object.keys(block)) {
    if (key.toLowerCase() === lowered) return block[key];
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
