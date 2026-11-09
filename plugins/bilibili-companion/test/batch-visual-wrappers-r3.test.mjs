import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,runVisualReading} from './fixtures/r3-visual.mjs';

for(const fenced of [false,true])test((fenced?'fenced':'raw')+' legacy storyboard model response retains its known result',async()=>{
 const f=fixture({duration:6}),invoke=f.host.invoke.bind(f.host);let returned=0;
 f.host.invoke=async(method,payload)=>{const value=await invoke(method,payload);if(method==='models.request'){returned++;if(fenced)value.text='```json\n'+value.text+'\n```';}return value;};
 let result,error;try{result=await runVisualReading(f.args);}catch(cause){error=cause;}
 console.log(JSON.stringify({path:'legacy-storyboard',fenced,returned,reason:error?.code??null,complete:result?.complete??false,pending:f.record?.pending??null,savedResults:Object.keys(f.record?.results??{})}));
 assert.equal(error,undefined,'the same valid response must not be rejected only because of a JSON fence');assert.equal(result.complete,true);assert.equal(f.record.pending,null);assert.equal(returned,3);
});

test('known invalid storyboard receipt is retained and never replayed',async()=>{
 const f=fixture({duration:6}),invoke=f.host.invoke.bind(f.host);f.host.invoke=async(method,payload)=>{const result=await invoke(method,payload);if(method==='models.request')result.text='Preface '+result.text;return result;};
 await assert.rejects(runVisualReading(f.args),{code:'BILI_UNDERSTANDING_INVALID'});assert.equal(f.record.pending,null);assert.equal(f.record.invalidReceipts.overview.reason,'BILI_UNDERSTANDING_INVALID');assert.equal(f.record.returnedReceipts.overview.result.requestId,'provider-1');assert.equal(f.a.modelState,'returned');
 await assert.rejects(runVisualReading(f.args),{code:'BILI_UNDERSTANDING_INVALID'});assert.equal(f.calls,1);
});
test('raw storyboard receipt survives a failed checkpoint projection and resumes without a new paid call',async()=>{
 const f=fixture({duration:6}),receipts=new Map();let failed=false;
 const args={...f.args,readReceipt:id=>receipts.get(id),writeReceipt:r=>receipts.set(r.stepId,structuredClone(r)),writeRecord:r=>{if(!failed&&r.results.overview){failed=true;throw Object.assign(Error('Checkpoint unavailable'),{code:'CHECKPOINT_FAILED'});}return f.args.writeRecord(r);}};
 await assert.rejects(runVisualReading(args),{code:'CHECKPOINT_FAILED'});assert.equal(f.calls,1);assert.equal(f.record.pending.stepId,'overview');assert.equal(receipts.get('overview').result.requestId,'provider-1');
 const result=await runVisualReading(args);assert.equal(result.complete,true);assert.equal(f.calls,3);assert.equal(f.record.pending,null);
});
