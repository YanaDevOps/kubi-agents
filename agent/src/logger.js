import fs from 'node:fs';
import path from 'node:path';

const levels = { debug: 10, info: 20, warn: 30, error: 40 };

function redact(value) {
  return String(value)
    .replace(/(Bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/(pairing[-_ ]token[=: ]+)[^\s]+/gi, '$1[redacted]')
    .replace(/(agent[-_ ]secret[=: ]+)[^\s]+/gi, '$1[redacted]')
    .replace(/((?:password|bearer[_-]?token|client[_-]?key)[=: ]+)[^\s]+/gi, '$1[redacted]');
}

function rotate(filePath, maxSizeBytes, maxFiles) {
  try {
    if (fs.statSync(filePath).size < maxSizeBytes) return;
  } catch {
    return;
  }
  for (let index = maxFiles - 1; index >= 1; index -= 1) {
    const source = index === 1 ? filePath : `${filePath}.${index - 1}`;
    const destination = `${filePath}.${index}`;
    if (fs.existsSync(source)) fs.renameSync(source, destination);
  }
}

export function createAgentLogger(config = {}) {
  const minimum = levels[config.level] || levels.info;
  const outputs = Array.isArray(config.outputs) ? config.outputs : ['stdout'];
  const file = config.file && typeof config.file.path === 'string' && config.file.path.trim() ? config.file : null;
  const maxSizeBytes = Math.max(1, Number(file?.max_size_mb || 10)) * 1024 * 1024;
  const maxFiles = Math.max(1, Math.min(20, Number(file?.max_files || 5)));
  if (file) fs.mkdirSync(path.dirname(file.path), { recursive: true, mode: 0o750 });

  const write = (level, message) => {
    if (levels[level] < minimum) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${redact(message)}\n`;
    if (outputs.includes('stdout')) {
      (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line);
    }
    if (file) {
      rotate(file.path, maxSizeBytes, maxFiles);
      fs.appendFileSync(file.path, line, { mode: 0o640 });
      fs.chmodSync(file.path, 0o640);
    }
  };

  return {
    debug: (message) => write('debug', message),
    info: (message) => write('info', message),
    warn: (message) => write('warn', message),
    error: (message) => write('error', message)
  };
}
