import {readFile,lstat} from 'node:fs/promises';
import {resolve,dirname,join,isAbsolute} from 'node:path';
export const PUBLIC_PLUGINS=['bilibili-companion','qq-connect'];
export async function publicRepository(root){
 let value;try{value=JSON.parse(await readFile(join(root,'PUBLIC-REPOSITORY.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
 if(value.schemaVersion!==1||value.kind!=='ai-buddy-public-plugin-source'||!PUBLIC_PLUGINS.includes(value.plugin)||value.node!=='24.21.0'||value.esbuild!=='0.28.2'||!/^\d+\.\d+\.\d+$/.test(value.npm))throw Error('PUBLIC_REPOSITORY_INVALID');
 return value;
}
export function requirePublicToolchain(config,{node=process.versions.node,esbuild}={}){
 if(config&&(node!==config.node||esbuild&&esbuild!==config.esbuild))throw Error('PINNED_TOOLCHAIN_REQUIRED: Node '+config.node+', esbuild '+config.esbuild);
}
export async function npmCli({env=process.env,nodeExecutable=process.execPath}={}){
 const requested=env.BUDDY_NPM_CLI||env.npm_execpath;
 const candidates=requested?[requested]:[join(dirname(nodeExecutable),'node_modules/npm/bin/npm-cli.js'),resolve(dirname(nodeExecutable),'../lib/node_modules/npm/bin/npm-cli.js')];
 for(const file of candidates){if(!isAbsolute(file))throw Error('NPM_CLI_MUST_BE_ABSOLUTE');try{if((await lstat(file)).isFile()&&/\.[cm]?js$/i.test(file))return file;}catch(error){if(error.code!=='ENOENT')throw error;}}
 throw Error('NPM_CLI_REQUIRED: use npm run build or set BUDDY_NPM_CLI to an existing npm-cli.js; no dependencies are installed by build');
}
