// Loads the unpacked extension into Chromium and returns handles for driving it.
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const EXTENSION_DIR = fs.realpathSync(path.join(root, 'src'));

// Chromium derives the ID of this keyless unpacked extension from its native path.
const nativePath = process.platform === 'win32'
  ? EXTENSION_DIR.replace(/^[a-z]:/, drive => drive.toUpperCase()) : EXTENSION_DIR;
const pathHash = createHash('sha256').update(Buffer.from(nativePath,
  process.platform === 'win32' ? 'utf16le' : 'utf8')).digest('hex').slice(0, 32);
const extensionId = [...pathHash].map(n => String.fromCharCode(97 + parseInt(n, 16))).join('');

async function readyWorker(context, timeout, pollInterval) {
  const started = performance.now();
  let missing = 'service worker not found';
  const timedOut = () => new Error(`Timed out after ${Math.round(performance.now() - started)} ms waiting for ` +
    `chrome-extension://${extensionId}/ with usable chrome.storage.local: ${missing}`);
  for (;;) {
    const remaining = timeout - (performance.now() - started);
    if (remaining <= 0) throw timedOut();
    const worker = context.serviceWorkers().find(candidate => {
      const url = new URL(candidate.url());
      return url.protocol === 'chrome-extension:' && url.hostname === extensionId;
    });
    if (!worker) missing = 'service worker not found';
    if (worker) {
      missing = 'chrome.storage.local readiness probe did not finish';
      let timer;
      try {
        const unavailable = await Promise.race([
          worker.evaluate(async () => {
            const local = globalThis.chrome?.storage?.local;
            if (!local) return 'chrome.storage.local unavailable';
            if (typeof local.get !== 'function' || typeof local.set !== 'function') {
              return 'chrome.storage.local.get/set unavailable';
            }
            try {
              await local.get([]); // Empty key list: no user data read or written.
              return null;
            } catch {
              return 'chrome.storage.local.get([]) not usable';
            }
          }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(timedOut()), remaining); })
        ]);
        if (unavailable === null) return worker;
        missing = unavailable;
      } finally {
        clearTimeout(timer);
      }
    }
    await new Promise(resolve => setTimeout(resolve,
      Math.min(pollInterval, Math.max(0, timeout - (performance.now() - started)))));
  }
}

export async function launch({ timeout = 10000, pollInterval = 50 } = {}) {
  if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isFinite(pollInterval) || pollInterval <= 0) {
    throw new Error('Readiness timeout and pollInterval must be finite positive milliseconds');
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xbc-e2e-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined),
      headless: true,
      viewport: { width: 1200, height: 900 },
      args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`]
    });
    const worker = await readyWorker(context, timeout, pollInterval);
    return {
      context,
      worker,
      extensionId,
      async close() {
        try {
          await context.close();
        } finally {
          fs.rmSync(profile, { recursive: true, force: true });
        }
      }
    };
  } catch (error) {
    try {
      await context?.close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], error.message);
    } finally {
      fs.rmSync(profile, { recursive: true, force: true });
    }
    throw error;
  }
}

// The popup and side panel look for "the active tab of the current window". Opened as a tab
// in a test, that tab is the extension page itself, so point the query at the X tab instead.
export async function openExtensionPage(context, extensionId, page) {
  const tab = await context.newPage();
  await tab.addInitScript(() => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = async (info) => {
      if (info?.active && info?.currentWindow) {
        const tabs = await query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
        return tabs.slice(0, 1);
      }
      return query(info);
    };
    window.close = () => {};
  });
  await tab.goto(`chrome-extension://${extensionId}/${page}`);
  return tab;
}

export async function storage(worker, keys) {
  return worker.evaluate(k => chrome.storage.local.get(k), keys);
}

export async function waitFor(fn, { timeout = 60000, interval = 250, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`);
    await new Promise(r => setTimeout(r, interval));
  }
}
