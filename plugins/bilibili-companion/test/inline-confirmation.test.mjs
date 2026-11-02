import test from 'node:test';
import assert from 'node:assert/strict';
import {mountPage,ok,refuse} from '../../../test/page-harness.mjs';
import {createBilibiliApp} from '../src/client/index.mjs';

const preview=id=>({id,characterId:'deepseek',readingMode:'full-v1',visual:true,state:'paused',pauseReason:'restart',video:{videoId:'BV12345678',title:'Preview '+id,url:'https://www.bilibili.com/video/BV12345678'},startedAt:1});
const plan=id=>({activityId:id,readingId:id,readingMode:'full-v1',phase:'awaiting-confirmation',confirmed:false,planHash:'hash-'+id,parts:[{cid:123,page:1,title:'First',duration:6}],availableParts:[{cid:123,page:1,title:'First',duration:6}],config:{sampleSeconds:.5,windowSeconds:6},model:{label:'Frozen model'},frameCount:12,sheetCount:1,windowCount:1,cueCount:0,textCharacters:0,estimatedCalls:2,sheetRef:'full:fixture',cells:[],sheets:[],progress:{completed:0,total:1}});
function fixture(t,{lang='zh-CN',history=[],pending=[preview('old-1'),preview('old-2')],over={}}={}){
 const state={account:'10001',history,pending},page=mountPage(t,createBilibiliApp,async(action,payload)=>{
  if(over[action])return over[action](payload,state);
  if(action==='readiness')return ok({mode:'runtime'});
  if(action==='settings.read')return ok({accountId:state.account,settings:{autonomousEnabled:true,visualAutoApproved:true,sampleSeconds:.5,windowSeconds:6,maxConcurrent:1,dailyWatchLimit:5,dailyCommentLimit:3,commentMode:'off',commentConsent:false,shareMode:'record-only',resumeMode:'idle',connectionRef:'bili-'+state.account,modelConnectionRef:'model',defaultCharacterId:'deepseek',startMinute:0,endMinute:1440},characters:[{id:'deepseek',name:'DeepSeek'}],connections:[{id:'bili-'+state.account,kind:'bilibili',name:'Bili'},{id:'model',kind:'model',name:'Image model'}],timeZone:'UTC'});
  if(action==='history.list')return ok(state.history);
  if(action==='reading.pending.list')return ok(state.pending);
  if(action==='schedule.list')return ok([]);
  if(action==='quota.read')return ok({day:'2026-11-01',rows:[],limits:{watch:5,comment:3}});
  if(action==='reading.get')return ok(plan(payload.activityId));
  if(action==='reading.image')return ok({dataUrl:'data:image/png;base64,aGVsbG8='});
  if(action==='reading.open')return ok({opened:true});
  return refuse('UNEXPECTED_'+action);
 },{lang,embedded:true});return {page,state};
}
for(const [lang,label,openLabel]of [['zh-CN','待确认阅读计划','查看并确认'],['en','Reading plans awaiting confirmation','Review and confirm']])test(lang+': schedule recovers every pending plan outside recent history and opens it inside the existing page',async t=>{
 const {page}=fixture(t,{lang});await page.settle();assert.ok(page.text().includes(label));for(const id of ['old-1','old-2'])assert.ok(page.text().includes('Preview '+id));
 const cards=page.all(n=>n.type==='section'&&n.props['aria-label']===label);assert.equal(cards.length,1);assert.equal(page.all(n=>n.type==='button'&&page.textOf(n).includes(openLabel)).length,2);
 await page.click(openLabel);assert.ok(page.text().includes(lang==='en'?'Complete-reading plan preview':'完整精读计划预览'));assert.equal(page.count('reading.open'),0,'local navigation must not move the native plugin surface');assert.ok(page.calls.some(c=>c.action==='reading.get'&&c.payload.activityId==='old-1'));assert.equal(page.count('reading.confirm'),0);assert.ok(page.text().includes('Preview old-1'));
});
test('history storyboard navigation authorizes its read without requesting host page movement',async t=>{
 const {page}=fixture(t,{history:[preview('history-1')],pending:[]});await page.settle();await page.click('观看记录');await page.click('查看分镜');assert.equal(page.count('reading.open'),0);assert.ok(page.calls.some(c=>c.action==='reading.get'&&c.payload.activityId==='history-1'));assert.ok(page.text().includes('完整精读计划预览'));
});
test('an unconfirmed preview has neutral waiting feedback and no generic continue or stopped-step claim',async t=>{
 const {page}=fixture(t,{history:[preview('old-1')],over:{now:()=>ok({...preview('new-preview'),pauseReason:'BILI_FULL_PLAN_CONFIRMATION_REQUIRED'})}});await page.settle();assert.ok(page.text().includes('待确认阅读计划'));assert.ok(!page.text().includes('停在第'));assert.equal(page.button('继续'),undefined);await page.click('现在看');assert.ok(page.text().includes('等待确认阅读计划'));assert.ok(page.text().includes('完整精读计划预览'));assert.ok(!page.text().includes('已暂停观看'));assert.equal(page.count('reading.confirm'),0);
});
test('a late pending-list response from the previous account cannot replace current cards',async t=>{
 let release,held=false;const {page,state}=fixture(t,{over:{'reading.pending.list':(_p,current)=>{const value=structuredClone(current.pending);if(held)return new Promise(resolve=>{release=()=>resolve(ok(value));});return ok(value);}}});t.after(()=>release?.());await page.settle();held=true;page.button('刷新账号与设置').props.onClick();await page.settle();assert.ok(release);held=false;state.account='20002';state.pending=[preview('new-account')];await page.dispatch('ai-buddy:social-accounts-changed');assert.ok(page.text().includes('Preview new-account'));release();await page.settle();assert.ok(page.text().includes('Preview new-account'));assert.ok(!page.text().includes('Preview old-1'));assert.ok(!page.text().includes('Preview old-2'));
});
test('a pending or rejected host confirmation never optimistically marks the plan confirmed',async t=>{
 let release;const {page}=fixture(t,{history:[preview('unconfirmed')],pending:[],over:{'reading.confirm':()=>new Promise(resolve=>{release=()=>resolve(refuse('BILI_FULL_PLAN_CONFIRMATION_REQUIRED'));})}});t.after(()=>release?.());await page.settle();await page.click('观看记录');await page.click('查看分镜');await page.click('确认整份计划并开始');assert.ok(release);assert.ok(page.text().includes('完整精读计划预览'),'confirmation stays pending until the trusted host accepts it');assert.equal(page.button('确认整份计划并开始').props.disabled,true);assert.equal(page.button('暂停'),undefined);release();await page.settle();assert.ok(page.text().includes('完整精读计划预览'));assert.equal(page.button('确认整份计划并开始').props.disabled,false);assert.equal(page.count('reading.continue'),0);
});
for(const confirmed of [false,true])test('a host-paused full plan uses '+(confirmed?'the actual paused warning after confirmation':'neutral confirmation waiting before confirmation'),async t=>{
 const {page}=fixture(t,{over:{'reading.get':payload=>ok({...plan(payload.activityId),phase:'paused',confirmed,modelReason:'BILI_FULL_PAUSED'})}});await page.settle();await page.click('查看并确认');
 const pills=page.all(n=>n.type==='span'&&String(n.props.className??'').startsWith('bili-pill '));
 if(!confirmed){assert.ok(page.text().includes('完整精读计划预览'));assert.ok(pills.some(n=>page.textOf(n)==='等待确认完整计划'&&n.props.className==='bili-pill muted'));assert.ok(!page.text().includes('当前阅读已暂停'));assert.equal(page.button('继续阅读'),undefined);}else{assert.ok(pills.some(n=>page.textOf(n)==='阅读已暂停'&&n.props.className==='bili-pill warn'));assert.ok(page.text().includes('当前阅读已暂停'));assert.ok(page.button('继续阅读'));}
});
for(const lang of ['zh-CN','en'])test(lang+': waiting feedback colors use the current theme neutral surface and border',async t=>{
 const {page}=fixture(t,{lang,over:{now:()=>ok({...preview('waiting-color'),pauseReason:'BILI_FULL_PLAN_CONFIRMATION_REQUIRED'})}});await page.settle();await page.click(lang==='en'?'Watch now':'现在看');const feedback=page.all(n=>n.props['data-bili-watch-feedback']===true)[0];assert.equal(feedback.props.role,'status');assert.equal(feedback.props.className,'bili-alert neutral');assert.equal(page.count('reading.confirm'),0);
 const css=page.styles.map(s=>s.textContent).join('\n'),rule=css.match(/\.bili-alert\.neutral\s*\{([^}]*)\}/)?.[1];assert.ok(rule,'neutral feedback needs an explicit themed style');assert.match(rule,/border-color\s*:\s*var\(--b-line\)/);assert.match(rule,/background\s*:\s*var\(--b-card2\)/);assert.doesNotMatch(rule,/--b-(?:warn|err)/);
});
for(const state of ['paused','failed'])test(state+': actual interrupted or failed feedback colors keep the existing warning/error classes',async t=>{
 const {page}=fixture(t,{over:{now:()=>ok({...preview('actual-'+state),state,pauseReason:state==='paused'?'pause':null,lastFailureCode:state==='failed'?'BILI_VIDEO_UNAVAILABLE':null})}});await page.settle();await page.click('现在看');const feedback=page.all(n=>n.props['data-bili-watch-feedback']===true)[0];assert.equal(feedback.props.className,state==='failed'?'bili-alert err':'bili-alert');assert.equal(feedback.props.role,state==='failed'?'alert':'status');
});
