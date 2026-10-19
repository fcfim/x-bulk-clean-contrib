// Synthetic storage/isolated-world adapters; no browser, network, or real account data.
import fs from 'node:fs';
import vm from 'node:vm';

export const START = 1800000000000;
export const PREFIX = 'xbcApiCooldown:42:DeleteTweet';
export const clone = value => JSON.parse(JSON.stringify(value));
const sources = Object.fromEntries([
  ['api', 'worker/xapi.js'], ['popup', 'popup/popup.js'], ['panel', 'sidepanel/sidepanel.js']
].map(([name, file]) => [name, fs.readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8')]));

export function records() {
  return {
    jobHistory: [{ id: 'synthetic-history', text: 'unrelated history' }],
    [PREFIX]: { until: START + 300000, reason: 'legacy', slowdown: 2 },
    [PREFIX + ':claim:blocked']: { until: START + 600000, reason: 'blocked', blocked: true, slowdown: 4 },
    [PREFIX + ':claim:long']: { until: START + 900000, reason: 'longer', slowdown: 8 },
    [PREFIX + ':claim:expired']: { until: START - 1, blocked: true, slowdown: 16 },
    [PREFIX + ':unrelated']: { until: START + 99999999, blocked: true },
    [PREFIX + 'Extra:claim:wrong-operation']: { until: START + 99999999, blocked: true },
    'xbcApiCooldown:99:DeleteTweet:claim:other': { until: START + 99999999, blocked: true },
    'xbcApiCooldown:42:UnfavoriteTweet:claim:other': { until: START + 99999999, blocked: true },
    'xbcApiCooldown:99:Likes:claim:expired': { until: START - 1 },
    'xbcApiCooldown:42:Likes': { until: START - 1 },
    'unrelated:claim:expired': { until: START - 1 }
  };
}

export function storage(store, { modern = true, failKeys, failGet, afterKeys, afterSet, beforeRemove } = {}) {
  const gets = [], sets = [], removes = [];
  let keyCalls = 0, bytes = 0;
  const local = {
    async get(keys) {
      gets.push(keys === null ? null : Array.from(keys));
      if (failGet?.(keys)) throw new Error('synthetic get rejected');
      const selected = Object.fromEntries((keys ?? Object.keys(store)).filter(key => key in store).map(key => [key, store[key]]));
      // Models value serialization across the storage boundary, including large histories.
      const json = JSON.stringify(selected);
      bytes += Buffer.byteLength(json);
      return JSON.parse(json);
    },
    async set(values) {
      sets.push(clone(values));
      Object.assign(store, clone(values));
      await afterSet?.(values);
    },
    async remove(keys) {
      removes.push(Array.from(keys));
      await beforeRemove?.(keys);
      for (const key of keys) delete store[key];
    }
  };
  if (modern) local.getKeys = async () => {
    keyCalls++;
    if (failKeys) throw new Error('synthetic getKeys rejected');
    const keys = Object.keys(store);
    await afterKeys?.();
    return keys;
  };
  return { local, gets, sets, removes, get keyCalls() { return keyCalls; }, get bytes() { return bytes; } };
}

class ClockDate extends Date {
  constructor(...args) { super(...(args.length ? args : [START])); }
  static now() { return START; }
}

export function cooldowns(local) {
  // Execute the unchanged functions from the actual client, exposing them only in this VM.
  const start = sources.api.indexOf('  const cooldownKey =');
  const end = sources.api.indexOf('  const suspension =', start);
  if (start < 0 || end < 0) throw new Error('Cooldown function boundaries not found');
  let uuid = 0;
  const context = vm.createContext({ Date: ClockDate, chrome: { storage: { local } },
    crypto: { randomUUID: () => `synthetic-${++uuid}` } });
  vm.runInContext(sources.api.slice(start, end) + '\nglobalThis.subject = { readCooldown, rememberCooldown, pruneCooldowns };', context);
  return context.subject;
}

export function domCooldown(name, local) {
  const source = name === 'popup' ? sources.popup : sources.panel;
  const workerStart = source.indexOf(`function ${name === 'popup' ? 'runWorker' : name === 'scan' ? 'startPreviewScanner' : 'runSelectedDelete'}(`);
  const start = source.indexOf('  async function domCooldown(', workerStart);
  const end = source.indexOf('\n  const api', start);
  if (workerStart < 0 || start < 0 || end < 0) throw new Error('DOM cooldown boundaries not found');
  const context = vm.createContext({ Date: ClockDate, document: { cookie: 'twid=u%3D42' },
    action: 'delete', type: 'tweets', LIST_OP: { delete: 'UserTweets' }, chrome: { storage: { local } } });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.subject = domCooldown;', context);
  return () => context.subject(['UserTweets']);
}

export const cooldownRead = keys => keys === null || Array.from(keys).every(key => key.startsWith('xbcApiCooldown:'));
