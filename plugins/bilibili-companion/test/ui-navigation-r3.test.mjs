// Regression coverage for storyboard identity and navigation ownership.
// Uses the candidate page and existing public page harness; no real account or model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mountPage, ok, refuse } from '../../../test/page-harness.mjs';
import { createBilibiliApp } from '../src/client/index.mjs';
import { createReadingView } from '../src/client/reading.mjs';

const image = 'data:image/png;base64,aGVsbG8=';
const makeRecord = (id, state='paused') => ({ id, characterId:'deepseek', readingMode:'full-v1', visual:true,
  state, statusRevision:1, pauseReason:'BILI_FULL_PLAN_CONFIRMATION_REQUIRED', startedAt:Date.now(),
  video:{videoId:'BV12345678',title:'AUDIT_'+id,url:'https://www.bilibili.com/video/BV12345678'} });
const makeReading = (id, count=2) => {
  const sheets=Array.from({length:count},(_,i)=>({sheetRef:`full:${id}:${i}`,cid:123,from:i*6,to:(i+1)*6,cells:[{index:1,start:i*6,end:(i+1)*6}]}));
  return {readingId:id,activityId:id,activityRevision:1,readingRevision:1,readingMode:'full-v1',phase:'awaiting-confirmation',confirmed:false,
    planHash:'plan-'+id,currentCid:123,parts:[{cid:123,page:1,title:'Part',duration:count*6}],config:{sampleSeconds:.5,windowSeconds:6},
    model:{label:'Synthetic image model'},frameCount:count*12,sheetCount:count,windowCount:count,cueCount:1,textCharacters:10,estimatedCalls:count,
    sheetRef:sheets[0].sheetRef,source:'original-video',media:{audio:'platform-subtitles'},cells:sheets[0].cells,sheets,progress:{completed:0,total:count+1}};
};
function fixture(t, overrides={}) {
  t.mock.timers.enable({apis:['setTimeout']});
  const records=[makeRecord('long'),makeRecord('short')], readings={long:makeReading('long',61),short:makeReading('short',2)};
  const state={records,pending:[],readings};
  const page=mountPage(t,createBilibiliApp,async(action,payload)=>{
    if(overrides[action]) return overrides[action](payload,state);
    if(action==='readiness')return ok({mode:'runtime'});
    if(action==='settings.read')return ok({accountId:'synthetic-account',settings:{autonomousEnabled:true,visualAutoApproved:true,sampleSeconds:.5,windowSeconds:6,maxConcurrent:1,dailyWatchLimit:5,dailyCommentLimit:0,commentMode:'off',commentConsent:false,shareMode:'record-only',resumeMode:'manual',connectionRef:'bili',modelConnectionRef:'model',defaultCharacterId:'deepseek',startMinute:0,endMinute:1440},characters:[{id:'deepseek',name:'DeepSeek'}],connections:[{id:'bili',kind:'bilibili',name:'Synthetic account'},{id:'model',kind:'model',name:'Synthetic model'}],timeZone:'UTC'});
    if(action==='reading.pending.list')return ok(state.pending);
    if(action==='history.list')return ok(state.records);
    if(action==='schedule.list')return ok([]);
    if(action==='quota.read')return ok({day:'2026-11-07',rows:[],limits:{watch:5,comment:0}});
    if(action==='reading.get')return ok(state.readings[payload.activityId]);
    if(action==='reading.image')return ok({dataUrl:image});
    if(action==='reading.replan')return ok(state.records.find(r=>r.id==='short'));
    return refuse('UNEXPECTED_'+action);
  });
  const open = async(id='long')=>{await page.settle();await page.click('观看记录');const row=page.all(n=>n.type==='article'&&n.props.id==='bili-activity-'+id)[0];assert.ok(row);await page.click(page.all(n=>n.type==='button'&&page.textOf(n)==='查看分镜',row)[0]);};
  const sheetButtons=()=>{const group=page.all(n=>n.props['aria-label']==='选择分镜')[0];return group?page.all(n=>n.type==='button',group):[];};
  const selectedTab=()=>page.all(n=>n.props.role==='tab'&&n.props['aria-selected']===true).map(n=>page.textOf(n))[0];
  return {page,state,open,sheetButtons,selectedTab};
}

test('CONTROL: opening another reading through History resets storyboard pagination',async t=>{
  const f=fixture(t);await f.open();await f.page.click('下一页分镜');assert.equal(f.sheetButtons().length,30);
  await f.page.click('返回观看安排');await f.open('short');assert.equal(f.sheetButtons().length,2);
});

test('UI-PAGING-EVENT: a host reading-open event resets pagination for a shorter reading',async t=>{
  const f=fixture(t);await f.open();await f.page.click('下一页分镜');assert.equal(f.sheetButtons().length,30);
  await f.page.dispatch('ai-buddy:bili-reading-open',{activityId:'short'});
  assert.ok(f.page.text().includes('AUDIT_short'),'the actual second DTO is on screen');
  assert.equal(f.sheetButtons().length,2,'the second reading must show both of its sheets, irrespective of the former page');
});

test('UI-PAGING-REPLAN: a shorter replacement preview resets storyboard pagination',async t=>{
  const f=fixture(t);await f.open();await f.page.click('下一页分镜');
  const field=f.page.all(n=>n.type==='input'&&n.props.type==='number')[0];
  field.props.onChange({target:{value:'1'}});await f.page.settle();await f.page.click('更新预览');
  assert.equal(f.page.count('reading.replan'),1);assert.ok(f.page.text().includes('AUDIT_short'));
  assert.equal(f.sheetButtons().length,2,'the new shorter plan must not inherit the old page index');
});

test('UI-LATE-OPEN: a delayed storyboard read cannot undo a later Settings tab selection',async t=>{
  let release,hold=true;const f=fixture(t,{'reading.get':(payload,state)=>{const value=structuredClone(state.readings[payload.activityId]);if(hold){hold=false;return new Promise(resolve=>release=()=>resolve(ok(value)));}return ok(value);}});
  t.after(()=>release?.());await f.open();assert.equal(typeof release,'function');
  await f.page.click('设置');assert.equal(f.selectedTab(),'设置');release();await f.page.settle();
  assert.equal(f.selectedTab(),'设置','the user chose Settings after asking for the delayed storyboard');
});

test('UI-LATE-WATCH: a stopped preview cannot be reopened by the delayed Watch now response',async t=>{
  let release;const f=fixture(t,{now:(_payload,state)=>{state.records=[makeRecord('short')];state.pending=[state.records[0]];const originalReply=structuredClone(state.records[0]);return new Promise(resolve=>release=()=>resolve(ok(originalReply)));},'reading.stop':(payload,state)=>{const rec=state.records.find(r=>r.id===payload.activityId);Object.assign(rec,{state:'cancelled',statusRevision:2,pauseReason:'stop'});Object.assign(state.readings[payload.activityId],{phase:'cancelled',activityRevision:2,readingRevision:2,pauseReason:'stop'});state.pending=[];return ok({stopped:true});}});
  t.after(()=>release?.());f.state.records=[];await f.page.settle();await f.page.click('现在看');assert.equal(typeof release,'function');
  await f.page.click('刷新账号与设置');await f.page.click('查看并确认');await f.page.click('停止阅读');
  assert.ok(f.page.text().includes('阅读已停止'));await f.page.click('返回观看安排');await f.page.click('设置');
  release();await f.page.settle();assert.equal(f.selectedTab(),'设置','the old prepared-plan response must not override the later Stop and Settings choices');
});


test('storyboard pagination clamps to the current plan even when a caller retains an invalid page',()=>{
  const React={createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity)})};
  const ReadingView=createReadingView(React),all=(node,predicate)=>!node||typeof node!=='object'?[]:[...(predicate(node)?[node]:[]),...(node.children??[]).flatMap(child=>all(child,predicate))];
  for(const [count,page,expected] of [[2,5,2],[61,99,1],[61,-2,30]]){
    const tree=ReadingView({reading:makeReading('clamp',count),sheetPage:page});
    const group=all(tree,node=>node.props['aria-label']==='选择分镜')[0];
    assert.equal(all(group,node=>node.type==='button').length,expected);
  }
});

test('a slow replacement preview cannot undo Settings and still refreshes the same account history',async t=>{
  let release;const f=fixture(t,{'reading.replan':(_payload,state)=>new Promise(resolve=>{release=()=>{state.records=[makeRecord('short')];resolve(ok(state.records[0]));};})});
  t.after(()=>release?.());await f.open();
  const field=f.page.all(n=>n.type==='input'&&n.props.type==='number')[0];
  field.props.onChange({target:{value:'1'}});await f.page.settle();await f.page.click('更新预览');
  await f.page.click('设置');const before=f.page.count('history.list');release();await f.page.settle();
  assert.equal(f.selectedTab(),'设置');assert.ok(f.page.count('history.list')>before);
  await f.page.click('观看记录');assert.ok(f.page.text().includes('AUDIT_short'));
});
