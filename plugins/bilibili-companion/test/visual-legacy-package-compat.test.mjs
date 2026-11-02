import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {unpack} from '../../../scripts/lib/tar-reader.mjs';
import {createBilibiliService} from '../src/service.mjs';

const oldPackage=process.env.AI_BUDDY_V21_OLD_BILI_PACKAGE;
const oldSha='5bca9e0364892b9e7ed670a713cbfe66af55cc07887ab8f00863daeea6c40361';
test('actual2.0.2 to2.1 to2.0.2 to2.1 preserves visual in-flight data without older automatic execution',{skip:!oldPackage},async t=>{
 const archive=readFileSync(oldPackage);assert.equal(createHash('sha256').update(archive).digest('hex'),oldSha,'Only the pinned actual2.0.2 package is admissible');
 const files=unpack(archive);assert.equal(JSON.parse(files.get('package.json').toString()).version,'2.0.2');assert.ok(files.get('lib/index.js'));
 const base=process.env.AI_BUDDY_PLUGIN_TEST_ROOT??tmpdir();mkdirSync(base,{recursive:true});const directory=mkdtempSync(join(base,'vision-compat-')),databasePath=join(directory,'data.sqlite'),modulePath=join(directory,'old202.mjs');writeFileSync(modulePath,files.get('lib/index.js'));
 const old=await import(pathToFileURL(modulePath).href);assert.equal(typeof old.createBilibiliService,'function');
 const state={models:0,selects:0,prepares:0,holdRead:false,readingId:null};let service,readStarted;
 const entered=new Promise(resolve=>readStarted=resolve),principal={contextToken:'app-owner'},catalog=[{ref:'bili',label:'Fixture account',platform:'bilibili'},{ref:'model',label:'Fixture model',platform:'model'}];
 const context={contextToken:'activity',accountId:'10001',characterId:'deepseek',personaId:'default',lifeId:'life-1',operationId:'op-1',generation:1};
 const segments=[{id:'segment-0',from:0,to:60},{id:'segment-1',from:60,to:180},{id:'segment-2',from:180,to:480},{id:'segment-3',from:480,to:600}];
 const dto=()=>({readingId:state.readingId,segments,remaining:16,zoomRemaining:2,phase:'reading',materialMissing:[]});
 const host={async invoke(method,payload,options={}){
  if(method==='social.context.read')return payload.purpose==='manage-plugin'?{contextToken:'manage',accountId:'10001',permissions:['plugin.manage'],managedConnections:catalog,availableCharacters:[{id:'deepseek',label:'Fixture character'}]}:{...context,characterId:payload.characterId??context.characterId};
  if(method==='activity.lease')return {leaseId:'lease:'+payload.activityId,generation:1};
  if(method==='activity.check')return {valid:true,characterId:payload.characterId,lifeId:payload.lifeId,operationId:payload.operationId,generation:payload.generation};
  if(method==='activity.finish'||method==='ui.bubble')return {ok:true};
  if(method==='experience.append')return {recorded:true,eventId:payload.eventId};
  if(method==='proactive.offer')return {accepted:true};
  if(method==='connections.request'){
   if(payload.operation==='video.storyboard.prepare'){state.prepares++;state.readingId=payload.parameters.readingId;return dto();}
   if(payload.operation==='video.storyboard.get')return dto();
   if(payload.operation==='video.storyboard.read'){
    if(state.holdRead){readStarted();await new Promise((resolve,reject)=>{const abort=()=>reject(Object.assign(Error('Fixture cancelled before model submission'),{code:'BILI_CANCELLED'}));options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();});}
    return {readingId:state.readingId,visualMaterialRefs:['vision:fixture-range'],cells:[{index:1,start:payload.parameters.from,end:payload.parameters.to,imageRef:'vision:fixture-range'}]};
   }
   throw Error('Unexpected fixture operation '+payload.operation);
  }
  if(method==='models.request'){state.models++;return {requestId:'fixture-provider-'+state.models,text:JSON.stringify({summary:'Fixture sampled material',notes:'Only fixture subtitles and sampled frames',evidenceRefs:[payload.material.items[0].id],completedMaterial:true,shareWorthy:false,commentWorthy:false,shareText:'',interestTags:[]})};}
  throw Error('Unexpected fixture host method '+method);
 }};
 const platform={async selectVideo(){state.selects++;return {videoId:'BV12345678',cid:123,duration:600,pageCount:1,title:'Compatibility fixture'};},async acquireMaterial(){return {videoId:'BV12345678',coverage:'subtitles',complete:true,items:[{id:'subtitle:1',text:'Original fixture subtitle',start:0,end:10}]};}};
 const options={databasePath,host,platform,timeZone:'UTC',now:()=>Date.parse('2026-10-30T12:00:00Z'),runtimeOwnerInspector:pid=>({pid,exe:'fixture',birth:'fixture'})};
 const call=(action,payload={})=>service.dispatch(action,payload,principal),reopen=async make=>{await service?.close();service=make(options);};
 t.after(async()=>{await service?.close();rmSync(directory,{recursive:true,force:true});});
 service=old.createBilibiliService(options);
 await call('settings.update',{connectionRef:'bili',modelConnectionRef:'model',autonomousEnabled:true,shareMode:'record-only',dailyWatchLimit:20,startMinute:0,endMinute:1440});
 const oldPlan=await call('schedule.create',{participants:['deepseek'],count:1,startMinute:800,endMinute:900});
 const oldActivity=await call('now',{characterId:'deepseek'});assert.equal(oldActivity.state,'completed');assert.equal(state.models,1);assert.equal(service.status().version,'2.0.2');

 await reopen(createBilibiliService);assert.equal(service.status().version,'2.1.0');await call('settings.update',{visualAutoApproved:true});
 const visualPlan=await call('schedule.create',{participants:['deepseek'],count:1,visualReading:true,startMinute:0,endMinute:1440});state.holdRead=true;
 const running=call('tick');running.catch(()=>{});await Promise.race([entered,running.then(result=>{throw Error('Visual reading finished before the cancellable frame phase: '+result.state);})]);
 const inFlight=(await call('history.list')).find(a=>a.visual===true);assert.ok(inFlight,'The new factory must expose the actual in-flight visual activity');assert.equal(inFlight.scheduleId,visualPlan.id);
 assert.equal((await call('reading.pause',{activityId:inFlight.id})).paused,true);assert.equal((await running).state,'paused');assert.equal(state.models,1,'Pausing before the first image-model submission must not create a call');state.holdRead=false;

 await reopen(old.createBilibiliService);const beforeOld={models:state.models,selects:state.selects,prepares:state.prepares};
 assert.deepEqual((await call('history.list')).map(a=>a.id),[oldActivity.id]);assert.deepEqual((await call('schedule.list')).map(s=>s.id),[oldPlan.id]);
 await call('settings.update',{dailyWatchLimit:21,shareMode:'record-only'});const anotherOldPlan=await call('schedule.create',{participants:['deepseek'],count:1,startMinute:1000,endMinute:1100});
 assert.equal((await call('tick')).reason,'no-eligible-schedule');assert.equal((await call('continue')).reason,'no-eligible-schedule');assert.deepEqual({models:state.models,selects:state.selects,prepares:state.prepares},beforeOld,'The actual old code must not automatically resume any new visual record');
 const writtenByOld=await call('now',{characterId:'deepseek'});assert.equal(writtenByOld.state,'completed');assert.equal(state.models,beforeOld.models+1,'The actual old service still reads and writes normal settings/tasks');

 await reopen(createBilibiliService);const currentSettings=(await call('settings.read')).settings;assert.equal(currentSettings.dailyWatchLimit,21);assert.equal(currentSettings.visualAutoApproved,true,'The older settings writer must not erase the independent new approval');
 const recoveredPlans=await call('schedule.list');assert.ok([oldPlan.id,anotherOldPlan.id,visualPlan.id].every(id=>recoveredPlans.some(s=>s.id===id)));const recovered=(await call('history.list')).find(a=>a.id===inFlight.id);assert.equal(recovered.state,'paused');assert.equal(recovered.visual,true);assert.equal(recovered.needsReview,false);
 const beforeResume=state.models,resumed=await call('reading.continue',{activityId:inFlight.id});assert.equal(resumed.id,inFlight.id);assert.equal(resumed.state,'completed');assert.equal(state.models-beforeResume,6,'The new service resumes the preserved segmented plan exactly once');
 assert.equal((await call('reading.get',{activityId:inFlight.id})).results.length,6);const finalHistory=await call('history.list');assert.ok([oldActivity.id,writtenByOld.id,inFlight.id].every(id=>finalHistory.some(a=>a.id===id)));assert.equal(new Set(finalHistory.map(a=>a.id)).size,finalHistory.length);
 const db=new DatabaseSync(databasePath,{readOnly:true});try{assert.deepEqual({...db.prepare('SELECT schema_version,minimum_writer FROM a_plugin_meta').get()},{schema_version:1,minimum_writer:'0.1.0-dev.2'});assert.ok(db.prepare("SELECT value FROM a_plugin_kv WHERE key=?").get('visual-activity-v21:'+inFlight.id));assert.ok(db.prepare("SELECT value FROM a_plugin_kv WHERE key=?").get('visual-plan-v21:'+visualPlan.id));}finally{db.close();}
});
