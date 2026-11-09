import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createBilibiliService} from '../src/service.mjs';
import {normalizeMaterial} from '../src/platform.mjs';

const root=process.env.AI_BUDDY_PLUGIN_TEST_ROOT??fileURLToPath(new URL('../../../test-data/',import.meta.url));mkdirSync(root,{recursive:true});
const owner={contextToken:'owner'},deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {resolve,promise};};
function fixture(){
  const databasePath=join(mkdtempSync(join(root,'bili-bugs-')),'private.sqlite');
  const state={at:Date.parse('2026-10-25T17:00:00Z'),models:0,materialCalls:0,offers:[],events:new Map(),calls:[],checks:0,selects:0,sends:0};
  const host={async invoke(method,payload,options={}){
    state.calls.push({method,payload});
    if(method==='social.context.read'){
      if(payload.purpose==='manage-plugin'){if(state.manageHook)await state.manageHook(payload);return {contextToken:'manage',accountId:'account',permissions:['plugin.manage'],managedConnections:[]};}
      if(payload.purpose==='plugin-background')return {contextToken:'background',accountId:'account',permissions:['plugin.activity']};
      if(state.contextHook)await state.contextHook(payload);
      return {connectionRef:payload.modelConnectionRef??'model',contextToken:'social',accountId:'account',characterId:payload.characterId,personaId:'persona',lifeId:state.life??'life',operationId:'operation',generation:1,sleeping:false};
    }
    if(method==='activity.lease')return {leaseId:'lease:'+payload.activityId,generation:1};
    if(method==='activity.check'){state.checks++;if(state.checkHook)await state.checkHook(payload,state.checks);return {valid:true,characterId:payload.characterId,lifeId:payload.lifeId,operationId:payload.operationId,generation:payload.generation};}
    if(method==='ui.bubble'){if(state.bubbleHook)await state.bubbleHook(payload);return {ok:true};}
    if(method==='activity.finish')return {ok:true};
    if(method==='models.request'){
      state.models++;if(state.modelHook)await state.modelHook(payload,options);
      return {requestId:`model-${state.models}`,usageAccounting:'core-model-router',text:JSON.stringify(payload.purpose==='bilibili-comment'?{text:'海洋内容很有意思。',evidenceRefs:['s1']}:{summary:'海洋材料',notes:'公开材料笔记',evidenceRefs:['s1'],completedMaterial:true,shareWorthy:state.shareWorthy===true})};
    }
    if(method==='experience.append'){if(state.experienceHook)await state.experienceHook(payload);state.events.set(payload.idempotencyKey,payload);return {recorded:true,eventId:payload.eventId};}
    if(method==='proactive.offer'){state.offers.push(payload);if(state.offerHook)await state.offerHook(payload);return {accepted:true};}
    throw Object.assign(Error('unsupported'),{code:'UNSUPPORTED'});
  }};
  const platform={async selectVideo(){state.selects++;return {videoId:'BVbugs123',aid:123,cid:456,title:'海洋',url:'https://www.bilibili.com/video/BVbugs123'};},async acquireMaterial(){state.materialCalls++;if(state.materialHook)await state.materialHook();return {videoId:'BVbugs123',coverage:state.description?'description':'subtitles',complete:!state.description,items:[{id:'s1',text:'海洋材料'}],sourceRefs:['fixture:public']};},async sendComment(){state.sends++;if(state.sendHook)await state.sendHook();return {status:'sent',platformId:'platform-comment-id'};}};
  const options={databasePath,host,platform,now:()=>state.at,timeZone:'America/New_York'};let service=createBilibiliService(options);const call=(a,p={})=>service.dispatch(a,p,owner);
  return {get service(){return service;},state,databasePath,call,configure:p=>call('settings.update',{connectionRef:'bilibili',modelConnectionRef:'model',...p}),query(sql,...args){const db=new DatabaseSync(databasePath,{readOnly:true});try{return db.prepare(sql).all(...args);}finally{db.close();}},mutate(fn){const db=new DatabaseSync(databasePath);try{return fn(db);}finally{db.close();}},async reopen(){await service.close();service=createBilibiliService(options);},close:()=>service.close()};
}

test('BUG-MIDNIGHT: an admitted model completion after midnight is factual and charged to the original day',async()=>{
  const f=fixture(),started=deferred(),release=deferred();let pending;try{
    f.state.at=Date.parse('2026-10-26T03:59:00Z');await f.configure();f.state.modelHook=async()=>{started.resolve();await release.promise;};pending=f.call('now',{characterId:'alpha'});await started.promise;f.state.at=Date.parse('2026-10-26T04:01:00Z');release.resolve();const result=await pending;
    assert.equal(result.state,'completed');assert.equal(result.day,'2026-10-25');const rows=f.query('SELECT day,status FROM bili_reservations WHERE kind=?','watch');assert.equal(rows[0].status,'committed');assert.equal(rows[0].day,'2026-10-25');assert.equal((await f.call('quota.read')).rows.length,0);assert.equal(f.state.models,1);
  }finally{release.resolve();await Promise.allSettled([pending].filter(Boolean));await f.close();}
});

test('BUG-CACHE: description fallback is not a permanent substitute for later available subtitles',async()=>{
  const f=fixture();try{await f.configure();f.state.description=true;assert.equal((await f.call('now',{characterId:'alpha'})).state,'partial');f.state.description=false;const second=await f.call('now',{characterId:'beta'});assert.equal(second.state,'completed');assert.equal(f.state.materialCalls,2);}finally{await f.close();}
});

test('BUG-MATERIAL: invalid rows and duplicate evidence IDs cannot be silently discarded while retaining complete=true',()=>{
  const video={videoId:'BVbugs123'};
  assert.throws(()=>normalizeMaterial({complete:true,coverage:'subtitles',items:[{id:'s1',text:'valid'},{id:'missing-content'}]},video),{code:'BILI_MATERIAL_INVALID'});
  assert.throws(()=>normalizeMaterial({complete:true,coverage:'subtitles',items:[{id:'s1',text:'one'},{id:'s1',text:'different'}]},video),{code:'BILI_MATERIAL_INVALID'});
});

test('BUG-TRUNCATION: technical text truncation cannot retain a claim of complete material',()=>{
  const material=normalizeMaterial({complete:true,coverage:'subtitles',items:[{id:'s1',text:'x'.repeat(30001)}]},{videoId:'BVbugs123'});assert.equal(material.complete,false);assert.match(material.coverageNotes,/截断/);
});

test('BUG-RESUME: concurrent continue requests claim one paused activity once and cannot decrement a schedule twice',async()=>{
  const f=fixture(),materialStarted=deferred(),materialRelease=deferred(),contextsStarted=deferred(),contextsRelease=deferred();let first,resumes=[];try{
    await f.configure({autonomousEnabled:true,maxConcurrent:2});await f.call('schedule.create',{participants:['alpha'],count:1});f.state.materialHook=async()=>{materialStarted.resolve();await materialRelease.promise;};first=f.call('tick');await materialStarted.promise;await f.call('user.return');materialRelease.resolve();assert.equal((await first).state,'paused');
    let contexts=0;f.state.contextHook=async()=>{if(++contexts===2)contextsStarted.resolve();await contextsRelease.promise;};resumes=[f.call('continue'),f.call('continue')];await contextsStarted.promise;contextsRelease.resolve();await Promise.all(resumes);
    assert.equal(f.state.models,1);assert.equal((await f.call('schedule.list'))[0].remaining,0);
  }finally{materialRelease.resolve();contextsRelease.resolve();await Promise.allSettled([first,...resumes].filter(Boolean));await f.close();}
});

test('BUG-STOP-AUTH: a now request awaiting authorization before stop cannot later clear that stop',async()=>{
  const f=fixture(),started=deferred(),release=deferred();let pending;try{
    await f.configure();let first=true;f.state.manageHook=async()=>{if(first){first=false;started.resolve();await release.promise;}};pending=f.call('now',{characterId:'alpha'});await started.promise;await f.call('stop');release.resolve();const result=await Promise.allSettled([pending]);assert.equal(f.state.models,0);assert.equal(result[0].status,'rejected');assert.equal(result[0].reason.code,'BILI_CONTROL_STALE');assert.equal((await f.call('settings.read')).stopped,true);
  }finally{release.resolve();await Promise.allSettled([pending].filter(Boolean));await f.close();}
});

test('BUG-RETURN-CONTEXT: returning user wins over an older now request still waiting for its character context',async()=>{
  const f=fixture(),started=deferred(),release=deferred();let pending;try{
    await f.configure();f.state.contextHook=async()=>{started.resolve();await release.promise;};pending=f.call('now',{characterId:'alpha'});await started.promise;await f.call('user.return');release.resolve();await Promise.allSettled([pending]);assert.equal(f.state.models,0);assert.equal(f.state.selects,0);
  }finally{release.resolve();await Promise.allSettled([pending].filter(Boolean));await f.close();}
});

test('BUG-SETTINGS-AWAIT: changing the model during a host guard cannot start a new request under an old lease',async()=>{
  const f=fixture(),started=deferred(),release=deferred();let pending;try{
    await f.configure();f.state.checkHook=async(_p,n)=>{if(n===3){started.resolve();await release.promise;}};pending=f.call('now',{characterId:'alpha'});await started.promise;await f.call('settings.update',{connectionRef:'different-account'});release.resolve();await pending;assert.equal(f.state.models,0);
  }finally{release.resolve();await Promise.allSettled([pending].filter(Boolean));await f.close();}
});

test('BUG-SHARE-AWAIT: user return while a durable pending share checks its lease prevents that offer',async()=>{
  const f=fixture(),started=deferred(),release=deferred();let flushing;try{
    await f.configure();f.state.shareWorthy=true;f.state.offerHook=()=>{throw Object.assign(Error('temporary'),{code:'TEMPORARY'});};await f.call('now',{characterId:'alpha'});assert.equal(f.state.offers.length,1);f.state.offerHook=null;f.state.checkHook=async()=>{started.resolve();await release.promise;};flushing=f.call('outbox.flush');await started.promise;await f.call('user.return');release.resolve();await flushing;assert.equal(f.state.offers.length,1);
  }finally{release.resolve();await Promise.allSettled([flushing].filter(Boolean));await f.close();}
});

test('BUG-COMMENT-EVIDENCE: actual public comment fact uses the comment model request, public scope and posted text',async()=>{
  const f=fixture();try{
    await f.configure({commentMode:'managed',commentConsent:true});const activity=await f.call('now',{characterId:'alpha'});await f.call('comment.send',{activityId:activity.id});await f.call('outbox.flush');const event=[...f.state.events.values()].find(v=>v.sourceKind==='bilibili-comment');assert.equal(event.channel,'bilibili-public');assert.equal(event.visibilityScope,'public');assert.equal(event.providerRequestId,'model-2');assert.equal(event.text,'海洋内容很有意思。');assert.equal(event.deliveryState,'sent');
  }finally{await f.close();}
});

test('BUG-CLOSE-OUTBOX: close drains an independently requested outbox flush before closing SQLite',async()=>{
  const f=fixture(),started=deferred(),release=deferred();let flushing,closing;try{
    await f.configure();f.state.experienceHook=()=>{throw Object.assign(Error('temporary'),{code:'TEMPORARY'});};await f.call('now',{characterId:'alpha'});f.state.experienceHook=async()=>{started.resolve();await release.promise;};flushing=f.call('outbox.flush');flushing.catch(()=>{});await started.promise;let finished=false;closing=f.close().then(()=>{finished=true;});await new Promise(r=>setImmediate(r));assert.equal(finished,false);release.resolve();assert.equal((await flushing).pending,0);await closing;
  }finally{release.resolve();await Promise.allSettled([flushing,closing].filter(Boolean));await f.close();}
});

test('BUG-RESTART-UNKNOWN: an old schedule cannot create a replacement for a recovered unknown model request',async()=>{
  const f=fixture();try{
    await f.configure({autonomousEnabled:true});await f.call('schedule.create',{participants:['alpha'],count:1});const activity=await f.call('tick');await f.close();
    f.mutate(db=>{const a=JSON.parse(db.prepare('SELECT data FROM bili_activities WHERE id=?').get(activity.id).data);a.state='understanding';a.modelState='started';delete a.understanding;delete a.providerRequestId;a.effective=false;db.prepare("UPDATE bili_activities SET state='understanding',data=? WHERE id=?").run(JSON.stringify(a),a.id);const s=JSON.parse(db.prepare('SELECT data FROM bili_schedules WHERE id=?').get(a.scheduleId).data);s.state='running';s.remaining=1;db.prepare("UPDATE bili_schedules SET state='running',data=? WHERE id=?").run(JSON.stringify(s),s.id);db.prepare("UPDATE bili_reservations SET status='reserved' WHERE id=?").run(a.id);});
    await f.reopen();const before=f.state.models,result=await f.call('tick');assert.equal(result.reason,'uncertain-model-not-retried');assert.equal(f.state.models,before);assert.equal((await f.call('history.list')).length,1);
  }finally{await f.close();}
});

test('BUG-RESUME-PARENT: another tick cannot start a new activity while its paused predecessor resumes',async()=>{
  const f=fixture(),materialStarted=deferred(),materialRelease=deferred(),modelStarted=deferred(),modelRelease=deferred();let initial,resuming,third;try{
    await f.configure({autonomousEnabled:true,maxConcurrent:2});await f.call('schedule.create',{participants:['alpha'],count:1});f.state.materialHook=async()=>{materialStarted.resolve();await materialRelease.promise;};initial=f.call('tick');await materialStarted.promise;await f.call('user.return');materialRelease.resolve();await initial;
    let first=true;f.state.modelHook=async()=>{if(first){first=false;modelStarted.resolve();await modelRelease.promise;}};resuming=f.call('continue');await modelStarted.promise;third=f.call('tick');const result=await third;assert.equal(result.reason,'no-eligible-schedule');assert.equal(f.state.models,1);modelRelease.resolve();await resuming;assert.equal((await f.call('schedule.list'))[0].remaining,0);
  }finally{materialRelease.resolve();modelRelease.resolve();await Promise.allSettled([initial,resuming,third].filter(Boolean));await f.close();}
});

test('BUG-OLD-LIFE: an old paused life cannot permanently block a newly authorized schedule',async()=>{
  const f=fixture(),started=deferred(),release=deferred();let initial;try{
    await f.configure({autonomousEnabled:true});await f.call('schedule.create',{participants:['alpha'],count:1});f.state.materialHook=async()=>{started.resolve();await release.promise;};initial=f.call('tick');await started.promise;await f.call('user.return');release.resolve();await initial;f.state.life='new-life';await f.call('idle');await f.call('schedule.create',{participants:['beta'],count:1});const result=await f.call('tick');assert.equal(result.characterId,'beta');assert.equal(result.state,'completed');
  }finally{release.resolve();await Promise.allSettled([initial].filter(Boolean));await f.close();}
});

test('BUG-PENDING-MEMORY: waiting for a durable host experience receipt does not keep a finished video concurrency slot',async()=>{
  const f=fixture();try{await f.configure({maxConcurrent:1});f.state.experienceHook=()=>{throw Object.assign(Error('temporary'),{code:'TEMPORARY'});};assert.equal((await f.call('now',{characterId:'alpha'})).state,'recording');assert.equal((await f.call('now',{characterId:'beta'})).state,'recording');assert.equal(f.state.models,2);}finally{await f.close();}
});

test('BUG-EXPIRED-PAUSE: yesterday paused authorization cannot block a new-day schedule',async()=>{
  const f=fixture(),started=deferred(),release=deferred();let initial;try{
    await f.configure({autonomousEnabled:true});await f.call('schedule.create',{participants:['alpha'],count:1});f.state.materialHook=async()=>{started.resolve();await release.promise;};initial=f.call('tick');await started.promise;await f.call('user.return');release.resolve();await initial;f.state.at=Date.parse('2026-10-26T17:00:00Z');await f.call('schedule.create',{participants:['beta'],count:1});const result=await f.call('idle');assert.equal(result.state,'completed');assert.equal(result.characterId,'beta');
  }finally{release.resolve();await Promise.allSettled([initial].filter(Boolean));await f.close();}
});

test('BUG-OUTBOX-CANONICAL: retry after an unknown host acknowledgement keeps the exact event payload and idempotency identity',async()=>{
  const f=fixture();try{
    await f.configure();let recorded=null;f.state.experienceHook=payload=>{if(!recorded){recorded=JSON.stringify(payload);throw Object.assign(Error('ack lost after commit'),{code:'TRANSPORT_TIMEOUT'});}assert.equal(JSON.stringify(payload),recorded,'Local failure diagnostics must not mutate an already committed event payload');};
    assert.equal((await f.call('now',{characterId:'alpha'})).state,'recording');assert.equal((await f.call('outbox.flush')).pending,0);assert.equal(f.state.events.size,1);
  }finally{await f.close();}
});

test('BUG-PREPARED-MODEL: interruption during the understanding bubble is not an unknown model request',async()=>{
  const f=fixture(),started=deferred(),release=deferred();let pending;try{
    await f.configure();f.state.bubbleHook=async payload=>{if(payload.stage==='understanding'){started.resolve();await release.promise;}};pending=f.call('now',{characterId:'alpha'});await started.promise;await f.call('user.return');release.resolve();const paused=await pending;assert.equal(paused.state,'paused');assert.equal(paused.needsReview,false);assert.equal(f.state.models,0);f.state.bubbleHook=null;assert.equal((await f.call('continue')).state,'completed');assert.equal(f.state.models,1);
  }finally{release.resolve();await Promise.allSettled([pending].filter(Boolean));await f.close();}
});

test('BUG-LATE-PUBLIC-RECEIPT: stop and midnight do not erase an already accepted public send receipt',async()=>{
  const f=fixture(),started=deferred(),release=deferred();let posting;try{
    f.state.at=Date.parse('2026-10-26T03:59:00Z');await f.configure({commentMode:'managed',commentConsent:true});const a=await f.call('now',{characterId:'alpha'});f.state.sendHook=async()=>{started.resolve();await release.promise;};posting=f.call('comment.send',{activityId:a.id});await started.promise;await f.call('stop');f.state.at=Date.parse('2026-10-26T04:01:00Z');release.resolve();const receipt=await posting;assert.equal(receipt.state,'sent');assert.equal(receipt.platformId,'platform-comment-id');assert.equal(f.query("SELECT day,status FROM bili_reservations WHERE kind='comment'")[0].day,'2026-10-25');assert.equal(f.query("SELECT day,status FROM bili_reservations WHERE kind='comment'")[0].status,'committed');
  }finally{release.resolve();await Promise.allSettled([posting].filter(Boolean));await f.close();}
});

test('BUG-STOP-PAUSED: a new explicit now cannot revive a previously stopped paused activity',async()=>{
  const f=fixture(),started=deferred(),release=deferred();let initial;try{
    await f.configure({autonomousEnabled:true});await f.call('schedule.create',{participants:['alpha'],count:1});f.state.materialHook=async()=>{started.resolve();await release.promise;};initial=f.call('tick');await started.promise;await f.call('user.return');release.resolve();const paused=await initial;assert.equal(paused.state,'paused');await f.call('stop');await f.call('now',{characterId:'beta'});const result=await f.call('idle');assert.equal(result.reason,'no-eligible-schedule');assert.equal(f.state.models,1);assert.equal((await f.call('activity.read',{id:paused.id})).state,'cancelled');
  }finally{release.resolve();await Promise.allSettled([initial].filter(Boolean));await f.close();}
});
