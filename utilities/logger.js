const fs = require('fs');
const path = require('path');
const keys = require('../config/keys');

const originalConsole = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console)
};

let isInitialized = false;
let logFilePath = '';
let logStream = null;

function initializeLogger(options = {}) {
  if (isInitialized) {
    return logFilePath;
  }

  const announce = options.announce !== false;

  const logDirectory = path.resolve(process.cwd(), keys.logging.directory);
  fs.mkdirSync(logDirectory, { recursive: true });
  logFilePath = path.join(logDirectory, keys.logging.filename);
  openLogStream();

  console.log = createLoggerMethod('log');
  console.info = createLoggerMethod('info');
  console.warn = createLoggerMethod('warn');
  console.error = createLoggerMethod('error');

  isInitialized = true;
  if (announce) {
    console.info(`File logging enabled at ${logFilePath}`);
  }

  return logFilePath;
}

function openLogStream() {
  logStream = fs.createWriteStream(logFilePath, { flags: 'a' });
}

function createLoggerMethod(level) {
  return (...args) => {
    originalConsole[level](...args);

    const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${args
      .map((arg) => formatArgument(arg))
      .join(' ')}\n`;

    if (!logStream.write(line)) {
      logStream.once('error', (err) => {
        originalConsole.error('Failed to write log file:', err.message);
      });
    }
  };
}

function formatArgument(arg) {
  if (arg instanceof Error) {
    return JSON.stringify({
      name: arg.name,
      message: arg.message,
      stack: arg.stack
    });
  }

  if (typeof arg === 'string') {
    return arg;
  }

  try {
    return JSON.stringify(arg, errorReplacer);
  } catch (error) {
    return String(arg);
  }
}

function errorReplacer(key, value) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }

  if (Buffer.isBuffer(value)) {
    return `[Buffer length=${value.length}]`;
  }

  return value;
}

function getLogFilePath() {
  return logFilePath || initializeLogger();
}

async function readRecentLogs(maxLines = keys.logging.maxLines) {
  const content = await fs.promises.readFile(getLogFilePath(), 'utf8');
  const lines = content.split(/\r?\n/).filter(Boolean);
  return lines.slice(-maxLines);
}

async function clearLogFile() {
  const filePath = getLogFilePath();

  if (logStream) {
    await new Promise((resolve) => {
      logStream.end(resolve);
    });
  }

  await fs.promises.writeFile(filePath, '', 'utf8');
  openLogStream();
  originalConsole.info(`Log file cleared at ${filePath}`);
}

module.exports = {
  initializeLogger,
  getLogFilePath,
  readRecentLogs,
  clearLogFile
};
