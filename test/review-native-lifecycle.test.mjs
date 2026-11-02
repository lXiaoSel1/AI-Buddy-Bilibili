import test from 'node:test';
import assert from 'node:assert/strict';
import {registerNativePlugin} from '../shared/native.mjs';
import {CONTRACT_HASH, REQUIRED_CAPABILITIES} from '../shared/contract.mjs';

const pluginId = '@ai-buddy/qq-connect';
const deferred = () => { let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve}; };
function fixture({serviceClose = async () => {}, routeThrows = false} = {}) {
  const counts = {serviceClosed: 0, bridgeClosed: 0, unsubscribed: 0, routeClosed: 0};
  const bridge = {
    describe: async () => ({pluginId, mode: 'runtime', contractHash: CONTRACT_HASH, contractAcknowledgement: {owner: 'B', hash: CONTRACT_HASH}, capabilities: REQUIRED_CAPABILITIES[pluginId]}),
    invoke: async () => ({}), dataDirectory: 'C:/fixture-private-review',
    authorizeRequest: async () => ({contextToken: 'fixture-host-principal'}),
    subscribeEvents: async () => () => {counts.unsubscribed++;},
    close: async () => {counts.bridgeClosed++;},
  };
  const service = {dispatch: async () => ({}), onHostEvent: async () => ({}), close: async () => {counts.serviceClosed++; await serviceClose();}};
  const ctx = {buddySocialServices: {openPlugin: async () => bridge}, connection: {fetch: {register() {if (routeThrows) throw Error('fixture-route-register-failed'); return () => {counts.routeClosed++;};}}}, effect() {}};
  return {ctx, service, counts};
}

test('review: every concurrent native close waits until the same service drain ends', async () => {
  const gate = deferred();
  const f = fixture({serviceClose: () => gate.promise});
  const p = await registerNativePlugin(f.ctx, {pluginId, label: 'QQ连接', createService: () => f.service});
  const first = p.close();
  let secondResolved = false;
  const second = p.close().then(() => {secondResolved = true;});
  try {
    await Promise.resolve(); await Promise.resolve();
    assert.equal(secondResolved, false, 'a concurrent caller must not observe successful cleanup before the first drain finishes');
  } finally {gate.resolve(); await Promise.allSettled([first, second]);}
  assert.equal(f.counts.serviceClosed, 1);
  assert.equal(f.counts.bridgeClosed, 1);
});

test('review: failure to register native route drains the already opened runtime', async () => {
  const f = fixture({routeThrows: true});
  await assert.rejects(registerNativePlugin(f.ctx, {pluginId, label: 'QQ连接', createService: () => f.service}), /fixture-route-register-failed/);
  assert.equal(f.counts.unsubscribed, 1, 'initialization route failure must dispose the background subscription');
  assert.equal(f.counts.serviceClosed, 1, 'initialization route failure must close the service');
  assert.equal(f.counts.bridgeClosed, 1, 'initialization route failure must close the bridge');
});

test('review: native close is assigned before a disposer can synchronously reenter it', async () => {
  const f = fixture();
  let handle, reentered = false, nested;
  f.ctx.connection.fetch.register = () => () => {
    f.counts.routeClosed++;
    if (!reentered) {reentered = true; nested = handle.close();}
  };
  handle = await registerNativePlugin(f.ctx, {pluginId, label: 'QQ连接', createService: () => f.service});
  await handle.close(); await nested;
  assert.equal(f.counts.routeClosed, 1, 'one close operation must own route disposal despite synchronous reentry');
  assert.equal(f.counts.serviceClosed, 1);
  assert.equal(f.counts.bridgeClosed, 1);
});
