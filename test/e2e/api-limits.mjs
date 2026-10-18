// Real client and scan worker with synthetic transport, clock, storage and DOM.
// No network implementation is installed. Run through run.mjs --api-limits.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const apiSource = fs.readFileSync(new URL('../../src/worker/xapi.js', import.meta.url), 'utf8');
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

async function harness(responses, { store = {}, clock = { now: START }, account = '42', queryId = 'synthetic-id', onSleep, failGet = false, failSet = false } = {}) {
  const calls = [], sleeps = [];
  let responseIndex = 0;
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [clock.now])); }
    static now() { return clock.now; }
  }
  const schedule = (fn, ms = 0) => { sleeps.push(ms); clock.now += Math.max(0, ms); onSleep?.(ms); queueMicrotask(fn); return 1; };
  const runtime = { sendMessage(message, callback) { if (message.type === 'xbc:sleep') { callback?.(); return; } return Promise.resolve({ ok: false }); } };
  const math = Object.create(Math); math.random = () => 0;
  const context = vm.createContext({ URL, URLSearchParams, Date: ClockDate, Math: math, console, setTimeout: schedule,
    location: { origin: 'https://x.com' }, document: { cookie: `ct0=synthetic; twid=u%3D${account}`, scripts: [], documentElement: { lang: 'en', dataset: { xbcApi: JSON.stringify({ viewerId: account, ops: { UserTweets: { queryId }, DeleteTweet: { queryId } } }) } } },
    chrome: { runtime, storage: { local: {
      get: async keys => { if (failGet && keys.some(k => k.startsWith('xbcApiCooldown:'))) throw new Error('synthetic storage failure'); return Object.fromEntries(keys.filter(k => k in store).map(k => [k, clone(store[k])])); },
      set: async values => { if (failSet && Object.keys(values).some(k => k.startsWith('xbcApiCooldown:'))) throw new Error('synthetic storage failure'); Object.assign(store, clone(values)); }
    } } },
    fetch: async (url, options) => {
      calls.push({ at: clock.now, operation: url.pathname.split('/').at(-1), method: options.method });
      assert(calls.length <= 50, 'finite synthetic request budget');
      const spec = responses[responseIndex++];
      assert(spec, `unplanned synthetic request ${calls.length}`);
      const headers = Object.fromEntries(Object.entries(spec.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
      return { status: spec.status ?? 200, headers: { get: name => headers[name.toLowerCase()] ?? null }, json: async () => clone(spec.body) };
    }
  });
  vm.runInContext(apiSource, context);
  const api = context.__xbcApi;
  await api.init({ username: 'synthetic_me' });
  return { api, calls, sleeps, store, clock, schedule, Date: ClockDate, runtime };
}

async function scan(h) {
  const window = { innerHeight: 800, scrollY: 0, scrollTo() {}, scrollBy() {}, dispatchEvent() {} };
  const context = vm.createContext({ window, __xbcApi: h.api, Date: h.Date, setTimeout: h.schedule, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, Event: class {}, console: { warn() {} }, chrome: { runtime: h.runtime },
    document: { hidden: false, visibilityState: 'visible', documentElement: { scrollHeight: 10 }, addEventListener() {}, querySelector: selector => selector.includes('AppTabBar_Profile_Link') ? { getAttribute: () => '/synthetic_me' } : null, querySelectorAll: () => [] } });
  vm.runInContext(panelSource, context);
  context.startPreviewScanner('tweets', { username: 'synthetic_me' }, false, 'fast', true);
  for (let i = 0; i < 20000 && window.__xbcPreview?.interval; i++) await Promise.resolve();
  assert.equal(window.__xbcPreview.interval, null, 'scan settled');
  return window.__xbcPreview;
}

export async function testApiLimits() {
  let passed = 0;
  const failures = [];
  const check = async (name, fn) => {
    try { await fn(); passed++; console.log(`PASS ${name}`); }
    catch (error) { failures.push({ name, error }); console.log(`FAIL ${name}: ${error.message}`); }
  };
  await check('reset one hour away suspends with full persisted deadline, without retry', async () => {
    const h = await harness([rate(reset(3600))]);
    const r = await h.api.deleteTweet('synthetic');
    assert.equal(r.kind, 'stop'); assert.equal(r.retryAt, START + 3610000); assert.equal(h.calls.length, 1); assert.equal(h.clock.now, START);
    assert.equal(h.store['xbcApiCooldown:42:DeleteTweet'].until, r.retryAt);
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
    assert.equal(h.store['xbcApiCooldown:42:DeleteTweet'].until, START + 48 * 3600000 + 10000);
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
