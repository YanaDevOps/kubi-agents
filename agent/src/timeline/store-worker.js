import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parentPort } from 'node:worker_threads';
import { openDatabase } from './sqlite.js';

const DAY = 86400000;
const MAX_TARGETS = 256;
const databases = new Map();
let options;
const fail = (message, code = 'TIMELINE_INVALID') => { throw Object.assign(new Error(message), { code }); };
const iso = (time) => time == null ? null : new Date(time).toISOString();
const hash = (value) => createHash('sha256').update(value).digest('hex');
function timestamp(value, fallback) {
  if (value == null) return fallback;
  const result = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(result) || Math.abs(result) > 8.64e15) fail('Invalid timeline timestamp');
  return Math.trunc(result);
}
function text(value, length = 256) {
  return typeof value === 'string' ? value.slice(0, length) : '';
}
function safeText(value, length = 4096) {
  return text(value, length)
    .replace(/\b(Bearer\s+)\S+/gi, '$1[redacted]')
    .replace(/\b(token|password|secret|authorization|api[-_]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]');
}
function privateFile(filename) {
  const fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
  try {
    if (!fs.fstatSync(fd).isFile()) fail('Timeline database is not a regular file');
    fs.fchmodSync(fd, 0o600);
  } finally { fs.closeSync(fd); }
}
function names() {
  const result = fs.readdirSync(options.directory).filter((name) => /^[a-f0-9]{64}\.sqlite$/.test(name));
  if (result.length > MAX_TARGETS) fail('Too many timeline targets', 'TIMELINE_QUOTA');
  return result;
}
function filename(key) { return path.join(options.directory, `${key}.sqlite`); }
function database(key) {
  if (databases.has(key)) return databases.get(key);
  const file = filename(key);
  if (!fs.existsSync(file) && names().length >= MAX_TARGETS) fail('Too many timeline targets', 'TIMELINE_QUOTA');
  if (databases.size >= 8) {
    const oldest = databases.keys().next().value;
    databases.get(oldest).close();
    databases.delete(oldest);
  }
  privateFile(file);
  const db = openDatabase(file);
  try {
    // DELETE journal avoids accumulating WAL sidecars; journal files inherit DB permissions.
    db.exec(`PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1), seq INTEGER NOT NULL,
        retention INTEGER NOT NULL, pruned INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO meta(id,seq,retention) VALUES(1,0,7);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, dedup TEXT UNIQUE NOT NULL,
        seq INTEGER UNIQUE NOT NULL, occurred INTEGER NOT NULL, observed INTEGER NOT NULL,
        namespace TEXT NOT NULL, severity TEXT NOT NULL, category TEXT NOT NULL,
        search TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_occurrence ON events(occurred);
      CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), updated INTEGER NOT NULL, body TEXT NOT NULL);
      PRAGMA user_version=1;`);
    databases.set(key, db);
    return db;
  } catch (error) { db.close(); throw error; }
}
function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = work(); db.exec('COMMIT'); return result; }
  catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
}
function bytes(key) {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      const stat = fs.lstatSync(filename(key) + suffix);
      if (!stat.isFile()) fail('Unsafe timeline sidecar');
      total += stat.size;
      fs.chmodSync(filename(key) + suffix, 0o600);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return total;
}
function bounds(key) {
  const db = database(key);
  const row = db.get(`SELECT COUNT(*) AS count, MIN(occurred) AS first, MAX(occurred) AS last,
    MIN(observed) AS observedFirst, MAX(observed) AS observedLast FROM events`);
  const meta = db.get('SELECT * FROM meta WHERE id=1');
  return { retainedFrom: iso(row.first), retainedTo: iso(row.last),
    retainedObservedFrom: iso(row.observedFirst), retainedObservedTo: iso(row.observedLast),
    count: row.count, after: meta.seq, retentionDays: meta.retention, pruned: meta.pruned };
}
function removeEvents(db, sql, ...args) {
  const count = Number(db.run(sql, ...args).changes);
  if (count) db.run('UPDATE meta SET pruned=pruned+? WHERE id=1', count);
  return count;
}
function expire(key) {
  const db = database(key);
  const cutoff = Date.now() - db.get('SELECT retention FROM meta WHERE id=1').retention * DAY;
  const changed = transaction(db, () => {
    const count = removeEvents(db, 'DELETE FROM events WHERE occurred < ?', cutoff);
    return Number(db.run('DELETE FROM state WHERE updated < ?', cutoff).changes) + count;
  });
  if (changed) db.exec('VACUUM');
}
function oldest(key) {
  const db = database(key);
  const event = db.get('SELECT id, occurred AS time FROM events ORDER BY occurred, seq LIMIT 1');
  const state = db.get('SELECT updated AS time FROM state WHERE id=1');
  if (!event && !state) return null;
  return state && (!event || state.time < event.time)
    ? { key, time: state.time, state: true } : { key, time: event.time, id: event.id };
}
function evict(candidate) {
  const db = database(candidate.key);
  transaction(db, () => {
    if (candidate.state) db.exec('DELETE FROM state');
    else removeEvents(db, 'DELETE FROM events WHERE id=?', candidate.id);
  });
  // Reclaim actual bytes, not just SQLite free pages. Done only on eviction/expiry.
  db.exec('VACUUM');
}
function enforce() {
  const keys = names().map((name) => name.slice(0, -7));
  for (const key of keys) {
    expire(key);
    while (bytes(key) > options.maxTargetBytes) {
      const candidate = oldest(key);
      if (!candidate) fail('Target quota is smaller than SQLite overhead/sidecars', 'TIMELINE_QUOTA');
      evict(candidate);
    }
  }
  while (keys.reduce((total, key) => total + bytes(key), 0) > options.maxTotalBytes) {
    const candidate = keys.map(oldest).filter(Boolean).sort((a, b) => a.time - b.time)[0];
    if (!candidate) fail('Global quota is smaller than SQLite overhead/sidecars', 'TIMELINE_QUOTA');
    evict(candidate);
  }
}
function normalize(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) fail('Expected a timeline event');
  const observed = timestamp(event.observedAt, Date.now());
  const occurred = timestamp(event.occurredAt, observed);
  const resource = {};
  for (const field of ['apiVersion', 'kind', 'name', 'namespace', 'uid']) {
    if (typeof event.resource?.[field] === 'string') resource[field] = text(event.resource[field]);
  }
  const row = { sourceId: text(event.sourceId), namespace: text(event.namespace ?? resource.namespace),
    severity: text(event.severity || 'info', 32), category: text(event.category || 'event', 64),
    reason: text(event.reason), message: safeText(event.message), resource,
    occurredAt: iso(occurred), observedAt: iso(observed),
    firstOccurredAt: iso(timestamp(event.firstOccurredAt, occurred)), lastOccurredAt: iso(timestamp(event.lastOccurredAt, occurred)),
    firstObservedAt: iso(observed), lastObservedAt: iso(observed), count: 1 };
  if (event.count != null && (!Number.isSafeInteger(event.count) || event.count < 1)) fail('Invalid event count');
  row.count = event.count ?? 1;
  const identity = text(event.dedupKey || event.id, 1024) || hash(JSON.stringify([
    row.sourceId, row.namespace, row.resource, row.category, row.reason, row.message, row.occurredAt,
  ]));
  return { row, dedup: hash(JSON.stringify([row.sourceId, identity])), requestedId: text(event.id, 256), cumulative: event.count != null };
}
function append(key, event) {
  const entries = Array.isArray(event) ? event : [event];
  if (!entries.length || entries.length > 100) fail('Append accepts 1..100 events');
  const normalized = entries.map(normalize);
  const db = database(key);
  const ids = transaction(db, () => normalized.map(({ row, dedup, requestedId, cumulative }) => {
    const existing = db.get('SELECT body FROM events WHERE dedup=?', dedup);
    const previous = existing ? JSON.parse(existing.body) : null;
    if (previous) {
      row.id = previous.id;
      row.count = cumulative ? Math.max(previous.count, row.count) : previous.count + 1;
      row.firstOccurredAt = iso(Math.min(Date.parse(previous.firstOccurredAt), Date.parse(row.firstOccurredAt)));
      row.lastOccurredAt = iso(Math.max(Date.parse(previous.lastOccurredAt), Date.parse(row.lastOccurredAt)));
      row.firstObservedAt = iso(Math.min(Date.parse(previous.firstObservedAt), Date.parse(row.observedAt)));
      row.lastObservedAt = iso(Math.max(Date.parse(previous.lastObservedAt), Date.parse(row.observedAt)));
      row.occurredAt = row.lastOccurredAt;
      row.observedAt = row.lastObservedAt;
    } else row.id = requestedId || randomUUID();
    db.run('UPDATE meta SET seq=seq+1 WHERE id=1');
    row.seq = db.get('SELECT seq FROM meta WHERE id=1').seq;
    db.run(`INSERT INTO events(id,dedup,seq,occurred,observed,namespace,severity,category,search,body)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(dedup) DO UPDATE SET seq=excluded.seq,
      occurred=excluded.occurred,observed=excluded.observed,namespace=excluded.namespace,
      severity=excluded.severity,category=excluded.category,search=excluded.search,body=excluded.body`,
    row.id, dedup, row.seq, Date.parse(row.occurredAt), Date.parse(row.observedAt), row.namespace,
    row.severity, row.category, [row.message, row.reason, ...Object.values(row.resource)].join(' ').toLowerCase(), JSON.stringify(row));
    return row.id;
  }));
  enforce();
  return { ids, ...bounds(key) };
}
function list(key, query) {
  enforce();
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(query.limit) || 25)));
  const where = [];
  const args = [];
  let ascending = query.after != null;
  let position = ascending ? Number(query.after) : null;
  if (query.cursor) {
    try {
      const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
      if (cursor.key !== key || !Number.isSafeInteger(cursor.seq) || typeof cursor.ascending !== 'boolean') throw new Error();
      position = cursor.seq;
      ascending = cursor.ascending;
    } catch { fail('Invalid timeline cursor'); }
  }
  if (position != null) {
    if (!Number.isSafeInteger(position) || position < 0) fail('Invalid timeline after sequence');
    where.push(`seq ${ascending ? '>' : '<'} ?`); args.push(position);
  }
  if (query.namespace) {
    where.push(query.includeCluster ? '(namespace=? OR namespace=\'\')' : 'namespace=?');
    args.push(text(query.namespace));
  } else if (query.includeCluster === false) where.push("namespace<>''");
  for (const field of ['severity', 'category']) {
    if (query[field] == null || query[field] === '') continue;
    const values = Array.isArray(query[field]) ? query[field] : [query[field]];
    if (!values.length || values.length > 20) fail(`Invalid ${field} filter`);
    where.push(`${field} IN (${values.map(() => '?').join(',')})`); args.push(...values.map((value) => text(value)));
  }
  if (query.search) { where.push('instr(search,?)>0'); args.push(text(query.search, 256).toLowerCase()); }
  for (const [field, comparison] of [['from', '>='], ['to', '<=']]) {
    if (query[field] != null) { where.push(`occurred ${comparison} ?`); args.push(timestamp(query[field])); }
  }
  const rows = database(key).all(`SELECT body FROM events ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY seq ${ascending ? 'ASC' : 'DESC'} LIMIT ?`, ...args, limit + 1);
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map((row) => JSON.parse(row.body));
  const retained = bounds(key);
  const last = items.at(-1)?.seq;
  return { ...retained, items, hasMore,
    nextCursor: hasMore ? Buffer.from(JSON.stringify({ key, seq: last, ascending })).toString('base64url') : null,
    after: ascending && hasMore ? last : retained.after };
}

// Only compact reconnect identifiers/counters are retained, never specs, logs or credentials.
const stateFields = new Set(['uid', 'id', 'kind', 'name', 'namespace', 'apiVersion', 'resourceVersion',
  'generation', 'fingerprint', 'hash', 'count', 'restartCount', 'replicas', 'readyReplicas',
  'availableReplicas', 'observedGeneration', 'phase', 'status', 'reason', 'type', 'sourceId',
  'lastTimestamp', 'firstTimestamp', 'occurredAt', 'observedAt', 'updatedAt', 'lastSeenAt',
  'lastObservedAt', 'lastOccurredAt', 'timestamp', 'cursor', 'seq', 'after', 'supported', 'available',
  'error', 'message', 'deleted', 'initialized', 'version', 'checkpoint']);
function sanitizeState(state) {
  let nodes = 0;
  function clean(value, depth, map = false) {
    if (++nodes > 12000 || depth > 8) fail('Timeline state is too complex', 'TIMELINE_TOO_LARGE');
    if (value == null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') return safeText(value, 1024);
    if (Array.isArray(value)) return value.slice(0, 2000).map((entry) => clean(entry, depth + 1));
    const result = Object.create(null);
    for (const [key, entry] of Object.entries(value)) {
      if (/token|secret|password|authorization|credential|kubeconfig|^data$|^spec$|^annotations$|^managedFields$/i.test(key)) continue;
      if (map || stateFields.has(key)) result[text(key, 256)] = clean(entry, depth + 1);
    }
    return result;
  }
  const result = {};
  for (const field of ['sources', 'baselines', 'checkpoints']) {
    if (state?.[field] != null) result[field] = clean(state[field], 0, true);
  }
  for (const field of ['initialized', 'lastObservedAt', 'gaps']) {
    if (state?.[field] != null) result[field] = clean(state[field], 0);
  }
  const body = JSON.stringify(result);
  if (Buffer.byteLength(body) > options.maxStateBytes) fail('Timeline state exceeds its limit', 'TIMELINE_TOO_LARGE');
  return body;
}
function dispatch(operation, key, value) {
  if (operation === 'init') {
    options = value;
    fs.mkdirSync(options.directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(options.directory).isDirectory()) fail('Timeline directory must not be a symlink');
    fs.chmodSync(options.directory, 0o700);
    enforce();
    return { ready: true };
  }
  if (operation === 'close') {
    for (const db of databases.values()) db.close();
    databases.clear();
    return null;
  }
  if (!/^[a-f0-9]{64}$/.test(key)) fail('Invalid target key');
  if (operation === 'append') return append(key, value);
  if (operation === 'list') return list(key, value || {});
  if (operation === 'prune' && value?.retentionDays != null) {
    if (!Number.isInteger(value.retentionDays) || value.retentionDays < 1 || value.retentionDays > 30) fail('retentionDays must be 1..30');
    database(key).run('UPDATE meta SET retention=? WHERE id=1', value.retentionDays);
  }
  if (operation === 'saveState') {
    const body = sanitizeState(value);
    database(key).run('INSERT OR REPLACE INTO state(id,updated,body) VALUES(1,?,?)', Date.now(), body);
  }
  database(key);
  enforce();
  if (operation === 'getState' || operation === 'saveState') {
    const row = database(key).get('SELECT body FROM state WHERE id=1');
    return row ? JSON.parse(row.body) : null;
  }
  if (operation === 'detail') {
    const row = database(key).get('SELECT body FROM events WHERE id=?', text(value));
    return row ? JSON.parse(row.body) : null;
  }
  if (operation === 'status' || operation === 'prune') return { ...bounds(key), bytes: bytes(key),
    totalBytes: names().reduce((total, name) => total + bytes(name.slice(0, -7)), 0),
    maxTargetBytes: options.maxTargetBytes, maxTotalBytes: options.maxTotalBytes };
  fail('Unknown timeline operation');
}

parentPort.on('message', ({ id, operation, targetKey, payload }) => {
  try { parentPort.postMessage({ id, result: dispatch(operation, targetKey, JSON.parse(payload)) }); }
  catch (error) {
    parentPort.postMessage({ id, error: { code: error.code || 'TIMELINE_STORAGE', message: error.message } });
  }
});
