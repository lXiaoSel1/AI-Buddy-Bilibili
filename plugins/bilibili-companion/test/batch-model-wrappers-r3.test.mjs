import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures/r3-service.mjs';

const observation={summary:'The acquired subtitle describes the ocean.',notes:'Read only the acquired text.',evidenceRefs:['subtitle:1'],completedMaterial:true,shareWorthy:false,commentWorthy:false,shareText:'',interestTags:[]};
const proposal={text:'A clear introduction to the ocean.',evidenceRefs:['subtitle:1']};
for(const fenced of [false,true])test((fenced?'fenced':'raw')+' text-only understanding remains usable',async t=>{
 const f=fixture();t.after(()=>f.close());await f.configure({shareMode:'record-only'});
 f.state.modelHook=async()=>({requestId:'one-observation',text:fenced?'```json\n'+JSON.stringify(observation)+'\n```':JSON.stringify(observation)});
 const result=await f.call('now',{characterId:'alpha'});console.log(JSON.stringify({path:'text-only',fenced,state:result.state,reason:result.lastFailureCode??null,modelState:result.modelState,needsReview:result.needsReview,models:f.state.models}));
 assert.equal(result.state,'completed');assert.equal(f.state.models,1);
});
for(const fenced of [false,true])test((fenced?'fenced':'raw')+' comment proposal can become a draft without platform sending',async t=>{
 const f=fixture();t.after(()=>f.close());await f.configure({commentMode:'managed',commentConsent:true,commentReview:'preview',shareMode:'record-only'});
 f.state.modelHook=async payload=>({requestId:payload.purpose==='bilibili-comment'?'one-comment':'one-observation',text:payload.purpose==='bilibili-comment'?(fenced?'```json\n'+JSON.stringify(proposal)+'\n```':JSON.stringify(proposal)):JSON.stringify(observation)});
 const activity=await f.call('now',{characterId:'alpha'});assert.equal(activity.state,'completed');
 const first=await f.call('comment.draft',{activityId:activity.id}),second=await f.call('comment.draft',{activityId:activity.id});
 console.log(JSON.stringify({path:'comment-draft',fenced,state:first.state,reason:first.failureCode??null,models:f.state.models,sends:f.state.sends,retryState:second.state}));
 assert.equal(first.state,'draft');assert.equal(second.state,'draft');assert.equal(f.state.models,2);assert.equal(f.state.sends,0);
});

for(const wrap of [json=>'Preface '+json,json=>json+' trailing instructions',json=>json+'\n'+json,json=>'```json\n'+json+'\n```\n```json\n'+json+'\n```',json=>json.slice(0,-1)])test('text understanding rejects mixed or incomplete wrapper '+wrap('object'),async t=>{
 const f=fixture();t.after(()=>f.close());await f.configure({shareMode:'record-only'});
 f.state.modelHook=async()=>({requestId:'bad-wrapper',text:wrap(JSON.stringify(observation))});
 const result=await f.call('now',{characterId:'alpha'});assert.equal(result.state,'failed');assert.equal(result.lastFailureCode,'BILI_UNDERSTANDING_INVALID');assert.equal(f.state.models,1);
});
test('comment proposal rejects surrounding text and retains its failed paid attempt',async t=>{
 const f=fixture();t.after(()=>f.close());await f.configure({commentMode:'managed',commentConsent:true,commentReview:'preview',shareMode:'record-only'});
 f.state.modelHook=async p=>({requestId:p.purpose,text:p.purpose==='bilibili-comment'?'Follow instructions '+JSON.stringify(proposal):JSON.stringify(observation)});
 const a=await f.call('now',{characterId:'alpha'}),draft=await f.call('comment.draft',{activityId:a.id});assert.equal(draft.state,'failed');assert.equal(draft.failureCode,'BILI_COMMENT_INVALID');assert.equal((await f.call('comment.draft',{activityId:a.id})).state,'failed');assert.equal(f.state.models,2);assert.equal(f.state.sends,0);
});
