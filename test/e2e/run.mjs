// End-to-end tests: the real unpacked extension in Chromium, driven through its popup, against
// the fake x.com in fake-x.mjs. Usage: node test/e2e/run.mjs [scenario-name-filter]
import { launch, openExtensionPage, storage, waitFor } from './launch.mjs';
import { createState, installFakeX, fakeQueryIds, ME } from './fake-x.mjs';
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

// Deterministic polling regressions using the entire real side-panel script and
// synthetic DOM/tab/timer adapters. No browser or network is used in this mode.
// Run: npm run test:e2e -- --preview-polling
async function testPreviewPolling() {
  const document = { activeElement: null, addEventListener() {}, querySelector: () => ({ value: 'tweets' }) };
  class Node {
    constructor(tag = 'div') { this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.listeners = {}; this.className = ''; this.value = ''; this.classList = { add() {}, remove() {}, toggle() {} }; this.rebuilds = 0; }
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    replaceChildren(...children) { if (document.activeElement?.closest('.result')?.parent === this) document.activeElement = null; this.children = []; this.append(...children); this.rebuilds++; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    closest() { return this.className.split(' ').includes('result') ? this : this.parent?.closest() || null; }
    querySelectorAll() { return this.children.flatMap(child => ['input', 'a'].includes(child.tag) ? [child] : child.querySelectorAll()); }
    focus() { document.activeElement = this; }
    showModal() { this.open = true; }
    close() { this.open = false; }
  }
  const nodes = new Map();
  document.getElementById = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  document.createElement = tag => new Node(tag);
  document.createTextNode = text => Object.assign(new Node('text'), { textContent: text });
  const timers = new Map(); let timerId = 0, fullReads = 0, holdFull = null, holdWrite = null, dispatch = null, stops = 0;
  const makeItems = n => Array.from({ length: n }, (_, i) => ({ id: `synthetic-${i}`, type: 'tweet', classification: 'tweets', text: `post ${i}`, date: '2024-01-01', selected: true }));
  const window = { __xbcPreview: { startedAt: 1, type: 'tweets', items: makeItems(2000), interval: {}, paused: true, done: false } };
  const context = vm.createContext({ document, window, console, setInterval: fn => { timers.set(++timerId, fn); return timerId; }, clearInterval: id => timers.delete(id),
    chrome: { storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } }, scripting: { executeScript: async ({ func, args = [] }) => {
      if (func.name === 'runSelectedDelete') { dispatch = args; return [{ result: { ok: true } }]; }
      if (func.name === 'updatePreviewSelection' && holdWrite) await holdWrite;
      const result = JSON.parse(JSON.stringify(func(...args) ?? null));
      if (func.name === 'readPreviewState' && args[0]) { fullReads++; if (holdFull) await holdFull; }
      return [{ result }];
    } } }
  });
  vm.runInContext(fs.readFileSync(new URL('../../src/sidepanel/sidepanel.js', import.meta.url), 'utf8'), context);
  const run = code => vm.runInContext(code, context);
  run('activeTab = { id: 42 }; activeAccount = { username: "synthetic_owner" };');
  // Flush deterministic adapter promises without wall-clock sleeps or private poll state.
  const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const list = document.getElementById('resultsList');
  const first = () => list.children[0].querySelectorAll()[0];
  const checks = [];
  const check = (label, fn) => { fn(); checks.push(label); console.log(`PASS ${label}`); };

  run('startPolling()'); await settle();
  const original = first(); original.focus();
  for (let i = 0; i < 4; i++) await run('pollPreview()');
  check('2,000 paused items are fetched/rendered once; checkbox and focus stay attached', () => { assert.equal(fullReads, 1); assert.equal(list.rebuilds, 1); assert.equal(first(), original); assert.equal(document.activeElement, original); assert.equal(timers.size, 1); });

  original.checked = false; await original.listeners.change();
  await run('togglePause()'); await settle();
  assert.equal(document.getElementById('reviewSection').style.display, 'none', 'resume hides the review');
  await run('togglePause()'); await settle();
  check('pause resume pause with no new items shows the cached review and selection bar', () => { assert.equal(document.getElementById('reviewSection').style.display, 'block'); assert.equal(document.getElementById('stickyBar').style.display, 'block'); assert.equal(first().checked, false); assert.equal(document.getElementById('selectedCount').textContent, '1999 selected'); });
  for (let i = 0; i < 3; i++) await run('pollPreview()');
  check('repeated pause preserves cached rows and focus without another fetch', () => { assert.equal(fullReads, 1); assert.equal(list.rebuilds, 1); assert.equal(first(), original); assert.equal(document.activeElement, original); });
  original.checked = true; await original.listeners.change();

  let releaseWrite;
  holdWrite = new Promise(resolve => { releaseWrite = resolve; });
  original.checked = false; const change = original.listeners.change();
  window.__xbcPreview.done = true; window.__xbcPreview.paused = false; window.__xbcPreview.interval = null;
  await run('pollPreview()');
  check('completion snapshot cannot undo an in-flight choice and restores focus', () => { assert.equal(first().checked, false); assert.equal(document.activeElement, first()); assert.equal(document.getElementById('selectedCount').textContent, '1999 selected'); assert.equal(timers.size, 0); });
  const completedRebuilds = list.rebuilds;
  await run('pollPreview()'); await run('pollPreview()');
  check('unchanged completed preview with 2,000 items does not rebuild', () => assert.equal(list.rebuilds, completedRebuilds));
  releaseWrite(); await change; holdWrite = null;
  const toggle = selected => { first().checked = selected; return first().listeners.change(); };
  await Promise.all([toggle(true), toggle(false)]);
  check('rapid toggles are written in click order', () => assert.equal(window.__xbcPreview.items[0].selected, false));

  let releaseFull;
  holdFull = new Promise(resolve => { releaseFull = resolve; });
  window.__xbcPreview.interval = {}; window.__xbcPreview.paused = true; window.__xbcPreview.done = false;
  window.__xbcPreview.items.push({ ...makeItems(1)[0], id: 'synthetic-extra' });
  run('startPolling()');
  for (let i = 0; i < 20 && fullReads < 3; i++) await Promise.resolve();
  assert.equal(fullReads, 3, 'snapshot captured before edit');
  await toggle(true);
  await run('pollPreview()');
  releaseFull(); holdFull = null; await settle();
  check('overlapping polls are skipped and a delayed snapshot preserves a later edit', () => { assert.equal(fullReads, 3); assert.equal(first().checked, true); assert.equal(document.activeElement, first()); });
  const afterChange = list.rebuilds;
  await run('pollPreview()');
  check('unchanged paused state after append does not rebuild', () => assert.equal(list.rebuilds, afterChange));

  holdWrite = new Promise(resolve => { releaseWrite = resolve; });
  const oldChange = toggle(false);
  window.__xbcPreview = { startedAt: 2, type: 'tweets', items: makeItems(2001), interval: {}, paused: true, done: false };
  await run('pollPreview()'); releaseWrite(); await oldChange; holdWrite = null;
  check('new scan with the same count/IDs replaces the cache; old writes cannot change it', () => { assert.equal(first().checked, true); assert.equal(window.__xbcPreview.items[0].selected, true); });
  await run('setFilteredSelection("none")'); await toggle(true); run('openDeleteDialog()');
  check('confirmation uses the current selected count and account', () => { assert.equal(document.getElementById('deleteCount').textContent, '1 item'); assert.equal(document.getElementById('deleteAccount').textContent, '@synthetic_owner'); assert.equal(dispatch, null); });

  window.__xbcPreviewStop = () => { window.__xbcPreview.interval = null; window.__xbcPreview.paused = false; window.__xbcPreview.issue = 'Scan stopped by user'; };
  await run('stopScan()');
  check('Stop scan refreshes once and stops polling', () => assert.equal(timers.size, 0));
  await run('stopScan()');
  check('New scan resets the review and its snapshot', () => { assert.equal(run('previewItems.length'), 0); assert.equal(run('previewSnapshot'), null); });

  holdFull = new Promise(resolve => { releaseFull = resolve; });
  window.__xbcPreview = { startedAt: 3, type: 'tweets', items: makeItems(2), interval: {}, paused: true };
  const beforeRestart = fullReads;
  const rebuildsBeforeRestart = list.rebuilds;
  run('startPolling()');
  for (let i = 0; i < 20 && fullReads === beforeRestart; i++) await Promise.resolve();
  assert.equal(fullReads, beforeRestart + 1);
  window.__xbcPreview = { startedAt: 4, type: 'tweets', items: makeItems(2).map(item => ({ ...item, selected: false })), interval: null, done: true };
  run('stopPolling(); startPolling(); startPolling();');
  releaseFull(); holdFull = null; await settle();
  check('pending restarts coalesce into an immediate refresh after the in-flight poll', () => assert.equal(fullReads, beforeRestart + 2));
  check('earlier polling responses are discarded and the next scan loads without a timer tick', () => { assert.equal(list.rebuilds, rebuildsBeforeRestart + 1); assert.equal(first().checked, false); assert.equal(run('previewSnapshot.startedAt'), 4); });

  run('startPolling()'); await settle();
  await run('setFilteredSelection("none")'); await toggle(true);
  context.detectAccount = async () => ({ username: 'synthetic_owner' });
  context.ensurePreviewPage = async () => {};
  context.findActiveXTab = async () => ({ id: 42 });
  window.__xCleaner = { action: 'delete', stats: { deleted: 0 }, interval: {}, historyPersisted: false };
  window.__xCleanerStop = () => { stops++; window.__xCleaner.interval = null; window.__xCleaner.issue = 'Stopped by user'; window.__xCleaner.historyPersisted = true; };
  await run('beginSelectedDelete()'); await settle();
  check('new confirmed action dispatches only selected IDs and restarts polling', () => { assert.equal(dispatch[1].map(item => item.id).join(','), 'synthetic-0'); assert.equal(timers.size, 1); });
  window.__xCleaner.stats.deleted = 1; await run('pollPreview()');
  check('cleanup progress still updates', () => assert.equal(document.getElementById('scanCount').textContent, '1'));
  await run('stopScan()'); await run('pollPreview()');
  check('Stop deletion still responds and final history state stops polling', () => { assert.equal(stops, 1); assert.equal(timers.size, 0); assert.equal(run('cleanupRunning'), false); });
  console.log(`${checks.length}/${checks.length} synthetic polling checks passed (not browser e2e)`);
}

if (process.argv[2] === '--preview-polling') {
  await testPreviewPolling();
  process.exit(0);
}

if (process.argv[2] === '--api-limits') {
  const { testApiLimits } = await import('./api-limits.mjs');
  await testApiLimits();
  process.exit(0);
}

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
async function previewAndAct(env, type, { replyScope = 'fast', apiMode = true, beforeAct } = {}) {
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
  await beforeAct?.();
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
  ...[
    { name: '403 with Retry-After', response: { status: 403, body: {}, resetSeconds: 5, headers: { 'Retry-After': '3600' } }, reason: /suspended/ },
    { name: 'binding with Retry-After', response: { status: 401, body: {}, resetSeconds: 5, headers: { 'x-tfe-auth-result-code': '3071', 'Retry-After': '3600' } }, reason: /suspended/ },
    { name: '403 with backoff', response: { status: 403, body: {}, resetSeconds: 5, headers: { 'backoff-policy': 'backoff=3600000' } }, reason: /suspended/ },
    { name: '403 with remaining zero', response: { status: 403, body: {}, resetSeconds: 3600, headers: { 'x-rate-limit-remaining': '0' } }, reason: /suspended/ },
    { name: 'one hour reset', response: { resetSeconds: 3600 }, reason: /suspended/ },
    { name: 'one hour Retry-After', response: { resetSeconds: 5, headers: { 'Retry-After': '3600' } }, reason: /suspended/ },
    { name: 'daily 344 in HTTP 429', response: { code: 344, resetSeconds: 5 }, reason: /daily limit/ },
    { name: 'daily 344 in HTTP 400', response: { status: 400, code: 344 }, reason: /daily limit/ },
    { name: 'automation in HTTP 429', response: { code: 226 }, reason: /looks automated/ }
  ].map(({ name, response, reason }) => ({
    name: `limits: ${name} stops without DOM and survives a new job`,
    state: { own: 2 },
    async run(env, state) {
      state.misbehave.responses.DeleteTweet = [response];
      const first = await quickClean(env, 'delete');
      const callsBefore = state.calls.filter(c => c.op === 'DeleteTweet').length;
      // Header-backed waits and daily restrictions survive api.init in the next job.
      // Automation without a deadline stops this job; no unlock time is invented.
      const persistent = response.resetSeconds != null || response.code === 344;
      const second = persistent ? await quickClean(env, 'delete') : null;
      return [
        ['first job is interrupted with a clear reason', first.job.status === 'interrupted' && reason.test(first.job.statusText), first.job],
        ['only the refused mutation was attempted', callsBefore === 1, callsBefore],
        ['no DOM fallback or mutation after restriction', first.worker?.mode === 'api' && !first.worker.apiFallback && !state.calls.some(c => c.op === 'dom-delete'), first.worker],
        ['fixture posts stay intact', state.tweets.length === 2, state.tweets.length],
        ['next job respects persisted restriction', !persistent || (second.job.status === 'interrupted' && state.calls.filter(c => c.op === 'DeleteTweet').length === 1 && !second.worker.apiFallback), second?.job]
      ];
    }
  })),
  ...[
    { name: 'daily 429', response: { code: 344, resetSeconds: 5 }, reason: /daily limit/ },
    { name: '403 with Retry-After', response: { status: 403, body: {}, headers: { 'Retry-After': '3600' } }, reason: /suspended/ },
    { name: 'binding with Retry-After', response: { status: 401, body: {}, headers: { 'x-tfe-auth-result-code': '3071', 'Retry-After': '3600' } }, reason: /suspended/ }
  ].map(({ name, response, reason }) => ({
    name: `limits: preview scan stops on ${name} without starting DOM`,
    state: { own: 2 },
    async run(env, state) {
      // Prime the profile first: its own discovery GET must not consume the worker fixture.
      const xTab = env.context.pages().find(page => page.url().startsWith('https://x.com/'));
      await xTab.goto(`https://x.com/${ME.screen}`);
      await waitFor(() => state.calls.some(c => c.op === 'UserTweets'), { label: 'profile discovery GET' });
      state.misbehave.responses.UserTweets = [response];
      const panel = await openExtensionPage(env.context, env.extensionId, 'sidepanel/sidepanel.html');
      await panel.waitForFunction(() => !document.getElementById('startScan').disabled);
      await panel.locator('#startScan').click();
      await panel.waitForFunction(() => /Scan stopped/.test(document.getElementById('scanState').textContent));
      const result = await env.worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ url: ['https://x.com/*'] });
        const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
          const p = window.__xbcPreview;
          return { mode: p.mode, fallback: p.apiFallback || null, done: p.done, issue: p.issue, waiting: p.waitUntil, running: !!p.interval };
        } });
        return r.result;
      });
      await panel.close();
      return [
        ['scan interrupted without DOM/completion', result.mode === 'api' && !result.fallback && !result.done && !result.running, result],
        ['restriction message preserved', reason.test(result.issue), result.issue],
        ['no destructive request', !state.calls.some(c => c.method === 'POST'), state.calls]
      ];
    }
  })),
  ...[
    { name: '403', status: 403, headers: { 'Retry-After': '3600' } },
    { name: 'binding', status: 401, headers: { 'x-tfe-auth-result-code': '3071', 'Retry-After': '3600' } }
  ].map(({ name, ...response }) => ({
    name: `limits: selected delete stops on ${name} cooldown without DOM`,
    state: { own: 2 },
    async run(env, state) {
      const r = await previewAndAct(env, 'tweets', { beforeAct: () => { state.misbehave.responses.DeleteTweet = [{ ...response, body: {} }]; } });
      return [
        ['scan still completes before confirmation', r.scan.mode === 'api' && r.scan.items.length === 2, r.scan],
        ['selected job stops with no success', r.job.status === 'interrupted' && r.job.total === 0 && /suspended/.test(r.job.statusText), r.job],
        ['no DOM fallback or subsequent mutation', r.worker.mode === 'api' && !r.worker.apiFallback && state.calls.filter(c => c.op === 'DeleteTweet').length === 1 && !state.calls.some(c => c.op === 'dom-delete'), r.worker],
        ['posts unchanged', state.tweets.length === 2, state.tweets.length]
      ];
    }
  })),
  {
    name: 'limits: Stop during rate wait persists deadline and partial history',
    state: { own: 2 },
    async run(env, state) {
      state.misbehave.responses.DeleteTweet = [{ resetSeconds: 120 }];
      const popup = await openExtensionPage(env.context, env.extensionId, 'popup/popup.html');
      await popup.waitForFunction(() => document.getElementById('accountCard')?.dataset.state === 'ready');
      await popup.locator('#startDelete').click();
      await popup.waitForFunction(() => document.getElementById('confirmDialog').open);
      await popup.locator('#confirmStart').click();
      await waitFor(async () => Object.entries(await storage(env.worker, null)).some(([key, value]) => key.startsWith(`xbcApiCooldown:${ME.id}:DeleteTweet:claim:`) && value.until > Date.now()), { timeout: 10000, label: 'persisted cooldown' });
      await env.worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ url: ['https://x.com/*'] });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.__xCleanerStop() });
      });
      const job = await waitFor(async () => (await storage(env.worker, ['jobHistory'])).jobHistory?.[0], { timeout: 10000, label: 'Stop history' });
      await popup.close();
      return [
        ['Stop records stopped history and zero successful mutations', job.status === 'stopped' && job.total === 0, job],
        ['no second mutation or DOM fallback', state.calls.filter(c => c.op === 'DeleteTweet').length === 1 && !state.calls.some(c => c.op === 'dom-delete'), state.calls],
        ['posts unchanged', state.tweets.length === 2, state.tweets.length]
      ];
    }
  },
  {
    name: 'preview: pause resume pause without new items restores cached review',
    state: { own: 0 },
    async run(env) {
      await env.worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ url: ['https://x.com/*'] });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
          window.__xbcPreview = {
            startedAt: 1, type: 'tweets', account: { username: 'me' }, interval: {}, paused: true, done: false,
            items: Array.from({ length: 2000 }, (_, i) => ({ id: `9${1000 + i}`, type: 'tweet', classification: 'tweets', text: `post ${i}`, date: '2024-01-01', selected: false }))
          };
        } });
      });
      const panel = await openExtensionPage(env.context, env.extensionId, 'sidepanel/sidepanel.html');
      await panel.waitForFunction(() => document.getElementById('scanState').textContent === 'Scan paused' && document.getElementById('reviewSection').style.display === 'block');
      await panel.locator('#resultsList input').first().check();
      await panel.evaluate(() => {
        window.__cachedCheckbox = document.querySelector('#resultsList input');
        window.__fullReads = 0;
        const execute = chrome.scripting.executeScript.bind(chrome.scripting);
        chrome.scripting.executeScript = details => {
          if (details.func?.name === 'readPreviewState' && details.args?.[0]) window.__fullReads++;
          return execute(details);
        };
      });
      await panel.locator('#pauseScan').click();
      await panel.waitForFunction(() => document.getElementById('reviewSection').style.display === 'none');
      await panel.locator('#pauseScan').click();
      await panel.waitForFunction(() => document.getElementById('scanState').textContent === 'Scan paused' && document.getElementById('reviewSection').style.display === 'block' && document.getElementById('stickyBar').style.display === 'block', null, { timeout: 5000 });
      await panel.locator('#resultsList input').first().focus();
      await panel.waitForTimeout(1800);
      const result = await panel.evaluate(() => ({ sameNode: document.querySelector('#resultsList input') === window.__cachedCheckbox, focused: document.activeElement === window.__cachedCheckbox, checked: window.__cachedCheckbox.checked, count: document.getElementById('selectedCount').textContent, fullReads: window.__fullReads }));
      await panel.close();
      return [
        ['second pause restores the same cached row without a full read', result.sameNode && result.fullReads === 0, result],
        ['selected checkbox and count survive resume and re-pause', result.checked && result.count === '1 selected', result],
        ['focus remains stable during subsequent paused ticks', result.focused, result]
      ];
    }
  },
  {
    name: 'preview: 2000 paused items preserve checkbox focus and selection',
    state: { own: 3 },
    async run(env, state) {
      await env.worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ url: ['https://x.com/*'] });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
          // Synthetic scanner state; deletion below still goes through fake-x's API.
          window.__xbcPreview = {
            startedAt: 1, type: 'tweets', account: { username: 'me' }, interval: {}, paused: true, done: false,
            items: Array.from({ length: 2000 }, (_, i) => ({ id: `9${1000 + i}`, type: 'tweet', classification: 'tweets', text: `post ${i}`, date: '2024-01-01', author: 'me', selected: false }))
          };
        } });
      });
      const panel = await openExtensionPage(env.context, env.extensionId, 'sidepanel/sidepanel.html');
      await panel.locator('#resultsList input').first().waitFor();
      await panel.evaluate(() => {
        window.__firstCheckbox = document.querySelector('#resultsList input');
        window.__firstCheckbox.focus();
        window.__firstCheckbox.click();
      });
      // Span multiple real polling ticks; this is the regression's time boundary.
      await panel.waitForTimeout(1800);
      const stable = await panel.evaluate(() => ({
        sameNode: document.querySelector('#resultsList input') === window.__firstCheckbox,
        focused: document.activeElement === window.__firstCheckbox,
        checked: window.__firstCheckbox.checked,
        count: document.getElementById('selectedCount').textContent
      }));
      await env.worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ url: ['https://x.com/*'] });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { window.__xbcPreview.interval = null; window.__xbcPreview.paused = false; window.__xbcPreview.done = true; } });
      });
      await panel.waitForFunction(() => document.getElementById('scanState').textContent === 'Scan complete');
      const completed = await panel.evaluate(() => ({ focused: document.activeElement === document.querySelector('#resultsList input'), checked: document.querySelector('#resultsList input').checked, stopped: pollTimer === null }));
      await panel.locator('#deleteSelected').click();
      const confirmation = await panel.locator('#deleteCount').textContent();
      await panel.locator('#confirmDelete').click();
      const history = await waitFor(async () => (await storage(env.worker, ['jobHistory'])).jobHistory?.[0], { label: 'single selected deletion' });
      await panel.close();
      return [
        ['paused list preserves its checkbox node', stable.sameNode, stable],
        ['keyboard focus and checked state survive polling', stable.focused && stable.checked, stable],
        ['only one item remains selected', stable.count === '1 selected', stable],
        ['completion preserves selection/focus and stops polling', completed.focused && completed.checked && completed.stopped, completed],
        ['confirmation and result match the selected ID', confirmation === '1 item' && history.total === 1 && state.calls.filter(c => c.op === 'DeleteTweet').map(c => c.body.variables.tweet_id).join(',') === '91000', history],
        ['other real fixture posts remain', state.tweets.length === 2, state.tweets.length]
      ];
    }
  },
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
        ['listing used the signed-in account id', state.calls.filter(c => c.op === 'UserTweets' && c.method === 'GET' && c.variables).slice(1).every(c => c.variables.userId === ME.id)],
        ['features: all 40 of the build, values from the page state', (() => { const c = state.calls.filter(c => c.op === 'UserTweets' && c.features).at(-1); return c && Object.keys(c.features).length === 40 && c.features.rweb_video_screen_enabled === true; })(), state.calls.filter(c => c.op === 'UserTweets').at(-1)?.features],
        ['fieldToggles as X sends them', JSON.stringify(state.calls.filter(c => c.op === 'UserTweets').at(-1)?.fieldToggles) === '{"withPayments":false,"withArticlePlainText":false}', state.calls.filter(c => c.op === 'UserTweets').at(-1)?.fieldToggles],
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
        ['user lists send no fieldToggles', state.calls.filter(c => c.op === 'Following' && c.features).every(c => c.fieldToggles === null), state.calls.filter(c => c.op === 'Following').map(c => c.fieldToggles)],
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
    name: 'stops at once when X flags the activity as automated',
    state: { own: 8 },
    setup: (state) => { state.misbehave.errorCode = { op: 'DeleteTweet', code: 226, after: 3 }; },
    async run(env, state) {
      const r = await quickClean(env, 'delete');
      const deletes = state.calls.filter(c => c.op === 'DeleteTweet');
      return [
        ['job stopped with the automation message', /looks automated/.test(r.job.statusText) && r.job.status === 'interrupted', r.job.statusText],
        ['no request after the flag', deletes.length === 4, deletes.length],
        ['the 3 deleted before are recorded', r.job.total === 3, r.job.total]
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
  await env.worker.evaluate(() => chrome.storage.local.set({ apiPace: 1 }));
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
