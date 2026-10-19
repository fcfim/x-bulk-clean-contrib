// Isolated launch contract tests: no browser, network, or account data.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { chromium } from 'playwright';
import { launch, EXTENSION_DIR } from './launch.mjs';

const nativePath = process.platform === 'win32'
  ? EXTENSION_DIR.replace(/^[a-z]:/, drive => drive.toUpperCase()) : EXTENSION_DIR;
const digest = createHash('sha256').update(Buffer.from(nativePath,
  process.platform === 'win32' ? 'utf16le' : 'utf8')).digest('hex').slice(0, 32);
const ownId = [...digest].map(n => String.fromCharCode(97 + parseInt(n, 16))).join('');
const ownUrl = `chrome-extension://${ownId}/background.js`;
const ready = () => ({ storage: { local: {
  async get(keys) { assert.deepEqual(Array.from(keys), []); return {}; },
  async set() {}
} } });

function worker(url = ownUrl, chromeAt = ready) {
  return {
    calls: 0,
    url: () => url,
    async evaluate(fn) {
      this.calls++;
      return vm.runInNewContext(`(${fn.toString()})()`, { chrome: chromeAt(this.calls) });
    }
  };
}

async function withContext(workersAt, run, launchError) {
  const original = chromium.launchPersistentContext;
  let profile;
  let snapshots = 0;
  const context = {
    closed: false,
    serviceWorkers: () => workersAt(++snapshots),
    async waitForEvent() { throw new Error('Unexpected unfiltered serviceworker wait'); },
    async close() { this.closed = true; }
  };
  chromium.launchPersistentContext = async (dir, options) => {
    profile = dir;
    assert.ok(options.args.includes(`--load-extension=${EXTENSION_DIR}`));
    if (launchError) throw launchError;
    return context;
  };
  try {
    await run(context);
    assert.ok(profile);
    assert.equal(fs.existsSync(profile), false, 'temporary profile must be removed');
  } finally {
    chromium.launchPersistentContext = original;
    if (profile) fs.rmSync(profile, { recursive: true, force: true });
  }
}

const options = { timeout: 80, pollInterval: 2 };
const timeoutError = /Timed out after \d+ ms.*chrome\.storage\.local/;

test('ignores web and foreign extension workers, then waits for the own worker', async () => {
  const web = worker('https://x.com/sw.js');
  const foreign = worker('chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/background.js');
  const own = worker();
  await withContext(n => n < 3 ? [web, foreign] : [web, foreign, own], async context => {
    const env = await launch(options);
    assert.equal(env.worker, own);
    assert.equal(env.extensionId, ownId);
    assert.equal(web.calls + foreign.calls, 0);
    assert.ok(own.calls >= 1);
    await env.close();
    assert.equal(context.closed, true);
  });
});

test('waits until storage.local appears and get([]) is usable', async () => {
  const own = worker(ownUrl, n => n < 3 ? undefined : ready());
  await withContext(() => [own], async () => {
    const env = await launch(options);
    assert.ok(own.calls >= 3);
    assert.equal(env.worker, own);
    await env.close();
  });
});

for (const [label, chromeAt] of [
  ['chrome absent', () => undefined],
  ['storage absent', () => ({})],
  ['local absent', () => ({ storage: {} })],
  ['get/set incomplete', () => ({ storage: { local: { get() {} } } })],
  ['read refused', () => ({ storage: { local: {
    async get() { throw new Error('not ready'); }, async set() {}
  } } })]
]) {
  test(`permanent ${label} rejects explicitly and cleans up`, async () => {
    const own = worker(ownUrl, chromeAt);
    await withContext(() => [own], async context => {
      await assert.rejects(launch(options), timeoutError);
      assert.ok(own.calls >= 2);
      assert.equal(context.closed, true);
    });
  });
}

test('missing own worker rejects with identity and elapsed timeout', async () => {
  await withContext(() => [], async context => {
    await assert.rejects(launch(options), error => {
      assert.match(error.message, timeoutError);
      assert.ok(error.message.includes(ownId));
      assert.match(error.message, /service worker.*not found/);
      return true;
    });
    assert.equal(context.closed, true);
  });
});

test('a hanging probe cannot outlive the readiness deadline', { timeout: 1000 }, async () => {
  const own = worker();
  own.evaluate = () => new Promise(() => {});
  await withContext(() => [own], async context => {
    await assert.rejects(launch(options), timeoutError);
    assert.equal(context.closed, true);
  });
});

test('unexpected worker evaluation error propagates', async () => {
  const own = worker();
  const failure = new Error('worker evaluation disconnected');
  own.evaluate = async () => { throw failure; };
  await withContext(() => [own], async context => {
    await assert.rejects(launch(options), error => error === failure);
    assert.equal(context.closed, true);
  });
});

test('browser launch failure propagates and removes the temporary profile', async () => {
  const failure = new Error('browser launch failed');
  await withContext(() => [], async () => {
    await assert.rejects(launch(options), error => error === failure);
  }, failure);
});
