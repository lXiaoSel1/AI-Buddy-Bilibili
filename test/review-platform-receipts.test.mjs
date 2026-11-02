import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createBilibiliHttpPlatform} from '../plugins/bilibili-companion/src/http-platform.mjs';

test('review: malformed Bilibili comment platform identity stays unknown', async () => {
  const platform = createBilibiliHttpPlatform({request: async () => ({json: {code: 0, data: {rpid: {invalid: true}}}})});
  const result = await platform.sendComment({connectionRef: 'fixture', context: {contextToken: 'c', characterId: 'whale', lifeId: 'life', operationId: 'operation', accountId: 'account'}, lease: {leaseId: 'l', generation: 1}, video: {aid: 123, videoId: 'BVfixture'}, text: 'fixture', idempotencyKey: 'review'});
  assert.equal(result.status, 'unknown');
  assert.equal(result.platformId, undefined);
});
