import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverFullReadingRecord,syncFullReadingRecord} from '../src/full-reading.mjs';
const result={stepId:'batch',providerRequestId:'paid-original',readingId:'reading',planHash:'plan',inputHash:'input',material:{items:[{id:'evidence',text:'original cue'}]},understanding:{summary:'Original observation',notes:'Original detail',evidenceRefs:['evidence'],completedMaterial:true,shareWorthy:false,commentWorthy:false,shareText:'',interestTags:[]}};
const local=()=>({readingId:'reading',planHash:'plan',phase:'paused',results:{earlier:{providerRequestId:'earlier-paid'}},pending:{stepId:'batch',requestId:'reading:batch',inputHash:'input'}});
const state=()=>({readingId:'reading',planHash:'plan',phase:'paused',modelReason:null,needsReview:false,calls:[{stepId:'batch',status:'completed',processed:true,providerRequestId:'paid-original'}],recoveredResults:[structuredClone(result)]});
test('a verified host receipt consumes only the original pending batch and preserves earlier results',()=>{const writes=[],record=local(),next=recoverFullReadingRecord(record,state(),value=>{writes.push(value);return 'original-ref';});assert.equal(next.pending,null);assert.equal(next.results.batch.providerRequestId,'paid-original');assert.deepEqual(next.results.earlier,record.results.earlier);assert.equal(writes.length,1);assert.equal(next.recoveredResults,undefined);assert.equal(recoverFullReadingRecord(next,state(),()=>{throw Error('must not rewrite');}),next);});
test('an unknown batch without a complete receipt stays pending and never initiates a model',()=>{const record=local(),view={...state(),recoveredResults:[]};assert.equal(recoverFullReadingRecord(record,view,()=>{throw Error('no receipt');}),record);assert.ok(record.pending);});
test('a receipt for another plan, batch, input or provider is rejected before writes',()=>{for(const patch of [{planHash:'another'},{stepId:'another'},{inputHash:'changed'},{providerRequestId:'other'},{understanding:{...result.understanding,evidenceRefs:['invented']}}]){const view=state();Object.assign(view.recoveredResults[0],patch);assert.throws(()=>recoverFullReadingRecord(local(),view,()=>{throw Error('must not write');}),{code:'BILI_FULL_RESULT_CONFLICT'});}});
test('ordinary checkpoint synchronization never persists private recovery payloads',()=>{assert.equal(syncFullReadingRecord(local(),state()).recoveredResults,undefined);});


test('legacy pending-null recovery requires the exact retained local receipt and repairs only its review checkpoint',()=>{
 const record={...local(),pending:null,needsReview:true,results:{batch:{stepId:'batch',providerRequestId:'paid-original',resultRef:'original-ref'}}},original={stepId:result.stepId,understanding:result.understanding,providerRequestId:result.providerRequestId,material:result.material};
 const writes=[],next=recoverFullReadingRecord(record,state(),value=>{writes.push(value);return 'original-ref';},()=>original);
 assert.equal(next.needsReview,false);assert.equal(next.pending,null);assert.equal(writes.length,0);assert.deepEqual(next.results,record.results);
 for(const retained of [null,{...original,providerRequestId:'different'},{...original,understanding:{...original.understanding,notes:'different'}}])assert.throws(()=>recoverFullReadingRecord(record,state(),()=>{throw Error('no writes');},()=>retained),{code:'BILI_FULL_RESULT_CONFLICT'});
});

test('a pending-null checkpoint without a matching local result does not clear review merely because the host has a receipt',()=>{
 const record={...local(),pending:null,needsReview:true,results:{}};assert.equal(recoverFullReadingRecord(record,state(),()=>{throw Error('no writes');},()=>null),record);assert.equal(record.needsReview,true);
});

for(const schemaInvalid of [true,false])test('exact known-invalid receipt clears only its pending without adding covered results: '+schemaInvalid,()=>{
 const view=state(),raw={requestId:'paid-original',text:schemaInvalid?'{malformed':JSON.stringify({...result.understanding,completedMaterial:false})};view.phase='paused';view.modelReason='BILI_FULL_MATERIAL_NOT_COMPLETED';view.calls[0].processed=false;view.recoveredResults=[{...result,receiptKind:'invalid',schemaInvalid,result:raw,...(!schemaInvalid?{understanding:{...result.understanding,completedMaterial:false}}:{understanding:null})}];
 const record=local(),writes=[],next=recoverFullReadingRecord(record,view,value=>{writes.push(value);return 'invalid-ref';});assert.equal(next.pending,null);assert.equal(next.needsReview,false);assert.deepEqual(next.results,record.results);assert.equal(next.invalidReceipts.batch.providerRequestId,'paid-original');assert.deepEqual(writes[0].result,raw);assert.equal(writes[0].schemaInvalid,schemaInvalid);assert.equal(next.modelReason,'BILI_FULL_MATERIAL_NOT_COMPLETED');assert.deepEqual(recoverFullReadingRecord(next,view,()=>{throw Error('must not overwrite');},()=>writes[0]),next);
});


test('an invalid recovery receipt must retain the same provider identity inside its original result',()=>{
 const view=state();view.calls[0].processed=false;view.recoveredResults=[{...result,receiptKind:'invalid',schemaInvalid:true,understanding:null,result:{requestId:'different-provider',text:'{malformed'}}];assert.throws(()=>recoverFullReadingRecord(local(),view,()=>{throw Error('must not write a mismatched receipt');}),{code:'BILI_FULL_RESULT_CONFLICT'});
});

test('exact fenced-invalid reclassification writes one derived result and preserves its original audit on repeat',()=>{
 const record={...local(),pending:null,modelReason:'BILI_FULL_MATERIAL_NOT_COMPLETED',invalidReceipts:{batch:{providerRequestId:'paid-original',resultRef:'raw-original-ref'}}},original={stepId:'batch',providerRequestId:'paid-original',result:{requestId:'paid-original',text:'```json\n'+JSON.stringify(result.understanding)+'\n```'},material:result.material,schemaInvalid:true},writes=[];
 const next=recoverFullReadingRecord(record,state(),(value,options)=>{writes.push({value,options});return 'derived-ref';},()=>original);assert.equal(writes.length,1);assert.deepEqual(writes[0].options.priorInvalid,original);assert.equal(next.results.batch.resultRef,'derived-ref');assert.deepEqual(next.results.earlier,record.results.earlier);assert.equal(next.invalidReceipts.batch,undefined);assert.equal(next.recoveredInvalidReceipts.batch.resultRef,'raw-original-ref');assert.equal(next.recoveredInvalidReceipts.batch.priorModelReason,'BILI_FULL_MATERIAL_NOT_COMPLETED');
 const repeated=recoverFullReadingRecord(next,state(),()=>{throw Error('must not rewrite the derived result');},()=>writes[0].value);assert.deepEqual(repeated,next);assert.deepEqual(original.result.text,'```json\n'+JSON.stringify(result.understanding)+'\n```');
});
