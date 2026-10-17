// Loads the unpacked extension into Chromium and returns handles for driving it.
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const EXTENSION_DIR = path.join(root, 'src');

export async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'xbc-e2e-'));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined),
    headless: true,
    viewport: { width: 1200, height: 900 },
    args: [`--disable-extensions-except=${EXTENSION_DIR}`, `--load-extension=${EXTENSION_DIR}`]
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  return {
    context,
    worker,
    extensionId,
    async close() {
      await context.close();
      fs.rmSync(profile, { recursive: true, force: true });
    }
  };
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
