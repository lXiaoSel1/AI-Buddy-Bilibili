import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {assert} from './errors.mjs';

// Existing plugin-v1.sqlite remains in place. Older plugin versions continue
// to read that account; newly connected accounts get separate databases.
// Each account has its own database, so without a connected account there is no service to ask. The plugin's
// `unconnected` view answers only its listed read actions (status, settings and empty lists) from the host's
// management context; every other action still refuses with SOCIAL_ACCOUNT_REQUIRED and nothing is opened.
const accountOf=context=>typeof context?.accountId==='string'&&/^\d{1,20}$/.test(context.accountId)?context.accountId:null;
export function createAccountServices({directory,pluginId,host,createService,unconnected=null,options={}}){
 mkdirSync(directory,{recursive:true});const legacy=join(directory,'plugin-v1.sqlite'),registry=new DatabaseSync(join(directory,'account-directories-v1.sqlite'));
 registry.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
 let selected=null,service=null,closed=false,switching=Promise.resolve(),closePromise=null;
 function pathFor(accountId){
  let owner=registry.prepare("SELECT value FROM metadata WHERE key='legacyAccount'").get()?.value;
  if(!owner){
   if(existsSync(legacy)){const probe=new DatabaseSync(legacy,{readOnly:true});try{if(probe.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='a_plugin_kv'").get()){const stored=probe.prepare("SELECT value FROM a_plugin_kv WHERE key=?").get(pluginId.includes('bilibili')?'accountId':'settings');if(stored){const value=JSON.parse(stored.value);owner=pluginId.includes('bilibili')?value:value.accountId;}}}finally{probe.close();}}
   owner=owner||accountId;assert(typeof owner==='string'&&/^\d{1,20}$/.test(owner),'SOCIAL_ACCOUNT_ID_INVALID');registry.prepare("INSERT INTO metadata VALUES('legacyAccount',?)").run(owner);
  }
  return owner===accountId?legacy:join(directory,'accounts',createHash('sha256').update(accountId).digest('hex'),'plugin-v1.sqlite');
 }
 async function select(principal,background,read=null){
  const context=read??await host.invoke('social.context.read',{purpose:background?'plugin-background':'manage-plugin',principal});
  assert(!closed&&accountOf(context),'SOCIAL_ACCOUNT_REQUIRED','请先扫码连接账号');
  const operation=switching.then(async()=>{assert(!closed,'PLUGIN_CLOSED');if(selected!==context.accountId){await service?.close();service=null;selected=null;const path=pathFor(context.accountId);service=await createService({...options,databasePath:path,host});selected=context.accountId;}return {service,accountId:selected};});
  switching=operation.then(()=>{},()=>{});return operation;
 }
 return {
  async dispatch(action,payload,principal){
   const context=await host.invoke('social.context.read',{purpose:'manage-plugin',principal});
   if(!closed&&!accountOf(context)&&unconnected?.actions?.includes(action))return unconnected.read(action,payload??{},context,{...options,storedAccountData:!!registry.prepare("SELECT value FROM metadata WHERE key='legacyAccount'").get()||existsSync(legacy)});
   const current=await select(principal,false,context);const value=await current.service.dispatch(action,payload,principal);assert(!closed&&selected===current.accountId,'SOCIAL_ACCOUNT_CHANGED');return value;},
  async onHostEvent(event){if(event?.type==='app.exit')return this.close();if(event?.type==='lifecycle.revoke')return service?.onHostEvent(event);try{const current=await select(event.principal,true);return await current.service.onHostEvent(event);}catch(cause){if(['SOCIAL_ACCOUNT_REQUIRED','PLUGIN_BACKGROUND_DENIED','PLUGIN_ACTIVITY_DENIED'].includes(cause?.code))return {status:'not-connected'};throw cause;}},
  close(){if(closePromise)return closePromise;closed=true;closePromise=(async()=>{await switching;await service?.close();registry.close();})();return closePromise;},
 };
}
