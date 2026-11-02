// Current official policy was checked by the coordinating agent on 2026-10-25.
// This is a scheduling preference, never a promise about the final billed price.
export const DEEPSEEK_POLICY=Object.freeze({source:'https://api-docs.deepseek.com/quick_start/pricing/',sourceCheckedAt:'2026-10-25',timeZone:'UTC',weekdayPeakMinutes:[[60,240],[360,600]],holidayCalendar:'host-supplied-China-statutory-holidays'});
function local(at,timeZone){const p=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(at).map(v=>[v.type,v.value]));return {day:`${p.year}-${p.month}-${p.day}`,minute:Number(p.hour)*60+Number(p.minute)};}
export function preferOffPeak({at,timeZone,day,startMinute,endMinute,provider,holidayDates=[],manual=false}){
  if(manual||provider!=='deepseek')return {runNow:true,reason:manual?'manual-request':'provider-unconfirmed'};
  const utc=new Date(at),utcDay=utc.toISOString().slice(0,10),weekday=utc.getUTCDay();
  if(weekday===0||weekday===6||holidayDates.includes(utcDay))return {runNow:true,reason:'official-offpeak',policy:DEEPSEEK_POLICY};
  const minute=utc.getUTCHours()*60+utc.getUTCMinutes(),peak=DEEPSEEK_POLICY.weekdayPeakMinutes.find(([start,end])=>minute>=start&&minute<end);
  if(!peak)return {runNow:true,reason:'official-offpeak',policy:DEEPSEEK_POLICY};
  const candidate=Date.UTC(utc.getUTCFullYear(),utc.getUTCMonth(),utc.getUTCDate(),0,peak[1]),target=local(candidate,timeZone);
  if(target.day===day&&target.minute>=startMinute&&target.minute<endMinute)return {runNow:false,resumeAt:candidate,reason:'prefer-offpeak-within-window',policy:DEEPSEEK_POLICY};
  return {runNow:true,reason:'no-offpeak-within-authorized-window',policy:DEEPSEEK_POLICY};
}
