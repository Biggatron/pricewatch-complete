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

function initializeLogger() {
  if (isInitialized) {
    return logFilePath;
  }

  const logDirectory = path.resolve(process.cwd(), keys.logging.directory);
  fs.mkdirSync(logDirectory, { recursive: true });
  logFilePath = path.join(logDirectory, keys.logging.filename);

  console.log = createLoggerMethod('log');
  console.info = createLoggerMethod('info');
  console.warn = createLoggerMethod('warn');
  console.error = createLoggerMethod('error');

  isInitialized = true;
  console.info(`File logging enabled at ${logFilePath}`);

  return logFilePath;
}

function createLoggerMethod(level) {
  return (...args) => {
    originalConsole[level](...args);

    const line = `[${new Date().toISOString()}] ${level.toUpperCase()} ${args
      .map((arg) => formatArgument(arg))
      .join(' ')}\n`;

    fs.appendFile(logFilePath, line, (err) => {
      if (err) {
        originalConsole.error('Failed to write log file:', err.message);
      }
    });
  };
}

function formatArgument(arg) {
  if (arg instanceof Error) {
    return arg.stack || arg.message;
  }

  if (typeof arg === 'string') {
    return arg;
  }

  try {
    return JSON.stringify(arg);
  } catch (error) {
    return String(arg);
  }
}

function getLogFilePath() {
  return logFilePath || initializeLogger();
}

async function readRecentLogs(maxLines = keys.logging.maxLines) {
  const content = await fs.promises.readFile(getLogFilePath(), 'utf8');
  const lines = content.split(/\r?\n/).filter(Boolean);
  return lines.slice(-maxLines);
}

module.exports = {
  initializeLogger,
  getLogFilePath,
  readRecentLogs
};
