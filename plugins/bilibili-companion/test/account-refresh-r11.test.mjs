import test from 'node:test';
import assert from 'node:assert/strict';
import {mountPage,ok,refuse} from '../../../test/page-harness.mjs';
import {createBilibiliApp} from '../src/client/index.mjs';

const settings=account=>({autonomousEnabled:true,maxConcurrent:1,dailyWatchLimit:account==='A'?5:7,dailyCommentLimit:3,commentMode:'managed',commentConsent:true,commentReview:'preview',shareMode:'selected',resumeMode:'idle',connectionRef:'bili-'+account,modelConnectionRef:'model',startMinute:0,endMinute:1440,defaultCharacterId:'deepseek'});
const config=account=>({settings:settings(account),accountId:account==='A'?'10001':'20002',timeZone:'UTC',characters:[{id:'deepseek',name:'DeepSeek'}],connections:[{id:'bili-'+account,name:'Account '+account,kind:'bilibili'},{id:'model',name:'Fixture model',kind:'model'}],todayAllowed:true});
const record=account=>({id:'activity-'+account,accountId:account==='A'?'10001':'20002',characterId:'deepseek',state:'completed',day:'2026-10-29',createdAt:Date.parse('2026-10-29T12:00:00Z'),finishedAt:Date.parse('2026-10-29T12:01:00Z'),video:{videoId:account==='A'?'BV1xK4y1a7Qz':'BV1Gz4y1h7Kp',title:'ONLY_ACCOUNT_'+account,url:'https://www.bilibili.com/video/'+(account==='A'?'BV1xK4y1a7Qz':'BV1Gz4y1h7Kp')},understanding:{summary:'PRIVATE_ACCOUNT_'+account,notes:'note'},material:{complete:true},comments:[{id:'comment-'+account,state:'draft',text:'PRIVATE_DRAFT_'+account}]});
function route(state,over={}){return async(action,payload)=>{
 if(over[action])return over[action](payload);
 if(action==='readiness')return ok({mode:'runtime',blockers:[]});
 if(action==='settings.read')return ok(config(state.account));
 if(action==='reading.pending.list')return ok([]);if(action==='history.list')return ok([record(state.account)]);
 if(action==='schedule.list')return ok([]);
 if(action==='quota.read')return ok({day:'2026-10-29',limits:{watch:5,comment:3},rows:[]});
 return refuse('UNEXPECTED_'+action);
};}

test('Bilibili account refresh discards another account unsaved settings but keeps same-account edits',async t=>{
 const state={account:'A'},page=mountPage(t,createBilibiliApp,route(state));await page.settle();await page.click('设置');await page.change('每天最多看','9');
 await page.dispatch('ai-buddy:social-accounts-changed');assert.equal(page.all(n=>n.props['aria-label']==='每天最多看')[0].props.value,9,'same-account refresh retains the unsaved edit');
 state.account='B';await page.dispatch('ai-buddy:social-accounts-changed');
 assert.equal(page.all(n=>n.props['aria-label']==='每天最多看')[0].props.value,7,'account B must get B settings rather than A draft');
});

test('Bilibili account refresh ignores an older settings and history response arriving after the new account',async t=>{
 const state={account:'A'};let release,hold=true;
 const page=mountPage(t,createBilibiliApp,route(state,{'settings.read':()=>{const value=config(state.account);if(hold){hold=false;return new Promise(resolve=>release=()=>resolve(ok(value)));}return ok(value);}}));
 t.after(()=>release?.());await page.settle();assert.equal(typeof release,'function');
 state.account='B';await page.dispatch('ai-buddy:social-accounts-changed');await page.click('观看记录');assert.ok(page.text().includes('ONLY_ACCOUNT_B'));
 release();await page.settle();
 assert.ok(page.text().includes('ONLY_ACCOUNT_B'));assert.ok(!page.text().includes('ONLY_ACCOUNT_A'),'the old account response must not replace the new account page');
});

test('Bilibili account refresh clears another account comment preview and drafts',async t=>{
 const state={account:'A'},page=mountPage(t,createBilibiliApp,route(state));await page.settle();await page.click('观看记录');await page.click('预览并发表…');
 assert.equal(page.all(n=>n.type==='textarea')[0].props.value,'PRIVATE_DRAFT_A');
 state.account='B';await page.dispatch('ai-buddy:social-accounts-changed');
 assert.equal(page.all(n=>n.props.role==='dialog').length,0,'an account A preview must close before B is shown');
 assert.ok(!page.text().includes('PRIVATE_ACCOUNT_A'));
});

test('Bilibili same-account refresh preserves an edited comment preview',async t=>{
 const state={account:'A'},page=mountPage(t,createBilibiliApp,route(state));await page.settle();await page.click('观看记录');await page.click('预览并发表…');
 await page.change('评论内容','EDITED_ACCOUNT_A_DRAFT');await page.dispatch('ai-buddy:social-accounts-changed');
 assert.equal(page.all(n=>n.props.role==='dialog').length,1);assert.equal(page.all(n=>n.type==='textarea')[0].props.value,'EDITED_ACCOUNT_A_DRAFT');
 assert.equal(page.count('comment.post'),0);
});

test('Bilibili returning to the original account cancels a late intermediate account read',async t=>{
 const state={account:'A'};let release;
 const page=mountPage(t,createBilibiliApp,route(state,{'settings.read':()=>{const value=config(state.account);return state.account==='B'?new Promise(resolve=>release=()=>resolve(ok(value))):ok(value);}}));
 t.after(()=>release?.());await page.settle();await page.click('设置');await page.change('每天最多看','9');
 state.account='B';await page.dispatch('ai-buddy:social-accounts-changed');assert.equal(typeof release,'function');
 state.account='A';await page.dispatch('ai-buddy:social-accounts-changed');release();await page.settle();
 assert.equal(page.all(n=>n.props['aria-label']==='每天最多看')[0].props.value,9);await page.click('观看记录');
 assert.ok(page.text().includes('ONLY_ACCOUNT_A'));assert.ok(!page.text().includes('ONLY_ACCOUNT_B'));
});

test('Bilibili a cancelled old-account watch cannot add an error or reload the new account',async t=>{
 const state={account:'A'};let release;
 const page=mountPage(t,createBilibiliApp,route(state,{now:()=>new Promise(resolve=>release=()=>resolve(refuse('LATE_ACCOUNT_A_WATCH')))}));
 t.after(()=>release?.());await page.settle();await page.click('现在看');assert.equal(typeof release,'function');
 state.account='B';await page.dispatch('ai-buddy:social-accounts-changed');const reads=page.count('settings.read');release();await page.settle();
 assert.equal(page.count('settings.read'),reads);assert.ok(!page.text().includes('LATE_ACCOUNT_A_WATCH'));assert.equal(page.button('现在看').props.disabled,false);
});
