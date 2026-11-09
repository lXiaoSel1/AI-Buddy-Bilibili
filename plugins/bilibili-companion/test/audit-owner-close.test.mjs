import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createBilibiliService} from '../src/service.mjs';

function fixture(t){
 const parent=resolve(process.env.AI_BUDDY_PLUGIN_TEST_ROOT??join(tmpdir(),'buddy-social-audit'));mkdirSync(parent,{recursive:true});
 const root=mkdtempSync(join(parent,'bili-owner-')),databasePath=join(root,'plugin.sqlite'),bubbles=[],hooks={};
 const identity={pid:process.pid,birth:'current-birth',executable:process.execPath};
 const host={async invoke(method,payload){
  if(method==='ui.bubble'){bubbles.push(payload);if(payload.clear&&hooks.clear)return hooks.clear(payload);return {cleared:true};}
  if(method==='social.context.read')return payload.purpose==='manage-plugin'?{contextToken:'owner',accountId:'123',permissions:['plugin.manage'],managedConnections:[]}:{connectionRef:payload.modelConnectionRef??'model',contextToken:'context',accountId:'123',characterId:payload.characterId,personaId:'p',lifeId:'l',operationId:'o',generation:1,sleeping:false};
  if(method==='activity.lease')return {leaseId:'lease',generation:1};if(method==='activity.check')return {valid:true,generation:1,characterId:'whale',lifeId:'l',operationId:'o'};
  if(method==='models.request')return {requestId:'mock-only',text:JSON.stringify({summary:'Mock public material',evidenceRefs:['s1'],completedMaterial:true})};
  if(method==='experience.append')return {recorded:true,eventId:payload.eventId};if(method==='activity.finish')return {finished:true};
  assert.fail('Unexpected host method '+method);
 }};
 const platform={selectVideo:async()=>({videoId:'BVfixture123',aid:1,cid:2,title:'Fixture',url:'https://www.bilibili.com/video/BVfixture123'}),acquireMaterial:async()=>({videoId:'BVfixture123',coverage:'subtitles',complete:true,items:[{id:'s1',text:'Mock public material'}],sourceRefs:['fixture:public']})};
 const options={databasePath,host,platform,cleanupTimeoutMs:50,runtimeOwnerInspector:pid=>pid===process.pid?identity:null};let service=createBilibiliService(options);
 const mutate=fn=>{const db=new DatabaseSync(databasePath);try{return fn(db);}finally{db.close();}};
 t.after(async()=>{await service?.close();assert.ok(resolve(root).startsWith(parent+sep));rmSync(root,{recursive:true,force:true});});
 return {databasePath,bubbles,hooks,identity,options,mutate,get service(){return service;},async close(){const result=await service.close();service=null;return result;},open(){service=createBilibiliService(options);return service;}};
}

test('AUDIT Bili closing does not replay clear operations over all historical activities',async t=>{
 const f=fixture(t);f.mutate(db=>{const insert=db.prepare('INSERT INTO bili_activities VALUES(?,?,?,?,?,?)');db.exec('BEGIN');for(let n=0;n<1000;n++){const row={id:'history-'+n,accountId:'123',characterId:'whale',day:'2026-10-25',state:'completed',contextToken:'old-private-token'};insert.run(row.id,row.accountId,row.characterId,row.day,row.state,JSON.stringify(row));}db.exec('COMMIT');});
 await f.close();assert.equal(f.bubbles.length,0,'No historical activity from a prior session has a live bubble owned by this instance');
});

test('AUDIT Bili stale PID reused by another process identity is not a live owner',async t=>{
 const f=fixture(t);await f.close();f.mutate(db=>db.prepare("UPDATE a_plugin_kv SET value=? WHERE key='runtimeOwner'").run(JSON.stringify({...f.identity,birth:'prior-birth',instanceId:'crashed-instance'})));
 assert.doesNotThrow(()=>f.open(),'PID existence without matching birth must not lock the database forever');
});

test('AUDIT Bili a matching active process owner is not stolen',async t=>{
 const f=fixture(t);assert.throws(()=>createBilibiliService(f.options),{code:'BILI_DATA_BUSY'});
});

test('AUDIT Bili legacy live owner without birth proof stays conservative',async t=>{
 const f=fixture(t);await f.close();f.mutate(db=>db.prepare("UPDATE a_plugin_kv SET value=? WHERE key='runtimeOwner'").run(JSON.stringify({pid:process.pid,instanceId:'legacy'})));
 assert.throws(()=>f.open(),{code:'BILI_DATA_BUSY'});
});

test('AUDIT Bili active bubble cleanup has one bounded deadline and preserves its failure warning',async t=>{
 const f=fixture(t),owner={contextToken:'owner'};await f.service.dispatch('settings.update',{connectionRef:'bili',modelConnectionRef:'model',shareMode:'record-only'},owner);assert.equal((await f.service.dispatch('now',{characterId:'whale'},owner)).state,'completed');
 let release;f.hooks.clear=()=>new Promise(resolve=>{release=resolve;});t.mock.timers.enable({apis:['setTimeout']});
 const closing=f.close();await new Promise(setImmediate);t.mock.timers.tick(50);
 const result=await closing;assert.deepEqual(result.warnings,['BILI_BUBBLE_CLEANUP_PENDING']);assert.equal(f.bubbles.filter(row=>row.clear).length,1);release({cleared:true});
 // C11: every shown bubble carries its second line; a clearing bubble carries none.
 const shown=f.bubbles.filter(row=>!row.clear);assert.ok(shown.length>0);assert.ok(shown.every(row=>typeof row.detail==='string'&&row.detail.length>0&&!row.detail.includes('点一下打开')),JSON.stringify(shown.map(row=>row.detail)));assert.ok(f.bubbles.filter(row=>row.clear).every(row=>row.detail===undefined));
});
