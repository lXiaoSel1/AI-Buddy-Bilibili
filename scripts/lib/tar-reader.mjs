import {gunzipSync} from 'node:zlib';
export function unpack(tgz){
 const bytes=gunzipSync(tgz),files=new Map(),seen=new Set();let offset=0;
 while(offset+512<=bytes.length){
  const header=bytes.subarray(offset,offset+512);
  if(header.every(value=>value===0)){if(!bytes.subarray(offset).every(value=>value===0))throw Error('Nonzero data after tar terminator');return files;}
  const string=(start,length)=>header.subarray(start,start+length).toString('utf8').replace(/\0.*$/s,''),prefix=string(345,155),name=(prefix?prefix+'/':'')+string(0,100),member=name.slice(8),type=string(156,1),sizeText=string(124,12).trim(),checksumText=string(148,8).trim();
  if(!name.startsWith('package/')||!member||member.split('/').some(part=>!part||part==='.'||part==='..')||/[\\:]/.test(member)||!['','0'].includes(type))throw Error('Unsafe tar entry '+name);
  const key=process.platform==='win32'?member.toLowerCase():member;if(seen.has(key))throw Error('Duplicate tar entry '+name);
  if(!/^[0-7]+$/.test(sizeText)||!/^[0-7]+$/.test(checksumText))throw Error('Invalid tar numeric field');
  const size=parseInt(sizeText,8),checksum=parseInt(checksumText,8);if(!Number.isSafeInteger(size)||size<0||offset+512+size>bytes.length)throw Error('Truncated tar member '+name);
  let sum=0;for(let i=0;i<512;i++)sum+=i>=148&&i<156?32:header[i];if(sum!==checksum)throw Error('Tar checksum mismatch');
  seen.add(key);files.set(member,bytes.subarray(offset+512,offset+512+size));offset+=512+Math.ceil(size/512)*512;
 }
 throw Error('Tar terminator missing');
}
