import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerNativePlugin} from '../shared/native.mjs';
import {createAccountServices} from '../shared/account-services.mjs';
import {CONTRACT_HASH,REQUIRED_CAPABILITIES} from '../shared/contract.mjs';
import {createBilibiliService,BILI_UNCONNECTED} from '../plugins/bilibili-companion/src/service.mjs';

// The real host (social-plugin-broker readContext) answers a management read with accountId '' when the plugin has
// no enabled account, plus the character catalog and the managed connections. 2.0.1 refused every page request in
// that state, so QQ showed "操作未完成，请查看插件状态。 / 设置没读到" instead of setup step 1.
const CATALOG=[{id:'hunyuan',label:'混元'},{id:'deepseek',label:'DeepSeek'}];
const noAccountContext=()=>({contextToken:'mgmt-'+Math.random(),accountId:'',sourceMode:'host-managed-transport',onboardingAvailable:true,permissions:['plugin.manage'],availableCharacters:CATALOG,managedConnections:[{ref:'model-a',label:'Model A',platform:'model',provider:'deepseek'}]});
async function page(t,pluginId,createService,unconnected){
 const dataDirectory=await mkdtemp(join(tmpdir(),'social-no-account-'));let created=0;const calls=[];
 const bridge={dataDirectory,timeZone:'America/New_York',
  describe:async()=>({pluginId,mode:'runtime',contractHash:CONTRACT_HASH,contractAcknowledgement:{owner:'B',hash:CONTRACT_HASH},capabilities:REQUIRED_CAPABILITIES[pluginId],features:['social-login-v1']}),
  invoke:async(method,payload)=>{calls.push({method,payload});if(method==='social.context.read'&&payload.purpose==='manage-plugin')return noAccountContext();throw Object.assign(Error('unexpected '+method),{code:'UNEXPECTED'});},
  authorizeRequest:async()=>({contextToken:'host-issued'}),subscribeEvents:async()=>()=>{},close:async()=>{}};
 const handlers=[],ctx={buddySocialServices:{openPlugin:async()=>bridge},connection:{fetch:{register:spec=>{handlers.push(spec);return()=>{};}}}};
 const plugin=await registerNativePlugin(ctx,{pluginId,label:'x',createService:options=>{created++;return createService(options);},unconnected});
 t.after(async()=>{await plugin.close();await rm(dataDirectory,{recursive:true,force:true});});
 const post=async(action,payload={})=>{const response=await handlers[0].fetch(new Request('http://127.0.0.1'+plugin.route,{method:'POST',body:JSON.stringify({action,payload})}));return {status:response.status,body:await response.json()};};
 return {post,calls,created:()=>created,readiness:plugin.readiness};
}

test('Bilibili with no account: settings, lists and quota read through with defaults; actions are refused',async t=>{
 const bili=await page(t,'@ai-buddy/bilibili-companion',createBilibiliService,BILI_UNCONNECTED);
 const read=await bili.post('settings.read');
 assert.equal(read.status,200);assert.equal(read.body.accountRequired,true);assert.equal(read.body.storedAccountData,false);assert.equal(read.body.settings.connectionRef,null);assert.equal(read.body.settings.autonomousEnabled,false);
 assert.deepEqual(read.body.characters,[{id:'hunyuan',name:'混元'},{id:'deepseek',name:'DeepSeek'}]);assert.deepEqual(read.body.connections,[{id:'model-a',name:'Model A',kind:'model'}]);
 for(const action of ['history.list','schedule.list','comments.list','reading.pending.list'])assert.deepEqual((await bili.post(action)).body,[],action);
 const quota=await bili.post('quota.read');assert.match(quota.body.day,/^\d{4}-\d{2}-\d{2}$/);assert.deepEqual(quota.body.rows,[]);
 for(const action of ['now','settings.update','schedule.create','schedule.start','today.allow']){
  const refused=await bili.post(action,{characterId:'hunyuan',allowed:false});
  assert.equal(refused.status,403,action);assert.equal(refused.body.error.code,'SOCIAL_ACCOUNT_REQUIRED',action);
 }
 assert.equal(bili.created(),0);
});

test('account services without an unconnected view keep refusing, and a stored account is reported',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'social-no-account-mux-'));let account='',created=0;
 const host={invoke:async()=>({contextToken:'m',accountId:account,permissions:['plugin.manage']})};
 const view={actions:['status'],read:(action,payload,context,options)=>({view:action,stored:options.storedAccountData,extra:options.extra})};
 const createService=async()=>{created++;return {dispatch:async action=>({real:action}),onHostEvent:async()=>({}),close:async()=>{}};};
 const bare=createAccountServices({directory,pluginId:'@ai-buddy/qq-connect',host,createService});
 const muxed=createAccountServices({directory,pluginId:'@ai-buddy/qq-connect',host,createService,unconnected:view,options:{extra:'opt'}});
 t.after(async()=>{await bare.close();await muxed.close();await rm(directory,{recursive:true,force:true});});
 await assert.rejects(bare.dispatch('status',{},{}),{code:'SOCIAL_ACCOUNT_REQUIRED'});
 assert.deepEqual(await muxed.dispatch('status',{},{}),{view:'status',stored:false,extra:'opt'});
 await assert.rejects(muxed.dispatch('connect',{},{}),{code:'SOCIAL_ACCOUNT_REQUIRED'});assert.equal(created,0);
 account='12345';assert.deepEqual(await muxed.dispatch('status',{},{}),{real:'status'},'an account switches to its own service');assert.equal(created,1);
 account='';assert.deepEqual(await muxed.dispatch('status',{},{}),{view:'status',stored:true,extra:'opt'},'the earlier account’s data is reported as kept');
});
