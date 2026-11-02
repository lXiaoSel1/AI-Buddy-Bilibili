import {randomUUID} from 'node:crypto';
import {openStore} from '../../../shared/store.mjs';
import {assert,fail} from '../../../shared/errors.mjs';
import {DEFAULTS,PLUGIN_ID,VERSION,REQUIRED_CAPABILITIES} from './defaults.mjs';
import {createManagedBilibiliPlatform,normalizeMaterial,normalizeVideo,isPlatformMessageId} from './platform.mjs';
import {createBilibiliHttpPlatform} from './http-platform.mjs';
import {preferOffPeak} from './scheduling.mjs';
import {scheduleContent} from './plan-content.mjs';
import {understandingPrompt,publicCommentPrompt} from './prompts.mjs';
import {inspectRuntimeProcess,runtimeOwnerAlive} from '../../../shared/runtime-owner.mjs';
import {runVisualReading,isVisualPause} from './visual-reading.mjs';
import {runFullReading,isFullReadingPause,syncFullReadingRecord,recoverFullReadingRecord} from './full-reading.mjs';

const parse=v=>v?JSON.parse(v):null;
const terminal=new Set(['completed','partial','failed','cancelled']);
const active=new Set(['selecting','acquiring-material','understanding','recording']);
// C11: the pet bubble's second line (the host translates these fixed phrases).
const BUBBLE_DETAIL=Object.freeze({selecting:'正在挑视频','acquiring-material':'正在取视频材料',understanding:'正在看',recording:'正在记录',paused:'已暂停',completed:'看完了',partial:'只看了一部分',failed:'没看成'});
const text=(v,max=10000)=>typeof v==='string'?v.slice(0,max):'';
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const emptyObject=v=>object(v)&&Object.keys(v).length===0;
function clearResumedPause(a,at){
 if(a.lastFailureCode||a.pauseReason)a.failureHistory=[...(a.failureHistory??[]),{code:a.lastFailureCode??null,pauseReason:a.pauseReason??null,at:a.updatedAt??a.startedAt,resumedAt:at}];
 a.lastFailureCode=null;a.pauseReason=null;
}
function zeroCallFailure(a,checkpoint){
 return a?.readingMode==='full-v1'&&a.state==='failed'&&a.lastFailureCode==='BUDDY_SOCIAL_DENIED'&&a.modelState==='prepared'&&a.needsReview===false&&a.providerRequestId==null&&a.modelReceipt==null&&a.usageReceipt==null&&a.understanding==null&&(a.effective==null||a.effective===false)&&object(checkpoint)&&checkpoint.readingId===a.id&&typeof checkpoint.planHash==='string'&&checkpoint.planHash.length>0&&emptyObject(checkpoint.results)&&checkpoint.pending==null&&(checkpoint.invalidReceipts===undefined||emptyObject(checkpoint.invalidReceipts))&&checkpoint.needsReview!==true&&checkpoint.finalProviderRequestId==null&&checkpoint.finalProcessed!==true&&(checkpoint.calls===undefined||Array.isArray(checkpoint.calls)&&checkpoint.calls.length===0);
}
function zeroCallHost(a,checkpoint,state){
 return zeroCallFailure(a,checkpoint)&&state?.readingMode==='full-v1'&&state.readingId===a.id&&state.planHash===checkpoint.planHash&&state.confirmed===true&&['reading','paused'].includes(state.phase)&&Array.isArray(state.calls)&&state.calls.length===0&&state.progress?.completed===0&&Number.isSafeInteger(state.progress.total)&&state.progress.total>0&&state.coverage?.images?.completed===0&&state.coverage?.cues?.completed===0&&state.coverage.complete===false&&state.needsReview===false&&state.finalProviderRequestId==null&&state.finalProcessed!==true&&(state.modelReason==null||state.modelReason==='BILI_FULL_PAUSED')&&state.model?.connectionRef===a.modelConnectionRef;
}
function publicValue(value){if(Array.isArray(value))return value.map(publicValue);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/^(?:contextToken|principal|cookie|authorization|password|credentials|apiKey|keyCiphertext)$/i.test(key)).map(([key,item])=>[key,publicValue(item)]));return value;}
function localClock(at,timeZone){
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(at).map(v=>[v.type,v.value]));
  return {day:`${p.year}-${p.month}-${p.day}`,minute:Number(p.hour)*60+Number(p.minute)};
}
function validSettings(value,old){
  assert(value&&typeof value==='object'&&!Array.isArray(value),'BILI_SETTINGS_INVALID','Expected settings');
  for(const key of Object.keys(value))assert(Object.hasOwn(DEFAULTS,key),'BILI_SETTINGS_INVALID',`Unknown setting ${key}`);
  const s={...DEFAULTS,...old,...value};
  for(const key of ['autonomousEnabled','commentConsent','visualAutoApproved'])assert(typeof s[key]==='boolean','BILI_SETTINGS_INVALID',`${key} must be a boolean`);
  for(const[key,min,max]of [['maxConcurrent',1,16],['dailyWatchLimit',0,1000],['dailyCommentLimit',0,1000],['startMinute',0,1439],['endMinute',1,1440]])assert(Number.isInteger(s[key])&&s[key]>=min&&s[key]<=max,'BILI_SETTINGS_INVALID',`${key} is outside its supported range`);
  assert(Number.isFinite(s.sampleSeconds)&&s.sampleSeconds>=.1&&s.sampleSeconds<=60&&Number.isFinite(s.windowSeconds)&&s.windowSeconds>=.1&&s.windowSeconds<=3600,'BILI_FULL_CONFIG_INVALID','Sampling and reading-window seconds are outside their supported ranges');
  assert(s.startMinute<s.endMinute,'BILI_SETTINGS_INVALID','The activity window must end after it starts');
  assert(['off','managed'].includes(s.commentMode)&&['direct','preview'].includes(s.commentReview)&&['selected','record-only','after-chat'].includes(s.shareMode)&&['idle','manual'].includes(s.resumeMode),'BILI_SETTINGS_INVALID','Unsupported activity setting');
  assert(s.defaultCharacterId===null||(typeof s.defaultCharacterId==='string'&&s.defaultCharacterId.length>0&&s.defaultCharacterId.length<=300),'BILI_SETTINGS_INVALID','defaultCharacterId must be a character id');
  for(const key of ['connectionRef','modelConnectionRef'])assert(s[key]===null||(typeof s[key]==='string'&&s[key].length>0&&s[key].length<=300),'BILI_SETTINGS_INVALID',`${key} must be a connection reference`);
  assert(s.commentMode!=='managed'||s.commentConsent,'BILI_COMMENT_CONSENT_REQUIRED','Choose an account and explicitly authorize the managed comment allowance');
  return s;
}

const catalogCharacters=c=>(Array.isArray(c?.availableCharacters)?c.availableCharacters:[]).filter(v=>typeof v.id==='string'&&typeof v.label==='string').map(v=>({id:v.id,name:v.label}));
const catalogConnections=c=>(Array.isArray(c?.managedConnections)?c.managedConnections:[]).filter(v=>typeof v.ref==='string'&&typeof v.label==='string').map(v=>({id:v.ref,name:v.label,kind:typeof v.platform==='string'?v.platform:null}));
// No Bilibili account is connected, so there is no account database: quotas, plans and history all belong to an
// account. The page reads default settings, the character and connection choices and empty lists; every other
// action is refused upstream with SOCIAL_ACCOUNT_REQUIRED.
export const BILI_UNCONNECTED=Object.freeze({actions:Object.freeze(['settings.read','history.list','schedule.list','quota.read','comments.list','reading.pending.list']),read(action,payload,c,{timeZone='America/New_York',now=Date.now,storedAccountData=false}={}){
  if(action==='settings.read')return {settings:{...DEFAULTS},accountId:'',accountRequired:true,storedAccountData,timeZone,sourceMode:c?.sourceMode??'unverified-host',characters:catalogCharacters(c),connections:catalogConnections(c),todayAllowed:true,stopped:false};
  if(action==='quota.read')return {day:localClock(now(),timeZone).day,limits:{watch:DEFAULTS.dailyWatchLimit,comment:DEFAULTS.dailyCommentLimit},rows:[]};
  return [];
}});

export function createBilibiliService({databasePath,host,platform=null,now=Date.now,timeZone='America/New_York',runtimeOwnerInspector=inspectRuntimeProcess,cleanupTimeoutMs=2000}){
  assert(host&&typeof host.invoke==='function','BILI_HOST_REQUIRED','A trusted host bridge is required');
  localClock(now(),timeZone);
  assert(Number.isSafeInteger(cleanupTimeoutMs)&&cleanupTimeoutMs>=1&&cleanupTimeoutMs<=5000,'BILI_CLEANUP_BUDGET_INVALID');
  const store=openStore({databasePath,pluginId:PLUGIN_ID,schemaVersion:1,minimumWriter:'0.1.0-dev.2'});
  const db=store.db,inflight=new Map(),operations=new Set(),liveBubbles=new Map(),confirmedPlans=new Set(),readingControls=new Map(),confirmingReadings=new Set();let closing=false,closePromise=null,managedCatalog=[];
  const controlEpoch=()=>store.get('controlEpoch',0);
  const assertOpen=()=>assert(!closing,'BILI_CLOSED','The plugin is closing');
  const assertCurrent=epoch=>{if(epoch!==undefined)assert(epoch===controlEpoch(),'BILI_CONTROL_STALE','A newer user control superseded this request');};
  function revokeControl(accountId,reason){store.set('controlEpoch',controlEpoch()+1);interrupt(accountId,reason);}
  const instanceId=randomUUID();
  try{store.transaction(()=>{const old=store.get('runtimeOwner',null);if(runtimeOwnerAlive(old,runtimeOwnerInspector))throw fail('BILI_DATA_BUSY','Another plugin instance still owns this private database');const identity=runtimeOwnerInspector(process.pid);store.set('runtimeOwner',{...identity,pid:process.pid,instanceId});});}catch(error){store.close();throw error;}
  db.exec(`CREATE TABLE IF NOT EXISTS bili_activities(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,character_id TEXT NOT NULL,day TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bili_reservations(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,day TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS bili_quota ON bili_reservations(account_id,day,kind,status);
    CREATE TABLE IF NOT EXISTS bili_schedules(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bili_materials(video_id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bili_outbox(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS bili_comments(id TEXT PRIMARY KEY,account_id TEXT NOT NULL,activity_id TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL);`);
  // 2.0.2 additions (default character, "after-chat" sharing) are kept beside the 2.0.1 keys, so a rolled-back
  // 2.0.1 still reads and saves its own settings; it then shares her picks only.
  const settings=()=>{const base={...DEFAULTS,...store.get('settings',{})},extra=store.get('settings-v2',{}),full=store.get('settings-v206',{});return {...base,sampleSeconds:full.sampleSeconds??DEFAULTS.sampleSeconds,windowSeconds:full.windowSeconds??DEFAULTS.windowSeconds,visualAutoApproved:store.get('settings-v21',{}).visualAutoApproved===true,defaultCharacterId:typeof extra.defaultCharacterId==='string'?extra.defaultCharacterId:null,shareMode:extra.shareAfterChat===true&&base.shareMode==='selected'?'after-chat':base.shareMode};};
  const saveSettings=next=>{const {defaultCharacterId,visualAutoApproved,sampleSeconds,windowSeconds,...base}=next;store.transaction(()=>{store.set('settings-v206',{sampleSeconds,windowSeconds});store.set('settings-v21',{visualAutoApproved:visualAutoApproved===true});store.set('settings',{...base,shareMode:base.shareMode==='after-chat'?'selected':base.shareMode});store.set('settings-v2',{defaultCharacterId,shareAfterChat:base.shareMode==='after-chat'});});};
  const clock=()=>localClock(now(),timeZone);
  const row=id=>store.get('full-activity-v206:'+id,null)??store.get('visual-activity-v21:'+id,null)??parse(db.prepare('SELECT data FROM bili_activities WHERE id=?').get(id)?.data)??store.get('video-activity:'+id,null);
  const readingControl=id=>readingControls.get(id)??0;
  const checkpoint=id=>store.get('reading-full-v1:'+id,null);
  const recoverableZeroCall=(a,state)=>a?.connectionRef===settings().connectionRef&&a.modelConnectionRef===settings().modelConnectionRef&&zeroCallHost(a,checkpoint(a.id),state);
  function retainZeroCallFailure(a,reason){const {zeroCallRecoveryFailures,...failure}=a;a.zeroCallRecoveryFailures=[...(zeroCallRecoveryFailures??[]),{...failure,recoveryReason:reason,recoveredAt:now()}];}
  function fullReadingView(a,state){
    const {recoveredResults,...safeState}=state;state=safeState;
    const local=checkpoint(a.id),confirmationAccepted=state.confirmed===true&&a.pauseReason==='BILI_FULL_PLAN_CONFIRMATION_REQUIRED'&&['reading','completed'].includes(state.phase),phase=terminal.has(a.state)?a.state:a.state==='paused'&&!confirmationAccepted&&!(state.confirmed!==true&&state.phase==='awaiting-confirmation')?'paused':state.phase,needsReview=state.needsReview===true||a.needsReview===true||!!local?.pending;
    const currentReason=needsReview||['paused','failed','partial','cancelled','unknown'].includes(phase),pauseReason=['paused','cancelled'].includes(phase)&&!confirmationAccepted?a.pauseReason??null:null;
    return {...state,activityId:a.id,activityRevision:a.statusRevision??0,readingRevision:state.revision??0,pauseReason,phase,modelReason:currentReason?a.lastFailureCode??state.modelReason??null:null,needsReview,recoverableZeroCall:recoverableZeroCall(a,state),results:Object.values(local?.results??{}).map(x=>x.understanding?x:store.get('full-result-v206:'+a.id+':'+x.stepId,null)).filter(x=>x?.understanding).map(x=>({stepId:x.stepId,summary:x.understanding.summary,notes:x.understanding.notes,evidenceRefs:x.understanding.evidenceRefs}))};
  }
  function activities(accountId=null,states=null,limit=null){
    const old=[],extra=["(key GLOB 'video-activity:*' OR key GLOB 'visual-activity-v21:*' OR key GLOB 'full-activity-v206:*')"],args=[];if(accountId!==null){old.push('account_id=?');extra.push("json_extract(value,'$.accountId')=?");args.push(accountId);}if(states){const marks=states.map(()=>'?').join(',');old.push('state IN ('+marks+')');extra.push("json_extract(value,'$.state') IN ("+marks+')');args.push(...states);}const end=' ORDER BY rowid DESC'+(limit?' LIMIT '+limit:'');
    return [...db.prepare('SELECT data FROM bili_activities'+(old.length?' WHERE '+old.join(' AND '):'')+end).all(...args).map(v=>parse(v.data)),...db.prepare('SELECT value FROM a_plugin_kv WHERE '+extra.join(' AND ')+end).all(...args).map(v=>parse(v.value))].sort((a,b)=>(b.startedAt??0)-(a.startedAt??0)).slice(0,limit??Infinity);
  }
  const activityRevisions=new Map();
  const save=a=>{a.statusRevision=Math.max(a.statusRevision??0,activityRevisions.get(a.id)??0)+1;activityRevisions.set(a.id,a.statusRevision);a.updatedAt=now();if(a.readingMode==='full-v1')store.set('full-activity-v206:'+a.id,a);else if(a.visual===true)store.set('visual-activity-v21:'+a.id,a);else if(a.videoPlan===true)store.set('video-activity:'+a.id,a);else db.prepare('INSERT INTO bili_activities(id,account_id,character_id,day,state,data) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data').run(a.id,a.accountId,a.characterId,a.day,a.state,JSON.stringify(a));return a;};
  function writeFullResult(activityId,value){const key='full-result-v206:'+activityId+':'+value.stepId,prior=store.get(key,null);assert(!prior||JSON.stringify(prior)===JSON.stringify(value),'BILI_FULL_RESULT_CONFLICT','An original batch receipt cannot be overwritten');if(!prior)store.set(key,value);return key;}
  const getSchedule=id=>store.get('visual-plan-v21:'+id,null)??parse(db.prepare('SELECT data FROM bili_schedules WHERE id=?').get(id)?.data)??store.get('video-plan:'+id,null);
  const videoSchedules=accountId=>db.prepare("SELECT value FROM a_plugin_kv WHERE (key GLOB 'video-plan:*' OR key GLOB 'visual-plan-v21:*') ORDER BY rowid").all().map(v=>parse(v.value)).filter(s=>s?.accountId===accountId);
  const allSchedules=accountId=>[...new Map([...db.prepare('SELECT data FROM bili_schedules WHERE account_id=? ORDER BY rowid').all(accountId).map(v=>parse(v.data)),...videoSchedules(accountId)].map(s=>[s.id,s])).values()];
  const needsConfirmation=s=>s?.watchMode==='video'&&!terminal.has(s.state)&&!confirmedPlans.has(s.id);
  const scheduleView=s=>s.watchMode==='video'?{...s,state:needsConfirmation(s)?'paused':s.state,requiresConfirmation:needsConfirmation(s)}:s;
  const saveSchedule=s=>{if(s.visualReading===true){store.set('visual-plan-v21:'+s.id,s);const prior=db.prepare('SELECT data FROM bili_schedules WHERE id=?').get(s.id);if(prior){const old=parse(prior.data);old.state='cancelled';db.prepare("UPDATE bili_schedules SET state='cancelled',data=? WHERE id=?").run(JSON.stringify(old),s.id);}if(store.get('video-plan:'+s.id,null))store.set('video-plan:'+s.id,{...s,state:'cancelled'});}else if(s.watchMode==='video')store.set('video-plan:'+s.id,s);else db.prepare('INSERT INTO bili_schedules VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,data=excluded.data').run(s.id,s.accountId,s.state,JSON.stringify(s));return s;};
  function accountMatches(accountId){const bound=store.get('accountId',null);assert(!bound||bound===accountId,'BILI_ACCOUNT_CHANGED','The managed account changed; use its own data directory');if(!bound)store.set('accountId',accountId);}
  async function manage(principal){
    assert(principal&&typeof principal.contextToken==='string','BILI_OWNER_REQUIRED','A host-authorized local owner request is required');
    const c=await host.invoke('social.context.read',{purpose:'manage-plugin',principal,sourcePluginId:PLUGIN_ID});
    assertOpen();
    assert(c?.permissions?.includes('plugin.manage')&&typeof c.accountId==='string'&&c.accountId,'BILI_OWNER_REQUIRED','Plugin management permission is required');
    managedCatalog=Array.isArray(c.managedConnections)?c.managedConnections:[];
    accountMatches(c.accountId);return c;
  }
  async function context(characterId,principal,purpose='bilibili-activity',expectedEpoch){
    assertOpen();assertCurrent(expectedEpoch);
    assert(typeof characterId==='string'&&characterId,'BILI_CHARACTER_REQUIRED','Choose a participating character');
    const c=await host.invoke('social.context.read',{purpose,characterId,principal,sourcePluginId:PLUGIN_ID,modelConnectionRef:settings().modelConnectionRef,...(purpose==='bilibili-public-comment'?{channel:'bilibili-public',visibilityScope:'public',contextMode:'material-only',includePrivateMemory:false}:{})});
    assertOpen();assertCurrent(expectedEpoch);
    assert(c?.contextToken&&c.characterId===characterId&&c.lifeId&&c.operationId&&c.personaId&&c.accountId&&Number.isSafeInteger(c.generation),'BILI_CONTEXT_INVALID','A current trusted social context is required');
    accountMatches(c.accountId);return c;
  }
  function eligible(accountId,{day=clock().day,startMinute=settings().startMinute,endMinute=settings().endMinute,automatic=false}={}){
    assert(!closing,'BILI_CLOSED','The plugin is closing');
    assert(day===clock().day,'BILI_SCHEDULE_EXPIRED','Yesterday\'s authorization cannot carry to today');
    assert(store.get(`day:${accountId}:${day}`,true)!==false,'BILI_TODAY_FORBIDDEN','Watching is not allowed today');
    assert(!store.get('stopped',false),'BILI_STOPPED','Watching was explicitly stopped');
    assert(!store.get('pausedByUser',false),'BILI_PAUSED','Watching is paused');
    assert(clock().minute>=startMinute&&clock().minute<endMinute,'BILI_OUTSIDE_WINDOW','This activity is outside its allowed window');
    if(automatic)assert(settings().autonomousEnabled,'BILI_AUTONOMOUS_DISABLED','Autonomous viewing is disabled');
  }
  function reserve(id,accountId,day,kind){
    return store.transaction(()=>{
      const old=db.prepare('SELECT * FROM bili_reservations WHERE id=?').get(id);
      if(old)assert(old.account_id===accountId&&old.day===day&&old.kind===kind,'BILI_RESERVATION_MISMATCH','An allowance reservation cannot change owner or day');
      if(kind==='watch'){
        const running=activities(accountId,['selecting','acquiring-material','understanding']).length;
        assert(running<settings().maxConcurrent,'BILI_CONCURRENCY_LIMIT','The shared activity concurrency limit is reached');
      }
      if(old?.status==='released')db.prepare('DELETE FROM bili_reservations WHERE id=?').run(id);else if(old)return true;
      const limit=kind==='watch'?settings().dailyWatchLimit:settings().dailyCommentLimit;
      const count=db.prepare("SELECT COUNT(*) n FROM bili_reservations WHERE account_id=? AND day=? AND kind=? AND status!='released'").get(accountId,day,kind).n;
      assert(count<limit,'BILI_QUOTA_EXHAUSTED',`The shared daily ${kind} allowance is exhausted`);
      db.prepare('INSERT INTO bili_reservations VALUES(?,?,?,?,?)').run(id,accountId,day,kind,'reserved');return true;
    });
  }
  const settle=(id,status)=>db.prepare('UPDATE bili_reservations SET status=? WHERE id=?').run(status,id);
  function enqueue(id,accountId,kind,data){db.prepare('INSERT OR IGNORE INTO bili_outbox VALUES(?,?,?,?,?)').run(id,accountId,kind,'pending',JSON.stringify(data));}
  async function check(c,lease,a,signal){
    if(signal.aborted)throw fail('BILI_CANCELLED','Activity was interrupted');
    assertCurrent(a.controlEpoch);
    eligible(c.accountId,{day:a.day,startMinute:a.startMinute,endMinute:a.endMinute,automatic:a.automatic});
    const current=await host.invoke('activity.check',{contextToken:c.contextToken,leaseId:lease.leaseId,generation:lease.generation,characterId:c.characterId,lifeId:c.lifeId,operationId:c.operationId,sourcePluginId:PLUGIN_ID},{signal});
    assert(current?.valid===true&&current.characterId===c.characterId&&current.lifeId===c.lifeId&&current.operationId===c.operationId&&current.generation===lease.generation,'BILI_LEASE_REVOKED','The activity lease has expired or changed');
    if(signal.aborted)throw fail('BILI_CANCELLED','Activity was interrupted');
    assertCurrent(a.controlEpoch);eligible(c.accountId,{day:a.day,startMinute:a.startMinute,endMinute:a.endMinute,automatic:a.automatic});
  }
  async function flushOutbox(accountId,signal=new AbortController().signal){
    for(const rec of db.prepare("SELECT * FROM bili_outbox WHERE account_id=? AND state='pending' ORDER BY rowid").all(accountId)){
      const data=parse(rec.data);
      // v1 kept transport diagnostics inside the replayed event. Move that
      // local metadata aside so retries keep the original canonical payload.
      if(Object.hasOwn(data,'lastFailureCode')){store.set(`outbox-error:${rec.id}`,{code:data.lastFailureCode,at:now()});delete data.lastFailureCode;db.prepare('UPDATE bili_outbox SET data=? WHERE id=?').run(JSON.stringify(data),rec.id);}
      try{
        if(rec.kind==='share'){
          if(store.get('stopped',false)||data.day!==clock().day||store.get(`day:${accountId}:${data.day}`,true)===false||data.kind==='bilibili-share'&&settings().shareMode==='record-only'){db.prepare("UPDATE bili_outbox SET state='cancelled' WHERE id=? AND state='pending'").run(rec.id);continue;}
          if(closing||signal.aborted||store.get('pausedByUser',false)||store.get('chatActive',false))continue;
          if(data.activityId){const a=row(data.activityId);assert(a&&data.leaseId,'BILI_SHARE_LEASE_REQUIRED','Pending shares require their original activity lease');await check({...data,accountId},{leaseId:data.leaseId,generation:data.generation},a,signal);}
          // Re-read the durable state after the asynchronous host guard.
          if(db.prepare('SELECT state FROM bili_outbox WHERE id=?').get(rec.id)?.state!=='pending'||closing||store.get('stopped',false)||store.get('pausedByUser',false)||store.get('chatActive',false)||data.day!==clock().day||store.get(`day:${accountId}:${data.day}`,true)===false||signal.aborted||data.kind==='bilibili-share'&&settings().shareMode==='record-only')continue;
        }
        const result=await host.invoke(rec.kind==='experience'?'experience.append':'proactive.offer',data,{signal});
        assert(result?.recorded===true||rec.kind==='share'&&result?.accepted===true,'BILI_RECEIPT_REQUIRED','The host did not acknowledge this durable event');
        if(rec.kind==='share'){
          const current=db.prepare('SELECT state FROM bili_outbox WHERE id=?').get(rec.id)?.state;
          if(current==='pending')db.prepare("UPDATE bili_outbox SET state='done' WHERE id=? AND state='pending'").run(rec.id);
          else store.set(`outbox-receipt:${rec.id}`,{hostAccepted:true,localState:current,at:now()});
        }else db.prepare("UPDATE bili_outbox SET state='done' WHERE id=?").run(rec.id);
        store.delete(`outbox-error:${rec.id}`);
        if(rec.kind==='experience'){
          const a=row(data.activityId);if(a?.state==='recording'&&data.eventId===`${PLUGIN_ID}:${a.id}:experience`&&data.sourceKind==='bilibili'){a.state=a.effective?'completed':'partial';a.experienceId=result.eventId??data.eventId;save(a);}
        }
      }catch(error){if(db.prepare('SELECT state FROM bili_outbox WHERE id=?').get(rec.id)?.state==='pending')store.set(`outbox-error:${rec.id}`,{code:error.code??'BILI_HOST_FAILED',at:now()});}
    }
  }
  function experience(a,status){
    const eventId=`${PLUGIN_ID}:${a.id}:experience`;
    return {schemaVersion:1,eventId,idempotencyKey:eventId,sourcePluginId:PLUGIN_ID,sourceKind:'bilibili',activityId:a.id,contextToken:a.contextToken,characterId:a.characterId,lifeId:a.lifeId,operationId:a.operationId,personaId:a.personaId,channel:'bilibili-private',conversationId:a.id,visibilityScope:'character-private',occurredAt:a.startedAt,status,evidenceRefs:a.understanding?.evidenceRefs??[],providerRequestId:a.providerRequestId??null,deliveryState:'not-applicable',presentationState:'not-presented',material:a.material?{videoId:a.material.videoId,coverage:a.material.coverage,complete:a.material.complete,sourceRefs:a.material.sourceRefs}:null,video:a.video??null,summaryCandidate:a.understanding?.summary??null,sourceMode:a.sourceMode};
  }
  async function bubble(a,clear=false,options={}){
    try{await host.invoke('ui.bubble',{sourcePluginId:PLUGIN_ID,contextToken:a.contextToken,activityId:a.id,characterId:a.characterId,stage:a.state,title:clear?'':a.video?.title??'挑选视频',...(!clear&&BUBBLE_DETAIL[a.state]?{detail:BUBBLE_DETAIL[a.state]}:{}),followPetScreen:true,openPage:{pluginId:PLUGIN_ID,activityId:a.id},clear},options);if(clear){if(liveBubbles.get(a.characterId)?.id===a.id)liveBubbles.delete(a.characterId);}else liveBubbles.set(a.characterId,{id:a.id,characterId:a.characterId,contextToken:a.contextToken,state:a.state});return true;}catch{return false;}
  }
  async function clearLiveBubbles(){
    const current=[...liveBubbles.values()];if(!current.length)return [];
    const controller=new AbortController();let timer;
    try{
      const cleared=await Promise.race([Promise.all(current.map(a=>bubble(a,true,{signal:controller.signal}))),new Promise(resolve=>{timer=setTimeout(()=>{controller.abort();resolve(null);},cleanupTimeoutMs);})]);
      return cleared?.every(Boolean)?[]:['BILI_BUBBLE_CLEANUP_PENDING'];
    }finally{clearTimeout(timer);controller.abort();liveBubbles.clear();}
  }
  function settleScheduleOnce(a){
    if(!a.scheduleId||a.scheduleCounted||row(a.id)?.scheduleCounted)return;
    const parent=getSchedule(a.scheduleId);if(!parent||parent.state==='cancelled')return;
    if(parent.remaining>0){parent.remaining--;parent.participantIndex++;}
    parent.state=parent.remaining>0?'scheduled':'completed';saveSchedule(parent);a.scheduleCounted=true;save(a);
  }
  function recordUnderstanding(a){store.transaction(()=>{settle(a.id,a.effective?'committed':'released');if(a.effective&&!a.interestsApplied){const key=`interests:${a.characterId}:${a.lifeId}`,old=store.get(key,{});for(const tag of a.understanding.interestTags)old[tag]=Math.min(100,(old[tag]??0)+1);store.set(key,Object.fromEntries(Object.entries(old).sort((a,b)=>b[1]-a[1]).slice(0,30)));a.interestsApplied=true;}a.state='recording';save(a);settleScheduleOnce(a);enqueue(`${a.id}:experience`,a.accountId,'experience',experience(a,a.effective?'completed':'partial'));});}
  function reusableMaterial(video){
    const raw=parse(db.prepare('SELECT data FROM bili_materials WHERE video_id=?').get(video.videoId)?.data);
    if(!raw?.complete||raw.coverage==='description'||!Number.isFinite(raw.fetchedAt)||raw.fetchedAt>now()||now()-raw.fetchedAt>86400000||video.cid&&raw.videoCid!==video.cid)return null;
    try{return normalizeMaterial(raw,video);}catch{return null;}
  }
  async function perform(a,c,signal,principal){
    const leaseAttemptId=a.id+':attempt:'+randomUUID();let lease,materialReused=!!a.material;
    try{
      lease=await host.invoke('activity.lease',{sourcePluginId:PLUGIN_ID,contextToken:c.contextToken,activityId:leaseAttemptId,kind:'bilibili',generation:c.generation},{signal});
      assert(lease?.leaseId&&Number.isSafeInteger(lease.generation),'BILI_LEASE_REQUIRED','The host did not grant an activity lease');
      await check(c,lease,a,signal);
      if(!a.video){a.state='selecting';save(a);await bubble(a);await check(c,lease,a,signal);a.video=normalizeVideo(await managed.selectVideo({connectionRef:a.connectionRef,context:c,lease,videoId:a.requestedVideoId,signal}));save(a);}
      await check(c,lease,a,signal);
      if(!a.material&&a.readingMode!=='full-v1'){a.state='acquiring-material';save(a);await bubble(a);await check(c,lease,a,signal);const cached=a.readingMode==='full-v1'?null:reusableMaterial(a.video);materialReused=!!cached;a.material=cached??normalizeMaterial(await managed.acquireMaterial({connectionRef:a.connectionRef,context:c,lease,video:a.video,signal,fullReading:a.readingMode==='full-v1'}),a.video,{fullReading:a.readingMode==='full-v1'});if(a.material.fetchedAt===null)a.material.fetchedAt=now();db.prepare('INSERT INTO bili_materials VALUES(?,?) ON CONFLICT(video_id) DO UPDATE SET data=excluded.data').run(a.video.videoId,JSON.stringify(a.material));save(a);}
      await check(c,lease,a,signal);
      assert(a.modelConnectionRef,'BILI_MODEL_REQUIRED','Choose a managed activity model connection');
      if(a.readingMode==='full-v1'&&!a.understanding){
        a.state='acquiring-material';a.modelState='prepared';save(a);await bubble(a);
        if(!a.fullMaterialsRef){let materials=a.fullMaterials;if(!materials){const parts=a.video.pages??[{cid:a.video.cid,page:1,duration:a.video.duration}],selected=a.selectedCids??[a.video.cid];a.selectedCids=selected;materials=[];let characters=0;for(const part of parts.filter(p=>selected.includes(p.cid))){await check(c,lease,a,signal);const video=normalizeVideo({...a.video,cid:part.cid,duration:part.duration,currentPage:part.page}),material=part.cid===a.video.cid&&a.material?.coverage==='subtitles'?a.material:normalizeMaterial(await managed.acquireMaterial({connectionRef:a.connectionRef,context:c,lease,video,signal,fullReading:true}),video,{fullReading:true});characters+=material.items.reduce((n,item)=>n+(item.text?.length??0),0);assert(characters<=64*1024*1024,'BILI_FULL_TEXT_CAPACITY','Retained subtitle sources exceed the full-reading budget');materials.push(material);}assert(materials.length===selected.length,'BILI_FULL_PART_INVALID','Every selected part must be acquired');}a.fullMaterialsRef='full-materials-v206:'+a.id;store.set(a.fullMaterialsRef,materials);delete a.fullMaterials;save(a);}
        a.state='understanding';save(a);await bubble(a);
        const result=await runFullReading({a,c,lease,host,materials:store.get('full-materials-v206:'+a.id,[]),signal,check:()=>check(c,lease,a,signal),readRecord:()=>store.get('reading-full-v1:'+a.id,null),transaction:fn=>store.transaction(fn),writeRecord:value=>store.transaction(()=>{store.set('reading-full-v1:'+a.id,value);save(a);}),readResult:stepId=>store.get('full-result-v206:'+a.id+':'+stepId,null),writeResult:value=>writeFullResult(a.id,value)});
        if(result.awaitingConfirmation){a.state='paused';a.pauseReason='BILI_FULL_PLAN_CONFIRMATION_REQUIRED';a.lastFailureCode=null;a.needsReview=false;save(a);await bubble(a);return a;}
        a.material=result.material;a.providerRequestId=result.providerRequestId;a.modelState='returned';a.effective=result.complete;a.understanding=result.understanding;save(a);
      }
      if(a.visual&&a.readingMode!=='full-v1'&&!a.understanding){
        a.state='understanding';a.modelState='prepared';save(a);await bubble(a);
        const result=await runVisualReading({a,c,lease,host,material:a.material,signal,check:()=>check(c,lease,a,signal),readRecord:()=>store.get('reading-v21:'+a.id,null),writeRecord:value=>{store.set('reading-v21:'+a.id,value);save(a);}});
        a.material=result.material;a.providerRequestId=result.providerRequestId;a.modelState='returned';a.effective=result.complete&&result.understanding.completedMaterial===true;a.understanding={...result.understanding,notes:text(result.understanding.notes,100000),shareText:text(result.understanding.shareText,3000),interestTags:Array.isArray(result.understanding.interestTags)?result.understanding.interestTags.slice(0,5):[]};save(a);
      }
      if(!a.understanding){
      a.state='understanding';a.modelState='prepared';save(a);await bubble(a);
      await check(c,lease,a,signal);
      const requestUnderstanding=async()=>{
        await check(c,lease,a,signal);a.modelState='started';save(a);
        try{return await host.invoke('models.request',{sourcePluginId:PLUGIN_ID,contextToken:c.contextToken,leaseId:lease.leaseId,connectionRef:a.modelConnectionRef,purpose:'bilibili-understanding',activityId:a.id,material:a.material,video:a.video,...understandingPrompt(a.video,a.material),outputSchema:'bilibili-understanding-proposal-v1'},{signal});}
        catch(error){
          // This exact host error is emitted before the model journal or provider
          // submission. Other failures remain unknown and must never be replayed.
          if(error.code==='SOCIAL_UNOBSERVED_MATERIAL'){a.modelState='prepared';save(a);}
          throw error;
        }
      };
      let result;
      try{result=await requestUnderstanding();}catch(error){
        if(error.code!=='SOCIAL_UNOBSERVED_MATERIAL'||!materialReused)throw error;
        await check(c,lease,a,signal);a.state='acquiring-material';save(a);await bubble(a);
        const fresh=normalizeMaterial(await managed.acquireMaterial({connectionRef:a.connectionRef,context:c,lease,video:a.video,signal}),a.video);
        await check(c,lease,a,signal);a.material=fresh;if(a.material.fetchedAt===null)a.material.fetchedAt=now();
        db.prepare('INSERT INTO bili_materials VALUES(?,?) ON CONFLICT(video_id) DO UPDATE SET data=excluded.data').run(a.video.videoId,JSON.stringify(a.material));
        a.state='understanding';save(a);await bubble(a);
        result=await requestUnderstanding();
      }
      a.modelState='returned';a.providerRequestId=result?.providerRequestId??result?.requestId??result?.usageReceipt?.providerRequestId??null;
      save(a);
      let u=result?.understanding;try{if(!u&&typeof result?.text==='string')u=JSON.parse(result.text);}catch{}
      assert(u&&typeof u.summary==='string'&&Array.isArray(u.evidenceRefs)&&u.evidenceRefs.length>0,'BILI_UNDERSTANDING_INVALID','The model did not return evidence-linked understanding');
      const refs=new Set(a.material.items.map(v=>v.id));assert(u.evidenceRefs.every(id=>refs.has(id)),'BILI_EVIDENCE_INVALID','Understanding cited material that was never acquired');
      assert(a.providerRequestId,'BILI_MODEL_RECEIPT_REQUIRED','The host must return the actual model request identity');
      a.understanding={summary:text(u.summary),notes:text(u.notes,100000),evidenceRefs:[...new Set(u.evidenceRefs)],shareWorthy:u.shareWorthy===true,commentWorthy:u.commentWorthy===true,shareText:text(u.shareText,3000),interestTags:Array.isArray(u.interestTags)?[...new Set(u.interestTags.filter(v=>typeof v==='string'&&v.trim()&&v.length<=100))].slice(0,5):[]};
      a.effective=a.material.complete&&a.material.coverage!=='description'&&u.completedMaterial===true;
      save(a);
      }
      await check(c,lease,a,signal);
      recordUnderstanding(a);
      await flushOutbox(a.accountId);a=row(a.id);await bubble(a);
      // "selected" offers only what she found worth telling; "after-chat" offers every completed viewing. Either
      // way the app presents an offer only when no conversation is going on.
      if(a.state==='completed'&&settings().shareMode!=='record-only'&&(a.understanding.shareWorthy||settings().shareMode==='after-chat')){
        await check(c,lease,a,signal);
        enqueue(`${a.id}:share`,a.accountId,'share',{idempotencyKey:`${a.id}:share`,sourcePluginId:PLUGIN_ID,contextToken:c.contextToken,leaseId:lease.leaseId,generation:lease.generation,day:a.day,kind:'bilibili-share',activityId:a.id,eventId:a.experienceId,characterId:a.characterId,lifeId:a.lifeId,operationId:a.operationId,text:a.understanding.shareText||a.understanding.summary,channel:'app',requiresCurrentCharacter:true,expiresAt:now()+86400000});
        await flushOutbox(a.accountId,signal);
      }
      if(a.state==='completed'&&a.understanding.commentWorthy&&settings().commentMode==='managed'&&settings().commentConsent&&settings().dailyCommentLimit>0&&!signal.aborted){await check(c,lease,a,signal);await sendComment(a.id,principal,{activityContext:c,expectedEpoch:a.controlEpoch,draftOnly:settings().commentReview==='preview'});}
      return row(a.id);
    }catch(error){
      a=row(a.id)??a;
      if(a.state==='recording'||terminal.has(a.state)){a.lastFailureCode=error.code??'BILI_ACTIVITY_FAILED';save(a);return a;}
      if(['BILI_SCHEDULE_EXPIRED','BILI_OUTSIDE_WINDOW'].includes(error.code)&&a.modelState==='returned'&&a.understanding){a.finishedAfterWindow=true;a.lastFailureCode=error.code;recordUnderstanding(a);await flushOutbox(a.accountId);return row(a.id);}
      const cause=inflight.get(a.id)?.reason;
      a.state=cause==='stop'||cause==='today-forbidden'||cause==='close'?'cancelled':['user-return','pause','settings-changed','autonomous-disabled'].includes(cause)?'paused':error.code==='BILI_CANCELLED'||isVisualPause(error.code)||isFullReadingPause(error.code)?'paused':'failed';
      a.pauseReason=cause??(isVisualPause(error.code)||isFullReadingPause(error.code)?error.code:null);a.lastFailureCode=error.code??'BILI_ACTIVITY_FAILED';a.needsReview=a.modelState==='started';
      store.transaction(()=>{settle(a.id,a.effective&&a.modelState==='returned'?'committed':'released');save(a);const event=experience(a,a.state==='paused'?'partial':a.state);event.eventId=`${a.id}:attempt`;event.idempotencyKey=event.eventId;if(a.readingMode!=='full-v1')enqueue(event.eventId,a.accountId,'experience',event);});
      return a;
    }finally{if(lease)try{await host.invoke('activity.finish',{sourcePluginId:PLUGIN_ID,contextToken:c.contextToken,leaseId:lease.leaseId,activityId:leaseAttemptId,status:row(a.id)?.state??'failed'});}catch{}inflight.delete(a.id);}
  }
  const managed=platform??createBilibiliHttpPlatform({request:({signal,...payload})=>host.invoke('connections.request',payload,{signal}),now});
  async function begin({characterId,videoId=null,schedule=null,manual=false,visual=false,selectedCids=null,fullConfig=null},principal,expectedEpoch){
    const c=await context(characterId,principal,'bilibili-activity',expectedEpoch),s=settings();
    c.interests=[...(Array.isArray(c.interests)?c.interests:[]),...Object.entries(store.get(`interests:${c.characterId}:${c.lifeId}`,{})).map(([tag,count])=>({tag,weight:Math.min(3,count/10)}))];
    eligible(c.accountId,{day:schedule?.day??clock().day,startMinute:schedule?.startMinute??s.startMinute,endMinute:schedule?.endMinute??s.endMinute,automatic:!!schedule&&!manual});
    if(c.sleeping){
      if(schedule){schedule.state='waiting-sleep';saveSchedule(schedule);if(!schedule.dreamOffered){const key=`${schedule.id}:dream`;enqueue(key,c.accountId,'share',{idempotencyKey:key,sourcePluginId:PLUGIN_ID,contextToken:c.contextToken,day:schedule.day,kind:'dream-expectation',characterId,lifeId:c.lifeId,operationId:c.operationId,channel:'app',scheduleId:schedule.id,requiresCurrentCharacter:true,noVideoAcquisition:true});schedule.dreamOffered=true;saveSchedule(schedule);await flushOutbox(c.accountId);}}
      return {state:'waiting-sleep',scheduleId:schedule?.id??null,videoAcquired:false,watchQuotaConsumed:false};
    }
    if(schedule&&!manual){
      const model=c.activityModel?.connectionRef===s.modelConnectionRef?c.activityModel:managedCatalog.find(v=>v.ref===s.modelConnectionRef&&v.platform==='model');
      const preference=preferOffPeak({at:now(),timeZone,day:schedule.day,startMinute:schedule.startMinute,endMinute:schedule.endMinute,provider:model?.provider,holidayDates:Array.isArray(model?.allDayOffPeakDates)?model.allDayOffPeakDates:[]});
      if(!preference.runNow){schedule.state='scheduled';schedule.nextEligibleAt=preference.resumeAt;schedule.pricingPreference=preference;schedule.deferredForConnectionRef=s.modelConnectionRef;saveSchedule(schedule);return {state:'deferred',resumeAt:preference.resumeAt,reason:preference.reason};}
    }
    const features=typeof host.describe==='function'?(await host.describe()).features??[]:[],visualHost=features.includes('bilibili-vision-v1'),fullHost=features.includes('bilibili-full-reading-v1');assertOpen();assertCurrent(expectedEpoch);
    if(schedule&&!manual&&(visualHost||schedule.visualReading===true||s.visualAutoApproved===true)&&s.visualAutoApproved!==true){schedule.state='paused';schedule.pauseReason='visual-approval-required';saveSchedule(schedule);return {state:'paused',reason:'visual-approval-required',scheduleId:schedule.id};}
    assert(s.connectionRef,'BILI_CONNECTION_REQUIRED','Choose a managed Bilibili account connection');
    const a={id:randomUUID(),accountId:c.accountId,characterId:c.characterId,lifeId:c.lifeId,operationId:c.operationId,personaId:c.personaId,contextToken:c.contextToken,generation:c.generation,controlEpoch:expectedEpoch??controlEpoch(),connectionRef:s.connectionRef,modelConnectionRef:s.modelConnectionRef,sourceMode:c.sourceMode??'unverified-host',day:schedule?.day??clock().day,startMinute:schedule?.startMinute??s.startMinute,endMinute:schedule?.endMinute??s.endMinute,automatic:!!schedule&&!manual,scheduleId:schedule?.id??null,requestedVideoId:videoId,...(schedule?.watchMode==='video'?{videoPlan:true}:{}),state:'eligible',startedAt:now(),visual:visual===true||!!schedule&&(visualHost||fullHost||schedule.visualReading===true||s.visualAutoApproved===true)};
    if(fullHost&&a.visual){assert(selectedCids===null||Array.isArray(selectedCids)&&selectedCids.length>0&&selectedCids.every(Number.isSafeInteger),'BILI_FULL_PART_INVALID','Choose valid video parts');a.readingMode='full-v1';a.selectedCids=selectedCids;a.fullConfig=fullConfig??{sampleSeconds:s.sampleSeconds,windowSeconds:s.windowSeconds};}
    store.transaction(()=>{reserve(a.id,c.accountId,a.day,'watch');a.state='selecting';save(a);});
    const controller=new AbortController();const entry={controller,accountId:c.accountId,reason:null,promise:null};inflight.set(a.id,entry);entry.promise=perform(a,c,controller.signal,principal);return entry.promise;
  }
  function interrupt(accountId,reason){for(const entry of inflight.values()){if(entry.accountId===accountId){entry.reason=reason;entry.controller.abort();}}}
  async function sendComment(activityId,principal,{activityContext=null,expectedEpoch,draftOnly=false}={}){
    assertCurrent(expectedEpoch);
    const owner=activityContext??await manage(principal),a=row(activityId),s=settings();assert(a?.accountId===owner.accountId&&a.state==='completed','BILI_COMMENT_ACTIVITY_REQUIRED','A completed, account-owned viewing is required');
    assert(s.commentMode==='managed'&&s.commentConsent,'BILI_COMMENTS_OFF','Comments are disabled');
    assert(a.day===clock().day,'BILI_COMMENT_EXPIRED','Old activities cannot replay today\'s comment allowance');
    const c=await context(a.characterId,principal,'bilibili-public-comment',expectedEpoch);assert(c.lifeId===a.lifeId&&c.operationId===a.operationId,'BILI_LIFE_CHANGED','This viewing belongs to an old life');
    eligible(c.accountId,{day:a.day});assert(!c.sleeping,'BILI_SLEEPING','Do not post comments during sleep');
    const guard={...a,automatic:false,controlEpoch:expectedEpoch??controlEpoch()};
    const id=`${a.id}:comment`,prior=db.prepare('SELECT state,data FROM bili_comments WHERE id=?').get(id);
    if(prior)return {...parse(prior.data),state:prior.state};
    const claimId=randomUUID();
    const claimed=store.transaction(()=>{if(db.prepare('SELECT id FROM bili_comments WHERE id=?').get(id))return false;reserve(id,a.accountId,a.day,'comment');db.prepare('INSERT INTO bili_comments VALUES(?,?,?,?,?)').run(id,a.accountId,a.id,'generating',JSON.stringify({id,activityId:a.id,claimId,startedAt:now()}));return true;});
    if(!claimed){const old=db.prepare('SELECT state,data FROM bili_comments WHERE id=?').get(id);return {...parse(old.data),state:old.state};}
    const controller=new AbortController(),entry={controller,accountId:a.accountId,kind:'comment',reason:null,promise:null,resolve:null};entry.promise=new Promise(resolve=>{entry.resolve=resolve;});inflight.set(id,entry);let lease,sendStarted=false,commentRequestId=null;
    function commitComment(receipt){
      const event={...experience(a,receipt.state==='sent'?'completed':receipt.state==='failed'?'failed':'partial'),eventId:`${id}:experience`,idempotencyKey:`${id}:experience`,contextToken:c.contextToken,sourceKind:'bilibili-comment',channel:'bilibili-public',visibilityScope:'public',conversationId:`bilibili:video:${a.video.videoId}`,providerRequestId:commentRequestId,occurredAt:receipt.startedAt??now(),deliveryState:receipt.state,platformMessageId:receipt.platformId??null,text:receipt.text??'',summaryCandidate:receipt.state==='sent'?`已发表评论：${receipt.text}`:receipt.state==='unknown'?'评论发送结果未知，等待核对':'评论未发送成功'};
      store.transaction(()=>{settle(id,receipt.state==='failed'?'released':receipt.state==='sent'?'committed':'unknown');db.prepare('UPDATE bili_comments SET state=?,data=? WHERE id=?').run(receipt.state,JSON.stringify(receipt),id);enqueue(`${id}:experience`,a.accountId,'experience',event);});
    }
    try{
      lease=await host.invoke('activity.lease',{sourcePluginId:PLUGIN_ID,contextToken:c.contextToken,activityId:id,kind:'bilibili-comment',generation:c.generation},{signal:controller.signal});
      assert(lease?.leaseId&&Number.isSafeInteger(lease.generation),'BILI_LEASE_REQUIRED','A current comment lease is required');
      await check(c,lease,guard,controller.signal);
      const generated=await host.invoke('models.request',{sourcePluginId:PLUGIN_ID,contextToken:c.contextToken,leaseId:lease.leaseId,connectionRef:s.modelConnectionRef,purpose:'bilibili-comment',activityId:a.id,video:a.video,material:a.material,evidenceRefs:a.understanding.evidenceRefs,...publicCommentPrompt(a.video,a.material,a.understanding.evidenceRefs),channel:'bilibili-public',visibilityScope:'public',contextMode:'material-only',includePrivateMemory:false,outputSchema:'bilibili-comment-proposal-v1'},{signal:controller.signal});
      commentRequestId=generated.requestId??generated.providerRequestId??null;
      let proposal=generated?.comment;try{if(!proposal&&generated?.text)proposal=JSON.parse(generated.text);}catch{}
      assert(proposal&&typeof proposal.text==='string'&&proposal.text.trim()&&proposal.text.length<=1000&&Array.isArray(proposal.evidenceRefs)&&proposal.evidenceRefs.length>0&&proposal.evidenceRefs.every(v=>a.understanding.evidenceRefs.includes(v))&&(generated.requestId||generated.providerRequestId),'BILI_COMMENT_INVALID','The model must generate a short evidence-linked comment');
      const commentText=proposal.text;
      await check(c,lease,guard,controller.signal);
      db.prepare("UPDATE bili_comments SET data=? WHERE id=? AND state='generating'").run(JSON.stringify({id,activityId:a.id,claimId,text:commentText,startedAt:now()}),id);
      if(draftOnly){const draft={id,activityId:a.id,claimId,text:commentText,state:'draft',providerRequestId:commentRequestId,draftedAt:now()};db.prepare("UPDATE bili_comments SET state='draft',data=? WHERE id=? AND state='generating'").run(JSON.stringify(draft),id);return draft;}
      // Last gate after reservation; no await between it and handing the send to the managed adapter.
      await check(c,lease,guard,controller.signal);assert(settings().commentMode==='managed'&&settings().commentConsent,'BILI_COMMENTS_OFF','Comment authorization was revoked');
      db.prepare("UPDATE bili_comments SET state='sending' WHERE id=? AND state='generating'").run(id);sendStarted=true;
      const result=await managed.sendComment({connectionRef:s.connectionRef,context:c,lease,video:a.video,text:commentText,idempotencyKey:id,signal:controller.signal});
      const state=result?.status==='sent'&&isPlatformMessageId(result.platformId)?'sent':result?.status==='failed'?'failed':'unknown';
      const receipt={id,activityId:a.id,claimId,text:commentText,state,providerRequestId:commentRequestId,...(state==='sent'?{platformId:result.platformId}:{}),finishedAt:now()};
      commitComment(receipt);
      return receipt;
    }catch(error){
      const existing=db.prepare('SELECT state,data FROM bili_comments WHERE id=?').get(id);
      if(existing&&parse(existing.data)?.claimId===claimId&&['generating','sending'].includes(existing.state)){const state=sendStarted?'unknown':'failed',receipt={...parse(existing.data),state,providerRequestId:commentRequestId,failureCode:error.code??'BILI_COMMENT_UNKNOWN'};commitComment(receipt);return receipt;}
      if(existing)return {...parse(existing.data),state:existing.state};
      throw error;
    }finally{inflight.delete(id);if(lease)try{await host.invoke('activity.finish',{sourcePluginId:PLUGIN_ID,contextToken:c.contextToken,leaseId:lease.leaseId,activityId:id,status:finishStatus(db.prepare('SELECT state FROM bili_comments WHERE id=?').get(id)?.state)});}catch{}entry.resolve();}
  }
  // activity.finish knows completed/failed/cancelled/unknown only; any other value is refused and the lease
  // stays active. A posted comment and a stored draft are completed work.
  function finishStatus(state){return state==='sent'||state==='draft'?'completed':state==='failed'||state==='unknown'?state:'cancelled';}
  // Preview mode: post a stored draft (optionally edited by the user), with the same gates as a direct send.
  async function postDraft(activityId,principal,{expectedEpoch,text=null}={}){
    assertCurrent(expectedEpoch);
    const owner=await manage(principal),a=row(activityId),s=settings();assert(a?.accountId===owner.accountId&&a.state==='completed','BILI_COMMENT_ACTIVITY_REQUIRED','A completed, account-owned viewing is required');
    assert(s.commentMode==='managed'&&s.commentConsent,'BILI_COMMENTS_OFF','Comments are disabled');
    assert(a.day===clock().day,'BILI_COMMENT_EXPIRED','Old activities cannot replay today\'s comment allowance');
    assert(text===null||(typeof text==='string'&&text.trim().length>0&&text.length<=1000),'BILI_COMMENT_INVALID','A comment needs 1 to 1000 characters');
    const c=await context(a.characterId,principal,'bilibili-public-comment',expectedEpoch);assert(c.lifeId===a.lifeId&&c.operationId===a.operationId,'BILI_LIFE_CHANGED','This viewing belongs to an old life');
    eligible(c.accountId,{day:a.day});assert(!c.sleeping,'BILI_SLEEPING','Do not post comments during sleep');
    const guard={...a,automatic:false,controlEpoch:expectedEpoch??controlEpoch()},id=`${a.id}:comment`,claimId=randomUUID();
    // draft -> approved is the single claim; a second click sees "approved" and gets the stored row back
    const claimed=store.transaction(()=>{const prior=db.prepare('SELECT state,data FROM bili_comments WHERE id=?').get(id);if(prior?.state!=='draft')return prior??null;const d=parse(prior.data),postText=text===null?d.text:text.trim();db.prepare("UPDATE bili_comments SET state='approved',data=? WHERE id=? AND state='draft'").run(JSON.stringify({...d,claimId,postText,edited:postText!==d.text}),id);return true;});
    if(claimed!==true){assert(claimed,'BILI_COMMENT_NOT_DRAFT','There is no draft to post');return {...parse(claimed.data),state:claimed.state};}
    const controller=new AbortController(),entry={controller,accountId:a.accountId,kind:'comment',reason:null,promise:null,resolve:null};entry.promise=new Promise(resolve=>{entry.resolve=resolve;});inflight.set(id,entry);let lease,sendStarted=false;
    const draft=parse(db.prepare('SELECT data FROM bili_comments WHERE id=?').get(id).data),postActivityId=id+':post:'+claimId;
    // what the row says from the moment it is handed to the platform: the text actually sent, the model's draft kept aside
    const {postText:sentText,...kept}=draft,sending={...kept,text:sentText,...(sentText!==draft.text?{draftText:draft.text}:{})};
    // back to the user's draft with the model's own text; the edit is not kept
    const giveBack=()=>{const {postText,edited,claimId:_claim,...original}=draft;db.prepare("UPDATE bili_comments SET state='draft',data=? WHERE id=? AND state='approved'").run(JSON.stringify(original),id);};
    function commitComment(receipt){
      const event={...experience(a,receipt.state==='sent'?'completed':receipt.state==='failed'?'failed':'partial'),eventId:`${id}:experience`,idempotencyKey:`${id}:experience`,contextToken:c.contextToken,sourceKind:'bilibili-comment',channel:'bilibili-public',visibilityScope:'public',conversationId:`bilibili:video:${a.video.videoId}`,providerRequestId:draft.providerRequestId??null,occurredAt:draft.draftedAt??now(),deliveryState:receipt.state,platformMessageId:receipt.platformId??null,text:receipt.text??'',summaryCandidate:receipt.state==='sent'?`已发表评论：${receipt.text}`:receipt.state==='unknown'?'评论发送结果未知，等待核对':'评论未发送成功'};
      store.transaction(()=>{settle(id,receipt.state==='failed'?'released':receipt.state==='sent'?'committed':'unknown');db.prepare('UPDATE bili_comments SET state=?,data=? WHERE id=?').run(receipt.state,JSON.stringify(receipt),id);enqueue(`${id}:experience`,a.accountId,'experience',event);});
    }
    try{
      lease=await host.invoke('activity.lease',{sourcePluginId:PLUGIN_ID,contextToken:c.contextToken,activityId:postActivityId,kind:'bilibili-comment',generation:c.generation},{signal:controller.signal});
      assert(lease?.leaseId&&Number.isSafeInteger(lease.generation),'BILI_LEASE_REQUIRED','A current comment lease is required');
      // Last gate; no await between it and handing the send to the managed adapter.
      await check(c,lease,guard,controller.signal);assert(settings().commentMode==='managed'&&settings().commentConsent,'BILI_COMMENTS_OFF','Comment authorization was revoked');
      db.prepare("UPDATE bili_comments SET state='sending',data=? WHERE id=? AND state='approved'").run(JSON.stringify(sending),id);sendStarted=true;
      const result=await managed.sendComment({connectionRef:s.connectionRef,context:c,lease,video:a.video,text:sentText,idempotencyKey:id,signal:controller.signal});
      const state=result?.status==='sent'&&isPlatformMessageId(result.platformId)?'sent':result?.status==='failed'?'failed':'unknown';
      const receipt={...sending,state,...(state==='sent'?{platformId:result.platformId}:{}),finishedAt:now()};
      commitComment(receipt);return receipt;
    }catch(error){
      const existing=db.prepare('SELECT state,data FROM bili_comments WHERE id=?').get(id);
      // nothing left the app: the draft is the user's again
      if(existing?.state==='approved'&&parse(existing.data)?.claimId===claimId){giveBack();throw error;}
      if(existing?.state==='sending'&&parse(existing.data)?.claimId===claimId){const receipt={...sending,state:sendStarted?'unknown':'failed',failureCode:error.code??'BILI_COMMENT_UNKNOWN'};commitComment(receipt);return receipt;}
      if(existing)return {...parse(existing.data),state:existing.state};
      throw error;
    }finally{inflight.delete(id);if(lease)try{const state=db.prepare('SELECT state FROM bili_comments WHERE id=?').get(id)?.state;await host.invoke('activity.finish',{sourcePluginId:PLUGIN_ID,contextToken:c.contextToken,leaseId:lease.leaseId,activityId:postActivityId,status:state==='sent'?'completed':['failed','unknown'].includes(state)?state:'cancelled'});}catch{}entry.resolve();}
  }
  // Preview mode: the user does not want this draft. Nothing was posted; the reservation goes back.
  async function discardDraft(activityId,principal){
    const owner=await manage(principal),a=row(activityId);assert(a?.accountId===owner.accountId,'BILI_NOT_FOUND','Activity was not found');
    const id=`${a.id}:comment`;
    return store.transaction(()=>{const prior=db.prepare('SELECT state,data FROM bili_comments WHERE id=?').get(id);assert(prior,'BILI_COMMENT_NOT_DRAFT','There is no draft to discard');if(prior.state!=='draft')return {...parse(prior.data),state:prior.state};const receipt={...parse(prior.data),state:'discarded',discardedAt:now()};settle(id,'released');db.prepare("UPDATE bili_comments SET state='discarded',data=? WHERE id=? AND state='draft'").run(JSON.stringify(receipt),id);return receipt;});
  }
  // Crash recovery never repeats a model call or an externally accepted send.
  store.transaction(()=>{
    for(const a of activities(null,['selecting','acquiring-material','understanding'])){a.state='paused';a.pauseReason='restart';a.needsReview=a.modelState==='started';settle(a.id,'released');save(a);
    }
    db.prepare("UPDATE bili_comments SET state='unknown' WHERE state='sending'").run();
    for(const rec of db.prepare("SELECT id,data FROM bili_comments WHERE state='approved'").all()){const {postText,edited,claimId,...original}=parse(rec.data);db.prepare("UPDATE bili_comments SET state='draft',data=? WHERE id=?").run(JSON.stringify(original),rec.id);}
    db.prepare("UPDATE bili_comments SET state='failed' WHERE state='generating'").run();
    db.prepare("UPDATE bili_reservations SET status='released' WHERE kind='comment' AND status='reserved' AND id IN (SELECT id FROM bili_comments WHERE state='failed')").run();
    db.prepare("UPDATE bili_reservations SET status='unknown' WHERE kind='comment' AND status='reserved' AND id NOT IN (SELECT id FROM bili_comments WHERE state='draft')").run();
    for(const rec of db.prepare("SELECT data FROM bili_schedules WHERE state='running'").all()){const s=parse(rec.data);s.state='paused';saveSchedule(s);}
    for(const s of videoSchedules(store.get('accountId',null)))if(s.state==='running'){s.state='paused';saveSchedule(s);}
  });
  async function dispatchInternal(action,payload={},principal,expectedEpoch){
    assert(!closing,'BILI_CLOSED','The plugin is closed');
    const owner=await manage(principal),accountId=owner.accountId;
    if(['now','continue','schedule.create','schedule.start','settings.update','idle','tick','comment.send','comment.draft','comment.post'].includes(action)||action==='today.allow'&&payload.allowed===true)assertCurrent(expectedEpoch);
    if(action==='settings.read')return {settings:settings(),accountId,timeZone,sourceMode:owner.sourceMode??'unverified-host',characters:catalogCharacters(owner),connections:catalogConnections(owner),todayAllowed:store.get(`day:${accountId}:${clock().day}`,true),stopped:store.get('stopped',false)};
    if(action==='settings.update'){
      const previous=settings(),next=validSettings(payload,previous);saveSettings(next);
      if(['connectionRef','modelConnectionRef','startMinute','endMinute'].some(key=>previous[key]!==next[key]))revokeControl(accountId,'settings-changed');
      if(previous.autonomousEnabled&&!next.autonomousEnabled)for(const[id,entry]of inflight){if(row(id)?.automatic){entry.reason='autonomous-disabled';entry.controller.abort();}}
      if(previous.commentMode==='managed'&&next.commentMode!=='managed'||previous.commentConsent&&!next.commentConsent)for(const entry of inflight.values())if(entry.kind==='comment'){entry.reason='comments-disabled';entry.controller.abort();}
      if(next.shareMode==='record-only')for(const rec of db.prepare("SELECT id,data FROM bili_outbox WHERE account_id=? AND kind='share' AND state='pending'").all(accountId))if(parse(rec.data).kind==='bilibili-share')db.prepare("UPDATE bili_outbox SET state='cancelled' WHERE id=?").run(rec.id);
      return next;
    }
    if(action==='history.list')return activities(accountId,null,200).map(a=>{return {...a,comments:db.prepare('SELECT state,data FROM bili_comments WHERE account_id=? AND activity_id=? ORDER BY rowid').all(accountId,a.id).map(c=>({...parse(c.data),state:c.state}))};});
    if(action==='activity.read'){const a=row(payload.id);assert(a?.accountId===accountId,'BILI_NOT_FOUND','Activity was not found');return a;}
    if(action==='comments.list')return db.prepare('SELECT state,data FROM bili_comments WHERE account_id=? ORDER BY rowid DESC').all(accountId).map(v=>({...parse(v.data),state:v.state}));
    if(action==='reading.pending.list'){
      // Unconfirmed complete plans are durable records, independent of the recent-history limit.
      // Only paused full-reading candidates need a scoped host read; completed history is never scanned there.
      const candidates=db.prepare("SELECT value FROM a_plugin_kv WHERE key GLOB 'full-activity-v206:*' AND json_extract(value,'$.accountId')=? AND json_extract(value,'$.state')='paused' ORDER BY rowid DESC").all(accountId).map(v=>parse(v.value)),pending=[];
      for(const a of candidates){
        const checkpoint=store.get('reading-full-v1:'+a.id,null);if(a.readingMode!=='full-v1'||!checkpoint?.planHash||checkpoint.confirmed===true||!['awaiting-confirmation','paused'].includes(checkpoint.phase))continue;
        const value=await host.invoke('connections.request',{platform:'bilibili',contextToken:owner.contextToken,connectionRef:a.connectionRef,operation:'video.fullReading.get',parameters:{readingId:a.id}}),state=value.reading??value;assertOpen();
        if(state.confirmed===false&&['awaiting-confirmation','paused'].includes(state.phase))pending.push({...a,reading:{activityId:a.id,readingMode:'full-v1',confirmed:false,phase:state.phase,planHash:state.planHash}});
      }
      return pending;
    }
    if(action.startsWith('reading.')){
      const a=row(payload.activityId);assert(a?.accountId===accountId,'BILI_NOT_FOUND','Reading was not found');assert(a.visual,'BILI_VISION_READING_UNAVAILABLE','This record predates picture reading');
      if(a.readingMode==='full-v1'){
        const record=()=>store.get('reading-full-v1:'+a.id,null),call=async(operation,parameters={})=>{assertOpen();return host.invoke('connections.request',{platform:'bilibili',contextToken:owner.contextToken,connectionRef:a.connectionRef,operation:'video.fullReading.'+operation,parameters:{readingId:a.id,...parameters}});};
        if(action==='reading.get'){
          const revision=readingControl(a.id),value=await call('get');assertOpen();const state=value.reading??value,current=row(a.id),local=record();
          if(expectedEpoch===controlEpoch()&&revision===readingControl(a.id)&&current.state!=='cancelled'&&local&&(local.pending||current.needsReview||current.modelState==='started')&&(state.recoveredResults??[]).length){
            store.transaction(()=>{
              assertCurrent(expectedEpoch);assert(readingControl(a.id)===revision,'BILI_CONTROL_STALE','A newer control superseded receipt recovery');
              const next=recoverFullReadingRecord(local,state,result=>writeFullResult(a.id,result),stepId=>store.get('full-result-v206:'+a.id+':'+stepId,null));if(next===local)return;
              store.set('reading-full-v1:'+a.id,next);
              if(current.lastFailureCode)current.failureHistory=[...(current.failureHistory??[]),{code:current.lastFailureCode,pauseReason:current.pauseReason??null,at:current.updatedAt,recoveredAt:now()}];
              if(current.state==='failed'){current.receiptRecoveryFailures=[...(current.receiptRecoveryFailures??[]),{code:current.lastFailureCode,at:current.updatedAt,recoveredAt:now()}];current.state='paused';current.pauseReason='receipt-recovered';}
              const invalid=Object.keys(next.invalidReceipts??{}).length>0;current.needsReview=next.needsReview===true||!!next.pending;current.modelState=invalid?'returned':'prepared';current.lastFailureCode=invalid?'BILI_FULL_MATERIAL_NOT_COMPLETED':null;if(invalid){current.state='paused';current.pauseReason='BILI_FULL_MATERIAL_NOT_COMPLETED';}save(current);
            });
          }
          return fullReadingView(row(a.id),state);
        }
        if(action==='reading.image')return call('image',{ref:payload.ref});
        if(action==='reading.open')return call('open',{activityId:a.id});
        if(action==='reading.pause'||action==='reading.stop'){readingControls.set(a.id,readingControl(a.id)+1);const entry=inflight.get(a.id);if(entry){entry.reason=action==='reading.pause'?'pause':'stop';entry.controller.abort();await entry.promise;}await call(action==='reading.pause'?'pause':'stop');const current=row(a.id);if(!terminal.has(current.state)||action==='reading.stop'&&current.state==='failed'&&zeroCallFailure(current,record())){if(current.state==='failed')retainZeroCallFailure(current,'stop');current.state=action==='reading.pause'?'paused':'cancelled';current.pauseReason=action==='reading.pause'?'pause':'stop';save(current);if(current.state==='cancelled')settle(current.id,'released');}return {activityId:a.id,paused:action==='reading.pause',stopped:action==='reading.stop'};}
        if(action==='reading.replan'){const prior=await call('get');assert(!(prior.reading??prior).confirmed,'BILI_FULL_PLAN_FROZEN','Confirmed plans remain frozen; start a separate new viewing');await call('stop');a.state='cancelled';a.pauseReason='replanned';save(a);settle(a.id,'released');return begin({characterId:a.characterId,videoId:a.video.videoId,visual:true,selectedCids:payload.selectedCids,fullConfig:payload.config},principal,expectedEpoch);}
        if(action==='reading.confirm'||action==='reading.continue'){
          assertCurrent(expectedEpoch);const revision=readingControl(a.id),original=JSON.stringify(a),originalCheckpoint=JSON.stringify(record()),guard=()=>{assertOpen();assertCurrent(expectedEpoch);assert(readingControl(a.id)===revision,'BILI_CONTROL_STALE','A newer reading control superseded this request');};
          assert(a.modelConnectionRef===settings().modelConnectionRef,'BILI_VISION_MODEL_CHANGED_RESTART_REQUIRED','Start a separate reading to use another model');assert(!a.needsReview&&!record()?.pending,'BILI_VISION_UNCERTAIN','An unknown submission cannot be replayed');assert(!Object.keys(record()?.invalidReceipts??{}).length,'BILI_FULL_MATERIAL_NOT_COMPLETED','The original paid invalid response is retained and cannot be replayed');
          let value;
          if(action==='reading.confirm'){
            assert(payload.confirmed===true,'BILI_FULL_PLAN_CONFIRMATION_REQUIRED','Explicit confirmation of this frozen plan is required');
            const preview=await call('get'),hostState=preview.reading??preview;guard();
            assert(hostState.readingId===a.id&&typeof payload.planHash==='string'&&payload.planHash===hostState.planHash&&payload.planHash===record()?.planHash,'BILI_FULL_PLAN_CONFIRMATION_REQUIRED','Confirmation must match the original frozen plan');
            assert(hostState.needsReview!==true&&(!Array.isArray(hostState.calls)||!hostState.calls.some(x=>['submitted','unknown'].includes(x.status))),'BILI_VISION_UNCERTAIN','An unknown submission cannot be confirmed or replayed');
            if(a.state!=='paused'||hostState.confirmed===true){assert(hostState.confirmed===true,'BILI_FULL_PLAN_CONFIRMATION_REQUIRED','Only a paused preview can receive new confirmation');value=preview;}
            else{
              assert(hostState.confirmed===false&&['awaiting-confirmation','paused'].includes(hostState.phase),'BILI_FULL_PLAN_CONFIRMATION_REQUIRED','Preview the frozen plan before confirming');
              assert(!inflight.has(a.id)&&!confirmingReadings.has(a.id)&&JSON.stringify(row(a.id))===original&&JSON.stringify(record())===originalCheckpoint,'BILI_CONTROL_STALE','The reading changed while confirmation was being checked');
              confirmingReadings.add(a.id);try{value=await call('confirm',{confirmed:true,planHash:payload.planHash});}finally{confirmingReadings.delete(a.id);}
            }
          }else value=await call('get');
          const state=value.reading??value;guard();assert(state.confirmed===true,'BILI_FULL_PLAN_CONFIRMATION_REQUIRED','Preview and confirm the full plan first');assert(state.needsReview!==true&&(!Array.isArray(state.calls)||!state.calls.some(x=>['submitted','unknown'].includes(x.status))),'BILI_VISION_UNCERTAIN','An unknown submission cannot be resumed');
          if(action==='reading.continue'&&a.state==='failed'){
            assert(recoverableZeroCall(a,state),'BILI_VISION_UNCERTAIN','Only a host-proven zero-call lease failure can be resumed');
            const c=await context(a.characterId,principal,'bilibili-activity',expectedEpoch);guard();assert(c.accountId===a.accountId&&c.characterId===a.characterId&&c.personaId===a.personaId&&c.lifeId===a.lifeId&&c.operationId===a.operationId&&c.generation===a.generation,'BILI_LIFE_CHANGED','This reading belongs to another account or life');eligible(accountId,{...a,automatic:false});
            store.transaction(()=>{guard();const current=row(a.id),local=record();assert(!inflight.has(a.id)&&JSON.stringify(current)===original&&JSON.stringify(local)===originalCheckpoint&&recoverableZeroCall(current,state),'BILI_CONTROL_STALE','The failed reading changed while recovery was being checked');if(current.scheduleId)assert(!['cancelled','completed'].includes(getSchedule(current.scheduleId)?.state),'BILI_SCHEDULE_CANCELLED','This reading plan was cancelled');retainZeroCallFailure(current,'manual-zero-call');current.state='paused';current.pauseReason='zero-call-recovery';current.lastFailureCode=null;save(current);store.set('reading-full-v1:'+a.id,syncFullReadingRecord(local,state));});
          }else if(action==='reading.confirm'){
            const current=row(a.id);assert(JSON.stringify(current)===original,'BILI_CONTROL_STALE','The reading changed while confirmation was being checked');store.set('reading-full-v1:'+a.id,syncFullReadingRecord(record(),state));
          }
          guard();const current=row(a.id);if(current.state!=='paused')return fullReadingView(current,state);store.set('stopped',false);store.set('pausedByUser',false);store.set('chatActive',false);return tick(principal,accountId,true,expectedEpoch,a.id,guard);
        }
        throw fail('BILI_FULL_PLAN_FROZEN','This action is not part of the frozen complete-reading plan');
      }
      const managedCall=async(operation,parameters={})=>host.invoke('connections.request',{platform:'bilibili',contextToken:owner.contextToken,connectionRef:settings().connectionRef,operation,parameters:{readingId:a.id,...parameters}});
      if(action==='reading.get'){let value;try{value=await managedCall('video.storyboard.get');}catch(error){const pending=store.get('reading-v21:'+a.id,null),beforePrepare=pending?.phase==='preparing'&&!pending.pending&&Object.keys(pending.results??{}).length===0&&['BILI_VISION_MODEL_UNSUPPORTED','BILI_VISION_MODEL_REQUIRED','BILI_VISION_UNAVAILABLE','BILI_VISION_UNSUPPORTED'].includes(a.lastFailureCode);if(error.code!=='BILI_VISION_READING_UNAVAILABLE'||!beforePrepare)throw error;value={readingId:a.id,phase:a.state,cells:[],segments:[],progress:{completed:0,total:0},remaining:null,zoomRemaining:null,budgetKnown:false};}return {...(value.reading??value),activityId:a.id,needsReview:a.needsReview===true||!!store.get('reading-v21:'+a.id,null)?.pending,phase:['paused','partial','completed','cancelled','failed'].includes(a.state)?a.state:(value.reading??value).phase,modelReason:a.lastFailureCode??null,results:Object.values(store.get('reading-v21:'+a.id,{results:{}}).results??{}).map(x=>({stepId:x.stepId,from:x.from,to:x.to,summary:x.understanding.summary,notes:x.understanding.notes,evidenceRefs:x.understanding.evidenceRefs}))};}
      if(action==='reading.image')return managedCall('video.storyboard.image',{ref:payload.ref});
      if(action==='reading.open')return managedCall('video.storyboard.open',{activityId:a.id});
      if(action==='reading.pause'){const entry=inflight.get(a.id);if(!entry)return {paused:a.state==='paused',activityId:a.id};entry.reason='pause';entry.controller.abort();await entry.promise;return {paused:row(a.id)?.state==='paused',activityId:a.id};}
      if(action==='reading.stop'){const entry=inflight.get(a.id);if(entry){entry.reason='stop';entry.controller.abort();await entry.promise;}await managedCall('video.storyboard.stop');const current=row(a.id);if(current&&!terminal.has(current.state)){current.state='cancelled';current.pauseReason='stop';save(current);settle(current.id,'released');}return {stopped:true};}
      if(action==='reading.continue'){assert(a.modelConnectionRef===settings().modelConnectionRef,'BILI_VISION_MODEL_CHANGED_RESTART_REQUIRED','The selected model changed; explicitly start this video again to keep its original request history');assert(['paused','completed','partial'].includes(a.state)&&!a.needsReview&&!store.get('reading-v21:'+a.id,null)?.pending,'BILI_VISION_UNCERTAIN','An unknown model result needs review before resuming');if(payload.confirmed===true){assert(payload.additionalCalls===16,'BILI_VISION_BUDGET_INVALID','Additional budget must be16');await managedCall('video.storyboard.continue',{confirmed:true,additionalCalls:16});}if(a.state!=='paused')return managedCall('video.storyboard.get');store.set('stopped',false);store.set('pausedByUser',false);store.set('chatActive',false);return tick(principal,accountId,true,expectedEpoch,a.id);}
      if(action==='reading.zoom'){
        assert(a.modelConnectionRef===settings().modelConnectionRef,'BILI_VISION_MODEL_CHANGED_RESTART_REQUIRED','The selected model changed; explicitly start this video again');
        assert((a.state==='completed'||a.state==='partial')&&!store.get('reading-v21:'+a.id,null)?.pending,'BILI_VISION_READING_BUSY','Finish the current reading before requesting detail');assert(Number.isFinite(payload.from)&&Number.isFinite(payload.to)&&payload.from>=0&&payload.to>payload.from&&payload.to<=a.video.duration,'BILI_VISION_RANGE_INVALID','Choose a valid range');
        const c=await context(a.characterId,principal,'bilibili-activity',expectedEpoch);assert(c.lifeId===a.lifeId&&c.operationId===a.operationId,'BILI_LIFE_CHANGED','This reading belongs to an old life');assert(!inflight.has(a.id),'BILI_VISION_READING_BUSY','This reading already has an active operation');const zoomId=a.id+':zoom:'+randomUUID();const lease=await host.invoke('activity.lease',{sourcePluginId:PLUGIN_ID,contextToken:c.contextToken,activityId:zoomId,kind:'bilibili',generation:c.generation});const controller=new AbortController(),entry={controller,accountId,reason:null,promise:null};inflight.set(a.id,entry);
        const operation=(async()=>{try{const result=await runVisualReading({a,c,lease,host,material:a.material,signal:controller.signal,check:()=>check(c,lease,{...a,controlEpoch:expectedEpoch},controller.signal),readRecord:()=>store.get('reading-v21:'+a.id,null),writeRecord:value=>store.set('reading-v21:'+a.id,value),zoom:{from:payload.from,to:payload.to}});return {summary:result.understanding.summary,notes:result.understanding.notes,readingId:a.id};}finally{await host.invoke('activity.finish',{sourcePluginId:PLUGIN_ID,contextToken:c.contextToken,leaseId:lease.leaseId,activityId:zoomId,status:controller.signal.aborted?'cancelled':'completed'}).catch(()=>{});inflight.delete(a.id);}})();entry.promise=operation;return operation;
      }
      throw fail('BILI_ACTION_INVALID','Unknown reading action');
    }
    if(action==='quota.read')return {day:clock().day,limits:{watch:settings().dailyWatchLimit,comment:settings().dailyCommentLimit},rows:db.prepare("SELECT kind,status,COUNT(*) count FROM bili_reservations WHERE account_id=? AND day=? AND status!='released' GROUP BY kind,status").all(accountId,clock().day)};
    if(action==='schedule.list')return allSchedules(accountId).reverse().map(scheduleView);
    if(action==='schedule.create'){
      assert(Array.isArray(payload.participants)&&payload.participants.length>0&&payload.participants.length<=16&&payload.participants.every(v=>typeof v==='string'&&v),'BILI_SCHEDULE_INVALID','Choose participating characters');
      assert(Number.isInteger(payload.count)&&payload.count>=1&&payload.count<=1000,'BILI_SCHEDULE_INVALID','Choose a positive video count');
      const startMinute=payload.startMinute??settings().startMinute,endMinute=payload.endMinute??settings().endMinute;assert(Number.isInteger(startMinute)&&Number.isInteger(endMinute)&&startMinute>=0&&endMinute<=1440&&startMinute<endMinute,'BILI_SCHEDULE_INVALID','Invalid activity window');
      const day=payload.day??clock().day;assert(/^\d{4}-\d{2}-\d{2}$/.test(day)&&day>=clock().day,'BILI_SCHEDULE_INVALID','A schedule cannot use past authorization');
      const content=scheduleContent(payload),schedule=saveSchedule({id:randomUUID(),accountId,participants:[...new Set(payload.participants)],remaining:payload.count,participantIndex:0,day,startMinute,endMinute,state:'scheduled',dreamOffered:false,createdAt:now(),...(payload.visualReading===true?{visualReading:true}:{}),...(content.watchMode==='video'?content:{})});if(content.watchMode==='video')confirmedPlans.add(schedule.id);return scheduleView(schedule);
    }
    if(action==='schedule.start'){assert((payload.confirm===undefined||typeof payload.confirm==='boolean')&&(payload.confirmOnly===undefined||typeof payload.confirmOnly==='boolean'),'BILI_SCHEDULE_INVALID','Invalid confirmation');return startSchedule(payload.scheduleId,principal,accountId,expectedEpoch,payload);}
    if(action==='schedule.cancel')return cancelSchedule(payload.scheduleId,accountId);
    if(action==='now'){store.set('stopped',false);store.set('pausedByUser',false);return begin({characterId:payload.characterId,videoId:payload.videoId??null,visual:payload.visual===true,selectedCids:payload.selectedCids??null,fullConfig:payload.config??null},principal,expectedEpoch);}
    if(action==='pause'||action==='user.return'){if(action==='pause')store.set('pausedByUser',true);revokeControl(accountId,action==='pause'?'pause':'user-return');store.set('chatActive',action==='user.return');return {paused:true,reason:action};}
    if(action==='stop'){stopAccount(accountId);return {stopped:true};}
    if(action==='today.allow'){assert(typeof payload.allowed==='boolean','BILI_PERMISSION_INVALID','Choose whether watching is allowed today');store.set(`day:${accountId}:${clock().day}`,payload.allowed);if(!payload.allowed){db.prepare("UPDATE bili_outbox SET state='cancelled' WHERE account_id=? AND kind='share' AND state='pending'").run(accountId);revokeControl(accountId,'today-forbidden');}return {day:clock().day,allowed:payload.allowed};}
    if(action==='continue'){assert(!store.get('stopped',false),'BILI_STOPPED','Create a new explicit activity after stopping');store.set('pausedByUser',false);store.set('chatActive',false);return tick(principal,accountId,true,expectedEpoch);}
    if(action==='idle'){store.set('chatActive',false);if(settings().resumeMode!=='idle')return {resumed:false,reason:'manual-resume'};return tick(principal,accountId,false,expectedEpoch);}
    if(action==='tick')return tick(principal,accountId,false,expectedEpoch);
    if(action==='comment.send'){assert(settings().commentReview!=='preview','BILI_COMMENT_PREVIEW_REQUIRED','Comments are set to preview before posting');return sendComment(payload.activityId,principal,{expectedEpoch});}
    if(action==='comment.draft')return sendComment(payload.activityId,principal,{expectedEpoch,draftOnly:true});
    if(action==='comment.post')return postDraft(payload.activityId,principal,{expectedEpoch,text:payload.text??null});
    if(action==='comment.discard')return discardDraft(payload.activityId,principal);
    if(action==='outbox.flush'){await flushOutbox(accountId);const pending=db.prepare("SELECT id FROM bili_outbox WHERE account_id=? AND state='pending'").all(accountId);return {pending:pending.length,errors:pending.map(v=>({id:v.id,error:store.get(`outbox-error:${v.id}`,null)})).filter(v=>v.error)};}
    throw fail('BILI_ACTION_UNKNOWN','Unknown Bilibili action');
  }
  function stopAccount(accountId){
    store.transaction(()=>{
      store.set('stopped',true);store.set('pausedByUser',true);db.prepare("UPDATE bili_outbox SET state='cancelled' WHERE account_id=? AND kind='share' AND state='pending'").run(accountId);revokeControl(accountId,'stop');
      for(const a of activities(accountId,['paused','failed'])){
        if(a.state==='failed'){if(!zeroCallFailure(a,checkpoint(a.id)))continue;retainZeroCallFailure(a,'stop');}
        a.state='cancelled';a.pauseReason='stop';a.lastFailureCode='BILI_STOPPED';save(a);settle(a.id,a.effective&&a.modelState==='returned'?'committed':'released');const event=experience(a,'cancelled');event.eventId=`${a.id}:stopped`;event.idempotencyKey=event.eventId;enqueue(event.eventId,a.accountId,'experience',event);
      }
      for(const s of allSchedules(accountId))if(!terminal.has(s.state)){s.state='cancelled';confirmedPlans.delete(s.id);saveSchedule(s);}
    });
  }
  async function tick(principal,accountId,manual,expectedEpoch,targetActivityId=null,claimGuard=null){
    assertCurrent(expectedEpoch);claimGuard?.();
    if(store.get('stopped',false))return {resumed:false,reason:'BILI_STOPPED'};
    if(store.get('chatActive',false))return {resumed:false,reason:'user-chat-active'};
    const s=settings();
    if(!manual&&!s.autonomousEnabled)return {resumed:false,reason:'autonomous-disabled'};
    let blocked=null;
    function retirePaused(a,code){store.transaction(()=>{a.state='cancelled';a.lastFailureCode=code;save(a);settle(a.id,a.effective&&a.modelState==='returned'?'committed':'released');const event=experience(a,'cancelled');event.eventId=`${a.id}:retired:${code}`;event.idempotencyKey=event.eventId;enqueue(event.eventId,a.accountId,'experience',event);if(a.scheduleId){const parent=getSchedule(a.scheduleId);if(parent){parent.state='cancelled';parent.expired=code==='BILI_SCHEDULE_EXPIRED';saveSchedule(parent);}}});}
    const candidates=activities(accountId,['paused']).filter(a=>!targetActivityId||a.id===targetActivityId);
    for(const paused of candidates){
      if(paused.day<clock().day||paused.day===clock().day&&clock().minute>=paused.endMinute){retirePaused(paused,'BILI_SCHEDULE_EXPIRED');continue;}
      // "Wait for me" (resumeMode manual) holds every automatic resume; "resume when idle" continues interruptions.
      if(!manual&&(s.resumeMode!=='idle'||!['user-return','restart','autonomous-disabled'].includes(paused.pauseReason))){blocked={resumed:false,reason:'manual-resume-required',activityId:paused.id};continue;}
      if(paused.scheduleId&&needsConfirmation(getSchedule(paused.scheduleId))){blocked={resumed:false,reason:'target-confirmation-required',scheduleId:paused.scheduleId};continue;}
      if(paused.visual&&paused.modelConnectionRef!==s.modelConnectionRef){blocked={resumed:false,reason:'BILI_VISION_MODEL_CHANGED_RESTART_REQUIRED',activityId:paused.id};continue;}
      if(paused.needsReview){blocked={resumed:false,reason:'uncertain-model-not-retried',activityId:paused.id};continue;}
      try{
        const c=await context(paused.characterId,principal,'bilibili-activity',expectedEpoch);claimGuard?.();if(c.lifeId!==paused.lifeId||c.operationId!==paused.operationId){retirePaused(paused,'BILI_LIFE_CHANGED');continue;}
        eligible(accountId,{...paused,automatic:!manual});if(c.sleeping)return {resumed:false,reason:'waiting-sleep'};
        paused.contextToken=c.contextToken;paused.generation=c.generation;paused.controlEpoch=expectedEpoch??controlEpoch();paused.connectionRef=settings().connectionRef;paused.modelConnectionRef=settings().modelConnectionRef;if(manual)paused.automatic=false;
        const claimed=store.transaction(()=>{claimGuard?.();if(row(paused.id)?.state!=='paused')return false;reserve(paused.id,accountId,paused.day,'watch');clearResumedPause(paused,now());paused.state='selecting';save(paused);if(paused.scheduleId){const parent=getSchedule(paused.scheduleId);if(parent&&parent.state!=='cancelled'){parent.state='running';saveSchedule(parent);}}return true;});
        if(!claimed)return {resumed:false,reason:'activity-already-resuming'};
        const controller=new AbortController(),entry={controller,accountId,reason:null,promise:null};inflight.set(paused.id,entry);entry.promise=perform(paused,c,controller.signal,principal);const result=await entry.promise;
        if(paused.scheduleId&&['completed','partial','recording'].includes(result.state))store.transaction(()=>settleScheduleOnce(result));
        return result;
      }catch(error){if(['BILI_CONTROL_STALE','BILI_CLOSED'].includes(error.code))throw error;blocked={resumed:false,reason:error.code??'BILI_RESUME_FAILED'};}
    }
    if(targetActivityId)return blocked??{resumed:false,reason:'reading-not-resumable',activityId:targetActivityId};
    const all=allSchedules(accountId).filter(s=>['scheduled','waiting-sleep','paused'].includes(s.state));
    for(const schedule of all){
      if(schedule.day<clock().day){schedule.state='cancelled';schedule.expired=true;saveSchedule(schedule);continue;}
      if(needsConfirmation(schedule)){blocked={resumed:false,reason:'target-confirmation-required',scheduleId:schedule.id};continue;}
      if(schedule.day!==clock().day||clock().minute<schedule.startMinute||clock().minute>=schedule.endMinute)continue;
      if(!manual&&schedule.deferredForConnectionRef===s.modelConnectionRef&&schedule.nextEligibleAt>now())continue;
      const predecessor=activities(accountId,['paused','selecting','acquiring-material','understanding']).find(a=>a.scheduleId===schedule.id);
      if(predecessor){if(predecessor.needsReview)blocked={resumed:false,reason:'uncertain-model-not-retried',activityId:predecessor.id};continue;}
      const result=await runSchedule(schedule,principal,accountId,manual,expectedEpoch);
      if(result===null)continue;
      return result;
    }
    return blocked??{resumed:false,reason:'no-eligible-schedule'};
  }
  // One plan run: eligibility, an atomic claim, the viewing, then the plan's count. null: another run claimed it.
  async function runSchedule(schedule,principal,accountId,manual,expectedEpoch){
    try{
      eligible(accountId,{...schedule,automatic:!manual});
      const claimed=store.transaction(()=>{const current=getSchedule(schedule.id);if(!['scheduled','waiting-sleep','paused'].includes(current?.state)||needsConfirmation(current))return false;current.state='running';saveSchedule(current);return true;});
      if(!claimed)return null;
      const characterId=schedule.participants[schedule.participantIndex%schedule.participants.length];
      const result=await begin({characterId,videoId:schedule.watchMode==='video'?scheduleContent(schedule).videoId:null,schedule,manual},principal,expectedEpoch);
      if(result.state==='waiting-sleep'||result.state==='deferred')return result;
      if(getSchedule(schedule.id)?.state==='cancelled')return result;
      if(['completed','partial','recording'].includes(result.state))store.transaction(()=>settleScheduleOnce(result));
      else{const current=getSchedule(schedule.id);if(current&&current.state!=='cancelled'){current.state=result.state==='paused'?'paused':'failed';saveSchedule(current);}}
      return result;
    }catch(error){if(getSchedule(schedule.id)?.state==='running'){schedule.state='paused';saveSchedule(schedule);}return {resumed:false,reason:error.code??'BILI_SCHEDULE_FAILED'};}
  }
  // "Watch now" on a plan row: the plan's next participant starts at once, inside the plan's own window and counted
  // toward it. It is a manual start (no off-peak wait, no autonomous permission needed), like Continue on a plan.
  async function startSchedule(id,principal,accountId,expectedEpoch,{confirm=false,confirmOnly=false,visual=false}={}){
    const schedule=getSchedule(id);
    assert(schedule&&schedule.accountId===accountId,'BILI_NOT_FOUND','Plan was not found');
    assert(['scheduled','waiting-sleep','paused'].includes(schedule.state)&&schedule.remaining>0&&schedule.day===clock().day,'BILI_SCHEDULE_NOT_STARTABLE','This plan cannot start now');
    assert(!needsConfirmation(schedule)||confirm,'BILI_SCHEDULE_CONFIRM_REQUIRED','Confirm this specific-video plan after restarting');
    if(confirmOnly){assert(confirm&&schedule.watchMode==='video','BILI_SCHEDULE_INVALID','Only specific-video plans need confirmation');confirmedPlans.add(id);return scheduleView(schedule);}
    if(visual===true){schedule.visualReading=true;saveSchedule(schedule);}
    if(confirm&&schedule.watchMode==='video')confirmedPlans.add(id);
    assert(!activities(accountId,['paused','selecting','acquiring-material','understanding']).some(a=>a.scheduleId===id),'BILI_SCHEDULE_BUSY','This plan already has a viewing in progress or paused');
    store.set('stopped',false);store.set('pausedByUser',false);
    const result=await runSchedule(schedule,principal,accountId,true,expectedEpoch);
    assert(result,'BILI_SCHEDULE_NOT_STARTABLE','This plan cannot start now');
    if(result.resumed===false)throw fail(result.reason,'The plan did not start');
    return result;
  }
  // A plan that is not running can be cancelled; its paused viewing ends with it. Nothing already watched changes.
  function cancelSchedule(id,accountId){
    return store.transaction(()=>{
      const schedule=getSchedule(id);
      assert(schedule&&schedule.accountId===accountId,'BILI_NOT_FOUND','Plan was not found');
      if(['cancelled','completed'].includes(schedule.state))return schedule;
      assert(schedule.state!=='running','BILI_SCHEDULE_RUNNING','Pause or stop the viewing of this plan first');
      for(const a of activities(accountId,['paused'])){
        if(a.scheduleId!==id)continue;
        a.state='cancelled';a.pauseReason='plan-cancelled';a.lastFailureCode='BILI_SCHEDULE_CANCELLED';save(a);settle(a.id,a.effective&&a.modelState==='returned'?'committed':'released');
        const event=experience(a,'cancelled');event.eventId=`${a.id}:plan-cancelled`;event.idempotencyKey=event.eventId;enqueue(event.eventId,a.accountId,'experience',event);
      }
      schedule.state='cancelled';schedule.cancelledAt=now();confirmedPlans.delete(id);return scheduleView(saveSchedule(schedule));
    });
  }
  function close(excludedOperation=null){
    if(closePromise)return closePromise;closing=true;
    closePromise=(async()=>{for(const entry of inflight.values()){entry.reason='close';entry.controller.abort();}await Promise.allSettled([...operations].filter(v=>v!==excludedOperation).map(v=>v.promise));await Promise.allSettled([...inflight.values()].map(v=>v.promise).filter(Boolean));const warnings=await clearLiveBubbles();confirmedPlans.clear();if(store.get('runtimeOwner',null)?.instanceId===instanceId)store.set('runtimeOwner',null);store.close();return {closed:true,warnings};})();
    return closePromise;
  }
  async function onHostEventInternal(event,expectedEpoch,operation){
    assert(!closing,'BILI_CLOSED','The plugin is closed');
    assert(event&&typeof event.principal?.contextToken==='string','BILI_BACKGROUND_PRINCIPAL_REQUIRED','A fresh host event principal is required');
    const c=await host.invoke('social.context.read',{purpose:'plugin-background',principal:event.principal,sourcePluginId:PLUGIN_ID});
    assertOpen();
    assert(c?.permissions?.includes('plugin.activity')&&typeof c.accountId==='string'&&c.accountId,'BILI_BACKGROUND_DENIED','This event has no plugin activity permission');accountMatches(c.accountId);
    managedCatalog=Array.isArray(c.managedConnections)?c.managedConnections:[];
    const type=event.type??event.kind;
    if(type==='app.exit'){await close(operation);return {stopped:true};}
    if(type==='revoke'||type==='lifecycle.revoke'){stopAccount(c.accountId);return {revoked:true};}
    if(type==='user.return'){store.set('chatActive',true);revokeControl(c.accountId,'user-return');return {paused:true,reason:'user-return'};}
    if(['idle','tick','awake'].includes(type))assertCurrent(expectedEpoch);
    if(type==='idle'){store.set('chatActive',false);if(settings().resumeMode!=='idle')return {resumed:false,reason:'manual-resume'};return publicValue(await tick(event.principal,c.accountId,false,expectedEpoch));}
    if(type==='tick'||type==='awake')return publicValue(await tick(event.principal,c.accountId,false,expectedEpoch));
    throw fail('BILI_HOST_EVENT_UNKNOWN','Unknown host activity event');
  }
  function tracked(fn){
    if(closing)return Promise.reject(fail('BILI_CLOSED','The plugin is closed'));
    const epoch=controlEpoch(),operation={promise:null};operation.promise=Promise.resolve().then(()=>fn(epoch,operation));operations.add(operation);
    operation.promise.then(()=>operations.delete(operation),()=>operations.delete(operation));return operation.promise;
  }
  return {dispatch:(action,payload={},principal)=>tracked(async epoch=>publicValue(await dispatchInternal(action,payload,principal,epoch))),onHostEvent:event=>tracked((epoch,operation)=>onHostEventInternal(event,epoch,operation)),status:()=>({pluginId:PLUGIN_ID,version:VERSION,contract:'proposal-unconfirmed',requiredCapabilities:REQUIRED_CAPABILITIES,mode:'requires-trusted-social-host'}),close};
}
