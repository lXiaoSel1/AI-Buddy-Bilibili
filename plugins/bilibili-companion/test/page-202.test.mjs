import test from 'node:test';
import assert from 'node:assert/strict';
import {mountPage, ok, refuse} from '../../../test/page-harness.mjs';
import {createBilibiliApp} from '../src/client/index.mjs';

const CHARACTERS = [{id: 'hunyuan', name: '混元'}, {id: 'deepseek', name: 'DeepSeek'}];
const CONNECTIONS = [{id: 'bili-ref', name: '我的B站账号', kind: 'bilibili'}, {id: 'model-ref', name: '本机模型', kind: 'model'}];
const SETTINGS = {autonomousEnabled: true, maxConcurrent: 1, dailyWatchLimit: 5, dailyCommentLimit: 3, commentMode: 'managed', commentConsent: true, commentReview: 'preview', shareMode: 'selected', resumeMode: 'idle', connectionRef: 'bili-ref', modelConnectionRef: 'model-ref', startMinute: 0, endMinute: 1440, defaultCharacterId: null};
const day = new Intl.DateTimeFormat('en-CA', {timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit'}).format(new Date());
const minute = (() => {const d = new Date();return d.getUTCHours() * 60 + d.getUTCMinutes();})();
const read = (extra = {}) => ok({settings: SETTINGS, accountId: '1', timeZone: 'UTC', characters: CHARACTERS, connections: CONNECTIONS, todayAllowed: true, ...extra});
const quota = (comments = 0) => ok({day, limits: {watch: 5, comment: 3}, rows: comments ? [{kind: 'comment', status: 'reserved', count: comments}] : []});
const routes = over => async (action, payload) => {
  const answer = over[action];
  if (typeof answer === 'function') return answer(payload);
  if (answer) return answer;
  if (action === 'readiness') return ok({mode: 'runtime', blockers: []});
  if (action === 'settings.read') return read();
  if (action === 'quota.read') return quota();
  if (['history.list', 'schedule.list', 'reading.pending.list'].includes(action)) return ok([]);
  return refuse('UNEXPECTED_' + action);
};
const plan = (id, extra) => ({id, accountId: '1', participants: ['hunyuan'], remaining: 2, participantIndex: 0, day, startMinute: 0, endMinute: 1440, state: 'scheduled', ...extra});
const watched = (id, extra) => ({id, accountId: '1', characterId: 'hunyuan', day, state: 'completed', video: {videoId: 'BV1xK4y1a7Qz', title: '【开发日志】桌宠第 40 天', url: 'https://www.bilibili.com/video/BV1xK4y1a7Qz'}, understanding: {summary: '讲了拖拽和抛掷。', notes: '第一条\n第二条'}, material: {complete: true}, comments: [], ...extra});

test('E1: with no Bilibili account the page shows 「先连接一个B站账号才能看」 and says plainly that watching needs it', async t => {
  let account = false;
  const page = mountPage(t, createBilibiliApp, routes({'settings.read': () => account ? read() : read({accountId: '', accountRequired: true, storedAccountData: true, settings: {...SETTINGS, connectionRef: null}}), 'onboarding.open': ok({opened: true})}));
  await page.settle();
  const text = page.text();
  assert.ok(text.includes('先连接一个B站账号才能看'), text);
  assert.ok(text.includes('先连接一个B站账号才能看'), 'the rule in the code, not the design’s “watching needs no account”');
  assert.ok(text.includes('之前账号的观看记录都还在'));
  assert.equal(page.all(n => n.props.role === 'tab').length, 0);
  await page.click('扫码连接');assert.equal(page.count('onboarding.open'), 1);
  account = true;await page.dispatch('ai-buddy:social-accounts-changed');
  assert.ok(page.all(n => n.props.role === 'tab').length === 3, 'C-4: the page reads again and opens normally');
});

test('E1: reading failures are yellow with technical details; the settings read is not red', async t => {
  const page = mountPage(t, createBilibiliApp, routes({'settings.read': refuse('BUDDY_SERVICE_UNAVAILABLE')}), {lang: 'en'});
  await page.settle();
  const text = page.text();
  assert.ok(text.includes('Settings could not be read') && text.includes('BUDDY_SERVICE_UNAVAILABLE'), text);
  assert.equal(page.all(n => String(n.props.className ?? '').includes('bili-alert err')).length, 0);
});

test('E1: a readiness read that fails is the yellow card with its reason in technical details', async t => {
  const broken = mountPage(t, createBilibiliApp, async action => {if (action === 'readiness') throw new TypeError('Failed to fetch');return refuse('X');});
  await broken.settle();
  assert.ok(broken.text().includes('暂时读不到连接状态') && broken.text().includes('Failed to fetch'), broken.text());
});

test('E2: plan rows get Watch now / History / More, a title or 「按兴趣挑选」, and Skip today above the list', async t => {
  const later = minute < 1380 ? {startMinute: minute + 30, endMinute: 1440} : {startMinute: 0, endMinute: 30};
  const page = mountPage(t, createBilibiliApp, routes({
    'schedule.list': ok([plan('p1'), plan('p2', {state: 'completed', remaining: 0}), plan('p3', later)]),
    'history.list': ok([watched('a2', {scheduleId: 'p2'})]),
    'schedule.start': ok({state: 'completed'}), 'schedule.cancel': ok({state: 'cancelled'}), 'today.allow': ok({allowed: false})}));
  await page.settle();
  const rows = page.all(n => n.type === 'article' && String(n.props.className).includes('bili-plan'));
  assert.equal(rows.length, 3);
  assert.ok(page.textOf(rows[0]).includes('按兴趣挑选 · 还剩 2 个') && page.textOf(rows[0]).includes('已安排'), page.textOf(rows[0]));
  assert.ok(page.textOf(rows[1]).includes('【开发日志】桌宠第 40 天') && page.textOf(rows[1]).includes('看完了'), 'a finished plan names its video, no raw “completed”');
  const later3 = page.all(n => n.type === 'button' && page.textOf(n).includes('现在看'), rows[2])[0];
  assert.equal(later3.props.disabled, true);assert.ok(/开始|时间已过/.test(page.textOf(rows[2])));
  await page.click(page.all(n => n.type === 'button' && page.textOf(n).includes('现在看'), rows[0])[0]);
  assert.deepEqual(page.calls.find(c => c.action === 'schedule.start').payload, {scheduleId: 'p1', visual:true});
  await page.click(page.all(n => n.props['aria-label'] === '更多', rows[0])[0]);
  await page.click('取消这个预约');
  assert.deepEqual(page.calls.find(c => c.action === 'schedule.cancel').payload, {scheduleId: 'p1'});
  await page.click('今天不看');
  assert.deepEqual(page.calls.find(c => c.action === 'today.allow').payload, {allowed: false});
  await page.click(page.all(n => n.type === 'button' && page.textOf(n) === '看记录', page.tree)[0]);
  assert.equal(page.all(n => n.props.role === 'tab' && n.props['aria-selected'] === true)[0] && page.textOf(page.all(n => n.props.role === 'tab' && n.props['aria-selected'] === true)[0]).startsWith('观看记录'), true);
});

test('E2: the viewing going on now has 「观看中」, a progress bar by step and Pause / Stop', async t => {
  const page = mountPage(t, createBilibiliApp, routes({'history.list': ok([{id: 'r1', accountId: '1', characterId: 'deepseek', day, state: 'acquiring-material', video: {videoId: 'BV1', title: '十分钟看懂上下文窗口', url: 'https://www.bilibili.com/video/BV1'}}])}));
  await page.settle();
  const now = page.all(n => n.props['aria-label'] === '正在看')[0];
  assert.ok(page.textOf(now).includes('观看中') && page.textOf(now).includes('第 2 步，共 4 步 · 正在取视频材料'), page.textOf(now));
  const bar = page.all(n => n.props.role === 'progressbar', now)[0];assert.equal(bar.props['aria-valuenow'], 2);assert.equal(bar.children[0].props.style.width, '50%');
  assert.ok(page.button('暂停') && page.button('停止'));
  page.unmount();
});

test('E3: the preview says how many more can be posted today; a posted comment links to itself; notes show a count', async t => {
  const page = mountPage(t, createBilibiliApp, routes({'quota.read': quota(1), 'history.list': ok([
    watched('a1', {comments: [{id: 'a1:comment', state: 'draft', text: '回弹那段好细！'}]}),
    watched('a2', {comments: [{id: 'a2:comment', state: 'sent', text: '谢谢 UP', platformId: '987654'}]}),
    {id: 'm1', accountId: '1', characterId: 'deepseek', day, state: 'failed', lastFailureCode: 'BILI_SELECTION_EMPTY'}])}));
  await page.settle();await page.click('观看记录');
  const link = page.all(n => n.type === 'a' && page.textOf(n).includes('在 B站查看'))[0];
  assert.equal(link.props.href, 'https://www.bilibili.com/video/BV1xK4y1a7Qz#reply987654');assert.equal(link.props.target, '_blank');
  assert.ok(page.text().includes('观看笔记 · 2 条'));
  assert.ok(page.text().includes('没找到可看的视频'), 'missed rows say why in words');
  await page.click('预览并发表…');
  assert.ok(page.text().includes('还能再发 2 条'), page.text());
});

test('E4: 「被打断后」, all three after-watching options, a default character, one change for comments on/off', async t => {
  const page = mountPage(t, createBilibiliApp, routes({'settings.update': payload => ok(payload)}));
  await page.settle();await page.click('设置');
  const text = page.text();
  assert.ok(text.includes('被打断后') && !text.includes('聊天结束后等我'), text);
  for (const label of ['只记录', '聊天结束后说', '她挑值得说的']) assert.ok(page.button(label), label);
  await page.click('聊天结束后说');
  assert.ok(page.text().includes('有 1 项改动还没保存'));
  await page.click('不发表');
  assert.ok(page.text().includes('有 2 项改动还没保存'), 'turning comments off is one change, not two');
  await page.change('默认参与角色', 'deepseek');
  await page.click('保存设置');
  const saved = page.calls.find(c => c.action === 'settings.update').payload;
  assert.equal(saved.shareMode, 'after-chat');assert.equal(saved.defaultCharacterId, 'deepseek');assert.equal(saved.commentMode, 'off');
});

test('E4/C-1: the default character is picked for Watch now; faces carry the host picture variable', async t => {
  const page = mountPage(t, createBilibiliApp, routes({'settings.read': read({settings: {...SETTINGS, defaultCharacterId: 'deepseek'}}), now: ok({state: 'completed'})}));
  await page.settle();
  const chip = page.all(n => n.type === 'button' && n.props['aria-pressed'] === true)[0];
  assert.ok(page.textOf(chip).includes('DeepSeek'));
  const face = page.all(n => n.type === 'i' && n.props.style?.backgroundImage === 'var(--buddy-face-deepseek,none)')[0];
  assert.ok(face, 'face picture over the letter');
  await page.click(page.all(n => n.type === 'button' && page.textOf(n).includes('现在看') && String(n.props.className).includes('pri'))[0]);
  assert.deepEqual(page.calls.find(c => c.action === 'now').payload, {characterId: 'deepseek', videoId: null, visual:true});
  const css = page.styles.find(el => el.id === 'bili-style').textContent;
  assert.match(css, /\.bili\{[^}]*height:100%;min-height:0;overflow-y:auto/);assert.ok(!/\.bili\{[^}]*min-height:100%/.test(css));
  assert.ok(css.includes('html[data-buddy-embedded] .bili-wrap{max-width:none}'));
  page.unmount();
});
