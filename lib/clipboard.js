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
 * Copy via the ANSI OSC 52 escape sequence, which modern terminal emulators
 * (Windows Terminal, iTerm2, WezTerm, Alacritty, Ghostty, VS Code) honour by
 * forwarding the base64 payload to the client machine's clipboard. This is
 * the only clipboard path that works over SSH or in headless sessions, where
 * clipboardy has no X11/Wayland display or native helper (#199).
 *
 * @param {string} text
 * @param {NodeJS.WriteStream} [stream] Defaults to process.stdout; exposed
 *   as a parameter so tests can capture the sequence without a TTY.
 * @returns {boolean} Whether the sequence was written
 */
function copyOsc52(text, stream = process.stdout) {
  if (!stream || stream.isTTY !== true) return false;
  const base64 = Buffer.from(text, 'utf8').toString('base64');
  stream.write(`\x1b]52;c;${base64}\x07`);
  return true;
}

/**
 * @param {string} text
 * @returns {Promise<boolean>} Whether copying succeeded
 */
async function copyToClipboard(text) {
  try {
    const cb = await getClipboardModule();
    if (cb) {
      if (typeof cb.writeSync === 'function') {
        cb.writeSync(text);
        return true;
      } else if (typeof cb.write === 'function') {
        await cb.write(text);
        return true;
      }
    }
  } catch {
    // clipboardy failed (e.g. no X server in a remote session) — fall
    // through to the OSC 52 attempt below instead of giving up.
  }

  // clipboardy is unavailable or failed: try OSC 52, which reaches the
  // client clipboard over the terminal stream with no native helper (#199).
  return copyOsc52(text);
}

/**
 * Reads text from the system clipboard.
 * @returns {Promise<string|null>} The clipboard text, or null when the
 * clipboard is empty, unreadable, or unsupported in this environment
 */
async function readFromClipboard() {
  try {
    const cb = await getClipboardModule();
    if (!cb) return null;

    if (typeof cb.readSync === 'function') {
      const text = cb.readSync();
      return typeof text === 'string' && text.trim() ? text : null;
    } else if (typeof cb.read === 'function') {
      const text = await cb.read();
      return typeof text === 'string' && text.trim() ? text : null;
    }
    return null;
  } catch {
    // Graceful fallback if clipboard is unavailable in the environment
    return null;
  }
}

module.exports = {
  copyToClipboard,
  copyOsc52,
  readFromClipboard
};
