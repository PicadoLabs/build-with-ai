const pc = require('picocolors');
const { isUtf8Supported } = require('./ui');

/**
 * Log symbols: full Unicode glyphs where the terminal supports UTF-8,
 * plain ASCII fallbacks for legacy Windows CMD consoles where raw
 * Unicode glyphs render as mojibake (#147).
 */
const LOG_SYMBOLS = isUtf8Supported()
  ? { info: 'ℹ', success: '✔', warn: '⚠', error: '✖' }
  : { info: 'i', success: '+', warn: '!', error: 'x' };

const logger = {
  info: (msg) => console.log(pc.cyan(`${LOG_SYMBOLS.info} `) + msg),
  success: (msg) => console.log(pc.green(`${LOG_SYMBOLS.success} `) + msg),
  warn: (msg) => console.log(pc.yellow(`${LOG_SYMBOLS.warn} `) + msg),
  error: (msg) => console.error(pc.red(`${LOG_SYMBOLS.error} `) + msg),
  log: (msg) => console.log(msg),
  bold: (msg) => pc.bold(msg),
  dim: (msg) => pc.dim(msg),
  cyan: (msg) => pc.cyan(msg),
  green: (msg) => pc.green(msg),
  yellow: (msg) => pc.yellow(msg),
  magenta: (msg) => pc.magenta(msg)
};

module.exports = logger;
