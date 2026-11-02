import {readdir,mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {publicRepository,requirePublicToolchain} from './lib/public-repository.mjs';
import {sourceSnapshot,parseTapSummary} from './lib/source-evidence.mjs';
import {runOwnedTests,resolveOwnedTestTempBase} from './owned-tests.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const stamp=new Date().toISOString().replace(/[:.]/g,'-');
const publicConfig=await publicRepository(root);requirePublicToolchain(publicConfig);
const dirs=publicConfig?['test','plugins/'+publicConfig.plugin+'/test']:['test','plugins/bilibili-companion/test','plugins/qq-connect/test'];
const tests=[];
for(const dir of dirs)for(const name of(await readdir(join(root,dir))).sort())if(name.endsWith('.test.mjs'))tests.push(join(root,dir,name));
const tempBase=resolveOwnedTestTempBase({sourceRoot:root});
const receipts=join(root,'receipts');
await mkdir(receipts,{recursive:true});
const sourceBefore=await sourceSnapshot(root);
let result;
try{result=await runOwnedTests({sourceRoot:root,testFiles:tests,selectionRoots:dirs,receiptDirectory:join(receipts,'owned-tests'),tempBase});}
catch(error){const failure={schemaVersion:3,at:new Date().toISOString(),classification:'test-runner-refused-before-launch',exitCode:1,error:{code:error.code??null,message:error.message},sourceBefore};await writeFile(join(receipts,'TEST-'+stamp+'.json'),JSON.stringify(failure,null,2)+'\n');throw error;}
const stdout=result.logs?.stdout?.path?await readFile(result.logs.stdout.path,'utf8'):'';
const sourceAfter=await sourceSnapshot(root);
const stable=sourceBefore.hash===sourceAfter.hash;
const summary=parseTapSummary(stdout);
const complete=summary.tests>0&&summary.fail===0&&summary.pass+summary.skipped===summary.tests;
const code=result.status==='passed-cleaned'&&stable&&complete?0:1;
const receipt={schemaVersion:3,at:new Date().toISOString(),classification:'isolated-domain-and-proposal-mock-tests',exitCode:code,childExitCode:result.child?.exitCode,...summary,sourceBefore,sourceAfter,sourceStable:stable,summaryComplete:complete,log:result.logs?.stdout?.path??null,logBytes:result.logs?.stdout?.bytes??null,logSha256:result.logs?.stdout?.sha256??null,profile:result.root,ownedTestReceipt:result.receipt,cleanup:result.cleanup,realBContract:false,realPlatformMessagesSent:false};
await writeFile(join(receipts,'TEST-LATEST.json'),JSON.stringify(receipt,null,2)+'\n');
await writeFile(join(receipts,'TEST-'+stamp+'.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify({status:result.status,tests:summary.tests,pass:summary.pass,fail:summary.fail,receipt:result.receipt,sourceStable:stable}));
if(!stable)console.error('TEST_SOURCE_CHANGED_DURING_RUN');
process.exitCode=code;
