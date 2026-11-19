const SUMMARY_PAUSED=['本次整理未能缩短笔记，结果已保存，已暂停后续调用。','This consolidation did not shorten the notes. The result was saved, and further calls are paused.'];
const REASONS={BUDDY_SOCIAL_DENIED:['阅读许可被拒绝。已有记录保留，已提交或待核对请求不会自动重发。','Reading permission was denied. Existing records are retained; submitted or uncertain requests are not replayed automatically.'],BILI_FULL_MATERIAL_NOT_COMPLETED:['模型已返回，但字段或证据不完整。原回执已保留，未增加阅读覆盖；本次不会自动重新收费调用。','The model returned an incomplete schema or evidence. Its original receipt is retained and reading coverage was not increased. This request will not be submitted again automatically.'],BILI_FULL_SUMMARY_NO_PROGRESS:SUMMARY_PAUSED,BILI_FULL_SUMMARY_GRAPH_CHANGED:SUMMARY_PAUSED,BILI_VISION_MODEL_CHANGED_RESTART_REQUIRED:['模型已变化，请停止此记录，再开始一次新阅读；原记录仍保留。','The model changed. Stop this reading, then start a new one. Existing records are retained.'],BILI_VISION_CACHE_FULL:['分镜缓存已满，请先停止不再需要的旧阅读，再重试。','The storyboard cache is full. Stop old readings you no longer need, then retry.'],BILI_VISION_MODEL_UNSUPPORTED:['本次阅读模型未确认支持图片。请到 AI 酱中检查观看角色的模型绑定与 API 配置。停止旧阅读后再开始新阅读，已有记录保留。','The model for this reading is not confirmed to support images. Check the viewing character’s model binding and API settings in AI Buddy. Stop the old reading before starting a new one; existing records are retained.'],BILI_VISION_BUDGET_EXHAUSTED:['本次16次调用额度已用完，尚未读完。','The 16-call allowance is used up; this reading is incomplete.'],BILI_VISION_CACHE_MISSING:['分镜缓存已失效，文字记录仍保留。','The storyboard cache has expired. Text notes are retained.'],BILI_VISION_NO_PREVIEWS:['暂时取不到预览图，尚未进行画面阅读。','Preview images are unavailable; no visual reading has started.']};
export const SUMMARY_INCOMPLETE=['画面与字幕已读完，感想尚未完成。','The frames and subtitles have been read; the notes are not complete.'];

export function readingPauseMessage(T,code,info){
 return readingMessage(T,info?.failureCauseCode??code,info?.failureDetails)??(Object.hasOwn(REASONS,code)?T(...REASONS[code]):null);
}

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
