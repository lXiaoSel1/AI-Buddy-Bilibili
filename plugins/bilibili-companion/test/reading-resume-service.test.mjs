import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createBilibiliService} from '../src/service.mjs';
import {currentReadingReason} from '../src/client/watch-state.mjs';

const clone=value=>structuredClone(value);
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function fixture(t){
 const directory=mkdtempSync(join(tmpdir(),'bili-resume-service-')),databasePath=join(directory,'plugin.sqlite'),state={models:[],leases:[],finishes:[],contexts:new Map(),hostRecords:new Map(),nextLeaseFailure:null,nextConfirmFailure:null,nextGetGate:null};
 const scope={accountId:'10001',characterId:'deepseek',personaId:'persona',lifeId:'life',operationId:'operation',generation:1},video={videoId:'BV12345678',cid:123,duration:6,title:'Fixture',pages:[{cid:123,page:1,duration:6}]},leaseStates=new Map();let contextNumber=0;
 const host={async describe(){return {features:['bilibili-vision-v1','bilibili-full-reading-v1']};},async invoke(method,payload,{signal}={}){
  if(method==='social.context.read'){
   if(payload.purpose==='manage-plugin')return {contextToken:'manage',accountId:scope.accountId,permissions:['plugin.manage'],managedConnections:[{ref:'account',label:'Account',platform:'bilibili'},{ref:'model',label:'Vision',platform:'model'}],availableCharacters:[{id:'deepseek',label:'Fixture'}]};
   if(payload.purpose==='plugin-background')return {contextToken:'background',accountId:scope.accountId,permissions:['plugin.activity']};
   const gate=state.activityContextGate;if(gate&&--gate.remaining===0){state.activityContextGate=null;gate.entered.resolve();await gate.release.promise;}
   const context={...scope,connectionRef:payload.modelConnectionRef??'model',contextToken:'context-'+(++contextNumber)};state.contexts.set(context.contextToken,context);return context;
  }
  if(method==='activity.lease'){
   state.leases.push(clone(payload));if(state.nextLeaseFailure){const code=state.nextLeaseFailure;state.nextLeaseFailure=null;throw Object.assign(Error(code),{code});}
   if(leaseStates.has(payload.activityId))throw Object.assign(Error('Activity already ended or belongs to another scope'),{code:'BUDDY_SOCIAL_DENIED'});
   const leaseId='lease-'+state.leases.length;leaseStates.set(payload.activityId,{leaseId,state:'active'});return {leaseId,generation:1};
  }
  if(method==='activity.check')return {valid:true,...state.contexts.get(payload.contextToken)};
  if(method==='activity.finish'){state.finishes.push(clone(payload));const lease=[...leaseStates.values()].find(x=>x.leaseId===payload.leaseId);if(lease)lease.state='cancelled';return {finished:true};}
  if(method==='ui.bubble')return {ok:true};if(method==='experience.append')return {recorded:true,eventId:payload.eventId};
  if(method==='connections.request'){
   const p=payload.parameters,op=payload.operation.split('.').at(-1);let reading=state.hostRecords.get(p.readingId);
   if(op==='prepare'){reading={readingMode:'full-v1',readingId:p.readingId,planHash:'plan-'+p.readingId,confirmed:false,phase:'awaiting-confirmation',model:{connectionRef:'model'},config:p.config,parts:[{cid:123,page:1,duration:6}],sheetRef:'sheet',calls:[],progress:{completed:0,total:2},coverage:{images:{completed:0,total:1},cues:{completed:0,total:1},complete:false},needsReview:false,finalProviderRequestId:null};state.hostRecords.set(p.readingId,reading);return clone(reading);}
   assert.ok(reading,'every host read must refer to a prepared plan');
   if(op==='get'){const value=clone(reading),gate=state.nextGetGate;state.nextGetGate=null;if(gate){gate.entered.resolve();await gate.release.promise;}return value;}
   if(op==='confirm'){if(state.nextConfirmFailure){const code=state.nextConfirmFailure;state.nextConfirmFailure=null;throw Object.assign(Error(code),{code});}assert.equal(p.planHash,reading.planHash);assert.equal(p.confirmed,true);reading.confirmed=true;reading.phase='reading';return clone(reading);}
   if(op==='pause'){reading.phase='paused';reading.modelReason='BILI_FULL_PAUSED';return clone(reading);}
   if(op==='stop'){reading.phase='cancelled';return clone(reading);}
   if(op==='read'){const gate=state.nextReadGate;state.nextReadGate=null;if(gate){gate.entered.resolve();await new Promise((resolve,reject)=>{const abort=()=>reject(Object.assign(Error('Paused before any model submission'),{code:'BILI_CANCELLED'}));if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});});}reading.phase='reading';reading.modelReason=null;return {batchId:'batch-1',stepKind:'summary',finalSummary:true,inputHash:'input-hash',visualMaterialRefs:['sheet'],material:{videoId:video.videoId,coverage:'frames',complete:false,sourceRefs:[],items:[{id:'frame-1',imageRef:'sheet'}],coverageNotes:'Fixture'}};}
   throw Error(payload.operation);
  }
  if(method==='models.request'){state.models.push(clone(payload));const r=state.hostRecords.get(payload.readingId);r.phase='completed';r.progress.completed=2;r.coverage={images:{completed:1,total:1},cues:{completed:1,total:1},complete:true};r.calls=[{stepId:payload.stepId,status:'completed',processed:true,providerRequestId:'provider'}];const result={requestId:'provider',understanding:{summary:'Source-backed fixture',notes:'Visible fixture',evidenceRefs:['frame-1'],completedMaterial:true,shareWorthy:false,commentWorthy:false,shareText:'',interestTags:[]}};return state.modelTextWrap?{requestId:result.requestId,text:state.modelTextWrap(JSON.stringify(result.understanding))}:result;}
  throw Error(method);
 }};
 const platform={async selectVideo(){return video;},async acquireMaterial(){return {videoId:video.videoId,videoCid:123,coverage:'subtitles',complete:true,items:[{id:'subtitle:1',start:0,end:1,text:'Original subtitle'}],readRange:{language:'zh-CN',cid:123}};}};
 const options={databasePath,host,platform,now:()=>Date.parse('2026-11-01T12:00:00Z'),timeZone:'UTC',runtimeOwnerInspector:pid=>({pid,exe:'fixture',birth:'fixture'})};let service=createBilibiliService(options);
 t.after(async()=>{await service.close();rmSync(directory,{recursive:true,force:true});});
 const call=(action,payload={})=>service.dispatch(action,payload,{contextToken:'app'}),readKV=key=>{const db=new DatabaseSync(databasePath,{readOnly:true});try{return JSON.parse(db.prepare('SELECT value FROM a_plugin_kv WHERE key=?').get(key).value);}finally{db.close();}},writeKV=(key,value)=>{const db=new DatabaseSync(databasePath);try{db.prepare('INSERT INTO a_plugin_kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}finally{db.close();}};
 await call('settings.update',{connectionRef:'account',modelConnectionRef:'model',shareMode:'record-only',autonomousEnabled:false});
 const seedFailed=async()=>{const a=await call('now',{characterId:'deepseek',visual:true}),key='full-activity-v206:'+a.id,failed={...readKV(key),state:'failed',lastFailureCode:'BUDDY_SOCIAL_DENIED',pauseReason:null,modelState:'prepared',needsReview:false,effective:false};writeKV(key,failed);const h=state.hostRecords.get(a.id);h.confirmed=true;h.phase='reading';return failed;};
 return {state,scope,call,readKV,writeKV,seedFailed,databasePath,callFrom:(token,action,payload={})=>service.dispatch(action,payload,{contextToken:token}),restart:async()=>{await service.close();service=createBilibiliService(options);},close:()=>service.close(),gateNextGet(){const gate={entered:deferred(),release:deferred()};state.nextGetGate=gate;return gate;},gateActivityContext(remaining){const gate={remaining,entered:deferred(),release:deferred()};state.activityContextGate=gate;return gate;},gateNextRead(){const gate={entered:deferred()};state.nextReadGate=gate;return gate;}};
}

test('a retained activity without its original model ref refuses confirmation without a new role context or model call',async t=>{
 const f=await fixture(t),preview=await f.call('now',{characterId:'deepseek',visual:true}),plan=await f.call('reading.get',{activityId:preview.id}),key='full-activity-v206:'+preview.id,activity=f.readKV(key);delete activity.modelConnectionRef;f.writeKV(key,activity);
 const contexts=f.state.contexts.size;await assert.rejects(f.call('reading.confirm',{activityId:preview.id,confirmed:true,planHash:plan.planHash}),{code:'BILI_VISION_MODEL_CHANGED_RESTART_REQUIRED'});assert.equal(f.state.contexts.size,contexts);assert.equal(f.state.models.length,0);assert.equal(f.state.hostRecords.get(preview.id).confirmed,false);assert.equal(f.readKV(key).modelConnectionRef,undefined);
});

test('a confirmed manual plan uses a fresh lease attempt while retaining the reading and model identities',async t=>{
 const f=await fixture(t),preview=await f.call('now',{characterId:'deepseek',visual:true}),plan=await f.call('reading.get',{activityId:preview.id});assert.equal(f.state.models.length,0);
 const result=await f.call('reading.confirm',{activityId:preview.id,confirmed:true,planHash:plan.planHash});assert.equal(result.state,'completed');assert.equal(f.state.leases.length,2);assert.equal(new Set(f.state.leases.map(x=>x.activityId)).size,2);assert.ok(f.state.leases.every(x=>x.activityId!==preview.id));assert.deepEqual(f.state.finishes.map(x=>x.activityId),f.state.leases.map(x=>x.activityId));assert.ok(f.state.models.every(x=>x.activityId===preview.id&&x.readingId===preview.id&&x.requestId===preview.id+':'+x.stepId));
});

test('accepted confirmation is checkpointed before a resumed lease fails; rejected confirmation never is',async t=>{
 const f=await fixture(t),a=await f.call('now',{characterId:'deepseek',visual:true}),p=await f.call('reading.get',{activityId:a.id});f.state.nextLeaseFailure='BUDDY_SOCIAL_DENIED';await f.call('reading.confirm',{activityId:a.id,confirmed:true,planHash:p.planHash});assert.equal(f.readKV('reading-full-v1:'+a.id).confirmed,true);
 const b=await f.call('now',{characterId:'deepseek',visual:true}),bp=await f.call('reading.get',{activityId:b.id});f.state.nextConfirmFailure='TRUSTED_UI_PRINCIPAL_REQUIRED';await assert.rejects(f.call('reading.confirm',{activityId:b.id,confirmed:true,planHash:bp.planHash}),{code:'TRUSTED_UI_PRINCIPAL_REQUIRED'});assert.equal(f.readKV('reading-full-v1:'+b.id).confirmed,false);
});

test('reading get projects failed state, preserves host review and never mutates the failed record',async t=>{
 const f=await fixture(t),a=await f.seedFailed(),before=f.readKV('full-activity-v206:'+a.id);f.state.hostRecords.get(a.id).needsReview=true;const dto=await f.call('reading.get',{activityId:a.id});assert.equal(dto.phase,'failed');assert.equal(dto.needsReview,true);assert.equal(dto.recoverableZeroCall,false);assert.deepEqual(f.readKV('full-activity-v206:'+a.id),before);assert.equal(f.state.models.length,0);
});

test('only explicit reading continue recovers a proven zero-call failure and retains its original failure evidence',async t=>{
 const f=await fixture(t),a=await f.seedFailed(),key='full-activity-v206:'+a.id,before=f.readKV(key),plan=f.readKV('reading-full-v1:'+a.id);assert.equal((await f.call('reading.get',{activityId:a.id})).recoverableZeroCall,true);assert.deepEqual(f.readKV(key),before);await f.call('tick');assert.equal(f.readKV(key).state,'failed');assert.equal(f.state.models.length,0);
 const result=await f.call('reading.continue',{activityId:a.id});assert.equal(result.state,'completed');assert.equal(result.id,a.id);assert.equal(f.readKV('reading-full-v1:'+a.id).planHash,plan.planHash);assert.ok(f.readKV(key).zeroCallRecoveryFailures.some(x=>x.state==='failed'&&x.lastFailureCode==='BUDDY_SOCIAL_DENIED'&&x.modelState==='prepared'));assert.equal(f.state.models.length,1);
});

for(const [name,change] of [
 ['missing calls',r=>{delete r.calls;}],['a completed host batch',r=>{r.calls=[{status:'completed',processed:true}];}],['an unknown host batch',r=>{r.calls=[{status:'unknown'}];}],['missing progress count',r=>{delete r.progress.completed;}],['completed image coverage',r=>{r.coverage.images.completed=1;}],['missing cue coverage count',r=>{delete r.coverage.cues.completed;}],['another reading identity',r=>{r.readingId='foreign';}],['another plan hash',r=>{r.planHash='foreign';}],['unconfirmed host',r=>{r.confirmed=false;}],['cancelled host',r=>{r.phase='cancelled';}],['host needs review',r=>{r.needsReview=true;}],['host provider receipt',r=>{r.finalProviderRequestId='provider';}]
])test('zero-call recovery refuses '+name,async t=>{const f=await fixture(t),a=await f.seedFailed();change(f.state.hostRecords.get(a.id));assert.equal((await f.call('reading.get',{activityId:a.id})).recoverableZeroCall,false);await assert.rejects(f.call('reading.continue',{activityId:a.id}));assert.equal(f.readKV('full-activity-v206:'+a.id).state,'failed');assert.equal(f.state.models.length,0);});

for(const [name,change] of [
 ['local pending',c=>{c.pending={stepId:'unknown'};}],['local paid result',c=>{c.results={'batch-1':{providerRequestId:'provider'}};}],['local invalid receipt',c=>{c.invalidReceipts={'batch-1':{providerRequestId:'provider'}};}]
])test('zero-call recovery retains and refuses '+name,async t=>{const f=await fixture(t),a=await f.seedFailed(),key='reading-full-v1:'+a.id,c=f.readKV(key);change(c);f.writeKV(key,c);assert.equal((await f.call('reading.get',{activityId:a.id})).recoverableZeroCall,false);await assert.rejects(f.call('reading.continue',{activityId:a.id}));assert.deepEqual(f.readKV(key),c);assert.equal(f.state.models.length,0);});

for(const action of ['stop','reading.stop','reading.pause','settings.update'])test('late zero-call recovery cannot override '+action,async t=>{
 const f=await fixture(t),a=await f.seedFailed(),gate=f.gateNextGet(),recover=f.call('reading.continue',{activityId:a.id});await gate.entered.promise;
 await f.call(action,action==='settings.update'?{connectionRef:'other-account'}:action.startsWith('reading.')?{activityId:a.id}:{});gate.release.resolve();await assert.rejects(recover);assert.equal(f.state.models.length,0);assert.equal(f.state.leases.length,1);assert.ok(['failed','cancelled'].includes(f.readKV('full-activity-v206:'+a.id).state));
});

test('closing the service while recovery awaits the host cannot start another lease',async t=>{
 const f=await fixture(t),a=await f.seedFailed(),gate=f.gateNextGet(),recover=f.call('reading.continue',{activityId:a.id});await gate.entered.promise;const closing=f.close();gate.release.resolve();await assert.rejects(recover);await closing;assert.equal(f.state.models.length,0);assert.equal(f.state.leases.length,1);
});

test('a later reading pause during the second recovery context lookup prevents tick from starting a lease',async t=>{
 const f=await fixture(t),a=await f.seedFailed(),gate=f.gateActivityContext(2),recover=f.call('reading.continue',{activityId:a.id});
 await gate.entered.promise;
 try{
  const promoted=f.readKV('full-activity-v206:'+a.id);assert.equal(promoted.state,'paused');assert.ok(promoted.zeroCallRecoveryFailures?.some(x=>x.lastFailureCode==='BUDDY_SOCIAL_DENIED'));
  await f.call('reading.pause',{activityId:a.id});assert.equal(f.state.models.length,0);assert.equal(f.state.leases.length,1);
 }finally{gate.release.resolve();}
 await assert.rejects(recover,{code:'BILI_CONTROL_STALE'});
 assert.equal(f.state.models.length,0);assert.equal(f.state.leases.length,1);assert.equal(f.readKV('full-activity-v206:'+a.id).state,'paused');assert.equal(f.state.hostRecords.get(a.id).phase,'paused');
});

for(const action of ['reading.confirm','reading.continue'])test('a later pause during ordinary '+action+' context lookup prevents its lease claim',async t=>{
 const f=await fixture(t),a=await f.call('now',{characterId:'deepseek',visual:true}),plan=await f.call('reading.get',{activityId:a.id});if(action==='reading.continue'){f.state.hostRecords.get(a.id).confirmed=true;await f.call('reading.pause',{activityId:a.id});}
 const gate=f.gateActivityContext(1),running=f.call(action,{activityId:a.id,confirmed:true,planHash:plan.planHash});await gate.entered.promise;try{await f.call('reading.pause',{activityId:a.id});}finally{gate.release.resolve();}await assert.rejects(running,{code:'BILI_CONTROL_STALE'});assert.equal(f.state.models.length,0);assert.equal(f.state.leases.length,1);assert.equal(f.readKV('full-activity-v206:'+a.id).state,'paused');
});

test('ordinary pause then continue completes without returning a stale cancellation reason',async t=>{
 const f=await fixture(t),a=await f.call('now',{characterId:'deepseek',visual:true}),plan=await f.call('reading.get',{activityId:a.id}),gate=f.gateNextRead(),running=f.call('reading.confirm',{activityId:a.id,confirmed:true,planHash:plan.planHash});await gate.entered.promise;await f.call('reading.pause',{activityId:a.id});const paused=await running;assert.equal(paused.state,'paused');assert.equal(paused.lastFailureCode,'BILI_CANCELLED');assert.equal(f.state.models.length,0);
 const resumed=await f.call('reading.continue',{activityId:a.id});assert.equal(resumed.state,'completed');const view=await f.call('reading.get',{activityId:a.id});assert.equal(view.phase,'completed');assert.equal(view.modelReason,null);assert.equal(f.readKV('full-activity-v206:'+a.id).lastFailureCode,null);assert.equal(f.readKV('full-activity-v206:'+a.id).pauseReason,null);assert.equal(f.state.models.length,1);
});

test('reconfirming a completed plan cannot downgrade the host phase or acquire another lease',async t=>{
 const f=await fixture(t),a=await f.call('now',{characterId:'deepseek',visual:true}),plan=await f.call('reading.get',{activityId:a.id});await f.call('reading.confirm',{activityId:a.id,confirmed:true,planHash:plan.planHash});const before={models:f.state.models.length,leases:f.state.leases.length,host:clone(f.state.hostRecords.get(a.id)),quota:await f.call('quota.read')};
 const again=await f.call('reading.confirm',{activityId:a.id,confirmed:true,planHash:plan.planHash});assert.equal(again.phase,'completed');assert.deepEqual(f.state.hostRecords.get(a.id),before.host);assert.equal(f.state.models.length,before.models);assert.equal(f.state.leases.length,before.leases);assert.deepEqual(await f.call('quota.read'),before.quota);
});

for(const [name,request,change,code] of [
 ['another plan hash',{confirmed:true,planHash:'another-plan'},()=>{},'BILI_FULL_PLAN_CONFIRMATION_REQUIRED'],
 ['missing explicit confirmation',{confirmed:false},()=>{},'BILI_FULL_PLAN_CONFIRMATION_REQUIRED'],
 ['unconfirmed host',{confirmed:true},r=>{r.confirmed=false;r.phase='awaiting-confirmation';},'BILI_FULL_PLAN_CONFIRMATION_REQUIRED'],
 ['host review',{confirmed:true},r=>{r.needsReview=true;r.calls=[{status:'unknown'}];},'BILI_VISION_UNCERTAIN']
])test('reconfirmation cannot bypass '+name,async t=>{
 const f=await fixture(t),a=await f.call('now',{characterId:'deepseek',visual:true}),plan=await f.call('reading.get',{activityId:a.id});await f.call('reading.confirm',{activityId:a.id,confirmed:true,planHash:plan.planHash});change(f.state.hostRecords.get(a.id));const before=clone(f.state.hostRecords.get(a.id)),models=f.state.models.length,leases=f.state.leases.length;
 await assert.rejects(f.call('reading.confirm',{activityId:a.id,planHash:plan.planHash,...request}),{code});assert.deepEqual(f.state.hostRecords.get(a.id),before);assert.equal(f.state.models.length,models);assert.equal(f.state.leases.length,leases);
});


for(const boundary of ['checkpoint','activity'])test('batch receipt, result index and activity commit together when '+boundary+' persistence fails',async t=>{
 const f=await fixture(t),a=await f.call('now',{characterId:'deepseek',visual:true}),plan=await f.call('reading.get',{activityId:a.id}),db=new DatabaseSync(f.databasePath);
 try{
  const condition=boundary==='checkpoint'?"NEW.key GLOB 'reading-full-v1:*' AND json_extract(NEW.value,'$.pending') IS NULL":"NEW.key GLOB 'full-activity-v206:*' AND json_extract(NEW.value,'$.modelState')='prepared'";
  db.exec("CREATE TRIGGER refuse_receipt_boundary BEFORE UPDATE ON a_plugin_kv WHEN "+condition+" AND EXISTS(SELECT 1 FROM a_plugin_kv WHERE key GLOB 'full-result-v206:*') BEGIN SELECT RAISE(ABORT,'synthetic receipt boundary');END");
  await f.call('reading.confirm',{activityId:a.id,confirmed:true,planHash:plan.planHash});
  const checkpoint=f.readKV('reading-full-v1:'+a.id),activity=f.readKV('full-activity-v206:'+a.id);assert.ok(checkpoint.pending,'the pre-receipt pending checkpoint must survive rollback');assert.deepEqual(checkpoint.results,{});assert.equal(db.prepare("SELECT COUNT(*) n FROM a_plugin_kv WHERE key GLOB 'full-result-v206:*'").get().n,0,'no orphan result can escape the failed transaction');assert.equal(activity.needsReview,true);assert.equal(f.state.models.length,1);
 }finally{db.exec('DROP TRIGGER IF EXISTS refuse_receipt_boundary');db.close();}
});

test('restart repairs legacy pending-null activity uncertainty only after matching the exact host and retained local receipt',async t=>{
 const f=await fixture(t),a=await f.call('now',{characterId:'deepseek',visual:true}),plan=await f.call('reading.get',{activityId:a.id});await f.call('reading.confirm',{activityId:a.id,confirmed:true,planHash:plan.planHash});
 const key='full-activity-v206:'+a.id,checkpoint=f.readKV('reading-full-v1:'+a.id),result=f.readKV('full-result-v206:'+a.id+':batch-1'),original=clone(result),activity=f.readKV(key);assert.equal(checkpoint.pending,null);f.writeKV(key,{...activity,state:'understanding',modelState:'started',needsReview:false});
 const host=f.state.hostRecords.get(a.id);host.recoveredResults=[{...result,readingId:a.id,planHash:checkpoint.planHash,inputHash:'input-hash'}];await f.restart();assert.equal(f.readKV(key).needsReview,true);
 const recovered=await f.call('reading.get',{activityId:a.id});assert.equal(recovered.needsReview,false);assert.equal(f.readKV(key).needsReview,false);assert.equal(f.readKV(key).modelState,'prepared');assert.equal(f.readKV('reading-full-v1:'+a.id).pending,null);assert.deepEqual(f.readKV('full-result-v206:'+a.id+':batch-1'),original);assert.equal(f.state.models.length,1);
});

test('accepted resume archives an old current failure and projects live host phase consistently during the next request',async t=>{
 const f=await fixture(t),a=await f.call('now',{characterId:'deepseek',visual:true}),plan=await f.call('reading.get',{activityId:a.id}),key='full-activity-v206:'+a.id;
 const old=f.readKV(key);f.writeKV(key,{...old,pauseReason:'BILI_FULL_MODEL_CAPACITY',lastFailureCode:'BILI_FULL_MODEL_CAPACITY'});const host=f.state.hostRecords.get(a.id);host.confirmed=true;host.phase='reading';const gate=f.gateNextRead(),running=f.callFrom('window-one','reading.continue',{activityId:a.id});await gate.entered.promise;
 const current=f.readKV(key),view=await f.callFrom('window-two','reading.get',{activityId:a.id});assert.equal(current.lastFailureCode,null);assert.equal(current.pauseReason,null);assert.ok(current.failureHistory?.some(error=>error.code==='BILI_FULL_MODEL_CAPACITY'));assert.equal(view.phase,'reading');assert.equal(view.modelReason,null);assert.equal(view.pauseReason,null);await f.callFrom('window-two','reading.pause',{activityId:a.id});await running;
});

test('a pause from a second window supersedes an in-flight continue from the first window',async t=>{
 const f=await fixture(t),a=await f.call('now',{characterId:'deepseek',visual:true});f.state.hostRecords.get(a.id).confirmed=true;await f.callFrom('window-two','reading.pause',{activityId:a.id});const gate=f.gateNextGet(),running=f.callFrom('window-one','reading.continue',{activityId:a.id});await gate.entered.promise;await f.callFrom('window-two','reading.pause',{activityId:a.id});gate.release.resolve();await assert.rejects(running,{code:'BILI_CONTROL_STALE'});assert.equal(f.state.models.length,0);assert.equal(f.state.leases.length,1);assert.equal(f.readKV('full-activity-v206:'+a.id).state,'paused');assert.equal((await f.callFrom('window-two','reading.get',{activityId:a.id})).phase,'paused');
});


for(const schemaInvalid of [true,false])test('management archives a complete known-invalid original receipt without coverage or replay: '+schemaInvalid,async t=>{
 const f=await fixture(t),a=await f.call('now',{characterId:'deepseek',visual:true}),key='full-activity-v206:'+a.id,checkpoint=f.readKV('reading-full-v1:'+a.id),material={items:[{id:'frame-1',imageRef:'sheet'}]},understanding=schemaInvalid?null:{summary:'Incomplete original',notes:'Not every item read',evidenceRefs:['frame-1'],completedMaterial:false,shareWorthy:false,commentWorthy:false,shareText:'',interestTags:[]},result={requestId:'paid-invalid',text:schemaInvalid?'{malformed':JSON.stringify(understanding)};
 f.writeKV('reading-full-v1:'+a.id,{...checkpoint,confirmed:true,pending:{stepId:'batch-1',requestId:a.id+':batch-1',inputHash:'input-hash'}});f.writeKV(key,{...f.readKV(key),state:'paused',modelState:'started',needsReview:true,lastFailureCode:'SOCIAL_MODEL_RESULT_UNKNOWN',pauseReason:'SOCIAL_MODEL_RESULT_UNKNOWN'});
 const host=f.state.hostRecords.get(a.id);Object.assign(host,{confirmed:true,phase:'paused',modelReason:'BILI_FULL_MATERIAL_NOT_COMPLETED',needsReview:false,calls:[{stepId:'batch-1',status:'completed',processed:false,providerRequestId:'paid-invalid'}],recoveredResults:[{readingId:a.id,planHash:checkpoint.planHash,stepId:'batch-1',inputHash:'input-hash',providerRequestId:'paid-invalid',material,understanding,receiptKind:'invalid',schemaInvalid,result}]});
 const coverage=clone(host.coverage),view=await f.call('reading.get',{activityId:a.id}),record=f.readKV('reading-full-v1:'+a.id),activity=f.readKV(key),retained=f.readKV('full-result-v206:'+a.id+':batch-1');assert.equal(record.pending,null);assert.deepEqual(record.results,{});assert.equal(activity.needsReview,false);assert.equal(activity.modelState,'returned');assert.equal(view.needsReview,false);assert.equal(view.modelReason,'BILI_FULL_MATERIAL_NOT_COMPLETED');assert.equal(view.recoveredResults,undefined);assert.deepEqual(retained.result,result);assert.equal(retained.schemaInvalid,schemaInvalid);assert.deepEqual(host.coverage,coverage);assert.ok(activity.failureHistory.some(error=>error.code==='SOCIAL_MODEL_RESULT_UNKNOWN'));
 await assert.rejects(f.call('reading.continue',{activityId:a.id}),{code:'BILI_FULL_MATERIAL_NOT_COMPLETED'});const before=clone(activity);await f.call('reading.get',{activityId:a.id});assert.deepEqual(f.readKV(key),before);assert.equal(f.state.models.length,0);assert.equal(f.state.leases.length,1);
});

test('a failed management activity write rolls back its recovered result and checkpoint together',async t=>{
 const f=await fixture(t),a=await f.call('now',{characterId:'deepseek',visual:true}),key='full-activity-v206:'+a.id,checkpoint=f.readKV('reading-full-v1:'+a.id),understanding={summary:'Original observation',notes:'Original notes',evidenceRefs:['frame-1'],completedMaterial:true,shareWorthy:false,commentWorthy:false,shareText:'',interestTags:[]},material={items:[{id:'frame-1',imageRef:'sheet'}]};
 f.writeKV('reading-full-v1:'+a.id,{...checkpoint,confirmed:true,pending:{stepId:'batch-1',requestId:a.id+':batch-1',inputHash:'input-hash'}});f.writeKV(key,{...f.readKV(key),state:'paused',modelState:'started',needsReview:true});Object.assign(f.state.hostRecords.get(a.id),{confirmed:true,phase:'paused',needsReview:false,calls:[{stepId:'batch-1',status:'completed',processed:true,providerRequestId:'paid-original'}],recoveredResults:[{readingId:a.id,planHash:checkpoint.planHash,stepId:'batch-1',inputHash:'input-hash',providerRequestId:'paid-original',material,understanding}]});
 const db=new DatabaseSync(f.databasePath);try{db.exec("CREATE TRIGGER refuse_recovery_activity BEFORE UPDATE ON a_plugin_kv WHEN NEW.key GLOB 'full-activity-v206:*' AND json_extract(NEW.value,'$.modelState')='prepared' BEGIN SELECT RAISE(ABORT,'synthetic recovery activity');END");await assert.rejects(f.call('reading.get',{activityId:a.id}),/synthetic recovery activity/);assert.ok(f.readKV('reading-full-v1:'+a.id).pending);assert.equal(f.readKV(key).needsReview,true);assert.equal(db.prepare("SELECT COUNT(*) n FROM a_plugin_kv WHERE key GLOB 'full-result-v206:*'").get().n,0);db.exec('DROP TRIGGER refuse_recovery_activity');assert.equal((await f.call('reading.get',{activityId:a.id})).needsReview,false);assert.equal(f.state.models.length,0);}finally{db.exec('DROP TRIGGER IF EXISTS refuse_recovery_activity');db.close();}
});


test('a settings revocation during management recovery preserves the pending checkpoint and current review flag',async t=>{
 const f=await fixture(t),a=await f.call('now',{characterId:'deepseek',visual:true}),key='full-activity-v206:'+a.id,checkpoint=f.readKV('reading-full-v1:'+a.id),material={items:[{id:'frame-1',imageRef:'sheet'}]},understanding={summary:'Original observation',notes:'Original notes',evidenceRefs:['frame-1'],completedMaterial:true,shareWorthy:false,commentWorthy:false,shareText:'',interestTags:[]};
 f.writeKV('reading-full-v1:'+a.id,{...checkpoint,confirmed:true,pending:{stepId:'batch-1',requestId:a.id+':batch-1',inputHash:'input-hash'}});f.writeKV(key,{...f.readKV(key),state:'paused',modelState:'started',needsReview:true});Object.assign(f.state.hostRecords.get(a.id),{confirmed:true,phase:'paused',needsReview:false,calls:[{stepId:'batch-1',status:'completed',processed:true,providerRequestId:'paid-original'}],recoveredResults:[{readingId:a.id,planHash:checkpoint.planHash,stepId:'batch-1',inputHash:'input-hash',providerRequestId:'paid-original',material,understanding}]});
 const gate=f.gateNextGet(),reading=f.call('reading.get',{activityId:a.id});await gate.entered.promise;await f.call('settings.update',{connectionRef:'other-account'});gate.release.resolve();const view=await reading;assert.equal(view.needsReview,true);assert.ok(f.readKV('reading-full-v1:'+a.id).pending);assert.deepEqual(f.readKV('reading-full-v1:'+a.id).results,{});assert.equal(f.readKV(key).needsReview,true);assert.equal(f.state.models.length,0);
});

test('a fenced final model reply completes the actual plugin reading without a new reader or replay',async t=>{
 const f=await fixture(t);f.state.modelTextWrap=text=>'```json\n'+text+'\n```';const a=await f.call('now',{characterId:'deepseek',visual:true}),plan=await f.call('reading.get',{activityId:a.id});const result=await f.call('reading.confirm',{activityId:a.id,confirmed:true,planHash:plan.planHash});assert.equal(result.state,'completed');assert.equal(result.id,a.id);assert.equal(f.state.models.length,1);const checkpoint=f.readKV('reading-full-v1:'+a.id);assert.equal(Object.keys(checkpoint.results).length,1);assert.equal(Object.keys(checkpoint.invalidReceipts??{}).length,0);
});

async function seedLegacyFenced(f){
 const a=await f.call('now',{characterId:'deepseek',visual:true}),key='reading-full-v1:'+a.id,checkpoint=f.readKV(key),stepId='batch-1',providerRequestId='paid-fenced-original',resultRef='full-result-v206:'+a.id+':'+stepId,material={videoId:'BV12345678',coverage:'frames',complete:false,sourceRefs:[],items:[{id:'frame-1',imageRef:'sheet'}],coverageNotes:'Original fixture'},understanding={summary:'Original fenced observation',notes:'Original fenced detail',evidenceRefs:['frame-1'],completedMaterial:true,shareWorthy:false,commentWorthy:false,shareText:'',interestTags:[]},raw={requestId:providerRequestId,text:'```json\n'+JSON.stringify(understanding)+'\n```'},invalid={stepId,providerRequestId,result:raw,material,schemaInvalid:true};
 f.writeKV(resultRef,invalid);f.writeKV(key,{...checkpoint,confirmed:true,phase:'paused',modelReason:'BILI_FULL_MATERIAL_NOT_COMPLETED',pending:null,results:{},invalidReceipts:{[stepId]:{providerRequestId,resultRef}}});f.writeKV('full-activity-v206:'+a.id,{...f.readKV('full-activity-v206:'+a.id),state:'paused',modelState:'returned',needsReview:false,lastFailureCode:'BILI_FULL_MATERIAL_NOT_COMPLETED',pauseReason:'BILI_FULL_MATERIAL_NOT_COMPLETED'});
 const host=f.state.hostRecords.get(a.id);Object.assign(host,{confirmed:true,phase:'completed',modelReason:null,needsReview:false,finalBatchId:stepId,finalProcessed:true,finalProviderRequestId:providerRequestId,progress:{completed:2,total:2},coverage:{images:{completed:1,total:1},cues:{completed:1,total:1},complete:true},calls:[{stepId,status:'completed',processed:true,providerRequestId}],recoveredResults:[{readingId:a.id,planHash:checkpoint.planHash,stepId,inputHash:'input-hash',providerRequestId,material:clone(material),understanding:clone(understanding)}]});
 return {a,key,stepId,resultRef,invalid,host};
}

test('reading get repairs only the original fenced-invalid receipt into a separate immutable result across reboot',async t=>{
 const f=await fixture(t),legacy=await seedLegacyFenced(f),{a,key,stepId,resultRef,invalid}=legacy;await f.restart();const view=await f.call('reading.get',{activityId:a.id}),record=f.readKV(key);assert.equal(record.results[stepId]?.providerRequestId,invalid.providerRequestId);assert.equal(Object.keys(record.invalidReceipts??{}).length,0);assert.equal(record.recoveredInvalidReceipts[stepId].resultRef,resultRef);assert.equal(record.results[stepId].resultRef,'full-recovered-result-v207:'+a.id+':'+stepId);assert.deepEqual(f.readKV(resultRef),invalid);assert.equal(view.results[0].summary,'Original fenced observation');assert.equal(view.needsReview,false);assert.equal(view.phase,'paused');assert.equal(view.modelReason,null);assert.notEqual(currentReadingReason(view),'BILI_FULL_MATERIAL_NOT_COMPLETED');assert.ok(f.readKV('full-activity-v206:'+a.id).failureHistory.some(entry=>entry.code==='BILI_FULL_MATERIAL_NOT_COMPLETED'&&entry.pauseReason==='BILI_FULL_MATERIAL_NOT_COMPLETED'));assert.equal(f.state.models.length,0);
 const before=clone(record),activity=clone(f.readKV('full-activity-v206:'+a.id));await f.call('reading.get',{activityId:a.id});assert.deepEqual(f.readKV(key),before);assert.deepEqual(f.readKV('full-activity-v206:'+a.id),activity);await f.restart();const reboot=await f.call('reading.get',{activityId:a.id});assert.equal(reboot.results[0].notes,'Original fenced detail');assert.notEqual(currentReadingReason(reboot),'BILI_FULL_MATERIAL_NOT_COMPLETED');assert.deepEqual(f.readKV(key),before);assert.deepEqual(f.readKV(resultRef),invalid);
 const completed=await f.call('reading.continue',{activityId:a.id});assert.equal(completed.state,'completed');assert.equal(completed.id,a.id);assert.equal(f.state.models.length,0);assert.deepEqual(f.readKV(resultRef),invalid);
});

for(const [name,change]of [
 ['wrong provider',x=>{x.invalid.result.requestId='other-provider';}],['wrong material',x=>{x.invalid.material.items[0].imageRef='other-sheet';}],['wrong plan',x=>{x.host.recoveredResults[0].planHash='other-plan';}],['changed understanding',x=>{x.host.recoveredResults[0].understanding.notes='Changed note';}],['malformed text',x=>{x.invalid.result.text='{malformed';}],['multiple fences',x=>{x.invalid.result.text+='\n'+x.invalid.result.text;}],['schema false',x=>{x.invalid.schemaInvalid=false;x.invalid.result.text=JSON.stringify({...x.host.recoveredResults[0].understanding,completedMaterial:false});}],['pending unknown',x=>{x.checkpoint.pending={stepId:'another-batch',inputHash:'another-input'};}],['host unknown',x=>{x.host.needsReview=true;x.host.calls.push({stepId:'another-batch',status:'unknown',processed:false});}]
])test('fenced-invalid management recovery refuses '+name+' and retains the exact local checkpoint',async t=>{
 const f=await fixture(t),legacy=await seedLegacyFenced(f);legacy.checkpoint=f.readKV(legacy.key);change(legacy);f.writeKV(legacy.resultRef,legacy.invalid);f.writeKV(legacy.key,legacy.checkpoint);const before=clone(legacy.checkpoint),activity=clone(f.readKV('full-activity-v206:'+legacy.a.id));await assert.rejects(f.call('reading.get',{activityId:legacy.a.id}),{code:'BILI_FULL_RESULT_CONFLICT'});assert.deepEqual(f.readKV(legacy.key),before);assert.deepEqual(f.readKV('full-activity-v206:'+legacy.a.id),activity);assert.deepEqual(f.readKV(legacy.resultRef),legacy.invalid);assert.equal(f.state.models.length,0);
});

test('fenced-invalid management recovery preserves a stopped reading without projecting a derived result',async t=>{
 const f=await fixture(t),legacy=await seedLegacyFenced(f),activityKey='full-activity-v206:'+legacy.a.id;f.writeKV(activityKey,{...f.readKV(activityKey),state:'cancelled',pauseReason:'stop'});const before=clone(f.readKV(legacy.key)),activity=clone(f.readKV(activityKey)),view=await f.call('reading.get',{activityId:legacy.a.id});assert.equal(view.phase,'cancelled');assert.deepEqual(f.readKV(legacy.key),before);assert.deepEqual(f.readKV(activityKey),activity);assert.equal(view.results.length,0);assert.equal(f.state.models.length,0);
});

test('a preexisting different derived result remains immutable and blocks the entire local transition',async t=>{
 const f=await fixture(t),legacy=await seedLegacyFenced(f),derivedKey='full-recovered-result-v207:'+legacy.a.id+':'+legacy.stepId,other={stepId:legacy.stepId,providerRequestId:'other-original',understanding:{summary:'Other result'}};f.writeKV(derivedKey,other);const before=clone(f.readKV(legacy.key)),activity=clone(f.readKV('full-activity-v206:'+legacy.a.id));await assert.rejects(f.call('reading.get',{activityId:legacy.a.id}),{code:'BILI_FULL_RESULT_CONFLICT'});assert.deepEqual(f.readKV(derivedKey),other);assert.deepEqual(f.readKV(legacy.key),before);assert.deepEqual(f.readKV('full-activity-v206:'+legacy.a.id),activity);assert.deepEqual(f.readKV(legacy.resultRef),legacy.invalid);assert.equal(f.state.models.length,0);
});

test('derived fenced recovery rolls back its new result and both indexes when activity persistence fails',async t=>{
 const f=await fixture(t),legacy=await seedLegacyFenced(f),db=new DatabaseSync(f.databasePath),before=clone(f.readKV(legacy.key));try{
  db.exec("CREATE TRIGGER refuse_derived_recovery BEFORE UPDATE ON a_plugin_kv WHEN NEW.key GLOB 'full-activity-v206:*' AND json_extract(NEW.value,'$.modelState')='prepared' BEGIN SELECT RAISE(ABORT,'synthetic derived recovery');END");await assert.rejects(f.call('reading.get',{activityId:legacy.a.id}),/synthetic derived recovery/);assert.deepEqual(f.readKV(legacy.key),before);assert.equal(db.prepare("SELECT COUNT(*) n FROM a_plugin_kv WHERE key GLOB 'full-recovered-result-v207:*'").get().n,0);assert.deepEqual(f.readKV(legacy.resultRef),legacy.invalid);db.exec('DROP TRIGGER refuse_derived_recovery');const view=await f.call('reading.get',{activityId:legacy.a.id});assert.equal(view.results[0].summary,'Original fenced observation');assert.equal(f.state.models.length,0);
 }finally{db.exec('DROP TRIGGER IF EXISTS refuse_derived_recovery');db.close();}
});

for(const [name,wrap]of [['raw',text=>text],['plain fence',text=>'```\n'+text+'\n```'],['upper JSON fence',text=>' \r\n```JSON\r\n'+text+'\r\n``` ']])test('the actual plugin accepts a complete '+name+' response',async t=>{
 const f=await fixture(t);f.state.modelTextWrap=wrap;const a=await f.call('now',{characterId:'deepseek',visual:true}),plan=await f.call('reading.get',{activityId:a.id}),result=await f.call('reading.confirm',{activityId:a.id,confirmed:true,planHash:plan.planHash});assert.equal(result.state,'completed');assert.equal(f.state.models.length,1);
});

for(const [name,wrap]of [['leading prose',text=>'Here is the JSON:\n'+text],['trailing prose',text=>text+'\nDone.'],['array',text=>'['+text+']'],['multiple fences',text=>'```json\n'+text+'\n```\n```json\n'+text+'\n```'],['malformed fence',text=>'```json\n'+text],['wrong tag',text=>'```javascript\n'+text+'\n```'],['invalid schema',text=>JSON.stringify({...JSON.parse(text),shareWorthy:'false'})],['incomplete material',text=>JSON.stringify({...JSON.parse(text),completedMaterial:false})],['foreign evidence',text=>JSON.stringify({...JSON.parse(text),evidenceRefs:['foreign-sheet']})]])test('the actual plugin retains '+name+' as known invalid and never replays it',async t=>{
 const f=await fixture(t);f.state.modelTextWrap=wrap;const a=await f.call('now',{characterId:'deepseek',visual:true}),plan=await f.call('reading.get',{activityId:a.id}),result=await f.call('reading.confirm',{activityId:a.id,confirmed:true,planHash:plan.planHash});assert.equal(result.state,'paused');assert.equal(result.lastFailureCode,'BILI_FULL_MATERIAL_NOT_COMPLETED');const record=f.readKV('reading-full-v1:'+a.id);assert.equal(Object.keys(record.results).length,0);assert.equal(Object.keys(record.invalidReceipts).length,1);assert.equal(f.state.models.length,1);await assert.rejects(f.call('reading.continue',{activityId:a.id}),{code:'BILI_FULL_MATERIAL_NOT_COMPLETED'});assert.equal(f.state.models.length,1);
});

test('verified fenced recovery preserves a newer explicit user pause and its failure history',async t=>{
 const f=await fixture(t),legacy=await seedLegacyFenced(f);await f.call('reading.pause',{activityId:legacy.a.id});const view=await f.call('reading.get',{activityId:legacy.a.id}),activity=f.readKV('full-activity-v206:'+legacy.a.id);assert.equal(view.phase,'paused');assert.equal(view.pauseReason,'pause');assert.equal(activity.pauseReason,'pause');assert.equal(currentReadingReason(view),'BILI_FULL_PAUSED');assert.ok(activity.failureHistory.some(entry=>entry.code==='BILI_FULL_MATERIAL_NOT_COMPLETED'&&entry.pauseReason==='pause'));assert.equal(f.state.models.length,0);
});
