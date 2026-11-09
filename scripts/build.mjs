import {assertNewReleaseCompatibility} from './lib/plugin-release-compatibility.mjs';
import {build,version as esbuildVersion} from 'esbuild';
import {mkdir,readFile,writeFile,readdir,copyFile,lstat,rm} from 'node:fs/promises';
import {join,dirname,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {CONTRACT_HASH} from '../shared/contract.mjs';
import {sourceSnapshot} from './lib/source-evidence.mjs';
import {publicRepository,requirePublicToolchain,npmCli,PUBLIC_PLUGINS} from './lib/public-repository.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const hash=b=>createHash('sha256').update(b).digest('hex');
async function inventory(dir){const rows=[];async function visit(p){for(const e of(await readdir(p,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const f=join(p,e.name);if(e.isSymbolicLink())throw Error('Links cannot enter artifacts: '+f);if(e.isDirectory())await visit(f);else if(e.isFile()){const b=await readFile(f);rows.push({path:relative(dir,f).replaceAll('\\','/'),bytes:b.length,sha256:hash(b)});}}}await visit(dir);return rows;}
const publicConfig=await publicRepository(root);requirePublicToolchain(publicConfig,{esbuild:esbuildVersion});
const only=process.argv.find(arg=>arg.startsWith('--only='))?.slice(7);
if(only&&!PUBLIC_PLUGINS.includes(only)||publicConfig&&only&&only!==publicConfig.plugin)throw Error('Unsupported plugin selection');
const selected=publicConfig?[publicConfig.plugin]:only?[only]:PUBLIC_PLUGINS;
const npmPath=await npmCli(),npmVersionResult=spawnSync(process.execPath,[npmPath,'--version'],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:65536});
if(npmVersionResult.status!==0)throw Error('Existing npm CLI could not report its version');
const npmVersion=npmVersionResult.stdout.trim();if(publicConfig&&npmVersion!==publicConfig.npm)throw Error('PINNED_NPM_REQUIRED: '+publicConfig.npm);
const buildToolchain={node:process.versions.node,npm:npmVersion,esbuild:esbuildVersion};
const stamp=new Date().toISOString().replace(/[:.]/g,'-'),out=join(root,'artifacts',stamp);
await mkdir(join(root,'artifacts'),{recursive:true});
await mkdir(out,{recursive:false}); // Never reuse or overwrite an existing candidate directory.
const packages=[];
const snapshotBefore=await sourceSnapshot(root);
async function sourceInputs(src,slug){
 if(publicConfig)return (await sourceSnapshot(root)).files;
 const rows=[...(await inventory(src)).map(row=>({...row,path:'plugins/'+slug+'/'+row.path})),...(await inventory(join(root,'shared'))).map(row=>({...row,path:'shared/'+row.path})),...(await inventory(join(root,'contracts'))).map(row=>({...row,path:'contracts/'+row.path}))];
 for(const path of ['scripts/build.mjs','scripts/lib/source-evidence.mjs','scripts/lib/public-repository.mjs','package.json','package-lock.json','THIRD_PARTY_NOTICES.md','licenses/upstream/LICENSE.md']){const b=await readFile(join(root,path));rows.push({path,bytes:b.length,sha256:hash(b)});}
 return rows.sort((a,b)=>a.path.localeCompare(b.path));
}
// Private integration keeps the complete two-plugin default; exports select one.
for(const slug of selected){
 const src=join(root,'plugins',slug),manifest=JSON.parse(await readFile(join(src,'package.json'),'utf8')),stage=join(out,slug,'package');
 const releasePolicy=JSON.parse(await readFile(join(root,'release-compatibility.json'),'utf8'));
 assertNewReleaseCompatibility(releasePolicy,{sourceManifest:manifest});
 const sourceRows=await sourceInputs(src,slug);
 const sourceHash=hash(JSON.stringify(sourceRows));
 await mkdir(join(stage,'lib'),{recursive:true});
 await build({absWorkingDir:root,entryPoints:[join(src,'src/index.mjs')],outfile:join(stage,'lib/index.js'),bundle:true,format:'esm',platform:'node',target:'node24',external:['node:*'],legalComments:'eof',sourcemap:false});
 await build({absWorkingDir:root,entryPoints:[join(src,'src/client/index.mjs')],outfile:join(stage,'lib/client.js'),bundle:true,format:'iife',platform:'browser',target:'chrome130',legalComments:'eof',sourcemap:false});
 for(const name of ['README.md','LICENSE.md','THIRD-PARTY-NOTICES.md','CHANGELOG.md','DEFAULTS.json','SETTINGS.schema.json','DATA-SCHEMA.json','cordis.patch.yml'])await copyFile(join(src,name),join(stage,name));
 await copyFile(join(root,'contracts/proposal.json'),join(stage,'CONTRACT.json'));
 // Legal notice references in the unchanged license remain resolvable in TGZs.
 await copyFile(join(root,'THIRD_PARTY_NOTICES.md'),join(stage,'THIRD_PARTY_NOTICES.md'));
 await mkdir(join(stage,'licenses/upstream'),{recursive:true});await copyFile(join(root,'licenses/upstream/LICENSE.md'),join(stage,'licenses/upstream/LICENSE.md'));
 await writeFile(join(stage,'package.json'),JSON.stringify({...manifest,dependencies:{},scripts:{},files:['lib','licenses','*.md','*.json','cordis.patch.yml']},null,2)+'\n');
 await writeFile(join(stage,'SOURCE-INPUTS.json'),JSON.stringify({sourceRows,sourceHash,buildToolchain,contractHash:CONTRACT_HASH,contractStatus:'B_RUNTIME_CONTRACT_WITH_EXPLICIT_CAPABILITY_NEGOTIATION'},null,2)+'\n');
 const rows=await inventory(stage);await writeFile(join(stage,'BUILD-INVENTORY.json'),JSON.stringify({schemaVersion:1,packageName:manifest.name,version:manifest.version,files:rows},null,2)+'\n');
 const cache=join(dirname(stage),'pack-cache');await mkdir(cache,{recursive:false});
 const packed=spawnSync(process.execPath,[npmPath,'pack','--ignore-scripts','--json','--pack-destination',dirname(stage),'--cache',cache],{cwd:stage,encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:2*1024*1024});
 if(packed.status!==0)throw Error('scripts-disabled npm pack failed: '+packed.stderr);
 // Only this invocation's empty-before-use cache is disposable, after npm exits.
 if((await lstat(cache)).isSymbolicLink()||relative(out,cache).startsWith('..'))throw Error('PACK_CACHE_BOUNDARY');await rm(cache,{recursive:true});
 const result=JSON.parse(packed.stdout)[0],path=join(dirname(stage),result.filename),bytes=await readFile(path);
 // Re-read source after bundling: concurrent edits must never receive a stable artifact claim.
 const after=await sourceInputs(src,slug);
 if(hash(JSON.stringify(after))!==sourceHash)throw Error('SOURCE_CHANGED_DURING_BUILD: candidate retained but not accepted');
 const record={pluginId:manifest.name,version:manifest.version,path,bytes:bytes.length,sha256:hash(bytes),sourceHash,sourceSnapshotHash:snapshotBefore.hash,buildToolchain,contractHash:CONTRACT_HASH,contractStatus:'B_RUNTIME_CONTRACT_WITH_EXPLICIT_CAPABILITY_NEGOTIATION',runtimeVerified:false,files:result.files.map(f=>f.path)};
 await writeFile(join(dirname(stage),'BUILD.json'),JSON.stringify(record,null,2)+'\n');packages.push(record);
}
const snapshotAfter=await sourceSnapshot(root);if(snapshotBefore.hash!==snapshotAfter.hash)throw Error('SOURCE_CHANGED_DURING_BUILD');
const receipt={schemaVersion:2,at:new Date().toISOString(),kind:'isolated-plugin-candidates-not-final-release',sourceSnapshotHash:snapshotAfter.hash,packages};
await writeFile(join(out,'BUILD.json'),JSON.stringify(receipt,null,2)+'\n');await writeFile(join(root,'ARTIFACTS.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt,null,2));
