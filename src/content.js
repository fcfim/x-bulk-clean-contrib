// Listen for status updates from the deletion process
let stats = { deleted: 0, found: 0 };

// Send updates to popup
function updatePopup() {
  chrome.runtime.sendMessage({
    type: 'STATUS_UPDATE',
    stats: stats,
    status: document.getElementById('status')?.textContent || 'Running'
  });
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_STATS') {
    sendResponse({ stats, status: document.getElementById('status')?.textContent || 'Running' });
  }
});
