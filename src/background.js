// Reserved for extension lifecycle tasks. X Bulk Clean does not send analytics,
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

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || info.status === 'complete') updateSidePanel(tabId, tab.url);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const tab = await chrome.tabs.get(tabId);
    await updateSidePanel(tabId, tab.url);
  } catch (_) {}
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const stored = await chrome.storage.local.get(['activePreviewSession']);
  if (stored.activePreviewSession?.tabId === tabId) await chrome.storage.local.remove(['activePreviewSession']);
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
  if (message?.type === 'xbc:job' && sender.tab?.id != null) {
    // Memory Saver would otherwise discard the background tab and kill the job.
    chrome.tabs.update(sender.tab.id, { autoDiscardable: !message.running }).catch(() => {});
    sendResponse(true);
  }
});
