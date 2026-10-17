/**
 * Heuristic decision parsing for the `done --from-clipboard` workflow.
 *
 * AI responses pasted from the clipboard are free-form markdown, so exact
 * key paths cannot be expected. This module extracts a step's `writes`
 * decision keys from the text using tolerant line-based patterns, e.g.:
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
 * Heuristically extracts decision values for a step's `writes` keys from
 * free-form markdown text.
 * @param {string} text The raw AI response text
 * @param {string[]} writeKeys The step's `writes` keys (e.g. ["decisions.database"])
 * @returns {{ found: Record<string, string>, missing: string[] }}
 */
function parseDecisions(text, writeKeys) {
  const keys = Array.isArray(writeKeys) ? writeKeys : [];
  if (typeof text !== 'string' || !text.trim()) {
    return { found: {}, missing: [...keys] };
  }
  const lines = text.split(/\r?\n/);
  const found = {};
  const missing = [];
  for (const writeKey of keys) {
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
