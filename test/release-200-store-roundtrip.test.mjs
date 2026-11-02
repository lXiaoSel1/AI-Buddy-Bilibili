import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../shared/store.mjs';
for(const pluginId of ['@ai-buddy/qq-connect','@ai-buddy/bilibili-companion'])test(pluginId+' writer2.0 preserves dev7 rollback and newly appended settings',t=>{
 const root=mkdtempSync(join(tmpdir(),'a200-store-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const databasePath=join(root,'private.sqlite');
 const options={databasePath,pluginId,minimumWriter:'0.1.0-dev.2'};
 let s=openStore({...options,writerVersion:'0.1.0-dev.7'});s.set('account',{ref:'mock-reference',enabled:false,persona:'original'});s.close();
 s=openStore(options);s.set('new-setting',{value:'created-by2.0'});assert.equal(s.db.prepare('SELECT minimum_writer FROM a_plugin_meta').get().minimum_writer,'0.1.0-dev.2');s.close();
 s=openStore({...options,writerVersion:'0.1.0-dev.7'});assert.equal(s.get('new-setting').value,'created-by2.0');s.set('after-rollback',42);s.close();
 s=openStore(options);assert.equal(s.get('after-rollback'),42);assert.deepEqual(s.get('account'),{ref:'mock-reference',enabled:false,persona:'original'});s.close();
});
