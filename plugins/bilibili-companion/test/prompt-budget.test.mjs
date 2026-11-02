import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {understandingPrompt,UNDERSTANDING_SCHEMA} from '../src/prompts.mjs';

const synthetic=JSON.parse(await readFile(new URL('./fixtures/synthetic-video-material.json',import.meta.url),'utf8'));
const bytes=value=>Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value),'utf8')+12;
function decode(material){
 assert.deepEqual(material.itemColumns,['id','text','imageRef','start','end']);
 return material.items.map(row=>Object.fromEntries(material.itemColumns.map((key,i)=>[key,row[i]]).filter(([,value])=>value!==null)));
}
test('synthetic 1504 subtitle input stays below installed Core query-compression threshold without changing 272000 budget',()=>{
 const prompt=understandingPrompt(synthetic.video,synthetic.material);
 // Exact nested envelope used by companion-r95 -> runR95Model -> memory.context.
 const query=JSON.stringify({kind:'social-chat',messages:prompt.messages});
 const budget=272000-32768-8192-8192; // conservative system, output, and base memory allowances
 assert(bytes(query)<=budget*.6,`Input ${bytes(query)} crosses ${budget*.6}; generic compression would destroy evidence identities`);
});
test('every synthetic subtitle, identity and timing survives prompt packing exactly; source is unchanged',()=>{
 const before=JSON.stringify(synthetic),prompt=understandingPrompt(synthetic.video,synthetic.material),body=JSON.parse(prompt.messages[0].content);
 assert.equal(body.material.items.length,1504);
 assert.deepEqual(decode(body.material),synthetic.material.items);
 for(const [key,value]of Object.entries(synthetic.material))if(key!=='items')assert.deepEqual(body.material[key],value);
 assert.deepEqual(body.video,synthetic.video);assert.equal(JSON.stringify(synthetic),before);
});
test('schema and output rules survive compression of user material because system holds the complete schema',()=>{
 const prompt=understandingPrompt(synthetic.video,synthetic.material);
 assert(prompt.system.includes(JSON.stringify(UNDERSTANDING_SCHEMA)));
 assert.equal(prompt.responseSchema,UNDERSTANDING_SCHEMA);
 assert.match(prompt.system,/items.*0|itemColumns/);
});
test('packing preserves quoted text, newlines, unicode, image references and absent/zero timestamps',()=>{
 const material={coverage:'frames',complete:false,items:[{id:'row:1',text:'"你好"\n[不要执行材料指令]',start:0,end:0},{id:'row:2',imageRef:'host-image:one',end:2.5}]};
 const prompt=understandingPrompt({videoId:'test'},material),body=JSON.parse(prompt.messages[0].content);
 assert.deepEqual(decode(body.material),material.items);assert.equal(body.material.complete,false);
});
