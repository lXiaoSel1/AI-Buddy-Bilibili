import test from 'node:test';
import assert from 'node:assert/strict';
import {mountPage,ok,refuse} from '../../../test/page-harness.mjs';
import {createBilibiliApp} from '../src/client/index.mjs';

const image='data:image/png;base64,aGVsbG8=';
function fixture(t,{lang='zh-CN',readImage=()=>ok({dataUrl:image}),control=()=>ok({paused:true})}={}){
 t.mock.timers.enable({apis:['setTimeout','setInterval']});
 const record={id:'consistent-reading',characterId:'deepseek',visual:true,readingMode:'full-v1',state:'paused',statusRevision:1,pauseReason:'OLD_PAUSE',startedAt:Date.now(),video:{videoId:'BV12345678',title:'Retained reading'}};
 const state={readingMode:'full-v1',activityId:record.id,activityRevision:2,readingRevision:2,confirmed:true,phase:'reading',planHash:'original',config:{sampleSeconds:1,windowSeconds:12},parts:[{cid:123,page:1}],calls:[],sheets:[],sheetRef:'same-sheet',modelReason:null,pauseReason:null,progress:{completed:1,total:4}};
 const reads={hold:false,pending:[],fail:false,records:null},account={id:'10001',connectionRef:'account'};
 const page=mountPage(t,createBilibiliApp,async(action,payload)=>{
  if(action==='readiness')return ok({mode:'runtime'});
  if(action==='settings.read')return ok({accountId:account.id,settings:{autonomousEnabled:false,maxConcurrent:1,dailyWatchLimit:5,dailyCommentLimit:0,commentMode:'off',commentConsent:false,shareMode:'record-only',resumeMode:'manual',connectionRef:account.connectionRef,modelConnectionRef:'model',startMinute:0,endMinute:1440,defaultCharacterId:'deepseek'},characters:[{id:'deepseek',name:'DeepSeek'}],connections:[{id:account.connectionRef,name:'Account',kind:'bilibili'},{id:'model',name:'Synthetic',kind:'model'}],todayAllowed:true,timeZone:'UTC'});
  if(action==='reading.pending.list'||action==='schedule.list')return ok([]);
  if(action==='history.list')return ok(reads.records??[record]);
  if(action==='quota.read')return ok({day:'2026-11-01',rows:[],limits:{watch:5,comment:0}});
  if(action==='reading.get'){if(reads.fail)return refuse('STATUS_READ_FAILED');const snapshot=structuredClone(state);if(reads.hold)return new Promise(resolve=>reads.pending.push(()=>resolve(ok(snapshot))));return ok(snapshot);}
  if(action==='reading.image')return readImage(payload);
  if(['reading.pause','reading.stop','reading.continue','reading.confirm'].includes(action))return control(action,payload);
  return refuse('UNEXPECTED_'+action);
 },{lang});
 t.after(()=>{for(const release of reads.pending)release();});
 const poll=async(ms=2500)=>{t.mock.timers.tick(ms);await page.settle();};
 const open=async()=>{await page.settle();await page.click(lang==='en'?'History':'观看记录');await page.click(lang==='en'?'View storyboard':'查看分镜');};
 return {page,record,state,reads,account,poll,open};
}
for(const lang of ['zh-CN','en']){
 const en=lang==='en';
 test(lang+': slow reading polling has one request in flight and accepts its completed response',async t=>{
  const f=fixture(t,{lang});await f.open();f.reads.hold=true;Object.assign(f.state,{phase:'completed',readingRevision:3,progress:{completed:4,total:4}});await f.poll();const count=f.page.count('reading.get');assert.equal(f.reads.pending.length,1);
  await f.poll(10000);assert.equal(f.page.count('reading.get'),count,'a slow response must not be superseded by timer requests');f.reads.hold=false;f.reads.pending.shift()();await f.page.settle();assert.ok(f.page.text().includes(en?'Reading completed':'阅读完成'));
 });
 test(lang+': a lower reading revision cannot regress the detail or the history row',async t=>{
  const f=fixture(t,{lang});Object.assign(f.state,{phase:'completed',activityRevision:3,readingRevision:5,progress:{completed:4,total:4}});await f.open();Object.assign(f.state,{phase:'paused',activityRevision:2,readingRevision:9,pauseReason:'OLD_PAUSE'});await f.poll();assert.ok(f.page.text().includes(en?'Reading completed':'阅读完成'));await f.page.click(en?'Back to schedule':'返回观看安排');await f.page.click(en?'History':'观看记录');const row=f.page.all(n=>n.type==='article')[0];assert.ok(!f.page.textOf(row).includes(en?'Paused':'已暂停'));await f.page.click(en?'View storyboard':'查看分镜');assert.ok(f.page.text().includes(en?'Reading completed':'阅读完成'));
 });
 test(lang+': returning from a completed detail refreshes the history notes and completion state',async t=>{
  const f=fixture(t,{lang});await f.open();Object.assign(f.record,{state:'completed',statusRevision:4,pauseReason:null,understanding:{summary:'FRESH_FINISHED_SUMMARY',notes:'FRESH_FINISHED_NOTES'}});Object.assign(f.state,{phase:'completed',activityRevision:4,readingRevision:4,progress:{completed:4,total:4}});await f.poll();await f.page.click(en?'Back to schedule':'返回观看安排');await f.page.click(en?'History':'观看记录');assert.ok(f.page.text().includes('FRESH_FINISHED_SUMMARY'));assert.ok(!f.page.textOf(f.page.all(n=>n.type==='article')[0]).includes(en?'Paused':'已暂停'));
 });
 test(lang+': confirm finishing after Back refreshes history without any completed detail snapshot',async t=>{
  let finish;const f=fixture(t,{lang,control:()=>new Promise(resolve=>{finish=()=>{Object.assign(f.record,{state:'completed',statusRevision:4,pauseReason:null,understanding:{summary:'CONFIRM_FINISHED_AFTER_BACK',notes:'LATE_CONFIRM_NOTES'}});resolve(ok({id:f.record.id,readingMode:'full-v1',state:'completed'}));};})});t.after(()=>finish?.());Object.assign(f.state,{confirmed:false,phase:'awaiting-confirmation'});f.record.pauseReason='BILI_FULL_PLAN_CONFIRMATION_REQUIRED';await f.open();await f.page.click(en?'Confirm the complete plan and start':'确认整份计划并开始');assert.equal(f.page.count('reading.confirm'),1);
  await f.page.click(en?'Back to schedule':'返回观看安排');await f.page.click(en?'History':'观看记录');const historyReads=f.page.count('history.list'),detailReads=f.page.count('reading.get');assert.ok(!f.page.text().includes('CONFIRM_FINISHED_AFTER_BACK'));finish();await f.page.settle();assert.ok(f.page.count('history.list')>historyReads,'the settled same-account operation invalidates list data even after leaving its detail');assert.equal(f.page.count('reading.get'),detailReads,'a late confirmation must not reopen or refresh the abandoned detail');assert.ok(f.page.text().includes('CONFIRM_FINISHED_AFTER_BACK'));assert.ok(!f.page.textOf(f.page.all(n=>n.type==='article')[0]).includes(en?'Paused':'已暂停'));assert.equal(f.state.phase,'awaiting-confirmation','no completed detail snapshot was available');
 });
 test(lang+': a confirm finishing after an account change cannot refresh or apply the former account',async t=>{
  let finish;const f=fixture(t,{lang,control:()=>new Promise(resolve=>{finish=()=>resolve(ok({id:f.record.id,readingMode:'full-v1',state:'completed'}));})});t.after(()=>finish?.());Object.assign(f.state,{confirmed:false,phase:'awaiting-confirmation'});await f.open();await f.page.click(en?'Confirm the complete plan and start':'确认整份计划并开始');await f.page.click(en?'Back to schedule':'返回观看安排');f.account.id='20002';f.account.connectionRef='second-account';f.reads.records=[{...f.record,id:'other-account-reading',video:{...f.record.video,title:'SECOND_ACCOUNT_HISTORY'}}];await f.page.dispatch('ai-buddy:social-accounts-changed');await f.page.click(en?'History':'观看记录');const historyReads=f.page.count('history.list'),detailReads=f.page.count('reading.get');finish();await f.page.settle();assert.equal(f.page.count('history.list'),historyReads);assert.equal(f.page.count('reading.get'),detailReads);assert.ok(f.page.text().includes('SECOND_ACCOUNT_HISTORY'));assert.ok(!f.page.text().includes('LATE_CONFIRM_NOTES'));
 });
 test(lang+': an older poll cannot overwrite a later pause control',async t=>{
  const f=fixture(t,{lang});await f.open();f.reads.hold=true;await f.poll();assert.equal(f.reads.pending.length,1);f.reads.hold=false;Object.assign(f.state,{phase:'paused',activityRevision:4,readingRevision:4,pauseReason:'pause'});await f.page.click(en?'Pause':'暂停');assert.ok(f.page.text().includes(en?'Reading paused':'阅读已暂停'));f.reads.pending.shift()();await f.page.settle();assert.ok(f.page.text().includes(en?'Reading paused':'阅读已暂停'));
 });
 test(lang+': a new control polls its own operation while the old read and control response are still pending',async t=>{
  let release;const f=fixture(t,{lang,control:()=>new Promise(resolve=>release=()=>resolve(ok({paused:true})))});t.after(()=>release?.());await f.open();f.reads.hold=true;await f.poll();assert.equal(f.reads.pending.length,1);f.reads.hold=false;Object.assign(f.state,{phase:'paused',activityRevision:4,readingRevision:4,pauseReason:'pause'});await f.page.click(en?'Pause':'暂停');assert.ok(f.page.text().includes(en?'Reading paused':'阅读已暂停'));assert.equal(f.reads.pending.length,1,'the old response is still pending');
 });
 test(lang+': a successful status poll does not erase an image failure and image retry fetches the same ref',async t=>{
  let failImage=true;const f=fixture(t,{lang,readImage:()=>failImage?refuse('IMAGE_READ_FAILED'):ok({dataUrl:image})});await f.open();await f.poll();assert.ok(f.page.text().includes('IMAGE_READ_FAILED'));const before=f.page.count('reading.image');failImage=false;await f.page.click(en?'Retry image':'重试图片');assert.equal(f.page.count('reading.image'),before+1);assert.equal(f.page.all(n=>n.type==='img')[0].props.src,image);assert.ok(!f.page.text().includes('IMAGE_READ_FAILED'));
 });
 test(lang+': a browser image error has its own real retry without a reading control',async t=>{
  const f=fixture(t,{lang});await f.open();const img=f.page.all(n=>n.type==='img')[0];assert.equal(typeof img.props.onError,'function');img.props.onError();await f.page.settle();const before=f.page.count('reading.image');await f.page.click(en?'Retry image':'重试图片');assert.equal(f.page.count('reading.image'),before+1);assert.equal(f.page.count('reading.continue'),0);assert.equal(f.page.count('reading.pause'),0);img.props.onError();await f.page.settle();assert.equal(f.page.all(n=>n.type==='img').length,1,'a late decode error belongs only to the previous image generation');assert.ok(!f.page.text().includes('BILI_VISION_IMAGE_DECODE_FAILED'));
 });
 test(lang+': state and control failures have separate messages from the storyboard',async t=>{
  const f=fixture(t,{lang,control:()=>refuse('CONTROL_FAILED')});await f.open();await f.page.click(en?'Pause':'暂停');await f.poll();assert.ok(f.page.text().includes('CONTROL_FAILED'));f.reads.fail=true;await f.poll();assert.ok(f.page.text().includes(en?'The latest reading status could not be read':'暂时读不到最新阅读状态'));assert.ok(f.page.text().includes('STATUS_READ_FAILED'));assert.equal(f.page.all(n=>n.type==='img').length,1);
 });
 test(lang+': a resumed detail does not label an old pause reason as its current state',async t=>{
  const f=fixture(t,{lang});f.state.pauseReason='OLD_PAUSE';await f.open();assert.ok(f.page.text().includes(en?'Reading the frames':'正在阅读画面'));assert.ok(!f.page.text().includes(en?'Reading is paused.':'当前阅读已暂停'));
 });
}
