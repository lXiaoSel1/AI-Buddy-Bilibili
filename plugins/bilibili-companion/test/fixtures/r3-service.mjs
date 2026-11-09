import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createBilibiliService} from '../../src/service.mjs';
import {createManagedBilibiliPlatform} from '../../src/platform.mjs';

const dataRoot=process.env.AI_BUDDY_PLUGIN_TEST_ROOT??fileURLToPath(new URL('../../../test-data/',import.meta.url));
mkdirSync(dataRoot,{recursive:true});
const owner={contextToken:'owner-token'};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(options={}){
  const directory=mkdtempSync(join(dataRoot,'bili-')),databasePath=join(directory,'plugin.sqlite');
  const state={at:Date.parse('2026-10-25T17:00:00Z'),sleeping:false,life:'life-1',operation:'operation-1',generation:1,selects:0,materials:0,models:0,sends:0,offers:[],events:new Map(),calls:[],blockExperience:false,blockOffer:false,invalidLease:false,leases:new Map(),...options};
  const catalog=()=>state.managedConnections??[{ref:'managed-bilibili',label:'测试B站连接',platform:'bilibili'},{ref:'managed-model',label:'测试活动模型',platform:'model',provider:state.provider}];
  const host={async invoke(method,payload,opts={}){
    state.calls.push({method,payload});
    if(method==='social.context.read'){
      if(payload.purpose==='plugin-background')return {accountId:'account-1',managedConnections:catalog(),permissions:payload.principal?.contextToken==='background-token'?['plugin.activity']:[]};
      if(payload.purpose==='manage-plugin')return payload.principal?.contextToken==='owner-token'?{accountId:'account-1',permissions:['plugin.manage'],sourceMode:'proposal-mock',availableCharacters:state.availableCharacters??[{id:'alpha',label:'甲角色'},{id:'beta',label:'乙角色'}],managedConnections:catalog()}:{accountId:'account-1',permissions:[]};
      return {connectionRef:payload.modelConnectionRef??'managed-model',contextToken:`context:${payload.characterId}:${state.life}`,accountId:'account-1',characterId:payload.characterId,personaId:'persona-1',lifeId:state.life,operationId:state.operation,generation:state.generation,sleeping:state.sleeping,appCurrentCharacterId:'app-character',sourceMode:'proposal-mock'};
    }
    if(method==='activity.lease'&&state.failLease)throw Object.assign(Error('lease refused'),{code:'BUDDY_LEASE_DENIED'});if(method==='activity.lease'){/* like the social host: an ended activity id is never leased again */const lease=state.leases.get(payload.activityId);if(lease==='ended')throw Object.assign(Error('Activity already ended or belongs to another scope'),{code:'BUDDY_SOCIAL_DENIED'});state.leases.set(payload.activityId,'active');return {leaseId:`lease:${payload.activityId}`,generation:state.generation,expiresAt:state.at+300000};}
    if(method==='activity.check')return {valid:!state.invalidLease,characterId:payload.characterId,lifeId:payload.lifeId,operationId:payload.operationId,generation:payload.generation};
    if(method==='activity.finish'){/* like the social host: only a terminal status ends the lease */if(!['completed','failed','cancelled','unknown'].includes(payload.status))throw Object.assign(Error('Invalid activity terminal state'),{code:'BUDDY_SOCIAL_DENIED'});state.leases.set(payload.activityId,'ended');return {ok:true};}if(method==='ui.bubble')return {ok:true};
    if(method==='models.request'){
      state.models++;
      if(state.modelHook)return state.modelHook(payload,opts);
      if(payload.purpose==='bilibili-comment')return {requestId:`mock-request-${state.models}`,text:JSON.stringify({text:'这段对海洋的介绍很有意思。',evidenceRefs:['subtitle:1']})};
      return {requestId:`mock-request-${state.models}`,usageAccounting:'core-model-router',text:JSON.stringify({summary:'关于海洋的材料摘要',notes:'只基于实际取得的字幕。',evidenceRefs:state.badRefs?['not-read']:['subtitle:1'],completedMaterial:true,shareWorthy:state.shareWorthy===true,commentWorthy:state.commentWorthy===true,shareText:'刚看了一段海洋介绍。',interestTags:['海洋']})};
    }
    if(method==='experience.append'){
      if(state.blockExperience||!payload.contextToken.endsWith(state.life))throw Object.assign(Error('old context unavailable'),{code:'BUDDY_CONTEXT_EXPIRED'});
      if(!state.events.has(payload.idempotencyKey))state.events.set(payload.idempotencyKey,payload);
      return {recorded:true,eventId:payload.eventId};
    }
    if(method==='proactive.offer'){state.offers.push(payload);if(state.blockOffer)throw Object.assign(Error('not yet'),{code:'PROACTIVE_TEMPORARY'});return {accepted:true};}
    throw Object.assign(Error(`unsupported ${method}`),{code:'BUDDY_METHOD_UNKNOWN'});
  }};
  const platform={async selectVideo(){state.selects++;return {videoId:'BVtest123',title:'海洋介绍',author:'fixture',url:'https://www.bilibili.com/video/BVtest123'};},async acquireMaterial(){state.materials++;if(state.materialHook)return state.materialHook();return {videoId:'BVtest123',coverage:state.description?'description':'subtitles',complete:!state.description,items:[{id:'subtitle:1',text:'海洋覆盖了地球大部分表面。'}],sourceRefs:['fixture:subtitle']};},async sendComment(input){state.sends++;state.lastText=input?.text;if(state.sendHook)return state.sendHook();return state.unknownSend?{status:'unknown'}:{status:'sent',platformId:'platform-1'};}};
  let service=createBilibiliService({databasePath,host,platform,now:()=>state.at,timeZone:'America/New_York'});
  const call=(action,payload={},principal=owner)=>service.dispatch(action,payload,principal);
  return {state,host,platform,databasePath,call,get service(){return service;},async configure(settings={}){return call('settings.update',{connectionRef:'managed-bilibili',modelConnectionRef:'managed-model',...settings});},async reopen(){await service.close();service=createBilibiliService({databasePath,host,platform,now:()=>state.at,timeZone:'America/New_York'});return service;},async close(){await service.close();}};
}

export {fixture,owner};
