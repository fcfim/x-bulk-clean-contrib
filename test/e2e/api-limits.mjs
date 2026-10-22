// Real client and scan worker with synthetic transport, clock, storage and DOM.
// No network implementation is installed. Run through run.mjs --api-limits.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const apiSource = fs.readFileSync(new URL('../../src/worker/xapi.js', import.meta.url), 'utf8');
const popupSource = fs.readFileSync(new URL('../../src/popup/popup.js', import.meta.url), 'utf8');
let syntheticUuid = 0;
const panelSource = fs.readFileSync(new URL('../../src/sidepanel/sidepanel.js', import.meta.url), 'utf8');
const START = 1800000000000;
const clone = value => JSON.parse(JSON.stringify(value));
const ok = { status: 200, body: { data: { delete_tweet: 'Done' } } };
const rate = (headers = {}, code = 88, status = 429) => ({ status, headers, body: { errors: [{ code, message: 'synthetic restriction' }] } });
const reset = seconds => ({ 'x-rate-limit-reset': String(START / 1000 + seconds) });
const timeline = cursor => ({ data: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [
  { content: { itemContent: { tweet_results: { result: { __typename: 'Tweet', rest_id: cursor || 'last', legacy: { full_text: 'synthetic', user_id_str: '42' } } } } } },
  ...(cursor ? [{ content: { cursorType: 'Bottom', value: cursor } }] : [])
] }, ...(!cursor ? [{ type: 'TimelineTerminateTimeline', direction: 'Bottom' }] : [])] } } });

// capture: the operations the page itself requested ({ Operation: { queryId } }); bundle: the
// operations of a loaded main.js ({ ops: { Operation: { queryId } } }), absent by default.
export async function harness(responses, { store = {}, clock = { now: START }, account = '42', queryId = 'synthetic-id', capture, bundle, onSleep, failGet = false, failSet = false, onGet, beforeSet, afterSet, requestBudget = 50 } = {}) {
  const calls = [], sleeps = [];
  let responseIndex = 0, initialized = false;
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const schedule = (fn, ms = 0) => { sleeps.push(ms); clock.now += Math.max(0, ms); onSleep?.(ms); queueMicrotask(fn); return 1; };
  const runtime = { sendMessage(message, callback) { if (message.type === 'xbc:sleep') { callback?.(); return; } return Promise.resolve(message.type === 'xbc:bundleOps' && bundle ? { ok: true, ...clone(bundle) } : { ok: false }); } };
  const math = Object.create(Math); math.random = () => 0;
  const context = vm.createContext({ URL, URLSearchParams, Date: ClockDate, Math: math, console, setTimeout: schedule, crypto: { randomUUID: () => `synthetic-${++syntheticUuid}` },
    location: { origin: 'https://x.com' }, document: { cookie: `ct0=synthetic; twid=u%3D${account}`, scripts: bundle ? [{ src: 'https://abs.twimg.com/responsive-web/client-web/main.synthetic.js' }] : [], documentElement: { lang: 'en', dataset: { xbcApi: JSON.stringify({ viewerId: account, ops: capture || { UserTweets: { queryId }, DeleteTweet: { queryId } } }) } } },
    chrome: { runtime, storage: { local: {
      get: async keys => { if (failGet && (keys == null || keys.some(k => k.startsWith('xbcApiCooldown:')))) throw new Error('synthetic storage failure'); const value = Object.fromEntries((keys ?? Object.keys(store)).filter(k => k in store).map(k => [k, clone(store[k])])); if (initialized) await onGet?.(keys, value); return value; },
      remove: async keys => { for (const key of keys) delete store[key]; },
      set: async values => { if (failSet && Object.keys(values).some(k => k.startsWith('xbcApiCooldown:'))) throw new Error('synthetic storage failure'); await beforeSet?.(values); Object.assign(store, clone(values)); afterSet?.(values); }
    } } },
    fetch: async (url, options) => {
      calls.push({ at: clock.now, operation: url.pathname.split('/').at(-1), queryId: url.pathname.split('/').at(-2), method: options.method });
      assert(calls.length <= requestBudget, 'finite synthetic request budget');
      const index = responseIndex++;
      const spec = await (typeof responses === 'function' ? responses(index, url, options) : responses[index]);
      assert(spec, `unplanned synthetic request ${calls.length}`);
      const headers = Object.fromEntries(Object.entries(spec.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
      return { status: spec.status ?? 200, headers: { get: name => headers[name.toLowerCase()] ?? null }, json: async () => clone(spec.body) };
    }
  });
  vm.runInContext(apiSource, context);
  const api = context.__xbcApi;
  const originalInit = api.init;
  api.init = async (...args) => { initialized = false; try { return await originalInit(...args); } finally { initialized = true; } };
  await api.init({ username: 'synthetic_me' });
  return { api, calls, sleeps, store, clock, schedule, Date: ClockDate, runtime, storage: context.chrome.storage, document: context.document };
}

export async function scan(h, { useApi = true, type = 'tweets', whileRunning } = {}) {
  const window = { innerHeight: 800, scrollY: 0, scrollTo() {}, scrollBy() {}, dispatchEvent() {} };
  h.infos = [];
  const globals = { window, location: { pathname: '/synthetic_me' }, __xbcApi: useApi ? h.api : undefined, Date: h.Date, setTimeout: h.schedule, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, Event: class {}, console: { warn() {}, info: (...args) => h.infos.push(clone(args)) }, chrome: { runtime: h.runtime, storage: h.storage },
    document: { cookie: h.document.cookie, hidden: false, visibilityState: 'visible', documentElement: { scrollHeight: 10 }, addEventListener() {}, querySelector: selector => selector.includes('AppTabBar_Profile_Link') ? { getAttribute: () => '/synthetic_me' } : null, querySelectorAll: () => [] } };
  const definitions = vm.createContext({ ...globals });
  vm.runInContext(panelSource, definitions);
  const context = vm.createContext({ ...globals });
  vm.runInContext('globalThis.worker = ' + definitions.startPreviewScanner.toString(), context);
  h.workerWindow = window;
  context.worker(type, { username: 'synthetic_me' }, false, 'fast', useApi);
  for (let i = 0; i < 20000; i++) {
    await Promise.resolve();
    if (!window.__xbcPreview?.interval || (!useApi && window.__xbcPreview.interval.loop)) break;
  }
  if (whileRunning) await whileRunning(window.__xbcPreview);
  const result = { ...window.__xbcPreview, domStarted: !!window.__xbcPreview.interval?.loop };
  if (window.__xbcPreview.interval) window.__xbcPreviewStop();
  return result;
}

// A passive replies scan (VER-899) against a synthetic X Replies page, with the real scan worker.
// `responses` are what X's page receives, in order: the first on load, each next one after a
// scroll; an entry may be an array of responses that arrive together. The document's drain
// listener plays inject/capture.js: while the tab is armed it hands over what the page received.
export async function passiveScan(h, { replyScope = 'fast', responses = [], route = '/synthetic_me/with_replies', armed = true, capturePresent = true, hidden = false, whileRunning } = {}) {
  const stored = new Map();
  const sessionStorage = { getItem: key => (stored.has(key) ? stored.get(key) : null), setItem: (key, value) => { stored.set(key, String(value)); }, removeItem: key => { stored.delete(key); } };
  if (armed) sessionStorage.setItem('xbcPassiveScan', JSON.stringify({ id: 'synthetic-arm', until: h.clock.now + 60000 }));
  const isArmed = () => { try { const arm = JSON.parse(sessionStorage.getItem('xbcPassiveScan') || 'null'); return !!arm && arm.until > h.clock.now; } catch (_) { return false; } };
  const page = { queue: [], served: 0, scrolls: 0, drains: 0 };
  const deliver = () => { if (page.served < responses.length) page.queue.push(...[].concat(responses[page.served++])); };
  const document = new EventTarget();
  Object.assign(document, {
    cookie: h.document.cookie, hidden, visibilityState: hidden ? 'hidden' : 'visible',
    documentElement: { scrollHeight: 10, dataset: capturePresent ? { xbcCapture: '2' } : {} },
    querySelector: selector => selector.includes('AppTabBar_Profile_Link') ? { getAttribute: () => '/synthetic_me' } : selector.includes('primaryColumn') ? {} : null,
    querySelectorAll: () => []
  });
  document.addEventListener('xbc:passive-drain', () => {
    page.drains++;
    const queued = page.queue.splice(0);
    if (!isArmed()) return;
    for (const record of queued) document.dispatchEvent(new CustomEvent('xbc:passive-record', { detail: JSON.stringify(record) }));
  });
  const window = { innerHeight: 800, scrollY: 0, scrollTo() {}, scrollBy() { page.scrolls++; }, dispatchEvent(event) { if (event?.type === 'scroll') deliver(); } };
  deliver();
  h.infos = [];
  const globals = { window, document, sessionStorage, location: { pathname: route }, __xbcApi: h.api, Date: h.Date, setTimeout: h.schedule, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, Event, CustomEvent,
    console: { warn() {}, info: (...args) => h.infos.push(clone(args)) }, chrome: { runtime: h.runtime, storage: h.storage } };
  const definitions = vm.createContext({ ...globals });
  vm.runInContext(panelSource, definitions);
  const context = vm.createContext({ ...globals });
  vm.runInContext('globalThis.worker = ' + definitions.startPreviewScanner.toString(), context);
  const settle = async (done, budget = 400000) => { for (let i = 0; i < budget && !done(); i++) await Promise.resolve(); return done(); };
  const started = h.clock.now;
  context.worker('replies', { username: 'synthetic_me' }, false, replyScope, true);
  if (whileRunning) await whileRunning({ P: window.__xbcPreview, window, page, document, sessionStorage, settle });
  await settle(() => !window.__xbcPreview?.interval);
  const P = window.__xbcPreview;
  const result = { mode: P.mode, done: P.done, issue: P.issue, hint: P.hint, running: !!P.interval, otherRecords: P.otherRecords || 0, ids: clone(P.items.map(i => i.id).sort()), items: clone(P.items),
    scrolls: page.scrolls, drains: page.drains, served: page.served, arm: sessionStorage.getItem('xbcPassiveScan'), elapsed: h.clock.now - started };
  if (P.interval) window.__xbcPreviewStop();
  return result;
}

// Execute the complete real workers; synthetic DOM nodes only support rendering overlays.
export async function deletion(h, selected = false, { useApi = true, action = 'delete', type = 'tweets', whileRunning, items = [{ id: 'synthetic-selected', text: 'synthetic post' }], dateFilter } = {}) {
  const node = () => ({ style: {}, classList: { add() {}, remove() {} }, addEventListener() {}, remove() {}, appendChild() {}, setAttribute() {},
    querySelector: () => node(), getElementById: () => node(), attachShadow: () => node() });
  const window = { innerHeight: 800, scrollY: 0, scrollTo() {}, scrollBy() {}, dispatchEvent() {} };
  const globals = { window, location: { pathname: '/synthetic_me' }, __xbcApi: useApi ? h.api : undefined, Date: h.Date, Math, setTimeout: h.schedule, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, Event: class {}, navigator: {}, crypto: { randomUUID: () => `synthetic-job-${++syntheticUuid}` },
    console: { warn() {}, info() {} }, chrome: { runtime: h.runtime, storage: h.storage },
    document: { cookie: h.document.cookie, body: node(), hidden: false, visibilityState: 'visible', documentElement: { scrollHeight: 10 }, addEventListener() {}, createElement: node, getElementById: () => null,
      querySelector: selector => selector.includes('AppTabBar_Profile_Link') ? { getAttribute: () => '/synthetic_me' } : null, querySelectorAll: () => [] } };
  const definitions = vm.createContext({ ...globals });
  vm.runInContext(selected ? panelSource : popupSource, definitions);
  const context = vm.createContext({ ...globals });
  const serialized = selected ? definitions.runSelectedDelete : definitions.runWorker;
  vm.runInContext('globalThis.worker = ' + serialized.toString(), context);
  h.workerWindow = window;
  if (selected) context.worker(type, items, { username: 'synthetic_me' }, false, useApi);
  else context.worker(action, false, { username: 'synthetic_me' }, useApi, dateFilter);
  for (let i = 0; i < 20000; i++) {
    await Promise.resolve();
    if (window.__xCleaner?.historyPersisted || window.__xCleaner?.apiFallback || (!useApi && window.__xCleaner?.interval?.loop)) break;
  }
  const x = window.__xCleaner;
  assert(x.historyPersisted || x.apiFallback || (!useApi && x.interval?.loop), 'worker settled or entered DOM');
  if (whileRunning) await whileRunning(x);
  const result = { domStarted: !!x.interval?.loop, mode: x.mode, apiFallback: x.apiFallback || null, issue: x.issue, historyPersisted: x.historyPersisted, successCount: x.successCount, stats: clone(x.stats) };
  if (x.interval) await window.__xCleanerStop();
  return result;
}

const persisted = (store, account = '42', operation = 'DeleteTweet') => {
  const prefix = `xbcApiCooldown:${account}:${operation}`;
  const records = Object.entries(store).filter(([key]) => key === prefix || key.startsWith(prefix + ':')).map(([, value]) => value);
  return { until: Math.max(0, ...records.map(r => r.until || 0)), blocked: records.some(r => r.blocked) };
};
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

export async function testApiLimits() {
  let passed = 0;
  const failures = [];
  const check = async (name, fn) => {
    try { await fn(); passed++; console.log(`PASS ${name}`); }
    catch (error) { failures.push({ name, error }); console.log(`FAIL ${name}: ${error.message}`); }
  };
  const manualFlows = [
    { name: 'Quick Clean', operation: 'DeleteTweet', list: 'UserTweets', run: h => deletion(h, false, { useApi: false }) },
    { name: 'selected delete', operation: 'DeleteTweet', list: 'UserTweets', run: h => deletion(h, true, { useApi: false }) },
    { name: 'preview scan', operation: 'UserTweets', list: 'UserTweets', run: h => scan(h, { useApi: false }) }
  ];
  for (const flow of manualFlows) {
    for (const blocked of [false, true]) await check(`API off ${flow.name} stops on active ${blocked ? 'blocked' : 'cooldown'} claim without injected client`, async () => {
      const store = { [`xbcApiCooldown:42:${flow.operation}:claim:manual`]: { until: START + 3600000, blocked } };
      const h = await harness([], { store }); const result = await flow.run(h);
      assert.equal(result.domStarted, false); assert.match(result.issue, /suspended/); assert.equal(h.calls.length, 0);
      assert.equal(persisted(store, '42', flow.operation).until, START + 3600000);
    });
    if (flow.list !== flow.operation) await check(`API off ${flow.name} also respects its source list cooldown`, async () => {
      const h = await harness([], { store: { [`xbcApiCooldown:42:${flow.list}`]: { until: START + 60000 } } });
      const result = await flow.run(h); assert.equal(result.domStarted, false); assert.match(result.issue, /suspended/); assert.equal(h.calls.length, 0);
    });
    for (const condition of ['expired', 'other account', 'other operation', 'none']) await check(`API off ${flow.name} preserves DOM when claim is ${condition}`, async () => {
      const account = condition === 'other account' ? '99' : '42';
      const operation = condition === 'other operation' ? 'UnfavoriteTweet' : flow.operation;
      const store = condition === 'none' ? {} : { [`xbcApiCooldown:${account}:${operation}:claim:control`]: { until: condition === 'expired' ? START - 1 : START + 3600000, blocked: true } };
      const h = await harness([], { store }); const result = await flow.run(h);
      assert.equal(result.domStarted, true); assert.equal(h.calls.length, 0);
    });
    await check(`API off ${flow.name} honors Stop while cooldown read is pending`, async () => {
      let h;
      h = await harness([], { onGet: async keys => { if (keys == null) { if (h.workerWindow?.__xCleanerStop) await h.workerWindow.__xCleanerStop(); else h.workerWindow?.__xbcPreviewStop?.(); } } });
      const result = await flow.run(h); assert.equal(result.domStarted, false); assert.match(result.issue, /stopped by user/i); assert.equal(h.calls.length, 0);
    });
    await check(`API off ${flow.name} fails closed when account identity is unavailable`, async () => {
      const h = await harness([]); h.document.cookie = '';
      const result = await flow.run(h); assert.equal(result.domStarted, false); assert.match(result.issue, /cooldown/i); assert.equal(h.calls.length, 0);
    });
    await check(`API off ${flow.name} fails closed when cooldown storage is unavailable`, async () => {
      const h = await harness([], { failGet: true }); const result = await flow.run(h);
      assert.equal(result.domStarted, false); assert.match(result.issue, /cooldown/i); assert.equal(h.calls.length, 0);
    });
  }
  // A sleep the service worker answers with an error (the extension context went away) waits for
  // the page timer instead of resolving at once, so the click loops cannot spin (VER-823).
  const loopFlows = [
    { name: 'Quick Clean', run: (h, whileRunning) => deletion(h, false, { useApi: false, whileRunning }) },
    { name: 'selected delete', run: (h, whileRunning) => deletion(h, true, { useApi: false, whileRunning }) },
    { name: 'preview scan', run: (h, whileRunning) => scan(h, { useApi: false, whileRunning }) }
  ];
  for (const flow of loopFlows) await check(`API off ${flow.name} sleep waits for its timer when the service worker answers with an error`, async () => {
    const h = await harness([]);
    const send = h.runtime.sendMessage, timer = h.schedule, held = [];
    let failing = false, asked = 0;
    h.runtime.sendMessage = (message, callback) => {
      if (!failing || message.type !== 'xbc:sleep') return send(message, callback);
      asked++;
      h.runtime.lastError = { message: 'synthetic: extension context invalidated' };
      try { callback?.(); } finally { delete h.runtime.lastError; }
    };
    h.schedule = (fn, ms = 0) => failing ? (held.push({ fn, ms }), 1) : timer(fn, ms);
    await flow.run(h, async worker => {
      const settle = async () => { for (let i = 0; i < 2000; i++) await Promise.resolve(); };
      failing = true;
      await settle();
      assert.equal(asked, 1, `one sleep asked and still pending, not ${asked}`);
      assert.ok(worker.interval, 'job still running while its sleep waits');
      const pending = held.filter(t => t.ms >= 250);
      assert.equal(pending.length, 1, 'the sleep waits on one page timer');
      held.splice(held.indexOf(pending[0]), 1)[0].fn();
      await settle();
      assert.equal(asked, 2, 'the page timer, not the error reply, moved the loop on');
      failing = false;
      for (const t of held.splice(0)) t.fn();
    });
  });
  // An error while starting the click loop is reported as itself, not as a failed cooldown read (VER-823).
  for (const flow of loopFlows) await check(`API off ${flow.name} reports an error starting the loop as itself, not as a cooldown failure`, async () => {
    let armed = false, h;
    h = await harness([], { onGet: async keys => {
      const worker = h.workerWindow?.__xCleaner || h.workerWindow?.__xbcPreview;
      if (keys == null && !armed && worker) {
        armed = true;
        Object.defineProperty(worker, 'mode', { configurable: true, get: () => undefined, set() { throw new Error('synthetic start failure'); } });
      }
    } });
    const result = await flow.run(h);
    assert.ok(armed, 'the start was made to fail');
    assert.match(result.issue || '', /synthetic start failure/);
    assert.doesNotMatch(result.issue || '', /cooldown/i);
  });
  for (const selected of [false, true]) for (const active of [false, true]) await check(`API unavailable ${selected ? 'selected' : 'quick'} delete ${active ? 'stops on known cooldown' : 'offers a new explicit job without automatic DOM'}`, async () => {
    const store = active ? { 'xbcApiCooldown:42:DeleteTweet:claim:unavailable': { until: START + 3600000, blocked: true } } : {};
    const h = await harness([], { store }); h.api.init = async () => ({ ok: false, reason: 'synthetic unavailable' });
    const x = await deletion(h, selected); assert.equal(!!x.apiFallback, false); assert.equal(x.domStarted, false); assert.match(x.issue || '', active ? /suspended/ : /turn off API/); assert.equal(h.calls.length, 0);
  });
  for (const active of [false, true]) await check(`API unavailable scanner ${active ? 'stops on known cooldown' : 'offers a new explicit job without automatic DOM'}`, async () => {
    const store = active ? { 'xbcApiCooldown:42:UserTweets:claim:unavailable': { until: START + 3600000 } } : {};
    const h = await harness([], { store }); h.api.init = async () => ({ ok: false, reason: 'synthetic unavailable' });
    const p = await scan(h); assert.equal(!!p.apiFallback, false); assert.equal(p.domStarted, false); assert.match(p.issue, active ? /suspended/ : /turn off API/); assert.equal(h.calls.length, 0);
  });
  const quickActions = {
    delete: ['UserTweets', 'DeleteTweet'], unrepost: ['UserTweets', 'DeleteRetweet'],
    unlike: ['Likes', 'UnfavoriteTweet'], bulkUnfollow: ['Following', 'friendships/destroy'], followAll: ['Followers', 'friendships/create'], followVerified: ['BlueVerifiedFollowers', 'friendships/create']
  };
  for (const [action, operations] of Object.entries(quickActions)) for (const operation of operations) await check(`API off Quick Clean ${action} checks ${operation}`, async () => {
    const h = await harness([], { store: { [`xbcApiCooldown:42:${operation}:claim:mapped`]: { until: START + 3600000 } } });
    const x = await deletion(h, false, { useApi: false, action }); assert.equal(x.domStarted, false); assert.match(x.issue, /suspended/);
  });
  const previewTypes = { replies: ['UserTweetsAndReplies', 'DeleteTweet'], reposts: ['UserTweets', 'DeleteRetweet'], unfollow: ['Following', 'friendships/destroy'] };
  for (const [type, [list, operation]] of Object.entries(previewTypes)) {
    await check(`API off ${type} scanner checks its own list ${list}`, async () => {
      const h = await harness([], { store: { [`xbcApiCooldown:42:${list}:claim:typed`]: { until: START + 3600000 } } });
      const p = await scan(h, { useApi: false, type }); assert.equal(p.domStarted, false); assert.match(p.issue, /suspended/);
    });
    for (const bucket of [list, operation]) await check(`API off selected ${type} checks ${bucket}`, async () => {
      const h = await harness([], { store: { [`xbcApiCooldown:42:${bucket}:claim:typed`]: { until: START + 3600000 } } });
      const x = await deletion(h, true, { useApi: false, type }); assert.equal(x.domStarted, false); assert.match(x.issue, /suspended/);
    });
  }
  const refusals = [
    { name: '403 Retry-After 1h', status: 403, headers: { 'Retry-After': '3600' } },
    { name: 'binding 3071 Retry-After 1h', status: 401, headers: { 'x-tfe-auth-result-code': '3071', 'Retry-After': '3600' } },
    { name: '403 backoff 60s', status: 403, headers: { 'backoff-policy': 'backoff=60000' } },
    { name: '403 remaining zero', status: 403, headers: { ...reset(20), 'x-rate-limit-remaining': '0' } }
  ];
  for (const response of refusals) {
    const spec = { ...response, body: {} };
    await check(`refusal cooldown stops direct delete: ${response.name}`, async () => {
      const h = await harness([spec]); const r = await h.api.deleteTweet('synthetic');
      assert.equal(r.kind, 'stop'); assert.equal(h.calls.length, 1); assert(r.retryAt > START);
    });
    await check(`refusal cooldown blocks real scan fallback: ${response.name}`, async () => {
      const h = await harness([spec]); const p = await scan(h);
      assert.equal(p.mode, 'api'); assert.equal(!!p.apiFallback, false); assert.equal(p.done, false); assert.match(p.issue, /suspended/); assert.equal(h.calls.length, 1);
    });
    for (const selected of [false, true]) await check(`refusal cooldown blocks real ${selected ? 'selected' : 'quick'} delete fallback: ${response.name}`, async () => {
      const h = await harness(selected ? [spec] : [{ body: timeline(null) }, spec]); const x = await deletion(h, selected);
      assert.equal(x.mode, 'api'); assert.equal(x.apiFallback, null); assert.match(x.issue, /suspended/); assert.equal(x.historyPersisted, true); assert.equal(x.successCount, 0);
      assert.equal(h.calls.length, selected ? 1 : 2);
    });
  }
  await check('plain refusal stays refused in client and offers a new scan/job without automatic DOM', async () => {
    const spec = { status: 403, headers: { 'Retry-After': 'invalid', 'x-rate-limit-remaining': 'invalid' }, body: {} };
    const direct = await harness([spec]); assert.equal((await direct.api.deleteTweet('synthetic')).kind, 'refused');
    const h = await harness([spec]); const p = await scan(h); assert.equal(p.mode, 'api'); assert.equal(!!p.apiFallback, false); assert.match(p.issue, /turn off API/);
    for (const selected of [false, true]) {
      const x = await deletion(await harness(selected ? [spec] : [{ body: timeline(null) }, spec]), selected);
      assert.equal(x.mode, 'api'); assert.equal(!!x.apiFallback, false); assert.match(x.issue, /turn off API/);
    }
  });
  await check('Stop during refusal persistence retains cooldown and suppresses fallback', async () => {
    let active = true;
    const h = await harness([{ status: 403, headers: { 'Retry-After': '3600' }, body: {} }], {
      afterSet: values => { if (Object.keys(values).some(k => k.startsWith('xbcApiCooldown:'))) active = false; }
    });
    assert.equal((await h.api.deleteTweet('synthetic', { isActive: () => active })).kind, 'stopped');
    assert.equal(persisted(h.store).until, START + 3600000); assert.equal(h.calls.length, 1);
  });
  await check('late stopped response keeps original account and cannot change new job pacing', async () => {
    const late = deferred(); let oldActive = true;
    const h = await harness([late.promise, ok]);
    const old = h.api.deleteTweet('old', { isActive: () => oldActive });
    for (let i = 0; i < 100 && !h.calls.length; i++) await Promise.resolve();
    assert.equal(h.calls.length, 1); oldActive = false;
    const capture = JSON.parse(h.document.documentElement.dataset.xbcApi); capture.viewerId = '99';
    h.document.documentElement.dataset.xbcApi = JSON.stringify(capture);
    await h.api.init({ username: 'synthetic_other' });
    late.resolve(rate(reset(5))); assert.equal((await old).kind, 'stopped');
    assert.equal(persisted(h.store).until, START + 15000); assert.equal(persisted(h.store, '99').until, 0);
    assert.equal(h.api.pace('delete'), 2500); assert.equal((await h.api.deleteTweet('new')).kind, 'ok'); assert.equal(h.calls[1].at, START);
  });
  await check('expired immutable claims are pruned without deleting legacy or active claims', async () => {
    const prefix = 'xbcApiCooldown:42:DeleteTweet';
    const store = { [prefix]: { until: START - 1 }, [prefix + ':claim:old']: { until: START - 1 }, [prefix + ':claim:live']: { until: START + 3600000, blocked: true } };
    const h = await harness([], { store });
    assert(!(prefix + ':claim:old' in store)); assert(prefix in store); assert(prefix + ':claim:live' in store);
    assert.equal((await h.api.deleteTweet('synthetic')).kind, 'stop'); assert.equal(h.calls.length, 0);
  });
  await check('simultaneous writers cannot shorten a deadline or erase blocked=true', async () => {
    const store = {}; const bothRead = deferred(), longSaved = deferred(); let reads = 0;
    const hooks = () => { let gets = 0; return {
      onGet: async keys => { if (keys == null || keys.some(k => k.startsWith('xbcApiCooldown:'))) if (++gets === 2) { if (++reads === 2) bothRead.resolve(); await bothRead.promise; } },
      beforeSet: async values => { const v = Object.entries(values).find(([key]) => key.startsWith('xbcApiCooldown:'))?.[1]; if (v && !v.blocked) await longSaved.promise; },
      afterSet: values => { if (Object.entries(values).some(([key, v]) => key.startsWith('xbcApiCooldown:') && v.blocked)) longSaved.resolve(); }
    }; };
    let longActive = true, shortActive = true;
    const a = hooks(), b = hooks();
    const long = await harness([rate(reset(3600), 344)], { store, ...a, afterSet: values => { a.afterSet(values); if (Object.keys(values).some(k => k.startsWith('xbcApiCooldown:'))) longActive = false; } });
    const short = await harness([rate(reset(5))], { store, ...b, afterSet: values => { b.afterSet(values); if (Object.keys(values).some(k => k.startsWith('xbcApiCooldown:'))) shortActive = false; } });
    await Promise.all([long.api.deleteTweet('one', { isActive: () => longActive }), short.api.deleteTweet('two', { isActive: () => shortActive })]);
    assert.equal(persisted(store).blocked, true); assert.equal(persisted(store).until, START + 86400000);
  });
  await check('late stopped response cannot be overwritten by the new job shorter write', async () => {
    const late = deferred(), shortRead = deferred(), releaseShort = deferred(), longSaved = deferred(); let gets = 0, oldActive = true;
    const h = await harness([late.promise, rate({ 'Retry-After': '3600' }, 999, 403)], {
      onGet: async keys => { if (keys == null || keys.some(k => k.startsWith('xbcApiCooldown:'))) if (++gets === 3) { shortRead.resolve(); await releaseShort.promise; } },
      afterSet: values => { if (Object.entries(values).some(([key, v]) => key.startsWith('xbcApiCooldown:') && v.blocked)) longSaved.resolve(); }
    });
    const old = h.api.deleteTweet('old', { isActive: () => oldActive });
    for (let i = 0; i < 100 && !h.calls.length; i++) await Promise.resolve();
    assert.equal(h.calls.length, 1); oldActive = false;
    await h.api.init({ username: 'synthetic_me' });
    const current = h.api.deleteTweet('new'); await shortRead.promise;
    late.resolve(rate(reset(3600), 344)); await longSaved.promise; releaseShort.resolve();
    assert.equal((await old).kind, 'stopped'); await current;
    assert.equal(persisted(h.store).blocked, true); assert.equal(persisted(h.store).until, START + 86400000);
  });
  await check('reset one hour away suspends with full persisted deadline, without retry', async () => {
    const h = await harness([rate(reset(3600))]);
    const r = await h.api.deleteTweet('synthetic');
    assert.equal(r.kind, 'stop'); assert.equal(r.retryAt, START + 3610000); assert.equal(h.calls.length, 1); assert.equal(h.clock.now, START);
    assert.equal(persisted(h.store).until, r.retryAt);
  });
  for (const value of [undefined, 'invalid', 'Infinity', '-1', String(START / 1000 - 60), '']) await check(`missing/invalid/expired reset ${JSON.stringify(value)} waits conservatively`, async () => {
    const h = await harness([rate(value === undefined ? {} : { 'x-rate-limit-reset': value }), ok]);
    assert.equal((await h.api.deleteTweet('synthetic')).kind, 'ok'); assert(h.calls[1].at - h.calls[0].at >= 900000);
  });
  for (const value of ['120', new Date(START + 120000).toUTCString()]) await check(`Retry-After ${value} extends a shorter reset`, async () => {
    const h = await harness([rate({ ...reset(5), 'Retry-After': value }), ok]);
    await h.api.deleteTweet('synthetic'); assert.equal(h.calls[1].at - h.calls[0].at, 120000);
  });
  await check('later reset takes precedence over shorter Retry-After/backoff', async () => {
    const h = await harness([rate({ ...reset(120), 'Retry-After': '5', 'backoff-policy': 'backoff=60000' }), ok]);
    await h.api.deleteTweet('synthetic'); assert.equal(h.calls[1].at - START, 130000);
  });
  for (const status of [400, 429]) await check(`daily 344 beats HTTP ${status}, and survives init`, async () => {
    const h = await harness([rate(reset(5), 344, status)]);
    assert.equal((await h.api.deleteTweet('synthetic')).kind, 'stop'); assert.equal(h.calls.length, 1);
    const again = await harness([], { store: h.store, clock: h.clock });
    assert.equal((await again.api.deleteTweet('synthetic')).kind, 'stop'); assert.equal(again.calls.length, 0);
  });
  for (const code of [326, 226, 161]) await check(`restriction ${code} beats generic 429`, async () => {
    const h = await harness([rate(reset(5), code)]);
    assert.equal((await h.api.deleteTweet('synthetic')).kind, 'stop'); assert.equal(h.calls.length, 1);
  });
  await check('a stop retains a longer server reset instead of inventing an earlier unlock', async () => {
    const h = await harness([rate(reset(48 * 3600), 344)]);
    assert.equal((await h.api.deleteTweet('synthetic')).kind, 'stop');
    assert.equal(persisted(h.store).until, START + 48 * 3600000 + 10000);
  });
  for (const headers of [{ 'backoff-policy': 'backoff=60000' }, { 'Retry-After': '60' }]) await check(`success still gates next request on ${Object.keys(headers)[0]}`, async () => {
    const h = await harness([{ ...ok, headers }, ok]);
    await h.api.deleteTweet('first'); await h.api.deleteTweet('second'); assert.equal(h.calls[1].at - START, 60000);
  });
  await check('transient retry respects long backoff instead of 5 second retry delay', async () => {
    const h = await harness([rate({ 'backoff-policy': 'backoff=60000' }, 130, 503), ok]);
    await h.api.deleteTweet('synthetic'); assert.equal(h.calls[1].at - START, 60000);
  });
  await check('over-budget backoff persists and suspends without another call', async () => {
    const h = await harness([{ ...ok, headers: { 'backoff-policy': 'backoff=3600000' } }]);
    await h.api.deleteTweet('first'); const r = await h.api.deleteTweet('second');
    assert.equal(r.kind, 'stop'); assert.equal(r.retryAt, START + 3600000); assert.equal(h.calls.length, 1);
  });
  await check('finite rate retries shared by all calls in the job', async () => {
    const h = await harness([rate(reset(5)), ok, rate(reset(25)), rate(reset(45)), rate(reset(65))]);
    assert.equal((await h.api.deleteTweet('first')).kind, 'ok');
    assert.equal((await h.api.deleteTweet('second')).kind, 'stop'); assert.equal(h.calls.length, 5); assert(h.clock.now - START < 120000);
  });
  await check('cumulative wait budget suspends after two default waits', async () => {
    const h = await harness([rate(), rate(), rate()]);
    assert.equal((await h.api.deleteTweet('synthetic')).kind, 'stop'); assert.equal(h.calls.length, 3); assert.equal(h.clock.now - START, 1800000);
  });
  await check('Stop during wait clears onWait, prevents retry and retains cooldown after restart/query change', async () => {
    let active = true; const waits = [];
    const h = await harness([rate(reset(120))], { onSleep: () => { active = false; } });
    assert.equal((await h.api.deleteTweet('synthetic', { isActive: () => active, onWait: v => waits.push(v) })).kind, 'stopped');
    assert.equal(h.calls.length, 1); assert.equal(waits.at(-1), null);
    const restarted = await harness([ok], { store: h.store, clock: h.clock, queryId: 'changed-query-id' });
    assert.equal((await restarted.api.deleteTweet('synthetic')).kind, 'ok'); assert.equal(restarted.calls[0].at, START + 130000); assert.equal(restarted.api.pace('delete'), 5000);
  });
  await check('deadline extended by another job is rechecked before dispatch', async () => {
    const key = 'xbcApiCooldown:42:DeleteTweet';
    const store = { [key]: { until: START + 15000, slowdown: 2 } };
    let extended = false;
    const h = await harness([ok], { store, onSleep: () => {
      if (!extended) { store[key].until = START + 120000; extended = true; }
    } });
    await h.api.deleteTweet('synthetic'); assert.equal(h.calls[0].at, START + 120000);
  });
  await check('persisted bucket isolates accounts and operations', async () => {
    const h = await harness([rate(reset(3600))]); await h.api.deleteTweet('synthetic');
    const other = await harness([ok], { store: h.store, account: '99' }); assert.equal((await other.api.deleteTweet('synthetic')).kind, 'ok'); assert.equal(other.calls[0].at, START);
    const same = await harness([{ body: timeline(null) }], { store: h.store });
    for await (const page of same.api.pages('UserTweets')) assert.equal(page.tweets.length, 1);
    assert.equal(same.calls[0].at, START);
  });
  await check('remaining zero on success gates next call; limit/remaining low slows pace', async () => {
    const h = await harness([{ ...ok, headers: { ...reset(20), 'x-rate-limit-limit': '10', 'x-rate-limit-remaining': '0' } }, ok]);
    await h.api.deleteTweet('first'); await h.api.deleteTweet('second'); assert.equal(h.calls[1].at - START, 30000); assert.equal(h.api.pace('delete'), 5000);
    const near = await harness([{ ...ok, headers: { 'x-rate-limit-limit': '100', 'x-rate-limit-remaining': '9' } }]);
    await near.api.deleteTweet('first'); assert.equal(near.api.pace('delete'), 5000);
  });
  await check('invalid success remaining/reset headers never fabricate an immediate retry', async () => {
    const h = await harness([{ ...ok, headers: { 'x-rate-limit-remaining': '0', 'x-rate-limit-reset': 'invalid' } }, ok]);
    await h.api.deleteTweet('first'); await h.api.deleteTweet('second'); assert.equal(h.calls[1].at - START, 900000);
  });
  for (const configured of [0.05, 0.6, 0, -1, 'Infinity', 'n/a', 2, 12]) await check(`production pacing floor for apiPace=${configured}`, async () => {
    const h = await harness([], { store: { apiPace: configured } });
    assert.equal(h.api.pace('delete'), 2500 * (Number.isFinite(Number(configured)) ? Math.max(1, Number(configured)) : 1));
  });
  await check('rate slowdown affects next page as well as actions', async () => {
    const h = await harness([rate(reset(5)), { body: timeline('c1') }, { body: timeline(null) }]);
    for await (const _ of h.api.pages('UserTweets', { pause: 1 })) { /* consume real pages */ }
    assert.equal(h.calls[2].at - h.calls[1].at, 1800); assert.equal(h.api.pace('delete'), 5000);
  });
  await check('Stop while paging never requests the next page', async () => {
    let active = true;
    const h = await harness([{ body: timeline('c1') }], { onSleep: () => { active = false; } });
    await assert.rejects(async () => { for await (const _ of h.api.pages('UserTweets', { isActive: () => active })) { /* consume */ } }, e => e.result?.reason === 'cancelled');
    assert.equal(h.calls.length, 1);
  });
  // The service worker times at most 20 s per sleep request, so a longer API pause is asked in
  // steps; one request for the whole pause would end after 20 s (D19).
  await check('a sleep longer than the service worker cap is asked in steps of up to 20 s', async () => {
    const h = await harness([]);
    const asked = [];
    const send = h.runtime.sendMessage;
    h.runtime.sendMessage = (message, callback) => { if (message.type === 'xbc:sleep') asked.push(message.ms); return send(message, callback); };
    await h.api.sleep(50000);
    assert.deepEqual(asked, [20000, 20000, 10000]);
    asked.length = 0;
    await h.api.sleep(1500);
    assert.deepEqual(asked, [1500], 'a short sleep is one request, as before');
  });
  await check('storage read/write failures stop instead of bypassing cooldown', async () => {
    const read = await harness([], { failGet: true }); assert.equal((await read.api.deleteTweet('synthetic')).kind, 'stop'); assert.equal(read.calls.length, 0);
    const write = await harness([rate(reset(5))], { failSet: true }); assert.equal((await write.api.deleteTweet('synthetic')).kind, 'stop'); assert.equal(write.calls.length, 1);
  });
  for (const response of [rate(reset(3600)), rate(reset(5), 344), rate(reset(5), 226)]) await check(`real preview scanner stops without DOM for ${response.body.errors[0].code}`, async () => {
    const h = await harness([response]); const p = await scan(h);
    assert.equal(p.mode, 'api'); assert.equal(p.done, false); assert.equal(!!p.apiFallback, false); assert.match(p.issue, /Scan stopped/); assert.equal(h.calls.length, 1);
  });
  await check('expired persisted daily restriction does not become a new generic blocked cooldown', async () => {
    const store = { 'xbcApiCooldown:42:DeleteTweet': { until: START - 1, blocked: true, reason: 'old daily restriction' } };
    const h = await harness([rate(reset(5)), ok], { store });
    assert.equal((await h.api.deleteTweet('synthetic')).kind, 'ok'); assert.equal(h.calls.length, 2);
  });
  // Query ids for lists (VER-624). An id that did not come from this page load or the loaded
  // bundle may be stale, so the first request of a list waits a little for the page's own one.
  // Likes and Followers stand for any list the client requests: the replies list is never
  // requested since VER-899 (see 'passive:' below).
  const FALLBACK_LIKES = 'mu4us66Q6RRNOywVQhGtRg'; // the built-in Likes id
  const FALLBACK_FOLLOWERS = 'stpzFPAIZ2qv8s2lRzPOnQ'; // the built-in Followers id
  const empty404 = { status: 404, body: undefined }; // X's answer to an unknown id: no body at all
  const listPage = { body: timeline(null) };
  const listError = async iterator => { try { for await (const _ of iterator) { /* consume */ } } catch (error) { return error; } return null; };
  const cachedOps = store => store.xbcApiCache?.ops || {};
  await check('list ids: a fallback list id waits for the page request and uses its id', async () => {
    let h; const late = { UserTweets: { queryId: 'synthetic-id' }, Likes: { queryId: 'page-likes' } };
    h = await harness([listPage], { onSleep: () => { if (h && h.clock.now - START >= 1000) h.document.documentElement.dataset.xbcApi = JSON.stringify({ viewerId: '42', ops: late }); } });
    assert.equal(h.api.sources().Likes, 'fallback');
    assert.equal(await listError(h.api.pages('Likes')), null);
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].queryId, 'page-likes'); assert.equal(h.api.sources().Likes, 'page');
    assert(h.calls[0].at - START >= 1000 && h.calls[0].at - START < 1500, `request ${h.calls[0].at - START} ms after start, as soon as the page asked`);
  });
  await check('list ids: a page or bundle list id is used at once, with no wait', async () => {
    const page = await harness([listPage]);
    assert.equal(await listError(page.api.pages('UserTweets')), null);
    assert.equal(page.calls[0].at, START); assert.equal(page.calls[0].queryId, 'synthetic-id');
    const bundle = await harness([listPage], { bundle: { ops: { Likes: { queryId: 'bundle-likes', featureSwitches: [], fieldToggles: [] } } } });
    assert.equal(bundle.api.sources().Likes, 'bundle');
    assert.equal(await listError(bundle.api.pages('Likes')), null);
    assert.equal(bundle.calls[0].at, START); assert.equal(bundle.calls[0].queryId, 'bundle-likes');
  });
  await check('list ids: without the page request the wait ends after 8 s and keeps the id it had', async () => {
    const h = await harness([listPage]);
    assert.equal(await listError(h.api.pages('Likes')), null);
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0].queryId, FALLBACK_LIKES); assert.equal(h.api.sources().Likes, 'fallback');
    assert(h.calls[0].at - START >= 8000 && h.calls[0].at - START <= 8250, `request ${h.calls[0].at - START} ms after start`);
  });
  await check('list ids: Stop during the wait cancels without a request', async () => {
    let active = true;
    const h = await harness([], { onSleep: () => { active = false; } });
    const error = await listError(h.api.pages('Likes', { isActive: () => active }));
    assert.equal(error?.result?.reason, 'cancelled'); assert.equal(error.result.kind, 'stopped'); assert.equal(h.calls.length, 0);
    assert(h.clock.now - START < 1000, `the wait ends at the Stop, not after 8 s (${h.clock.now - START} ms)`);
  });
  await check('cache: fallback ids are never cached', async () => {
    const h = await harness([listPage]);
    assert.deepEqual(Object.keys(cachedOps(h.store)).sort(), ['DeleteTweet', 'UserTweets']);
    assert(Object.values(cachedOps(h.store)).every(op => op.source === 'page'), 'each entry records its source');
    await listError(h.api.pages('Likes'));
    assert.equal(h.calls[0].queryId, FALLBACK_LIKES);
    assert(!('Likes' in cachedOps(h.store)), 'the fallback id used after the wait is not cached');
  });
  await check('cache: entries are merged and record their source, and a page id found while waiting is saved', async () => {
    const store = { xbcApiCache: { ops: { Likes: { queryId: 'cached-likes', source: 'bundle' } } } };
    let h; const late = { UserTweets: { queryId: 'synthetic-id' }, Followers: { queryId: 'page-followers' } };
    h = await harness([listPage], { store, bundle: { ops: { Following: { queryId: 'bundle-following', featureSwitches: [] } } }, onSleep: () => { if (h) h.document.documentElement.dataset.xbcApi = JSON.stringify({ viewerId: '42', ops: late }); } });
    assert.equal(h.api.sources().Likes, 'stored');
    assert.deepEqual(cachedOps(store).Likes, { queryId: 'cached-likes', source: 'bundle' }, 'an entry not resolved from the page or bundle is kept as it was');
    assert.equal(cachedOps(store).Following?.source, 'bundle'); assert.equal(cachedOps(store).UserTweets?.source, 'page');
    assert.equal(await listError(h.api.pages('Followers')), null);
    assert.equal(cachedOps(store).Followers?.queryId, 'page-followers'); assert.equal(cachedOps(store).Followers?.source, 'page');
  });
  await check('cache: an entry saved without its source is not trusted as stored', async () => {
    const store = { xbcApiCache: { ops: { Followers: { queryId: FALLBACK_FOLLOWERS }, Likes: { queryId: 'legacy-likes' } } } };
    const h = await harness([], { store });
    assert.equal(h.api.sources().Followers, 'fallback'); assert.equal(h.api.sources().Likes, 'fallback');
    assert(!('Followers' in cachedOps(store)) && !('Likes' in cachedOps(store)), 'entries of unknown origin are dropped');
  });
  await check('cache: a 404 on a stored list id removes it from the cache', async () => {
    const store = { xbcApiCache: { ops: { Likes: { queryId: 'stale-likes', source: 'page' } } } };
    const h = await harness([empty404], { store });
    assert.equal(h.api.sources().Likes, 'stored');
    const error = await listError(h.api.pages('Likes'));
    assert.equal(error?.result?.kind, 'refused'); assert.equal(h.calls[0].queryId, 'stale-likes');
    assert(!('Likes' in cachedOps(store)), 'the stale stored id is removed'); assert.equal(cachedOps(store).UserTweets?.source, 'page');
    const page = await harness([empty404], { store });
    await listError(page.api.pages('UserTweets'));
    assert.equal(cachedOps(store).UserTweets?.queryId, 'synthetic-id', 'a 404 on an id from the page does not remove it');
    const other = await harness([{ status: 403, body: undefined }], { store: { xbcApiCache: { ops: { Likes: { queryId: 'kept-likes', source: 'bundle' } } } } });
    await listError(other.api.pages('Likes'));
    assert.equal(cachedOps(other.store).Likes?.queryId, 'kept-likes', 'only a 404 removes a stored id');
  });
  await check('errors: a refused list request names the operation, the HTTP status and the id source', async () => {
    const h = await harness([empty404]);
    const error = await listError(h.api.pages('Likes'));
    assert.deepEqual({ ...error?.result }, { kind: 'refused', message: 'HTTP 404', operation: 'Likes', status: 404, source: 'fallback' });
    const scanned = await scan(await harness([empty404]), { type: 'unfollow' });
    assert.equal(scanned.issue, 'Scan interrupted after 0 items: X did not accept the request for Following (HTTP 404, id source: fallback). Start a new scan to try the API again, or turn off API mode to scan by clicking.');
    assert.equal(scanned.mode, 'api'); assert.equal(scanned.domStarted, false);
  });
  await check('errors: a list request that gets no answer from X says so, instead of saying X refused it', async () => {
    const offline = () => { throw new TypeError('Failed to fetch'); };
    const scanned = await scan(await harness(offline), { type: 'unfollow' });
    assert.match(scanned.issue, /^Scan interrupted after 0 items: The request for Following got no answer from X \(network error, id source: fallback\)/);
    assert.doesNotMatch(scanned.issue, /did not accept/);
    assert.equal(scanned.mode, 'api'); assert.equal(scanned.domStarted, false);
  });
  await check('logs: an API scan logs its operation sources once, without secrets', async () => {
    const h = await harness([listPage]);
    await scan(h);
    const logged = h.infos.filter(args => args[0] === '[Postscrub] API mode, operation sources:');
    assert.equal(logged.length, 1, 'logged once per scan');
    const sources = logged[0][1];
    assert(sources && Object.entries(sources).every(([name, source]) => /^\w+$/.test(name) && ['page', 'bundle', 'stored', 'fallback'].includes(source)), 'only operation names and their sources');
    const text = JSON.stringify(h.infos);
    for (const secret of ['ct0', 'twid', 'synthetic-id', 'AAAAAAAA', '"42"', 'Bearer']) assert(!text.includes(secret), `the log holds no ${secret}`);
  });
  // Replies list by passive read (VER-899): in API mode the scan reads only the responses to X's
  // own page requests, sends no list request, and says "Scan complete" only when X ended the list.
  const post = (id, { replyTo = null, author = '42' } = {}) => ({ content: { itemContent: { tweet_results: { result: { __typename: 'Tweet', rest_id: id, legacy: { full_text: `synthetic ${id}`, user_id_str: author, ...(replyTo ? { in_reply_to_status_id_str: replyTo } : {}) } } } } } });
  const repliesTimeline = (entries, { cursor = null, end = false, errors, extra = [] } = {}) => ({ ...(errors ? { errors } : {}), data: { user: { result: { timeline: { timeline: { instructions: [
    { type: 'TimelineAddEntries', entries: [...entries, ...(cursor ? [{ content: { cursorType: 'Bottom', value: cursor } }] : [])] }, ...extra,
    ...(end ? [{ type: 'TimelineTerminateTimeline', direction: 'Bottom' }] : [])] } } } } } });
  const response = (json, cursor = null, extra = {}) => ({ status: 200, userId: '42', cursor, body: json === undefined ? '' : JSON.stringify(json), rateReset: null, rateRemaining: null, ...extra });
  const first = response(repliesTimeline([post('901'), post('701', { author: '500' }), post('801', { replyTo: '701' })], { cursor: 'c1' }));
  const second = response(repliesTimeline([post('802', { replyTo: '702' }), post('803', { replyTo: '703' })], { cursor: 'c2' }), 'c1');
  const last = response(repliesTimeline([post('804', { replyTo: '704' })], { end: true }), 'c2');
  const cooldownKeys = store => Object.keys(store).filter(key => key.startsWith('xbcApiCooldown:'));
  await check('passive: replies come only from X\'s page responses, across pages, with no request of their own', async () => {
    const h = await harness([]);
    const r = await passiveScan(h, { responses: [first, second, last] });
    assert.equal(r.issue, 'Scan complete'); assert.equal(r.done, true); assert.equal(r.mode, 'api');
    assert.deepEqual(r.ids, ['801', '802', '803', '804']);
    assert(r.items.every(i => i.classification === 'definite' && i.type === 'reply'), 'every item is a reply');
    assert.equal(h.calls.length, 0, 'no request at all');
    assert(r.scrolls >= 2, `the scan scrolled the page for each next page (${r.scrolls})`);
    assert.equal(r.served, 3); assert.equal(r.arm, null, 'the arm is removed when the scan ends');
    const all = await passiveScan(await harness([]), { replyScope: 'all', responses: [first, second, last] });
    assert.deepEqual(all.ids, ['801', '802', '803', '804', '901']); assert.equal(all.items.find(i => i.id === '901').classification, 'standalone');
  });
  await check('passive: another account\'s responses are ignored and never end the scan', async () => {
    const other = response(repliesTimeline([post('899', { replyTo: '799' })], { end: true }), null, { userId: '77' });
    const r = await passiveScan(await harness([]), { responses: [[other, first], second, last] });
    assert.equal(r.issue, 'Scan complete'); assert.deepEqual(r.ids, ['801', '802', '803', '804']); assert.equal(r.otherRecords, 1);
  });
  await check('passive: when X\'s page stops asking after a page that still had posts, the scan is not complete', async () => {
    const r = await passiveScan(await harness([]), { responses: [first] });
    assert.equal(r.done, false); assert.deepEqual(r.ids, ['801']);
    assert.equal(r.issue, 'Scan stopped after 1 item: X\'s page stopped loading replies before the end of the list. Start a new scan, or turn off API mode to scan by clicking');
  });
  await check('passive: a last page without posts, then no further request at the bottom, is the end', async () => {
    const empty = response(repliesTimeline([], { cursor: 'c2' }), 'c1');
    const r = await passiveScan(await harness([]), { responses: [first, empty] });
    assert.equal(r.issue, 'Scan complete'); assert.equal(r.done, true); assert.deepEqual(r.ids, ['801']);
  });
  await check('passive: errors[] or an unknown instruction keeps the replies but never ends as complete', async () => {
    for (const json of [repliesTimeline([post('805', { replyTo: '705' })], { end: true, errors: [{ code: 131, message: 'synthetic partial' }] }),
      repliesTimeline([post('805', { replyTo: '705' })], { end: true, extra: [{ type: 'TimelineShowAlert' }] })]) {
      const r = await passiveScan(await harness([]), { responses: [response(json)] });
      assert.equal(r.done, false); assert.deepEqual(r.ids, ['805']); assert.match(r.issue, /^Scan finished with gaps after 1 item: /);
    }
  });
  await check('passive: a list read without its first page ends with gaps, not complete', async () => {
    const r = await passiveScan(await harness([]), { responses: [second, last] });
    assert.equal(r.done, false); assert.deepEqual(r.ids, ['802', '803', '804']);
    assert.equal(r.issue, 'Scan finished with gaps after 3 items: the first page of your replies was not read, so some may be missing. Review the list, or start a new scan.');
  });
  await check('passive: a refused page response stops with its status and writes no cooldown', async () => {
    const h = await harness([]);
    const refused = await passiveScan(h, { responses: [response(undefined, null, { status: 404 })] });
    assert.equal(refused.issue, 'Scan stopped after 0 items: X refused its own request for your replies (HTTP 404)'); assert.equal(refused.done, false);
    const limited = await passiveScan(h, { responses: [first, response({ errors: [{ code: 88, message: 'Rate limit exceeded' }] }, 'c1', { status: 429, rateReset: START / 1000 + 600 })] });
    assert.match(limited.issue, /^Scan stopped after 1 item: X's rate limit stopped X's page from loading your replies; X allows more after \d/); assert.equal(limited.done, false);
    assert.deepEqual(cooldownKeys(h.store), []); assert.equal(h.calls.length, 0);
  });
  await check('passive: no answer from X\'s page within 20 s stops the scan, not complete', async () => {
    const r = await passiveScan(await harness([]), { responses: [] });
    assert.equal(r.done, false); assert.match(r.issue, /^Scan stopped after 0 items: X's page did not load your replies within 20 s/);
    assert(r.elapsed >= 20000 && r.elapsed < 30000, `stopped after ${r.elapsed} ms`);
  });
  await check('passive: a hidden tab is neither scrolled nor taken as the end, and the scan asks to keep it visible', async () => {
    const h = await harness([]);
    const r = await passiveScan(h, { hidden: true, responses: [first, last], whileRunning: async ({ P, settle, window }) => {
      await settle(() => window.__xbcPreview.items.length > 0, 100000);
      const at = h.clock.now;
      for (let i = 0; i < 60; i++) await settle(() => false, 2000);
      assert.equal(!!P.interval, true, 'still running'); assert.match(P.hint || '', /Keep the X tab visible/);
      assert(h.clock.now - at >= 60000, `a minute of hidden steps (${h.clock.now - at} ms)`);
      window.__xbcPreviewStop();
    } });
    assert.equal(r.scrolls, 0); assert.equal(r.served, 1); assert.deepEqual(r.ids, ['801']); assert.equal(r.issue, 'Scan stopped by user');
  });
  await check('passive: Pause stops scrolling but keeps reading what the page already asked for', async () => {
    const h = await harness([]);
    const r = await passiveScan(h, { responses: [first, second, last], whileRunning: async ({ P, settle, page }) => {
      await settle(() => P.items.length > 0, 100000);
      P.paused = true;
      const at = h.clock.now;
      const scrolls = page.scrolls;
      page.queue.push(second); page.served = 2;
      await settle(() => P.items.length >= 3, 100000);
      for (let i = 0; i < 20; i++) await settle(() => false, 2000);
      assert.equal(page.scrolls, scrolls, 'no scroll while paused'); assert.equal(!!P.interval, true);
      assert(h.clock.now - at >= 20000, `paused for ${h.clock.now - at} ms, past the end rules`);
      P.paused = false;
    } });
    assert.equal(r.issue, 'Scan complete'); assert.deepEqual(r.ids, ['801', '802', '803', '804']);
  });
  await check('passive: Stop removes the arm and late responses are not added', async () => {
    const h = await harness([]);
    const r = await passiveScan(h, { responses: [first, second, last], whileRunning: async ({ P, settle, window, page, document, sessionStorage }) => {
      await settle(() => P.items.length > 0, 100000);
      window.__xbcPreviewStop();
      assert.equal(sessionStorage.getItem('xbcPassiveScan'), null, 'disarmed at once');
      // Even if the tab were armed again, a late response reaches no listener of this scan.
      sessionStorage.setItem('xbcPassiveScan', JSON.stringify({ id: 'other', until: h.clock.now + 60000 }));
      const heard = [];
      document.addEventListener('xbc:passive-record', event => heard.push(event.detail));
      page.queue.push(second);
      document.dispatchEvent(new CustomEvent('xbc:passive-drain'));
      assert.equal(heard.length, 1, 'the late response was handed over');
      for (let i = 0; i < 20; i++) await settle(() => false, 2000);
      sessionStorage.removeItem('xbcPassiveScan');
    } });
    assert.equal(r.issue, 'Scan stopped by user'); assert.deepEqual(r.ids, ['801']); assert.equal(r.done, false);
  });
  await check('passive: the scan stops before listing when the tab was not armed, cannot be read, or is not your Replies page', async () => {
    const cases = [
      [{ armed: false }, "Scan stopped: the scan was not ready when X's page loaded, so its first replies could be missing. Start a new scan."],
      [{ capturePresent: false }, 'Scan stopped: Postscrub cannot read this X tab yet. Reload the X tab, then start a new scan.'],
      [{ route: '/someone/with_replies' }, 'Scan stopped: this is not your Replies page (@synthetic_me), so nothing was listed']
    ];
    for (const [options, issue] of cases) {
      const r = await passiveScan(await harness([]), { responses: [first, last], ...options });
      assert.equal(r.issue, issue); assert.deepEqual(r.ids, []); assert.equal(r.drains, 0); assert.equal(r.done, false); assert.equal(r.arm, null);
    }
  });
  await check('passive: responses the page lost before the scan read them stop the scan', async () => {
    const r = await passiveScan(await harness([]), { responses: [[first, { overflow: 2 }], last] });
    assert.equal(r.done, false); assert.match(r.issue, /^Scan stopped after 1 item: X's page loaded replies faster than Postscrub could read them \(2 missed\)/);
  });
  await check('passive: the API client refuses to request the replies list, before any wait or request', async () => {
    const h = await harness([listPage], { capture: { UserTweets: { queryId: 'synthetic-id' }, UserTweetsAndReplies: { queryId: 'page-utr' } }, bundle: { ops: { UserTweetsAndReplies: { queryId: 'bundle-utr', featureSwitches: [], fieldToggles: [] } } } });
    const at = h.clock.now;
    const error = await listError(h.api.pages('UserTweetsAndReplies'));
    assert.equal(error?.result?.reason, 'passive_only'); assert.equal(error.result.kind, 'refused');
    assert.equal(h.calls.length, 0); assert.equal(h.clock.now, at, 'no wait either');
  });
  // API speed (VER-635): Careful doubles the pace between two actions, a stored factor below 1 is
  // floored to Normal, and the pace is a Stop-aware wait taken in steps of at most 1 s, never
  // waited after the last item. Both API job loops: Quick Clean and selected deletion.
  const speedPosts = ids => ({ data: { timeline: { instructions: [
    { type: 'TimelineAddEntries', entries: ids.map(id => ({ content: { itemContent: { tweet_results: { result: { __typename: 'Tweet', rest_id: id, legacy: { full_text: 'synthetic', user_id_str: '42' } } } } } })) },
    { type: 'TimelineTerminateTimeline', direction: 'Bottom' }
  ] } } });
  const speedFlows = [{ name: 'Quick Clean', selected: false }, { name: 'selected deletion', selected: true }];
  // Deletes two posts. `stopAfter`: ms after the first DeleteTweet at which Stop is pressed.
  const pacedRun = async (flow, { apiPace, stopAfter } = {}) => {
    let lists = 0, stoppedAt = null;
    // The first list holds the two posts; the check pass after them finds nothing left.
    const h = await harness((index, url) => url.pathname.endsWith('/UserTweets') ? { body: speedPosts(lists++ ? [] : ['p1', 'p2']) } : ok,
      { store: apiPace === undefined ? {} : { apiPace } });
    const steps = [], send = h.runtime.sendMessage;
    h.runtime.sendMessage = (message, callback) => {
      if (message.type === 'xbc:sleep') {
        // The synthetic clock moves when a step's timer is set, so this step spans [now - ms, now).
        steps.push({ ms: message.ms, end: h.clock.now });
        const first = h.calls.find(c => c.operation === 'DeleteTweet');
        const at = first && first.at + stopAfter;
        if (stopAfter != null && stoppedAt == null && first && h.clock.now - message.ms <= at && at < h.clock.now) {
          stoppedAt = at;
          h.workerWindow.__xCleanerStop();
        }
      }
      return send(message, callback);
    };
    const result = await deletion(h, flow.selected, { items: [{ id: 'p1', text: 'synthetic post' }, { id: 'p2', text: 'synthetic post' }] });
    for (let i = 0; i < 2000; i++) await Promise.resolve(); // lets the job's own loop end after its record
    const deletes = h.calls.filter(c => c.operation === 'DeleteTweet');
    const between = deletes.length > 1 ? steps.filter(s => s.end > deletes[0].at && s.end <= deletes[1].at).map(s => s.ms) : [];
    return { h, result, steps, between, stoppedAt, deletes, job: h.store.jobHistory?.[0] };
  };
  for (const flow of speedFlows) await check(`speed: Careful doubles the pace between two DeleteTweet calls in ${flow.name}, waited in steps of at most 1 s`, async () => {
    const normal = await pacedRun(flow, { apiPace: 1 }), careful = await pacedRun(flow, { apiPace: 2 });
    assert.equal(normal.deletes.length, 2); assert.equal(careful.deletes.length, 2);
    assert.equal(normal.deletes[1].at - normal.deletes[0].at, 2500, 'Normal pace');
    assert.equal(careful.deletes[1].at - careful.deletes[0].at, 5000, 'Careful pace, twice Normal');
    assert.deepEqual(normal.between, [1000, 1000, 500]); assert.deepEqual(careful.between, [1000, 1000, 1000, 1000, 1000]);
  });
  for (const flow of speedFlows) await check(`speed: a stored apiPace of 0.6 still waits the Normal pace in ${flow.name}, in steps of at most 1 s`, async () => {
    const run = await pacedRun(flow, { apiPace: 0.6 });
    assert.equal(run.deletes.length, 2);
    assert.equal(run.deletes[1].at - run.deletes[0].at, 2500, 'floored to the Normal pace');
    assert.deepEqual(run.between, [1000, 1000, 500]);
  });
  for (const flow of speedFlows) await check(`speed: Stop during a Careful pace in ${flow.name} ends the pace within 1 s, with no further request`, async () => {
    const run = await pacedRun(flow, { apiPace: 2, stopAfter: 1001 });
    assert.equal(run.stoppedAt, run.deletes[0]?.at + 1001, 'Stop was pressed during the pace');
    assert.equal(run.deletes.length, 1, 'no DeleteTweet after Stop');
    assert.deepEqual(run.h.calls.map(c => c.operation), flow.selected ? ['DeleteTweet'] : ['UserTweets', 'DeleteTweet'], 'no request after Stop');
    const ended = Math.max(...run.steps.map(s => s.end));
    assert(ended - run.stoppedAt <= 1000, `the pace ended ${ended - run.stoppedAt} ms after Stop`);
    assert.equal(run.job?.status, 'stopped'); assert.equal(run.job?.total, 1);
  });
  for (const flow of speedFlows) await check(`speed: ${flow.name} waits no pace after its last item and finishes at once`, async () => {
    const run = await pacedRun(flow, { apiPace: 2 });
    assert.equal(run.deletes.length, 2);
    const last = run.deletes.at(-1).at;
    assert.deepEqual(run.steps.filter(s => s.end > last).map(s => s.ms), [], 'no wait after the last DeleteTweet');
    assert.equal(run.job?.status, 'completed'); assert.equal(run.job?.total, 2);
    assert.equal(run.job.completedAt, last, 'finished when its last item was done');
  });
  // "Delete all posts" by date (VER-636), in Quick Clean by API: only posts strictly older than the
  // cutoff are deleted, a post without a readable date is skipped, and a cutoff the worker cannot
  // read stops the job before any request.
  const CUTOFF = { mode: 'before', date: '2024-01-01', before: '2024-01-01T00:00:00.000Z', label: 'posts before 1 Jan 2024' };
  const datedPosts = posts => ({ data: { timeline: { instructions: [
    { type: 'TimelineAddEntries', entries: posts.map(([id, created]) => ({ content: { itemContent: { tweet_results: { result: { __typename: 'Tweet', rest_id: id, legacy: { full_text: 'synthetic', user_id_str: '42', ...(created ? { created_at: created } : {}) } } } } } })) },
    { type: 'TimelineTerminateTimeline', direction: 'Bottom' }
  ] } } });
  // Lists the posts that are left; each DeleteTweet removes its post.
  const datedRun = async (posts, dateFilter, action = 'delete') => {
    const left = new Map(posts.map(post => [post[0], post])), deleted = [];
    const h = await harness((index, url, options) => {
      if (url.pathname.endsWith('/UserTweets')) return { body: datedPosts([...left.values()]) };
      const id = JSON.parse(options.body).variables.tweet_id;
      deleted.push(id); left.delete(id);
      return ok;
    });
    const result = await deletion(h, false, { action, dateFilter });
    for (let i = 0; i < 2000; i++) await Promise.resolve();
    return { h, result, deleted, job: h.store.jobHistory?.[0], record: h.store[`job_${h.store.jobHistory?.[0]?.id}`] };
  };
  await check('date filter: Quick Clean by API deletes only the posts before the cutoff and skips those without a readable date', async () => {
    const run = await datedRun([
      ['old1', 'Fri Mar 01 12:00:00 +0000 2019'], ['new1', 'Sat Feb 01 12:00:00 +0000 2025'], ['undated', null],
      ['old2', 'Sun Dec 31 23:59:59 +0000 2023'], ['edge', 'Mon Jan 01 00:00:00 +0000 2024'], ['garbled', 'not a date']
    ], CUTOFF);
    assert.deepEqual(run.deleted, ['old1', 'old2'], 'only the posts strictly older than the cutoff');
    assert.equal(run.result.stats.found, 2, 'posts outside the range are not counted as found');
    assert.equal(run.result.stats.deleted, 2);
    assert.equal(run.job.status, 'completed'); assert.equal(run.job.total, 2);
    assert.deepEqual({ ...run.job.dateFilter }, { ...CUTOFF, kept: 2, unreadable: 2 }, 'the filter and what it left are on the job');
    assert.match(run.job.statusText, /2 newer posts kept, 2 without a readable date skipped/);
    assert.deepEqual(run.record.backup.tweets.map(t => t.id), ['old1', 'old2']);
  });
  await check('date filter: Quick Clean by API with no post before the cutoff deletes nothing and says so', async () => {
    const run = await datedRun([['new1', 'Sat Feb 01 12:00:00 +0000 2025'], ['undated', null]], CUTOFF);
    assert.deepEqual(run.deleted, []);
    assert.deepEqual(run.h.calls.map(c => c.operation), ['UserTweets'], 'listed once, nothing else');
    assert.equal(run.result.stats.found, 0); assert.equal(run.job.total, 0);
    assert.match(run.job.statusText, /^Finished — no posts in the date range, nothing deleted; 1 newer post kept, 1 without a readable date skipped$/);
  });
  await check('date filter: Quick Clean by API whose in-range deletions all fail is not reported as an empty range', async () => {
    const left = new Map([['old1', 'Fri Mar 01 12:00:00 +0000 2019'], ['new1', 'Sat Feb 01 12:00:00 +0000 2025']]);
    const h = await harness((index, url) => url.pathname.endsWith('/UserTweets')
      ? { body: datedPosts([...left.entries()]) }
      : { status: 500, body: { errors: [{ code: 131, message: 'synthetic internal error' }] } });
    const result = await deletion(h, false, { action: 'delete', dateFilter: CUTOFF });
    for (let i = 0; i < 2000; i++) await Promise.resolve();
    const job = h.store.jobHistory?.[0];
    assert(h.calls.some(c => c.operation === 'DeleteTweet'), 'the in-range post was tried');
    assert.equal(result.stats.found, 1); assert.equal(result.stats.deleted || 0, 0);
    assert.notEqual(job?.status, 'completed', 'a run that deleted nothing it found is not completed');
    assert.doesNotMatch(job?.statusText || result.issue || '', /no posts in the date range/);
    assert.match(job?.statusText || result.issue || '', /1 found, none deleted/);
  });
  for (const [label, dateFilter, action] of [
    ['an unreadable cutoff', { ...CUTOFF, before: 'not a date' }, 'delete'],
    ['a cutoff that is not an ISO time', { ...CUTOFF, before: '1' }, 'delete'],
    ['a filter given to another action', CUTOFF, 'unlike']
  ]) await check(`date filter: ${label} stops Quick Clean before any request`, async () => {
    const run = await datedRun([['old1', 'Fri Mar 01 12:00:00 +0000 2019']], dateFilter, action);
    assert.equal(run.h.calls.length, 0, 'no list and no deletion');
    assert.match(run.result.issue, /date range could not be read/);
    assert.equal(run.job.status, 'interrupted'); assert.equal(run.job.total, 0);
  });
  console.log(`${passed}/${passed + failures.length} synthetic API limit checks passed (not browser e2e)`);
  assert.equal(failures.length, 0, `${failures.length} synthetic API limit checks failed`);
}
