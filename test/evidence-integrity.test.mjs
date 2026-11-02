import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {unpack} from '../scripts/lib/tar-reader.mjs';
import {sha256,verifyDeliveryEvidence} from '../scripts/lib/source-evidence.mjs';
function archive(entries){const parts=[];for(const [name,value,sizeOverride]of entries){const data=Buffer.from(value),h=Buffer.alloc(512);h.write('package/'+name);h.write((sizeOverride??data.length).toString(8).padStart(11,'0')+'\0',124);h[156]=48;h.fill(32,148,156);let sum=0;for(const b of h)sum+=b;h.write(sum.toString(8).padStart(6,'0')+'\0 ',148);parts.push(h,data,Buffer.alloc((512-data.length%512)%512));}parts.push(Buffer.alloc(1024));return gzipSync(Buffer.concat(parts));}
test('AUDIT packed tar rejects duplicate members before Map overwrite',()=>{
 assert.throws(()=>unpack(archive([['lib/index.js','first'],['lib/index.js','second']])),/Duplicate tar entry/);
 assert.equal(unpack(archive([['lib/index.js','first']])).get('lib/index.js').toString(),'first');
});
test('AUDIT packed tar rejects invalid declared sizes, traversal and Windows path aliases',()=>{
 assert.throws(()=>unpack(archive([['lib/index.js','small',9999999]])),/Truncated tar member/);
 assert.throws(()=>unpack(archive([['lib/../index.js','bad']])),/Unsafe tar entry/);
 assert.throws(()=>unpack(archive([['lib\\index.js','bad']])),/Unsafe tar entry/);
});
function evidence(){const log='TAP version 13\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n# cancelled 0\n';const packages=['bili','qq'].map(pluginId=>({pluginId,path:pluginId+'-new',bytes:10,sha256:pluginId+'-sha',sourceHash:pluginId+'-source',sourceSnapshotHash:'current-source'}));return {currentSourceHash:'current-source',log,tests:{exitCode:0,tests:1,pass:1,fail:0,skipped:0,cancelled:0,sourceBefore:{hash:'current-source'},sourceAfter:{hash:'current-source'},logBytes:Buffer.byteLength(log),logSha256:sha256(log)},artifacts:{packages},packed:{reports:packages.map(p=>({...p,packedMemberHashes:'PASS',inertNativeEntryMock:'MOCK_PASS'}))},repro:{status:'PASS',comparisons:packages.map(p=>({...p,firstPath:p.pluginId+'-old',secondPath:p.path,byteIdentical:true}))}};}
test('AUDIT delivery rejects old tests after a source change and tampered complete logs',()=>{
 const good=evidence();assert.equal(verifyDeliveryEvidence(good),true);
 assert.throws(()=>verifyDeliveryEvidence({...good,currentSourceHash:'changed-source'}),{code:'TEST_SOURCE_EVIDENCE_STALE'});
 assert.throws(()=>verifyDeliveryEvidence({...good,log:good.log+'tamper'}),{code:'TEST_LOG_EVIDENCE_MISMATCH'});
});
test('AUDIT delivery rejects stale verification or reproducibility receipts for newly built packages',()=>{
 const oldPacked=evidence();oldPacked.packed.reports[0].sha256='old-sha';assert.throws(()=>verifyDeliveryEvidence(oldPacked),{code:'PACKED_EVIDENCE_STALE'});
 const oldRepro=evidence();oldRepro.repro.comparisons[0].secondPath='another-file';assert.throws(()=>verifyDeliveryEvidence(oldRepro),{code:'REPRODUCIBLE_EVIDENCE_STALE'});
 const oldBuild=evidence();oldBuild.artifacts.packages[0].sourceSnapshotHash='old-source';assert.throws(()=>verifyDeliveryEvidence(oldBuild),{code:'ARTIFACT_SOURCE_EVIDENCE_STALE'});
});
