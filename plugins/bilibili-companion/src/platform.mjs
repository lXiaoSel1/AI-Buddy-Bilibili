import {assert,fail} from '../../../shared/errors.mjs';

const cleanText=(value,max=30000)=>typeof value==='string'?value.slice(0,max):'';
export const isPlatformMessageId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,299}$/.test(value);
export function normalizeMaterial(raw,video,{fullReading=false}={}){
  assert(raw&&typeof raw==='object','BILI_MATERIAL_INVALID','Video material is unavailable');
  const coverage=['subtitles','frames','audio-transcript','description'].includes(raw.coverage)?raw.coverage:'description';
  assert(Array.isArray(raw.items)&&raw.items.length<=(fullReading?200000:20000),'BILI_MATERIAL_INVALID','Expected a bounded list of readable evidence rows');
  if(fullReading)assert(raw.items.reduce((n,v)=>n+(typeof v.text==='string'?v.text.length:0),0)<=64*1024*1024,'BILI_FULL_TEXT_CAPACITY','The full text exceeds the retained material budget; reading is paused');
  const ids=new Set();let truncated=false;
  const items=raw.items.map(v=>{
    assert(v&&typeof v.id==='string'&&v.id.length>0&&v.id.length<=300&&!ids.has(v.id)&&(typeof v.text==='string'&&v.text.length>0||typeof v.imageRef==='string'&&v.imageRef.length>0&&v.imageRef.length<=2000),'BILI_MATERIAL_INVALID','Every material row needs a unique valid identity and content');ids.add(v.id);
    for(const key of ['start','end'])if(v[key]!==undefined)assert(Number.isFinite(v[key])&&v[key]>=0,'BILI_MATERIAL_INVALID','Invalid material time range');
    if(v.start!==undefined&&v.end!==undefined)assert(v.end>=v.start,'BILI_MATERIAL_INVALID','Invalid material time range');
    if(typeof v.text==='string'&&v.text.length>30000&&!fullReading)truncated=true;
    if(fullReading)assert(typeof v.text!=='string'||v.text.length<=16*1024*1024,'BILI_FULL_TEXT_CAPACITY','A cue exceeds retained material capacity; it has not been truncated');
    return {id:v.id,...(typeof v.text==='string'?{text:fullReading?v.text:cleanText(v.text)}:{}),...(typeof v.imageRef==='string'?{imageRef:v.imageRef}:{}),...(Number.isFinite(v.start)?{start:v.start}:{}),...(Number.isFinite(v.end)?{end:v.end}:{})};
  });
  assert(items.length>0,'BILI_NO_MATERIAL','No readable video material was returned');
  assert(!raw.videoId||raw.videoId===video.videoId,'BILI_MATERIAL_MISMATCH','Material belongs to another video');
  assert(!Number.isSafeInteger(raw.videoCid)||!Number.isSafeInteger(video.cid)||raw.videoCid===video.cid,'BILI_MATERIAL_MISMATCH','Cached material belongs to another video part');
  return {videoId:video.videoId,videoCid:video.cid??raw.videoCid??null,coverage,items,complete:raw.complete===true&&coverage!=='description'&&!truncated,sourceRefs:Array.isArray(raw.sourceRefs)?raw.sourceRefs.filter(v=>typeof v==='string').slice(0,100):[],readRange:raw.readRange??null,coverageNotes:cleanText(raw.coverageNotes,3000)+(truncated?' 材料文本已按技术上限截断，不标为完整观看。':''),fetchedAt:Number.isFinite(raw.fetchedAt)?raw.fetchedAt:null};
}
export function normalizeVideo(raw){
  const videoId=String(raw?.videoId??raw?.bvid??'');
  assert(/^(?:BV[0-9A-Za-z]+|av\d+|[A-Za-z0-9][A-Za-z0-9_-]{0,99})$/.test(videoId),'BILI_VIDEO_INVALID','Invalid video identity');
  const url=raw.url??`https://www.bilibili.com/video/${encodeURIComponent(videoId)}`;
  let parsed;try{parsed=new URL(url);}catch{throw fail('BILI_VIDEO_INVALID','Invalid video URL');}
  assert(parsed.protocol==='https:'&&(parsed.hostname==='bilibili.com'||parsed.hostname.endsWith('.bilibili.com'))&&!parsed.username&&!parsed.password,'BILI_VIDEO_INVALID','Expected a Bilibili HTTPS video URL');
  const pages=Array.isArray(raw.pages)?raw.pages.map((p,i)=>{assert(Number.isSafeInteger(p.cid)&&p.cid>0&&Number.isFinite(p.duration)&&p.duration>0,'BILI_FULL_PART_INVALID','Invalid part metadata');return {cid:p.cid,page:Number.isSafeInteger(p.page)?p.page:i+1,title:cleanText(p.title??p.part,1000),duration:p.duration};}):null;
  return {videoId,title:cleanText(raw.title,1000)||videoId,author:cleanText(raw.author??raw.owner?.name,500),url:parsed.href,...(Number.isSafeInteger(raw.aid)?{aid:raw.aid}:{}),...(Number.isSafeInteger(raw.cid)?{cid:raw.cid}:{}),...(Number.isFinite(raw.duration)?{duration:raw.duration}:{}),...(pages?{pages,currentPage:Number.isSafeInteger(raw.currentPage)?raw.currentPage:pages.find(p=>p.cid===raw.cid)?.page??1}:{}),pageCount:Number.isInteger(raw.pageCount)?raw.pageCount:1,description:cleanText(raw.description??raw.desc,30000),selectionReason:cleanText(raw.selectionReason,1000)};
}
/** Managed transport only. No credential files, global environment or implicit network requests. */
export function createManagedBilibiliPlatform({request}){
  assert(typeof request==='function','BILI_CONNECTION_UNAVAILABLE','A managed Bilibili connection is required');
  return {
    async selectVideo({connectionRef,context,videoId,signal}){
      const result=await request({platform:'bilibili',connectionRef,operation:videoId?'video.info':'video.select',parameters:{videoId:videoId??null,characterId:context.characterId},signal});
      return normalizeVideo(result.video??result);
    },
    async acquireMaterial({connectionRef,context,video,signal}){
      const result=await request({platform:'bilibili',connectionRef,operation:'video.material',parameters:{videoId:video.videoId,characterId:context.characterId},signal});
      return normalizeMaterial(result.material??result,video);
    },
    async sendComment({connectionRef,video,text,idempotencyKey,signal}){
      const result=await request({platform:'bilibili',connectionRef,operation:'comment.send',parameters:{videoId:video.videoId,text,idempotencyKey},signal});
      if(result.status==='sent'&&isPlatformMessageId(result.platformId))return {status:'sent',platformId:result.platformId};
      if(result.status==='failed'&&result.definitive===true)return {status:'failed',code:result.code??'BILI_COMMENT_FAILED'};
      return {status:'unknown'};
    },
  };
}
