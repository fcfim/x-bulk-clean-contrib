// Real client + serialized workers. All transport, clocks, accounts and DOM are synthetic.
import assert from 'node:assert/strict';
import { harness, scan, deletion } from './api-limits.mjs';
const START = 1800000000000;
const error = (status, code, headers = {}) => ({ status, headers, body: { errors: [{ code, message: 'synthetic API error' }] } });
const mutation = { status: 200, body: { data: { delete_tweet: 'Done' } } };
export function timeline(ids = [], cursor = null, { end = false, errors, malformed = false } = {}) {
  const entries = ids.map(id => ({ content: { itemContent: { tweet_results: { result: {
    __typename: 'Tweet', rest_id: id, legacy: { full_text: 'synthetic post', user_id_str: '42' }
  } } } } }));
  if (cursor !== null) entries.push({ content: { cursorType: 'Bottom', value: cursor } });
  return { ...(errors ? { errors } : {}), data: { user: { result: { timeline: { timeline: { instructions: [
    { type: 'TimelineAddEntries', entries: malformed ? {} : entries },
    ...(end ? [{ type: 'TimelineTerminateTimeline', direction: 'Bottom' }] : [])
  ] } } } } } };
}
const response = (ids, cursor = null, options = {}) => ({ status: 200, body: timeline(ids, cursor, options) });
async function collect(h, options, operation = 'UserTweets') {
  const ids = [], users = [], pages = []; let failure = null, end = null;
  try {
    const iterator = h.api.pages(operation, options);
    for (;;) {
      const next = await iterator.next();
      if (next.done) { end = next.value; break; }
      pages.push(next.value); ids.push(...next.value.tweets.map(t => t.id)); users.push(...next.value.users.map(u => u.id));
    }
  } catch (e) { failure = { kind: e.result?.kind, reason: e.result?.reason, message: e.message }; }
  return { ids, users, pages: pages.length, failure, end, requests: h.calls.length };
}

export async function testApiPagination() {
  let passed = 0; const failures = [];
  const check = async (name, fn) => { try { await fn(); passed++; console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.log(`FAIL ${name}: ${error.message}`); } };
  await check('ten empty advancing pages interrupt at request 10 without an eleventh', async () => {
    const specs = [...Array.from({ length: 10 }, (_, i) => response([], `c${i}`)), response(['9001'], null, { end: true })];
    const h = await harness(specs); const r = await collect(h);
    assert.equal(r.requests, 10); assert.equal(r.failure?.kind, 'incomplete'); assert.equal(r.failure?.reason, 'empty_streak'); assert.equal(r.ids.length, 0);
  });
  await check('nine empty advancing pages still reach a post on page 10', async () => {
    const h = await harness([...Array.from({ length: 9 }, (_, i) => response([], `c${i}`)), response(['9001'], null, { end: true })]);
    const r = await collect(h); assert.equal(r.requests, 10); assert.equal(r.ids.join(','), '9001'); assert.equal(r.failure, null);
  });
  await check('new tweets reset the empty-page streak rather than a cumulative count', async () => {
    const h = await harness([...Array.from({ length: 9 }, (_, i) => response([], `a${i}`)), response(['9001'], 'after-a'), ...Array.from({ length: 9 }, (_, i) => response([], `b${i}`)), response(['9002'], null, { end: true })]);
    const r = await collect(h); assert.equal(r.requests, 20); assert.equal(r.ids.join(','), '9001,9002'); assert.equal(r.failure, null);
  });
  await check('ten duplicate-only advancing pages count as no new items', async () => {
    const h = await harness([response(['9001'], 'first'), ...Array.from({ length: 10 }, (_, i) => response(['9001'], `c${i}`)), response(['9002'], null, { end: true })]);
    const r = await collect(h); assert.equal(r.requests, 11); assert.equal(r.ids.join(','), '9001'); assert.equal(r.failure?.reason, 'empty_streak');
  });
  await check('new users also reset the empty-page streak', async () => {
    const userResponse = (ids, cursor, end = false) => {
      const body = timeline([], cursor, { end });
      body.data.user.result.timeline.timeline.instructions[0].entries.unshift(...ids.map(id => ({ content: { itemContent: { itemType: 'TimelineUser', user_results: { result: { __typename: 'User', rest_id: id, core: { screen_name: `synthetic_${id}` } } } } } })));
      return { status: 200, body };
    };
    const h = await harness([...Array.from({ length: 9 }, (_, i) => userResponse([], `a${i}`)), userResponse(['901'], 'after-a'), ...Array.from({ length: 9 }, (_, i) => userResponse([], `b${i}`)), userResponse(['902'], null, true)]);
    const r = await collect(h, undefined, 'Following'); assert.equal(r.requests, 20); assert.equal(r.users.join(','), '901,902'); assert.equal(r.failure, null);
  });
  await check('explicit end keeps precedence over the empty-page heuristic', async () => {
    const h = await harness([...Array.from({ length: 9 }, (_, i) => response([], `c${i}`)), response([], null, { end: true })]);
    const r = await collect(h); assert.equal(r.requests, 10); assert.equal(r.failure, null); assert.equal(r.end?.reason, 'explicit_end');
  });
  await check('real scanner empty streak reports interruption and no automatic DOM', async () => {
    const h = await harness([...Array.from({ length: 10 }, (_, i) => response([], `c${i}`)), response(['9001'], null, { end: true })]);
    const p = await scan(h); assert.equal(h.calls.length, 10); assert.equal(p.done, false); assert.equal(p.items.length, 0); assert.equal(p.domStarted, false); assert.equal(!!p.apiFallback, false); assert(!/Scan complete/.test(p.issue)); assert.match(p.issue, /10 consecutive pages without new items/); assert.match(p.issue, /Try again/);
  });
  await check('two empty advancing pages reach the later post', async () => {
    const h = await harness([response([], 'c1'), response([], 'c2'), response(['9001'], null, { end: true })]);
    const r = await collect(h); assert.equal(r.ids.join(','), '9001'); assert.equal(r.requests, 3); assert.equal(r.failure, null);
  });
  await check('duplicate-only advancing pages reach the later distinct post', async () => {
    const h = await harness([response(['9001'], 'c1'), response(['9001'], 'c2'), response(['9001'], 'c3'), response(['9002'], null, { end: true })]);
    const r = await collect(h); assert.equal(r.ids.join(','), '9001,9002'); assert.equal(r.requests, 4); assert.equal(r.failure, null);
  });
  for (const [name, specs, reason] of [
    ['cycle', [response(['9001'], 'c1'), response(['9002'], 'c2'), response(['9001'], 'c1')], 'cursor_cycle'],
    ['stalled', [response(['9001'], 'c1'), response(['9002'], 'c1')], 'cursor_stalled'],
    ['missing cursor', [response(['9001'])], 'missing_cursor'],
    ['invalid data', [{ status: 200, body: { data: {} } }], 'invalid_timeline'],
    ['malformed instructions', [response(['9001'], null, { end: true, malformed: true })], 'invalid_timeline']
  ]) await check(`${name} is a distinct interruption, not normal completion`, async () => {
    const h = await harness(specs); const r = await collect(h);
    assert.equal(r.failure?.kind, 'incomplete'); assert.equal(r.failure?.reason, reason); assert.equal(r.requests, specs.length);
  });
  await check('explicit end completes a nonempty recognized timeline', async () => {
    const h = await harness([response(['9001'], 'ignored', { end: true })]); const r = await collect(h);
    assert.equal(r.failure, null); assert.equal(r.ids.join(','), '9001'); assert.equal(r.requests, 1);
  });
  await check('finite page budget interrupts without requesting page 2001', async () => {
    // Keep every page productive: empty pages have their own smaller safety budget.
    const h = await harness(index => response([String(9000000 + index)], `c${index}`), { requestBudget: 2100 }); const r = await collect(h);
    assert.equal(r.requests, 2000); assert.equal(r.ids.length, 2000); assert.equal(r.failure?.reason, 'page_budget');
  });
  await check('cancellation during pacing is distinct and prevents the next request', async () => {
    let active = true;
    const h = await harness([response(['9001'], 'c1')], { onSleep: () => { active = false; } });
    const r = await collect(h, { isActive: () => active }); assert.equal(r.requests, 1); assert.equal(r.failure?.reason, 'cancelled');
  });
  await check('partial HTTP200 keeps parsed items and reports an interruption', async () => {
    const h = await harness([response(['9001'], null, { end: true, errors: [{ code: 999, message: 'synthetic partial result' }] })]);
    const r = await collect(h); assert.equal(r.ids.join(','), '9001'); assert.equal(r.failure?.reason, 'partial_response');
  });
  for (const [name, specs, expectedCount, expectedDone] of [
    ['empty pages then post', [response([], 'c1'), response([], 'c2'), response(['9001'], null, { end: true })], 1, true],
    ['duplicate pages then distinct post', [response(['9001'], 'c1'), response(['9001'], 'c2'), response(['9001'], 'c3'), response(['9002'], null, { end: true })], 2, true],
    ['cycle', [response(['9001'], 'c1'), response(['9002'], 'c2'), response(['9001'], 'c1')], 2, false],
    ['missing cursor', [response(['9001'])], 1, false],
    ['invalid shape', [{ status: 200, body: { data: {} } }], 0, false],
    ['explicit empty end', [response([], null, { end: true })], 0, false],
    ['partial response', [response(['9001'], null, { end: true, errors: [{ code: 999 }] })], 1, false],
    ['server error after first page', [response(['9001'], 'c1'), ...Array.from({ length: 4 }, () => error(500, 130))], 1, false]
  ]) await check(`real scanner ${name}: count/state remain truthful without DOM`, async () => {
    const h = await harness(specs); const p = await scan(h);
    assert.equal(p.items.length, expectedCount); assert.equal(p.done, expectedDone); assert.equal(p.mode, 'api'); assert.equal(!!p.apiFallback, false); assert.equal(p.domStarted, false);
    if (expectedDone) assert.equal(p.issue, 'Scan complete');
    else { assert(!/Scan complete/.test(p.issue)); assert.match(p.issue, new RegExp(String(expectedCount))); }
  });
  await check('real scanner user Stop preserves the first item and its reason', async () => {
    let h; h = await harness([response(['9001'], 'c1')], { onSleep: () => h.workerWindow?.__xbcPreviewStop?.() });
    const p = await scan(h); assert.equal(p.done, false); assert.equal(p.items.length, 1); assert.equal(h.calls.length, 1); assert.match(p.issue, /stopped by user/i); assert.equal(p.domStarted, false);
  });
  await check('quick clean zero result is interrupted, without an automatic mutation or DOM', async () => {
    const h = await harness([response([], null, { end: true })]); const x = await deletion(h);
    assert.equal(x.mode, 'api'); assert.equal(x.domStarted, false); assert.equal(x.apiFallback, null); assert.match(x.issue, /0/); assert(!/^Finished/.test(x.issue)); assert.equal(h.calls.length, 1);
  });
  await check('quick clean does not act on an uncertain partial page', async () => {
    const h = await harness([response(['9001'], null, { end: true, errors: [{ code: 999 }] }), mutation]); const x = await deletion(h);
    assert.equal(x.successCount, 0); assert.equal(h.calls.length, 1); assert.equal(x.domStarted, false); assert(!/^Finished/.test(x.issue));
  });
  await check('quick clean page error preserves successful history without claiming completion', async () => {
    const h = await harness([response(['9001'], 'c1'), mutation, ...Array.from({ length: 4 }, () => error(500, 130))]);
    const x = await deletion(h); assert.equal(x.successCount, 1); assert.equal(h.store.jobHistory[0].total, 1); assert.equal(h.store.jobHistory[0].status, 'interrupted'); assert(!/^Finished/.test(x.issue)); assert.equal(x.domStarted, false);
  });
  await check('quick clean pass safety limit is interrupted after recorded successes', async () => {
    const h = await harness([response(['9001'], null, { end: true }), mutation, response(['9002'], null, { end: true }), mutation, response(['9003'], null, { end: true }), mutation]);
    const x = await deletion(h); assert.equal(x.successCount, 3); assert.equal(h.calls.length, 6); assert.match(x.issue, /pass safety limit/); assert.equal(h.store.jobHistory[0].status, 'interrupted');
  });
  for (const instruction of ['TimelineReplaceEntry', 'TimelineAddToModule']) await check(`recognized ${instruction} preserves item parsing and explicit end`, async () => {
    const body = timeline(['9001'], null, { end: true }); const instructions = body.data.user.result.timeline.timeline.instructions;
    const entry = instructions[0].entries[0];
    instructions[0] = instruction === 'TimelineReplaceEntry' ? { type: instruction, entry } : { type: instruction, moduleItems: [{ item: entry.content }] };
    const h = await harness([{ status: 200, body }]); const r = await collect(h); assert.equal(r.ids.join(','), '9001'); assert.equal(r.failure, null);
  });
  await check('malformed null entry does not prove timeline completion', async () => {
    const body = timeline([], null, { end: true }); body.data.user.result.timeline.timeline.instructions[0].entries = [null];
    const r = await collect(await harness([{ status: 200, body }])); assert.equal(r.failure?.reason, 'invalid_timeline');
  });
  await check('unsupported instruction cannot turn partial data into explicit completion', async () => {
    const body = timeline(['9001'], null, { end: true }); body.data.user.result.timeline.timeline.instructions.push({ type: 'SyntheticUnknownInstruction' });
    const h = await harness([{ status: 200, body }]); const r = await collect(h); assert.equal(r.ids.join(','), '9001'); assert.equal(r.failure?.reason, 'partial_response');
  });
  for (const [name, run, specs] of [
    ['scanner', h => scan(h), [{ status: 400, body: {} }]],
    ['quick clean', h => deletion(h), [response(['9001'], null, { end: true }), { status: 403, body: {} }]],
    ['selected delete', h => deletion(h, true), [{ status: 403, body: {} }]]
  ]) await check(`${name} offers a new explicit retry/manual job instead of automatic fallback`, async () => {
    const h = await harness(specs); const r = await run(h);
    assert.equal(r.domStarted, false); assert.equal(!!r.apiFallback, false); assert.match(r.issue, /try again|retry/i); assert.match(r.issue, /turn off API/i);
  });
  for (const spec of [error(429, 88, { 'x-rate-limit-reset': String(START / 1000 + 3600) }), error(429, 344), error(429, 226), { status: 403, headers: { 'Retry-After': '3600' }, body: {} }]) await check(`scanner restriction ${spec.status}/${spec.body.errors?.[0]?.code || 'cooldown'} never offers DOM`, async () => {
    const h = await harness([spec]); const r = await scan(h);
    assert.equal(r.done, false); assert.equal(r.domStarted, false); assert.equal(!!r.apiFallback, false); assert(!/turn off API/i.test(r.issue));
  });
  console.log(`${passed}/${passed + failures.length} synthetic API pagination checks passed (not browser e2e)`);
  assert.equal(failures.length, 0, `${failures.length} pagination checks failed`);
}
