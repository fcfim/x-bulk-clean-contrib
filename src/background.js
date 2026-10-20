// Reserved for extension lifecycle tasks. Postscrub does not send analytics,
// perform license checks, or open an uninstall survey.

const X_URL = /^https:\/\/(x\.com|twitter\.com)\//;

async function updateSidePanel(tabId, url) {
  try {
    await chrome.sidePanel.setOptions({
      tabId,
      path: 'sidepanel/sidepanel.html',
      enabled: X_URL.test(url || '')
    });
    if (!X_URL.test(url || '')) {
      const stored = await chrome.storage.local.get(['activePreviewSession']);
      if (stored.activePreviewSession?.tabId === tabId) await chrome.storage.local.remove(['activePreviewSession']);
    }
  } catch (_) {}
}

chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.url || info.status === 'complete') updateSidePanel(tabId, tab.url);
  // A reload kills the job's worker before it can call stopAll, so give the tab back to
  // Memory Saver here. X's own pushState navigations also report 'loading' without touching
  // the worker, so the tab is released only when no running worker answers in it; 'complete'
  // checks again once a reloaded page has replaced the old one.
  if (info.status === 'loading' || info.status === 'complete') {
    const key = `jobTab_${tabId}`;
    if (!(await chrome.storage.session.get([key]))[key]) return;
    const alive = await chrome.scripting.executeScript({ target: { tabId }, func: () => !!window.__xCleaner?.interval })
      .then(([result]) => result?.result === true, () => false);
    if (alive) return;
    await chrome.storage.session.remove([key]);
    chrome.tabs.update(tabId, { autoDiscardable: true }).catch(() => {});
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await updateSidePanel(tabId, tab.url);
  } catch (_) {}
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const stored = await chrome.storage.local.get(['activePreviewSession', 'activeTabId']);
  if (stored.activePreviewSession?.tabId === tabId) await chrome.storage.local.remove(['activePreviewSession']);
  // The job died with its tab; without this the popup stays on "running".
  if (stored.activeTabId === tabId) await chrome.storage.local.remove(['activeAction', 'activeTabId', 'startTime', 'actionStats']);
  await chrome.storage.session.remove([`jobTab_${tabId}`]);
});

// Cleanup workers run inside the X tab, where Chrome throttles timers once the tab is hidden.
// Timing their sleeps here keeps jobs moving while the user works in other tabs, and each
// message also keeps this service worker alive for the duration of the job.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'xbc:sleep') {
    const ms = Math.min(Math.max(Number(message.ms) || 0, 0), 20000);
    setTimeout(() => sendResponse(true), ms);
    return true;
  }
  if (message?.type === 'xbc:bundleOps') {
    bundleOps(message.url).then(sendResponse, error => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }
  if (message?.type === 'xbc:job' && sender.tab?.id != null) {
    // Memory Saver would otherwise discard the background tab and kill the job.
    chrome.tabs.update(sender.tab.id, { autoDiscardable: !message.running }).catch(() => {});
    // Remember the job's tab (popup and side panel jobs alike) for onUpdated and onRemoved.
    const key = `jobTab_${sender.tab.id}`;
    (message.running ? chrome.storage.session.set({ [key]: true }) : chrome.storage.session.remove([key])).catch(() => {});
    sendResponse(true);
  }
});

// X's GraphQL query ids and feature lists change with every build of its web app. The API
// client asks for the operation definitions of the main.js the X tab actually loaded; this reads
// them from the bundle (each is a plain object literal: queryId, operationName, operationType,
// metadata.featureSwitches/fieldToggles) and caches them per bundle URL.
const BUNDLE_URL = /^https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/main\.[\w-]+\.js$/;

async function bundleOps(url) {
  if (!BUNDLE_URL.test(url || '')) return { ok: false, error: 'not an X web bundle URL' };
  const cached = (await chrome.storage.local.get(['xbcBundleOps'])).xbcBundleOps;
  if (cached?.url === url && cached.ops) return { ok: true, ...cached };
  const response = await fetch(url, { credentials: 'omit' });
  if (!response.ok) return { ok: false, error: `bundle HTTP ${response.status}` };
  const result = { url, ...parseBundleOps(await response.text()), at: Date.now() };
  await chrome.storage.local.set({ xbcBundleOps: result });
  return { ok: true, ...result };
}

function parseBundleOps(src) {
  const ops = {};
  const needle = /queryId\s*:\s*"/g;
  let match;
  while ((match = needle.exec(src))) {
    const start = src.lastIndexOf('{', match.index);
    let depth = 0, quote = null, end = -1;
    for (let i = start; i < src.length && i < start + 20000; i++) {
      const c = src[i];
      if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
      if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { end = i + 1; break; }
    }
    if (end < 0) continue;
    try {
      const def = JSON.parse(src.slice(start, end).replace(/([{,])\s*([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":'));
      if (def.operationName && def.queryId) {
        ops[def.operationName] = {
          queryId: def.queryId,
          operationType: def.operationType,
          featureSwitches: def.metadata?.featureSwitches || [],
          fieldToggles: def.metadata?.fieldToggles || []
        };
      }
    } catch (_) {}
  }
  const bearer = src.match(/Bearer (AAAA[A-Za-z0-9%]+)/)?.[1] || null;
  return { ops, bearer };
}
