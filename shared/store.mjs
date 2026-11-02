import {DatabaseSync} from 'node:sqlite';
import {existsSync, mkdirSync} from 'node:fs';
import {dirname, isAbsolute} from 'node:path';
import {assert, fail} from './errors.mjs';
import {VERSION} from './version.mjs';

export const WRITER_VERSION = VERSION;
function versionParts(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-dev\.(\d+))?$/.exec(value ?? '');
  assert(match, 'WRITER_VERSION_INVALID');
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] == null ? Number.MAX_SAFE_INTEGER : Number(match[4])];
}
function compare(a, b) {
  const left = versionParts(a), right = versionParts(b);
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}
function metadata(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='a_plugin_meta'").get();
  assert(table, 'FOREIGN_DATABASE_REJECTED');
  return db.prepare('SELECT plugin_id, schema_version, minimum_writer FROM a_plugin_meta WHERE id=1').get();
}
export function openStore({databasePath, pluginId, schemaVersion = 1, minimumWriter = WRITER_VERSION, writerVersion = WRITER_VERSION}) {
  assert(isAbsolute(databasePath ?? ''), 'PRIVATE_DATABASE_PATH_REQUIRED');
  assert(typeof pluginId === 'string' && pluginId.startsWith('@ai-buddy/'), 'PLUGIN_ID_REQUIRED');
  assert(Number.isSafeInteger(schemaVersion) && schemaVersion === 1, 'SCHEMA_UNSUPPORTED');
  versionParts(minimumWriter); versionParts(writerVersion);
  assert(compare(writerVersion, minimumWriter) >= 0, 'MINIMUM_WRITER_REQUIRED');
  // Inspect existing databases read-only before any WAL/DDL or writer metadata change.
  if (existsSync(databasePath)) {
    const probe = new DatabaseSync(databasePath, {readOnly: true});
    try {
      // A second native process may still be finishing a checkpoint. This is
      // a connection-local bounded wait, not a retry of a model/send or a DDL.
      probe.exec('PRAGMA busy_timeout=3000');
      const row = metadata(probe);
      assert(row?.plugin_id === pluginId, 'FOREIGN_DATABASE_REJECTED');
      assert(row.schema_version === schemaVersion, 'SCHEMA_UNSUPPORTED');
      assert(compare(writerVersion, row.minimum_writer) >= 0, 'MINIMUM_WRITER_REQUIRED');
    } finally { probe.close(); }
  }
  mkdirSync(dirname(databasePath), {recursive: true});
  const db = new DatabaseSync(databasePath);
  let closed = false, depth = 0, savepointSequence = 0;
  function callSync(fn) {
    assert(typeof fn === 'function', 'SQLITE_TRANSACTION_CALLBACK_REQUIRED');
    assert(fn.constructor?.name !== 'AsyncFunction', 'ASYNC_SQLITE_TRANSACTION_REJECTED');
    const result=fn();
    if(result&&typeof result.then==='function') {
      // Reject every nesting level, without allowing an ignored nested result
      // to commit. Known async callbacks are rejected before they can start.
      Promise.resolve(result).catch(()=>{});
      throw fail('ASYNC_SQLITE_TRANSACTION_REJECTED');
    }
    return result;
  }
  function transaction(fn) {
    assert(!closed, 'STORE_CLOSED');
    if (depth) {
      const name='a_store_'+(++savepointSequence);
      db.exec('SAVEPOINT '+name); depth++;
      try {const result=callSync(fn);db.exec('RELEASE SAVEPOINT '+name);return result;}
      catch(error) {db.exec('ROLLBACK TO SAVEPOINT '+name);db.exec('RELEASE SAVEPOINT '+name);throw error;}
      finally {depth--;}
    }
    db.exec('BEGIN IMMEDIATE'); depth++;
    try {
      const result = callSync(fn);
      db.exec('COMMIT'); return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    finally { depth--; }
  }
  try {
   db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
   transaction(() => {
    db.exec('CREATE TABLE IF NOT EXISTS a_plugin_meta(id INTEGER PRIMARY KEY CHECK(id=1),plugin_id TEXT NOT NULL,schema_version INTEGER NOT NULL,minimum_writer TEXT NOT NULL); CREATE TABLE IF NOT EXISTS a_plugin_kv(key TEXT PRIMARY KEY,value TEXT NOT NULL);');
    db.prepare('INSERT OR IGNORE INTO a_plugin_meta VALUES(1,?,?,?)').run(pluginId, schemaVersion, minimumWriter);
    const row = metadata(db);
    assert(row.plugin_id === pluginId && row.schema_version === schemaVersion, 'DATABASE_BINDING_CHANGED');
    assert(compare(writerVersion, row.minimum_writer) >= 0, 'MINIMUM_WRITER_REQUIRED');
    if(compare(minimumWriter,row.minimum_writer)>0)db.prepare('UPDATE a_plugin_meta SET minimum_writer=? WHERE id=1').run(minimumWriter);
   });
  } catch (error) { db.close(); throw error; }
  return {
    db, transaction, databasePath,
    get(key, fallback = null) { const row = db.prepare('SELECT value FROM a_plugin_kv WHERE key=?').get(key); return row ? JSON.parse(row.value) : structuredClone(fallback); },
    set(key, value) { db.prepare('INSERT INTO a_plugin_kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); return value; },
    delete(key) { db.prepare('DELETE FROM a_plugin_kv WHERE key=?').run(key); },
    close() { if (!closed) { db.close(); closed = true; } },
  };
}
