import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createAccountServices} from '../shared/account-services.mjs';
test('account switch keeps legacy storage and isolates new account state across restart',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'social-account-mux-'));let account='123';const opened=[];
 const host={invoke:async()=>({accountId:account,contextToken:'verified',permissions:['plugin.manage','plugin.activity']})};
 const createService=async({databasePath})=>{await mkdir(dirname(databasePath),{recursive:true});opened.push(databasePath);const db=new DatabaseSync(databasePath);db.exec('CREATE TABLE IF NOT EXISTS a_plugin_kv(key TEXT PRIMARY KEY,value TEXT)');return {dispatch:async(action,payload)=>{if(action==='write'){db.prepare("INSERT INTO a_plugin_kv VALUES('accountId',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(account));db.prepare("INSERT INTO a_plugin_kv VALUES('note',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(payload.note);}return db.prepare("SELECT value FROM a_plugin_kv WHERE key='note'").get()?.value??null;},onHostEvent:async()=>({}),close:async()=>db.close()};};
 let mux=createAccountServices({directory,pluginId:'@ai-buddy/bilibili-companion',host,createService});
 t.after(async()=>{await mux.close();await rm(directory,{recursive:true,force:true});});
 await mux.dispatch('write',{note:'first'},{});account='456';assert.equal(await mux.dispatch('read',{},{}),null);await mux.dispatch('write',{note:'second'},{});account='123';assert.equal(await mux.dispatch('read',{},{}),'first');assert.equal(opened[0],join(directory,'plugin-v1.sqlite'));assert.notEqual(opened[0],opened[1]);await mux.close();
 mux=createAccountServices({directory,pluginId:'@ai-buddy/bilibili-companion',host,createService});account='456';assert.equal(await mux.dispatch('read',{},{}),'second');
 const legacy=new DatabaseSync(join(directory,'plugin-v1.sqlite'),{readOnly:true});assert.equal(legacy.prepare("SELECT value FROM a_plugin_kv WHERE key='note'").get().value,'first');legacy.close();
});
test('account service refuses account identity supplied only by a plugin body',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'social-account-none-'));let created=0;const mux=createAccountServices({directory,pluginId:'@ai-buddy/qq-connect',host:{invoke:async()=>({accountId:''})},createService:()=>{created++;}});t.after(async()=>{await mux.close();await rm(directory,{recursive:true,force:true});});await assert.rejects(mux.dispatch('status',{accountId:'123'},{}),{code:'SOCIAL_ACCOUNT_REQUIRED'});assert.equal(created,0);
});
