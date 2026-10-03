const pc = require('picocolors');

const logger = {
  info: (msg) => console.log(pc.cyan('ℹ ') + msg),
  success: (msg) => console.log(pc.green('✔ ') + msg),
  warn: (msg) => console.log(pc.yellow('⚠ ') + msg),
  error: (msg) => console.error(pc.red('✖ ') + msg),
  log: (msg) => console.log(msg),
  bold: (msg) => pc.bold(msg),
  dim: (msg) => pc.dim(msg),
  cyan: (msg) => pc.cyan(msg),
  green: (msg) => pc.green(msg),
  yellow: (msg) => pc.yellow(msg),
  magenta: (msg) => pc.magenta(msg)
};

module.exports = logger;
