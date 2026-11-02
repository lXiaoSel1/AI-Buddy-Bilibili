import test from 'node:test';
import assert from 'node:assert/strict';
import {mountPage,ok,refuse} from '../../../test/page-harness.mjs';
import {createBilibiliApp} from '../src/client/index.mjs';

function fixture(t,lang){
 t.mock.timers.enable({apis:['setTimeout','setInterval']});
 const record={id:'async-reading',characterId:'deepseek',visual:true,readingMode:'full-v1',state:'paused',statusRevision:1,lastFailureCode:null,pauseReason:'BILI_FULL_PLAN_CONFIRMATION_REQUIRED',startedAt:Date.now(),video:{videoId:'BV12345678',title:'Synthetic retained reading'}};
 const reading={readingMode:'full-v1',readingId:record.id,activityRevision:1,readingRevision:1,confirmed:false,phase:'awaiting-confirmation',planHash:'original-plan',config:{sampleSeconds:1,windowSeconds:12},parts:[{cid:123,page:1,duration:24,title:'P1'}],availableParts:[{cid:123,page:1,duration:24,title:'P1'}],model:{label:'Synthetic'},progress:{completed:0,total:4},calls:[],sheets:[],sheetRef:'synthetic-sheet',modelReason:null,needsReview:false,estimatedCalls:4};
 let release;const page=mountPage(t,createBilibiliApp,async action=>{
  if(action==='readiness')return ok({mode:'runtime'});
  if(action==='settings.read')return ok({accountId:'10001',settings:{autonomousEnabled:false,maxConcurrent:1,dailyWatchLimit:5,dailyCommentLimit:0,commentMode:'off',commentConsent:false,shareMode:'record-only',resumeMode:'manual',connectionRef:'account',modelConnectionRef:'model',startMinute:0,endMinute:1440,defaultCharacterId:'deepseek'},characters:[{id:'deepseek',name:'DeepSeek'}],connections:[{id:'account',name:'Account',kind:'bilibili'},{id:'model',name:'Synthetic',kind:'model'}],todayAllowed:true,timeZone:'UTC'});
  if(action==='reading.pending.list'||action==='schedule.list')return ok([]);
  if(action==='history.list')return ok([record]);if(action==='quota.read')return ok({day:'2026-11-01',rows:[],limits:{watch:5,comment:0}});
  if(action==='reading.image')return ok({dataUrl:'data:image/png;base64,aGVsbG8='});if(action==='now')return ok(record);if(action==='reading.get')return ok(reading);
  if(action==='reading.confirm'){reading.confirmed=true;reading.phase='reading';reading.readingRevision++;return new Promise(done=>{release=()=>done(ok({...record,state:'understanding',pauseReason:null}));});}
  return refuse('UNEXPECTED_'+action);
 },{lang});
 t.after(()=>release?.());
 const poll=async()=>{t.mock.timers.tick(2500);await page.settle();};
 return {page,record,reading,poll};
}
const banner=page=>{const value=page.all(n=>n.props['data-bili-watch-feedback']===true)[0];assert.ok(value);return page.textOf(value);};
for(const lang of ['zh-CN','en']){
 const en=lang==='en';
 async function begin(f){await f.page.settle();await f.page.click(en?'Watch now':'现在看');await f.page.click(en?'History':'观看记录');await f.page.click(en?'View storyboard':'查看分镜');await f.page.click(en?'Confirm the complete plan and start':'确认整份计划并开始');await f.poll();}
 test(lang+': confirmed live reading clears an older paused history banner before the control request completes',async t=>{
  const f=fixture(t,lang);await begin(f);assert.equal(f.reading.phase,'reading');assert.ok(!banner(f.page).includes('BILI_FULL_PLAN_CONFIRMATION_REQUIRED'));assert.ok(!banner(f.page).includes(en?'Paused':'已暂停'));
 });
 test(lang+': a newer genuine reading failure remains visible after clearing the old confirmation reason',async t=>{
  const f=fixture(t,lang);await begin(f);Object.assign(f.reading,{phase:'failed',readingRevision:3,modelReason:'BUDDY_CONTEXT_EXPIRED',needsReview:true});await f.poll();assert.ok(banner(f.page).includes('BUDDY_CONTEXT_EXPIRED'));assert.ok(!banner(f.page).includes('BILI_FULL_PLAN_CONFIRMATION_REQUIRED'));assert.ok(banner(f.page).includes(en?'needs review':'待核对'));
 });
}
