import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {openStore} from '../shared/store.mjs';

const root = process.env.AI_BUDDY_PLUGIN_TEST_ROOT??fileURLToPath(new URL('../test-data/', import.meta.url));
const fresh = () => join(mkdtempSync(join(root, 'review-store-')), 'plugin.sqlite');
const pluginId = '@ai-buddy/review-store';

test('review: nested SQLite transactions reject thenables even when the outer callback ignores the result', () => {
  const store = openStore({databasePath: fresh(), pluginId});
  try {
    assert.throws(() => store.transaction(() => {
      store.set('must-rollback', true);
      store.transaction(() => Promise.resolve('unsupported async nested transaction'));
    }), {code: 'ASYNC_SQLITE_TRANSACTION_REJECTED'});
    assert.equal(store.get('must-rollback'), null);
  } finally {store.close();}
});

test('review: a higher declared minimum writer is durably raised before the new writer can write', () => {
  const databasePath = fresh();
  const oldOptions={minimumWriter:'0.1.0-dev.1',writerVersion:'0.1.0-dev.1'};
  const first = openStore({databasePath, pluginId,...oldOptions}); first.close();
  const upgraded = openStore({databasePath, pluginId, minimumWriter: '0.1.0-dev.2', writerVersion: '0.1.0-dev.2'});
  upgraded.set('new-writer-data', true); upgraded.close();
  let oldWriter;
  try {
    assert.throws(() => {oldWriter = openStore({databasePath, pluginId,...oldOptions});}, {code: 'MINIMUM_WRITER_REQUIRED'});
  } finally {oldWriter?.close();}
});
