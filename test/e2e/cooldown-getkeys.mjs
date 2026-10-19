// Run with Node 22: node test/e2e/cooldown-getkeys.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import { harness, deletion, scan } from './api-limits.mjs';
import { START, PREFIX, clone, records, storage, cooldowns, cooldownRead } from './cooldown-fixture.mjs';

const job = () => ({ me: { id: '42' }, slowdown: 4 });
const expected = { until: START + 900000, slowdown: 8, blocked: true, reason: 'blocked' };

for (const modern of [true, false]) {
  const mode = modern ? 'getKeys' : 'legacy';
  test(`${mode}: read preserves aggregation, legacy key, account and operation isolation`, async () => {
    const store = records(), before = clone(store), adapter = storage(store, { modern });
    assert.deepEqual(clone(await cooldowns(adapter.local).readCooldown(job(), 'DeleteTweet')), expected);
    assert.deepEqual(store, before, 'read must not migrate, write, or remove claims');
    if (modern) {
      assert.equal(adapter.keyCalls, 1);
      assert.deepEqual(adapter.gets, [[PREFIX, ...['blocked', 'long', 'expired'].map(id => PREFIX + ':claim:' + id)]]);
    } else assert.deepEqual(adapter.gets, [null]);
  });

  test(`${mode}: prune removes only expired immutable claims, including other buckets`, async () => {
    const store = records(), before = clone(store), adapter = storage(store, { modern });
    await cooldowns(adapter.local).pruneCooldowns();
    const expired = [PREFIX + ':claim:expired', 'xbcApiCooldown:99:Likes:claim:expired'];
    assert.deepEqual(adapter.removes, [expired]);
    for (const key of expired) delete before[key];
    assert.deepEqual(store, before, 'legacy keys and unrelated data must survive');
    assert.equal(adapter.sets.length, 0);
    if (modern) assert(adapter.gets[0].every(key => key.startsWith('xbcApiCooldown:') && key.includes(':claim:')));
    else assert.deepEqual(adapter.gets, [null]);
  });

  test(`${mode}: simultaneous short and long responses retain both immutable claims`, async () => {
    const store = {};
    let writes = 0, release;
    const barrier = new Promise(resolve => { release = resolve; });
    const adapter = storage(store, { modern, afterSet: async () => { if (++writes === 2) release(); await barrier; } });
    const subject = cooldowns(adapter.local);
    const results = await Promise.all([
      subject.rememberCooldown(job(), 'DeleteTweet', { until: START + 900000, reason: 'long', blocked: true }),
      subject.rememberCooldown({ ...job(), slowdown: 2 }, 'DeleteTweet', { until: START + 1000, reason: 'short' })
    ]);
    const keys = Object.keys(store);
    assert.equal(keys.length, 2);
    assert(keys.every(key => key.startsWith(PREFIX + ':claim:')));
    assert.equal(adapter.sets.length, 2);
    assert(adapter.sets.every(values => Object.keys(values).length === 1));
    for (const result of results) assert.deepEqual(clone(result), { until: START + 900000, reason: 'long', blocked: true, slowdown: 4 });
    assert.equal(store[keys[0]].until, START + 900000);
    assert.equal(store[keys[1]].until, START + 1000);
  });

  test(`${mode}: prune snapshot cannot erase a concurrent active claim`, async () => {
    const store = { [PREFIX + ':claim:expired']: { until: START - 1 }, [PREFIX]: { until: START - 1 } };
    const active = PREFIX + ':claim:concurrent';
    const adapter = storage(store, { modern, beforeRemove: () => { store[active] = { until: START + 900000, blocked: true }; } });
    await cooldowns(adapter.local).pruneCooldowns();
    assert.equal(store[active].until, START + 900000);
    assert.deepEqual(Object.keys(store), [PREFIX, active]);
  });

  test(`${mode}: read and prune propagate get rejection without mutation`, async () => {
    for (const method of ['readCooldown', 'pruneCooldowns']) {
      const store = records(), before = clone(store), adapter = storage(store, { modern, failGet: () => true });
      await assert.rejects(cooldowns(adapter.local)[method](job(), 'DeleteTweet'), /synthetic get rejected/);
      assert.deepEqual(store, before);
      assert.equal(adapter.removes.length + adapter.sets.length, 0);
    }
  });
}

test('getKeys rejection propagates from read/prune without falling back to get(null)', async () => {
  for (const method of ['readCooldown', 'pruneCooldowns']) {
    const adapter = storage(records(), { failKeys: true });
    await assert.rejects(cooldowns(adapter.local)[method](job(), 'DeleteTweet'), /synthetic getKeys rejected/);
    assert.equal(adapter.keyCalls, 1);
    assert.deepEqual(adapter.gets, []);
    assert.equal(adapter.removes.length + adapter.sets.length, 0);
  }
});

test('a claim added after key enumeration persists and is observed on the next snapshot', async () => {
  const store = {};
  const adapter = storage(store, { afterKeys: () => { store[PREFIX + ':claim:late'] = { until: START + 900000, blocked: true }; } });
  const subject = cooldowns(adapter.local);
  assert.equal((await subject.readCooldown(job(), 'DeleteTweet')).until, 0);
  assert.equal((await subject.readCooldown(job(), 'DeleteTweet')).until, START + 900000);
  assert.equal(Object.keys(store).length, 1);
  assert.equal(adapter.sets.length + adapter.removes.length, 0);
});

test('modern read and prune never deserialize a large unrelated history value', async () => {
  const store = records();
  Object.defineProperty(store, 'jobHistory', { enumerable: true, get() { throw new Error('history must not be read'); } });
  const subject = cooldowns(storage(store).local);
  assert.deepEqual(clone(await subject.readCooldown(job(), 'DeleteTweet')), expected);
  await subject.pruneCooldowns();
});

test('a present but non-callable getKeys uses the unchanged legacy read and prune', async () => {
  const adapter = storage(records(), { modern: false });
  adapter.local.getKeys = 'not a function';
  const subject = cooldowns(adapter.local);
  assert.deepEqual(clone(await subject.readCooldown(job(), 'DeleteTweet')), expected);
  await subject.pruneCooldowns();
  assert.deepEqual(adapter.gets, [null, null]);
});

// The existing harness serializes each complete worker into a fresh VM, like executeScript.
// Replace only the synthetic storage API after init; no getKeys is injected into page globals.
const flows = [
  { name: 'popup Quick Clean', run: h => deletion(h, false, { useApi: false }), operations: ['UserTweets', 'DeleteTweet'] },
  { name: 'sidepanel preview', run: h => scan(h, { useApi: false }), operations: ['UserTweets'] },
  { name: 'sidepanel selected delete', run: h => deletion(h, true, { useApi: false }), operations: ['UserTweets', 'DeleteTweet'] }
];
async function flowHarness(store, options) {
  const h = await harness([]);
  Object.assign(h.store, store);
  const adapter = storage(h.store, options);
  h.storage.local = adapter.local;
  return { h, adapter };
}

for (const flow of flows) for (const modern of [true, false]) {
  const mode = modern ? 'getKeys' : 'legacy';
  test(`${flow.name} isolated worker / ${mode}: maximum deadline and selective reads`, async () => {
    const list = 'xbcApiCooldown:42:UserTweets';
    const store = { ...records(), [list]: { until: START + 2000000 }, [list + ':claim:long']: { until: START + 3000000 } };
    const { h, adapter } = await flowHarness(store, { modern });
    const result = await flow.run(h);
    assert.equal(result.domStarted, false);
    assert.ok(result.issue.includes(new Date(START + 3000000).toISOString()));
    assert.equal(h.calls.length, 0);
    if (modern) {
      assert.equal(adapter.keyCalls, 1);
      const allowed = flow.operations.flatMap(op => Object.keys(store).filter(key => key === `xbcApiCooldown:42:${op}` || key.startsWith(`xbcApiCooldown:42:${op}:claim:`)));
      assert.deepEqual([...adapter.gets[0]].sort(), allowed.sort());
      assert(adapter.gets.every(keys => keys !== null));
    } else assert.equal(adapter.gets[0], null);
    assert(adapter.sets.every(values => Object.keys(values).every(key => !key.startsWith('xbcApiCooldown:'))));
  });

  test(`${flow.name} isolated worker / ${mode}: expired and unrelated claims allow DOM`, async () => {
    const store = records();
    delete store[PREFIX]; delete store[PREFIX + ':claim:blocked']; delete store[PREFIX + ':claim:long'];
    const { h } = await flowHarness(store, { modern });
    const result = await flow.run(h);
    assert.equal(result.domStarted, true);
    assert.equal(h.calls.length, 0);
  });

  test(`${flow.name} isolated worker / ${mode}: independent claims remain immutable across jobs`, async () => {
    const bucket = `xbcApiCooldown:42:${flow.operations[0]}`;
    const short = bucket + ':claim:short', long = bucket + ':claim:long';
    const shortValue = { until: START + 1000, reason: 'short' };
    const longValue = { until: START + 900000, reason: 'long', blocked: true };
    const { h } = await flowHarness({ [short]: shortValue }, { modern });
    // Another writer adds its own claim, never replacing the first writer's key.
    h.store[long] = clone(longValue);
    const result = await flow.run(h);
    assert.equal(result.domStarted, false);
    assert.ok(result.issue.includes(new Date(longValue.until).toISOString()));
    assert.deepEqual(h.store[short], shortValue);
    assert.deepEqual(h.store[long], longValue);
    assert.equal(h.calls.length, 0);
  });

  for (const failure of modern ? ['getKeys', 'get'] : ['get']) {
    test(`${flow.name} isolated worker / ${mode}: ${failure} rejection fails closed`, async () => {
      const { h, adapter } = await flowHarness(records(), { modern,
        failKeys: failure === 'getKeys', failGet: failure === 'get' ? cooldownRead : undefined });
      const result = await flow.run(h);
      assert.equal(result.domStarted, false);
      assert.match(result.issue, /could not check X cooldown/i);
      assert.equal(h.calls.length, 0);
      if (failure === 'getKeys') assert.equal(adapter.gets.filter(cooldownRead).length, 0);
    });
  }
}

for (const flow of flows) test(`${flow.name} isolated worker: non-callable getKeys falls back`, async () => {
  const { h, adapter } = await flowHarness({ [`xbcApiCooldown:42:${flow.operations[0]}`]: { until: START + 900000 } }, { modern: false });
  adapter.local.getKeys = {};
  const result = await flow.run(h);
  assert.equal(result.domStarted, false);
  assert.equal(adapter.gets[0], null);
});

for (const modern of [true, false]) {
  for (const failure of modern ? ['getKeys', 'get'] : ['get']) {
    test(`public API gate / ${modern ? 'getKeys' : 'legacy'}: ${failure} rejection stops before transport`, async () => {
      const { h } = await flowHarness({}, { modern, failKeys: failure === 'getKeys', failGet: failure === 'get' ? cooldownRead : undefined });
      const result = await h.api.deleteTweet('synthetic-post');
      assert.equal(result.kind, 'stop');
      assert.match(result.message, /Could not read the X API cooldown/);
      assert.equal(h.calls.length, 0);
    });
  }
}
