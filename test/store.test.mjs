import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {spawn} from 'node:child_process';
import {openStore,WRITER_VERSION} from '../shared/store.mjs';
const data=process.env.AI_BUDDY_PLUGIN_TEST_ROOT??fileURLToPath(new URL('../test-data/',import.meta.url));
const fresh=()=>join(mkdtempSync(join(data,'store-')),'private.sqlite');
test('SQLite rollback, restart persistence and plugin ownership guard',()=>{
 const path=fresh(),store=openStore({databasePath:path,pluginId:'@ai-buddy/test'});
 store.set('counter',1);assert.throws(()=>store.transaction(()=>{store.set('counter',2);throw Error('rollback');}));assert.equal(store.get('counter'),1);store.close();
 const reopened=openStore({databasePath:path,pluginId:'@ai-buddy/test'});assert.equal(reopened.get('counter'),1);reopened.close();
 const before=readFileSync(path);assert.throws(()=>openStore({databasePath:path,pluginId:'@ai-buddy/other'}),{code:'FOREIGN_DATABASE_REJECTED'});assert.deepEqual(readFileSync(path),before);
});
test('future schema and minimum writer reject before touching data',()=>{
 const futureWriter=`${Number(WRITER_VERSION.split('.')[0])+1}.0.0`;
 const path=fresh(),s=openStore({databasePath:path,pluginId:'@ai-buddy/test'});s.db.prepare('UPDATE a_plugin_meta SET minimum_writer=?').run(futureWriter);s.close();
 const before=readFileSync(path);assert.throws(()=>openStore({databasePath:path,pluginId:'@ai-buddy/test'}),{code:'MINIMUM_WRITER_REQUIRED'});assert.deepEqual(readFileSync(path),before);
 const db=new DatabaseSync(path);db.exec("UPDATE a_plugin_meta SET schema_version=2,minimum_writer='0.1.0-dev.1'");db.close();
 assert.throws(()=>openStore({databasePath:path,pluginId:'@ai-buddy/test'}),{code:'SCHEMA_UNSUPPORTED'});
});
test('two independent processes atomically compete for the last durable slot',async()=>{
 const path=fresh(),s=openStore({databasePath:path,pluginId:'@ai-buddy/test'});s.set('slots',1);s.close();
 const modulePath=new URL('../shared/store.mjs',import.meta.url).href;
 const source=`import {openStore} from ${JSON.stringify(modulePath)};const s=openStore({databasePath:process.argv[1],pluginId:'@ai-buddy/test'});const won=s.transaction(()=>{const left=s.get('slots');if(left!==1)return false;s.set('slots',0);return true;});console.log(won?'won':'lost');s.close();`;
 const run=()=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,['--input-type=module','-e',source,path],{windowsHide:true});let out='',err='';p.stdout.on('data',c=>out+=c);p.stderr.on('data',c=>err+=c);p.on('error',reject);p.on('close',code=>code===0?resolve(out.trim()):reject(Error('child failed '+code+'\n'+err)));});
 const results=await Promise.all([run(),run()]);assert.deepEqual(results.sort(),['lost','won']);
});
test('read-only admission tolerates a bounded concurrent SQLite checkpoint lock before the writer opens',async()=>{
 const path=fresh(),s=openStore({databasePath:path,pluginId:'@ai-buddy/test'});s.set('preserved','original');s.close();
 const code=`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA journal_mode=DELETE;BEGIN EXCLUSIVE');console.log('locked');setTimeout(()=>{db.exec('COMMIT');db.close();},400);`;
 const p=spawn(process.execPath,['--input-type=module','-e',code,path],{windowsHide:true});let err='';p.stderr.on('data',c=>err+=c);
 const ended=new Promise((resolve,reject)=>{p.on('error',reject);p.on('close',code=>code===0?resolve():reject(Error(err)));});
 await new Promise((resolve,reject)=>{p.stdout.once('data',resolve);p.once('error',reject);});
 try{const reopened=openStore({databasePath:path,pluginId:'@ai-buddy/test'});assert.equal(reopened.get('preserved'),'original');reopened.close();}finally{await ended;}
});
