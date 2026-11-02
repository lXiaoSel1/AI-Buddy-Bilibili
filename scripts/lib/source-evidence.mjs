import {readFile,readdir} from 'node:fs/promises';
import {publicRepository} from './public-repository.mjs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
export const sha256=value=>createHash('sha256').update(value).digest('hex');
function requireEvidence(condition,code){if(!condition)throw Object.assign(Error(code),{code});}
export async function sourceSnapshot(root){
 const files=[];
 // Public exports bind every checked-out source file, including legal/docs/test
 // inputs. Generated outputs and dependency/VCS stores have separate receipts.
 if(await publicRepository(root)){
  const excluded=new Set(['.git','node_modules','artifacts','receipts','test-data','ARTIFACTS.json','coverage','dist']);
  async function visitPublic(dir=''){for(const entry of(await readdir(join(root,dir),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){if(!dir&&excluded.has(entry.name))continue;const path=dir?dir+'/'+entry.name:entry.name;if(entry.isSymbolicLink())throw Error('SOURCE_LINK_REJECTED');if(entry.isDirectory())await visitPublic(path);else if(entry.isFile()){const data=await readFile(join(root,path));files.push({path,bytes:data.length,sha256:sha256(data)});}else throw Error('SOURCE_SPECIAL_FILE_REJECTED');}}
  await visitPublic();files.sort((a,b)=>a.path.localeCompare(b.path));return {hash:sha256(JSON.stringify(files)),files};
 }
 async function visit(dir){for(const entry of(await readdir(join(root,dir),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const path=dir+'/'+entry.name;if(entry.isSymbolicLink())throw Error('SOURCE_LINK_REJECTED');if(entry.isDirectory()){if(!['evidence','node_modules','dist','logs','test-data','artifacts'].includes(entry.name))await visit(path);}else if(!/\.(?:log|tap|sqlite|db|tgz|zip)$/i.test(entry.name)){const data=await readFile(join(root,path));files.push({path,bytes:data.length,sha256:sha256(data)});}}}
 for(const dir of ['shared','contracts','scripts','test','plugins','docs','licenses'])await visit(dir);
 for(const path of ['package.json','package-lock.json','THIRD_PARTY_NOTICES.md','.gitignore','.gitattributes','.nvmrc']){const data=await readFile(join(root,path));files.push({path,bytes:data.length,sha256:sha256(data)});}
 files.sort((a,b)=>a.path.localeCompare(b.path));return {hash:sha256(JSON.stringify(files)),files};
}
export function parseTapSummary(log){const number=key=>Number(new RegExp('^# '+key+' (\\d+)','m').exec(log)?.[1]??0);return {tests:number('tests'),pass:number('pass'),fail:number('fail'),skipped:number('skipped'),cancelled:number('cancelled')};}
export function verifyDeliveryEvidence({currentSourceHash,tests,log,artifacts,packed,repro}){
 requireEvidence(tests.exitCode===0&&tests.sourceBefore?.hash===currentSourceHash&&tests.sourceAfter?.hash===currentSourceHash,'TEST_SOURCE_EVIDENCE_STALE');
 const data=Buffer.from(log);requireEvidence(data.length===tests.logBytes&&sha256(data)===tests.logSha256,'TEST_LOG_EVIDENCE_MISMATCH');
 const summary=parseTapSummary(log);
 requireEvidence(summary.tests>0&&summary.fail===0&&summary.cancelled===0&&summary.tests===summary.pass+summary.skipped&&Object.keys(summary).every(key=>summary[key]===tests[key]),'TEST_SUMMARY_EVIDENCE_MISMATCH');
 requireEvidence(artifacts.packages?.length===2&&new Set(artifacts.packages.map(p=>p.pluginId)).size===2,'ARTIFACT_SET_INVALID');
 requireEvidence(packed.reports?.length===2&&repro.status==='PASS'&&repro.comparisons?.length===2,'PACKED_EVIDENCE_REQUIRED');
 for(const artifact of artifacts.packages){
  requireEvidence(artifact.sourceSnapshotHash===currentSourceHash,'ARTIFACT_SOURCE_EVIDENCE_STALE');
  const report=packed.reports.find(row=>row.pluginId===artifact.pluginId),comparison=repro.comparisons.find(row=>row.pluginId===artifact.pluginId);
  requireEvidence(report&&report.sha256===artifact.sha256&&report.bytes===artifact.bytes&&report.packedMemberHashes==='PASS'&&report.inertNativeEntryMock==='MOCK_PASS','PACKED_EVIDENCE_STALE');
  requireEvidence(comparison&&comparison.sha256===artifact.sha256&&comparison.sourceHash===artifact.sourceHash&&comparison.sourceSnapshotHash===currentSourceHash&&comparison.bytes===artifact.bytes&&comparison.secondPath===artifact.path&&comparison.firstPath!==comparison.secondPath&&comparison.byteIdentical===true,'REPRODUCIBLE_EVIDENCE_STALE');
 }
 return true;
}
