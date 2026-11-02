import {createHash} from 'node:crypto';
import {assert,fail} from '../../../shared/errors.mjs';
import {normalizeVideo,normalizeMaterial} from './platform.mjs';

const API='https://api.bilibili.com';
// Fixed protocol permutation, not a credential or a copied upstream implementation.
const WBI_ORDER=[46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
function imageKey(value){let parsed;try{parsed=new URL(value);}catch{throw fail('BILI_WBI_UNAVAILABLE','The platform did not return public WBI keys');}const key=parsed.pathname.split('/').at(-1).split('.')[0];assert(/^[a-fA-F0-9]{32}$/.test(key),'BILI_WBI_UNAVAILABLE','Invalid public WBI key');return key;}
export function signWbi(parameters,images,timestamp){
  const raw=imageKey(images.img_url)+imageKey(images.sub_url),mixin=WBI_ORDER.slice(0,32).map(index=>raw[index]).join('');
  const values={...parameters,wts:Math.floor(timestamp/1000)};
  const query=Object.keys(values).sort().map(key=>encodeURIComponent(key)+'='+encodeURIComponent(String(values[key]).replace(/[!'()*]/g,''))).join('&');
  return `${query}&w_rid=${createHash('md5').update(query+mixin).digest('hex')}`;
}
function publicSubtitleURL(value){
  const parsed=new URL(String(value).startsWith('//')?'https:'+value:String(value));
  assert(parsed.protocol==='https:'&&!parsed.username&&!parsed.password&&(parsed.hostname==='hdslb.com'||parsed.hostname.endsWith('.hdslb.com')||parsed.hostname==='bilibili.com'||parsed.hostname.endsWith('.bilibili.com')),'BILI_SUBTITLE_URL_DENIED','The subtitle endpoint is outside the fixed Bilibili/CDN allowlist');
  return parsed;
}
/** A owns all platform paths, protocol parsing, signature and send parameters.
 * B provides only an authorized low-level HTTP transport and secret injection.
 * API shapes are based on pinned local research; current platform compatibility is untested. */
export function createBilibiliHttpPlatform({request,now=Date.now,anonymousReadOnly=false}){
  assert(typeof request==='function','BILI_HTTP_TRANSPORT_REQUIRED','A managed low-level HTTP transport is required');
  const headers={referer:'https://www.bilibili.com/','user-agent':'Mozilla/5.0 AI-Buddy-BilibiliCompanion/0.1'};
  function scope(context,lease){assert(['contextToken','characterId','lifeId','operationId','accountId'].every(key=>typeof context?.[key]==='string'&&context[key])&&typeof lease?.leaseId==='string'&&lease.leaseId&&Number.isSafeInteger(lease.generation),'BILI_HTTP_SCOPE_REQUIRED','Platform requests require a current trusted context and activity lease');return {contextToken:context.contextToken,leaseId:lease.leaseId,generation:lease.generation,characterId:context.characterId,lifeId:context.lifeId,operationId:context.operationId,accountId:context.accountId,sourcePluginId:'@ai-buddy/bilibili-companion'};}
  async function json(url,{connectionRef,context,lease,signal,method='GET',form=null,credential='cookie',idempotencyKey=null,maxResponseBytes=4*1024*1024}={}){
    assert(!anonymousReadOnly||method==='GET'&&!form,'BILI_ANONYMOUS_SEND_DENIED','The anonymous probe permits read-only GET requests only');
    const binding=anonymousReadOnly?{anonymousReadOnly:true}:scope(context,lease);
    if(anonymousReadOnly){credential='none';connectionRef=null;}
    const parsed=new URL(url);
    assert(parsed.protocol==='https:'&&!parsed.username&&!parsed.password&&(parsed.origin===API||credential==='none'&&(parsed.hostname.endsWith('.hdslb.com')||parsed.hostname.endsWith('.bilibili.com'))),'BILI_HTTP_URL_DENIED','Unexpected platform URL');
    const result=await request({operation:'http.request',platform:'bilibili',connectionRef,...binding,url:parsed.href,method,headers:{...headers,...(form?{'content-type':'application/x-www-form-urlencoded'}:{})},...(form?{form}:{}),credentialBinding:credential==='none'?null:{connectionRef,cookie:true,...(credential==='comment'?{formFields:{csrf:{secretRef:'bili_jct'},csrf_token:{secretRef:'bili_jct'}}}:{})},redirect:'error',maxResponseBytes,idempotencyKey,signal});
    assert(!result?.status||result.status>=200&&result.status<300,'BILI_HTTP_FAILED','The platform HTTP request failed');
    const value=result?.json??result?.body??result;
    try{return typeof value==='string'?JSON.parse(value):value;}catch{throw fail('BILI_RESPONSE_INVALID','The platform response is not JSON');}
  }
  async function metadata(videoId,connectionRef,context,lease,signal){
    let currentPage=1;if(/^https:\/\//.test(videoId)){let parsed;try{parsed=new URL(videoId);}catch{}assert(parsed&&parsed.protocol==='https:'&&(parsed.hostname==='bilibili.com'||parsed.hostname.endsWith('.bilibili.com')),'BILI_VIDEO_INVALID','Expected a Bilibili video link');videoId=/\/video\/(BV[0-9A-Za-z]+)/.exec(parsed.pathname)?.[1]??'';currentPage=Number(parsed.searchParams.get('p')??1);assert(Number.isSafeInteger(currentPage)&&currentPage>=1,'BILI_FULL_PART_INVALID','Invalid current part');}
    assert(/^BV[0-9A-Za-z]{6,30}$/.test(videoId),'BILI_VIDEO_INVALID','Choose a Bilibili BV identifier');
    const result=await json(`${API}/x/web-interface/view?bvid=${encodeURIComponent(videoId)}`,{connectionRef,context,lease,signal});
    assert(result?.code===0&&result.data?.bvid===videoId,'BILI_VIDEO_UNAVAILABLE','Video metadata is not available');
    const d=result.data;
    const page=d.pages?.find(p=>p.page===currentPage)??(currentPage===1?d.pages?.find(p=>p.cid===d.cid):null);assert(currentPage===1||page,'BILI_FULL_PART_INVALID','The requested part is unavailable');const cid=page?.cid??d.cid;return normalizeVideo({videoId:d.bvid,aid:d.aid,cid,title:d.title,owner:d.owner,duration:page?.duration??d.duration,pages:d.pages,currentPage,pageCount:d.pages?.length??1,description:d.desc,url:`https://www.bilibili.com/video/${d.bvid}${currentPage>1?'?p='+currentPage:''}`});
  }
  return {
    async selectVideo({connectionRef,context,lease,videoId,signal}){
      if(videoId)return metadata(videoId,connectionRef,context,lease,signal);
      const result=await json(`${API}/x/web-interface/popular?pn=1&ps=20`,{connectionRef,context,lease,signal});
      assert(result?.code===0&&Array.isArray(result.data?.list)&&result.data.list.length,'BILI_SELECTION_EMPTY','The platform did not return video candidates');
      const interests=(Array.isArray(context?.interests)?context.interests:[]).map(v=>typeof v==='string'?{tag:v,weight:1}:v).filter(v=>typeof v?.tag==='string'&&v.tag.length<=100);
      const scored=result.data.list.filter(v=>/^BV[0-9A-Za-z]{6,30}$/.test(v.bvid??'')).map((v,index)=>({video:v,index,score:interests.reduce((n,interest)=>n+(String(v.title??'')+' '+String(v.desc??'')+' '+String(v.tname??'')).toLowerCase().includes(interest.tag.toLowerCase())*Math.min(5,Math.max(0.1,Number(interest.weight)||1)),0)})).sort((a,b)=>b.score-a.score||a.index-b.index);
      assert(scored.length,'BILI_SELECTION_EMPTY','No valid video candidates were available');
      const selected=await metadata(scored[0].video.bvid,connectionRef,context,lease,signal);selected.selectionReason=scored[0].score>0?'匹配该角色已知兴趣的热点候选':'热点探索候选，尚不代表角色自己的观看史';return selected;
    },
    async acquireMaterial({connectionRef,context,lease,video,signal,fullReading=false}){
      if(!anonymousReadOnly)scope(context,lease);
      const v=video.cid?video:await metadata(video.videoId,connectionRef,context,lease,signal);
      let failureCode=null;
      try{
        const nav=await json(`${API}/x/web-interface/nav`,{connectionRef,context,lease,signal});
        assert(nav?.data?.wbi_img,'BILI_WBI_UNAVAILABLE','Public player signature keys are unavailable');
        const query=signWbi({bvid:v.videoId,cid:v.cid},nav.data.wbi_img,now());
        const player=await json(`${API}/x/player/wbi/v2?${query}`,{connectionRef,context,lease,signal});
        assert(player?.code===0,'BILI_PLAYER_UNAVAILABLE','Player metadata is unavailable');
        const tracks=player.data?.subtitle?.subtitles??[];
        const track=tracks.find(v=>v.lan==='zh-CN')??tracks.find(v=>v.lan==='ai-zh')??tracks.find(v=>String(v.lan).startsWith('zh'))??tracks[0];
        if(track){
          const subtitleURL=publicSubtitleURL(track.subtitle_url);
          const subtitle=await json(subtitleURL.href,{connectionRef,context,lease,signal,credential:'none',maxResponseBytes:fullReading?64*1024*1024:4*1024*1024});
          assert(Array.isArray(subtitle?.body)&&subtitle.body.length,'BILI_SUBTITLE_EMPTY','Subtitle track is empty');
          assert(subtitle.body.length<=(fullReading?200000:20000),'BILI_FULL_TEXT_CAPACITY','The subtitle track exceeds retained material capacity; no rows were dropped');
          const items=subtitle.body.map((line,index)=>({id:`subtitle:${index+1}`,text:String(line.content??''),start:Number(line.from),end:Number(line.to)})).filter(v=>v.text&&Number.isFinite(v.start)&&Number.isFinite(v.end)&&v.start>=0&&v.end>=v.start);
          assert(items.length===subtitle.body.length,'BILI_SUBTITLE_INVALID','Subtitle track contained invalid rows');
          // Signed query strings are never stored in notes, model inputs or source references.
          return normalizeMaterial({videoId:v.videoId,videoCid:v.cid,coverage:'subtitles',complete:fullReading||v.pageCount===1,items,sourceRefs:[v.url,`${subtitleURL.origin}${subtitleURL.pathname}`],readRange:{part:v.currentPage??1,parts:v.pageCount,cid:v.cid,language:track.lan,from:items[0].start,to:items.at(-1).end,scope:'subtitle-track'},coverageNotes:fullReading?'取得该P完整字幕轨道；逐字符分页和画面覆盖分别核对。':v.pageCount===1?'取得完整字幕轨道；没有声称读懂字幕以外画面。':'只读取第一分P字幕，未看完整个多分P视频。',fetchedAt:now()},v,{fullReading});
        }
        failureCode='BILI_NO_SUBTITLE';
      }catch(error){if(signal?.aborted)throw error;if(fullReading)throw fail(error.code?.startsWith('BILI_FULL_')?error.code:'BILI_FULL_SUBTITLE_UNAVAILABLE','The subtitle acquisition failed; complete reading is paused rather than dropping its text');failureCode=error.code??'BILI_MATERIAL_UNAVAILABLE';}
      return normalizeMaterial({videoId:v.videoId,coverage:'description',complete:false,items:[{id:'description:1',text:`标题：${v.title}\n简介：${v.description||'未提供简介'}`}],sourceRefs:[v.url],readRange:{scope:'title-description',part:1,parts:v.pageCount},coverageNotes:`仅了解标题和简介；字幕/画面/ASR未取得（${failureCode}）。`,fetchedAt:now()},v);
    },
    async sendComment({connectionRef,context,lease,video,text,idempotencyKey,signal}){
      assert(!anonymousReadOnly,'BILI_ANONYMOUS_SEND_DENIED','The anonymous probe cannot send comments');scope(context,lease);
      assert(Number.isSafeInteger(video.aid)&&video.aid>0,'BILI_COMMENT_TARGET_INVALID','A verified video AID is required');
      try{
        const response=await json(`${API}/x/v2/reply/add`,{connectionRef,context,lease,signal,method:'POST',form:{type:'1',oid:String(video.aid),message:text,plat:'1'},credential:'comment',idempotencyKey});
        const rpid=response?.data?.rpid;
        const platformId=Number.isSafeInteger(rpid)&&rpid>0?String(rpid):typeof rpid==='string'&&/^\d{1,64}$/.test(rpid)&&/[1-9]/.test(rpid)?rpid:null;
        if(response?.code===0&&platformId!==null)return {status:'sent',platformId};
        if(Number.isFinite(response?.code)&&response.code!==0)return {status:'failed',definitive:true,code:'BILI_PLATFORM_COMMENT_REJECTED'};
        return {status:'unknown'};
      }catch{return {status:'unknown'};}
    },
  };
}
