// End-to-end tests: the real unpacked extension in Chromium, driven through its popup, against
// the fake x.com in fake-x.mjs. Usage: node test/e2e/run.mjs [scenario-name-filter]
import { launch, openExtensionPage, storage, waitFor } from './launch.mjs';
import { createState, installFakeX, fakeQueryIds, ME, scriptedTimeline, seededBundle, xCreatedAt } from './fake-x.mjs';
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
  const timers = new Map(); let timerId = 0, fullReads = 0, holdFull = null, holdWrite = null, dispatch = null, dispatchResult = { ok: true }, stops = 0;
  const makeItems = n => Array.from({ length: n }, (_, i) => ({ id: `synthetic-${i}`, type: 'tweet', classification: 'tweets', text: `post ${i}`, date: '2024-01-01', selected: true }));
  const window = { __xbcPreview: { startedAt: 1, type: 'tweets', items: makeItems(2000), interval: {}, paused: true, done: false } };
  const context = vm.createContext({ document, window, console, setInterval: fn => { timers.set(++timerId, fn); return timerId; }, clearInterval: id => timers.delete(id),
    chrome: { storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } }, scripting: { executeScript: async ({ func, args = [] }) => {
      if (func.name === 'runSelectedDelete') { dispatch = args; if (dispatchResult instanceof Error) throw dispatchResult; return [{ result: dispatchResult }]; }
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
  check('New scan with a review on screen asks first and keeps the list (VER-816)', () => { assert.equal(document.getElementById('newScanDialog').open, true); assert.ok(run('previewItems.length') > 0); });
  await run('resetPreview()');
  check('New scan resets the review and its snapshot', () => { assert.equal(run('previewItems.length'), 0); assert.equal(run('previewSnapshot'), null); assert.equal(document.getElementById('newScanDialog').open, false); });

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
  // A lost scan ends only this tab's session, not one another tab has started since (VER-816).
  const sessionStore = run('chrome.storage.local');
  let removed = null;
  sessionStore.remove = async keys => { removed = keys; };
  sessionStore.get = async () => ({ activePreviewSession: { tabId: 99 } });
  await run('previewLost()');
  check("a lost scan leaves the session another tab started", () => { assert.equal(removed, null); assert.equal(document.getElementById('setupSection').style.display, 'block'); });
  sessionStore.get = async () => ({ activePreviewSession: { tabId: 42 } });
  await run('previewLost()');
  check("a lost scan ends its own tab's session", () => assert.equal(removed?.[0], 'activePreviewSession'));
  // "Stop scan" on a scan the tab no longer holds says it was lost, instead of asking to clear the list.
  window.__xbcPreview = { startedAt: 9, type: 'tweets', items: makeItems(1), interval: {}, paused: true, done: false };
  run('startPolling()'); await settle();
  delete window.__xbcPreview;
  run('showError("")'); document.getElementById('setupSection').style.display = 'none';
  await run('stopScan()'); await settle();
  check('Stop scan on a scan the tab no longer holds says it was lost', () => { assert.match(document.getElementById('errorMessage').textContent, /scan was lost/); assert.equal(document.getElementById('setupSection').style.display, 'block'); assert.equal(document.getElementById('newScanDialog').open, false); assert.equal(timers.size, 0); });
  // A deletion that fails to start shows the stopped scan and offers "New scan".
  run('previewItems = [{ id: "synthetic-refused", selected: true, classification: "tweets" }]');
  dispatchResult = { ok: false, error: 'synthetic refusal' };
  await run('beginSelectedDelete()'); await settle();
  check('a deletion that fails to start shows the stopped scan and New scan', () => { assert.equal(document.getElementById('errorMessage').textContent, 'synthetic refusal'); assert.equal(document.getElementById('scanState').textContent, 'Scan stopped'); assert.equal(document.getElementById('stopScan').textContent, 'New scan'); assert.equal(timers.size, 0); assert.equal(run('cleanupRunning'), false); });
  // An error thrown while starting is reported the same way, and leaves no activeAction behind.
  run('previewItems = [{ id: "synthetic-thrown", selected: true, classification: "tweets" }]');
  removed = null;
  dispatchResult = new Error('synthetic throw');
  await run('beginSelectedDelete()'); await settle();
  check('an error thrown while starting a deletion is reported, with the stopped scan and no activeAction', () => { assert.equal(document.getElementById('errorMessage').textContent, 'Could not start selected deletion: synthetic throw'); assert.equal(document.getElementById('scanState').textContent, 'Scan stopped'); assert.equal(document.getElementById('stopScan').textContent, 'New scan'); assert.ok(removed?.includes('activeAction')); assert.equal(run('cleanupRunning'), false); });
  dispatchResult = { ok: true };
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

if (process.argv[2] === '--api-pagination') {
  const { testApiPagination } = await import('./api-pagination.mjs');
  await testApiPagination();
  process.exit(0);
}

const BUTTONS = { delete: 'startDelete', unrepost: 'startUnrepost', unlike: 'startUnlike', bulkUnfollow: 'bulkUnfollow', followAll: 'followAllFollowers', followVerified: 'followVerifiedFollowers' };

async function quickClean(env, action, { apiMode = true } = {}) {
  const before = (await storage(env.worker, ['jobHistory'])).jobHistory?.length || 0;
  const popup = await openExtensionPage(env.context, env.extensionId, 'popup/popup.html');
  await popup.waitForFunction(() => document.getElementById('accountCard')?.dataset.state === 'ready', null, { timeout: 20000 });
  // Restoring a finished job clears activeAction asynchronously in the new popup.
  await waitFor(async () => !(await storage(env.worker, ['activeAction'])).activeAction, { label: 'previous action state to clear' });
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
    return history.length > before && history[0]?.status !== 'running' ? history[0] : null;
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
    return history.length > before && history[0]?.status !== 'running' ? history[0] : null;
  }, { timeout: 120000, label: `selected ${type} job to finish` });
  const worker = await env.worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: ['https://x.com/*'] });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { const X = window.__xCleaner; return X && { mode: X.mode, apiFallback: X.apiFallback || null, issue: X.issue }; } });
    return r?.result;
  });
  await panel.close();
  return { scanned, scan, job, worker };
}

// Click-mode safety (VER-628): a DOM scan the test can watch and act on while it runs.
async function readPreview(env) {
  return env.worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: ['https://x.com/*'] });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      const P = window.__xbcPreview;
      return P && { mode: P.mode, running: !!P.interval, issue: P.issue, done: P.done, ids: P.items.map(i => i.id) };
    } });
    return r?.result;
  });
}
const xPage = env => env.context.pages().find(page => page.url().startsWith('https://x.com/'));
const domActions = state => state.calls.filter(c => /^dom-/.test(c.op));
async function startDomScan(env, type) {
  const panel = await openExtensionPage(env.context, env.extensionId, 'sidepanel/sidepanel.html');
  await panel.waitForFunction(() => !document.getElementById('startScan').disabled, null, { timeout: 20000 });
  await panel.evaluate((type) => {
    document.querySelector(`input[name="previewType"][value="${type}"]`).click();
    const box = document.getElementById('previewApi');
    if (box.checked) box.click();
    document.getElementById('startScan').click();
  }, type);
  return panel;
}

// Steps that throw (VER-823): once `worker` ('__xCleaner' or '__xbcPreview') runs in the X tab, the
// next `count` lookups of X's main column throw in the extension's isolated world, where the
// workers run. Every step starts with that lookup, so each throw aborts one step.
async function failSteps(env, worker, count) {
  return waitFor(() => env.worker.evaluate(async ({ worker, count }) => {
    const [tab] = await chrome.tabs.query({ url: ['https://x.com/*'] });
    if (!tab) return null;
    try {
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, args: [worker, count], func: (worker, count) => {
        if (!window[worker]?.interval) return null;
        if (!window.__xbcFault) {
          const fault = window.__xbcFault = { left: 0, thrown: 0, passed: 0 };
          const lookup = Document.prototype.querySelector;
          document.querySelector = function (selector) {
            if (selector === '[data-testid="primaryColumn"]') {
              if (fault.left > 0) { fault.left--; fault.thrown++; throw new Error('synthetic step failure'); }
              fault.passed++;
            }
            return lookup.call(this, selector);
          };
        }
        window.__xbcFault.left += count;
        return { ...window.__xbcFault };
      } });
      return r?.result;
    } catch { return null; }
  }, { worker, count }), { timeout: 120000, label: `${worker} to run` });
}
async function readFault(env) {
  return env.worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: ['https://x.com/*'] });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.__xbcFault && { ...window.__xbcFault, busy: !!(window.__xCleaner?.busy || window.__xbcPreview?.busy) } });
    return r?.result;
  });
}

// "Find & delete replies" with API mode on (VER-624). X builds change the UserTweetsAndReplies
// query id; the page asks for its replies with the new id, sometimes only after the extension
// started. The bundle is seeded, so these scenarios never fetch X's real main.js.
const ROTATED_UTR = 'RotatedRepliesQueryId001';
const FALLBACK_UTR = fakeQueryIds.UserTweetsAndReplies; // the fake's default ids are the extension's built-in ones
const REPORTED_404 = 'Scan interrupted after 0 items: HTTP 404. Try again with API, or turn off API mode and start a new scan.';
const idLabel = queryId => queryId === ROTATED_UTR ? 'rotated' : queryId === FALLBACK_UTR ? 'fallback' : 'other';
const rotatedReplies = (pageRequest) => (state) => {
  state.queryIds = { UserTweetsAndReplies: ROTATED_UTR };
  state.pageRequest = pageRequest;
  state.misbehave.emptyNotFound = true;
};
async function seedBundle(env, state, options) {
  await env.worker.evaluate(bundle => chrome.storage.local.set({ xbcBundleOps: bundle }), seededBundle(state, options));
}
async function scanRepliesByApi(env, state) {
  const panel = await openExtensionPage(env.context, env.extensionId, 'sidepanel/sidepanel.html');
  try {
    await panel.waitForFunction(() => !document.getElementById('startScan').disabled, null, { timeout: 20000 });
    const clicked = Date.now();
    await panel.evaluate(() => {
      document.querySelector('input[name="previewType"][value="replies"]').click();
      document.querySelector('input[name="replyScope"][value="fast"]').click();
      const box = document.getElementById('previewApi');
      if (!box.checked) box.click();
      document.getElementById('startScan').click();
    });
    await panel.waitForFunction(() => /Scan complete|Scan interrupted|Scan stopped/.test(document.getElementById('scanState')?.textContent || ''), null, { timeout: 60000 });
    const seconds = (Date.now() - clicked) / 1000;
    const scan = await env.worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ url: ['https://x.com/*'] });
      const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
        const P = window.__xbcPreview;
        return P && { mode: P.mode, done: P.done, running: !!P.interval, issue: P.issue, startedAt: P.startedAt, items: P.items.length,
          replies: P.items.filter(i => i.classification === 'definite').length, source: globalThis.__xbcApi?.sources().UserTweetsAndReplies || null };
      } });
      return r?.result;
    });
    // Only the cached id and its source: the cache also holds the bearer, which is never shown.
    const entry = (await storage(env.worker, ['xbcApiCache'])).xbcApiCache?.ops?.UserTweetsAndReplies;
    return { scan, seconds, cached: entry ? { id: idLabel(entry.queryId), source: entry.source ?? null } : null };
  } finally {
    await panel.close();
  }
}
// API speed (VER-635). Each scenario seeds the web bundle cache, so no request reaches X's CDN.
async function seedSpeedBundle(env, state) {
  const seeded = seededBundle(state);
  await env.worker.evaluate(bundle => chrome.storage.local.set({ xbcBundleOps: bundle }), seeded);
  return seeded;
}
const bundleKept = async (env, seeded) => (await storage(env.worker, ['xbcBundleOps'])).xbcBundleOps?.at === seeded.at;
const setSpeed = (env, value) => env.worker.evaluate(v => chrome.storage.local.set({ apiPace: v }), value);
// The service worker times every sleep a job asks for. Recording the requests there (only their
// length) shows when a pace ends, without touching the page.
async function recordSleeps(env) {
  await env.worker.evaluate(() => {
    globalThis.__speedSleeps = [];
    chrome.runtime.onMessage.addListener(message => {
      if (message?.type === 'xbc:sleep') globalThis.__speedSleeps.push({ at: Date.now(), ms: Math.min(Math.max(Number(message.ms) || 0, 0), 20000) });
    });
  });
}
const recordedSleeps = env => env.worker.evaluate(() => globalThis.__speedSleeps || []);
// Opens the popup or the side panel and reads its speed control once it shows the stored value
// (the control is disabled until then).
async function openSpeed(env, path) {
  const id = path.startsWith('popup') ? 'apiPace' : 'previewSpeed';
  const page = await openExtensionPage(env.context, env.extensionId, path);
  await page.waitForFunction(id => !document.getElementById(id).disabled, id, { timeout: 20000 });
  const shown = await page.evaluate(id => {
    const select = document.getElementById(id);
    return { value: select.value, options: [...select.options].map(o => `${o.value} ${o.textContent}`), note: document.getElementById(select.getAttribute('aria-describedby'))?.textContent || '' };
  }, id);
  return { page, shown };
}
const latestJob = async (env, before) => {
  const history = (await storage(env.worker, ['jobHistory'])).jobHistory || [];
  return history.length > before && history[0]?.status !== 'running' ? history[0] : null;
};
async function startQuickDelete(env, popup) {
  await popup.waitForFunction(() => document.getElementById('accountCard')?.dataset.state === 'ready', null, { timeout: 20000 });
  await popup.evaluate(() => { const box = document.getElementById('apiMode'); if (!box.checked) box.click(); document.getElementById('startDelete').click(); });
  await popup.waitForFunction(() => document.getElementById('confirmDialog')?.open, null, { timeout: 10000 });
  await popup.evaluate(() => document.getElementById('confirmStart').click());
}
async function scanPostsByApi(panel) {
  await panel.waitForFunction(() => !document.getElementById('startScan').disabled, null, { timeout: 20000 });
  await panel.evaluate(() => {
    document.querySelector('input[name="previewType"][value="tweets"]').click();
    const box = document.getElementById('previewApi');
    if (!box.checked) box.click();
    document.getElementById('startScan').click();
  });
}
// Stops a job by its own Stop button about 1.2 s into the Careful pace after its first
// DeleteTweet, then waits past the time a full pace would have ended.
async function stopDuringPace(env, state, before, pressStop) {
  const first = await waitFor(() => state.calls.find(c => c.op === 'DeleteTweet'), { timeout: 60000, interval: 50, label: 'first DeleteTweet' });
  await waitFor(() => Date.now() >= first.at + 1200, { interval: 50, label: 'into the pace' });
  const deletesAtStop = state.calls.filter(c => c.op === 'DeleteTweet').length;
  await pressStop();
  const job = await waitFor(() => latestJob(env, before), { timeout: 10000, label: 'stopped job record' });
  // A Careful pace lasts 5 to 7.5 s: a pace Stop did not end would still be running before this.
  await waitFor(() => Date.now() >= first.at + 8500, { interval: 100, label: 'past a full Careful pace' });
  const sleeps = (await recordedSleeps(env)).filter(s => s.at >= first.at);
  return {
    job, deletesAtStop,
    deletes: state.calls.filter(c => c.op === 'DeleteTweet').length,
    laterRequests: state.calls.filter(c => c.at > job.completedAt && !c.fromPage && c.method !== 'DOM').map(c => c.op || c.path),
    steps: sleeps.map(s => s.ms),
    // How long after the job stopped its last pace step ended.
    lingered: sleeps.length ? Math.max(...sleeps.map(s => s.at + s.ms)) - job.completedAt : null
  };
}
const repliesRequests = state => state.calls.filter(c => c.op === 'UserTweetsAndReplies').map(c => ({ at: c.at, fromPage: !!c.fromPage, id: idLabel(c.path.split('/').at(-2)) }));

// Date choice of "Delete all posts" (VER-636). Posts are dated far from the cutoff, so the
// browser's time zone cannot move one across it. `dates` gives the first posts their dates.
const DAY_MS = 86400000;
const datePosts = (state, dates) => dates.forEach((date, i) => { state.tweets[i].created = typeof date === 'string' && !/^\d{4}-/.test(date) ? date : xCreatedAt(date); });
const ids = list => list.map(t => t.id).sort().join(',');
async function readConfirm(popup) {
  return popup.evaluate(() => {
    const error = document.getElementById('dateScopeError');
    return {
      open: document.getElementById('confirmDialog').open,
      title: document.getElementById('confirmTitle').textContent,
      description: document.getElementById('confirmDescription').textContent,
      button: document.getElementById('confirmStart').textContent,
      scopeShown: !document.getElementById('dateScope').hidden,
      choice: document.querySelector('input[name="dateScope"]:checked')?.value || null,
      error: error.hidden ? '' : error.textContent
    };
  });
}
// Opens the popup, starts "Delete all posts", reads the dialog on All posts, then picks the date
// choice. Returns the open popup with both readings; the caller confirms or not.
async function openDeleteByDate(env, { apiMode = true, mode, date, days } = {}) {
  const popup = await openExtensionPage(env.context, env.extensionId, 'popup/popup.html');
  await popup.waitForFunction(() => document.getElementById('accountCard')?.dataset.state === 'ready', null, { timeout: 20000 });
  await waitFor(async () => !(await storage(env.worker, ['activeAction'])).activeAction, { label: 'previous action state to clear' });
  await popup.evaluate(on => { const box = document.getElementById('apiMode'); if (box.checked !== on) box.click(); }, apiMode);
  await popup.evaluate(() => document.getElementById('startDelete').click());
  await popup.waitForFunction(() => document.getElementById('confirmDialog')?.open, null, { timeout: 10000 });
  const allPosts = await readConfirm(popup);
  if (mode === 'before') { await popup.locator('#dateScopeBefore').check(); if (date != null) await popup.locator('#dateScopeDate').fill(date); }
  if (mode === 'days') { await popup.locator('#dateScopeKeep').check(); if (days != null) await popup.locator('#dateScopeDays').fill(String(days)); }
  return { popup, allPosts, chosen: await readConfirm(popup) };
}
async function deleteByDate(env, options) {
  const before = (await storage(env.worker, ['jobHistory'])).jobHistory?.length || 0;
  const opened = await openDeleteByDate(env, options);
  const clickedAt = Date.now();
  await opened.popup.locator('#confirmStart').click();
  const job = await waitFor(() => latestJob(env, before), { timeout: 120000, label: 'dated delete job to finish' });
  const worker = await env.worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: ['https://x.com/*'] });
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { const X = window.__xCleaner; return X && { mode: X.mode, stats: X.stats, issue: X.issue }; } });
    return r?.result;
  });
  const localMidnight = await opened.popup.evaluate(date => { const [y, m, d] = (date || '2000-01-01').split('-').map(Number); return new Date(y, m - 1, d).toISOString(); }, options.date);
  await opened.popup.close();
  return { ...opened, job, worker, clickedAt, localMidnight };
}
const xTabHasJob = env => env.worker.evaluate(async () => {
  const [tab] = await chrome.tabs.query({ url: ['https://x.com/*'] });
  const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => !!window.__xCleaner });
  return r?.result;
});
const ALL_POSTS = 'Every post on your profile will be permanently deleted. A record of each one is saved locally.';

const SCENARIOS = [
  ...[
    { name: 'ten empty pages interrupt with empty_streak', expected: 0, complete: false, reason: /10 consecutive pages without new items/, sequence: state => Array.from({ length: 10 }, (_, i) => scriptedTimeline(state, { cursor: `empty-${i}` })) },
    { name: 'nine empty pages still reach a post', expected: 1, complete: true, sequence: state => [...Array.from({ length: 9 }, (_, i) => scriptedTimeline(state, { cursor: `empty-${i}` })), scriptedTimeline(state, { indices: [0], end: true })] },
    { name: 'empty advancing pages reach a later post', expected: 1, complete: true, sequence: state => [scriptedTimeline(state, { cursor: 'c1' }), scriptedTimeline(state, { cursor: 'c2' }), scriptedTimeline(state, { indices: [0], end: true })] },
    { name: 'duplicate pages reach a later distinct post', expected: 2, complete: true, sequence: state => [scriptedTimeline(state, { indices: [0], cursor: 'c1' }), scriptedTimeline(state, { indices: [0], cursor: 'c2' }), scriptedTimeline(state, { indices: [0], cursor: 'c3' }), scriptedTimeline(state, { indices: [1], end: true })] },
    { name: 'cursor cycle interrupts with partial items', expected: 2, complete: false, sequence: state => [scriptedTimeline(state, { indices: [0], cursor: 'c1' }), scriptedTimeline(state, { indices: [1], cursor: 'c2' }), scriptedTimeline(state, { indices: [0], cursor: 'c1' })] },
    { name: 'stalled cursor interrupts', expected: 1, complete: false, sequence: state => [scriptedTimeline(state, { indices: [0], cursor: 'c1' }), scriptedTimeline(state, { indices: [0], cursor: 'c1' })] },
    { name: 'missing cursor interrupts', expected: 1, complete: false, sequence: state => [scriptedTimeline(state, { indices: [0] })] },
    { name: 'invalid data is interrupted zero', expected: 0, complete: false, sequence: () => [{ data: {} }] },
    { name: 'refusal offers a new scan without automatic DOM', expected: 0, complete: false, sequence: () => [{ status: 400, body: {} }] },
    { name: 'server error preserves earlier items', expected: 1, complete: false, sequence: state => [scriptedTimeline(state, { indices: [0], cursor: 'c1' }), ...Array.from({ length: 4 }, () => ({ status: 500, body: { errors: [{ code: 130, message: 'synthetic server error' }] } }))] },
    { name: 'explicit empty end is inconclusive zero', expected: 0, complete: false, sequence: state => [scriptedTimeline(state, { end: true })] },
    { name: 'partial response preserves items and interrupts', expected: 1, complete: false, sequence: state => [scriptedTimeline(state, { indices: [0], end: true, errors: [{ code: 999, message: 'synthetic partial response' }] })] }
  ].map(({ name, expected, complete, sequence, reason }) => ({
    name: `pagination: scan ${name}`,
    state: { own: 2 },
    async run(env, state) {
      const xTab = env.context.pages().find(page => page.url().startsWith('https://x.com/'));
      await xTab.goto(`https://x.com/${ME.screen}`);
      await waitFor(() => state.calls.some(c => c.op === 'UserTweets'), { label: 'profile discovery GET' });
      const before = state.calls.filter(c => c.op === 'UserTweets').length;
      const responses = sequence(state); state.misbehave.responses.UserTweets = responses.map(body => typeof body.status === 'number' ? body : { status: 200, body });
      const panel = await openExtensionPage(env.context, env.extensionId, 'sidepanel/sidepanel.html');
      await panel.waitForFunction(() => !document.getElementById('startScan').disabled);
      await panel.locator('#startScan').click();
      await panel.waitForFunction(() => /Scan complete|Scan interrupted|Scan stopped/.test(document.getElementById('scanState').textContent), null, { timeout: 100000 });
      const result = await env.worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ url: ['https://x.com/*'] });
        const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { const p = window.__xbcPreview; return { mode: p.mode, done: p.done, items: p.items.length, issue: p.issue, fallback: p.apiFallback || null, running: !!p.interval }; } });
        return r.result;
      });
      await panel.close();
      return [
        ['expected items and terminal state', result.items === expected && result.done === complete && !result.running, result],
        ['completion label only for proven nonzero end', complete ? result.issue === 'Scan complete' : !/Scan complete/.test(result.issue) && result.issue.includes(String(expected)), result.issue],
        ['API mode retained without DOM fallback or mutations', result.mode === 'api' && !result.fallback && !state.calls.some(c => c.method === 'POST'), result],
        ['all intended pages requested', state.calls.filter(c => c.op === 'UserTweets').length - before === responses.length, state.calls],
        ['specific safety reason is preserved when required', !reason || reason.test(result.issue), result.issue]
      ];
    }
  })),
  {
    name: 'pagination: Stop during paused page processing prevents the next request',
    state: { own: 2 },
    async run(env, state) {
      const xTab = env.context.pages().find(page => page.url().startsWith('https://x.com/'));
      await xTab.goto(`https://x.com/${ME.screen}`);
      await waitFor(() => state.calls.some(c => c.op === 'UserTweets'));
      const before = state.calls.filter(c => c.op === 'UserTweets').length;
      let release; const firstPage = new Promise(resolve => { release = resolve; });
      state.misbehave.responses.UserTweets = [{ status: 200, body: scriptedTimeline(state, { indices: [0], cursor: 'c1' }), waitFor: firstPage }];
      const panel = await openExtensionPage(env.context, env.extensionId, 'sidepanel/sidepanel.html');
      try {
        await panel.waitForFunction(() => !document.getElementById('startScan').disabled);
        await panel.locator('#startScan').click();
        await waitFor(() => state.calls.filter(c => c.op === 'UserTweets').length > before, { label: 'held first API page' });
        await env.worker.evaluate(async () => {
          const [tab] = await chrome.tabs.query({ url: ['https://x.com/*'] });
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { window.__xbcPreview.paused = true; } });
        });
        release();
        await waitFor(() => env.worker.evaluate(async () => {
          const [tab] = await chrome.tabs.query({ url: ['https://x.com/*'] });
          const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.__xbcPreview.items.length === 1 });
          return r.result;
        }), { label: 'first parsed item before Stop' });
        await panel.locator('#stopScan').click();
        await panel.waitForFunction(() => /stopped by user/i.test(document.getElementById('scanState').textContent));
        await panel.waitForTimeout(1100);
        const result = await env.worker.evaluate(async () => {
          const [tab] = await chrome.tabs.query({ url: ['https://x.com/*'] });
          const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { const p = window.__xbcPreview; return { done: p.done, count: p.items.length, running: !!p.interval }; } });
          return r.result;
        });
        await panel.close();
        return [
          ['Stop preserves partial items without completing', !result.done && !result.running && result.count === 1, result],
          ['no next page or mutation', state.calls.filter(c => c.op === 'UserTweets').length - before === 1 && !state.calls.some(c => c.method === 'POST'), state.calls]
        ];
      } finally { release(); }
    }
  },
  ...[
    { name: 'explicit empty timeline', body: state => scriptedTimeline(state, { end: true }) },
    { name: 'invalid timeline shape', body: () => ({ data: {} }) }
  ].map(({ name, body }) => ({
    name: `pagination: Quick Clean ${name} stops with zero actions`,
    state: { own: 2 },
    async run(env, state) {
      // Profile discovery must complete before the fixture is installed for the worker.
      const xTab = env.context.pages().find(page => page.url().startsWith('https://x.com/'));
      state.misbehave.responses.UserTweets = [];
      await xTab.goto(`https://x.com/${ME.screen}`);
      await waitFor(() => state.calls.some(c => c.op === 'UserTweets'));
      state.misbehave.responses.UserTweets = [{ status: 200, body: body(state) }];
      const r = await quickClean(env, 'delete');
      return [
        ['job interrupted with zero recorded actions', r.job.status === 'interrupted' && r.job.total === 0 && !/^Finished/.test(r.worker.issue), r.job],
        ['no automatic deletion or click fallback', r.worker.mode === 'api' && !r.worker.apiFallback && !state.calls.some(c => c.op === 'DeleteTweet' || c.op === 'dom-delete') && state.tweets.length === 2, r.worker],
        ['explicit new choice offered', /Start a new job to try the API again, or turn off API mode/.test(r.worker.issue), r.worker.issue]
      ];
    }
  })),
  ...[
    { name: 'active', account: ME.id, offset: 3600000, blocked: false, stops: true },
    { name: 'blocked', account: ME.id, offset: 3600000, blocked: true, stops: true },
    { name: 'expired', account: ME.id, offset: -60000, blocked: true, stops: false },
    { name: 'another account', account: '99', offset: 3600000, blocked: true, stops: false }
  ].map(({ name, account, offset, blocked, stops }) => ({
    name: `limits: API off Quick Clean respects ${name} cooldown`,
    state: { own: 2 },
    async run(env, state) {
      await env.worker.evaluate(({ account, offset, blocked }) => chrome.storage.local.set({ [`xbcApiCooldown:${account}:DeleteTweet:claim:manual-test`]: { until: Date.now() + offset, blocked } }), { account, offset, blocked });
      const r = await quickClean(env, 'delete', { apiMode: false });
      const dom = state.calls.filter(c => c.op === 'dom-delete').length;
      return [
        ['API mode stays off', !state.calls.some(c => c.op === 'DeleteTweet'), state.calls],
        ['only applicable active cooldown blocks DOM', stops ? dom === 0 && state.tweets.length === 2 : dom === 2 && state.tweets.length === 0, { dom, remaining: state.tweets.length }],
        ['history reflects the gate or completed consented action', stops ? r.job.status === 'interrupted' && r.job.total === 0 && /suspended/.test(r.job.statusText) : r.job.status === 'completed' && r.job.total === 2, r.job]
      ];
    }
  })),
  {
    name: 'limits: API off preview scan respects its list cooldown',
    state: { own: 2 },
    async run(env, state) {
      await env.worker.evaluate(id => chrome.storage.local.set({ [`xbcApiCooldown:${id}:UserTweets:claim:manual-test`]: { until: Date.now() + 3600000 } }), ME.id);
      const panel = await openExtensionPage(env.context, env.extensionId, 'sidepanel/sidepanel.html');
      await panel.waitForFunction(() => !document.getElementById('startScan').disabled);
      await panel.evaluate(() => { document.getElementById('previewApi').checked = false; document.getElementById('startScan').click(); });
      await panel.waitForFunction(() => /Scan stopped.*suspended/.test(document.getElementById('scanState').textContent));
      const result = await env.worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ url: ['https://x.com/*'] });
        const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => { const p = window.__xbcPreview; return { mode: p.mode, running: !!p.interval, done: p.done, items: p.items.length }; } });
        return r.result;
      });
      await panel.close();
      return [
        ['scan did not start DOM or mark complete', result.mode !== 'dom' && !result.running && !result.done && result.items === 0, result],
        ['no destructive request', !state.calls.some(c => c.method === 'POST'), state.calls]
      ];
    }
  },
  {
    name: 'limits: API off selected deletion respects an action cooldown after confirmation',
    state: { own: 2 },
    async run(env, state) {
      const r = await previewAndAct(env, 'tweets', { apiMode: false, beforeAct: () => env.worker.evaluate(id => chrome.storage.local.set({ [`xbcApiCooldown:${id}:DeleteTweet:claim:manual-test`]: { until: Date.now() + 3600000, blocked: true } }), ME.id) });
      return [
        ['unrestricted DOM scan still found both items', r.scan.mode === 'dom' && r.scan.items.length === 2, r.scan],
        ['confirmed job records suspension with zero success', r.job.status === 'interrupted' && r.job.total === 0 && /suspended/.test(r.job.statusText), r.job],
        ['no DOM or API deletion', !state.calls.some(c => c.op === 'dom-delete' || c.op === 'DeleteTweet') && state.tweets.length === 2, state.calls]
      ];
    }
  },
  {
    name: 'limits: API off Stop during pending cooldown read never starts DOM afterward',
    state: { own: 2 },
    async run(env, state) {
      // This test-only adapter holds the worker's local metadata read, not X traffic.
      // Navigate first so the isolated-world adapter survives the action dispatch.
      const xTab = env.context.pages().find(page => page.url().startsWith('https://x.com/'));
      await xTab.goto(`https://x.com/${ME.screen}`);
      await env.worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ url: ['https://x.com/*'] });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
          if (typeof chrome.storage.local.getKeys === 'function') {
            const original = chrome.storage.local.getKeys.bind(chrome.storage.local);
            chrome.storage.local.getKeys = () => new Promise(resolve => { window.__releaseCooldownRead = () => { chrome.storage.local.getKeys = original; resolve([]); }; });
          } else {
            const original = chrome.storage.local.get.bind(chrome.storage.local);
            chrome.storage.local.get = keys => keys === null ? new Promise(resolve => { window.__releaseCooldownRead = () => { chrome.storage.local.get = original; resolve({}); }; }) : original(keys);
          }
        } });
      });
      const popup = await openExtensionPage(env.context, env.extensionId, 'popup/popup.html');
      await popup.waitForFunction(() => document.getElementById('accountCard')?.dataset.state === 'ready');
      await popup.evaluate(() => { const box = document.getElementById('apiMode'); if (box.checked) box.click(); document.getElementById('startDelete').click(); });
      await popup.waitForFunction(() => document.getElementById('confirmDialog').open);
      await popup.locator('#confirmStart').click();
      await waitFor(() => env.worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ url: ['https://x.com/*'] });
        const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => !!window.__releaseCooldownRead });
        return r.result;
      }), { label: 'held manual cooldown read' });
      const result = await env.worker.evaluate(async () => {
        const [tab] = await chrome.tabs.query({ url: ['https://x.com/*'] });
        const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: async () => {
          await window.__xCleanerStop(); window.__releaseCooldownRead();
          await new Promise(resolve => setTimeout(resolve, 100));
          return { running: !!window.__xCleaner.interval, issue: window.__xCleaner.issue, mode: window.__xCleaner.mode };
        } });
        return r.result;
      });
      await popup.close();
      return [
        ['Stop survives delayed storage completion', !result.running && result.mode !== 'dom' && /Stopped by user/.test(result.issue), result],
        ['no actions were dispatched', !state.calls.some(c => c.op === 'dom-delete' || c.op === 'DeleteTweet') && state.tweets.length === 2, state.calls]
      ];
    }
  },
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
    name: 'API refusal requires a new confirmed click-mode job',
    state: { own: 5 },
    setup: (state) => { state.misbehave.refuse.DeleteTweet = 404; },
    async run(env, state) {
      const r = await quickClean(env, 'delete');
      const beforeChoice = { remaining: state.tweets.length, dom: state.calls.filter(c => c.op === 'dom-delete').length };
      const manual = await quickClean(env, 'delete', { apiMode: false });
      return [
        ['refusal interrupts without automatic DOM', r.worker?.mode === 'api' && !r.worker.apiFallback && r.job.status === 'interrupted' && r.job.total === 0, r],
        ['choice mentions API off and new job', /Start a new job to try the API again, or turn off API mode/.test(r.worker.issue), r.worker.issue],
        ['all posts untouched before explicit new choice', beforeChoice.remaining === 5 && beforeChoice.dom === 0, beforeChoice],
        ['new confirmed click job deletes all 5', manual.worker.mode === 'dom' && state.tweets.length === 0 && state.calls.filter(c => c.op === 'dom-delete').length === 5, manual],
        ['new history has 5 records', manual.job.total === 5, manual.job]
      ];
    }
  },
  {
    name: 'signed-session refusal stops without automatic click fallback',
    state: { own: 2, retweets: 3 },
    setup: (state) => { state.misbehave.binding.DeleteRetweet = true; },
    async run(env, state) {
      const r = await quickClean(env, 'unrepost');
      return [
        ['API job interrupted without automatic DOM', r.worker?.mode === 'api' && !r.worker.apiFallback && r.job.status === 'interrupted', r.worker],
        ['reason mentions the signed session', /signed session/.test(r.worker?.issue || ''), r.worker?.issue],
        ['no repost removed through the API', state.tweets.filter(t => t.retweetOf).length === 3, state.tweets.length],
        ['the refused DeleteRetweet was tried once, then no more', state.calls.filter(c => c.op === 'DeleteRetweet').length === 1],
        ['manual choice requires a new confirmed job', /Start a new job to try the API again, or turn off API mode/.test(r.worker.issue) && !state.calls.some(c => c.op === 'dom-delete'), r.worker.issue]
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
  },
  {
    name: 'click mode: Follow all leaves suggested accounts outside the main column alone',
    state: { followers: 3 },
    setup: (state) => { state.dom = { users: true, sidebar: [{ id: '900', screen: 'suggested0', name: 'Suggested 0' }, { id: '901', screen: 'suggested1', name: 'Suggested 1' }] }; },
    async run(env, state) {
      const r = await quickClean(env, 'followAll', { apiMode: false });
      const follows = state.calls.filter(c => c.op === 'dom-follow');
      return [
        ['mode is dom', r.worker?.mode === 'dom', r.worker],
        ['no action outside the main column', domActions(state).every(c => c.where === 'column'), domActions(state)],
        ['the 3 followers were followed', follows.length === 3 && state.followers.every(u => u.following), follows],
        ['history: 3 follows', r.job.counts.follows === 3 && r.record.backup.follows.every(u => /^r\d$/.test(u.username)), r.record.backup.follows]
      ];
    }
  },
  {
    name: 'click mode: navigating away mid-job stops it with no action on the new page',
    state: { own: 6 },
    setup: (state) => { state.dom = { navigateAfter: 2 }; },
    async run(env, state) {
      const r = await quickClean(env, 'delete', { apiMode: false });
      const deletes = state.calls.filter(c => c.op === 'dom-delete');
      return [
        ['mode is dom', r.worker?.mode === 'dom', r.worker],
        ['job stopped because the page changed', r.job.status === 'interrupted' && /The page changed/.test(r.job.statusText), r.job.statusText],
        ['no action after the switch', deletes.length === 2 && deletes.every(c => c.path === `/${ME.screen}`), deletes],
        ['the other 4 posts remain', state.tweets.length === 4, state.tweets.length],
        ['history: the 2 deletions', r.job.total === 2, r.job]
      ];
    }
  },
  {
    name: 'click mode: without a main column nothing is a candidate',
    state: { own: 3 },
    setup: (state) => { state.dom = { noPrimaryColumn: true }; },
    async run(env, state) {
      const r = await quickClean(env, 'delete', { apiMode: false });
      return [
        ['mode is dom', r.worker?.mode === 'dom', r.worker],
        ['no click action', domActions(state).length === 0 && state.tweets.length === 3, domActions(state)],
        ['zero found, zero deleted', r.worker?.stats.found === 0 && r.job.total === 0, { stats: r.worker?.stats, job: r.job }]
      ];
    }
  },
  {
    name: 'preview: DOM scan and selected unfollow stay inside the main column',
    state: { following: 2 },
    // "f1" also shows in the sidebar with its own Unfollow button, like X's "Relevant people".
    setup: (state) => { state.dom = { users: true, sidebar: [{ id: '900', screen: 'suggested0', name: 'Suggested 0' }, { id: 'f101', screen: 'f1', name: 'F 1', following: true }] }; },
    async run(env, state) {
      const r = await previewAndAct(env, 'unfollow', { apiMode: false });
      const unfollows = state.calls.filter(c => c.op === 'dom-unfollow');
      return [
        ['scan ran by clicking', r.scan?.mode === 'dom' && r.worker?.mode === 'dom', { scan: r.scan?.mode, worker: r.worker }],
        ['scan listed only the 2 accounts in the main column', r.scan?.items.map(i => i.id).sort().join() === 'f0,f1', r.scan?.items],
        ['no action outside the main column', domActions(state).every(c => c.where === 'column'), domActions(state)],
        ['both accounts unfollowed once', unfollows.length === 2 && state.following.length === 0, unfollows],
        ['history: 2 unfollows', r.job.counts.unfollows === 2, r.job.counts]
      ];
    }
  },
  {
    name: 'preview: DOM scan stops when the page changes',
    state: { own: 4 },
    setup: (state) => { state.dom = {}; },
    async run(env) {
      const panel = await startDomScan(env, 'tweets');
      await waitFor(async () => { const P = await readPreview(env); return P?.mode === 'dom' && P.ids.length > 0; }, { interval: 100, label: 'first scanned items' });
      // Like X's SPA: a new path, and a post of yours on the new page.
      await xPage(env).evaluate(() => {
        history.pushState({}, '', '/explore');
        const cell = document.createElement('div');
        cell.dataset.testid = 'cellInnerDiv';
        cell.innerHTML = '<article data-testid="tweet"><div data-testid="User-Name"><a role="link" href="/me">me</a> <a href="/me/status/91999">t</a></div><button data-testid="caret">…</button></article>';
        document.getElementById('list').appendChild(cell);
      });
      const scan = await waitFor(async () => { const P = await readPreview(env); return !P.running && P; }, { timeout: 20000, label: 'scan to stop' });
      const label = await panel.waitForFunction(() => /The page changed/.test(document.getElementById('scanState').textContent), null, { timeout: 5000 })
        .then(() => 'The page changed', () => panel.evaluate(() => document.getElementById('scanState').textContent));
      await panel.close();
      return [
        ['scan stopped because the page changed', !scan.done && /The page changed/.test(scan.issue || ''), scan],
        ['nothing listed from the new page', scan.ids.length === 4 && !scan.ids.includes('91999'), scan.ids],
        ['the panel says why', /The page changed/.test(label), label]
      ];
    }
  },
  {
    name: 'preview: selected deletion stops when the page changes',
    state: { own: 6 },
    setup: (state) => { state.dom = { navigateAfter: 2 }; },
    async run(env, state) {
      const r = await previewAndAct(env, 'tweets', { apiMode: false });
      const deletes = state.calls.filter(c => c.op === 'dom-delete');
      return [
        ['scan and deletion ran by clicking', r.scan?.mode === 'dom' && r.scan.items.length === 6 && r.worker?.mode === 'dom', { scan: r.scan, worker: r.worker }],
        ['job stopped because the page changed', r.job.status === 'interrupted' && /The page changed/.test(r.job.statusText), r.job.statusText],
        ['no action after the switch', deletes.length === 2 && deletes.every(c => c.path === `/${ME.screen}`), deletes],
        ['the other 4 posts remain', state.tweets.length === 4, state.tweets.length]
      ];
    }
  },
  // Delete menus as X draws them in other languages (VER-814): the label list alone, the red first
  // item alone, and neither, which must delete nothing. Both click-mode executors, with the list
  // redrawn after every deletion.
  ...[
    { name: 'Portuguese "Excluir" found by its label alone', menu: { label: 'Excluir', red: false, confirm: 'Excluir' }, deletes: true },
    { name: 'unknown red first item found by its color', menu: { label: 'Apagar post', red: true, confirm: 'Apagar' }, deletes: true },
    { name: 'unknown label that is not red deletes nothing', menu: { label: 'Apagar post', red: false, confirm: 'Apagar' }, deletes: false }
  ].flatMap(({ name, menu, deletes }) => {
    const opened = (state, id) => state.calls.filter(c => c.op === 'menu-open' && c.id === id).length;
    const checks = (state, own) => {
      const deleted = state.calls.filter(c => c.op === 'dom-delete').map(c => c.id);
      const common = [['no other menu item clicked', !state.calls.some(c => c.op === 'menu-other'), state.calls.filter(c => c.op === 'menu-other')]];
      if (!deletes) return [
        ...common,
        ['nothing deleted', deleted.length === 0 && own.every(id => state.tweets.some(t => t.id === id)), deleted],
        ['each post tried 3 times, then left', own.every(id => opened(state, id) === 3), own.map(id => opened(state, id))]
      ];
      return [
        ...common,
        ['each own post deleted once', deleted.length === own.length && new Set(deleted).size === own.length && own.every(id => deleted.includes(id)), deleted],
        ['each menu opened once, none missed after a redraw', own.every(id => opened(state, id) === 1), own.map(id => opened(state, id))],
        ['the list was redrawn after every deletion', state.calls.filter(c => c.op === 'menu-render').length === own.length, state.calls.filter(c => c.op === 'menu-render').length]
      ];
    };
    const ownIds = state => state.tweets.filter(t => !t.retweetOf).map(t => t.id);
    return [
      {
        name: `click mode menu: ${name}`,
        state: { own: 5, retweets: 2 },
        setup: (state) => { state.dom = { lang: 'pt', deleteMenu: menu }; },
        async run(env, state) {
          const own = ownIds(state);
          const r = await quickClean(env, 'delete', { apiMode: false });
          return [
            ['mode is dom', r.worker?.mode === 'dom', r.worker],
            ...checks(state, own),
            // "found" counts your own posts whether they were deleted or tried 3 times (VER-824).
            ['found counts your own posts only', r.worker?.stats.found === own.length, r.worker?.stats],
            ['reposts untouched', state.tweets.filter(t => t.retweetOf).length === 2, state.tweets.length],
            ['history total', r.job.total === (deletes ? own.length : 0), r.job]
          ];
        }
      },
      {
        name: `preview menu: ${name}`,
        state: { own: 4 },
        setup: (state) => { state.dom = { lang: 'pt', deleteMenu: menu }; },
        async run(env, state) {
          const own = ownIds(state);
          const r = await previewAndAct(env, 'tweets', { apiMode: false });
          return [
            ['scan and deletion ran by clicking', r.scan?.mode === 'dom' && r.scan.items.length === own.length && r.worker?.mode === 'dom', { scan: r.scan, worker: r.worker }],
            ...checks(state, own),
            ['history total', r.job.total === (deletes ? own.length : 0), r.job]
          ];
        }
      }
    ];
  }),
  // Whose posts are whose in click mode (VER-815): without X's profile link the confirmed account
  // decides, and a tab signed in to another account than the one confirmed stops before any click.
  {
    name: 'click mode identity: without a profile link no menu opens on posts of others',
    state: { own: 3, retweets: 2 },
    setup: (state) => { state.dom = { noProfileLink: true, deleteMenu: { label: 'Delete', red: true, confirm: 'Delete' } }; },
    async run(env, state) {
      const own = state.tweets.filter(t => !t.retweetOf).map(t => t.id);
      const others = state.tweets.filter(t => t.retweetOf).map(t => t.retweetOf.id);
      const r = await quickClean(env, 'delete', { apiMode: false });
      const opened = state.calls.filter(c => c.op === 'menu-open').map(c => c.id);
      return [
        ['mode is dom', r.worker?.mode === 'dom', r.worker],
        ['no menu opened on a post of someone else', !opened.some(id => others.includes(id)), opened],
        ['your posts deleted, the reposts untouched', own.every(id => !state.tweets.some(t => t.id === id)) && state.tweets.filter(t => t.retweetOf).length === others.length, state.tweets.map(t => t.id)],
        ['history: your posts', r.job.status === 'completed' && r.job.total === own.length, r.job]
      ];
    }
  },
  {
    name: 'preview identity: without a profile link the scan lists only your own posts',
    state: { own: 3, retweets: 2 },
    setup: (state) => { state.dom = { noProfileLink: true }; },
    async run(env, state) {
      const own = state.tweets.filter(t => !t.retweetOf).map(t => t.id);
      const r = await previewAndAct(env, 'tweets', { apiMode: false });
      const listed = (r.scan?.items || []).map(i => i.id).sort();
      return [
        ['scan and deletion ran by clicking', r.scan?.mode === 'dom' && r.worker?.mode === 'dom', { scan: r.scan?.mode, worker: r.worker }],
        ['scan listed only your own posts', listed.join() === own.slice().sort().join(), listed],
        ['your posts deleted, the reposts untouched', own.every(id => !state.tweets.some(t => t.id === id)) && state.tweets.filter(t => t.retweetOf).length === 2, state.tweets.map(t => t.id)],
        ['history: your posts', r.job.total === own.length, r.job]
      ];
    }
  },
  {
    name: 'click mode identity: a tab signed in to another account stops before any click',
    state: { own: 3 },
    setup: (state) => { state.dom = { switchedAccount: 'other', deleteMenu: { label: 'Delete', red: true, confirm: 'Delete' } }; },
    async run(env, state) {
      const r = await quickClean(env, 'delete', { apiMode: false });
      return [
        ['mode is dom', r.worker?.mode === 'dom', r.worker],
        ['job stopped and says why', r.job.status === 'interrupted' && /signed in to @other, not @me/.test(r.job.statusText), r.job.statusText],
        ['no click at all', !state.calls.some(c => c.op === 'menu-open') && domActions(state).length === 0 && state.tweets.length === 3, state.calls.filter(c => c.method === 'DOM')],
        ['history: nothing deleted', r.job.total === 0, r.job]
      ];
    }
  },
  {
    name: 'preview identity: a scan in a tab signed in to another account stops and lists nothing',
    state: { own: 3 },
    setup: (state) => { state.dom = { switchedAccount: 'other' }; },
    async run(env) {
      const panel = await startDomScan(env, 'tweets');
      const scan = await waitFor(async () => { const P = await readPreview(env); return P && !P.running && P; }, { timeout: 20000, label: 'scan to stop' });
      const label = await panel.waitForFunction(() => /signed in to @other/.test(document.getElementById('scanState').textContent), null, { timeout: 5000 })
        .then(() => 'signed in to @other', () => panel.evaluate(() => document.getElementById('scanState').textContent));
      await panel.close();
      return [
        ['scan stopped and says why', !scan.done && /signed in to @other, not @me/.test(scan.issue || ''), scan],
        ['nothing listed', scan.ids.length === 0, scan.ids],
        ['the panel says why', /signed in to @other/.test(label), label]
      ];
    }
  },
  {
    // The panel reads @me on /home before deleting; back on the profile page the tab is @other.
    name: 'preview identity: selected deletion in a tab switched to another account stops before any click',
    state: { own: 3 },
    async run(env, state) {
      const r = await previewAndAct(env, 'tweets', { apiMode: false, beforeAct: async () => { state.dom = { switchedAccount: 'other' }; await xPage(env).goto('https://x.com/home'); } });
      return [
        ['scan listed your 3 posts', r.scan?.mode === 'dom' && r.scan.items.length === 3, r.scan],
        ['job stopped and says why', r.job.status === 'interrupted' && /signed in to @other, not @me/.test(r.job.statusText), r.job.statusText],
        ['no click at all', domActions(state).length === 0 && state.tweets.length === 3, state.calls.filter(c => c.method === 'DOM')],
        ['history: nothing deleted', r.job.total === 0, r.job]
      ];
    }
  },
  // CSV backups (VER-630): a byte order mark for Excel, cells that a spreadsheet would evaluate
  // kept as text, and the download URL still valid after the click. All three download paths.
  ...(() => {
    const at = Date.UTC(2024, 0, 2, 12);
    const job = {
      id: 'csv-job', action: 'delete', account: { username: ME.screen }, startedAt: at - 60000, completedAt: at, durationMs: 60000,
      status: 'completed', statusText: 'Finished', total: 6, counts: { tweets: 1, replies: 1, unliked: 1, unreposted: 2, follows: 1, unfollows: 0 }
    };
    const backup = {
      tweets: [{ date: '2024-01-01T00:00:00.000Z', text: '=HYPERLINK("http://example.com","x")', author: 'me', url: 'https://x.com/me/status/1', action: 'deleted', actionAt: '2024-01-02T12:00:00.000Z' }],
      replies: [{ date: '2024-01-01T00:00:00.000Z', text: '@fulano obrigado pela atenção', author: 'me', url: 'https://x.com/me/status/2', action: 'deleted_reply', actionAt: '2024-01-02T12:00:00.000Z' }],
      unliked: [{ date: '2024-01-01T00:00:00.000Z', text: '+1 and -2\tminus', author: 'other', url: 'https://x.com/other/status/3', action: 'unliked', actionAt: '2024-01-02T12:00:00.000Z' }],
      unreposted: [{ date: '2024-01-01T00:00:00.000Z', text: '\tstarts with a tab', author: 'other', url: 'https://x.com/other/status/4', action: 'unreposted', actionAt: '2024-01-02T12:00:00.000Z' },
        { date: '2024-01-01T00:00:00.000Z', text: '\rstarts with a carriage return', author: 'other', url: 'https://x.com/other/status/5', action: 'unreposted', actionAt: '2024-01-02T12:00:00.000Z' }],
      follows: [{ username: 'fulano', displayName: '-dash name', profileUrl: 'https://x.com/fulano', action: 'followed', actionAt: '2024-01-02T12:00:00.000Z' }],
      unfollows: []
    };
    const seed = env => env.worker.evaluate(({ job, backup }) => chrome.storage.local.set({ jobHistory: [job], 'job_csv-job': { ...job, backup } }), { job, backup });
    // Clicks, saves the download, and reports whether the page revoked its URL within a second.
    const download = async (page, click) => {
      await page.evaluate(() => {
        window.__revoked = 0;
        const revoke = URL.revokeObjectURL.bind(URL);
        URL.revokeObjectURL = url => { window.__revoked++; revoke(url); };
      });
      const [file] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), click()]);
      const bytes = fs.readFileSync(await file.path());
      await new Promise(resolve => setTimeout(resolve, 1000));
      return { bytes, revokedEarly: await page.evaluate(() => window.__revoked > 0) };
    };
    const checks = ({ bytes, revokedEarly }) => {
      const text = bytes.toString('utf8');
      return [
        ['the file starts with one UTF-8 byte order mark', bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf && !text.slice(1).includes('\ufeff'), [...bytes.subarray(0, 6)]],
        ['a formula is kept as text', text.includes(`"'=HYPERLINK(""http://example.com"",""x"")"`), text],
        ['cells starting with @, +, - are kept as text, accents intact', text.includes("'@fulano obrigado pela atenção") && text.includes("'+1 and -2\tminus") && text.includes("'-dash name"), text],
        ['cells starting with a tab or a carriage return are kept as text', text.includes("'\tstarts with a tab") && text.includes(`"'\rstarts with a carriage return"`), text],
        ['ordinary cells are unchanged', text.includes(',https://x.com/me/status/1,') && !text.includes("'me") && !text.includes("'https"), text],
        ['the download URL is not revoked right after the click', !revokedEarly, revokedEarly]
      ];
    };
    return [
      {
        name: 'csv: history "Download all CSV" keeps formulas as text and has a BOM',
        state: { own: 0 },
        async run(env) {
          await seed(env);
          const page = await openExtensionPage(env.context, env.extensionId, 'history/history.html');
          await page.waitForFunction(() => !document.getElementById('downloadAll').disabled, null, { timeout: 10000 });
          const result = await download(page, () => page.click('#downloadAll'));
          await page.close();
          return checks(result);
        }
      },
      {
        name: 'csv: a history job download keeps formulas as text and has a BOM',
        state: { own: 0 },
        async run(env) {
          await seed(env);
          const page = await openExtensionPage(env.context, env.extensionId, 'history/history.html');
          await page.click('details.job summary', { timeout: 10000 });
          const button = page.locator('details.job button', { hasText: 'Download CSV' });
          await button.waitFor({ timeout: 10000 });
          const result = await download(page, () => button.click());
          await page.close();
          return checks(result);
        }
      },
      {
        name: 'csv: a popup job download keeps formulas as text and has a BOM',
        state: { own: 0 },
        async run(env) {
          await seed(env);
          const page = await openExtensionPage(env.context, env.extensionId, 'popup/popup.html');
          const button = page.locator('.history-icon-button.download').first();
          await button.waitFor({ timeout: 10000 });
          const result = await download(page, () => button.click());
          await page.close();
          return checks(result);
        }
      }
    ];
  })(),
  // Click mode counts an action only once X shows it took effect (VER-821): with X refusing in
  // silence, nothing is counted or backed up and each item is tried three times, then left.
  {
    name: 'click mode confirm: unliking by clicking counts each like once',
    state: { likes: 3 },
    setup: (state) => { state.dom = { likes: true }; },
    async run(env, state) {
      const r = await quickClean(env, 'unlike', { apiMode: false });
      const unlikes = state.calls.filter(c => c.op === 'dom-unlike');
      return [
        ['mode is dom', r.worker?.mode === 'dom', r.worker],
        ['each like removed once', unlikes.length === 3 && new Set(unlikes.map(c => c.id)).size === 3 && state.likes.length === 0, unlikes],
        ['history: 3 unliked with backup', r.job.counts.unliked === 3 && r.record.backup.unliked.length === 3, r.job.counts]
      ];
    }
  },
  {
    name: 'click mode confirm: bulk unfollow by clicking counts each account once',
    state: { following: 3 },
    setup: (state) => { state.dom = { users: true }; },
    async run(env, state) {
      const r = await quickClean(env, 'bulkUnfollow', { apiMode: false });
      const unfollows = state.calls.filter(c => c.op === 'dom-unfollow');
      return [
        ['mode is dom', r.worker?.mode === 'dom', r.worker],
        ['each account unfollowed once', unfollows.length === 3 && new Set(unfollows.map(c => c.id)).size === 3 && state.following.length === 0, unfollows],
        ['history: 3 unfollows with backup', r.job.counts.unfollows === 3 && r.record.backup.unfollows.length === 3, r.job.counts]
      ];
    }
  },
  // X slower than before: a follow shown 3.5 s later now counts within the wait (about 4 s, plus
  // the toast check), and one shown after the wait ended but before the list is read again (7 s)
  // is recorded then, without a second click.
  ...[{ ms: 3500, followers: 3 }, { ms: 7000, followers: 1 }].map(({ ms, followers }) => ({
    name: `click mode confirm: a follow X shows after ${ms} ms is counted once, without a second click`,
    state: { followers },
    setup: (state) => { state.dom = { users: true, slow: { follow: ms } }; },
    async run(env, state) {
      const r = await quickClean(env, 'followAll', { apiMode: false });
      const follows = state.calls.filter(c => c.op === 'dom-follow');
      return [
        ['mode is dom', r.worker?.mode === 'dom', r.worker],
        ['each account followed once', follows.length === followers && new Set(follows.map(c => c.id)).size === followers && state.followers.every(u => u.following), follows],
        ['history: every follow counted once, with backup', r.job.counts.follows === followers && r.record.backup.follows.length === followers, r.job.counts]
      ];
    }
  })),
  ...[
    { action: 'unlike', state: { likes: 3 }, dom: { likes: true, reject: { unlike: true } }, ids: state => state.likes.map(l => l.id), count: 'unliked' },
    { action: 'followAll', state: { followers: 3 }, dom: { users: true, reject: { follow: true } }, ids: state => state.followers.map(u => u.screen), count: 'follows' },
    { action: 'bulkUnfollow', state: { following: 3 }, dom: { users: true, reject: { unfollow: true } }, ids: state => state.following.map(u => u.screen), count: 'unfollows' }
  ].map(({ action, state: initial, dom, ids, count }) => ({
    name: `click mode confirm: ${action} that X refuses counts nothing and is tried three times`,
    state: initial,
    setup: (state) => { state.dom = dom; },
    async run(env, state) {
      const items = ids(state);
      const r = await quickClean(env, action, { apiMode: false });
      const refused = state.calls.filter(c => /-rejected$/.test(c.op));
      const tries = items.map(id => refused.filter(c => c.id === id).length);
      return [
        ['mode is dom', r.worker?.mode === 'dom', r.worker],
        ['nothing counted or backed up', r.job.total === 0 && r.job.counts[count] === 0 && Object.values(r.record.backup).every(rows => rows.length === 0), { counts: r.job.counts, total: r.job.total }],
        ['each item tried three times, then left', tries.every(n => n === 3), tries]
      ];
    }
  })),
  // Click mode stops for the right reason (VER-822): no main column is not the end of the list,
  // a changed page gets no more scrolling, the same page spelled differently is still the same
  // page, and the selected-deletion worker stops at X's login form like the popup does.
  {
    name: 'click mode stop: without a main column the job stops as interrupted, with the reason',
    state: { own: 3 },
    setup: (state) => { state.dom = { noPrimaryColumn: true }; },
    async run(env, state) {
      const r = await quickClean(env, 'delete', { apiMode: false });
      return [
        ['job interrupted with the reason', r.job.status === 'interrupted' && /main column was not found/.test(r.job.statusText), r.job.statusText],
        ['no click action', domActions(state).length === 0 && state.tweets.length === 3, domActions(state)]
      ];
    }
  },
  {
    name: 'preview stop: without a main column the scan stops unfinished, with the reason',
    state: { own: 3 },
    setup: (state) => { state.dom = { noPrimaryColumn: true }; },
    async run(env) {
      const panel = await startDomScan(env, 'tweets');
      const scan = await waitFor(async () => { const P = await readPreview(env); return P && !P.running && P; }, { timeout: 40000, label: 'scan to stop' });
      const label = await panel.waitForFunction(() => /main column was not found/.test(document.getElementById('scanState').textContent), null, { timeout: 5000 })
        .then(() => 'main column was not found', () => panel.evaluate(() => document.getElementById('scanState').textContent));
      await panel.close();
      return [
        ['scan stopped unfinished, with the reason', !scan.done && /main column was not found/.test(scan.issue || ''), scan],
        ['the panel says why', /main column was not found/.test(label), label]
      ];
    }
  },
  {
    name: 'preview stop: selected deletion without a main column stops as interrupted, with the reason',
    state: { own: 3 },
    async run(env, state) {
      const r = await previewAndAct(env, 'tweets', { apiMode: false, beforeAct: () => xPage(env).evaluate(() => document.querySelector('[data-testid="primaryColumn"]').removeAttribute('data-testid')) });
      return [
        ['job interrupted with the reason', r.job.status === 'interrupted' && /main column was not found/.test(r.job.statusText), r.job.statusText],
        ['no click action', domActions(state).length === 0 && state.tweets.length === 3, domActions(state)]
      ];
    }
  },
  {
    name: 'click mode stop: no scrolling on the page a stray click moved to',
    state: { own: 1 },
    setup: (state) => { state.dom = { navigateOnCaret: true, recordScroll: true }; },
    async run(env, state) {
      const r = await quickClean(env, 'delete', { apiMode: false });
      const scrolls = state.calls.filter(c => c.op === 'scroll' && c.path !== `/${ME.screen}`);
      return [
        ['job stopped because the page changed', r.job.status === 'interrupted' && /The page changed/.test(r.job.statusText), r.job.statusText],
        ['no scroll on the new page', scrolls.length === 0, scrolls],
        ['nothing deleted', domActions(state).length === 0 && state.tweets.length === 1, domActions(state)]
      ];
    }
  },
  {
    name: 'preview stop: selected deletion does not scroll the page a stray click moved to',
    state: { own: 1 },
    setup: (state) => { state.dom = { navigateOnCaret: true, recordScroll: true }; },
    async run(env, state) {
      const r = await previewAndAct(env, 'tweets', { apiMode: false });
      const scrolls = state.calls.filter(c => c.op === 'scroll' && c.path !== `/${ME.screen}`);
      return [
        ['job stopped because the page changed', r.job.status === 'interrupted' && /The page changed/.test(r.job.statusText), r.job.statusText],
        ['no scroll on the new page', scrolls.length === 0, scrolls],
        ['nothing deleted', domActions(state).length === 0 && state.tweets.length === 1, domActions(state)]
      ];
    }
  },
  {
    name: 'click mode stop: the same page with capitals, a trailing slash, query and hash keeps the job going',
    state: { own: 4 },
    setup: (state) => { state.dom = { renameAfter: 2 }; },
    async run(env, state) {
      const r = await quickClean(env, 'delete', { apiMode: false });
      return [
        ['job finished, not stopped', r.job.status === 'completed' && !/page changed/i.test(r.job.statusText), r.job.statusText],
        ['all 4 deleted', state.tweets.length === 0 && r.job.total === 4, { left: state.tweets.length, total: r.job.total }]
      ];
    }
  },
  {
    name: 'preview stop: selected deletion keeps going on the same page with capitals, a trailing slash, query and hash',
    state: { own: 4 },
    setup: (state) => { state.dom = { renameAfter: 2 }; },
    async run(env, state) {
      const r = await previewAndAct(env, 'tweets', { apiMode: false });
      return [
        ['job finished, not stopped', r.job.status === 'completed' && !/page changed/i.test(r.job.statusText), r.job.statusText],
        ['all 4 deleted', state.tweets.length === 0, state.tweets.length]
      ];
    }
  },
  {
    name: "preview stop: selected deletion stops at X's login form",
    state: { own: 6 },
    setup: (state) => { state.dom = { loginAfter: 2 }; },
    async run(env, state) {
      const r = await previewAndAct(env, 'tweets', { apiMode: false });
      const deletes = state.calls.filter(c => c.op === 'dom-delete');
      return [
        ['job interrupted: login required', r.job.status === 'interrupted' && /Login required/.test(r.job.statusText), r.job.statusText],
        ['no deletion after the login form', deletes.length === 2 && state.tweets.length === 4, deletes.length]
      ];
    }
  },
  // Click-mode loops do not hide failures (VER-823): a step that throws three times in a row stops
  // the job, or the scan, with the error as its reason; a good step in between resets the count.
  {
    name: 'click mode loop: three failing steps in a row stop Quick Clean with the error',
    state: { own: 4 },
    async run(env) {
      const [r] = await Promise.all([quickClean(env, 'delete', { apiMode: false }), failSteps(env, '__xCleaner', 3)]);
      const fault = await readFault(env);
      return [
        ['job interrupted with the error', r.job.status === 'interrupted' && /3 errors in a row: synthetic step failure/.test(r.job.statusText), r.job.statusText],
        ['stopped at the third failure', fault?.thrown === 3 && fault.left === 0, fault]
      ];
    }
  },
  {
    name: 'click mode loop: failing steps with a good step between them leave Quick Clean running',
    state: { own: 4 },
    async run(env, state) {
      const job = quickClean(env, 'delete', { apiMode: false });
      const first = await failSteps(env, '__xCleaner', 2);
      // Arm the next two only after a good step has run to its end.
      await waitFor(async () => { const f = await readFault(env); return f && f.left === 0 && f.passed > first.passed && !f.busy; }, { timeout: 30000, label: 'a good step' });
      await failSteps(env, '__xCleaner', 2);
      const r = await job;
      const fault = await readFault(env);
      return [
        ['job finished', r.job.status === 'completed', r.job.statusText],
        ['all 4 deleted', state.tweets.length === 0, state.tweets.length],
        ['four failures, never three in a row', fault?.thrown === 4, fault]
      ];
    }
  },
  {
    name: 'preview loop: three failing steps in a row stop the scan, unfinished, with the error',
    state: { own: 4 },
    async run(env) {
      const panel = await startDomScan(env, 'tweets');
      await failSteps(env, '__xbcPreview', 3);
      const scan = await waitFor(async () => { const P = await readPreview(env); return P && !P.running && P; }, { timeout: 40000, label: 'scan to stop' });
      const fault = await readFault(env);
      const label = await panel.waitForFunction(() => /errors in a row/.test(document.getElementById('scanState').textContent), null, { timeout: 5000 })
        .then(() => 'errors in a row', () => panel.evaluate(() => document.getElementById('scanState').textContent));
      await panel.close();
      return [
        ['scan stopped unfinished, with the error', !scan.done && /3 errors in a row: synthetic step failure/.test(scan.issue || ''), scan],
        ['the panel says why', /errors in a row/.test(label), label],
        ['stopped at the third failure', fault?.thrown === 3 && fault.left === 0, fault]
      ];
    }
  },
  {
    name: 'preview loop: failing steps with a good step between them leave the scan running',
    state: { own: 12 },
    async run(env) {
      const panel = await startDomScan(env, 'tweets');
      const first = await failSteps(env, '__xbcPreview', 2);
      await waitFor(async () => { const f = await readFault(env); return f && f.left === 0 && f.passed > first.passed && !f.busy; }, { timeout: 30000, label: 'a good step' });
      await failSteps(env, '__xbcPreview', 2);
      const scan = await waitFor(async () => { const P = await readPreview(env); return P && !P.running && P; }, { timeout: 60000, label: 'scan to end' });
      const fault = await readFault(env);
      await panel.close();
      return [
        ['scan complete', scan.done && scan.ids.length === 12, scan],
        ['four failures, never three in a row', fault?.thrown === 4, fault]
      ];
    }
  },
  {
    name: 'preview loop: failing steps with a good step between them leave selected deletion running',
    state: { own: 8 },
    async run(env, state) {
      const job = previewAndAct(env, 'tweets', { apiMode: false });
      const first = await failSteps(env, '__xCleaner', 2);
      // Arm the next two only after a good step has run to its end.
      await waitFor(async () => { const f = await readFault(env); return f && f.left === 0 && f.passed > first.passed && !f.busy; }, { timeout: 60000, label: 'a good step' });
      await failSteps(env, '__xCleaner', 2);
      const r = await job;
      const fault = await readFault(env);
      return [
        ['job finished', r.job.status === 'completed', r.job.statusText],
        ['all 8 deleted', state.tweets.length === 0, state.tweets.length],
        ['four failures, never three in a row', fault?.thrown === 4, fault]
      ];
    }
  },
  {
    name: 'preview loop: three failing steps in a row stop selected deletion with the error',
    state: { own: 4 },
    async run(env) {
      const [r] = await Promise.all([previewAndAct(env, 'tweets', { apiMode: false }), failSteps(env, '__xCleaner', 3)]);
      const fault = await readFault(env);
      return [
        ['job interrupted with the error', r.job.status === 'interrupted' && /3 errors in a row: synthetic step failure/.test(r.job.statusText), r.job.statusText],
        ['stopped at the third failure', fault?.thrown === 3 && fault.left === 0, fault]
      ];
    }
  },
  // "found" in click mode counts your own posts, not the reposts of others it skips (VER-824).
  {
    name: 'click mode found: reposts of others are skipped and not counted as found',
    state: { own: 3, retweets: 2 },
    async run(env, state) {
      const r = await quickClean(env, 'delete', { apiMode: false });
      return [
        ['mode is dom', r.worker?.mode === 'dom', r.worker],
        ['found counts your 3 posts only', r.worker?.stats.found === 3, r.worker?.stats],
        ['your posts deleted, the reposts untouched', r.worker?.stats.deleted === 3 && state.tweets.length === 2 && state.tweets.every(t => t.retweetOf), state.tweets.map(t => t.id)]
      ];
    }
  },
  // The Preview panel after the incident of 21/10 (VER-816): a scan the X tab lost is reported and
  // ends its session, a rate-limit wait is shown, "New scan" asks before clearing a review, and an
  // API scan is not stopped by moving to another page inside X.
  {
    name: 'preview lost: a reload during the scan brings the panel back to the setup, with the reason',
    state: { own: 12 },
    async run(env) {
      const panel = await startDomScan(env, 'tweets');
      await waitFor(async () => { const P = await readPreview(env); return P?.running && P.ids.length > 0; }, { timeout: 30000, label: 'scan under way' });
      await xPage(env).reload();
      const shown = await panel.waitForFunction(() => document.getElementById('setupSection').style.display === 'block' && /scan was lost/.test(document.getElementById('errorMessage').textContent), null, { timeout: 15000 }).then(() => true, () => false);
      const ui = await panel.evaluate(() => ({ setup: document.getElementById('setupSection').style.display, card: document.getElementById('scanCard').style.display, error: document.getElementById('errorMessage').textContent, state: document.getElementById('scanState').textContent }));
      const session = (await storage(env.worker, ['activePreviewSession'])).activePreviewSession || null;
      await panel.evaluate(() => document.getElementById('startScan').click());
      const restarted = await waitFor(async () => { const P = await readPreview(env); return P?.running && P; }, { timeout: 20000, label: 'new scan' }).catch(() => null);
      await panel.close();
      return [
        ['the panel says the scan was lost and shows the setup', shown, ui],
        ['the session is ended', session === null, session],
        ['a new scan starts', !!restarted, restarted]
      ];
    }
  },
  {
    name: 'preview lost: reopening the panel after the scan was lost says so and ends the session',
    state: { own: 12 },
    async run(env) {
      const panel = await startDomScan(env, 'tweets');
      await waitFor(async () => { const P = await readPreview(env); return P?.running && P.ids.length > 0; }, { timeout: 30000, label: 'scan under way' });
      await panel.close();
      await xPage(env).reload();
      const again = await openExtensionPage(env.context, env.extensionId, 'sidepanel/sidepanel.html');
      const said = await again.waitForFunction(() => /last scan was lost/.test(document.getElementById('errorMessage').textContent), null, { timeout: 10000 }).then(() => true, () => false);
      const error = await again.evaluate(() => document.getElementById('errorMessage').textContent);
      const session = (await storage(env.worker, ['activePreviewSession'])).activePreviewSession || null;
      await again.close();
      return [
        ['the panel says the last scan was lost', said, error],
        ['the session is ended', session === null, session]
      ];
    }
  },
  {
    name: 'preview lost: a session left by a tab without its scan does not block a new scan',
    state: { own: 3 },
    async run(env) {
      await env.worker.evaluate(() => chrome.storage.local.set({ activePreviewSession: { tabId: 987654321, type: 'tweets', startedAt: Date.now() } }));
      const panel = await startDomScan(env, 'tweets');
      const started = await waitFor(async () => { const P = await readPreview(env); return P?.running && P; }, { timeout: 20000, label: 'scan to start' }).catch(() => null);
      const error = await panel.evaluate(() => document.getElementById('errorMessage').textContent);
      await panel.close();
      return [
        ['the scan started', !!started, error],
        ['no other-session error', !/Another Preview/.test(error), error]
      ];
    }
  },
  {
    name: 'preview lost: a scan held by another tab still blocks a new one, and stops blocking once that tab reloads',
    state: { own: 12 },
    async run(env) {
      const xTabs = () => env.worker.evaluate(async () => (await chrome.tabs.query({ url: ['https://x.com/*'] })).map(t => t.id));
      const readIn = (tabId) => env.worker.evaluate(async (tabId) => {
        const [r] = await chrome.scripting.executeScript({ target: { tabId }, func: () => { const P = window.__xbcPreview; return P && { running: !!P.interval, done: !!P.done, n: P.items.length }; } });
        return r?.result;
      }, tabId);
      const panelA = await startDomScan(env, 'tweets');
      await waitFor(async () => { const P = await readPreview(env); return P && P.ids.length > 0; }, { timeout: 30000, label: 'scan in tab A' });
      const [tabA] = await xTabs();
      await (await env.context.newPage()).goto('https://x.com/home');
      const [, tabB] = await xTabs();
      // A second panel whose active tab is tab B.
      const panelB = await env.context.newPage();
      await panelB.addInitScript(() => {
        const query = chrome.tabs.query.bind(chrome.tabs);
        chrome.tabs.query = async (info) => {
          if (info?.active && info?.currentWindow) return (await query({ url: ['https://x.com/*', 'https://twitter.com/*'] })).slice(-1);
          return query(info);
        };
        window.close = () => {};
      });
      await panelB.goto(`chrome-extension://${env.extensionId}/sidepanel/sidepanel.html`);
      await panelB.waitForFunction(() => !document.getElementById('startScan').disabled, null, { timeout: 20000 });
      await panelB.evaluate(() => { const box = document.getElementById('previewApi'); if (box.checked) box.click(); document.getElementById('startScan').click(); });
      const blocked = await panelB.waitForFunction(() => /Another Preview/.test(document.getElementById('errorMessage').textContent), null, { timeout: 10000 }).then(() => true, () => false);
      const afterBlock = { session: (await storage(env.worker, ['activePreviewSession'])).activePreviewSession || null, a: await readIn(tabA), b: await readIn(tabB) };
      await panelA.close();
      await xPage(env).reload();
      await panelB.evaluate(() => document.getElementById('startScan').click());
      const startedB = await waitFor(async () => { const P = await readIn(tabB); return P && P; }, { timeout: 20000, label: 'scan in tab B' }).catch(() => null);
      const afterReload = { error: await panelB.evaluate(() => document.getElementById('errorMessage').textContent), session: (await storage(env.worker, ['activePreviewSession'])).activePreviewSession || null, b: startedB };
      await panelB.close();
      return [
        ["a live scan in tab A blocks tab B and keeps A's session", blocked && afterBlock.session?.tabId === tabA && !!afterBlock.a && !afterBlock.b, { blocked, afterBlock, tabA, tabB }],
        ['after tab A reloads, tab B starts and owns the session', !!startedB && afterReload.session?.tabId === tabB && !/Another Preview/.test(afterReload.error), { afterReload, tabA, tabB }]
      ];
    }
  },
  {
    name: 'preview lost: deleting from a paused review after moving inside X reports no lost scan',
    state: { own: 9, pageSize: 3 },
    async run(env, state) {
      await xPage(env).goto(`https://x.com/${ME.screen}`);
      await waitFor(() => state.calls.some(c => c.op === 'UserTweets'), { label: 'profile discovery GET' });
      const panel = await openExtensionPage(env.context, env.extensionId, 'sidepanel/sidepanel.html');
      await panel.waitForFunction(() => !document.getElementById('startScan').disabled);
      await panel.evaluate(() => { const box = document.getElementById('previewApi'); if (!box.checked) box.click(); });
      await panel.locator('#startScan').click();
      await waitFor(async () => { const P = await readPreview(env); return P?.running && P.ids.length > 0 && P; }, { timeout: 20000, label: 'first API page' });
      await panel.locator('#pauseScan').click();
      await panel.waitForFunction(() => document.getElementById('reviewSection').style.display === 'block' && !document.getElementById('deleteSelected').disabled, null, { timeout: 10000 });
      // Record every message the panel shows from here on.
      await panel.evaluate(() => { window.__seen = []; new MutationObserver(() => window.__seen.push(document.getElementById('errorMessage').textContent)).observe(document.getElementById('errorMessage'), { childList: true, characterData: true, subtree: true }); });
      // The deletion then reloads the profile page, which takes the paused scan away on purpose.
      await xPage(env).evaluate(() => history.pushState({}, '', '/explore'));
      const before = (await storage(env.worker, ['jobHistory'])).jobHistory?.length || 0;
      await panel.locator('#deleteSelected').click();
      await panel.waitForFunction(() => document.getElementById('deleteDialog')?.open, null, { timeout: 10000 });
      await panel.locator('#confirmDelete').click();
      const job = await waitFor(async () => { const h = (await storage(env.worker, ['jobHistory'])).jobHistory || []; return h.length > before && h[0]?.status !== 'running' ? h[0] : null; }, { timeout: 120000, label: 'selected job to finish' }).catch(() => null);
      await panel.waitForFunction(() => document.getElementById('stopScan').textContent === 'New scan', null, { timeout: 10000 }).catch(() => {});
      const ui = await panel.evaluate(() => ({ setup: document.getElementById('setupSection').style.display, card: document.getElementById('scanCard').style.display, error: document.getElementById('errorMessage').textContent, state: document.getElementById('scanState').textContent, seen: window.__seen }));
      await panel.locator('#stopScan').click();
      await panel.waitForFunction(() => document.getElementById('setupSection').style.display === 'block', null, { timeout: 5000 }).catch(() => {});
      const afterNew = await panel.evaluate(() => ({ setup: document.getElementById('setupSection').style.display, card: document.getElementById('scanCard').style.display, error: document.getElementById('errorMessage').textContent, dialog: !!document.getElementById('newScanDialog')?.open }));
      await panel.close();
      return [
        ['job finished', job?.status === 'completed', job && { status: job.status, statusText: job.statusText, total: job.total }],
        ['no "scan was lost" while or after deleting', !/scan was lost/.test(ui.error) && !(ui.seen || []).some(t => /scan was lost/.test(t)), ui],
        ['the setup is not shown with the job card', !(ui.setup === 'block' && ui.card === 'block'), ui],
        ['New scan after the job goes back to the setup, with no "scan was lost"', afterNew.setup === 'block' && !/scan was lost/.test(afterNew.error) && !afterNew.dialog, afterNew]
      ];
    }
  },
  {
    name: 'preview wait: an API scan waiting out a rate limit says when it resumes',
    state: { own: 3 },
    async run(env, state) {
      // Prime the profile first: its own discovery GET must not consume the worker fixture.
      await xPage(env).goto(`https://x.com/${ME.screen}`);
      await waitFor(() => state.calls.some(c => c.op === 'UserTweets'), { label: 'profile discovery GET' });
      state.misbehave.responses.UserTweets = [{ code: 88, resetSeconds: 8 }];
      const panel = await openExtensionPage(env.context, env.extensionId, 'sidepanel/sidepanel.html');
      await panel.waitForFunction(() => !document.getElementById('startScan').disabled);
      await panel.locator('#startScan').click();
      const shown = await panel.waitForFunction(() => /X rate limit · resuming at \d/.test(document.getElementById('scanState').textContent), null, { timeout: 8000 })
        .then(() => true, () => false);
      const during = await panel.evaluate(() => document.getElementById('scanState').textContent);
      await panel.waitForFunction(() => /Scan complete/.test(document.getElementById('scanState').textContent), null, { timeout: 60000 });
      const scan = await readPreview(env);
      await panel.close();
      return [
        ['the wait and its end time are shown', shown, during],
        ['the scan resumed and finished by API', scan?.mode === 'api' && scan.done && scan.ids.length === 3, scan]
      ];
    }
  },
  {
    name: 'preview new scan: a review on screen is cleared only after you confirm',
    state: { own: 3 },
    async run(env) {
      const panel = await startDomScan(env, 'tweets');
      await panel.waitForFunction(() => /Scan complete/.test(document.getElementById('scanState').textContent) && document.getElementById('reviewSection').style.display === 'block', null, { timeout: 60000 });
      await panel.locator('#stopScan').click();
      const asked = await panel.waitForFunction(() => document.getElementById('newScanDialog')?.open, null, { timeout: 5000 }).then(() => true, () => false);
      const shownAfterAsk = await panel.evaluate(() => ({ review: document.getElementById('reviewSection').style.display, items: previewItems.length }));
      let afterCancel = null, afterConfirm = null;
      if (asked) {
        await panel.locator('#cancelNewScan').click();
        afterCancel = { review: await panel.evaluate(() => document.getElementById('reviewSection').style.display), scan: !!(await readPreview(env)) };
        await panel.locator('#stopScan').click();
        await panel.locator('#confirmNewScan').click();
        await panel.waitForFunction(() => document.getElementById('setupSection').style.display === 'block', null, { timeout: 5000 });
        afterConfirm = { setup: true, scan: await readPreview(env), session: (await storage(env.worker, ['activePreviewSession'])).activePreviewSession || null };
      }
      await panel.close();
      return [
        ['New scan asks first and keeps the list', asked && shownAfterAsk.review === 'block' && shownAfterAsk.items === 3, { asked, shownAfterAsk }],
        ['Keep the list leaves the review and the scan', afterCancel?.review === 'block' && afterCancel.scan, afterCancel],
        ['Clear the list resets the scan and ends the session', afterConfirm?.setup && afterConfirm.scan === null && afterConfirm.session === null, afterConfirm]
      ];
    }
  },
  {
    name: 'preview api: moving to another page inside X does not stop an API scan',
    state: { own: 9, pageSize: 3 },
    async run(env, state) {
      await xPage(env).goto(`https://x.com/${ME.screen}`);
      await waitFor(() => state.calls.some(c => c.op === 'UserTweets'), { label: 'profile discovery GET' });
      const panel = await openExtensionPage(env.context, env.extensionId, 'sidepanel/sidepanel.html');
      await panel.waitForFunction(() => !document.getElementById('startScan').disabled);
      await panel.locator('#startScan').click();
      const during = await waitFor(async () => { const P = await readPreview(env); return P?.running && P.ids.length > 0 && P; }, { timeout: 20000, label: 'first API page' });
      await xPage(env).evaluate(() => history.pushState({}, '', '/explore'));
      await panel.waitForFunction(() => /Scan complete/.test(document.getElementById('scanState').textContent), null, { timeout: 60000 });
      const scan = await readPreview(env);
      await panel.close();
      return [
        ['moved while the API scan was running', during.mode === 'api' && during.ids.length < 9, during],
        ['the scan finished with every post', scan?.mode === 'api' && scan.done && scan.ids.length === 9, scan]
      ];
    }
  },
  {
    name: 'replies api 404: a scan that starts before the page asks for its replies waits and uses the page id',
    state: { own: 2, replies: 5, pageSize: 3 },
    setup: rotatedReplies({ delay: 2500 }),
    async run(env, state) {
      await seedBundle(env, state, { omit: ['UserTweetsAndReplies'] });
      const r = await scanRepliesByApi(env, state);
      const requests = repliesRequests(state);
      return [
        ['the scan does not end with the reported HTTP 404', r.scan?.issue !== REPORTED_404, r.scan?.issue],
        ['the scan completes with every reply', r.scan?.mode === 'api' && r.scan.done && r.scan.issue === 'Scan complete' && r.scan.replies === 5 && r.scan.items === 5, r.scan],
        ['the id is reported, and cached, as taken from the page', r.scan?.source === 'page' && r.cached?.source === 'page' && r.cached.id === 'rotated', { source: r.scan?.source, cached: r.cached }],
        ['no request ever carries the fallback id', requests.length > 1 && requests.every(c => c.id !== 'fallback'), requests],
        ["the extension asked only after the page's own request", requests.some(c => c.fromPage) && requests.filter(c => !c.fromPage).every(c => c.at >= requests.find(p => p.fromPage).at), requests]
      ];
    }
  },
  {
    name: 'replies api 404: with the id in the bundle the scan does not wait for the page',
    state: { own: 2, replies: 5, pageSize: 3 },
    setup: rotatedReplies({ delay: 2500 }),
    async run(env, state) {
      await seedBundle(env, state);
      const r = await scanRepliesByApi(env, state);
      await waitFor(() => state.calls.some(c => c.op === 'UserTweetsAndReplies' && c.fromPage), { timeout: 15000, label: "the page's own delayed request" }).catch(() => null);
      const requests = repliesRequests(state);
      const first = requests.find(c => !c.fromPage), page = requests.find(c => c.fromPage);
      return [
        ['the scan completes with every reply', r.scan?.mode === 'api' && r.scan.done && r.scan.issue === 'Scan complete' && r.scan.replies === 5, r.scan],
        ['the id came from the bundle', r.scan?.source === 'bundle', r.scan?.source],
        ["the extension's first request went before the page's delayed one", !!first && !!page && first.at < page.at, requests],
        ['no request ever carries the fallback id', requests.every(c => c.id !== 'fallback'), requests]
      ];
    }
  },
  {
    name: 'replies api 404: when the page never asks, the scan stops naming the operation, the status and the id source',
    state: { own: 2, replies: 5, pageSize: 3 },
    setup: rotatedReplies({ skip: true }),
    async run(env, state) {
      await seedBundle(env, state, { omit: ['UserTweetsAndReplies'] });
      const tweets = state.tweets.length;
      const r = await scanRepliesByApi(env, state);
      const requests = repliesRequests(state);
      const sent = requests.filter(c => !c.fromPage);
      const waited = sent[0] && r.scan ? sent[0].at - r.scan.startedAt : null;
      return [
        ['the scan ends naming UserTweetsAndReplies, HTTP 404 and the fallback id', r.scan?.issue === 'Scan interrupted after 0 items: X did not accept the request for UserTweetsAndReplies (HTTP 404, id source: fallback). Start a new scan to try the API again, or turn off API mode to scan by clicking.', r.scan?.issue],
        ['it waited about 8 s for the page, no longer', waited >= 7900 && waited <= 9500, { waited, seconds: r.seconds }],
        ['one request, with the fallback id; the page sent none', sent.length === 1 && sent[0].id === 'fallback' && sent.length === requests.length, requests],
        ['no click scan and no deletion', r.scan?.mode === 'api' && !r.scan.done && !r.scan.running && !state.calls.some(c => /^dom-/.test(c.op || '') || c.method === 'POST') && state.tweets.length === tweets, { mode: r.scan?.mode, done: r.scan?.done, tweets: state.tweets.length }],
        ['no fallback-sourced UserTweetsAndReplies cached', !r.cached || (r.cached.source !== 'fallback' && r.cached.id !== 'fallback'), r.cached]
      ];
    }
  },
  {
    name: 'speed: the setting persists between popup openings and the side panel shows the same value',
    state: { own: 0 },
    async run(env) {
      const stored = async () => (await storage(env.worker, ['apiPace'])).apiPace;
      await env.worker.evaluate(() => chrome.storage.local.remove(['apiPace']));
      const fresh = await openSpeed(env, 'popup/popup.html');
      await fresh.page.selectOption('#apiPace', '2');
      const savedCareful = await waitFor(async () => (await stored()) === 2, { timeout: 5000, label: 'Careful saved' }).then(() => true, () => false);
      await fresh.page.close();
      const reopened = await openSpeed(env, 'popup/popup.html');
      await reopened.page.close();
      const panel = await openSpeed(env, 'sidepanel/sidepanel.html');
      // With both open, a change in one shows in the other.
      const popup = await openSpeed(env, 'popup/popup.html');
      await panel.page.selectOption('#previewSpeed', '1');
      const savedNormal = await waitFor(async () => (await stored()) === 1, { timeout: 5000, label: 'Normal saved' }).then(() => true, () => false);
      const popupFollowed = await popup.page.waitForFunction(() => document.getElementById('apiPace').value === '1', null, { timeout: 5000 }).then(() => true, () => false);
      await popup.page.selectOption('#apiPace', '2');
      const panelFollowed = await panel.page.waitForFunction(() => document.getElementById('previewSpeed').value === '2', null, { timeout: 5000 }).then(() => true, () => false);
      await panel.page.close(); await popup.page.close();
      // Values written by hand: shown as Normal, left as they are (the worker floors them at 1).
      const handWritten = [];
      for (const value of [0.6, 3, 'fast']) {
        await setSpeed(env, value);
        const inPopup = await openSpeed(env, 'popup/popup.html'), inPanel = await openSpeed(env, 'sidepanel/sidepanel.html');
        handWritten.push({ value, popup: inPopup.shown.value, panel: inPanel.shown.value, stored: await stored() });
        await inPopup.page.close(); await inPanel.page.close();
      }
      const notes = [fresh.shown.note, panel.shown.note];
      return [
        ['a missing setting shows Normal', fresh.shown.value === '1', fresh.shown],
        ['only Normal and Careful, no Fast, in both views', [fresh.shown, panel.shown].every(v => JSON.stringify(v.options) === '["1 Normal","2 Careful"]'), [fresh.shown.options, panel.shown.options]],
        ['the note says X publishes no limit and what Careful does, with no promise of safety', notes.every(n => /X publishes no limit for deleting/.test(n) && /Careful waits twice as long/.test(n) && !/\bsafe/i.test(n)), notes],
        ['choosing Careful in the popup saves apiPace 2', savedCareful],
        ['a reopened popup shows Careful', reopened.shown.value === '2', reopened.shown.value],
        ['the side panel shows the same Careful', panel.shown.value === '2', panel.shown.value],
        ['Normal chosen in the side panel saves apiPace 1 and shows in the open popup', savedNormal && popupFollowed, { savedNormal, popupFollowed }],
        ['a choice in the popup shows in the open side panel', panelFollowed],
        ['hand-written values show as Normal and stay as stored', handWritten.every(h => h.popup === '1' && h.panel === '1' && h.stored === h.value), handWritten]
      ];
    }
  },
  {
    name: 'speed: the control is disabled while a scan or a job runs, and enabled again after',
    state: { own: 4, pageSize: 1 },
    async run(env, state) {
      const seeded = await seedSpeedBundle(env, state);
      const panel = await openSpeed(env, 'sidepanel/sidepanel.html');
      await scanPostsByApi(panel.page);
      await panel.page.waitForFunction(() => document.getElementById('setupSection').style.display === 'none', null, { timeout: 20000 });
      const duringScan = { disabled: await panel.page.evaluate(() => document.getElementById('previewSpeed').disabled), running: (await readPreview(env))?.running };
      await panel.page.waitForFunction(() => /Scan complete/.test(document.getElementById('scanState').textContent), null, { timeout: 60000 });
      const afterScan = await panel.page.evaluate(() => document.getElementById('previewSpeed').disabled);
      await panel.page.evaluate(() => document.getElementById('stopScan').click());
      await panel.page.waitForFunction(() => document.getElementById('newScanDialog').open, null, { timeout: 10000 });
      await panel.page.evaluate(() => document.getElementById('confirmNewScan').click());
      const backToSetup = await panel.page.waitForFunction(() => document.getElementById('setupSection').style.display !== 'none' && !document.getElementById('previewSpeed').disabled, null, { timeout: 10000 }).then(() => true, () => false);
      await panel.page.close();
      const before = (await storage(env.worker, ['jobHistory'])).jobHistory?.length || 0;
      const popup = await openSpeed(env, 'popup/popup.html');
      await startQuickDelete(env, popup.page);
      await waitFor(() => state.calls.some(c => c.op === 'DeleteTweet'), { timeout: 30000, interval: 50, label: 'first DeleteTweet' });
      const duringJob = await popup.page.evaluate(() => ({ disabled: document.getElementById('apiPace').disabled, running: document.body.dataset.running }));
      const job = await waitFor(() => latestJob(env, before), { timeout: 60000, label: 'delete job to finish' });
      const afterJob = await popup.page.waitForFunction(() => !document.getElementById('apiPace').disabled, null, { timeout: 10000 }).then(() => true, () => false);
      await popup.page.close();
      return [
        ['disabled while the side panel scan runs', duringScan.disabled === true && duringScan.running === true, duringScan],
        ['still disabled while the review is on screen', afterScan === true],
        ['enabled again once the panel is back at the setup', backToSetup],
        ['disabled in the popup while the job runs', duringJob.disabled === true && duringJob.running === 'true', duringJob],
        ['the job deleted the 4 posts by API', job.status === 'completed' && job.total === 4 && state.tweets.length === 0, { status: job.status, total: job.total }],
        ['enabled again in the popup once the job is over', afterJob],
        ['the web bundle came from the seeded cache, not from X', await bundleKept(env, seeded)]
      ];
    }
  },
  {
    name: 'speed: selected deletion by API finishes right after its last item, with no extra pace',
    state: { own: 3 },
    async run(env, state) {
      const seeded = await seedSpeedBundle(env, state);
      await setSpeed(env, 2); // Careful: a pace after the last item would add 5 s or more
      await recordSleeps(env);
      const r = await previewAndAct(env, 'tweets');
      const deletes = state.calls.filter(c => c.op === 'DeleteTweet');
      const last = deletes.at(-1)?.at;
      const gaps = deletes.slice(1).map((c, i) => c.at - deletes[i].at);
      const after = (await recordedSleeps(env)).filter(s => s.at >= last).map(s => s.ms);
      return [
        ['the 3 posts deleted by API', r.worker?.mode === 'api' && deletes.length === 3 && state.tweets.length === 0 && r.job.status === 'completed', { mode: r.worker?.mode, deletes: deletes.length, status: r.job.status }],
        ['a Careful pace of 5 s or more between deletions', gaps.length === 2 && gaps.every(g => g >= 5000), gaps],
        ['finished within 2 s of its last DeleteTweet', r.job.completedAt - last < 2000, r.job.completedAt - last],
        ['no sleep asked after its last DeleteTweet', after.length === 0, after],
        ['the web bundle came from the seeded cache, not from X', await bundleKept(env, seeded)]
      ];
    }
  },
  ...[
    { flow: 'Quick Clean', popup: true },
    { flow: 'selected deletion', popup: false }
  ].map(({ flow, popup: fromPopup }) => ({
    name: `speed: Stop during a Careful pace stops ${flow} promptly, with no further DeleteTweet`,
    state: { own: 3 },
    async run(env, state) {
      const seeded = await seedSpeedBundle(env, state);
      await setSpeed(env, 2);
      const before = (await storage(env.worker, ['jobHistory'])).jobHistory?.length || 0;
      let page, r;
      if (fromPopup) {
        page = await openExtensionPage(env.context, env.extensionId, 'popup/popup.html');
        await recordSleeps(env);
        await startQuickDelete(env, page);
        r = await stopDuringPace(env, state, before, () => page.evaluate(() => document.getElementById('stopAction').click()));
      } else {
        page = await openExtensionPage(env.context, env.extensionId, 'sidepanel/sidepanel.html');
        await scanPostsByApi(page);
        await page.waitForFunction(() => /Scan complete/.test(document.getElementById('scanState').textContent) && !document.getElementById('deleteSelected').disabled, null, { timeout: 60000 });
        await recordSleeps(env);
        await page.evaluate(() => document.getElementById('deleteSelected').click());
        await page.waitForFunction(() => document.getElementById('deleteDialog')?.open, null, { timeout: 10000 });
        await page.evaluate(() => document.getElementById('confirmDelete').click());
        r = await stopDuringPace(env, state, before, () => page.evaluate(() => document.getElementById('stopScan').click()));
      }
      await page.close();
      return [
        ['Stop pressed during the pace after the first DeleteTweet', r.deletesAtStop === 1, r.deletesAtStop],
        ['the job record says stopped, with the 1 deletion', r.job.status === 'stopped' && r.job.total === 1, { status: r.job.status, total: r.job.total }],
        ['no DeleteTweet and no other request after Stop', r.deletes === 1 && r.laterRequests.length === 0, { deletes: r.deletes, later: r.laterRequests }],
        ['the pace was taken in steps of at most 1 s', r.steps.length > 0 && r.steps.every(ms => ms <= 1000), r.steps],
        ['the pace ended within about 1 s of Stop', r.lingered !== null && r.lingered <= 1300, r.lingered],
        ['the other 2 posts are untouched', state.tweets.length === 2, state.tweets.length],
        ['the web bundle came from the seeded cache, not from X', await bundleKept(env, seeded)]
      ];
    }
  })),
  // "Delete all posts" by date (VER-636): only posts strictly older than the cutoff are deleted,
  // in API mode and in click mode; a post whose date cannot be read is never deleted; an
  // incomplete choice starts nothing. API scenarios seed the web bundle cache.
  {
    name: 'date filter: API mode deletes only posts before the date, and the dialog names the range',
    state: { own: 6 },
    setup: state => datePosts(state, ['2019-03-01T12:00:00Z', '2020-06-15T12:00:00Z', '2021-09-30T12:00:00Z', '2025-02-01T12:00:00Z', '2026-05-20T12:00:00Z', 'not a date']),
    async run(env, state) {
      const seeded = await seedSpeedBundle(env, state);
      const [old, newer, undated] = [state.tweets.slice(0, 3), state.tweets.slice(3, 5), state.tweets.slice(5)];
      const r = await deleteByDate(env, { mode: 'before', date: '2024-01-01' });
      const deleted = state.calls.filter(c => c.op === 'DeleteTweet').map(c => c.body.variables.tweet_id).sort().join(',');
      const history = await openExtensionPage(env.context, env.extensionId, 'history/history.html');
      await history.click('details.job summary', { timeout: 10000 });
      const facts = await history.locator('.job-facts').textContent({ timeout: 10000 });
      await history.close();
      return [
        ['with All posts the dialog is unchanged', r.allPosts.scopeShown && r.allPosts.choice === 'all' && r.allPosts.title === 'Delete all your posts?' && r.allPosts.description === ALL_POSTS && r.allPosts.button === 'Delete all posts', r.allPosts],
        ['the dialog names the range in plain words', r.chosen.description.startsWith('Only posts before 1 Jan 2024 will be deleted.') && r.chosen.title === 'Delete your older posts?' && r.chosen.button === 'Delete older posts', r.chosen],
        ['only the 3 older posts were deleted, by API', r.worker?.mode === 'api' && deleted === ids(old), deleted],
        ['the newer posts and the one without a readable date are untouched', ids(state.tweets) === ids([...newer, ...undated]), ids(state.tweets)],
        ['found and deleted count only the posts in the range', r.worker?.stats.found === 3 && r.worker?.stats.deleted === 3, r.worker?.stats],
        ['history: completed with 3 records, naming what was kept', r.job.status === 'completed' && r.job.total === 3 && /2 newer posts kept, 1 without a readable date skipped/.test(r.job.statusText), { status: r.job.status, total: r.job.total, text: r.job.statusText }],
        ['the job records the filter: before local midnight of the date', r.job.dateFilter?.mode === 'before' && r.job.dateFilter.date === '2024-01-01' && r.job.dateFilter.before === r.localMidnight && r.job.dateFilter.kept === 2 && r.job.dateFilter.unreadable === 1, r.job.dateFilter],
        ['the history entry shows the range', /Date range: Only posts before 1 Jan 2024/.test(facts) && /Newer posts kept: 2/.test(facts) && /Skipped, no readable date: 1/.test(facts), facts],
        ['the web bundle came from the seeded cache, not from X', await bundleKept(env, seeded)]
      ];
    }
  },
  {
    name: 'date filter: click mode deletes only posts before the date, and never one without a readable date',
    state: { own: 7 },
    setup: state => {
      datePosts(state, ['2019-03-01T12:00:00Z', '2020-06-15T12:00:00Z', '2021-09-30T12:00:00Z', '2025-02-01T12:00:00Z', '2026-05-20T12:00:00Z', '2018-01-10T12:00:00Z', 'not a date']);
      state.tweets[5].timeless = true; // dated 2018, but the page draws no time for it
    },
    async run(env, state) {
      const [old, kept] = [state.tweets.slice(0, 3), state.tweets.slice(3)];
      const r = await deleteByDate(env, { apiMode: false, mode: 'before', date: '2024-01-01' });
      const clicked = state.calls.filter(c => c.op === 'dom-delete').map(c => c.id).sort().join(',');
      return [
        ['the dialog names the range', r.chosen.description.startsWith('Only posts before 1 Jan 2024 will be deleted.'), r.chosen.description],
        ['only the 3 older posts were deleted, by clicking', r.worker?.mode === 'dom' && clicked === ids(old) && !state.calls.some(c => c.op === 'DeleteTweet'), clicked],
        ['newer posts, the post without a time and the one with an unreadable time are untouched', ids(state.tweets) === ids(kept), ids(state.tweets)],
        ['found and deleted count only the posts in the range', r.worker?.stats.found === 3 && r.worker?.stats.deleted === 3, r.worker?.stats],
        ['history: completed with 3 records', r.job.status === 'completed' && r.job.total === 3, { status: r.job.status, total: r.job.total, text: r.job.statusText }],
        ['the job records the filter and what it left', r.job.dateFilter?.mode === 'before' && r.job.dateFilter.kept === 2 && r.job.dateFilter.unreadable === 2, r.job.dateFilter]
      ];
    }
  },
  {
    name: 'date filter: keep the last N days deletes only older posts',
    state: { own: 4 },
    setup: state => datePosts(state, [Date.now() - 2 * DAY_MS, Date.now() - 5 * DAY_MS, Date.now() - 20 * DAY_MS, Date.now() - 400 * DAY_MS]),
    async run(env, state) {
      const seeded = await seedSpeedBundle(env, state);
      const [recent, old] = [state.tweets.slice(0, 2), state.tweets.slice(2)];
      const r = await deleteByDate(env, { mode: 'days', days: 10 });
      const deleted = state.calls.filter(c => c.op === 'DeleteTweet').map(c => c.body.variables.tweet_id).sort().join(',');
      const cutoff = Date.parse(r.job.dateFilter?.before);
      return [
        ['the dialog names the range in plain words', r.chosen.description.startsWith('Only posts older than 10 days will be deleted. Posts from the last 10 days stay on your profile.'), r.chosen.description],
        ['only the 2 posts older than 10 days were deleted', r.worker?.mode === 'api' && deleted === ids(old), deleted],
        ['the 2 recent posts are untouched', ids(state.tweets) === ids(recent), ids(state.tweets)],
        ['found and deleted count only the older posts', r.worker?.stats.found === 2 && r.worker?.stats.deleted === 2, r.worker?.stats],
        ['the cutoff is the start time minus 10 days', r.job.dateFilter?.mode === 'days' && r.job.dateFilter.days === 10 && Math.abs(cutoff - (r.clickedAt - 10 * DAY_MS)) < 60000, r.job.dateFilter],
        ['history: completed with 2 records', r.job.status === 'completed' && r.job.total === 2 && r.job.dateFilter.kept === 2, { status: r.job.status, total: r.job.total }],
        ['the web bundle came from the seeded cache, not from X', await bundleKept(env, seeded)]
      ];
    }
  },
  {
    name: 'date filter: an incomplete choice blocks the start and never falls back to all posts',
    state: { own: 3 },
    async run(env, state) {
      const seeded = await seedSpeedBundle(env, state);
      const { popup } = await openDeleteByDate(env, { mode: 'before' });
      const attempts = [];
      const attempt = async (label, choose) => {
        await choose();
        await popup.locator('#confirmStart').click();
        await popup.waitForTimeout(300);
        attempts.push({ label, ...(await readConfirm(popup)) });
      };
      await attempt('no date', async () => {});
      for (const days of ['', '0', '3651', '2.5']) await attempt(`${days || 'no'} days`, async () => { await popup.locator('#dateScopeKeep').check(); await popup.locator('#dateScopeDays').fill(days); });
      await popup.waitForTimeout(1500);
      const started = { activeAction: (await storage(env.worker, ['activeAction'])).activeAction || null, history: (await storage(env.worker, ['jobHistory'])).jobHistory?.length || 0, job: await xTabHasJob(env) };
      await popup.close();
      const [noDate, ...badDays] = attempts;
      return [
        ['each attempt kept the dialog open on its date choice, with a message', attempts.every(a => a.open && a.choice !== 'all' && a.error), attempts],
        ['without a date it asks for one', noDate.choice === 'before' && noDate.error === 'Choose a date first. Nothing was started.', noDate],
        ['an empty, zero, too large or fractional number of days asks for 1 to 3650', badDays.every(a => a.choice === 'days' && a.error === 'Enter a number of days from 1 to 3650. Nothing was started.'), badDays],
        ['no job started', !started.activeAction && started.history === 0 && !started.job, started],
        ['nothing listed, deleted or clicked', state.tweets.length === 3 && !state.calls.some(c => c.op === 'UserTweets' || c.method === 'POST' || c.method === 'DOM'), state.calls.map(c => c.op || c.path)],
        ['the web bundle came from the seeded cache, not from X', await bundleKept(env, seeded)]
      ];
    }
  },
  // Export of the selection before deleting (VER-636): the selected rows only, with the columns of
  // the history CSV, a byte order mark and formulas kept as text; nothing deleted, selection kept.
  {
    name: 'export selection: downloads exactly the selected rows as CSV and deletes nothing',
    state: { own: 4 },
    setup: state => { state.tweets[0].text = '=HYPERLINK("http://example.com","x")'; },
    async run(env, state) {
      const seeded = await seedSpeedBundle(env, state);
      const panel = await openExtensionPage(env.context, env.extensionId, 'sidepanel/sidepanel.html');
      await scanPostsByApi(panel);
      await panel.waitForFunction(() => /Scan complete/.test(document.getElementById('scanState').textContent) && !document.getElementById('deleteSelected').disabled, null, { timeout: 60000 });
      const enabled = () => panel.evaluate(() => !document.getElementById('exportSelection').disabled);
      const allSelected = await enabled();
      await panel.locator('#selectNone').click();
      const noneSelected = await enabled();
      await panel.locator('#selectAll').click();
      const unselected = state.tweets[2].id;
      await panel.locator(`.result[data-id="${unselected}"] input`).uncheck();
      await panel.waitForFunction(() => document.getElementById('selectedCount').textContent === '3 selected', null, { timeout: 5000 });
      const selection = async () => ({
        panel: await panel.evaluate(() => document.getElementById('selectedCount').textContent),
        tab: await env.worker.evaluate(async () => {
          const [tab] = await chrome.tabs.query({ url: ['https://x.com/*'] });
          const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.__xbcPreview.items.map(i => `${i.id}:${i.selected}`).join(',') });
          return r?.result;
        })
      });
      await waitFor(async () => (await selection()).tab?.includes(`${unselected}:false`), { timeout: 5000, label: 'selection saved in the tab' });
      const before = await selection();
      const callsBefore = state.calls.length;
      const [file] = await Promise.all([panel.waitForEvent('download', { timeout: 10000 }), panel.locator('#exportSelection').click()]);
      const bytes = fs.readFileSync(await file.path());
      await panel.waitForTimeout(1000);
      const after = await selection();
      const dialogOpen = await panel.evaluate(() => document.getElementById('deleteDialog').open);
      await panel.close();
      const text = bytes.toString('utf8').replace(/^﻿/, '');
      const [header, ...rows] = text.split('\n');
      const rowIds = rows.map(row => row.match(/\/status\/(\d+),/)?.[1]).join(',');
      const expected = state.tweets.filter(t => t.id !== unselected);
      return [
        ['the button is enabled with a selection and disabled without one', allSelected && !noneSelected, { allSelected, noneSelected }],
        ['the file name says it is the selection', /^postscrub_selection_tweets_\d{4}-\d{2}-\d{2}\.csv$/.test(file.suggestedFilename()), file.suggestedFilename()],
        ['the file starts with one UTF-8 byte order mark', bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf && !text.includes('﻿'), [...bytes.subarray(0, 6)]],
        ['the columns are those of the history CSV', header === 'Type,Date,Content,Author/Username,Display Name,URL,Action,Action Date', header],
        ['exactly the 3 selected posts, in order, and not the unselected one', rows.length === 3 && rowIds === expected.map(t => t.id).join(','), rows],
        ['each row has its type, date, author, link and the action "selected"', rows.every((row, i) => row.startsWith(`Post,${new Date(expected[i].created).toISOString()},`) && row.includes(`,me,,https://x.com/me/status/${expected[i].id},selected,`)), rows],
        ['a formula is kept as text', rows[0].includes(`"'=HYPERLINK(""http://example.com"",""x"")"`), rows[0]],
        ['the selection is unchanged, in the panel and in the tab', JSON.stringify(after) === JSON.stringify(before) && before.panel === '3 selected', { before, after }],
        ['nothing deleted and no request to X', state.tweets.length === 4 && state.calls.length === callsBefore && !dialogOpen, { posts: state.tweets.length, calls: state.calls.slice(callsBefore).map(c => c.op || c.path), dialogOpen }],
        ['no job started', !(await storage(env.worker, ['activeAction'])).activeAction && !((await storage(env.worker, ['jobHistory'])).jobHistory || []).length],
        ['the web bundle came from the seeded cache, not from X', await bundleKept(env, seeded)]
      ];
    }
  },
  ...(await import('./checkpoint.mjs')).checkpointScenarios()
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
