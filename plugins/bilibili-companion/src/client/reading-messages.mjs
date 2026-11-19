export const READING_MESSAGES={
 MODEL_IMAGE_TRANSPORT_UNSUPPORTED:['当前模型连接无法传图片，请换成支持图片输入的连接。','The current model connection cannot send images. Choose a connection that supports image input.'],
 SOCIAL_UNOBSERVED_MATERIAL:['这次重试缺少字幕来源记录，请重新获取材料。','This retry is missing subtitle source records. Obtain the material again.'],
 BILI_VISION_READING_UNAVAILABLE:['暂时无法读取本次观看的检查点。请重试状态。','The checkpoint for this viewing could not be read. Retry the status check.'],
 BILI_FULL_CHECKPOINT_ABSENT:['这次观看还没生成计划，没有可继续的进度。','This viewing has no plan and no progress to resume.'],
 BILI_FULL_CUES_INVALID:['字幕结构不符合要求。请核对分P的字幕，或选择其他分P重新准备计划。','The subtitle structure is invalid. Check the subtitles for this part, or choose another part and prepare a new plan.'],
};

const SUBTITLE_STRUCTURE={
 'invalid-tracks':['字幕轨道列表无效','Invalid subtitle track list'],
 'invalid-track':['字幕轨道与分P不匹配，或同一分P有重复轨道','Subtitle tracks do not match the part, or the part has duplicate tracks'],
 'empty-track':['字幕轨道为空','Empty subtitle track'],
 'invalid-id':['字幕条目编号无效','Invalid subtitle cue ID'],
 'invalid-text':['字幕条目的文本为空或格式无效','A subtitle cue has empty or invalid text'],
 'invalid-time':['字幕条目的时间格式无效','A subtitle cue has invalid timing values'],
 'duplicate-cue':['字幕编号重复','Duplicate subtitle cue ID'],
};

export function readingMessage(T,code,details){
 if(!Object.hasOwn(READING_MESSAGES,code))return null;
 const message=READING_MESSAGES[code];
 const structural=code==='BILI_FULL_CUES_INVALID'&&Object.hasOwn(SUBTITLE_STRUCTURE,details?.reason)?SUBTITLE_STRUCTURE[details.reason]:null;
 const part=structural&&Number.isSafeInteger(details.page)&&details.page>0?'P'+details.page+' · ':'';
 return (structural?part+T(...structural)+' · ':'')+T(...message);
}

export function subtitleNotice(T,notice){
 if(!Number.isSafeInteger(notice?.page)||notice.page<1)return null;
 const part='P'+notice.page+' · ';
 if(notice.reason==='shifted'){
  const hours=notice.timebaseShiftSeconds/3600;
  if(!Number.isSafeInteger(hours)||hours<1)return null;
  return part+T('字幕整体偏了 {n} 小时，已校正。',hours===1?'Subtitles were offset by {n} hour. The timing has been corrected.':'Subtitles were offset by {n} hours. The timing has been corrected.').replace('{n}',hours);
 }
 if(['out-of-range','ambiguous','partial'].includes(notice.reason))return part+T('这条字幕的时间和视频对不上，已跳过字幕。','The subtitle timing did not match the video. This subtitle track was skipped.');
 return null;
}
