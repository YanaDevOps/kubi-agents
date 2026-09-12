// Keep runtime-specific imports lazy so Node source and Bun executables share code.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let SQLite;
if (process.versions.bun) SQLite = await import('bun:sqlite');
else {
  try { SQLite = { DatabaseSync: require('better-sqlite3') }; }
  catch { SQLite = await import('node:sqlite'); }
}

export function openDatabase(filename) {
  const database = process.versions.bun
    ? new SQLite.Database(filename, { create: true })
    : SQLite.DatabaseSync === require('better-sqlite3')
      ? new SQLite.DatabaseSync(filename)
      : new SQLite.DatabaseSync(filename);
  database.exec('PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY;');
  return {
    exec: (sql) => database.exec(sql),
    run: (sql, ...args) => database.prepare(sql).run(...args),
    get: (sql, ...args) => database.prepare(sql).get(...args),
    all: (sql, ...args) => database.prepare(sql).all(...args),
    close: () => database.close(),
  };
}
