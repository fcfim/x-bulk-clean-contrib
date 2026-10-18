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
] }] } } });

async function harness(responses, { store = {}, clock = { now: START }, account = '42', queryId = 'synthetic-id', onSleep, failGet = false, failSet = false, onGet, beforeSet, afterSet } = {}) {
  const calls = [], sleeps = [];
  let responseIndex = 0, initialized = false;
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const schedule = (fn, ms = 0) => { sleeps.push(ms); clock.now += Math.max(0, ms); onSleep?.(ms); queueMicrotask(fn); return 1; };
  const runtime = { sendMessage(message, callback) { if (message.type === 'xbc:sleep') { callback?.(); return; } return Promise.resolve({ ok: false }); } };
  const math = Object.create(Math); math.random = () => 0;
  const context = vm.createContext({ URL, URLSearchParams, Date: ClockDate, Math: math, console, setTimeout: schedule, crypto: { randomUUID: () => `synthetic-${++syntheticUuid}` },
    location: { origin: 'https://x.com' }, document: { cookie: `ct0=synthetic; twid=u%3D${account}`, scripts: [], documentElement: { lang: 'en', dataset: { xbcApi: JSON.stringify({ viewerId: account, ops: { UserTweets: { queryId }, DeleteTweet: { queryId } } }) } } },
    chrome: { runtime, storage: { local: {
      get: async keys => { if (failGet && (keys == null || keys.some(k => k.startsWith('xbcApiCooldown:')))) throw new Error('synthetic storage failure'); const value = Object.fromEntries((keys ?? Object.keys(store)).filter(k => k in store).map(k => [k, clone(store[k])])); if (initialized) await onGet?.(keys, value); return value; },
      remove: async keys => { for (const key of keys) delete store[key]; },
      set: async values => { if (failSet && Object.keys(values).some(k => k.startsWith('xbcApiCooldown:'))) throw new Error('synthetic storage failure'); await beforeSet?.(values); Object.assign(store, clone(values)); afterSet?.(values); }
    } } },
    fetch: async (url, options) => {
      calls.push({ at: clock.now, operation: url.pathname.split('/').at(-1), method: options.method });
      assert(calls.length <= 50, 'finite synthetic request budget');
      const spec = await responses[responseIndex++];
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

async function scan(h, { useApi = true, type = 'tweets' } = {}) {
  const window = { innerHeight: 800, scrollY: 0, scrollTo() {}, scrollBy() {}, dispatchEvent() {} };
  const globals = { window, __xbcApi: useApi ? h.api : undefined, Date: h.Date, setTimeout: h.schedule, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, Event: class {}, console: { warn() {} }, chrome: { runtime: h.runtime, storage: h.storage },
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
  const result = { ...window.__xbcPreview, domStarted: !!window.__xbcPreview.interval?.loop };
  if (window.__xbcPreview.interval) window.__xbcPreviewStop();
  return result;
}

// Execute the complete real workers; synthetic DOM nodes only support rendering overlays.
async function deletion(h, selected = false, { useApi = true, action = 'delete', type = 'tweets' } = {}) {
  const node = () => ({ style: {}, classList: { add() {}, remove() {} }, addEventListener() {}, remove() {}, appendChild() {}, setAttribute() {},
    querySelector: () => node(), getElementById: () => node(), attachShadow: () => node() });
  const window = { innerHeight: 800, scrollY: 0, scrollTo() {}, scrollBy() {}, dispatchEvent() {} };
  const globals = { window, __xbcApi: useApi ? h.api : undefined, Date: h.Date, Math, setTimeout: h.schedule, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, Event: class {}, navigator: {}, crypto: { randomUUID: () => `synthetic-job-${++syntheticUuid}` },
    console: { warn() {}, info() {} }, chrome: { runtime: h.runtime, storage: h.storage },
    document: { cookie: h.document.cookie, body: node(), hidden: false, visibilityState: 'visible', documentElement: { scrollHeight: 10 }, addEventListener() {}, createElement: node, getElementById: () => null,
      querySelector: selector => selector.includes('AppTabBar_Profile_Link') ? { getAttribute: () => '/synthetic_me' } : null, querySelectorAll: () => [] } };
  const definitions = vm.createContext({ ...globals });
  vm.runInContext(selected ? panelSource : popupSource, definitions);
  const context = vm.createContext({ ...globals });
  const serialized = selected ? definitions.runSelectedDelete : definitions.runWorker;
  vm.runInContext('globalThis.worker = ' + serialized.toString(), context);
  h.workerWindow = window;
  if (selected) context.worker(type, [{ id: 'synthetic-selected', text: 'synthetic post' }], { username: 'synthetic_me' }, false, useApi);
  else context.worker(action, false, { username: 'synthetic_me' }, useApi);
  for (let i = 0; i < 20000; i++) {
    await Promise.resolve();
    if (window.__xCleaner?.historyPersisted || window.__xCleaner?.apiFallback || (!useApi && window.__xCleaner?.interval?.loop)) break;
  }
  const x = window.__xCleaner;
  assert(x.historyPersisted || x.apiFallback || (!useApi && x.interval?.loop), 'worker settled or entered DOM');
  const result = { domStarted: !!x.interval?.loop, mode: x.mode, apiFallback: x.apiFallback || null, issue: x.issue, historyPersisted: x.historyPersisted, successCount: x.successCount };
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
  for (const selected of [false, true]) for (const active of [false, true]) await check(`API unavailable ${selected ? 'selected' : 'quick'} delete ${active ? 'stops on known cooldown' : 'preserves unrestricted fallback'}`, async () => {
    const store = active ? { 'xbcApiCooldown:42:DeleteTweet:claim:unavailable': { until: START + 3600000, blocked: true } } : {};
    const h = await harness([], { store }); h.api.init = async () => ({ ok: false, reason: 'synthetic unavailable' });
    const x = await deletion(h, selected); assert.equal(!!x.apiFallback, !active); assert.match(x.issue || '', active ? /suspended/ : /^$/); assert.equal(h.calls.length, 0);
  });
  for (const active of [false, true]) await check(`API unavailable scanner ${active ? 'stops on known cooldown' : 'preserves unrestricted fallback'}`, async () => {
    const store = active ? { 'xbcApiCooldown:42:UserTweets:claim:unavailable': { until: START + 3600000 } } : {};
    const h = await harness([], { store }); h.api.init = async () => ({ ok: false, reason: 'synthetic unavailable' });
    const p = await scan(h); assert.equal(!!p.apiFallback, !active); if (active) assert.match(p.issue, /suspended/); assert.equal(h.calls.length, 0);
  });
  const quickActions = {
    delete: ['UserTweets', 'DeleteTweet'], deleteReplies: ['UserTweetsAndReplies', 'DeleteTweet'], unrepost: ['UserTweets', 'DeleteRetweet'],
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
  await check('plain refusal without a valid deadline preserves direct/scanner/delete fallback contracts', async () => {
    const spec = { status: 403, headers: { 'Retry-After': 'invalid', 'x-rate-limit-remaining': 'invalid' }, body: {} };
    const direct = await harness([spec]); assert.equal((await direct.api.deleteTweet('synthetic')).kind, 'refused');
    const h = await harness([spec]); const p = await scan(h); assert.equal(p.mode, 'dom'); assert(!!p.apiFallback);
    for (const selected of [false, true]) {
      const x = await deletion(await harness(selected ? [spec] : [{ body: timeline(null) }, spec]), selected);
      assert.equal(x.mode, 'dom'); assert(!!x.apiFallback);
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
    for await (const _ of h.api.pages('UserTweets', { isActive: () => active })) { /* consume */ }
    assert.equal(h.calls.length, 1);
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
  console.log(`${passed}/${passed + failures.length} synthetic API limit checks passed (not browser e2e)`);
  assert.equal(failures.length, 0, `${failures.length} synthetic API limit checks failed`);
}
