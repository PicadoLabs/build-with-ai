/**
 * Cross-platform clipboard helper.
 * Gracefully handles headless environments or unsupported OS setups.
 * Supports both CommonJS and ESM clipboardy exports.
 *
 * The resolved clipboardy module is cached after the first lookup so
 * repeated calls do not re-evaluate the dynamic import.
 */

let cachedClipboard = null;
let clipboardResolved = false;

async function getClipboardModule() {
  if (clipboardResolved) return cachedClipboard;
  clipboardResolved = true;
  try {
    const imported = await import('clipboardy');
    cachedClipboard = imported.default || imported;
  } catch {
    cachedClipboard = null;
  }
  return cachedClipboard;
}

/**
 * @param {string} text
 * @returns {Promise<boolean>} Whether copying succeeded
 */
async function copyToClipboard(text) {
  try {
    const cb = await getClipboardModule();
    if (!cb) return false;

    if (typeof cb.writeSync === 'function') {
      cb.writeSync(text);
      return true;
    } else if (typeof cb.write === 'function') {
      await cb.write(text);
      return true;
    }
    return false;
  } catch {
    // Graceful fallback if clipboard is unavailable in the environment
    return false;
  }
}

module.exports = {
  copyToClipboard
};
