import path from 'node:path';
import os from 'node:os';
import { Worker } from 'node:worker_threads';

const MiB = 1024 * 1024;
const failure = (message, code) => Object.assign(new Error(message), { code });

function defaultDirectory() {
  if (process.env.KUBI_AGENT_IDENTITY) return path.join(path.dirname(process.env.KUBI_AGENT_IDENTITY), 'timeline');
  const base = process.platform === 'win32' && process.env.APPDATA
    ? process.env.APPDATA : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'kubi-agent', 'timeline');
}

/**
 * All filesystem/SQLite work runs off the relay thread. Compile with BOTH entries:
 * bun build agent/src/cli.js agent/src/timeline/store-worker.js --compile --outfile dist/kubi-agent
 * targetKey is the manager's SHA256(workspace, agent, connection, selector).
 * append's count is cumulative when supplied, otherwise each observation adds one.
 * after is a target-local change sequence; cursor is opaque and target-bound.
 * Errors reject only the operation. Callers should report degraded persistence.
 */
export async function createTimelineStore({
  directory = defaultDirectory(), maxTargetBytes = 100 * MiB, maxTotalBytes = 512 * MiB,
  maxQueue = 64, maxRequestBytes = MiB, maxStateBytes = 256 * 1024,
} = {}) {
  for (const [key, value] of Object.entries({ maxTargetBytes, maxTotalBytes, maxQueue, maxRequestBytes, maxStateBytes })) {
    if (!Number.isSafeInteger(value) || value < 1) throw failure(`Invalid ${key}`, 'TIMELINE_INVALID');
  }
  // A parent launched with --input-type=module (common in smoke tests) cannot
  // be used as a worker entrypoint. The worker is an actual module file.
  const worker = new Worker(new URL('./store-worker.js', import.meta.url), {
    execArgv: process.execArgv.filter((argument) => argument !== '--input-type=module')
  });
  const pending = new Map();
  let sequence = 0;
  let closed = false;
  let fatal;
  let closing;
  const fail = (error) => {
    fatal = failure(error.message || 'Timeline worker stopped', error.code || 'TIMELINE_WORKER');
    for (const request of pending.values()) request.reject(fatal);
    pending.clear();
  };
  worker.on('error', fail);
  worker.on('exit', (code) => {
    if (!closed || pending.size) fail(failure(`Timeline worker exited (${code})`, 'TIMELINE_WORKER'));
  });
  worker.on('message', ({ id, result, error }) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    if (error) request.reject(failure(error.message, error.code));
    else request.resolve(result);
  });
  function request(operation, targetKey, value) {
    if (fatal) return Promise.reject(fatal);
    if (closed) return Promise.reject(failure('Timeline store is closed', 'TIMELINE_CLOSED'));
    if (pending.size >= maxQueue) return Promise.reject(failure('Timeline queue is full', 'TIMELINE_BUSY'));
    if (targetKey !== null && !/^[a-f0-9]{64}$/.test(targetKey)) {
      return Promise.reject(failure('targetKey must be a lowercase SHA256 hex digest', 'TIMELINE_INVALID'));
    }
    let payload;
    try {
      payload = JSON.stringify(value ?? null);
      if (Buffer.byteLength(payload) > maxRequestBytes) throw failure('Timeline request is too large', 'TIMELINE_TOO_LARGE');
    } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      try { worker.postMessage({ id, operation, targetKey, payload }); }
      catch (error) { pending.delete(id); reject(error); }
    });
  }
  try {
    await request('init', null, { directory: path.resolve(directory), maxTargetBytes, maxTotalBytes, maxStateBytes });
  } catch (error) {
    closed = true;
    await worker.terminate();
    throw error;
  }
  return {
    append: (targetKey, event) => request('append', targetKey, event),
    list: (targetKey, query = {}) => request('list', targetKey, query),
    detail: (targetKey, id) => request('detail', targetKey, id),
    getState: (targetKey) => request('getState', targetKey),
    saveState: (targetKey, state) => request('saveState', targetKey, state),
    status: (targetKey) => request('status', targetKey),
    prune: (targetKey, options = {}) => request('prune', targetKey, options),
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        // Drain accepted work even when the bounded public queue is full.
        try {
          if (!fatal) await new Promise((resolve, reject) => {
            const id = ++sequence;
            pending.set(id, { resolve, reject });
            worker.postMessage({ id, operation: 'close', targetKey: null, payload: 'null' });
          });
        } finally { await worker.terminate(); }
      })();
      return closing;
    },
  };
}
