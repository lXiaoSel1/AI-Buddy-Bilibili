export const CLIENT_PLUGIN_ID='@ai-buddy/bilibili-companion';
export function activityTarget({url=null,detail=null}={}){
  let id=null;
  if(detail){if(detail.pluginId!==CLIENT_PLUGIN_ID)return null;id=detail.activityId;}
  else if(url){try{id=new URL(url,'https://local.invalid').searchParams.get('activityId');}catch{return null;}}
  return typeof id==='string'&&id.length>0&&id.length<=300?id:null;
}
export function selectActivity(activities,id){return typeof id==='string'&&Array.isArray(activities)?activities.find(v=>v.id===id)??null:null;}
// One label and tone per comment state. "approved" is a preview the user pressed Post on; "discarded" was dropped unposted.
const COMMENT_STATES={
  draft:['草稿，尚未发送','Draft, not posted','warn'],generating:['正在生成评论','Writing','busy'],approved:['正在发表','Posting','busy'],sending:['正在发送','Posting','busy'],
  sent:['已发送','Posted','ok'],failed:['发送失败','Failed','err'],unknown:['发送结果未知，等待核对','Result unknown, checking','warn'],discarded:['已放弃，没有发表','Discarded, not posted','muted'],
};
export function commentStatusLabel(comment,lang='zh-CN'){const row=COMMENT_STATES[comment?.state];return row?(lang==='en'?row[1]:row[0]):(lang==='en'?'Waiting':'等待处理');}
export const commentStatusTone=comment=>COMMENT_STATES[comment?.state]?.[2]??'muted';
