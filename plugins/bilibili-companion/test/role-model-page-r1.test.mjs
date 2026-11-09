import test from 'node:test';
import assert from 'node:assert/strict';
import {mountPage,ok,refuse} from '../../../test/page-harness.mjs';
import {createBilibiliApp} from '../src/client/index.mjs';

const SETTINGS={autonomousEnabled:true,maxConcurrent:1,dailyWatchLimit:5,dailyCommentLimit:0,commentMode:'off',commentConsent:false,commentReview:'preview',shareMode:'record-only',resumeMode:'manual',connectionRef:'bili-ref',modelConnectionRef:'legacy-model',defaultCharacterId:'alpha',startMinute:0,endMinute:1440};
const CHARACTERS=[{id:'alpha',name:'甲角色'},{id:'beta',name:'乙角色'}];
const CONNECTIONS=[{id:'bili-ref',name:'测试B站账号',kind:'bilibili'},{id:'legacy-model',name:'Legacy independent model',kind:'model'}];
const day=new Intl.DateTimeFormat('en-CA',{timeZone:'UTC',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function fixture(t,{lang='zh-CN',settings=SETTINGS,over={}}={}){
  let saved={...settings};
  const page=mountPage(t,createBilibiliApp,async(action,payload)=>{
    if(Object.hasOwn(over,action))return typeof over[action]==='function'?over[action](payload):over[action];
    if(action==='readiness')return ok({mode:'runtime',blockers:[]});
    if(action==='settings.read')return ok({settings:saved,accountId:'synthetic-account',timeZone:'UTC',todayAllowed:true,characters:CHARACTERS,connections:CONNECTIONS});
    if(action==='settings.update'){saved={...saved,...payload};return ok(saved);}
    if(action==='quota.read')return ok({day,limits:{watch:5,comment:0},rows:[]});
    if(['history.list','reading.pending.list','schedule.list'].includes(action))return ok([]);
    return refuse('UNEXPECTED_'+action);
  },{lang});
  return {page,get saved(){return saved;}};
}

for(const lang of ['zh-CN','en'])test('role model: '+lang+' settings show a readonly role rule and other edits leave the legacy connection untouched',async t=>{
  const en=lang==='en',f=fixture(t,{lang}),{page}=f;
  await page.settle();await page.click(en?'Settings':'设置');
  assert.ok(page.text().includes(en?'Use the viewing character’s chat model':'使用观看角色的聊天模型'),page.text());
  assert.ok(page.text().includes(en?'Without a dedicated binding, the current default chat connection is used.':'没有专属绑定时使用当前默认聊天连接。'),page.text());
  assert.ok(page.text().includes(en?'The actual model is shown in the reading plan.':'具体模型会在阅读计划中显示。'),page.text());
  assert.equal(page.all(n=>n.type==='select'&&n.props['aria-label']===(en?'Model for notes':'写感想用的模型')).length,0);
  assert.ok(!page.text().includes('Legacy independent model'),'a catalog model is not claimed to be the selected role’s model');
  await page.change(en?'Default character':'默认参与角色','beta');
  await page.click(en?'Save settings':'保存设置');
  const payload=page.calls.find(c=>c.action==='settings.update').payload;
  assert.equal(payload.defaultCharacterId,'beta');
  assert.equal(payload.connectionRef,'bili-ref');
  assert.equal(Object.hasOwn(payload,'modelConnectionRef'),false,'the retired selector is not serialized by unrelated settings edits');
  assert.equal(f.saved.modelConnectionRef,'legacy-model','the existing field is preserved for old data');
});

for(const lang of ['zh-CN','en'])for(const modelConnectionRef of [null,'removed-legacy-model'])test('role model: '+lang+' a '+String(modelConnectionRef)+' legacy choice does not block watching or a scheduled character',async t=>{
  const en=lang==='en',plan={id:'plan-1',participants:['beta'],day,startMinute:0,endMinute:1440,state:'scheduled',remaining:1};
  const {page}=fixture(t,{lang,settings:{...SETTINGS,modelConnectionRef},over:{'schedule.list':ok([plan]),now:ok({state:'completed'}),'schedule.start':ok({state:'completed'})}});
  await page.settle();
  assert.equal(page.all(n=>n.props['aria-label']===(en?'Steps left':'还差几步')).length,0,'the retired independent model is not a readiness step');
  assert.ok(!page.text().includes('Legacy independent model'),'the independent catalog label is not attributed to any participant');
  await page.click(page.all(n=>n.type==='button'&&page.textOf(n).includes(en?'Watch now':'现在看')&&String(n.props.className).includes('pri'))[0]);
  assert.deepEqual(page.calls.find(c=>c.action==='now').payload,{visual:true,characterId:'alpha',videoId:null});
  const row=page.all(n=>n.type==='article'&&String(n.props.className).includes('bili-plan'))[0];
  await page.click(page.all(n=>n.type==='button'&&page.textOf(n).includes(en?'Watch now':'现在看'),row)[0]);
  assert.deepEqual(page.calls.find(c=>c.action==='schedule.start').payload,{scheduleId:'plan-1',visual:true});
  await page.click(en?'New plan':'新增预约');
  const dialog=page.all(n=>n.props.role==='dialog')[0];
  assert.ok(page.textOf(dialog).includes(en?'Each participant uses their own chat model.':'每位参与角色使用自己的聊天模型。'),page.textOf(dialog));
  assert.ok(page.textOf(dialog).includes(en?'The actual model is shown in the reading plan.':'具体模型会在阅读计划中显示。'),page.textOf(dialog));
});

for(const lang of ['zh-CN','en'])for(const code of ['BILI_MODEL_REQUIRED','BILI_VISION_MODEL_REQUIRED','BILI_VISION_MODEL_UNSUPPORTED'])test('role model: '+lang+' '+code+' directs the user to the character chat connection',async t=>{
  const en=lang==='en',{page}=fixture(t,{lang,over:{now:code==='BILI_MODEL_REQUIRED'?refuse(code):ok({state:'paused',reason:code})}});
  await page.settle();await page.click(en?'Watch now':'现在看');
  assert.ok(page.text().includes(en?'AI Buddy':'AI 酱'),page.text());
  assert.ok(page.text().includes(en?'model binding':'模型绑定'),page.text());
  assert.ok(!page.text().includes(en?'Choose a reading model in Settings':'先在设置里选择'),page.text());
  assert.equal(page.count('now'),1);
});
