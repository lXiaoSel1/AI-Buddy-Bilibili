import {execFileSync} from 'node:child_process';
import {readFileSync,readlinkSync} from 'node:fs';
import {join} from 'node:path';

let selfIdentity;
// null proves absence; undefined means inspection failed and must never grant
// permission to steal an owner's database. No operation terminates a process.
export function inspectRuntimeProcess(pid){
 if(!Number.isSafeInteger(pid)||pid<=0)return undefined;
 if(pid===process.pid&&selfIdentity)return {...selfIdentity};
 let identity;
 try{
  if(process.platform==='win32'){
   const shell=join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
   const script=`$ErrorActionPreference='Stop'; $p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($null -eq $p){'null';exit 0}; try { $v=@{pid=$p.Id;birth=$p.StartTime.ToUniversalTime().Ticks.ToString();executable=$p.Path}; if(-not $v.executable){exit 2}; $v|ConvertTo-Json -Compress } catch { exit 2 }`;
   identity=JSON.parse(execFileSync(shell,['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:5000,maxBuffer:8192,stdio:['ignore','pipe','ignore']}).trim());
  }else if(process.platform==='linux'){
   const stat=readFileSync(`/proc/${pid}/stat`,'utf8'),fields=stat.slice(stat.lastIndexOf(')')+2).split(/\s+/);
   identity={pid,birth:fields[19],executable:readlinkSync(`/proc/${pid}/exe`)};
  }else return undefined;
 }catch(cause){if(cause.code==='ENOENT'&&process.platform==='linux')return null;return undefined;}
 if(identity===null)return null;
 if(identity?.pid!==pid||typeof identity.birth!=='string'||!/^\d+$/.test(identity.birth)||typeof identity.executable!=='string'||!identity.executable)return undefined;
 if(pid===process.pid)selfIdentity={...identity};return identity;
}

export function runtimeOwnerAlive(owner,inspect=inspectRuntimeProcess){
 if(!owner?.pid)return false;
 let actual;try{actual=inspect(owner.pid);}catch{return true;}
 if(actual===null)return false;
 // Birth identity changes prove PID reuse. A missing proof, including a
 // legacy owner, or only an executable-path difference remains conservative.
 if(actual&&typeof owner.birth==='string'&&owner.birth&&typeof owner.executable==='string'&&owner.executable&&actual.pid===owner.pid&&typeof actual.birth==='string'&&actual.birth&&typeof actual.executable==='string'&&actual.executable)return actual.birth===owner.birth;
 try{process.kill(owner.pid,0);return true;}catch(cause){return cause.code!=='ESRCH';}
}
