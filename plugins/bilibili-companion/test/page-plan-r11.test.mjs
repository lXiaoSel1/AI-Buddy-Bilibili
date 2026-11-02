import test from 'node:test';
import assert from 'node:assert/strict';
import {mountPage,ok,refuse} from '../../../test/page-harness.mjs';
import {createBilibiliApp} from '../src/client/index.mjs';

const settings={autonomousEnabled:true,maxConcurrent:1,dailyWatchLimit:5,dailyCommentLimit:3,commentMode:'off',commentConsent:false,commentReview:'preview',shareMode:'selected',resumeMode:'idle',connectionRef:'bili-ref',modelConnectionRef:'model-ref',startMinute:0,endMinute:1440,defaultCharacterId:'deepseek'};
const day=new Intl.DateTimeFormat('en-CA',{timeZone:'UTC',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const routes=over=>async(action,payload)=>{if(Object.hasOwn(over,action))return typeof over[action]==='function'?over[action](payload):over[action];if(action==='readiness')return ok({mode:'runtime',blockers:[]});if(action==='settings.read')return ok({settings,accountId:'account',timeZone:'UTC',todayAllowed:true,characters:[{id:'deepseek',name:'DeepSeek'}],connections:[{id:'bili-ref',name:'我的B站',kind:'bilibili'},{id:'model-ref',name:'本地模型',kind:'model'}]});if(action==='quota.read')return ok({day,limits:{watch:5,comment:3},rows:[]});if(['reading.pending.list','schedule.list','history.list'].includes(action))return ok([]);return refuse('UNEXPECTED_'+action);};

for(const lang of ['zh-CN','en'])test('G6-11: '+lang+' new plans really submit interest or a validated specific video',async t=>{
 const page=mountPage(t,createBilibiliApp,routes({'schedule.create':payload=>ok({id:'created',...payload})}),{lang});await page.settle();
 const en=lang==='en';await page.click(en?'New plan':'新增预约');
 assert.ok(page.text().includes(en?'Today · app time zone':'今天 · 应用时区'));
 const mode=page.all(n=>n.props.role==='radiogroup'&&n.props['aria-label']===(en?'What to watch':'看什么'))[0];assert.ok(mode,'the choice is not a decorative label');
 await page.click(en?'A specific video':'指定视频');
 assert.equal(page.button(en?'Save plan':'保存预约').props.disabled,true,'an empty fixed target cannot be saved');
 await page.change(en?'Video ID or Bilibili link':'视频编号或B站链接','https://localhost/video/BV1xx411c7mD');
 assert.equal(page.button(en?'Save plan':'保存预约').props.disabled,true,'a non-Bilibili link is rejected before saving');
 await page.change(en?'Video ID or Bilibili link':'视频编号或B站链接','https://www.bilibili.com/video/BV1xx411c7mD/?share_source=fixture');
 await page.click(en?'Save plan':'保存预约');
 assert.deepEqual(page.calls.find(c=>c.action==='schedule.create').payload,{participants:['deepseek'],count:1,startMinute:1200,endMinute:1320,watchMode:'video',videoId:'BV1xx411c7mD',visualReading:true});
 await page.click(en?'New plan':'新增预约');await page.click(en?'By interest':'按兴趣挑选');await page.click(en?'Save plan':'保存预约');
 assert.equal(page.calls.filter(c=>c.action==='schedule.create').at(-1).payload.watchMode,'interest');assert.equal(page.calls.filter(c=>c.action==='schedule.create').at(-1).payload.videoId,null);
});

for(const lang of ['zh-CN','en'])test('E3-4: '+lang+' even one viewing note displays its count without inventing a second entry',async t=>{
 const record={id:'a1',characterId:'deepseek',day,state:'completed',video:{videoId:'BV1xx411c7mD',title:'fixture',url:'https://www.bilibili.com/video/BV1xx411c7mD'},understanding:{summary:'summary',notes:'  唯一一条笔记\n\n '},comments:[]};
 const page=mountPage(t,createBilibiliApp,routes({'history.list':ok([record])}),{lang});await page.settle();await page.click(lang==='en'?'History':'观看记录');
 assert.ok(page.text().includes(lang==='en'?'1 note':'观看笔记 · 1 条'));assert.ok(!page.text().includes(lang==='en'?'1 notes':'观看笔记 · 2 条'));
});
