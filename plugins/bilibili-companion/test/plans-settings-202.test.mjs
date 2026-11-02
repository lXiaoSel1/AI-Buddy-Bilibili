import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createBilibiliService} from '../src/service.mjs';

const dataRoot=process.env.AI_BUDDY_PLUGIN_TEST_ROOT??fileURLToPath(new URL('../../../test-data/',import.meta.url));
mkdirSync(dataRoot,{recursive:true});
const owner={contextToken:'owner-token'};
// Same host shape as service.test.mjs (manage/background reads, activity contexts, leases that end once).
function fixture(options={}){
  const directory=mkdtempSync(join(dataRoot,'bili202-')),databasePath=join(directory,'plugin.sqlite');
  const state={at:Date.parse('2026-10-25T17:00:00Z'),selects:0,models:0,offers:[],leases:new Map(),shareWorthy:false,...options};
  const catalog=[{ref:'managed-bilibili',label:'测试B站连接',platform:'bilibili'},{ref:'managed-model',label:'测试活动模型',platform:'model'}];
  const host={async invoke(method,payload){
    if(method==='social.context.read'){
      if(payload.purpose==='plugin-background')return {accountId:'account-1',managedConnections:catalog,permissions:['plugin.activity']};
      if(payload.purpose==='manage-plugin')return {accountId:'account-1',permissions:['plugin.manage'],availableCharacters:[{id:'alpha',label:'甲角色'},{id:'beta',label:'乙角色'}],managedConnections:catalog};
      return {contextToken:`context:${payload.characterId}`,accountId:'account-1',characterId:payload.characterId,personaId:'persona-1',lifeId:'life-1',operationId:'operation-1',generation:1,sleeping:false};
    }
    if(method==='activity.lease'){if(state.leases.get(payload.activityId)==='ended')throw Object.assign(Error('ended'),{code:'BUDDY_SOCIAL_DENIED'});state.leases.set(payload.activityId,'active');return {leaseId:`lease:${payload.activityId}`,generation:1};}
    if(method==='activity.check')return {valid:true,characterId:payload.characterId,lifeId:payload.lifeId,operationId:payload.operationId,generation:payload.generation};
    if(method==='activity.finish'){if(!['completed','failed','cancelled','unknown'].includes(payload.status))throw Object.assign(Error('bad'),{code:'BUDDY_SOCIAL_DENIED'});state.leases.set(payload.activityId,'ended');return {ok:true};}
    if(method==='ui.bubble')return {ok:true};
    if(method==='models.request'){state.models++;if(state.modelHook)return state.modelHook();return {requestId:`model-${state.models}`,text:JSON.stringify({summary:'海洋',notes:'字幕',evidenceRefs:['subtitle:1'],completedMaterial:true,shareWorthy:state.shareWorthy,commentWorthy:false,shareText:'刚看了海洋介绍。',interestTags:[]})};}
    if(method==='experience.append')return {recorded:true,eventId:payload.eventId};
    if(method==='proactive.offer'){state.offers.push(payload);return {accepted:true};}
    throw Object.assign(Error(`unsupported ${method}`),{code:'BUDDY_METHOD_UNKNOWN'});
  }};
  const platform={async selectVideo(){state.selects++;return {videoId:'BVtest123',title:'海洋介绍',author:'fixture',url:'https://www.bilibili.com/video/BVtest123'};},async acquireMaterial(input){if(state.materialHook)return state.materialHook(input);return {videoId:'BVtest123',coverage:'subtitles',complete:true,items:[{id:'subtitle:1',text:'海洋覆盖了地球大部分表面。'}],sourceRefs:['fixture:subtitle']};},async sendComment(){return {status:'sent',platformId:'1'};}};
  let service=createBilibiliService({databasePath,host,platform,now:()=>state.at,timeZone:'America/New_York'});
  const call=(action,payload={})=>service.dispatch(action,payload,owner);
  return {state,databasePath,call,get service(){return service;},
    configure:(settings={})=>call('settings.update',{connectionRef:'managed-bilibili',modelConnectionRef:'managed-model',...settings}),
    async reopen(){await service.close();service=createBilibiliService({databasePath,host,platform,now:()=>state.at,timeZone:'America/New_York'});},close:()=>service.close()};
}
const kv=(path,key)=>{const db=new DatabaseSync(path,{readOnly:true});try{const row=db.prepare('SELECT value FROM a_plugin_kv WHERE key=?').get(key);return row?JSON.parse(row.value):null;}finally{db.close();}};
const V201_KEYS=['autonomousEnabled','maxConcurrent','dailyWatchLimit','dailyCommentLimit','commentMode','commentConsent','commentReview','shareMode','resumeMode','connectionRef','modelConnectionRef','startMinute','endMinute'];

test('E4: “after chat” sharing and a default character are saved; the 2.0.1 settings row stays readable by 2.0.1',async()=>{
  const f=fixture();try{
    assert.equal((await f.call('settings.read')).settings.defaultCharacterId,null,'2.0.1 data loads with no default character');
    const saved=await f.configure({shareMode:'after-chat',defaultCharacterId:'beta'});
    assert.equal(saved.shareMode,'after-chat');assert.equal(saved.defaultCharacterId,'beta');
    const read=(await f.call('settings.read')).settings;assert.equal(read.shareMode,'after-chat');assert.equal(read.defaultCharacterId,'beta');
    const base=kv(f.databasePath,'settings');
    assert.ok(Object.keys(base).every(key=>V201_KEYS.includes(key)),'only 2.0.1 keys in the 2.0.1 row: '+Object.keys(base));
    assert.ok(['selected','record-only'].includes(base.shareMode),'a 2.0.1 enum value');
    await assert.rejects(f.configure({shareMode:'loud'}),{code:'BILI_SETTINGS_INVALID'});
    await assert.rejects(f.configure({defaultCharacterId:''}),{code:'BILI_SETTINGS_INVALID'});
    await f.configure({shareMode:'record-only',defaultCharacterId:null});
    const again=(await f.call('settings.read')).settings;assert.equal(again.shareMode,'record-only');assert.equal(again.defaultCharacterId,null);
  }finally{await f.close();}
});

test('E4: “after chat” offers every finished viewing; “her pick” still offers only what she found worth telling',async()=>{
  const pick=fixture();try{await pick.configure({shareMode:'selected'});assert.equal((await pick.call('now',{characterId:'alpha'})).state,'completed');assert.equal(pick.state.offers.filter(o=>o.kind==='bilibili-share').length,0);}finally{await pick.close();}
  const after=fixture();try{await after.configure({shareMode:'after-chat'});assert.equal((await after.call('now',{characterId:'alpha'})).state,'completed');const shares=after.state.offers.filter(o=>o.kind==='bilibili-share');assert.equal(shares.length,1);assert.equal(shares[0].text,'刚看了海洋介绍。');}finally{await after.close();}
});

test('E4: “wait for me” keeps an interrupted viewing paused until Continue',async()=>{
  const f=fixture();let started=false;try{
    await f.configure({autonomousEnabled:true,resumeMode:'manual'});await f.call('schedule.create',{participants:['alpha'],count:1});
    // Loading the material waits until the automatic viewing is interrupted (watching on schedule switched off).
    f.state.materialHook=({signal})=>new Promise((resolve,reject)=>{started=true;signal.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{code:'BILI_CANCELLED'})),{once:true});});
    const first=f.call('tick');while(!started)await new Promise(r=>setTimeout(r,5));
    await f.configure({autonomousEnabled:false});assert.equal((await first).state,'paused');
    f.state.materialHook=null;
    const history=await f.call('history.list');assert.equal(history[0].pauseReason,'autonomous-disabled');
    await f.configure({autonomousEnabled:true});
    assert.equal((await f.call('tick')).reason,'manual-resume-required','“wait for me”: no automatic resume');
    assert.equal((await f.call('history.list'))[0].state,'paused');
    await f.configure({resumeMode:'idle'});
    assert.equal((await f.call('tick')).state,'completed','“resume when idle” continues it as before');
  }finally{await f.close();}
});

test('E2: “watch now” on a plan row starts that plan inside its window and counts toward it',async()=>{
  const f=fixture();try{
    await f.configure();
    const plan=await f.call('schedule.create',{participants:['beta'],count:2});
    const result=await f.call('schedule.start',{scheduleId:plan.id});
    assert.equal(result.state,'completed');assert.equal(result.characterId,'beta');assert.equal(result.scheduleId,plan.id);
    const after=(await f.call('schedule.list')).find(s=>s.id===plan.id);assert.equal(after.remaining,1);assert.equal(after.state,'scheduled');
    const evening=await f.call('schedule.create',{participants:['alpha'],count:1,startMinute:1200,endMinute:1320});
    await assert.rejects(f.call('schedule.start',{scheduleId:evening.id}),{code:'BILI_OUTSIDE_WINDOW'});
    assert.equal((await f.call('schedule.list')).find(s=>s.id===evening.id).state,'scheduled','an early press changes nothing');
    await assert.rejects(f.call('schedule.start',{scheduleId:'nope'}),{code:'BILI_NOT_FOUND'});
    await f.call('stop');
    await assert.rejects(f.call('schedule.start',{scheduleId:plan.id}),{code:'BILI_SCHEDULE_NOT_STARTABLE'},'stop cancelled the plans');
  }finally{await f.close();}
});

test('E2: a plan can be cancelled from its row; a paused viewing of it ends with it, a running one must be stopped first',async()=>{
  const f=fixture();let release;try{
    await f.configure({autonomousEnabled:true});
    const quiet=await f.call('schedule.create',{participants:['alpha'],count:1,startMinute:1200,endMinute:1320});
    assert.equal((await f.call('schedule.cancel',{scheduleId:quiet.id})).state,'cancelled');
    const plan=await f.call('schedule.create',{participants:['alpha'],count:1});
    f.state.modelHook=()=>new Promise(resolve=>{release=resolve;});
    const running=f.call('schedule.start',{scheduleId:plan.id});while(!release)await new Promise(r=>setTimeout(r,5));
    await assert.rejects(f.call('schedule.cancel',{scheduleId:plan.id}),{code:'BILI_SCHEDULE_RUNNING'});
    await f.call('pause');release({requestId:'r',text:JSON.stringify({summary:'s',notes:'n',evidenceRefs:['subtitle:1'],completedMaterial:true})});await running.catch(()=>{});
    const paused=(await f.call('history.list'))[0];assert.equal(paused.state,'paused');
    assert.equal((await f.call('schedule.cancel',{scheduleId:plan.id})).state,'cancelled');
    const ended=(await f.call('history.list'))[0];assert.equal(ended.state,'cancelled');assert.equal(ended.lastFailureCode,'BILI_SCHEDULE_CANCELLED');
    assert.equal((await f.call('continue')).reason,'no-eligible-schedule','nothing left to continue');
  }finally{release?.();await f.close();}
});
