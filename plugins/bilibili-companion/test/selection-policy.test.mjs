import test from 'node:test';
import assert from 'node:assert/strict';
import {activityTarget,selectActivity,commentStatusLabel} from '../src/client/selection.mjs';
import {preferOffPeak,DEEPSEEK_POLICY} from '../src/scheduling.mjs';

test('bubble/page targeting resolves only this plugin and the exact existing activity',()=>{
  const list=[{id:'alpha'},{id:'beta'}];assert.equal(activityTarget({url:'https://local/app?activityId=beta'}),'beta');assert.equal(activityTarget({detail:{pluginId:'@ai-buddy/qq-connect',activityId:'alpha'}}),null);const id=activityTarget({detail:{pluginId:'@ai-buddy/bilibili-companion',activityId:'alpha'}});assert.equal(selectActivity(list,id),list[0]);assert.equal(selectActivity(list,'missing'),null);assert.equal(activityTarget({detail:{pluginId:'@ai-buddy/bilibili-companion',activityId:''}}),null);
});
test('comment labels distinguish drafts, generation, actual sent, failure and unknown',()=>{
  assert.match(commentStatusLabel({state:'draft'}),/尚未发送/);assert.match(commentStatusLabel({state:'generating'}),/生成/);assert.equal(commentStatusLabel({state:'sent'}),'已发送');assert.equal(commentStatusLabel({state:'failed'}),'发送失败');assert.match(commentStatusLabel({state:'unknown'}),/未知/);
});
test('official current policy has weekday two peak bands, offpeak gaps, weekends, and trusted China holiday dates',()=>{
  const args={timeZone:'UTC',day:'2026-10-26',startMinute:0,endMinute:1440,provider:'deepseek'};
  assert.equal(preferOffPeak({...args,at:Date.parse('2026-10-26T02:00:00Z')}).resumeAt,Date.parse('2026-10-26T04:00:00Z'));
  assert.equal(preferOffPeak({...args,at:Date.parse('2026-10-26T07:00:00Z')}).resumeAt,Date.parse('2026-10-26T10:00:00Z'));
  assert.equal(preferOffPeak({...args,at:Date.parse('2026-10-26T05:00:00Z')}).runNow,true);
  assert.equal(preferOffPeak({...args,day:'2026-10-25',at:Date.parse('2026-10-25T02:00:00Z')}).runNow,true);
  assert.equal(preferOffPeak({...args,at:Date.parse('2026-10-26T02:00:00Z'),holidayDates:['2026-10-26']}).runNow,true);
  assert.equal(DEEPSEEK_POLICY.sourceCheckedAt,'2026-10-25');
});
test('offpeak preference never expands a window, guesses unknown provider, imposes token budget, or delays manual actions',()=>{
  const args={timeZone:'UTC',day:'2026-10-26',startMinute:60,endMinute:180,provider:'deepseek',at:Date.parse('2026-10-26T02:00:00Z')};
  assert.equal(preferOffPeak(args).reason,'no-offpeak-within-authorized-window');assert.equal(preferOffPeak({...args,manual:true}).runNow,true);assert.equal(preferOffPeak({...args,provider:undefined}).reason,'provider-unconfirmed');assert(!JSON.stringify(preferOffPeak(args)).includes('tokenBudget'));
});
