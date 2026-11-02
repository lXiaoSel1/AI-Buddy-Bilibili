import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {DatabaseSync} from 'node:sqlite';
import {unpack} from '../../../scripts/lib/tar-reader.mjs';
import {mountPage,ok} from '../../../test/page-harness.mjs';
import {createBilibiliService} from '../src/service.mjs';

const owner={contextToken:'owner-token'},day='2026-10-25',videoId='BV1xx411c7mD';
function fixture(t){
 const base=process.env.AI_BUDDY_PLUGIN_TEST_ROOT??tmpdir();mkdirSync(base,{recursive:true});const directory=mkdtempSync(join(base,'bili-target-')),databasePath=join(directory,'private.sqlite');
 const state={at:Date.parse('2026-10-25T17:00:00Z'),accountId:'account-1',life:'life',sleeping:false,selects:[],models:0,manageGate:null};
 const catalog=[{ref:'bili',label:'Fixture Bilibili',platform:'bilibili'},{ref:'model',label:'Fixture model',platform:'model'}];
 const host={async invoke(method,payload){
  if(method==='social.context.read'){
   if(payload.purpose==='manage-plugin'){const gate=state.manageGate;state.manageGate=null;if(gate)await gate;return {accountId:state.accountId,permissions:['plugin.manage'],availableCharacters:[{id:'alpha',label:'Alpha'},{id:'beta',label:'Beta'}],managedConnections:catalog};}
   return {contextToken:'context',accountId:state.accountId,characterId:payload.characterId,personaId:'persona',lifeId:state.life,operationId:'operation',generation:1,sleeping:state.sleeping,interests:['海洋']};
  }
  if(method==='activity.lease')return {leaseId:'lease:'+payload.activityId,generation:1};
  if(method==='activity.check')return {valid:true,characterId:payload.characterId,lifeId:payload.lifeId,operationId:payload.operationId,generation:payload.generation};
  if(method==='activity.finish'||method==='ui.bubble')return {ok:true};
  if(method==='models.request'){state.models++;return {requestId:'fixture:'+state.models,text:JSON.stringify({summary:'Fixture notes',notes:'One line',evidenceRefs:['subtitle:1'],completedMaterial:true,interestTags:[]})};}
  if(method==='experience.append')return {recorded:true,eventId:payload.eventId};
  if(method==='proactive.offer')return {accepted:true};
  throw Error('Unexpected host call '+method);
 }};
 const platform={async selectVideo(input){state.selects.push({videoId:input.videoId??null,characterId:input.context.characterId});return {videoId:input.videoId??'BVfixture123',title:'Fixture',url:'https://www.bilibili.com/video/'+(input.videoId??'BVfixture123')};},async acquireMaterial(input){if(state.materialHook)return state.materialHook(input);return {videoId:input.video.videoId,coverage:'subtitles',complete:true,items:[{id:'subtitle:1',text:'Fixture subtitle'}]};},async sendComment(){throw Error('No comments in this fixture');}};
 const options={databasePath,host,platform,now:()=>state.at,timeZone:'America/New_York'};let service=createBilibiliService(options);
 const f={state,directory,databasePath,options,get service(){return service;},call:(action,payload={})=>service.dispatch(action,payload,owner),async reopen(make=createBilibiliService){await service.close();service=make(options);},close:()=>service.close()};
 t.after(()=>f.close());return f;
}
const configure=f=>f.call('settings.update',{connectionRef:'bili',modelConnectionRef:'model',autonomousEnabled:true,startMinute:0,endMinute:1440,dailyWatchLimit:20});
const create=(f,extra={})=>f.call('schedule.create',{participants:['alpha','beta'],count:2,day,startMinute:0,endMinute:1440,...extra});
const rows=(file,sql)=>{const db=new DatabaseSync(file,{readOnly:true});try{return db.prepare(sql).all().map(row=>({...row}));}finally{db.close();}};

test('G6-11: interest plans keep the legacy table while specific videos persist canonical IDs in their own namespace and execute that target',async t=>{
 const f=fixture(t);await configure(f);const interest=await create(f),target=await create(f,{watchMode:'video',videoId:'https://www.bilibili.com/video/'+videoId+'/?share_source=fixture'});
 assert.equal(target.watchMode,'video');assert.equal(target.videoId,videoId);assert.equal(target.requiresConfirmation,false);
 assert.equal(rows(f.databasePath,'SELECT id FROM bili_schedules').length,1);assert.equal(rows(f.databasePath,"SELECT key FROM a_plugin_kv WHERE key LIKE 'video-plan:%'").length,1);
 const result=await f.call('schedule.start',{scheduleId:target.id});assert.equal(result.state,'completed');assert.equal(result.requestedVideoId,videoId);assert.deepEqual(f.state.selects,[{videoId,characterId:'alpha'}]);
 assert.equal((await f.call('schedule.list')).find(s=>s.id===interest.id).remaining,2);
 const again=await f.call('tick');assert.equal(again.scheduleId,interest.id);assert.equal(f.state.selects[1].videoId,null,'old plans keep the interest selector');
});

test('specific-video plans hold after every restart; confirming alone has no viewing, model or autonomous-setting side effects',async t=>{
 const f=fixture(t);await configure(f);const target=await create(f,{watchMode:'video',videoId});await f.reopen();
 const held=(await f.call('schedule.list'))[0];assert.equal(held.state,'paused');assert.equal(held.requiresConfirmation,true);
 assert.equal((await f.call('tick')).reason,'target-confirmation-required');assert.equal(f.state.selects.length,0);assert.equal(f.state.models,0);
 await assert.rejects(f.call('schedule.start',{scheduleId:target.id}),{code:'BILI_SCHEDULE_CONFIRM_REQUIRED'});
 await f.call('settings.update',{autonomousEnabled:false});
 const confirmed=await f.call('schedule.start',{scheduleId:target.id,confirm:true,confirmOnly:true});assert.equal(confirmed.requiresConfirmation,false);
 assert.equal(f.state.selects.length,0);assert.equal(f.state.models,0);assert.equal((await f.call('settings.read')).settings.autonomousEnabled,false);
 await f.call('schedule.start',{scheduleId:target.id});assert.equal(f.state.selects.length,1);
 await f.reopen();assert.equal((await f.call('schedule.list'))[0].requiresConfirmation,true);assert.equal((await f.call('continue')).reason,'target-confirmation-required');
});

test('specific-video cancel is durable and neither duplicate nor delayed confirmation revives it',async t=>{
 const f=fixture(t);await configure(f);const target=await create(f,{watchMode:'video',videoId});await f.reopen();
 let release;f.state.manageGate=new Promise(r=>{release=r;});const late=f.call('schedule.start',{scheduleId:target.id,confirm:true,confirmOnly:true});
 await new Promise(r=>setImmediate(r));await f.call('schedule.cancel',{scheduleId:target.id});release();
 await assert.rejects(late,{code:'BILI_SCHEDULE_NOT_STARTABLE'});assert.equal((await f.call('schedule.cancel',{scheduleId:target.id})).state,'cancelled');
 await f.reopen();const list=await f.call('schedule.list');assert.equal(list[0].state,'cancelled');assert.equal(list[0].requiresConfirmation,false);await f.call('tick');assert.equal(f.state.models,0);
});

test('specific-video inputs reject foreign URLs, credentials, invalid IDs and conflicting interest targets before writing',async t=>{
 const f=fixture(t);await configure(f);
 for(const input of ['','https://localhost/video/'+videoId,'https://www.bilibili.com.evil.test/video/'+videoId,'https://user:secret@www.bilibili.com/video/'+videoId,'file:///private/BV1xx411c7mD','javascript:alert(1)','av123'])await assert.rejects(create(f,{watchMode:'video',videoId:input}),{code:'BILI_SCHEDULE_INVALID'});
 await assert.rejects(create(f,{watchMode:'interest',videoId}),{code:'BILI_SCHEDULE_INVALID'});
 assert.deepEqual(await f.call('schedule.list'),[]);
 assert.deepEqual(rows(f.databasePath,'SELECT schema_version,minimum_writer FROM a_plugin_meta'),[{schema_version:1,minimum_writer:'0.1.0-dev.2'}]);
});

test('specific-video plans still obey account, sleep, window and stop boundaries',async t=>{
 const f=fixture(t);await configure(f);const target=await create(f,{watchMode:'video',videoId});f.state.sleeping=true;
 assert.equal((await f.call('schedule.start',{scheduleId:target.id})).state,'waiting-sleep');assert.equal(f.state.selects.length,0);
 f.state.sleeping=false;await f.call('stop');await assert.rejects(f.call('schedule.start',{scheduleId:target.id,confirm:true}),{code:'BILI_SCHEDULE_NOT_STARTABLE'});assert.equal(f.state.models,0);
 const future=await create(f,{watchMode:'video',videoId,startMinute:1200,endMinute:1320});await assert.rejects(f.call('schedule.start',{scheduleId:future.id}),{code:'BILI_OUTSIDE_WINDOW'});
 f.state.accountId='different';await assert.rejects(f.call('schedule.list'),{code:'BILI_ACCOUNT_CHANGED'});
});

test('target activity concurrency, account quota and completion settlement stay shared and do not double-count',async t=>{
 const f=fixture(t);await configure(f);await f.call('settings.update',{maxConcurrent:1});const first=await create(f,{watchMode:'video',videoId}),second=await create(f,{watchMode:'video',videoId:'BV1yy411c7mE'});let entered,release;
 const ready=new Promise(r=>{entered=r;});f.state.materialHook=input=>new Promise(r=>{entered();release=()=>r({videoId:input.video.videoId,coverage:'subtitles',complete:true,items:[{id:'subtitle:1',text:'Fixture subtitle'}]});});
 const running=f.call('schedule.start',{scheduleId:first.id});await ready;await assert.rejects(f.call('schedule.start',{scheduleId:second.id}),{code:'BILI_CONCURRENCY_LIMIT'});release();assert.equal((await running).state,'completed');f.state.materialHook=null;
 const completed=(await f.call('schedule.list')).find(s=>s.id===first.id);assert.equal(completed.remaining,1);assert.equal(f.state.models,1);
 const usage=await f.call('quota.read');assert.deepEqual(usage.rows.map(r=>({...r})),[{kind:'watch',status:'committed',count:1}]);assert.equal((await f.call('history.list')).filter(a=>a.scheduleId===first.id).length,1);
 await f.call('outbox.flush');assert.equal((await f.call('schedule.list')).find(s=>s.id===first.id).remaining,1);assert.equal(f.state.models,1);
});

test('a paused target from a different life is retired after confirmation and never reaches the model',async t=>{
 const f=fixture(t);await configure(f);const target=await create(f,{watchMode:'video',videoId});let entered;const ready=new Promise(r=>{entered=r;});
 f.state.materialHook=({signal})=>new Promise((resolve,reject)=>{entered();signal.addEventListener('abort',()=>reject(Object.assign(Error('fixture cancelled'),{code:'BILI_CANCELLED'})),{once:true});});
 const running=f.call('tick');await ready;await f.call('pause');await running;f.state.materialHook=null;await f.reopen();f.state.life='another-life';
 await f.call('schedule.start',{scheduleId:target.id,confirm:true,confirmOnly:true});await f.call('continue');
 assert.equal((await f.call('schedule.list'))[0].state,'cancelled');assert.equal(f.state.models,0);assert.equal((await f.call('history.list'))[0].lastFailureCode,'BILI_LIFE_CHANGED');
});

test('combined history stays bounded to 200, with each real activity appearing once',async t=>{
 const f=fixture(t);await configure(f);const db=new DatabaseSync(f.databasePath);try{const add=db.prepare('INSERT INTO a_plugin_kv(key,value) VALUES(?,?)');for(let i=0;i<230;i++)add.run('video-activity:fixture-'+i,JSON.stringify({id:'fixture-'+i,accountId:'account-1',videoPlan:true,state:'completed',startedAt:i,characterId:'alpha',day}));}finally{db.close();}
 const history=await f.call('history.list');assert.equal(history.length,200);assert.equal(new Set(history.map(a=>a.id)).size,200);assert.equal(history[0].id,'fixture-229');
});

const oldPackage=process.env.AI_BUDDY_R11_OLD_BILI_PACKAGE;
test('actual 2.0.1 cannot resume an interrupted specific-video activity through Continue or automatic ticks',{skip:!oldPackage},async t=>{
 const f=fixture(t),files=unpack(readFileSync(oldPackage)),modulePath=join(f.directory,'old201.mjs');writeFileSync(modulePath,files.get('lib/index.js'));const old=await import(pathToFileURL(modulePath).href);
 await configure(f);const target=await create(f,{watchMode:'video',videoId});let started;
 const entered=new Promise(r=>{started=r;});f.state.materialHook=({signal})=>new Promise((resolve,reject)=>{started();signal.addEventListener('abort',()=>reject(Object.assign(Error('fixture cancelled'),{code:'BILI_CANCELLED'})),{once:true});});
 const run=f.call('tick');await entered;await f.call('pause');assert.equal((await run).state,'paused');f.state.materialHook=null;
 assert.equal((await f.call('history.list'))[0].scheduleId,target.id);assert.equal(rows(f.databasePath,'SELECT id FROM bili_activities').length,0,'old readers must not see a resumable target activity');
 await f.reopen(old.createBilibiliService);assert.deepEqual(await f.call('history.list'),[]);assert.equal((await f.call('continue')).reason,'no-eligible-schedule');assert.equal((await f.call('tick')).reason,'no-eligible-schedule');assert.equal(f.state.models,0);
 await f.reopen();assert.equal((await f.call('continue')).reason,'target-confirmation-required');await f.call('schedule.start',{scheduleId:target.id,confirm:true,confirmOnly:true});assert.equal((await f.call('continue')).state,'completed');assert.equal(f.state.models,1);
});

test('actual 2.0.1 package reads and writes legacy plans while ignoring new targets; Stop and upgrade never auto-execute them',{skip:!oldPackage},async t=>{
 const bytes=readFileSync(oldPackage);assert.equal(createHash('sha256').update(bytes).digest('hex'),'0ed158cb807be7856d0ccb5058097365199a0a5e3dc974205a309e456167a6e7');
 const files=unpack(bytes),f=fixture(t),modulePath=join(f.directory,'old201.mjs');writeFileSync(modulePath,files.get('lib/index.js'));const old=await import(pathToFileURL(modulePath).href);
 await configure(f);const interest=await create(f),target=await create(f,{watchMode:'video',videoId});await f.reopen(old.createBilibiliService);
 assert.deepEqual((await f.call('schedule.list')).map(s=>s.id),[interest.id]);await f.call('settings.update',{shareMode:'record-only'});
 const context={URL,Date,Intl,CustomEvent,Event,EventTarget,setTimeout,clearTimeout,console};for(const key of ['window','document','fetch'])Object.defineProperty(context,key,{get:()=>globalThis[key],configurable:true});
 const client=files.get('lib/client.js').toString().replace('if (typeof window !== "undefined" && window.__ModuleLoader__)','globalThis.__oldPage = createBilibiliApp; if (typeof window !== "undefined" && window.__ModuleLoader__)');vm.runInNewContext(client,context);
 const page=mountPage(t,context.__oldPage,async(action,payload)=>action==='readiness'?ok({mode:'runtime',blockers:[]}):ok(await f.call(action,payload)));await page.settle();assert.ok(!page.text().includes(target.id));assert.ok(!page.text().includes('scheduled-video'));page.unmount();
 await f.call('stop');await f.reopen();const held=(await f.call('schedule.list')).find(s=>s.id===target.id);assert.equal(held.requiresConfirmation,true);
 assert.equal((await f.call('tick')).reason,'BILI_STOPPED');assert.equal(f.state.models,0);assert.equal(f.state.selects.length,0);
 await f.call('schedule.start',{scheduleId:target.id,confirm:true});assert.equal(f.state.selects.length,1);assert.equal(f.state.selects[0].videoId,videoId);
 assert.equal(rows(f.databasePath,'SELECT schema_version FROM a_plugin_meta')[0].schema_version,1);
});
