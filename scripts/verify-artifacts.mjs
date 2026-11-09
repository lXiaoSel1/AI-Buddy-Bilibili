import {assertNewReleaseCompatibility} from './lib/plugin-release-compatibility.mjs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,dirname,join,relative} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import vm from 'node:vm';
import {unpack} from './lib/tar-reader.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),sha=b=>createHash('sha256').update(b).digest('hex');
const receipt=JSON.parse(await readFile(join(root,'ARTIFACTS.json'),'utf8')),stamp=new Date().toISOString().replace(/[:.]/g,'-'),reports=[];
for(const artifact of receipt.packages){
 const bytes=await readFile(artifact.path);if(bytes.length!==artifact.bytes||sha(bytes)!==artifact.sha256)throw Error('Artifact digest mismatch');
 const files=unpack(bytes),manifest=JSON.parse(files.get('package.json').toString()),inputs=JSON.parse(files.get('SOURCE-INPUTS.json').toString()),inventory=JSON.parse(files.get('BUILD-INVENTORY.json').toString());
 assertNewReleaseCompatibility(JSON.parse(await readFile(join(root,'release-compatibility.json'),'utf8')),{sourceManifest:manifest});
 if(manifest.name!==artifact.pluginId||manifest.version!==artifact.version||inputs.sourceHash!==artifact.sourceHash||inputs.contractHash!==artifact.contractHash)throw Error('Manifest/source mismatch');
 if(manifest.aiBuddy.capabilities.includes('work.host'))throw Error('Social packages must not receive work.host');
 for(const row of inventory.files){const data=files.get(row.path);if(!data||data.length!==row.bytes||sha(data)!==row.sha256)throw Error('Packed member mismatch '+row.path);}
 if(files.size!==inventory.files.length+1)throw Error('Unexpected package member');
 for(const name of files.keys())if(/(^|\/)(?:node_modules|runtime|logs|test-data|data-v003)(\/|$)|\.(?:sqlite|db|env)$/i.test(name))throw Error('Private/runtime file in package '+name);
 const extracted=join(root,'test-data','packed-'+stamp,manifest.name.split('/').at(-1));await mkdir(extracted,{recursive:true});
 for(const [name,data] of files){const path=resolve(extracted,name);if(relative(extracted,path).startsWith('..'))throw Error('Extraction escape');await mkdir(dirname(path),{recursive:true});await writeFile(path,data);}
 const plugin=await import(pathToFileURL(join(extracted,'lib/index.js')).href),routes=[];let cleanup;
 const handle=await plugin.apply({connection:{fetch:{register:r=>{routes.push(r);return()=>{};}}},tools:{register(){throw Error('Unexpected unscoped work tool');}},effect:fn=>{cleanup=fn();}});
 if(routes.length!==1)throw Error('Native route missing');
 const response=await routes[0].fetch(new Request('http://127.0.0.1'+routes[0].path+'?action=readiness')),status=await response.json();
 if(response.status!==200||status.mode!=='unavailable'||status.contractConfirmed!==false)throw Error('Absent B must remain unavailable');
 const privateResponse=await routes[0].fetch(new Request('http://127.0.0.1'+routes[0].path+'?action=history'));if(privateResponse.status!==403)throw Error('Packed private route was not denied');
 await cleanup?.();await handle?.close?.();
 let clientModule;
 vm.runInNewContext(files.get('lib/client.js').toString(),{window:{__ModuleLoader__:{load:spec=>{clientModule=spec;}}},console,URL,setTimeout,clearTimeout,setInterval,clearInterval,fetch:()=>{throw Error('Client module loading must not auto-fetch');},AbortController},{timeout:3000});
 if(clientModule?.id!==manifest.name||typeof clientModule.factory!=='function')throw Error('Native client module registration mismatch');
 reports.push({pluginId:artifact.pluginId,sha256:artifact.sha256,bytes:artifact.bytes,memberCount:files.size,packedMemberHashes:'PASS',rawNodeEntryImport:'PASS',inertNativeEntryMock:'MOCK_PASS',clientModuleRegistration:'MOCK_PASS',privateRouteDenied:true,nativeDshInstalled:false,externalPlatformVerified:false});
}
const result={schemaVersion:1,at:new Date().toISOString(),classification:'packed-bytes-and-mock-entry-verification-not-native-install',reports};await mkdir(join(root,'receipts'),{recursive:true});await writeFile(join(root,'receipts','ARTIFACT-VERIFICATION.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
