import {assert} from '../../../shared/errors.mjs';

export function scheduleContent(payload={}){
 const watchMode=payload.watchMode??(payload.videoId?'video':'interest');
 assert(['interest','video'].includes(watchMode),'BILI_SCHEDULE_INVALID','Choose what this plan will watch');
 if(watchMode==='interest'){assert(payload.videoId==null||payload.videoId==='','BILI_SCHEDULE_INVALID','An interest plan cannot carry a fixed video');return {watchMode,videoId:null};}
 assert(typeof payload.videoId==='string'&&payload.videoId.length<=2048,'BILI_SCHEDULE_INVALID','Choose a Bilibili video');
 let videoId=payload.videoId.trim();
 if(!/^BV[0-9A-Za-z]{6,30}$/.test(videoId)){
  let url;try{url=new URL(videoId);}catch{}
  assert(url?.protocol==='https:'&&!url.username&&!url.password&&['bilibili.com','www.bilibili.com','m.bilibili.com'].includes(url.hostname)&&!url.port,'BILI_SCHEDULE_INVALID','Choose a Bilibili HTTPS video link');
  videoId=/^\/video\/(BV[0-9A-Za-z]{6,30})\/?$/.exec(url.pathname)?.[1];
 }
 assert(/^BV[0-9A-Za-z]{6,30}$/.test(videoId??''),'BILI_SCHEDULE_INVALID','Choose a valid BV identifier');
 return {watchMode,videoId};
}
