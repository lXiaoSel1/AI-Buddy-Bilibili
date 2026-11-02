import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createBilibiliService} from '../src/service.mjs';
import {createManagedBilibiliPlatform} from '../src/platform.mjs';

const dataRoot=process.env.AI_BUDDY_PLUGIN_TEST_ROOT??fileURLToPath(new URL('../../../test-data/',import.meta.url));
mkdirSync(dataRoot,{recursive:true});
const owner={contextToken:'owner-token'};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(options={}){
  const directory=mkdtempSync(join(dataRoot,'bili-')),databasePath=join(directory,'plugin.sqlite');
  const state={at:Date.parse('2026-10-25T17:00:00Z'),sleeping:false,life:'life-1',operation:'operation-1',generation:1,selects:0,materials:0,models:0,sends:0,offers:[],events:new Map(),calls:[],blockExperience:false,blockOffer:false,invalidLease:false,leases:new Map(),...options};
  const catalog=()=>state.managedConnections??[{ref:'managed-bilibili',label:'测试B站连接',platform:'bilibili'},{ref:'managed-model',label:'测试活动模型',platform:'model',provider:state.provider}];
  const host={async invoke(method,payload,opts={}){
    state.calls.push({method,payload});
    if(method==='social.context.read'){
      if(payload.purpose==='plugin-background')return {accountId:'account-1',managedConnections:catalog(),permissions:payload.principal?.contextToken==='background-token'?['plugin.activity']:[]};
      if(payload.purpose==='manage-plugin')return payload.principal?.contextToken==='owner-token'?{accountId:'account-1',permissions:['plugin.manage'],sourceMode:'proposal-mock',availableCharacters:state.availableCharacters??[{id:'alpha',label:'甲角色'},{id:'beta',label:'乙角色'}],managedConnections:catalog()}:{accountId:'account-1',permissions:[]};
      return {contextToken:`context:${payload.characterId}:${state.life}`,accountId:'account-1',characterId:payload.characterId,personaId:'persona-1',lifeId:state.life,operationId:state.operation,generation:state.generation,sleeping:state.sleeping,appCurrentCharacterId:'app-character',sourceMode:'proposal-mock'};
    }
    if(method==='activity.lease'&&state.failLease)throw Object.assign(Error('lease refused'),{code:'BUDDY_LEASE_DENIED'});if(method==='activity.lease'){/* like the social host: an ended activity id is never leased again */const lease=state.leases.get(payload.activityId);if(lease==='ended')throw Object.assign(Error('Activity already ended or belongs to another scope'),{code:'BUDDY_SOCIAL_DENIED'});state.leases.set(payload.activityId,'active');return {leaseId:`lease:${payload.activityId}`,generation:state.generation,expiresAt:state.at+300000};}
    if(method==='activity.check')return {valid:!state.invalidLease,characterId:payload.characterId,lifeId:payload.lifeId,operationId:payload.operationId,generation:payload.generation};
    if(method==='activity.finish'){/* like the social host: only a terminal status ends the lease */if(!['completed','failed','cancelled','unknown'].includes(payload.status))throw Object.assign(Error('Invalid activity terminal state'),{code:'BUDDY_SOCIAL_DENIED'});state.leases.set(payload.activityId,'ended');return {ok:true};}if(method==='ui.bubble')return {ok:true};
    if(method==='models.request'){
      state.models++;
      if(state.modelHook)return state.modelHook(payload,opts);
      if(payload.purpose==='bilibili-comment')return {requestId:`mock-request-${state.models}`,text:JSON.stringify({text:'这段对海洋的介绍很有意思。',evidenceRefs:['subtitle:1']})};
      return {requestId:`mock-request-${state.models}`,usageAccounting:'core-model-router',text:JSON.stringify({summary:'关于海洋的材料摘要',notes:'只基于实际取得的字幕。',evidenceRefs:state.badRefs?['not-read']:['subtitle:1'],completedMaterial:true,shareWorthy:state.shareWorthy===true,commentWorthy:state.commentWorthy===true,shareText:'刚看了一段海洋介绍。',interestTags:['海洋']})};
    }
    if(method==='experience.append'){
      if(state.blockExperience||!payload.contextToken.endsWith(state.life))throw Object.assign(Error('old context unavailable'),{code:'BUDDY_CONTEXT_EXPIRED'});
      if(!state.events.has(payload.idempotencyKey))state.events.set(payload.idempotencyKey,payload);
      return {recorded:true,eventId:payload.eventId};
    }
    if(method==='proactive.offer'){state.offers.push(payload);if(state.blockOffer)throw Object.assign(Error('not yet'),{code:'PROACTIVE_TEMPORARY'});return {accepted:true};}
    throw Object.assign(Error(`unsupported ${method}`),{code:'BUDDY_METHOD_UNKNOWN'});
  }};
  const platform={async selectVideo(){state.selects++;return {videoId:'BVtest123',title:'海洋介绍',author:'fixture',url:'https://www.bilibili.com/video/BVtest123'};},async acquireMaterial(){state.materials++;if(state.materialHook)return state.materialHook();return {videoId:'BVtest123',coverage:state.description?'description':'subtitles',complete:!state.description,items:[{id:'subtitle:1',text:'海洋覆盖了地球大部分表面。'}],sourceRefs:['fixture:subtitle']};},async sendComment(input){state.sends++;state.lastText=input?.text;if(state.sendHook)return state.sendHook();return state.unknownSend?{status:'unknown'}:{status:'sent',platformId:'platform-1'};}};
  let service=createBilibiliService({databasePath,host,platform,now:()=>state.at,timeZone:'America/New_York'});
  const call=(action,payload={},principal=owner)=>service.dispatch(action,payload,principal);
  return {state,host,platform,databasePath,call,get service(){return service;},async configure(settings={}){return call('settings.update',{connectionRef:'managed-bilibili',modelConnectionRef:'managed-model',...settings});},async reopen(){await service.close();service=createBilibiliService({databasePath,host,platform,now:()=>state.at,timeZone:'America/New_York'});return service;},async close(){await service.close();}};
}

async function cachedWithoutHostProof(f){
  await f.configure({modelConnectionRef:null});
  const first=await f.call('now',{characterId:'alpha'});
  assert.equal(first.lastFailureCode,'BILI_MODEL_REQUIRED');
  assert.equal(f.state.materials,1);assert.equal(f.state.models,0);
  await f.configure();
}
const mockUnderstanding=()=>({requestId:'actual-model-once',text:JSON.stringify({summary:'Read after host proof',notes:'Verified material',evidenceRefs:['subtitle:1'],completedMaterial:true})});
test('cached material acquired before model selection is refetched once after definitive host proof rejection',async()=>{
  const f=fixture();try{
    await cachedWithoutHostProof(f);await f.reopen();let providerCalls=0;
    f.state.modelHook=()=>{if(f.state.materials===1)throw Object.assign(Error('Missing host observation'),{code:'SOCIAL_UNOBSERVED_MATERIAL'});providerCalls++;return mockUnderstanding();};
    const result=await f.call('now',{characterId:'alpha'});
    assert.equal(result.state,'completed');assert.equal(f.state.materials,2);assert.equal(f.state.models,2);assert.equal(providerCalls,1);
    const calls=f.state.calls.filter(v=>v.method==='models.request');assert.equal(calls[0].payload.activityId,calls[1].payload.activityId);
  }finally{await f.close();}
});
test('a repeated material proof rejection is bounded and marked as not submitted',async()=>{
  const f=fixture();try{await cachedWithoutHostProof(f);f.state.modelHook=()=>{throw Object.assign(Error('Unobserved'),{code:'SOCIAL_UNOBSERVED_MATERIAL'});};
    const r=await f.call('now',{characterId:'alpha'});assert.equal(r.lastFailureCode,'SOCIAL_UNOBSERVED_MATERIAL');assert.equal(f.state.models,2);assert.equal(f.state.materials,2);assert.equal(r.needsReview,false);
  }finally{await f.close();}
});
test('fresh material proof failures do not trigger redundant acquisition',async()=>{
  const f=fixture();try{await f.configure();f.state.modelHook=()=>{throw Object.assign(Error('Unobserved'),{code:'SOCIAL_UNOBSERVED_MATERIAL'});};
    const r=await f.call('now',{characterId:'alpha'});assert.equal(r.state,'failed');assert.equal(f.state.models,1);assert.equal(f.state.materials,1);assert.equal(r.needsReview,false);
  }finally{await f.close();}
});
for(const code of ['SOCIAL_MODEL_RESULT_UNKNOWN','R95_CONNECTION_CHANGED','HTTP_401','ABORT_ERR'])test('cached material does not replay model after '+code,async()=>{
  const f=fixture();try{await cachedWithoutHostProof(f);f.state.modelHook=()=>{throw Object.assign(Error(code),{code});};
    const r=await f.call('now',{characterId:'alpha'});assert.equal(r.state,code==='SOCIAL_MODEL_RESULT_UNKNOWN'?'paused':'failed');assert.equal(r.lastFailureCode,code);assert.equal(r.modelState,'started');assert.equal(r.needsReview,true);assert.equal(f.state.materials,1);assert.equal(f.state.models,1);
    if(code==='SOCIAL_MODEL_RESULT_UNKNOWN'){
      assert.equal(r.pauseReason,code);for(const reopen of [false,true]){if(reopen)await f.reopen();const resumed=await f.call('continue');assert.equal(resumed.resumed,false);assert.equal(resumed.reason,'uncertain-model-not-retried');assert.equal(resumed.activityId,r.id);assert.equal(f.state.materials,1);assert.equal(f.state.models,1);}
    }
  }finally{await f.close();}
});
test('scope invalidation during proof refresh prevents a second model dispatch',async()=>{
  const f=fixture();try{await cachedWithoutHostProof(f);f.state.modelHook=()=>{throw Object.assign(Error('Unobserved'),{code:'SOCIAL_UNOBSERVED_MATERIAL'});};
    f.state.materialHook=()=>{f.state.invalidLease=true;return {coverage:'subtitles',complete:true,items:[{id:'subtitle:1',text:'Fresh host material'}]};};
    const r=await f.call('now',{characterId:'alpha'});assert.equal(r.state,'failed');assert.equal(f.state.materials,2);assert.equal(f.state.models,1);assert.equal(r.needsReview,false);
  }finally{await f.close();}
});

test('B01 defaults are inert, private reads require verified host management, no principal/token leaks',async()=>{
  const f=fixture();try{
    assert.equal((await f.call('settings.read')).settings.autonomousEnabled,false);
    assert.equal((await f.call('tick')).reason,'autonomous-disabled');
    assert.equal(f.state.selects,0);
    await assert.rejects(f.call('settings.read',{},null),{code:'BILI_OWNER_REQUIRED'});
    await assert.rejects(f.call('history.list',{}, {contextToken:'forged',permissions:['plugin.manage'],accountId:'account-1'}),{code:'BILI_OWNER_REQUIRED'});
    await assert.rejects(f.call('settings.update',{tokenBudget:100000}),{code:'BILI_SETTINGS_INVALID'});
    await assert.rejects(f.call('now',{characterId:'bili-character'}),{code:'BILI_CONNECTION_REQUIRED'});
    assert(!JSON.stringify(f.service.status()).includes('account-1'));
  }finally{await f.close();}
});

test('B02 actual material references and independent model understanding; cached material does not grant another character experience',async()=>{
  const f=fixture();try{
    await f.configure({maxConcurrent:2});
    const a=await f.call('now',{characterId:'alpha'}),b=await f.call('now',{characterId:'beta'});
    assert.equal(a.state,'completed');assert.equal(b.state,'completed');assert.equal(f.state.materials,1);assert.equal(f.state.models,2);assert.equal(f.state.events.size,2);
    assert.equal(a.characterId,'alpha');assert.equal(b.characterId,'beta');assert.equal(a.sourceMode,'proposal-mock');
    assert(!JSON.stringify(a).includes('context:'));
    const before=f.state.models;await f.call('history.list');await f.call('activity.read',{id:a.id});await f.call('outbox.flush');assert.equal(f.state.models,before);assert.equal(f.state.events.size,2);
    await f.reopen();await f.call('outbox.flush');assert.equal(f.state.events.size,2);
    assert.equal((await f.call('quota.read')).rows.find(v=>v.kind==='watch'&&v.status==='committed').count,2);
  }finally{await f.close();}
});

test('B02 description-only and fabricated evidence cannot become completed viewing',async()=>{
  const f=fixture({description:true});try{await f.configure();const a=await f.call('now',{characterId:'alpha'});assert.equal(a.state,'partial');assert.equal(a.effective,false);assert.equal((await f.call('quota.read')).rows.length,0);assert.equal([...f.state.events.values()][0].status,'partial');}finally{await f.close();}
  const g=fixture({badRefs:true});try{await g.configure();const a=await g.call('now',{characterId:'alpha'});assert.equal(a.state,'failed');assert.equal(a.lastFailureCode,'BILI_EVIDENCE_INVALID');assert.equal((await g.call('quota.read')).rows.length,0);}finally{await g.close();}
});

test('B03 simultaneous last watch quota is atomically reserved; opening a second live database instance is denied',async()=>{
  const f=fixture(),started=deferred(),release=deferred();try{
    await f.configure({maxConcurrent:2,dailyWatchLimit:1});
    f.state.modelHook=async()=>{started.resolve();await release.promise;return {requestId:'mock-last-quota',text:JSON.stringify({summary:'海洋',notes:'字幕',evidenceRefs:['subtitle:1'],completedMaterial:true})};};
    const first=f.call('now',{characterId:'alpha'});await started.promise;
    await assert.rejects(f.call('now',{characterId:'beta'}),{code:'BILI_QUOTA_EXHAUSTED'});
    assert.throws(()=>createBilibiliService({databasePath:f.databasePath,host:f.host,platform:f.platform,now:()=>f.state.at}),{code:'BILI_DATA_BUSY'});
    release.resolve();assert.equal((await first).state,'completed');assert.equal(f.state.models,1);
  }finally{release.resolve();await f.close();}
});

test('B04 returning user pauses after the current result; idle resumes materials without repeating model call or schedule count',async()=>{
  const f=fixture(),started=deferred(),release=deferred();try{
    await f.configure({autonomousEnabled:true});await f.call('schedule.create',{participants:['alpha'],count:1});
    f.state.modelHook=async()=>{started.resolve();await release.promise;return {requestId:'mock-user-return',text:JSON.stringify({summary:'海洋',notes:'字幕',evidenceRefs:['subtitle:1'],completedMaterial:true})};};
    const first=f.call('tick');await started.promise;await f.call('user.return');release.resolve();assert.equal((await first).state,'paused');
    assert.equal((await f.call('tick')).reason,'user-chat-active');
    const resumed=await f.call('idle');assert.equal(resumed.state,'completed');assert.equal(resumed.experienceId,`@ai-buddy/bilibili-companion:${resumed.id}:experience`);assert.equal(f.state.models,1);assert.equal(f.state.materials,1);
    assert.equal((await f.call('schedule.list'))[0].remaining,0);assert.equal((await f.call('tick')).reason,'no-eligible-schedule');
  }finally{release.resolve();await f.close();}
});

test('B04 explicit pause persists through restart; explicit stop and today denial prevent idle restart',async()=>{
  const f=fixture();try{
    await f.configure({autonomousEnabled:true});await f.call('schedule.create',{participants:['alpha'],count:1});await f.call('pause');await f.reopen();
    assert.equal((await f.call('tick')).reason,'BILI_PAUSED');assert.equal(f.state.selects,0);
    await f.call('stop');assert.equal((await f.call('idle')).reason,'BILI_STOPPED');assert.equal(f.state.selects,0);
    await f.call('today.allow',{allowed:false});await assert.rejects(f.call('now',{characterId:'alpha'}),{code:'BILI_TODAY_FORBIDDEN'});assert.equal(f.state.selects,0);
  }finally{await f.close();}
});

test('B05 sleeping appointment offers dream once without video/understanding/quota; expiry and midnight do not carry authorization',async()=>{
  const f=fixture({sleeping:true});try{
    await f.configure({autonomousEnabled:true});await f.call('schedule.create',{participants:['alpha'],count:1,startMinute:720,endMinute:840});
    assert.equal((await f.call('tick')).state,'waiting-sleep');assert.equal((await f.call('tick')).state,'waiting-sleep');assert.equal(f.state.offers.length,1);assert.equal(f.state.offers[0].kind,'dream-expectation');assert.equal(f.state.selects,0);assert.equal(f.state.models,0);assert.equal((await f.call('quota.read')).rows.length,0);
    f.state.sleeping=false;f.state.at=Date.parse('2026-10-25T19:00:00Z');assert.equal((await f.call('tick')).reason,'no-eligible-schedule');assert.equal(f.state.selects,0);
    f.state.at=Date.parse('2026-10-26T17:00:00Z');await f.call('tick');assert.equal((await f.call('schedule.list'))[0].expired,true);assert.equal(f.state.selects,0);
  }finally{await f.close();}
});

test('B05 waking within the original window performs one true viewing after new lease verification',async()=>{
  const f=fixture({sleeping:true});try{await f.configure({autonomousEnabled:true});await f.call('schedule.create',{participants:['alpha'],count:1});await f.call('tick');f.state.sleeping=false;assert.equal((await f.call('tick')).state,'completed');assert.equal(f.state.models,1);assert.equal(f.state.selects,1);}finally{await f.close();}
});

test('B06 record-only suppresses all shares; pending shares cannot be offered after stop/today denial or invalid lease',async()=>{
  const f=fixture({shareWorthy:true});try{await f.configure({shareMode:'record-only'});await f.call('now',{characterId:'alpha'});assert.equal(f.state.offers.length,0);}finally{await f.close();}
  for(const stopAction of ['stop','today.allow']){
    const g=fixture({shareWorthy:true,blockOffer:true});try{await g.configure();await g.call('now',{characterId:'alpha'});assert.equal(g.state.offers.length,1);await g.call(stopAction,stopAction==='today.allow'?{allowed:false}:{});g.state.blockOffer=false;await g.call('outbox.flush');assert.equal(g.state.offers.length,1);assert.equal(g.state.events.size,1);}finally{await g.close();}
  }
  const h=fixture({shareWorthy:true,blockOffer:true});try{await h.configure();await h.call('now',{characterId:'alpha'});h.state.blockOffer=false;h.state.invalidLease=true;await h.call('outbox.flush');assert.equal(h.state.offers.length,1);}finally{await h.close();}
});

test('B07 comment off cannot send; unknown send survives restart and is never blindly repeated',async()=>{
  const f=fixture({unknownSend:true});try{
    await f.configure();const a=await f.call('now',{characterId:'alpha'});await assert.rejects(f.call('comment.send',{activityId:a.id}),{code:'BILI_COMMENTS_OFF'});assert.equal(f.state.sends,0);
    await f.call('settings.update',{commentMode:'managed',commentConsent:true});const receipt=await f.call('comment.send',{activityId:a.id});assert.equal(receipt.state,'unknown');assert.equal(f.state.sends,1);
    await f.reopen();assert.equal((await f.call('comment.send',{activityId:a.id})).state,'unknown');assert.equal(f.state.sends,1);
    assert.equal((await f.call('quota.read')).rows.find(v=>v.kind==='comment').status,'unknown');
  }finally{await f.close();}
});

test('B07 duplicate concurrent comment request cannot overwrite a sent receipt; final comment allowance is shared',async()=>{
  const f=fixture(),started=deferred(),release=deferred();try{
    await f.configure({commentMode:'managed',commentConsent:true,dailyCommentLimit:1});const a=await f.call('now',{characterId:'alpha'}),b=await f.call('now',{characterId:'beta'});
    f.state.sendHook=async()=>{started.resolve();await release.promise;return {status:'sent',platformId:'exact-platform-id'};};
    const first=f.call('comment.send',{activityId:a.id});await started.promise;const duplicate=await f.call('comment.send',{activityId:a.id});assert.equal(duplicate.state,'sending');
    await assert.rejects(f.call('comment.send',{activityId:b.id}),{code:'BILI_QUOTA_EXHAUSTED'});release.resolve();assert.equal((await first).state,'sent');assert.equal((await f.call('comment.send',{activityId:a.id})).state,'sent');assert.equal(f.state.sends,1);
  }finally{release.resolve();await f.close();}
});

test('C07 revocation before external send does not send and unknown/sent facts remain accurate',async()=>{
  const f=fixture(),started=deferred(),release=deferred();try{
    await f.configure({commentMode:'managed',commentConsent:true});const a=await f.call('now',{characterId:'alpha'});
    f.state.modelHook=async()=>{started.resolve();await release.promise;return {requestId:'comment-r',text:JSON.stringify({text:'海洋介绍很有意思。',evidenceRefs:['subtitle:1']})};};
    const comment=f.call('comment.send',{activityId:a.id});await started.promise;await f.call('today.allow',{allowed:false});release.resolve();assert.equal((await comment).state,'failed');assert.equal(f.state.sends,0);
  }finally{release.resolve();await f.close();}
});

test('C07 durable outbox preserves original life when host context expires; no reattribution or repeated understanding',async()=>{
  const f=fixture({blockExperience:true});try{
    await f.configure();const a=await f.call('now',{characterId:'alpha'});assert.equal(a.state,'recording');assert.equal(f.state.models,1);
    await f.reopen();f.state.blockExperience=false;f.state.life='life-2';await f.call('outbox.flush');const old=await f.call('activity.read',{id:a.id});assert.equal(old.lifeId,'life-1');assert.equal(old.state,'recording');assert.equal(f.state.events.size,0);assert.equal(f.state.models,1);
    const attempted=f.state.calls.filter(v=>v.method==='experience.append');assert(attempted.every(v=>v.payload.lifeId==='life-1'));
  }finally{await f.close();}
});

test('managed adapter accepts only supplied transport and distinguishes actual material and platform send receipts',async()=>{
  const calls=[],platform=createManagedBilibiliPlatform({request:async request=>{calls.push(request);if(request.operation==='video.info')return {bvid:'BVadapter',title:'fixture'};if(request.operation==='video.material')return {coverage:'description',complete:true,items:[{id:'description',text:'简介'}]};return {status:'sent'};}});
  const context={characterId:'alpha'},video=await platform.selectVideo({connectionRef:'ref',context,videoId:'BVadapter'});assert.equal(video.videoId,'BVadapter');const material=await platform.acquireMaterial({connectionRef:'ref',context,video});assert.equal(material.complete,false);assert.equal((await platform.sendComment({connectionRef:'ref',video,text:'hello',idempotencyKey:'id'})).status,'unknown');assert.equal(calls.length,3);
});

test('trusted background events require plugin.activity and cannot reuse owner UI token as a background permission',async()=>{
  const f=fixture();try{
    await f.configure({autonomousEnabled:true});await f.call('schedule.create',{participants:['alpha'],count:1});
    await assert.rejects(f.service.onHostEvent({type:'tick',principal:owner}),{code:'BILI_BACKGROUND_DENIED'});
    await assert.rejects(f.service.onHostEvent({type:'tick',principal:{contextToken:'forged',permissions:['plugin.activity']}}),{code:'BILI_BACKGROUND_DENIED'});
    const principal={contextToken:'background-token'};
    assert.equal((await f.service.onHostEvent({type:'user.return',principal})).paused,true);assert.equal((await f.service.onHostEvent({type:'tick',principal})).reason,'user-chat-active');
    assert.equal((await f.service.onHostEvent({type:'idle',principal})).state,'completed');assert.equal(f.state.models,1);
    await assert.rejects(f.call('history.list',{},principal),{code:'BILI_OWNER_REQUIRED'});
    await f.service.onHostEvent({type:'revoke',principal});assert.equal((await f.service.onHostEvent({type:'tick',principal})).reason,'BILI_STOPPED');
  }finally{await f.close();}
});

test('per-character interest accumulation is gradual, life-bound and cannot transfer cached understanding to another character',async()=>{
  const f=fixture();try{
    await f.configure();await f.call('now',{characterId:'alpha'});const picked=[];f.platform.selectVideo=async({context})=>{picked.push(context.interests);return {videoId:'BVtest123',title:'海洋介绍',url:'https://www.bilibili.com/video/BVtest123'};};
    await f.call('now',{characterId:'alpha'});await f.call('now',{characterId:'beta'});assert(picked[0].some(v=>v.tag==='海洋'&&v.weight<=0.2));assert(!picked[1].some(v=>v.tag==='海洋'));
    f.state.life='life-2';await f.call('now',{characterId:'alpha'});assert(!picked[2].some(v=>v.tag==='海洋'));
  }finally{await f.close();}
});

test('manual continue can execute an explicit appointment while autonomous viewing remains disabled',async()=>{
  const f=fixture();try{await f.configure({autonomousEnabled:false});await f.call('schedule.create',{participants:['alpha'],count:1});assert.equal((await f.call('tick')).reason,'autonomous-disabled');assert.equal((await f.call('continue')).state,'completed');assert.equal((await f.call('settings.read')).settings.autonomousEnabled,false);}finally{await f.close();}
});

test('canonical host catalogs map to UI choices without requiring a second public shape',async()=>{
  const f=fixture();try{const config=await f.call('settings.read');assert.deepEqual(config.characters,[{id:'alpha',name:'甲角色'},{id:'beta',name:'乙角色'}]);assert.deepEqual(config.connections.map(v=>[v.id,v.name,v.kind]),[['managed-bilibili','测试B站连接','bilibili'],['managed-model','测试活动模型','model']]);}finally{await f.close();}
});

test('managed consent + evidence-linked commentWorthy automatically uses the same comment send path; off and zero quota remain silent',async()=>{
  for(const variant of [{managed:true,limit:3,expected:1},{managed:false,limit:3,expected:0},{managed:true,limit:0,expected:0}]){
    const f=fixture({commentWorthy:true});try{await f.configure({commentMode:variant.managed?'managed':'off',commentConsent:variant.managed,dailyCommentLimit:variant.limit});const a=await f.call('now',{characterId:'alpha'});assert.equal(a.state,'completed');assert.equal(f.state.sends,variant.expected);const history=await f.call('history.list');assert.equal(history[0].comments.length,variant.expected);if(variant.expected){assert.equal(history[0].comments[0].state,'sent');assert.equal(history[0].comments[0].platformId,'platform-1');assert.equal((await f.call('comment.send',{activityId:a.id})).state,'sent');assert.equal(f.state.sends,1);}}finally{await f.close();}
  }
});

test('public comment generation uses A-owned prompt/schema and only material, never private understanding notes',async()=>{
  const f=fixture();try{
    await f.configure({commentMode:'managed',commentConsent:true});
    f.state.modelHook=async payload=>payload.purpose==='bilibili-comment'?{requestId:'public-request',text:JSON.stringify({text:'海洋介绍有趣。',evidenceRefs:['subtitle:1']})}:{requestId:'watch-request',text:JSON.stringify({summary:'海洋材料',notes:'PRIVATE_NOTE_SENTINEL',evidenceRefs:['subtitle:1'],completedMaterial:true,commentWorthy:true})};
    await f.call('now',{characterId:'alpha'});const call=f.state.calls.find(v=>v.method==='models.request'&&v.payload.purpose==='bilibili-comment').payload;
    assert.equal(call.channel,'bilibili-public');assert.equal(call.visibilityScope,'public');assert.equal(call.contextMode,'material-only');assert.equal(call.includePrivateMemory,false);assert(call.messages[0].content.includes('generate-public-video-comment'));assert(call.responseSchema.properties.evidenceRefs);assert(!JSON.stringify(call).includes('PRIVATE_NOTE_SENTINEL'));assert.equal(f.state.sends,1);
    const understanding=f.state.calls.find(v=>v.method==='models.request'&&v.payload.purpose==='bilibili-understanding').payload;assert(understanding.responseSchema.properties.commentWorthy);assert(understanding.messages[0].content.includes('allowedEvidenceIds'));
  }finally{await f.close();}
});

test('verified DeepSeek provider prefers current official offpeak only within the authorized window; manual now does not wait',async()=>{
  const f=fixture({provider:'deepseek',at:Date.parse('2026-10-26T06:30:00Z')});try{
    await f.configure({autonomousEnabled:true});await f.call('schedule.create',{participants:['alpha'],count:1});const delayed=await f.call('tick');assert.equal(delayed.state,'deferred');assert.equal(delayed.resumeAt,Date.parse('2026-10-26T10:00:00Z'));assert.equal(f.state.models,0);assert.equal(f.state.selects,0);
    const s=(await f.call('schedule.list'))[0];assert.equal(s.remaining,1);assert.equal(s.pricingPreference.policy.source,'https://api-docs.deepseek.com/quick_start/pricing/');
    assert.equal((await f.call('now',{characterId:'beta'})).state,'completed');assert.equal(f.state.models,1);f.state.at=Date.parse('2026-10-26T10:00:00Z');assert.equal((await f.call('tick')).state,'completed');assert.equal(f.state.models,2);
  }finally{await f.close();}
});

test('lifecycle.revoke is the canonical background stop event',async()=>{
  const f=fixture();try{await f.configure({autonomousEnabled:true});await f.call('schedule.create',{participants:['alpha'],count:1});assert.equal((await f.service.onHostEvent({type:'lifecycle.revoke',principal:{contextToken:'background-token'}})).revoked,true);assert.equal((await f.call('tick')).reason,'BILI_STOPPED');assert.equal(f.state.models,0);}finally{await f.close();}
});

test('normalized sent results with malformed platformId remain unknown and keep the external-send reservation',async()=>{
  for(const platformId of [{},[],true,42,'',' ','bad\u0000id','x'.repeat(301)]){
    const f=fixture();try{await f.configure({commentMode:'managed',commentConsent:true});const a=await f.call('now',{characterId:'alpha'});f.state.sendHook=async()=>({status:'sent',platformId});const receipt=await f.call('comment.send',{activityId:a.id});assert.equal(receipt.state,'unknown',`Invalid platformId: ${String(platformId)}`);assert.equal(Object.hasOwn(receipt,'platformId'),false);assert.equal((await f.call('quota.read')).rows.find(v=>v.kind==='comment').status,'unknown');assert.equal((await f.call('comment.send',{activityId:a.id})).state,'unknown');assert.equal(f.state.sends,1);}finally{await f.close();}
  }
});

test('default HTTP host adapter keeps AbortSignal only in invoke options and preserves the complete serializable activity scope',async()=>{
  const f=fixture(),seen=[];let service;try{
    await f.configure();await f.close();
    const host={async invoke(method,payload,options){
      if(method!=='connections.request')return f.host.invoke(method,payload,options);
      seen.push({payload,options});const path=new URL(payload.url).pathname;
      if(path==='/x/web-interface/view')return {status:200,json:{code:0,data:{bvid:'BVadapter123',aid:1,cid:2,title:'fixture',desc:'public description',owner:{name:'fixture'},duration:30,pages:[{cid:2,page:1,part:'fixture',duration:30}]}}};
      if(path==='/x/web-interface/nav')return {status:200,json:{code:0,data:{wbi_img:{img_url:'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',sub_url:'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'}}}};
      if(path==='/x/player/wbi/v2')return {status:200,json:{code:0,data:{subtitle:{subtitles:[]}}}};
      throw Error('Unexpected test-only URL');
    }};
    f.state.modelHook=async()=>({requestId:'adapter-model',usageAccounting:'core-model-router',text:JSON.stringify({summary:'简介',notes:'只有简介',evidenceRefs:['description:1'],completedMaterial:false})});
    service=createBilibiliService({databasePath:f.databasePath,host,now:()=>f.state.at,timeZone:'America/New_York'});
    const result=await service.dispatch('now',{characterId:'alpha',videoId:'BVadapter123'},owner);assert.equal(result.state,'partial');assert.equal(result.lastFailureCode??null,null);assert.equal(result.material.coverage,'description');assert.equal(result.material.complete,false);assert.equal(result.providerRequestId,'adapter-model');assert.equal(f.state.models,1);assert.equal(seen.length,3);
    for(const {payload,options} of seen){assert.equal(Object.hasOwn(payload,'signal'),false);assert(options.signal instanceof AbortSignal);for(const key of ['contextToken','leaseId','generation','characterId','lifeId','operationId','accountId'])assert.notEqual(payload[key],undefined);assert.doesNotThrow(()=>JSON.stringify(payload));}
  }finally{await service?.close();await f.close();}
});

test('E3 preview: a draft is written but not posted, holds the allowance, and posts the edited text once',async()=>{
  const f=fixture();try{
    await f.configure({commentMode:'managed',commentConsent:true,commentReview:'preview',dailyCommentLimit:1});
    const a=await f.call('now',{characterId:'alpha'}),b=await f.call('now',{characterId:'beta'});
    await assert.rejects(f.call('comment.send',{activityId:a.id}),{code:'BILI_COMMENT_PREVIEW_REQUIRED'});assert.equal(f.state.sends,0);
    const draft=await f.call('comment.draft',{activityId:a.id});assert.equal(draft.state,'draft');assert.equal(draft.text,'这段对海洋的介绍很有意思。');assert.equal(f.state.sends,0);
    assert.equal((await f.call('quota.read')).rows.find(v=>v.kind==='comment').status,'reserved');
    await assert.rejects(f.call('comment.draft',{activityId:b.id}),{code:'BILI_QUOTA_EXHAUSTED'});
    await assert.rejects(f.call('comment.post',{activityId:a.id,text:'   '}),{code:'BILI_COMMENT_INVALID'});
    const sent=await f.call('comment.post',{activityId:a.id,text:'改过的评论：海洋那段很好。'});
    assert.equal(sent.state,'sent');assert.equal(sent.edited,true);assert.equal(f.state.lastText,'改过的评论：海洋那段很好。');assert.equal(f.state.sends,1);
    assert.equal((await f.call('comment.post',{activityId:a.id})).state,'sent');assert.equal(f.state.sends,1);
    assert.equal((await f.call('quota.read')).rows.find(v=>v.kind==='comment').status,'committed');
  }finally{await f.close();}
});

test('E3 preview: drafts survive a restart; discard releases the allowance and keeps the record; a refused lease gives the draft back',async()=>{
  const f=fixture();try{
    await f.configure({commentMode:'managed',commentConsent:true,commentReview:'preview',dailyCommentLimit:1});
    const a=await f.call('now',{characterId:'alpha'}),b=await f.call('now',{characterId:'beta'});await f.call('comment.draft',{activityId:a.id});
    await f.reopen();
    assert.equal((await f.call('comments.list')).find(v=>v.activityId===a.id).state,'draft');
    assert.equal((await f.call('quota.read')).rows.find(v=>v.kind==='comment').status,'reserved');
    assert.equal((await f.call('comment.discard',{activityId:a.id})).state,'discarded');assert.equal((await f.call('comment.discard',{activityId:a.id})).state,'discarded');
    assert.equal((await f.call('quota.read')).rows.some(v=>v.kind==='comment'),false);
    assert.equal((await f.call('comments.list')).find(v=>v.activityId===a.id).state,'discarded');
    // a discarded draft is not written again
    assert.equal((await f.call('comment.draft',{activityId:a.id})).state,'discarded');
    await f.call('comment.draft',{activityId:b.id});f.state.failLease=true;
    await assert.rejects(f.call('comment.post',{activityId:b.id,text:'没发出去的改写'}),{code:'BUDDY_LEASE_DENIED'});
    // the draft keeps the model's text; the unsent edit is not kept
    assert.equal((await f.call('comments.list')).find(v=>v.activityId===b.id).text,'这段对海洋的介绍很有意思。');
    assert.equal((await f.call('comments.list')).find(v=>v.activityId===b.id).state,'draft');assert.equal(f.state.sends,0);
    f.state.failLease=false;assert.equal((await f.call('comment.post',{activityId:b.id})).state,'sent');assert.equal(f.state.sends,1);
  }finally{await f.close();}
});

test('E3 preview: her own comment after watching becomes a draft; direct mode still posts as before',async()=>{
  for(const review of ['preview','direct']){
    const f=fixture({commentWorthy:true});try{
      await f.configure({commentMode:'managed',commentConsent:true,commentReview:review});const a=await f.call('now',{characterId:'alpha'});
      const comment=(await f.call('comments.list')).find(v=>v.activityId===a.id);
      assert.equal(comment.state,review==='preview'?'draft':'sent',review);assert.equal(f.state.sends,review==='preview'?0:1,review);
    }finally{await f.close();}
  }
  await assert.rejects((async()=>{const f=fixture();try{await f.configure({commentReview:'sometimes'});}finally{await f.close();}})(),{code:'BILI_SETTINGS_INVALID'});
});

test('E3 preview: a post cut off mid-send is kept as unknown with the text that was actually sent',async()=>{
  const f=fixture(),started=deferred(),release=deferred();let second;try{
    await f.configure({commentMode:'managed',commentConsent:true,commentReview:'preview'});
    const a=await f.call('now',{characterId:'alpha'});await f.call('comment.draft',{activityId:a.id});
    f.state.sendHook=async()=>{started.resolve();await release.promise;return {status:'sent',platformId:'239874123'};};
    void f.call('comment.post',{activityId:a.id,text:'用户改写后发出的评论'}).catch(()=>{});await started.promise;
    // a second instance that finds no live owner is what a restart after a crash sees
    second=createBilibiliService({databasePath:f.databasePath,host:f.host,platform:f.platform,now:()=>f.state.at,timeZone:'America/New_York',runtimeOwnerInspector:()=>null});
    const row=(await second.dispatch('comments.list',{},{contextToken:'owner-token'})).find(v=>v.activityId===a.id);
    assert.equal(row.state,'unknown');assert.equal(row.text,'用户改写后发出的评论');assert.equal(row.draftText,'这段对海洋的介绍很有意思。');assert.equal(row.postText,undefined);
  }finally{release.resolve();await second?.close().catch(()=>{});await f.close();}
});

test('a direct comment ends its lease with a status the host accepts',async()=>{
  const f=fixture();try{
    await f.configure({commentMode:'managed',commentConsent:true});const a=await f.call('now',{characterId:'alpha'});
    assert.equal((await f.call('comment.send',{activityId:a.id})).state,'sent');
    assert.equal(f.state.leases.get(a.id+':comment'),'ended');
  }finally{await f.close();}
});
