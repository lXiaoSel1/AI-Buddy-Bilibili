import test from 'node:test';
import assert from 'node:assert/strict';
import {createBilibiliHttpPlatform,signWbi} from '../src/http-platform.mjs';

const scopeArgs={context:{contextToken:'scoped-token',characterId:'alpha',lifeId:'life-1',operationId:'op-1',accountId:'account-1'},lease:{leaseId:'lease-1',generation:4}};
const images={img_url:'https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png',sub_url:'https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png'};
const view=(id='BVmarine123',pages=1)=>({code:0,data:{bvid:id,aid:123456,cid:100,title:'海洋纪录片',desc:'海洋里的动物',owner:{name:'fixture-up'},duration:30*pages,pages:Array.from({length:pages},(_,i)=>({cid:100+i,page:i+1,part:`海洋第${i+1}部分`,duration:30}))}});
const make=(options={})=>{
  const trace=[];
  const platform=createBilibiliHttpPlatform({now:()=>1702204169000,anonymousReadOnly:options.anonymousReadOnly===true,request:async r=>{
    trace.push(r);if(options.request)return options.request(r);
    const u=new URL(r.url);
    if(u.pathname==='/x/web-interface/view')return {status:200,json:view(u.searchParams.get('bvid'),options.pages??1)};
    if(u.pathname==='/x/web-interface/popular')return {status:200,json:{code:0,data:{list:[{bvid:'BVcats1234',title:'可爱猫咪',desc:'猫'},{bvid:'BVmarine123',title:'海洋纪录片',desc:'海洋'}]}}};
    if(u.pathname==='/x/web-interface/nav')return {status:200,json:{code:0,data:{wbi_img:images}}};
    if(u.pathname==='/x/player/wbi/v2')return {status:200,json:{code:0,data:{subtitle:{subtitles:options.noSubs?[]:[{lan:'zh-CN',subtitle_url:options.badURL??'//aisubtitle.hdslb.com/fixture.json?auth_key=ephemeral-fixture'}]}}}};
    if(u.hostname==='aisubtitle.hdslb.com')return {status:200,json:{body:[{from:0,to:10,content:'海洋覆盖大部分地表。'},{from:10,to:30,content:'各种动物生活在其中。'}]}};
    if(u.pathname==='/x/v2/reply/add')return {status:200,json:options.commentResult??{code:0,data:{rpid:778899}}};
    throw Error('Unexpected fixture URL');
  }});
  return {platform,trace};
};

test('HTTP fixture: explicit BV metadata -> nav -> signed player -> full subtitle; signed query never enters material/model evidence',async()=>{
  const {platform,trace}=make();const video=await platform.selectVideo({...scopeArgs,connectionRef:'opaque-account',context:{...scopeArgs.context,characterId:'alpha'},videoId:'BVmarine123'});const material=await platform.acquireMaterial({...scopeArgs,connectionRef:'opaque-account',video});
  assert.equal(video.aid,123456);assert.equal(video.cid,100);assert.equal(material.coverage,'subtitles');assert.equal(material.complete,true);assert.equal(material.items.length,2);assert.equal(material.readRange.to,30);
  assert.equal(trace.length,4);const player=trace.find(v=>v.url.includes('/x/player/'));assert.equal(new URL(player.url).searchParams.get('wts'),'1702204169');assert.match(new URL(player.url).searchParams.get('w_rid'),/^[a-f0-9]{32}$/);
  assert(trace.slice(0,3).every(r=>r.credentialBinding?.cookie===true));assert.equal(trace[3].credentialBinding,null);assert.equal(trace[3].redirect,'error');assert(!JSON.stringify(material).includes('auth_key'));assert(!JSON.stringify(material).includes('ephemeral-fixture'));
  for(const request of trace)for(const[key,value]of Object.entries({...scopeArgs.context,...scopeArgs.lease}))assert.equal(request[key],value,`All metadata/nav/player/subtitle requests retain ${key}`);
});

test('HTTP fixture: popular exploration is ranked using only this character trusted interests',async()=>{
  const {platform,trace}=make();const result=await platform.selectVideo({...scopeArgs,connectionRef:'opaque-account',context:{...scopeArgs.context,characterId:'alpha',interests:['海洋']}});assert.equal(result.videoId,'BVmarine123');assert.match(result.selectionReason,/已知兴趣/);assert.equal(new URL(trace[1].url).searchParams.get('bvid'),'BVmarine123');
});

test('HTTP fixture: missing subtitles and rejected CDN URL yield explicit description-only partial material',async()=>{
  for(const options of [{noSubs:true},{badURL:'https://untrusted.example/steal?cookie=no'}]){
    const {platform,trace}=make(options),video=await platform.selectVideo({...scopeArgs,connectionRef:'ref',context:scopeArgs.context,videoId:'BVmarine123'}),material=await platform.acquireMaterial({...scopeArgs,connectionRef:'ref',video});
    assert.equal(material.coverage,'description');assert.equal(material.complete,false);assert.match(material.coverageNotes,/仅了解标题和简介/);assert(!trace.some(r=>r.url.startsWith('https://untrusted.example')));
  }
});

test('HTTP fixture: first multipart subtitle remains partial and accurately discloses the acquired part',async()=>{
  const {platform}=make({pages:3}),video=await platform.selectVideo({...scopeArgs,connectionRef:'ref',context:scopeArgs.context,videoId:'BVmarine123'}),material=await platform.acquireMaterial({...scopeArgs,connectionRef:'ref',video});assert.equal(video.duration,30);assert.deepEqual(video.pages.map(p=>({cid:p.cid,page:p.page,duration:p.duration})),[{cid:100,page:1,duration:30},{cid:101,page:2,duration:30},{cid:102,page:3,duration:30}]);assert.equal(material.complete,false);assert.equal(material.readRange.parts,3);assert.match(material.coverageNotes,/第一分P/);
});

test('HTTP fixture: missing or invalid part duration is rejected before any player or model acquisition',async()=>{
  for(const duration of [undefined,0,-1,NaN]){
    const {platform,trace}=make({request:r=>{assert.equal(new URL(r.url).pathname,'/x/web-interface/view');const result=view();result.data.pages[0].duration=duration;return {status:200,json:result};}});
    await assert.rejects(platform.selectVideo({...scopeArgs,connectionRef:'ref',videoId:'BVmarine123'}),{code:'BILI_FULL_PART_INVALID'});assert.equal(trace.length,1);
  }
});

test('HTTP fixture: comment parameters owned by A; cookie/CSRF remain opaque managed bindings and success requires platform ID',async()=>{
  const {platform,trace}=make(),video=await platform.selectVideo({...scopeArgs,connectionRef:'opaque-account',context:scopeArgs.context,videoId:'BVmarine123'});const result=await platform.sendComment({...scopeArgs,connectionRef:'opaque-account',video,text:'关于海洋的介绍很好。',idempotencyKey:'comment-event'});assert.deepEqual(result,{status:'sent',platformId:'778899'});
  const r=trace.at(-1);assert.equal(r.url,'https://api.bilibili.com/x/v2/reply/add');assert.equal(r.method,'POST');assert.deepEqual(r.form,{type:'1',oid:'123456',message:'关于海洋的介绍很好。',plat:'1'});assert.deepEqual(r.credentialBinding.formFields,{csrf:{secretRef:'bili_jct'},csrf_token:{secretRef:'bili_jct'}});assert.equal(r.idempotencyKey,'comment-event');assert(!Object.keys(r.headers).some(k=>k.toLowerCase()==='cookie'));
  for(const[key,value]of Object.entries({...scopeArgs.context,...scopeArgs.lease}))assert.equal(r[key],value);
  const denied=make({commentResult:{code:-101}});assert.equal((await denied.platform.sendComment({...scopeArgs,connectionRef:'ref',video,text:'fixture',idempotencyKey:'deny'})).definitive,true);
  const unknown=make({commentResult:{code:0,data:{}}});assert.equal((await unknown.platform.sendComment({...scopeArgs,connectionRef:'ref',video,text:'fixture',idempotencyKey:'unknown'})).status,'unknown');
});

test('WBI protocol fixture: parameter order/forbidden characters/timestamp normalization are deterministic',()=>{
  const left=signWbi({foo:'a!b(c)*',bar:514},images,1702204169000),right=signWbi({bar:514,foo:'abc'},images,1702204169999);assert.equal(left,right);assert.match(left,/^bar=514&foo=abc&wts=1702204169&w_rid=[a-f0-9]{32}$/);assert.throws(()=>signWbi({}, {img_url:'https://example/x.png',sub_url:images.sub_url},0),{code:'BILI_WBI_UNAVAILABLE'});
});

test('runtime low-level HTTP rejects missing context or lease before any transport request',async()=>{
  const {platform,trace}=make();await assert.rejects(platform.selectVideo({connectionRef:'ref',videoId:'BVmarine123'}),{code:'BILI_HTTP_SCOPE_REQUIRED'});await assert.rejects(platform.acquireMaterial({connectionRef:'ref',video:{videoId:'BVmarine123',cid:100}}),{code:'BILI_HTTP_SCOPE_REQUIRED'});await assert.rejects(platform.sendComment({connectionRef:'ref',video:{aid:1},text:'fixture'}),{code:'BILI_HTTP_SCOPE_REQUIRED'});assert.equal(trace.length,0);
});

test('explicit anonymousReadOnly probe permits GET without personal cookies but can never send',async()=>{
  const {platform,trace}=make({anonymousReadOnly:true});const video=await platform.selectVideo({videoId:'BVmarine123'});await platform.acquireMaterial({video});assert.equal(trace.length,4);assert(trace.every(v=>v.method==='GET'&&v.anonymousReadOnly===true&&v.connectionRef===null&&v.credentialBinding===null));await assert.rejects(platform.sendComment({...scopeArgs,connectionRef:'ref',video,text:'not permitted'}),{code:'BILI_ANONYMOUS_SEND_DENIED'});assert.equal(trace.length,4);
});

test('reply/add malformed or zero rpid never becomes a successful comment receipt',async()=>{
  for(const rpid of [{},[],true,false,'',' ',0,-1,1.5,Number.MAX_SAFE_INTEGER+1,NaN,Infinity,'0','000','-1','1.5','9'.repeat(65)]){
    const {platform}=make({commentResult:{code:0,data:{rpid}}});const result=await platform.sendComment({...scopeArgs,connectionRef:'ref',video:{aid:123},text:'fixture',idempotencyKey:'malformed-receipt'});assert.equal(result.status,'unknown',`Invalid rpid: ${String(rpid)}`);assert.equal(Object.hasOwn(result,'platformId'),false);
  }
});

test('reply/add accepts positive safe integers and bounded nonzero decimal strings without losing string precision',async()=>{
  for(const rpid of [1,Number.MAX_SAFE_INTEGER,'0001','123456789012345678901234567890']){
    const {platform}=make({commentResult:{code:0,data:{rpid}}});assert.deepEqual(await platform.sendComment({...scopeArgs,connectionRef:'ref',video:{aid:123},text:'fixture',idempotencyKey:'valid-receipt'}),{status:'sent',platformId:String(rpid)});
  }
});
