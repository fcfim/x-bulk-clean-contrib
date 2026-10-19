// Synthetic Node serialization benchmark, NOT browser storage latency.
// Run: node test/e2e/cooldown-benchmark.mjs
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { START, records, storage, cooldowns, domCooldown } from './cooldown-fixture.mjs';

const samples = 5;
console.log(JSON.stringify({ runtime: process.version, adapter: 'Node JSON storage serialization; not Chromium IPC', samples }));
for (const historyBytes of [3300000, 34000000]) {
  for (const name of ['readCooldown', 'pruneCooldowns', 'popup', 'scan', 'selected']) {
    for (const modern of [false, true]) {
      const store = records();
      store['xbcApiCooldown:42:UserTweets:claim:synthetic'] = { until: START + 900000 };
      store.jobHistory = [{ id: 'synthetic-history', text: 'h'.repeat(historyBytes) }];
      const adapter = storage(store, { modern });
      const subject = cooldowns(adapter.local);
      const run = name === 'readCooldown' ? () => subject.readCooldown({ me: { id: '42' } }, 'DeleteTweet')
        : name === 'pruneCooldowns' ? () => subject.pruneCooldowns() : domCooldown(name, adapter.local);
      await run(); // One warm-up; pruning removes only the expired synthetic claims.
      const bytesBefore = adapter.bytes, timings = [];
      for (let i = 0; i < samples; i++) {
        const started = performance.now();
        await run();
        timings.push(performance.now() - started);
      }
      timings.sort((a, b) => a - b);
      const bytesPerRead = (adapter.bytes - bytesBefore) / samples;
      assert(modern ? bytesPerRead < 5000 : bytesPerRead > historyBytes);
      assert.equal(adapter.gets.some(keys => keys === null), !modern);
      console.log(JSON.stringify({ historyBytes, name, mode: modern ? 'getKeys' : 'legacy-get-null',
        medianMs: Number(timings[2].toFixed(3)), minMs: Number(timings[0].toFixed(3)), maxMs: Number(timings[4].toFixed(3)), bytesPerRead }));
    }
  }
}
