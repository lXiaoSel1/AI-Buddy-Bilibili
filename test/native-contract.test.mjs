import test from 'node:test';
import assert from 'node:assert/strict';
import {registerNativePlugin} from '../shared/native.mjs';
import {CONTRACT,CONTRACT_HASH,REQUIRED_CAPABILITIES,createHostClient} from '../shared/contract.mjs';
const pluginId='@ai-buddy/qq-connect';
function ctx(bridge){const handlers=[],effects=[];return {handlers,effects,buddySocialServices:bridge?{openPlugin:async()=>bridge}:undefined,connection:{fetch:{register:spec=>{handlers.push(spec);return()=>handlers.splice(handlers.indexOf(spec),1);}}},effect:fn=>effects.push(fn())};}
const description=()=>({pluginId,mode:'runtime',contractHash:CONTRACT_HASH,contractAcknowledgement:{owner:'B',hash:CONTRACT_HASH},capabilities:REQUIRED_CAPABILITIES[pluginId]});
test('MOCK native install without B stays inert and exposes no private state',async()=>{
 let created=0;const c=ctx(),p=await registerNativePlugin(c,{pluginId,label:'QQ连接',createService:()=>{created++;}});
 assert.equal(created,0);assert.equal(p.readiness().mode,'unavailable');
 const read=await c.handlers[0].fetch(new Request('http://127.0.0.1/api/ai-buddy/qq-connect?action=readiness'));assert.equal(read.status,200);
 const privateRead=await c.handlers[0].fetch(new Request('http://127.0.0.1/api/ai-buddy/qq-connect?action=history'));assert.equal(privateRead.status,403);
 const write=await c.handlers[0].fetch(new Request('http://127.0.0.1/api/ai-buddy/qq-connect',{method:'POST',body:JSON.stringify({action:'settings',principal:{ownerVerified:true}})}));assert.equal(write.status,403);
 await p.close();assert.equal(c.handlers.length,0);
});
test('MOCK failed B handshake drains its bridge immediately',async()=>{
 let closed=0;const c=ctx({describe:async()=>({...description(),contractHash:'wrong'}),invoke:async()=>{},close:async()=>closed++});
 const p=await registerNativePlugin(c,{pluginId,label:'QQ连接',createService:()=>{throw Error('unreachable');}});assert.equal(closed,1);assert.equal(p.readiness().contractConfirmed,false);await p.close();assert.equal(closed,1);
});
test('MOCK native dispatch drops body principal and requires B authorization',async()=>{
 let seen,closed=0;const bridge={describe:async()=>description(),invoke:async()=>{},dataDirectory:'C:/a-private-mock',authorizeRequest:async()=>({contextToken:'host-issued'}),subscribeEvents:async()=>()=>{},close:async()=>closed++};
 const c=ctx(bridge),p=await registerNativePlugin(c,{pluginId,label:'QQ连接',createService:()=>({dispatch:async(action,payload,principal)=>{seen={action,payload,principal};return {ok:true};},onHostEvent:async()=>{},close:async()=>{}})});
 const response=await c.handlers[0].fetch(new Request('http://127.0.0.1/api/ai-buddy/qq-connect',{method:'POST',body:JSON.stringify({action:'settings',payload:{principal:{ownerVerified:true},contextToken:'forged',databasePath:'C:/production',operator:'new'},principal:{contextToken:'forged'}})}));
 assert.equal(response.status,200);assert.deepEqual(seen.principal,{contextToken:'host-issued'});assert.deepEqual(seen.payload,{operator:'new'});await p.close();assert.equal(closed,1);
});
test('MOCK SDK rejects missing B ACK, absent capability and malformed context',async()=>{
 const raw={describe:async()=>({...description(),contractAcknowledgement:null}),invoke:async()=>({})};await assert.rejects(createHostClient(raw,{pluginId}),{code:'B_CONTRACT_ACK_REQUIRED'});
 raw.describe=async()=>description();const h=await createHostClient(raw,{pluginId});await assert.rejects(h.invoke('owner.work.approve',{}),{code:'SOCIAL_CAPABILITY_UNAVAILABLE'});await assert.rejects(h.invoke('social.context.read',{}),{code:'TRUSTED_CONTEXT_REQUIRED'});
 assert.throws(()=>CONTRACT.methods.push('work.host'),TypeError);
});
test('MOCK late abort preserves actual external receipt but cancels stale model results',async()=>{
 const controller=new AbortController();
 const raw={describe:async()=>description(),invoke:async()=>{controller.abort();return {status:'sent',messageId:'actual-accepted'};}};
 const host=await createHostClient(raw,{pluginId});
 assert.deepEqual(await host.invoke('connections.request',{}, {signal:controller.signal}),{status:'sent',messageId:'actual-accepted'});
 const modelController=new AbortController();raw.invoke=async()=>{modelController.abort();return {text:'late old-life result'};};
 await assert.rejects(host.invoke('models.request',{}, {signal:modelController.signal}),{name:'AbortError'});
});
test('MOCK failing event disposer does not skip service, bridge or route cleanup',async()=>{
 let serviceClosed=0,bridgeClosed=0;
 const bridge={describe:async()=>description(),invoke:async()=>{},dataDirectory:'C:/a-private-mock',authorizeRequest:async()=>({contextToken:'host-issued'}),subscribeEvents:async()=>()=>{throw Error('fixture-disposer');},close:async()=>bridgeClosed++};
 const c=ctx(bridge),p=await registerNativePlugin(c,{pluginId,label:'QQ连接',createService:()=>({dispatch:async()=>({}),onHostEvent:async()=>{},close:async()=>serviceClosed++})});
 await assert.rejects(p.close(),{code:'PLUGIN_DRAIN_FAILED'});assert.equal(serviceClosed,1);assert.equal(bridgeClosed,1);assert.equal(c.handlers.length,0);
});
test('MOCK model bridge requires a real request identity and core-ledger routing marker',async()=>{
 const raw={describe:async()=>description(),invoke:async()=>({text:'unaccounted',requestId:'r-1'})};
 const host=await createHostClient(raw,{pluginId});await assert.rejects(host.invoke('models.request',{}),{code:'CORE_MODEL_ACCOUNTING_REQUIRED'});
 raw.invoke=async()=>({text:'accounted',requestId:'r-1',usageAccounting:'core-model-router'});
 assert.equal((await host.invoke('models.request',{})).text,'accounted');
});
