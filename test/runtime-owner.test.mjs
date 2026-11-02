import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectRuntimeProcess,runtimeOwnerAlive} from '../shared/runtime-owner.mjs';

test('Runtime identity inspects the real test process without signalling termination',{skip:!['win32','linux'].includes(process.platform)},()=>{
 const identity=inspectRuntimeProcess(process.pid);assert.equal(identity?.pid,process.pid);assert.match(identity.birth,/^\d+$/);assert.ok(identity.executable.toLowerCase().endsWith(process.platform==='win32'?'node.exe':'node'));assert.equal(runtimeOwnerAlive(identity),true);
 assert.equal(runtimeOwnerAlive({...identity,birth:identity.birth+'0'}),false,'An independently inspected birth mismatch proves reuse');
});
test('Unknown process inspection never grants ownership over a live legacy process',()=>{
 assert.equal(runtimeOwnerAlive({pid:process.pid,instanceId:'legacy'},()=>undefined),true);
 assert.equal(runtimeOwnerAlive({pid:process.pid,birth:'old',executable:'node'},()=>{throw Error('denied');}),true);
 assert.equal(runtimeOwnerAlive({pid:123,birth:'old',executable:'node'},()=>null),false);
});
