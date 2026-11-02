import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {openStore} from '../shared/store.mjs';
import {registerNativePlugin} from '../shared/native.mjs';
import {CONTRACT_HASH,REQUIRED_CAPABILITIES} from '../shared/contract.mjs';
const pluginId='@ai-buddy/qq-connect';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function nativeFixture(authorizeRequest=async()=>({contextToken:'host-issued'})){
 let dispatches=0,route;const bridge={describe:async()=>({pluginId,mode:'runtime',contractHash:CONTRACT_HASH,contractAcknowledgement:{owner:'B',hash:CONTRACT_HASH},capabilities:REQUIRED_CAPABILITIES[pluginId]}),invoke:async()=>{},dataDirectory:'C:/fixture-private',authorizeRequest,subscribeEvents:async()=>()=>{},close:async()=>{}};
 return {ctx:{buddySocialServices:{openPlugin:async()=>bridge},connection:{fetch:{register:r=>{route=r;return()=>{};}}},effect(){}},service:{dispatch:async()=>{dispatches++;return {ok:true};},onHostEvent:async()=>{},close:async()=>{}},route:()=>route,dispatches:()=>dispatches};
}
test('AUDIT native GET cannot run a state-changing action even with valid APP authorization',async()=>{
 const f=nativeFixture(),p=await registerNativePlugin(f.ctx,{pluginId,label:'QQ',createService:()=>f.service});
 try{const response=await f.route().fetch(new Request('http://127.0.0.1/api/ai-buddy/qq-connect?action=disconnect'));assert.equal(response.status,405);assert.equal(f.dispatches(),0);}finally{await p.close();}
});
test('AUDIT native authorization resolving after close cannot dispatch into a drained service',async()=>{
 const entered=deferred(),auth=deferred(),f=nativeFixture(async()=>{entered.resolve();return auth.promise;}),p=await registerNativePlugin(f.ctx,{pluginId,label:'QQ',createService:()=>f.service});
 const request=f.route().fetch(new Request('http://127.0.0.1/api/ai-buddy/qq-connect',{method:'POST',body:JSON.stringify({action:'connect'})}));
 await entered.promise;await p.close();auth.resolve({contextToken:'host-issued'});const response=await request;
 assert.equal(response.status,503);assert.equal(f.dispatches(),0);
});
test('AUDIT APP authorizer can inspect its own request body without receiving an already consumed stream',async()=>{
 let authorizedBody;const f=nativeFixture(async request=>{authorizedBody=await request.json();return {contextToken:'host-issued'};}),p=await registerNativePlugin(f.ctx,{pluginId,label:'QQ',createService:()=>f.service});
 try{const response=await f.route().fetch(new Request('http://127.0.0.1/api/ai-buddy/qq-connect',{method:'POST',body:JSON.stringify({action:'status',payload:{}})}));assert.equal(response.status,200);assert.equal(authorizedBody.action,'status');assert.equal(f.dispatches(),1);}finally{await p.close();}
});
test('AUDIT async SQLite callback is rejected before it can start or continue outside rollback',async()=>{
 const root=process.env.AI_BUDDY_PLUGIN_TEST_ROOT??fileURLToPath(new URL('../test-data/',import.meta.url)),s=openStore({databasePath:join(mkdtempSync(join(root,'async-store-')),'private.sqlite'),pluginId:'@ai-buddy/audit'});let entered=false;
 try{assert.throws(()=>s.transaction(async()=>{entered=true;s.set('early',true);await Promise.resolve();s.set('late',true);}),{code:'ASYNC_SQLITE_TRANSACTION_REJECTED'});await Promise.resolve();assert.equal(entered,false);assert.equal(s.get('late'),null);}finally{s.close();}
});
test('AUDIT caught nested transaction failure rolls back its own writes while keeping the outer unit',()=>{
 const root=process.env.AI_BUDDY_PLUGIN_TEST_ROOT??fileURLToPath(new URL('../test-data/',import.meta.url)),s=openStore({databasePath:join(mkdtempSync(join(root,'nested-store-')),'private.sqlite'),pluginId:'@ai-buddy/audit'});
 try{s.transaction(()=>{s.set('outer',true);try{s.transaction(()=>{s.set('inner',true);throw Error('nested failure');});}catch{}s.set('outer-tail',true);});assert.equal(s.get('outer'),true);assert.equal(s.get('inner'),null);assert.equal(s.get('outer-tail'),true);}finally{s.close();}
});
