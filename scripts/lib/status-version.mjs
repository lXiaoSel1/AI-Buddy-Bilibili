import {readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
export async function assertStatusVersion(source){
 const manifest=JSON.parse(await readFile(source,'utf8')),root=dirname(source);
 const version=manifest.name==='@ai-buddy/bilibili-companion'?(await import(pathToFileURL(join(root,'src/defaults.mjs')))).VERSION:(await import(pathToFileURL(join(root,'src/service.mjs')))).QQ_UNCONNECTED.read('status').version;
 if(version!==manifest.version)throw Error('PLUGIN_STATUS_VERSION_MISMATCH');
 return version;
}
