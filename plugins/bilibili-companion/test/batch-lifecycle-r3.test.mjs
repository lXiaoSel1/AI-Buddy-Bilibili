import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {fixture,gate} from './fixtures/r3-lifecycle.mjs';

test('L01 a stale replan cannot create a replacement after a newer reading.stop',async t=>{
 const f=await fixture(t),a=await f.call('now',{characterId:'alpha',visual:true}),g=f.gateNext('get');
 const pending=f.call('reading.replan',{activityId:a.id,selectedCids:[123],config:{sampleSeconds:.5,windowSeconds:6}}).then(value=>({value}),error=>({error}));
 await g.entered.promise;await f.call('reading.stop',{activityId:a.id});g.release.resolve();
 const result=await pending,history=await f.call('history.list');
 t.diagnostic(JSON.stringify({result:result.error?.code??result.value?.state,history:history.map(x=>({id:x.id,state:x.state})),leases:f.state.leases.length,models:f.state.models.length}));
 assert.equal(history.length,1,'the completed stop must supersede the older pending replan');
 assert.equal(f.state.leases.length,1,'no replacement activity may acquire a lease after stop');
});

test('L02 stale replan cannot overwrite a completed paid reading or release its quota',async t=>{
 const f=await fixture(t),a=await f.call('now',{characterId:'alpha',visual:true}),p=await f.call('reading.get',{activityId:a.id}),g=f.gateNext('get');
 const pending=f.call('reading.replan',{activityId:a.id,selectedCids:[123],config:{sampleSeconds:.5,windowSeconds:6}}).then(value=>({value}),error=>({error}));
 await g.entered.promise;const completed=await f.call('reading.confirm',{activityId:a.id,confirmed:true,planHash:p.planHash});assert.equal(completed.state,'completed');g.release.resolve();
 const result=await pending,after=await f.call('activity.read',{id:a.id}),quota=await f.call('quota.read');
 t.diagnostic(JSON.stringify({result:result.error?.code??result.value?.state,originalState:after.state,hostPhase:f.state.hostRecords.get(a.id).phase,quota:quota.rows,models:f.state.models.length,history:(await f.call('history.list')).length}));
 assert.equal(after.state,'completed','a stale pre-confirmation replan cannot erase a completed paid activity');
 assert.equal(quota.rows.find(x=>x.kind==='watch'&&x.status==='committed')?.count,1,'its committed watch allowance must remain committed');
});

test('L03 storyboard pause after a model reply must retain the known reply and resume without paying again',async t=>{
 const f=await fixture(t,{mode:'visual'}),g=gate();f.state.afterModelCheckGate=g;
 const running=f.call('now',{characterId:'alpha',visual:true});await g.entered.promise;await f.call('user.return');g.release.resolve();
 const paused=await running,checkpoint=f.readKV('reading-v21:'+paused.id);
 t.diagnostic(JSON.stringify({state:paused.state,needsReview:paused.needsReview,pending:checkpoint?.pending,results:Object.keys(checkpoint?.results??{}),models:f.state.models.length}));
 assert.equal(paused.state,'paused');
 assert.equal(checkpoint.pending,null,'the known returned receipt must be persisted before cancellation checks');
 assert.equal(paused.needsReview,false,'a completed known response is not an unknown submission');
 const resumed=await f.call('reading.continue',{activityId:paused.id});assert.equal(resumed.state,'completed');assert.equal(f.state.models.length,3);
});

test('L04 disabling comment permission before public context returns must prevent paid comment generation',async t=>{
 const f=await fixture(t,{mode:'legacy'});await f.call('settings.update',{commentMode:'managed',commentConsent:true});const a=await f.call('now',{characterId:'alpha'}),before=f.state.models.length,g=f.gateNext('bilibili-public-comment');
 const pending=f.call('comment.send',{activityId:a.id}).then(value=>({value}),error=>({error}));await g.entered.promise;await f.call('settings.update',{commentMode:'off',commentConsent:false});g.release.resolve();
 const result=await pending;
 t.diagnostic(JSON.stringify({result:result.error?.code??result.value?.state,modelsBefore:before,modelsAfter:f.state.models.length,sends:f.state.sends.length,comment:result.value}));
 assert.equal(f.state.sends.length,0);assert.equal(f.state.models.length,before,'revocation completed before any comment lease/model began');
});

test('LC normal full two-batch completion uses final summary and settles once',async t=>{
 const f=await fixture(t,{batches:2}),a=await f.call('now',{characterId:'alpha',visual:true}),p=await f.call('reading.get',{activityId:a.id});const result=await f.call('reading.confirm',{activityId:a.id,confirmed:true,planHash:p.planHash});
 assert.equal(result.state,'completed');assert.equal(result.understanding.summary,'Summary batch-2');assert.equal(f.state.models.length,2);assert.equal((await f.call('quota.read')).rows.find(x=>x.kind==='watch'&&x.status==='committed').count,1);
});

test('LC normal storyboard completion validates the fixture',async t=>{
 const f=await fixture(t,{mode:'visual'}),result=await f.call('now',{characterId:'alpha',visual:true});assert.equal(result.state,'completed');assert.equal(f.state.models.length,3);
});

test('B01 a newer stop during the conditional host stop still prevents replacement',async t=>{
 const f=await fixture(t),a=await f.call('now',{characterId:'alpha',visual:true}),g=f.gateNext('stop');
 const pending=f.call('reading.replan',{activityId:a.id,selectedCids:[123],config:{sampleSeconds:1,windowSeconds:6}}).then(value=>({value}),error=>({error}));
 await g.entered.promise;await f.call('reading.stop',{activityId:a.id});g.release.resolve();const result=await pending;assert.equal(result.error.code,'BILI_CONTROL_STALE');assert.equal((await f.call('history.list')).length,1);assert.equal(f.state.leases.length,1);
});
test('B01 a stop while replacement context waits prevents its activity reservation',async t=>{
 const f=await fixture(t),a=await f.call('now',{characterId:'alpha',visual:true}),g=f.gateNext('bilibili-activity');
 const pending=f.call('reading.replan',{activityId:a.id,selectedCids:[123],config:{sampleSeconds:1,windowSeconds:6}}).then(value=>({value}),error=>({error}));
 await g.entered.promise;await f.call('reading.stop',{activityId:a.id});g.release.resolve();const result=await pending;assert.equal(result.error.code,'BILI_CONTROL_STALE');assert.equal((await f.call('history.list')).length,1);assert.equal(f.state.leases.length,1);
});
test('B01 confirmation cannot overtake an already claimed replan host mutation',async t=>{
 const f=await fixture(t),a=await f.call('now',{characterId:'alpha',visual:true}),p=await f.call('reading.get',{activityId:a.id}),g=f.gateNext('stop');
 const pending=f.call('reading.replan',{activityId:a.id,selectedCids:[123],config:{sampleSeconds:1,windowSeconds:6}});await g.entered.promise;
 await assert.rejects(f.call('reading.confirm',{activityId:a.id,confirmed:true,planHash:p.planHash}),{code:'BILI_CONTROL_STALE'});g.release.resolve();const replacement=await pending;assert.notEqual(replacement.id,a.id);assert.equal(f.state.models.length,0);
});
test('B04 revoke and re-enable cannot revive an older pending comment authorization',async t=>{
 const f=await fixture(t,{mode:'legacy'});await f.call('settings.update',{commentMode:'managed',commentConsent:true});const a=await f.call('now',{characterId:'alpha'}),g=f.gateNext('bilibili-public-comment'),paid=f.state.models.length;
 const pending=f.call('comment.draft',{activityId:a.id}).then(value=>({value}),error=>({error}));await g.entered.promise;await f.call('settings.update',{commentMode:'off',commentConsent:false});await f.call('settings.update',{commentMode:'managed',commentConsent:true});g.release.resolve();assert.equal((await pending).error.code,'BILI_CONTROL_STALE');assert.equal(f.state.models.length,paid);assert.equal(f.state.sends.length,0);
});
test('B04 comment permission changes leave unrelated viewing in progress',async t=>{
 const f=await fixture(t,{mode:'legacy'});await f.call('settings.update',{commentMode:'managed',commentConsent:true});const g=f.gateNext('model'),running=f.call('now',{characterId:'alpha'});await g.entered.promise;await f.call('settings.update',{commentMode:'off',commentConsent:false});g.release.resolve();assert.equal((await running).state,'completed');assert.equal(f.state.models.length,1);
});
test('B03 raw receipt survives atomic checkpoint/activity rollback and public get recovers without paying again',async t=>{
 const f=await fixture(t,{mode:'visual'});let injected=false;
 f.state.onModelResult=async payload=>{if(injected)return;injected=true;const db=new DatabaseSync(f.databasePath);try{db.exec("CREATE TRIGGER fail_visual_projection BEFORE UPDATE OF value ON a_plugin_kv WHEN NEW.key='reading-v21:"+payload.activityId+"' AND json_extract(NEW.value,'$.pending') IS NULL BEGIN SELECT RAISE(ABORT,'fixture checkpoint fault'); END");}finally{db.close();}};
 const failed=await f.call('now',{characterId:'alpha',visual:true});assert.equal(failed.state,'failed');assert.equal(failed.needsReview,true);assert.equal(f.readKV('reading-v21:'+failed.id).pending.stepId,'overview');assert.equal(f.readKV('visual-receipt-v207:'+failed.id+':overview').result.requestId,'provider-1');assert.equal(f.state.models.length,1);
 const db=new DatabaseSync(f.databasePath);try{db.exec('DROP TRIGGER fail_visual_projection');}finally{db.close();}
 const recovered=await f.call('reading.get',{activityId:failed.id});assert.equal(recovered.needsReview,false);assert.equal(recovered.phase,'paused');assert.equal(f.readKV('reading-v21:'+failed.id).pending,null);assert.equal((await f.call('activity.read',{id:failed.id})).modelState,'returned');
 const completed=await f.call('reading.continue',{activityId:failed.id});assert.equal(completed.state,'completed');assert.equal(f.state.models.length,3);
});

test('B04 a comment waiting on owner context cannot inherit a newly re-enabled authorization',async t=>{
 const f=await fixture(t,{mode:'legacy'});await f.call('settings.update',{commentMode:'managed',commentConsent:true});const a=await f.call('now',{characterId:'alpha'}),g=f.gateNext('manage-plugin'),paid=f.state.models.length;
 const pending=f.call('comment.draft',{activityId:a.id}).then(value=>({value}),error=>({error}));await g.entered.promise;await f.call('settings.update',{commentMode:'off',commentConsent:false});await f.call('settings.update',{commentMode:'managed',commentConsent:true});g.release.resolve();assert.equal((await pending).error.code,'BILI_CONTROL_STALE');assert.equal(f.state.models.length,paid);assert.equal(f.state.sends.length,0);
});
