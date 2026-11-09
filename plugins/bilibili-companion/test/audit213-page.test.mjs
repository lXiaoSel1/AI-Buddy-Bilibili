import test from 'node:test';
import assert from 'node:assert/strict';
import {mountPage,ok,refuse} from '../../../test/page-harness.mjs';
import {createBilibiliApp} from '../src/client/index.mjs';
for(const lang of ['zh-CN','en'])for(const code of ['BILI_LOGIN_EXPIRED','BILI_REQUEST_RESTRICTED'])test(lang+': paused '+code+' offers the matching recovery',async t=>{
 const activity={id:'fixture',characterId:'deepseek',state:'paused',pauseReason:code,lastFailureCode:code,startedAt:Date.now(),video:{videoId:'BVfixture123',title:'Fixture'}};
 const page=mountPage(t,createBilibiliApp,async action=>{
  if(action==='readiness')return ok({mode:'runtime',blockers:[]});
  if(action==='settings.read')return ok({settings:{connectionRef:'fixture',modelConnectionRef:'fixture-model',defaultCharacterId:'deepseek',startMinute:0,endMinute:1440},accountId:'fixture',timeZone:'UTC',todayAllowed:true,characters:[{id:'deepseek',name:'Fixture'}],connections:[]});
  if(action==='history.list')return ok([activity]);if(action==='quota.read')return ok({limits:{watch:5,comment:0},rows:[]});if(['reading.pending.list','schedule.list'].includes(action))return ok([]);if(action==='onboarding.open')return ok({opened:true});return refuse('UNEXPECTED');
 },{lang});await page.settle();
 if(code==='BILI_LOGIN_EXPIRED'){assert.ok(page.text().includes(lang==='en'?'login expired':'登录已过期'));await page.click(lang==='en'?'Sign in again':'重新登录');assert.equal(page.count('onboarding.open'),1);}
 else{assert.ok(page.text().includes(lang==='en'?'restricted this request':'限制了这次请求'));assert.ok(!page.text().includes(lang==='en'?'login expired':'登录已过期'));}
});
