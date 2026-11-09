import test from 'node:test';
import assert from 'node:assert/strict';
import {mountPage,ok,refuse} from '../../../test/page-harness.mjs';
import {createBilibiliApp} from '../src/client/index.mjs';

const settings=account=>({autonomousEnabled:true,maxConcurrent:1,dailyWatchLimit:5,dailyCommentLimit:0,commentMode:'off',commentConsent:false,shareMode:'selected',resumeMode:'manual',connectionRef:'bili-'+account,modelConnectionRef:'model',startMinute:0,endMinute:1440,defaultCharacterId:'deepseek'});
const config=account=>({accountId:account,settings:settings(account),timeZone:'UTC',characters:[{id:'deepseek',name:'DeepSeek'}],connections:[{id:'bili-'+account,name:'Account '+account,kind:'bilibili'},{id:'model',name:'Image model',kind:'model'}],todayAllowed:true});
const day=new Intl.DateTimeFormat('en-CA',{timeZone:'UTC',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const record=extra=>({id:'watch-1',characterId:'deepseek',state:'understanding',visual:true,startedAt:Date.now(),video:{videoId:'BV1xx411c7mD',title:'Storyboard fixture'},...extra});
function fixture(t,{lang='zh-CN',over={},history=[],plans=[]}={}){
 const state={account:'10001',history,plans};
 const page=mountPage(t,createBilibiliApp,async(action,payload)=>{if(over[action])return over[action](payload);if(action==='readiness')return ok({mode:'runtime',blockers:[]});if(action==='settings.read')return ok(config(state.account));if(action==='reading.pending.list')return ok([]);if(action==='history.list')return ok(state.history);if(action==='schedule.list')return ok(state.plans);if(action==='quota.read')return ok({day,rows:[],limits:{watch:5,comment:0}});return refuse('UNEXPECTED_'+action);},{lang});
 return {page,state};
}
const feedback=page=>page.all(n=>n.props['data-bili-watch-feedback']===true)[0];
const button=(page,label)=>page.all(n=>n.type==='button'&&page.textOf(n)===label)[0];

for(const lang of ['zh-CN','en']){
 const en=lang==='en',watch=en?'Watch now':'现在看';
 test(lang+': a pending watch immediately names the character and prevents double submission',async t=>{
  let release;const {page}=fixture(t,{lang,over:{now:()=>new Promise(resolve=>{release=()=>resolve(ok(record({state:'completed'})));})}});t.after(()=>release?.());await page.settle();
  const start=button(page,watch);start.props.onClick();start.props.onClick();await page.settle();
  assert.equal(page.count('now'),1);const status=feedback(page);assert.ok(status,'there must be visible feedback before history contains an activity');assert.equal(status.props.role,'status');assert.ok(page.textOf(status).includes('DeepSeek'));assert.ok(page.textOf(status).includes(en?'Preparing':'正在准备'));
  release();await page.settle();assert.ok(page.textOf(feedback(page)).includes(en?'completed':'完成'));
 });
 test(lang+': a sleeping manual request says it did not start and must be requested again',async t=>{
  const {page}=fixture(t,{lang,over:{now:()=>ok({state:'waiting-sleep',scheduleId:null,videoAcquired:false,watchQuotaConsumed:false})}});await page.settle();await page.click(button(page,watch));
  const text=page.textOf(feedback(page));assert.ok(text.includes(en?'has not started':'尚未开始'));assert.ok(text.includes(en?'Watch now again':'再次点「现在看」'));assert.equal(page.count('now'),1);assert.equal(button(page,watch).props.disabled,false);
 });
 for(const [state,reason,expected] of [
  ['paused','BILI_VISION_MODEL_UNSUPPORTED',en?'support images':'支持图片'],
  ['failed','BILI_SELECTION_EMPTY',en?'No video':'没找到可看'],
  ['partial',null,en?'Partly':'只完成部分'],
  ['deferred','off-peak',en?'not started':'尚未开始'],
 ])test(lang+': a successful HTTP '+state+' result is shown honestly',async t=>{
  const {page}=fixture(t,{lang,over:{now:()=>ok(record({state,lastFailureCode:reason,reason}))}});await page.settle();await page.click(button(page,watch));
  const status=feedback(page);assert.ok(status);assert.ok(page.textOf(status).includes(expected),page.textOf(status));assert.equal(status.props.role,state==='failed'?'alert':'status');
 });
}

test('Continue and a plan start use the same visible lifecycle as Watch now',async t=>{
 let release;const paused=record({state:'paused',lastFailureCode:'BILI_VISION_MODEL_UNSUPPORTED'}),plan={id:'plan-1',participants:['deepseek'],participantIndex:0,remaining:1,day,startMinute:0,endMinute:1440,state:'scheduled'};
 const {page,state}=fixture(t,{history:[paused],plans:[plan],over:{continue:()=>new Promise(resolve=>{release=()=>resolve(ok({resumed:false,reason:'waiting-sleep'}));}),'schedule.start':()=>ok({state:'deferred',reason:'off-peak',scheduleId:'plan-1'})}});t.after(()=>release?.());await page.settle();
 assert.ok(page.text().includes('支持图片'),'the current paused activity explains why it is paused');await page.click(button(page,'继续'));assert.ok(page.textOf(feedback(page)).includes('DeepSeek'));release();await page.settle();assert.ok(page.textOf(feedback(page)).includes('尚未开始'));
 state.history=[];await page.dispatch('ai-buddy:social-accounts-changed');const row=page.all(n=>n.type==='article'&&String(n.props.className).includes('bili-plan'))[0];await page.click(page.all(n=>n.type==='button'&&page.textOf(n)==='现在看',row)[0]);assert.ok(page.textOf(feedback(page)).includes('尚未开始'));
});

test('quiet progress polling reports failures and clears the notice on the next successful read',async t=>{
 let release,failReads=false;const {page}=fixture(t,{over:{now:()=>new Promise(resolve=>{release=()=>resolve(ok(record({state:'completed'})));}),'history.list':()=>failReads?refuse('POLL_NETWORK_FAILURE'):ok([])}});t.after(()=>release?.());await page.settle();failReads=true;await page.click(button(page,'现在看'));await new Promise(resolve=>setTimeout(resolve,450));await page.settle();assert.ok(page.text().includes('暂时读不到最新状态'));assert.ok(page.text().includes('POLL_NETWORK_FAILURE'));
 failReads=false;await page.click('刷新账号与设置');assert.ok(!page.text().includes('POLL_NETWORK_FAILURE'));release();await page.settle();
});

test('an old account result cannot overwrite the new account feedback or unlock its request',async t=>{
 const releases=[];const {page,state}=fixture(t,{over:{now:()=>new Promise(resolve=>releases.push(value=>resolve(ok(value))))}});t.after(()=>releases.forEach(fn=>fn(record({state:'completed'}))));await page.settle();await page.click(button(page,'现在看'));state.account='20002';await page.dispatch('ai-buddy:social-accounts-changed');assert.equal(feedback(page),undefined);await page.click(button(page,'现在看'));releases[0](record({state:'failed',lastFailureCode:'OLD_ACCOUNT_FAILURE'}));await page.settle();assert.ok(!page.text().includes('OLD_ACCOUNT_FAILURE'));assert.equal(button(page,'现在看').props.disabled,true);releases[1](record({state:'completed'}));await page.settle();assert.equal(button(page,'现在看').props.disabled,false);
});

test('same-account refresh cannot submit the pending request a second time or leave its button locked',async t=>{
 let release;const {page}=fixture(t,{over:{now:()=>new Promise(resolve=>{release=value=>resolve(ok(value));})}});t.after(()=>release?.(record({state:'completed'})));await page.settle();await page.click(button(page,'现在看'));await page.dispatch('ai-buddy:social-accounts-changed');
 const start=button(page,'现在看');assert.equal(start.props.disabled,true);start.props.onClick();await page.settle();assert.equal(page.count('now'),1);release(record({state:'failed',lastFailureCode:'STALE_SAME_ACCOUNT_RESULT'}));await page.settle();assert.equal(button(page,'现在看').props.disabled,false);assert.ok(!page.text().includes('STALE_SAME_ACCOUNT_RESULT'));
});

test('recent previous completions cannot impersonate a newly pending watch',async t=>{
 let release;const {page}=fixture(t,{history:[record({id:'previous-watch',state:'completed'})],over:{now:()=>new Promise(resolve=>{release=()=>resolve(ok(record({state:'completed'})));})}});t.after(()=>release?.());await page.settle();await page.click(button(page,'现在看'));assert.ok(page.textOf(feedback(page)).includes('正在准备观看'));assert.ok(!page.textOf(feedback(page)).includes('本次阅读已完成'));
});

test('settings let their controls move below readable text rather than squeeze the note into a character column',async t=>{
 const {page}=fixture(t);await page.settle();await page.click('设置');const css=page.styles.map(x=>x.textContent).join('\n');assert.ok(!/\.bili-seg\{flex-wrap:nowrap\}/.test(css));assert.match(css,/\.bili-srow\{[^}]*flex-wrap:wrap/);assert.match(css,/\.bili-srow>div:first-child\{[^}]*flex:1 1 2\d\dpx/);assert.match(css,/\.bili-srow>:last-child\{[^}]*max-width:100%/);
});
