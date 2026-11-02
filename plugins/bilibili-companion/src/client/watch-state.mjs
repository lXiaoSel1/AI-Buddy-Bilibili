const revision=value=>Number.isSafeInteger(value)&&value>=0?value:0;
export function olderReading(next,previous){
 if(!previous)return false;
 const activity=revision(next.activityRevision),prior=revision(previous.activityRevision??previous.statusRevision);
 return activity<prior||activity===prior&&revision(next.readingRevision)<revision(previous.readingRevision);
}
export function currentReadingReason(state){
 return state?.needsReview===true||['paused','unknown','failed','partial','stopped','cancelled'].includes(state?.phase)?state.modelReason??state.pauseReason??null:null;
}
export function readingActivityStatus(activity,state,id){
 if(!activity||activity.id!==id||olderReading(state,activity))return activity;
 const phase=({reading:'understanding','awaiting-confirmation':'paused',unknown:'paused',stopped:'cancelled'})[state.phase]??state.phase;
 if(!['selecting','acquiring-material','understanding','recording','paused','completed','partial','failed','cancelled'].includes(phase))return activity;
 const reason=currentReadingReason(state);
 return {...activity,state:phase,statusRevision:revision(state.activityRevision),readingRevision:revision(state.readingRevision),pauseReason:reason,lastFailureCode:reason?state.modelReason??null:null,needsReview:state.needsReview===true};
}
export function readingWatchStatus(previous,state,id){
 if(!previous||previous.activityId!==id)return previous;
 const activityRevision=revision(state.activityRevision),readingRevision=revision(state.readingRevision);
 if(activityRevision<revision(previous.activityRevision)||activityRevision===revision(previous.activityRevision)&&readingRevision<revision(previous.readingRevision))return previous;
 const confirmed=state.confirmed===true,phase=state.phase==='reading'?'understanding':state.phase;
 return {...previous,activityRevision,readingRevision,confirmed,state:phase,awaitingConfirmation:!confirmed&&['awaiting-confirmation','paused'].includes(state.phase),reason:currentReadingReason(state),needsReview:state.needsReview===true};
}
export function watchFeedback(status,activity){
 if(!status||!activity||activity.id!==status.activityId)return status;
 if(Number.isSafeInteger(status.activityRevision)&&revision(activity.statusRevision)<=status.activityRevision)return status;
 return {...status,...activity,activityId:activity.id,activityRevision:revision(activity.statusRevision),awaitingConfirmation:activity.readingMode==='full-v1'&&activity.pauseReason==='BILI_FULL_PLAN_CONFIRMATION_REQUIRED',reason:activity.lastFailureCode??activity.pauseReason??null};
}
