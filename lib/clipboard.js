/**
 * Cross-platform clipboard helper.
 * Gracefully handles headless environments or unsupported OS setups.
 * Supports both CommonJS and ESM clipboardy exports.
 * 
 * @param {string} text
 * @returns {Promise<boolean>} Whether copying succeeded
 */
async function copyToClipboard(text) {
  try {
    let cb = null;
    try {
      const imported = await import('clipboardy');
      cb = imported.default || imported;
    } catch {
      cb = null;
    }

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

