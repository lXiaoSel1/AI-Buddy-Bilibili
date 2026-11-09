import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture} from './fixtures/r3-service.mjs';
import {createBilibiliHttpPlatform} from '../src/http-platform.mjs';
import {VERSION} from '../src/defaults.mjs';
import manifest from '../package.json' with {type:'json'};
const pause=()=>{let release;const promise=new Promise(resolve=>release=resolve);return {promise,release};};

test('C4: manual reading crosses midnight outside its start window and keeps the starting quota day',async t=>{
 const f=fixture({at:Date.parse('2026-11-09T04:59:59Z')}),entered=pause(),gate=pause();t.after(()=>f.close());await f.configure({startMinute:60,endMinute:120});
 f.state.materialHook=async()=>{entered.release();await gate.promise;return {videoId:'BVtest123',coverage:'subtitles',complete:true,items:[{id:'subtitle:1',text:'Fixture subtitle'}],sourceRefs:['fixture:subtitle']};};
 const reading=f.call('now',{characterId:'alpha'});await entered.promise;f.state.at+=2000;gate.release();const result=await reading;
 assert.equal(result.state,'completed');assert.equal(f.state.models,1);assert.equal(result.day,'2026-11-08');const quota=await f.call('quota.read');assert.equal(quota.day,'2026-11-09');assert.deepEqual(quota.rows,[]);
});
test('C4: authorized paused reading continues next day without replaying a model request',async t=>{
 const f=fixture({at:Date.parse('2026-11-09T04:59:59Z')});t.after(()=>f.close());await f.configure();f.state.materialHook=()=>{throw Object.assign(Error('Fixture login unavailable'),{code:'BILI_LOGIN_EXPIRED'});};
 const paused=await f.call('now',{characterId:'alpha'});assert.equal(paused.state,'paused');assert.equal(f.state.models,0);f.state.materialHook=null;f.state.at+=2000;const completed=await f.call('continue',{activityId:paused.id});assert.equal(completed.state,'completed');assert.equal(completed.day,paused.day);assert.equal(f.state.models,1);
});
const images={img_url:'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',sub_url:'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'};
for(const scenario of [
 {name:'nav -101',nav:{code:-101,data:{isLogin:false,wbi_img:images}},expected:'BILI_LOGIN_EXPIRED'},
 {name:'nav isLogin false',nav:{code:0,data:{isLogin:false,wbi_img:images}},expected:'BILI_LOGIN_EXPIRED'},
 {name:'player -101',player:{code:-101},expected:'BILI_LOGIN_EXPIRED'},
 {name:'player -352',player:{code:-352},expected:'BILI_REQUEST_RESTRICTED'},
 {name:'player -412',player:{code:-412},expected:'BILI_REQUEST_RESTRICTED'},
 {name:'player HTTP412',status:412,player:{code:-412},expected:'BILI_REQUEST_RESTRICTED'},
 {name:'signed-in without subtitles',expected:null},
])test('C6: '+scenario.name+' preserves the platform distinction at the real service seam',async t=>{
 const f=fixture();t.after(()=>f.close());await f.configure();
 const http=createBilibiliHttpPlatform({now:()=>f.state.at,request:async({url})=>{
  const path=new URL(url).pathname;
  if(path==='/x/web-interface/view')return {status:200,json:{code:0,data:{bvid:'BVtest123',aid:1,cid:2,title:'Fixture',desc:'Fixture description',owner:{name:'Fixture'},duration:30,pages:[{cid:2,page:1,duration:30}]}}};
  if(path==='/x/web-interface/nav')return {status:200,json:scenario.nav??{code:0,data:{isLogin:true,wbi_img:images}}};
  if(path==='/x/player/wbi/v2')return {status:scenario.status??200,json:scenario.player??{code:0,data:{subtitle:{subtitles:[]}}}};
  throw Error('Unexpected fixture path '+path);
 }});f.platform.selectVideo=http.selectVideo;f.platform.acquireMaterial=http.acquireMaterial;
 f.state.modelHook=async()=>({requestId:'fixture-model',usageAccounting:'core-model-router',text:JSON.stringify({summary:'Fixture title/description',evidenceRefs:['description:1'],completedMaterial:true})});
 const result=await f.call('now',{characterId:'alpha',videoId:'BVtest123'});
 assert.equal(result.state,scenario.expected?'paused':'partial');assert.equal(result.lastFailureCode??null,scenario.expected);assert.equal(f.state.models,scenario.expected?0:1);
});
test('C15: exposed Bilibili version derives from its package manifest',()=>assert.equal(VERSION,manifest.version));
