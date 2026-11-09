import manifest from '../package.json' with {type:'json'};
export const PLUGIN_ID='@ai-buddy/bilibili-companion';
export const VERSION=manifest.version;
export const DEFAULTS=Object.freeze({autonomousEnabled:false,visualAutoApproved:false,sampleSeconds:.5,windowSeconds:6,maxConcurrent:1,dailyWatchLimit:5,dailyCommentLimit:3,commentMode:'off',commentConsent:false,commentReview:'direct',shareMode:'selected',resumeMode:'idle',connectionRef:null,modelConnectionRef:null,startMinute:0,endMinute:1440,defaultCharacterId:null});
export const REQUIRED_CAPABILITIES=Object.freeze(['social.context.read','activity.lease','activity.check','activity.finish','models.request','experience.append','proactive.offer','connections.request','ui.bubble']);
