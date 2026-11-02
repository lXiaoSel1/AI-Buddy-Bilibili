import test from 'node:test';
import assert from 'node:assert/strict';
import {mountPage,ok,refuse} from '../../../test/page-harness.mjs';
import {createBilibiliApp} from '../src/client/index.mjs';

function fixture(t,{lang='zh-CN',recoverable=true,needsReview=false}={}){
 const record={id:'failed-zero-call',characterId:'deepseek',visual:true,readingMode:'full-v1',state:'failed',lastFailureCode:'BUDDY_SOCIAL_DENIED',pauseReason:null,startedAt:Date.now(),video:{videoId:'BV12345678',title:'Retained plan'}},reading={readingMode:'full-v1',readingId:record.id,confirmed:true,phase:'failed',planHash:'retained-plan',config:{sampleSeconds:.5,windowSeconds:6},parts:[{cid:123,page:1}],model:{label:'Original model'},progress:{completed:0,total:252},calls:[],sheets:[],modelReason:'BUDDY_SOCIAL_DENIED',recoverableZeroCall:recoverable,needsReview};
 const page=mountPage(t,createBilibiliApp,async(action,payload)=>{
  if(action==='readiness')return ok({mode:'runtime'});
  if(action==='settings.read')return ok({accountId:'10001',settings:{autonomousEnabled:false,maxConcurrent:1,dailyWatchLimit:5,dailyCommentLimit:0,commentMode:'off',commentConsent:false,shareMode:'record-only',resumeMode:'manual',connectionRef:'account',modelConnectionRef:'model',startMinute:0,endMinute:1440,defaultCharacterId:'deepseek'},characters:[{id:'deepseek',name:'DeepSeek'}],connections:[{id:'account',name:'Account',kind:'bilibili'},{id:'model',name:'Original model',kind:'model'}],todayAllowed:true,timeZone:'UTC'});
  if(action==='reading.pending.list'||action==='schedule.list')return ok([]);if(action==='history.list')return ok([record]);if(action==='quota.read')return ok({day:'2026-11-01',rows:[],limits:{watch:5,comment:0}});
  if(action==='now')return ok(record);if(action==='reading.get')return ok(reading);
  if(action==='reading.continue'){Object.assign(record,{state:'completed',lastFailureCode:null,pauseReason:null});Object.assign(reading,{phase:'completed',modelReason:null,recoverableZeroCall:false,needsReview:false});return ok(record);}
  return refuse('UNEXPECTED_'+action);
 },{lang});return {page,record,reading};
}
async function open(page,lang){await page.settle();await page.click(lang==='en'?'History':'观看记录');await page.click(lang==='en'?'View storyboard':'查看分镜');await page.settle();}

for(const lang of ['zh-CN','en']){
 const en=lang==='en',continueLabel=en?'Continue reading':'继续阅读';
 test(lang+': proven zero-call failure is a red failure with an explicit original-plan Continue',async t=>{const {page}=fixture(t,{lang});await open(page,lang);assert.ok(page.text().includes(en?'Reading failed':'阅读失败'));assert.ok(page.all(n=>n.props.role==='alert'&&String(n.props.className).includes('err')).length>0);assert.equal(page.button(continueLabel).props.disabled,false);assert.equal(page.count('reading.continue'),0);await page.click(continueLabel);assert.equal(page.count('reading.continue'),1);assert.equal(page.count('now'),0);});
 test(lang+': a failed reading without zero-call proof has no replay button',async t=>{const {page}=fixture(t,{lang,recoverable:false});await open(page,lang);assert.equal(page.all(n=>n.type==='button'&&page.textOf(n)===continueLabel).length,0);assert.equal(page.count('reading.continue'),0);});
 test(lang+': host review disables recovery even if a stale recoverable flag remains',async t=>{const {page}=fixture(t,{lang,needsReview:true});await open(page,lang);assert.equal(page.button(continueLabel).props.disabled,true);assert.equal(page.count('reading.continue'),0);});
 test(lang+': optional automatic watching never becomes a missing manual-watch prerequisite',async t=>{const {page}=fixture(t,{lang});await page.settle();assert.ok(page.text().includes(en?'Automatic watching is off':'自动观看未开启'));assert.ok(!page.text().includes(en?'One step left':'还差一步就能开始'));assert.equal(page.button(en?'Watch now':'现在看').props.disabled,false);});
 test(lang+': a successful explicit recovery clears the old failure reason in watch feedback',async t=>{const {page}=fixture(t,{lang});await page.settle();await page.click(en?'Watch now':'现在看');await open(page,lang);await page.click(continueLabel);await page.click(en?'Back to schedule':'返回观看安排');await page.settle();const feedback=page.all(n=>n.props['data-bili-watch-feedback']===true)[0];assert.ok(feedback);assert.ok(!page.textOf(feedback).includes('BUDDY_SOCIAL_DENIED'));assert.ok(page.textOf(feedback).includes(en?'completed':'完成'));});
}
