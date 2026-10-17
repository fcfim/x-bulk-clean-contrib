// End-to-end tests: the real unpacked extension in Chromium, driven through its popup, against
// the fake x.com in fake-x.mjs. Usage: node test/e2e/run.mjs [scenario-name-filter]
import { launch, openExtensionPage, storage, waitFor } from './launch.mjs';
import { createState, installFakeX, fakeQueryIds, ME } from './fake-x.mjs';

const BUTTONS = { delete: 'startDelete', unrepost: 'startUnrepost', unlike: 'startUnlike', bulkUnfollow: 'bulkUnfollow', followAll: 'followAllFollowers', followVerified: 'followVerifiedFollowers' };

async function quickClean(env, action, { apiMode = true } = {}) {
  const before = (await storage(env.worker, ['jobHistory'])).jobHistory?.length || 0;
  const popup = await openExtensionPage(env.context, env.extensionId, 'popup/popup.html');
  await popup.waitForFunction(() => document.getElementById('accountCard')?.dataset.state === 'ready', null, { timeout: 20000 });
  await popup.evaluate((on) => {
    const box = document.getElementById('apiMode');
    if (box.checked !== on) box.click();
  }, apiMode);
  await popup.evaluate((id) => document.getElementById(id).click(), BUTTONS[action]);
  await popup.waitForFunction(() => document.getElementById('confirmDialog')?.open, null, { timeout: 10000 });
  await popup.evaluate(() => document.getElementById('confirmStart').click());
  const started = Date.now();
  const job = await waitFor(async () => {
    const history = (await storage(env.worker, ['jobHistory'])).jobHistory || [];
    return history.length > before ? history[0] : null;
  }, { timeout: 120000, label: `${action} job to finish` });
  const worker = await env.worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: ['https://x.com/*'] });
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      const X = window.__xCleaner;
      return X && { mode: X.mode, apiFallback: X.apiFallback || null, stats: X.stats, issue: X.issue };
    } });
    return result?.result;
  });
  const record = (await storage(env.worker, [`job_${job.id}`]))[`job_${job.id}`];
  await popup.close();
  return { job, record, worker, seconds: (Date.now() - started) / 1000 };
}

// Preview & Select in the side panel: scan, keep everything selected, act on the selection.
async function previewAndAct(env, type, { replyScope = 'fast', apiMode = true } = {}) {
  const before = (await storage(env.worker, ['jobHistory'])).jobHistory?.length || 0;
  const panel = await openExtensionPage(env.context, env.extensionId, 'sidepanel/sidepanel.html');
  await panel.waitForFunction(() => !document.getElementById('startScan').disabled, null, { timeout: 20000 });
  await panel.evaluate(({ type, replyScope, apiMode }) => {
    document.querySelector(`input[name="previewType"][value="${type}"]`).click();
    if (type === 'replies') document.querySelector(`input[name="replyScope"][value="${replyScope}"]`).click();
    const box = document.getElementById('previewApi');
    if (box.checked !== apiMode) box.click();
    document.getElementById('startScan').click();
  }, { type, replyScope, apiMode });
  await panel.waitForFunction(() => /Scan complete/.test(document.getElementById('scanState')?.textContent || '') && !document.getElementById('deleteSelected').disabled, null, { timeout: 90000 });
  const scanned = await panel.evaluate(() => ({ found: document.getElementById('stickyScanned').textContent, selected: document.getElementById('selectedCount').textContent }));
  const scan = await env.worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: ['https://x.com/*'] });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { const P = window.__xbcPreview; return P && { mode: P.mode, apiFallback: P.apiFallback || null, items: P.items.map(i => ({ id: i.id, type: i.type, classification: i.classification, userId: i.userId })) }; } });
    return r?.result;
  });
  await panel.evaluate(() => document.getElementById('deleteSelected').click());
  await panel.waitForFunction(() => document.getElementById('deleteDialog')?.open, null, { timeout: 10000 });
  await panel.evaluate(() => document.getElementById('confirmDelete').click());
  const job = await waitFor(async () => {
    const history = (await storage(env.worker, ['jobHistory'])).jobHistory || [];
    return history.length > before ? history[0] : null;
  }, { timeout: 120000, label: `selected ${type} job to finish` });
  const worker = await env.worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: ['https://x.com/*'] });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { const X = window.__xCleaner; return X && { mode: X.mode, apiFallback: X.apiFallback || null, issue: X.issue }; } });
    return r?.result;
  });
  await panel.close();
  return { scanned, scan, job, worker };
}

const SCENARIOS = [
  {
    name: 'delete posts via API, leaving reposts alone',
    state: { own: 15, retweets: 4 },
    async run(env, state) {
      const r = await quickClean(env, 'delete');
      const deletes = state.calls.filter(c => c.op === 'DeleteTweet');
      return [
        ['mode is api', r.worker?.mode === 'api', r.worker],
        ['all 15 own posts deleted', state.tweets.filter(t => !t.retweetOf).length === 0, state.tweets.length],
        ['4 reposts untouched', state.tweets.filter(t => t.retweetOf).length === 4],
        ['15 DeleteTweet calls', deletes.length === 15, deletes.length],
        ['body is {variables:{tweet_id}, queryId}', deletes.every(c => c.body?.queryId === fakeQueryIds.DeleteTweet && Object.keys(c.body.variables).join() === 'tweet_id'), deletes[0]?.body],
        ['listing used the account id from twid', state.calls.filter(c => c.op === 'UserTweets' && c.method === 'GET' && c.variables).slice(1).every(c => c.variables.userId === ME.id)],
        ['history: completed with 15 records', r.job.status === 'completed' && r.job.total === 15, r.job],
        ['backup rows have text and url', r.record.backup.tweets.every(t => t.text && t.url?.includes('/status/'))]
      ];
    }
  },
  {
    name: 'remove reposts via API with the original id',
    state: { own: 3, retweets: 6 },
    async run(env, state) {
      const r = await quickClean(env, 'unrepost');
      const calls = state.calls.filter(c => c.op === 'DeleteRetweet');
      return [
        ['mode is api', r.worker?.mode === 'api', r.worker],
        ['all 6 reposts removed', state.tweets.filter(t => t.retweetOf).length === 0],
        ['own posts untouched', state.tweets.filter(t => !t.retweetOf).length === 3],
        ['source_tweet_id is the original post', calls.every(c => /^5\d+$/.test(c.body.variables.source_tweet_id)), calls.map(c => c.body.variables)],
        ['history: 6 unreposted', r.job.counts.unreposted === 6, r.job.counts]
      ];
    }
  },
  {
    name: 'clear likes via API across pages',
    state: { likes: 17, pageSize: 5 },
    async run(env, state) {
      const r = await quickClean(env, 'unlike');
      return [
        ['mode is api', r.worker?.mode === 'api', r.worker],
        ['all 17 likes removed', state.likes.length === 0, state.likes.length],
        ['17 UnfavoriteTweet calls', state.calls.filter(c => c.op === 'UnfavoriteTweet').length === 17],
        ['history: 17 unliked', r.job.counts.unliked === 17, r.job.counts]
      ];
    }
  },
  {
    name: 'bulk unfollow via REST friendships/destroy',
    state: { following: 9, pageSize: 4 },
    async run(env, state) {
      const r = await quickClean(env, 'bulkUnfollow');
      const calls = state.calls.filter(c => c.op === 'friendships/destroy');
      return [
        ['mode is api', r.worker?.mode === 'api', r.worker],
        ['all 9 unfollowed', state.following.length === 0, state.following.length],
        ['form has user_id and the include_* params', calls.every(c => c.form.user_id && c.form.include_profile_interstitial_type === '1' && c.form.skip_status === '1'), calls[0]?.form],
        ['history: 9 unfollows', r.job.counts.unfollows === 9, r.job.counts]
      ];
    }
  },
  {
    name: 'follow back only followers not yet followed',
    state: { followers: 10, followedBack: 3, pageSize: 4 },
    async run(env, state) {
      const r = await quickClean(env, 'followAll');
      const calls = state.calls.filter(c => c.op === 'friendships/create');
      return [
        ['mode is api', r.worker?.mode === 'api', r.worker],
        ['7 follow calls', calls.length === 7, calls.length],
        ['everyone followed now', state.followers.every(u => u.following)],
        ['history: 7 follows', r.job.counts.follows === 7, r.job.counts]
      ];
    }
  },
  {
    name: 'waits out a rate limit and resumes',
    state: { own: 6 },
    setup: (state) => { state.misbehave.rateLimitAfter = 2; state.misbehave.rateLimitSeconds = 4; },
    async run(env, state) {
      const r = await quickClean(env, 'delete');
      return [
        ['mode is api', r.worker?.mode === 'api', r.worker],
        ['all 6 deleted despite the 429', state.tweets.length === 0, state.tweets.length],
        ['job waited for the reset', r.seconds >= 4, r.seconds],
        ['history: completed', r.job.status === 'completed', r.job.statusText]
      ];
    }
  },
  {
    name: 'falls back to clicking when X refuses the API',
    state: { own: 5 },
    setup: (state) => { state.misbehave.refuse.DeleteTweet = 404; },
    async run(env, state) {
      const r = await quickClean(env, 'delete');
      return [
        ['fell back to click mode', r.worker?.mode === 'dom' && !!r.worker.apiFallback, r.worker],
        ['all 5 deleted by clicking', state.tweets.length === 0 && state.calls.filter(c => c.op === 'dom-delete').length === 5, state.calls.filter(c => c.op === 'dom-delete').length],
        ['history: 5 records', r.job.total === 5, r.job]
      ];
    }
  },
  {
    name: 'falls back when X requires a signed session (session binding)',
    state: { own: 2, retweets: 3 },
    setup: (state) => { state.misbehave.binding.DeleteRetweet = true; },
    async run(env, state) {
      const r = await quickClean(env, 'unrepost');
      return [
        ['fell back to click mode', r.worker?.mode === 'dom', r.worker],
        ['reason mentions the signed session', /signed session/.test(r.worker?.apiFallback || ''), r.worker?.apiFallback],
        ['no repost removed through the API', state.tweets.filter(t => t.retweetOf).length === 3, state.tweets.length],
        ['the refused DeleteRetweet was tried once, then no more', state.calls.filter(c => c.op === 'DeleteRetweet').length === 1]
      ];
    }
  },
  {
    name: 'click mode when API mode is off',
    state: { own: 4 },
    async run(env, state) {
      const r = await quickClean(env, 'delete', { apiMode: false });
      return [
        ['mode is dom', r.worker?.mode === 'dom', r.worker],
        ['no API mutation sent', !state.calls.some(c => c.op === 'DeleteTweet')],
        ['all 4 deleted by clicking', state.tweets.length === 0, state.tweets.length]
      ];
    }
  },
  {
    name: 'preview: scan posts via API and delete the selection',
    state: { own: 9, replies: 3, retweets: 2, pageSize: 4 },
    async run(env, state) {
      const r = await previewAndAct(env, 'tweets');
      return [
        ['scan ran via API', r.scan?.mode === 'api', r.scan],
        ['scan found exactly the 9 posts (no replies, no reposts)', r.scan?.items.length === 9 && r.scan.items.every(i => i.classification === 'tweets'), r.scan?.items.length],
        ['delete ran via API', r.worker?.mode === 'api', r.worker],
        ['the 9 posts are gone, replies and reposts kept', state.tweets.filter(t => !t.retweetOf && !t.replyTo).length === 0 && state.tweets.length === 5, state.tweets.length],
        ['history: 9 records', r.job.total === 9, r.job]
      ];
    }
  },
  {
    name: 'preview: replies only, exact from the API',
    state: { own: 4, replies: 5, pageSize: 3 },
    async run(env, state) {
      const r = await previewAndAct(env, 'replies', { replyScope: 'fast' });
      return [
        ['scan ran via API', r.scan?.mode === 'api', r.scan],
        ['5 replies found, none of the other person\'s posts', r.scan?.items.length === 5 && r.scan.items.every(i => i.classification === 'definite' && /^8/.test(i.id)), r.scan?.items],
        ['replies deleted, posts kept', state.tweets.filter(t => t.replyTo).length === 0 && state.tweets.length === 4, state.tweets.length],
        ['history: 5 replies', r.job.counts.replies === 5, r.job.counts]
      ];
    }
  },
  {
    name: 'preview: unfollow selected accounts by user id',
    state: { following: 7, pageSize: 3 },
    async run(env, state) {
      const r = await previewAndAct(env, 'unfollow');
      const calls = state.calls.filter(c => c.op === 'friendships/destroy');
      return [
        ['scan ran via API with user ids', r.scan?.mode === 'api' && r.scan.items.length === 7 && r.scan.items.every(i => i.userId), r.scan],
        ['all 7 unfollowed by user_id', state.following.length === 0 && calls.every(c => c.form.user_id), calls.length],
        ['history: 7 unfollows', r.job.counts.unfollows === 7, r.job.counts]
      ];
    }
  },
  {
    name: 'preview: reposts via API',
    state: { own: 2, retweets: 5, pageSize: 3 },
    async run(env, state) {
      const r = await previewAndAct(env, 'reposts');
      return [
        ['scan found the 5 reposts by original id', r.scan?.mode === 'api' && r.scan.items.length === 5 && r.scan.items.every(i => /^5/.test(i.id)), r.scan],
        ['reposts removed, posts kept', state.tweets.filter(t => t.retweetOf).length === 0 && state.tweets.length === 2],
        ['history: 5 unreposted', r.job.counts.unreposted === 5, r.job.counts]
      ];
    }
  }
];

const filter = process.argv[2];
let failed = 0;
for (const scenario of SCENARIOS.filter(s => !filter || s.name.includes(filter))) {
  const env = await launch();
  const state = createState(scenario.state);
  scenario.setup?.(state);
  await installFakeX(env.context, state);
  const tab = await env.context.newPage();
  await tab.goto('https://x.com/home');
  let checks;
  try {
    checks = await scenario.run(env, state);
  } catch (error) {
    checks = [[`ran without error: ${error.message}`, false]];
  }
  await env.close();
  const bad = checks.filter(([, ok]) => !ok);
  failed += bad.length;
  console.log(`${bad.length ? 'FAIL' : 'PASS'}  ${scenario.name}`);
  for (const [label, ok, detail] of checks) console.log(`   ${ok ? '✓' : '✗'} ${label}${ok || detail === undefined ? '' : `  → ${JSON.stringify(detail).slice(0, 300)}`}`);
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
