// Public service fixture promoted from the frozen batch audit; external host/platform only are simulated.
import {mkdtempSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createBilibiliService} from '../../src/service.mjs';

export const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
export const gate=()=>({entered:deferred(),release:deferred()});
const clone=v=>structuredClone(v);
export async function fixture(t,{mode='full',batches=1}={}){
 const root=process.env.AI_BUDDY_PLUGIN_TEST_ROOT??fileURLToPath(new URL('../../../../../../test-data/',import.meta.url));mkdirSync(root,{recursive:true});
 const databasePath=join(mkdtempSync(join(root,'bili-lifecycle-')),'plugin.sqlite');
 const state={models:[],leases:[],finishes:[],events:new Map(),contexts:new Map(),hostRecords:new Map(),sends:[],offers:[],gates:new Map(),at:Date.parse('2026-11-01T12:00:00Z'),life:'life',operation:'operation',persona:'persona',generation:1,afterModelCheckGate:null};
 const video={videoId:'BV12345678',cid:123,duration:6,title:'Lifecycle fixture',pages:[{cid:123,page:1,duration:6}]};
 let contextNumber=0;
 const waitGate=async name=>{const g=state.gates.get(name);if(g){state.gates.delete(name);g.entered.resolve();await g.release.promise;}};
 const host={async describe(){await waitGate('describe');return {features:mode==='full'?['bilibili-vision-v1','bilibili-full-reading-v1']:mode==='visual'?['bilibili-vision-v1']:[]};},async invoke(method,payload,{signal}={}){
  if(method==='social.context.read'){
   if(payload.purpose==='manage-plugin'){await waitGate('manage-plugin');return {contextToken:'manage',accountId:'account',permissions:['plugin.manage'],managedConnections:[{ref:'account',label:'Account',platform:'bilibili'},{ref:'model',label:'Model',platform:'model'}],availableCharacters:[{id:'alpha',label:'Alpha'}]};}
   if(payload.purpose==='plugin-background')return {contextToken:'background',accountId:'account',permissions:['plugin.activity']};
   await waitGate(payload.purpose);
   const context={connectionRef:payload.modelConnectionRef??'model',accountId:'account',characterId:payload.characterId,lifeId:state.life,operationId:state.operation,personaId:state.persona,generation:state.generation,contextToken:'context-'+(++contextNumber)};state.contexts.set(context.contextToken,context);return context;
  }
  if(method==='activity.lease'){state.leases.push(clone(payload));await waitGate('lease');return {leaseId:'lease-'+state.leases.length,generation:state.generation};}
  if(method==='activity.check'){await waitGate('check');return {valid:true,...state.contexts.get(payload.contextToken)};}
  if(method==='activity.finish'){state.finishes.push(clone(payload));await waitGate('finish');return {finished:true};}
  if(method==='ui.bubble')return {ok:true};
  if(method==='experience.append'){await waitGate('experience');state.events.set(payload.idempotencyKey,clone(payload));return {recorded:true,eventId:payload.eventId};}
  if(method==='proactive.offer'){state.offers.push(clone(payload));await waitGate('offer');return {accepted:true};}
  if(method==='connections.request'){
   const p=payload.parameters,op=payload.operation.split('.').at(-1);let reading=state.hostRecords.get(p.readingId);
   if(payload.operation.includes('storyboard')){
    if(op==='prepare')return {readingId:p.readingId,segments:[{id:'segment-1',from:0,to:6}],cells:[]};
    if(op==='read')return {visualMaterialRefs:['sheet:frame-1'],cells:[],source:'video-scenes'};
    if(op==='get')return {readingId:p.readingId,phase:'reading',materialMissing:[]};
    if(op==='stop')return {stopped:true};
    throw Error(payload.operation);
   }
   if(op==='prepare'){reading={readingMode:'full-v1',readingId:p.readingId,planHash:'plan-'+p.readingId,revision:1,confirmed:false,phase:'awaiting-confirmation',model:{connectionRef:'model'},config:p.config,parts:[{cid:123,page:1,duration:6}],sheetRef:'sheet',calls:[],progress:{completed:0,total:batches},coverage:{images:{completed:0,total:1},cues:{completed:0,total:1},complete:false},needsReview:false,finalProviderRequestId:null};state.hostRecords.set(p.readingId,reading);return clone(reading);}
   if(!reading)throw Error('Missing prepared host reading');
   if(op==='get'){const value=clone(reading);await waitGate('get');return value;}
   if(op==='confirm'){reading.confirmed=true;reading.phase='reading';return clone(reading);}
   if(op==='pause'){reading.phase='paused';reading.modelReason='BILI_FULL_PAUSED';return clone(reading);}
   if(op==='stop'){await waitGate('stop');if(p.onlyIfUnconfirmed===true){if(reading.confirmed)throw Object.assign(Error('Confirmed plan is frozen'),{code:'BILI_FULL_PLAN_FROZEN'});if(p.planHash!==reading.planHash||p.revision!==reading.revision||!['awaiting-confirmation','paused'].includes(reading.phase))throw Object.assign(Error('A newer control changed the preview'),{code:'BILI_CONTROL_STALE'});}if(reading.phase!=='completed')reading.phase='cancelled';return clone(reading);}
   if(op==='read'){const index=reading.calls.length+1;return {batchId:'batch-'+index,stepKind:index===batches?'summary':'segment',finalSummary:index===batches,summaryOutputChars:10000,inputHash:'input-'+index,visualMaterialRefs:['sheet'],material:{videoId:video.videoId,coverage:'frames',complete:false,sourceRefs:[],items:[{id:'frame-'+index,imageRef:'sheet'}],coverageNotes:'Fixture'}};}
   throw Error(payload.operation);
  }
  if(method==='models.request'){
   state.models.push(clone(payload));const reading=state.hostRecords.get(payload.readingId);
   const provider='provider-'+state.models.length;
   if(reading){reading.calls.push({stepId:payload.stepId,status:'completed',processed:true,providerRequestId:provider});reading.progress.completed++;if(reading.calls.length===batches){reading.phase='completed';reading.coverage={images:{completed:1,total:1},cues:{completed:1,total:1},complete:true};reading.finalProviderRequestId=provider;}}
   const result=payload.purpose==='bilibili-comment'?{requestId:provider,comment:{text:'A fixture comment',evidenceRefs:[payload.material.items[0].id]}}:{requestId:provider,understanding:{summary:'Summary '+(payload.stepId??'legacy'),notes:'Notes '+(payload.stepId??'legacy'),evidenceRefs:[payload.material.items[0].id],completedMaterial:true,shareWorthy:false,commentWorthy:false,shareText:'',interestTags:[]}};
   if(state.afterModelCheckGate){state.gates.set('check',state.afterModelCheckGate);state.afterModelCheckGate=null;}
   await waitGate('model');await state.onModelResult?.(payload,result);return result;
  }
  throw Error(method);
 }};
 const platform={async selectVideo(){return video;},async acquireMaterial(){return {videoId:video.videoId,videoCid:123,coverage:'subtitles',complete:true,items:[{id:'subtitle:1',start:0,end:1,text:'Original subtitle'}],readRange:{language:'zh-CN',cid:123}};},async sendComment(payload){state.sends.push(clone({...payload,signal:undefined}));await waitGate('send');return {status:'sent',platformId:'comment-1'};}};
 const options={databasePath,host,platform,now:()=>state.at,timeZone:'UTC',runtimeOwnerInspector:pid=>({pid,exe:'fixture',birth:'fixture'})};let service=createBilibiliService(options);
 t.after(async()=>{for(const g of state.gates.values())g.release.resolve();await service.close();});
 const call=(action,payload={})=>service.dispatch(action,payload,{contextToken:'app'});
 const readKV=key=>{const db=new DatabaseSync(databasePath,{readOnly:true});try{const row=db.prepare('SELECT value FROM a_plugin_kv WHERE key=?').get(key);return row?JSON.parse(row.value):null;}finally{db.close();}};
 const writeKV=(key,value)=>{const db=new DatabaseSync(databasePath);try{db.prepare('INSERT INTO a_plugin_kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));}finally{db.close();}};
 await call('settings.update',{connectionRef:'account',modelConnectionRef:'model',shareMode:'record-only',autonomousEnabled:false});
 return {state,call,readKV,writeKV,databasePath,service,close:()=>service.close(),restart:async()=>{await service.close();service=createBilibiliService(options);},gateNext:name=>{const g=gate();state.gates.set(name,g);return g;}};
}
