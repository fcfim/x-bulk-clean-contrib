// === Popup-side state ===
let currentAction = null;
let startTime = null;
let actionStats = {};
let pollHandle = null;
let pendingAction = null;
let isStarting = false;
let clearHistoryTimer = null;
let armedHistoryJob = null;
let armedHistoryTimer = null;
let previewSessionToEnd = null;

const ACTION_LABELS = {
  delete: 'Deleting tweets',
  unlike: 'Unliking posts',
  unrepost: 'Removing reposts',
  deleteReplies: 'Deleting replies',
  followVerified: 'Following verified users',
  followAll: 'Following all users',
  bulkUnfollow: 'Bulk unfollowing'
};

const ACTION_PATHS = {
  delete: '',
  unlike: '/likes',
  unrepost: '',
  deleteReplies: '/with_replies',
  followVerified: '/verified_followers',
  followAll: '/followers',
  bulkUnfollow: '/following'
};

const ACTION_CONFIRMATIONS = {
  delete: {
    title: 'Delete all tweets?',
    description: 'Tweets will be permanently deleted as X Bulk Clean scrolls through your profile.',
    button: 'Delete all tweets',
    icon: 'icon-trash',
    danger: true
  },
  unlike: {
    title: 'Clear all likes?',
    description: 'Likes will be removed automatically as X Bulk Clean scrolls through your Likes tab.',
    button: 'Clear all likes',
    icon: 'icon-heart-off'
  },
  unrepost: {
    title: 'Remove all reposts?',
    description: 'Every repost X Bulk Clean can find on your timeline will be undone.',
    button: 'Remove reposts',
    icon: 'icon-repeat'
  },
  deleteReplies: {
    title: 'Find replies safely',
    description: 'Opens Preview & Select to identify normal and orphan replies before you choose what to delete.',
    button: 'Open safe scan',
    icon: 'icon-message-x',
    danger: true
  },
  followVerified: {
    title: 'Follow verified followers?',
    description: 'X Bulk Clean will follow verified accounts found in your followers list.',
    button: 'Start following',
    icon: 'icon-badge-check'
  },
  followAll: {
    title: 'Follow all followers?',
    description: 'X Bulk Clean will follow back accounts found in your followers list.',
    button: 'Start following',
    icon: 'icon-users'
  },
  bulkUnfollow: {
    title: 'Start bulk unfollow?',
    description: 'X Bulk Clean will unfollow accounts as it scrolls through your Following list.',
    button: 'Start unfollowing',
    icon: 'icon-user-minus',
    danger: true
  }
};

const X_URL = /^https:\/\/(twitter\.com|x\.com)\//;
const $ = (id) => document.getElementById(id);
const todayKey = () => new Date().toISOString().split('T')[0];

// === Tab helpers ===

async function findXTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.url && X_URL.test(active.url)) return active;
  const all = await chrome.tabs.query({ url: ['https://twitter.com/*', 'https://x.com/*'] });
  return all[0] || null;
}

async function findActionTab() {
  const stored = await chrome.storage.local.get(['activeTabId']);
  if (stored.activeTabId) {
    try {
      const tab = await chrome.tabs.get(stored.activeTabId);
      if (tab?.url && X_URL.test(tab.url)) return tab;
    } catch (_) {
      await chrome.storage.local.remove(['activeTabId']);
    }
  }
  return findXTab();
}

function waitForTabLoad(tabId, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      setTimeout(() => resolve(ok), 1500);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') finish(true);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function detectCurrentAccount(tab, attempts = 1) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const link = document.querySelector('[data-testid="AppTabBar_Profile_Link"]') ||
                       document.querySelector('a[aria-label="Profile"]') ||
                       document.querySelector('nav[role="navigation"] a[href*="/"][role="link"][aria-label*="Profile" i]');
          const switcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
          const href = link?.getAttribute('href') || '';
          const hrefHandle = href.replace(/^\//, '').split('/')[0];
          const leafTexts = Array.from(switcher?.querySelectorAll('span') || [])
            .filter(span => span.children.length === 0)
            .map(span => (span.textContent || '').trim())
            .filter(Boolean);
          const textHandle = leafTexts.find(text => /^@[A-Za-z0-9_]{1,15}$/.test(text));
          const username = (/^[A-Za-z0-9_]{1,15}$/.test(hrefHandle) &&
                            !/^(home|explore|notifications|messages|i)$/i.test(hrefHandle))
            ? hrefHandle
            : textHandle?.slice(1);
          if (!username) return null;

          const avatar = switcher?.querySelector('img[src]') || link?.querySelector('img[src]');
          const alt = (avatar?.getAttribute('alt') || '').trim();
          const displayName = (alt && !/^(image|profile photo)$/i.test(alt))
            ? alt
            : leafTexts.find(text => text !== `@${username}` && !text.startsWith('@') && text.length <= 60) || username;

          return {
            username,
            displayName,
            avatarUrl: avatar?.currentSrc || avatar?.src || ''
          };
        }
      });
      const account = results?.[0]?.result;
      if (account?.username) {
        await chrome.storage.local.set({
          twitterUsername: account.username,
          currentAccount: account
        });
        return account;
      }
    } catch (_) {}
    if (attempt < attempts - 1) await new Promise(r => setTimeout(r, 800));
  }
  return null;
}

function renderAccount(account) {
  const card = $('accountCard');
  const avatar = $('accountAvatar');
  const initials = $('accountInitials');

  if (!account?.username) {
    card.dataset.state = 'missing';
    $('accountName').textContent = 'Account not detected';
    $('accountHandle').textContent = 'Open X and make sure you are signed in';
    $('accountStateText').textContent = 'Not found';
    avatar.classList.remove('visible');
    avatar.removeAttribute('src');
    initials.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-user"/></svg>';
    return;
  }

  card.dataset.state = 'ready';
  $('accountName').textContent = account.displayName || account.username;
  $('accountHandle').textContent = `@${account.username}`;
  $('accountStateText').textContent = 'Detected';
  initials.textContent = (account.displayName || account.username).trim().slice(0, 2);

  if (account.avatarUrl) {
    avatar.onload = () => avatar.classList.add('visible');
    avatar.onerror = () => avatar.classList.remove('visible');
    avatar.src = account.avatarUrl;
  } else {
    avatar.classList.remove('visible');
    avatar.removeAttribute('src');
  }
}

async function renderCurrentAccount() {
  const tab = await findActionTab();
  if (!tab) {
    renderAccount(null);
    return null;
  }
  const account = await detectCurrentAccount(tab, 2);
  renderAccount(account);
  return account;
}

async function getUsername(tab) {
  const account = await detectCurrentAccount(tab, 6);
  renderAccount(account);
  return account?.username || null;
}

async function ensureProfilePage(action) {
  let tab = await findXTab();

  if (!tab) {
    tab = await chrome.tabs.create({ url: 'https://x.com/home', active: true });
    await waitForTabLoad(tab.id);
    tab = await chrome.tabs.get(tab.id);
  } else if (!X_URL.test(tab.url || '')) {
    const loadPromise = waitForTabLoad(tab.id);
    await chrome.tabs.update(tab.id, { url: 'https://x.com/home', active: true });
    await loadPromise;
    tab = await chrome.tabs.get(tab.id);
  }

  const username = await getUsername(tab);
  if (!username) {
    updateStats('Could not detect your X handle. Please log in to X first.');
    return null;
  }

  const domain = (tab.url || '').includes('twitter.com') ? 'twitter.com' : 'x.com';
  const path = ACTION_PATHS[action] ?? '';
  const targetUrl = `https://${domain}/${username}${path}`;
  const currentNormalized = (tab.url || '').replace(/[?#].*$/, '').replace(/\/$/, '');

  if (currentNormalized !== targetUrl.replace(/\/$/, '')) {
    const loadPromise = waitForTabLoad(tab.id);
    await chrome.tabs.update(tab.id, { url: targetUrl, active: true });
    await loadPromise;
  } else {
    await chrome.tabs.update(tab.id, { active: true });
    await new Promise(r => setTimeout(r, 400));
  }

  return await chrome.tabs.get(tab.id);
}

// === Worker (runs in the tab via chrome.scripting.executeScript) ===

function runWorker(action, performanceMode, account) {

  const prior = window.__xCleaner;
  if (prior?.interval) return;
  if (prior) {
    if (prior.interval) clearInterval(prior.interval);
    if (prior.keepAlive) clearInterval(prior.keepAlive);
    if (prior.mediaObserver) prior.mediaObserver.disconnect();
    if (prior.overlayTimer) clearInterval(prior.overlayTimer);
  }
  document.getElementById('__openxPerformanceStyle')?.remove();
  document.getElementById('__xbcJobOverlay')?.remove();

  const X = window.__xCleaner = {
    action,
    stats: {},
    backup: { tweets: [], replies: [], unliked: [], unreposted: [], follows: [], unfollows: [] },
    processed: new Set(),
    busy: false,
    issue: null,
    interval: null,
    keepAlive: null,
    mediaObserver: null,
    overlayTimer: null,
    overlayHost: null,
    emptyCycles: 0,
    successCount: 0,
    startedAt: Date.now(),
    jobId: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    historySaved: false,
    historyPersisted: false
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const hidden = () => document.hidden || document.visibilityState === 'hidden';

  function overlayProgressText() {
    const s = X.stats || {};
    if (action === 'delete') return `${s.deleted || 0} deleted · ${s.found || 0} found`;
    if (action === 'unlike') return `${s.unlikes || 0} unliked · ${s.foundLikes || 0} found`;
    if (action === 'unrepost') return `${s.unreposts || 0} removed · ${s.foundReposts || 0} found`;
    if (action === 'deleteReplies') return `${s.repliesDeleted || 0} deleted · ${s.repliesFound || 0} found`;
    if (action === 'followVerified' || action === 'followAll') return `${s.follows || 0} followed · ${s.foundFollowers || 0} found`;
    if (action === 'bulkUnfollow') return `${s.unfollows || 0} unfollowed · ${s.foundFollowing || 0} found`;
    return `${X.successCount || 0} completed`;
  }

  function updateJobOverlay() {
    const shadow = X.overlayHost?.shadowRoot;
    if (!shadow) return;
    shadow.getElementById('jobProgress').textContent = overlayProgressText();
    const elapsed = Math.max(0, Math.floor((Date.now() - X.startedAt) / 1000));
    shadow.getElementById('jobTime').textContent = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  }

  function createJobOverlay() {
    const labels = {
      delete: 'Deleting all tweets',
      unlike: 'Clearing all likes',
      unrepost: 'Removing all reposts',
      deleteReplies: 'Deleting all replies',
      followVerified: 'Following verified accounts',
      followAll: 'Following all followers',
      bulkUnfollow: 'Bulk unfollowing'
    };
    const host = document.createElement('div');
    host.id = '__xbcJobOverlay';
    host.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        *{box-sizing:border-box}
        .card{width:300px;padding:14px;border:1px solid rgba(255,255,255,.12);border-radius:14px;background:rgba(20,20,20,.96);color:#f7f7f7;box-shadow:0 18px 48px rgba(0,0,0,.34);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
        .kicker{display:flex;align-items:center;gap:7px;color:#a9aaa9;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase}
        .dot{width:7px;height:7px;border-radius:50%;background:#28b66f;box-shadow:0 0 0 3px rgba(40,182,111,.16)}
        h2{margin:7px 0 11px;font-size:16px;line-height:1.25;letter-spacing:-.02em}
        .account{display:flex;align-items:center;gap:8px;padding:8px;border-radius:9px;background:rgba(255,255,255,.07)}
        .avatar{width:30px;height:30px;border-radius:50%;object-fit:cover;background:#343434}
        .avatar.hidden{display:none}
        .fallback{width:30px;height:30px;display:grid;place-items:center;border-radius:50%;background:#343434;color:#ddd;font-size:10px;font-weight:750;text-transform:uppercase}
        .name{min-width:0;flex:1}.display{overflow:hidden;font-size:12px;font-weight:700;text-overflow:ellipsis;white-space:nowrap}.handle{color:#a9aaa9;font-size:10px}
        .progress{height:3px;margin:12px 0 9px;overflow:hidden;border-radius:999px;background:rgba(255,255,255,.1)}
        .progress::after{content:"";display:block;width:42%;height:100%;border-radius:inherit;background:#28b66f;animation:move 1.15s cubic-bezier(.4,0,.2,1) infinite alternate}
        @keyframes move{from{transform:translateX(-15%)}to{transform:translateX(155%)}}
        .meta{display:flex;align-items:center;justify-content:space-between;color:#c8c9c8;font-size:11px;font-variant-numeric:tabular-nums}
        button{width:100%;min-height:38px;margin-top:12px;border:1px solid rgba(255,92,87,.28);border-radius:8px;background:rgba(255,92,87,.12);color:#ff8580;font:700 11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;cursor:pointer}
        button:hover{background:rgba(255,92,87,.18)}button:active{transform:scale(.97)}button:disabled{opacity:.55;cursor:default;transform:none}
        .card.done .dot{background:#8b8c8b;box-shadow:none}.card.done .progress{display:none}
        @media(prefers-reduced-motion:reduce){.progress::after{animation:none;width:100%}button{transition:none}}
      </style>
      <section class="card" role="status" aria-live="polite">
        <div class="kicker"><span class="dot"></span><span id="jobState">X Bulk Clean running</span></div>
        <h2 id="jobTitle"></h2>
        <div class="account">
          <div id="jobFallback" class="fallback"></div>
          <img id="jobAvatar" class="avatar hidden" alt="" referrerpolicy="no-referrer">
          <div class="name"><div id="jobName" class="display"></div><div id="jobHandle" class="handle"></div></div>
        </div>
        <div class="progress"></div>
        <div class="meta"><span id="jobProgress">Preparing…</span><span id="jobTime">0:00</span></div>
        <button id="jobStop" type="button">Stop current action</button>
      </section>`;

    shadow.getElementById('jobTitle').textContent = labels[action] || 'Running cleanup';
    shadow.getElementById('jobName').textContent = account?.displayName || account?.username || 'Active account';
    shadow.getElementById('jobHandle').textContent = account?.username ? `@${account.username}` : '';
    shadow.getElementById('jobFallback').textContent = (account?.displayName || account?.username || 'X').trim().slice(0, 2);
    const avatar = shadow.getElementById('jobAvatar');
    if (account?.avatarUrl) {
      avatar.onload = () => {
        avatar.classList.remove('hidden');
        shadow.getElementById('jobFallback').style.display = 'none';
      };
      avatar.src = account.avatarUrl;
    }
    shadow.getElementById('jobStop').addEventListener('click', () => stopAll('Stopped by user'));
    (document.body || document.documentElement).appendChild(host);
    X.overlayHost = host;
    updateJobOverlay();
    X.overlayTimer = setInterval(updateJobOverlay, 500);
  }

  function finishJobOverlay(reason) {
    if (X.overlayTimer) clearInterval(X.overlayTimer);
    X.overlayTimer = null;
    updateJobOverlay();
    const shadow = X.overlayHost?.shadowRoot;
    if (!shadow) return;
    shadow.querySelector('.card')?.classList.add('done');
    shadow.getElementById('jobState').textContent = reason || 'Action finished';
    shadow.getElementById('jobStop').disabled = true;
    setTimeout(() => X.overlayHost?.remove(), 2200);
  }

  function cleanUpPerformanceMode() {
    if (X.mediaObserver) X.mediaObserver.disconnect();
    X.mediaObserver = null;
    document.getElementById('__openxPerformanceStyle')?.remove();
  }

  function applyPerformanceMode() {
    if (!performanceMode) return;

    const style = document.createElement('style');
    style.id = '__openxPerformanceStyle';
    style.textContent = `
      article[data-testid="tweet"] [data-testid="tweetPhoto"],
      article[data-testid="tweet"] [data-testid="videoPlayer"],
      article[data-testid="tweet"] video {
        display: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);

    const pauseVideos = (root = document) => {
      const videos = [];
      if (root.matches?.('article[data-testid="tweet"] video')) videos.push(root);
      videos.push(...(root.querySelectorAll?.('article[data-testid="tweet"] video') || []));
      for (const video of videos) {
        video.pause();
        video.autoplay = false;
        video.preload = 'none';
      }
    };
    pauseVideos();
    X.mediaObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) pauseVideos(node);
        }
      }
    });
    X.mediaObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function ownHandle() {
    const link = document.querySelector('[data-testid="AppTabBar_Profile_Link"]') ||
                 document.querySelector('a[aria-label="Profile"]');
    return link?.getAttribute('href')?.replace(/^\//, '').toLowerCase() || null;
  }
  const me = ownHandle();

  function tweetId(article) {
    const m = article.querySelector('a[href*="/status/"]')?.getAttribute('href')?.match(/\/status\/(\d+)/);
    return m ? m[1] : null;
  }

  function authorHandle(article) {
    const link = article.querySelector('[data-testid="User-Name"] a[role="link"][href^="/"]');
    return link?.getAttribute('href')?.replace(/^\//, '').split('/')[0].toLowerCase() || null;
  }

  function isMine(article) {
    if (!me) return true;
    return authorHandle(article) === me;
  }

  // A thread connector is a thin, tall, visible vertical line in a tweet's avatar
  // column. On /with_replies the PARENT tweet carries a downward connector to the reply
  // beneath it. Detected by shape (X's class names are obfuscated and rotate).
  function cellHasConnector(cell) {
    if (!cell) return false;
    const divs = cell.querySelectorAll('div');
    const max = Math.min(divs.length, 160);
    for (let i = 0; i < max; i++) {
      const el = divs[i];
      const w = el.offsetWidth, h = el.offsetHeight;
      if (w >= 1 && w <= 3 && h >= 18) {
        const bg = getComputedStyle(el).backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return true;
      }
    }
    return false;
  }

  // Robust reply detection (verified against live x.com on 2026-06-14):
  //  1. Standalone replies carry a "Replying to @x" label.
  //  2. Threaded replies have NO label and look like posts — but the parent tweet sits in
  //     the previous cell with a downward connector line. So: an owned tweet whose nearest
  //     preceding article-cell has a connector is a reply. Original posts stand alone with
  //     no connected parent above, so they're correctly excluded (never deleted by mistake).
  function isReply(article) {
    if (/Replying to/i.test((article.textContent || '').slice(0, 300))) return true;
    const cell = article.closest('[data-testid="cellInnerDiv"]');
    if (!cell) return false;
    let prev = cell.previousElementSibling;
    for (let hops = 0; prev && hops < 4; hops++, prev = prev.previousElementSibling) {
      if (prev.querySelector && prev.querySelector('article[data-testid="tweet"]')) {
        return cellHasConnector(prev);
      }
    }
    return false;
  }

  function tweetSnap(article) {
    const a = article.querySelector('a[href*="/status/"]');
    return {
      id: tweetId(article),
      date: article.querySelector('time')?.getAttribute('datetime') || '',
      text: article.querySelector('[data-testid="tweetText"]')?.textContent || '',
      author: authorHandle(article) || '',
      url: a?.getAttribute('href') || ''
    };
  }

  function userSnap(cell) {
    const link = cell.querySelector('a[role="link"][href^="/"]');
    const username = link?.getAttribute('href')?.replace(/^\//, '').split('/')[0] || '';
    const nameSpan = cell.querySelector('[data-testid="User-Name"] span');
    return {
      username,
      displayName: nameSpan?.textContent || '',
      profileUrl: link?.getAttribute('href') || ''
    };
  }

  function detectIssue() {
    const toast = document.querySelector('[data-testid="toast"]') || document.querySelector('[role="alert"]');
    if (toast) {
      const text = (toast.textContent || '').trim();
      if (/try again|something went wrong|rate.?limit|unable|locked|restrict|exceeded|too many/i.test(text)) {
        return text.slice(0, 200);
      }
    }
    if (document.querySelector('[data-testid="LoginForm"]') ||
        document.querySelector('a[data-testid="loginButton"]') ||
        document.querySelector('[data-testid="login"]')) {
      return 'Login required';
    }
    return null;
  }

  async function persistJob(reason) {
    if (X.historySaved) return;
    X.historySaved = true;
    const completedAt = Date.now();
    const counts = {
      tweets: X.backup.tweets.length,
      replies: X.backup.replies.length,
      unliked: X.backup.unliked.length,
      unreposted: X.backup.unreposted.length,
      follows: X.backup.follows.length,
      unfollows: X.backup.unfollows.length
    };
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    const status = /^Finished/i.test(reason || '')
      ? 'completed'
      : /Stopped by user/i.test(reason || '') ? 'stopped' : 'interrupted';
    const summary = {
      id: X.jobId,
      action,
      account: {
        username: account?.username || me || '',
        displayName: account?.displayName || account?.username || me || '',
        avatarUrl: account?.avatarUrl || ''
      },
      startedAt: X.startedAt,
      completedAt,
      durationMs: completedAt - X.startedAt,
      status,
      statusText: reason || 'Action finished',
      total,
      counts
    };
    try {
      const stored = await chrome.storage.local.get(['jobHistory']);
      const history = Array.isArray(stored.jobHistory) ? stored.jobHistory : [];
      const nextHistory = [summary, ...history.filter(job => job?.id !== X.jobId)];
      await chrome.storage.local.set({
        jobHistory: nextHistory,
        [`job_${X.jobId}`]: { ...summary, backup: X.backup }
      });
      X.historyPersisted = true;
    } catch (error) {
      X.historySaveError = error?.message || 'Could not save job history';
    }
  }

  async function stopAll(reason) {
    if (X.interval) clearInterval(X.interval);
    if (X.keepAlive) clearInterval(X.keepAlive);
    X.interval = null;
    X.keepAlive = null;
    cleanUpPerformanceMode();
    if (reason) X.issue = reason;
    const historySave = persistJob(reason);
    finishJobOverlay(reason);
    await historySave;
  }
  window.__xCleanerStop = () => stopAll('Stopped by user');

  X.keepAlive = setInterval(() => {
    document.body?.setAttribute('data-keepalive', String(Date.now()));
  }, 25000);

  applyPerformanceMode();
  createJobOverlay();

  async function bumpAndCheckCap() {
    X.successCount++;
  }

  async function clickConfirm(testId, attempts = 10) {
    for (let i = 0; i < attempts; i++) {
      const btn = document.querySelector(`[data-testid="${testId}"]`);
      if (btn && btn.offsetParent !== null) {
        btn.click();
        return true;
      }
      await sleep(200);
    }
    return false;
  }

  // X dismisses popup menus on an outside pointer event against the real hit-target.
  // document.body.click() does NOT work (verified on live x.com). Click a neutral,
  // non-link point so the menu closes without navigating.
  function closeMenus() {
    try {
      const el = document.elementFromPoint(8, Math.round(window.innerHeight / 2));
      if (el && !el.closest('a') && !el.closest('[role="menuitem"]') && !el.closest('[data-testid="caret"]')) {
        el.click();
      }
    } catch (_) {}
  }

  async function clickDeleteInMenu() {
    // Poll for the menu to render (it can take 300-700ms), then find Delete.
    for (let i = 0; i < 8; i++) {
      const menuItems = document.querySelectorAll('[role="menuitem"]');
      if (menuItems.length) {
        const del = Array.from(menuItems).find(m => {
          const t = (m.textContent || '').trim().toLowerCase();
          return t === 'delete' || t === 'delete post' || t === 'delete tweet' || t === 'delete reply';
        });
        if (del && del.offsetParent !== null) {
          del.click();
          return true;
        }
        break; // menu is open but has no Delete (not our tweet) — stop waiting
      }
      await sleep(150);
    }
    closeMenus();
    await sleep(250);
    return false;
  }

  function atBottom() {
    return (window.innerHeight + window.scrollY) >= (document.documentElement.scrollHeight - 240);
  }

  // Only treat an empty cycle as "done" once we've actually reached the bottom of the
  // timeline. Otherwise X just hasn't virtualized the next batch into view yet, and
  // stopping here would abandon most of the user's content (the old 0/12 bug).
  function noteEmpty(found) {
    if (found === 0 && atBottom()) {
      X.emptyCycles++;
      if (X.emptyCycles >= 5) stopAll('Finished — no more items found');
    } else {
      X.emptyCycles = 0;
    }
  }

  // === Action dispatch ===

  if (action === 'delete' || action === 'unrepost') {
    X.stats = action === 'delete'
      ? { deleted: 0, found: 0 }
      : { unreposts: 0, foundReposts: 0 };

    X.interval = setInterval(async () => {
      if (X.busy || !X.interval) return;
      const issue = detectIssue();
      if (issue) { stopAll(issue); return; }
      X.busy = true;
      try {
        let processedThisCycle = 0;
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        const candidates = [];

        if (action === 'delete') {
          for (const a of articles) {
            const id = tweetId(a);
            if (!id || X.processed.has(id)) continue;
            if (!isMine(a)) { X.processed.add(id); continue; }
            const caret = a.querySelector('[data-testid="caret"]');
            if (caret) candidates.push({ article: a, control: caret, id, kind: 'caret' });
          }
        } else {
          for (const a of articles) {
            const id = tweetId(a);
            if (!id || X.processed.has(id)) continue;
            const btn = a.querySelector('[data-testid="unretweet"]');
            if (btn) candidates.push({ article: a, control: btn, id, kind: 'unretweet' });
          }
        }

        if (action === 'delete') X.stats.found = X.processed.size + candidates.length;
        else X.stats.foundReposts = X.processed.size + candidates.length;

        const maxPerCycle = hidden() ? 2 : 4;
        for (const { article, control, id, kind } of candidates) {
          if (!X.interval) break;
          X.processed.add(id);
          const snap = tweetSnap(article);
          control.click();
          await sleep(hidden() ? 800 : 550);

          if (kind === 'caret') {
            const opened = await clickDeleteInMenu();
            if (opened) {
              await sleep(hidden() ? 800 : 550);
              if (await clickConfirm('confirmationSheetConfirm')) {
                X.stats.deleted++;
                X.backup.tweets.push({ ...snap, action: 'deleted', actionAt: new Date().toISOString() });
                await bumpAndCheckCap();
                if (!X.interval) break;
              }
              await sleep(hidden() ? 1000 : 700);
            }
          } else {
            if (await clickConfirm('unretweetConfirm')) {
              X.stats.unreposts++;
              X.backup.unreposted.push({ ...snap, action: 'unreposted', actionAt: new Date().toISOString() });
              await bumpAndCheckCap();
              if (!X.interval) break;
            }
            await sleep(hidden() ? 900 : 600);
          }

          processedThisCycle++;
          if (processedThisCycle >= maxPerCycle) break;
        }

        noteEmpty(candidates.length);
        // Only advance once every visible candidate this cycle was handled — otherwise a
        // fast scroll would virtualize away unprocessed items before we reach them.
        if (candidates.length <= processedThisCycle) window.scrollBy(0, window.innerHeight * 0.7);
        await sleep(hidden() ? 1500 : 1000);
      } finally {
        X.busy = false;
      }
    }, 2500);
  }

  else if (action === 'unlike') {
    X.stats = { unlikes: 0, foundLikes: 0 };
    X.interval = setInterval(async () => {
      if (X.busy || !X.interval) return;
      const issue = detectIssue();
      if (issue) { stopAll(issue); return; }
      X.busy = true;
      try {
        const buttons = Array.from(document.querySelectorAll('[data-testid="unlike"]'));
        const candidates = [];
        for (const btn of buttons) {
          const article = btn.closest('article');
          if (!article) continue;
          const id = tweetId(article);
          if (id && X.processed.has(id)) continue;
          candidates.push({ btn, article, id });
        }
        X.stats.foundLikes = X.processed.size + candidates.length;

        let processedThisCycle = 0;
        const maxPerCycle = hidden() ? 3 : 5;
        for (const { btn, article, id } of candidates) {
          if (!X.interval) break;
          if (id) X.processed.add(id);
          const snap = tweetSnap(article);
          btn.click();
          X.stats.unlikes++;
          X.backup.unliked.push({ ...snap, action: 'unliked', actionAt: new Date().toISOString() });
          await bumpAndCheckCap();
          if (!X.interval) break;
          await sleep(hidden() ? 800 : 500);

          processedThisCycle++;
          if (processedThisCycle >= maxPerCycle) break;
        }

        noteEmpty(candidates.length);
        // Only advance once every visible candidate this cycle was handled — otherwise a
        // fast scroll would virtualize away unprocessed items before we reach them.
        if (candidates.length <= processedThisCycle) window.scrollBy(0, window.innerHeight * 0.7);
        await sleep(hidden() ? 1500 : 1000);
      } finally {
        X.busy = false;
      }
    }, 2000);
  }

  else if (action === 'deleteReplies') {
    X.stats = { repliesDeleted: 0, repliesFound: 0 };
    X.interval = setInterval(async () => {
      if (X.busy || !X.interval) return;
      const issue = detectIssue();
      if (issue) { stopAll(issue); return; }
      X.busy = true;
      try {
        const articles = document.querySelectorAll('article[data-testid="tweet"]');
        const candidates = [];
        for (const a of articles) {
          const id = tweetId(a);
          if (!id || X.processed.has(id)) continue;
          if (!isMine(a)) { X.processed.add(id); continue; }
          if (!isReply(a)) continue;
          const caret = a.querySelector('[data-testid="caret"]');
          if (caret) candidates.push({ article: a, caret, id });
        }
        X.stats.repliesFound = X.processed.size + candidates.length;

        let processedThisCycle = 0;
        const maxPerCycle = hidden() ? 1 : 3;
        for (const { article, caret, id } of candidates) {
          if (!X.interval) break;
          X.processed.add(id);
          const snap = tweetSnap(article);
          caret.click();
          await sleep(hidden() ? 900 : 600);

          const opened = await clickDeleteInMenu();
          if (opened) {
            await sleep(hidden() ? 900 : 600);
            if (await clickConfirm('confirmationSheetConfirm')) {
              X.stats.repliesDeleted++;
              X.backup.replies.push({ ...snap, action: 'deleted_reply', actionAt: new Date().toISOString() });
              await bumpAndCheckCap();
              if (!X.interval) break;
            }
            await sleep(hidden() ? 1200 : 800);
          }

          processedThisCycle++;
          if (processedThisCycle >= maxPerCycle) break;
        }

        noteEmpty(candidates.length);
        // Only advance once every visible candidate this cycle was handled — otherwise a
        // fast scroll would virtualize away unprocessed items before we reach them.
        if (candidates.length <= processedThisCycle) window.scrollBy(0, window.innerHeight * 0.7);
        await sleep(hidden() ? 1800 : 1200);
      } finally {
        X.busy = false;
      }
    }, 3000);
  }

  else if (action === 'followVerified' || action === 'followAll') {
    X.stats = { follows: 0, foundFollowers: 0 };
    X.interval = setInterval(async () => {
      if (X.busy || !X.interval) return;
      const issue = detectIssue();
      if (issue) { stopAll(issue); return; }
      X.busy = true;
      try {
        const cells = document.querySelectorAll('[data-testid="UserCell"]');
        const candidates = [];
        for (const cell of cells) {
          const link = cell.querySelector('a[role="link"][href^="/"]');
          const username = link?.getAttribute('href')?.replace(/^\//, '').split('/')[0];
          if (!username) continue;
          const key = `u:${username.toLowerCase()}`;
          if (X.processed.has(key)) continue;
          const followBtn = Array.from(cell.querySelectorAll('button')).find(b => {
            const testid = b.getAttribute('data-testid') || '';
            return testid.endsWith('-follow');
          });
          if (followBtn && followBtn.offsetParent !== null) {
            candidates.push({ cell, button: followBtn, key });
          } else {
            X.processed.add(key);
          }
        }
        X.stats.foundFollowers = X.processed.size + candidates.length;

        let processedThisCycle = 0;
        const maxPerCycle = hidden() ? 2 : 4;
        for (const { cell, button, key } of candidates) {
          if (!X.interval) break;
          X.processed.add(key);
          const user = userSnap(cell);
          button.click();
          X.stats.follows++;
          X.backup.follows.push({
            ...user,
            action: action === 'followVerified' ? 'followed_verified' : 'followed_all',
            actionAt: new Date().toISOString()
          });
          await bumpAndCheckCap();
          if (!X.interval) break;
          await sleep(hidden() ? 1400 : 950);

          processedThisCycle++;
          if (processedThisCycle >= maxPerCycle) break;
        }

        noteEmpty(candidates.length);
        // Only advance once every visible candidate this cycle was handled — otherwise a
        // fast scroll would virtualize away unprocessed items before we reach them.
        if (candidates.length <= processedThisCycle) window.scrollBy(0, window.innerHeight * 0.7);
        await sleep(hidden() ? 2000 : 1500);
      } finally {
        X.busy = false;
      }
    }, 3500);
  }

  else if (action === 'bulkUnfollow') {
    X.stats = { unfollows: 0, foundFollowing: 0 };
    X.interval = setInterval(async () => {
      if (X.busy || !X.interval) return;
      const issue = detectIssue();
      if (issue) { stopAll(issue); return; }
      X.busy = true;
      try {
        const cells = document.querySelectorAll('[data-testid="UserCell"]');
        const candidates = [];
        for (const cell of cells) {
          const link = cell.querySelector('a[role="link"][href^="/"]');
          const username = link?.getAttribute('href')?.replace(/^\//, '').split('/')[0];
          if (!username) continue;
          const key = `u:${username.toLowerCase()}`;
          if (X.processed.has(key)) continue;
          const unfollowBtn = Array.from(cell.querySelectorAll('button')).find(b => {
            const testid = b.getAttribute('data-testid') || '';
            return testid.endsWith('-unfollow');
          });
          if (unfollowBtn && unfollowBtn.offsetParent !== null) {
            candidates.push({ cell, button: unfollowBtn, key });
          }
        }
        X.stats.foundFollowing = X.processed.size + candidates.length;

        let processedThisCycle = 0;
        const maxPerCycle = hidden() ? 2 : 3;
        for (const { cell, button, key } of candidates) {
          if (!X.interval) break;
          X.processed.add(key);
          const user = userSnap(cell);
          button.click();
          await sleep(hidden() ? 700 : 500);
          if (await clickConfirm('confirmationSheetConfirm')) {
            X.stats.unfollows++;
            X.backup.unfollows.push({ ...user, action: 'unfollowed', actionAt: new Date().toISOString() });
            await bumpAndCheckCap();
            if (!X.interval) break;
          }
          await sleep(hidden() ? 1200 : 800);

          processedThisCycle++;
          if (processedThisCycle >= maxPerCycle) break;
        }

        noteEmpty(candidates.length);
        // Only advance once every visible candidate this cycle was handled — otherwise a
        // fast scroll would virtualize away unprocessed items before we reach them.
        if (candidates.length <= processedThisCycle) window.scrollBy(0, window.innerHeight * 0.7);
        await sleep(hidden() ? 2000 : 1500);
      } finally {
        X.busy = false;
      }
    }, 3500);
  }
}

function stopWorker() {
  if (typeof window.__xCleanerStop === 'function') {
    window.__xCleanerStop();
    return;
  }
  const X = window.__xCleaner;
  if (!X) return;
  if (X.interval) clearInterval(X.interval);
  if (X.keepAlive) clearInterval(X.keepAlive);
  if (X.mediaObserver) X.mediaObserver.disconnect();
  document.getElementById('__openxPerformanceStyle')?.remove();
  X.interval = null;
  X.keepAlive = null;
  if (!X.issue) X.issue = 'Stopped by user';
}

function readWorkerState() {
  const X = window.__xCleaner;
  if (!X) return null;
  return {
    action: X.action,
    stats: X.stats,
    running: !!X.interval,
    issue: X.issue,
    historyPersisted: !!X.historyPersisted,
    historySaveError: X.historySaveError || null,
    counts: {
      tweets: X.backup.tweets.length,
      replies: X.backup.replies.length,
      unliked: X.backup.unliked.length,
      unreposted: X.backup.unreposted.length,
      follows: X.backup.follows.length,
      unfollows: X.backup.unfollows.length
    }
  };
}

function readWorkerBackups() {
  return window.__xCleaner ? window.__xCleaner.backup : null;
}

// === Popup UI ===

function disableActionButtons(disabled) {
  ['startDelete', 'startUnlike', 'startUnrepost', 'startDeleteReplies',
   'followVerifiedFollowers', 'followAllFollowers', 'bulkUnfollow'].forEach(id => {
    const el = $(id);
    if (el) el.disabled = disabled;
  });
  $('stopAction').disabled = !disabled;
  $('openPreview').disabled = disabled;
  $('performanceMode').disabled = disabled;
  document.body.dataset.running = disabled ? 'true' : 'false';
  const moreActions = document.querySelector('.more-actions');
  if (moreActions) moreActions.inert = disabled;
}

async function openPreviewPanel(requestedType = null) {
  if (currentAction || isStarting) return;
  const tab = await findXTab();
  if (!tab) {
    updateStats('Open X in a browser tab before starting preview mode.');
    return;
  }
  try {
    if (requestedType) await chrome.storage.local.set({ previewRequestedType: requestedType });
    await chrome.sidePanel.setOptions({ tabId: tab.id, path: 'sidepanel/sidepanel.html', enabled: true });
    await chrome.sidePanel.open({ tabId: tab.id });
    window.close();
  } catch (error) {
    updateStats(`Could not open preview: ${error.message}`);
  }
}

function renderProgress() {
  const s = actionStats || {};
  if (currentAction === 'unlike') {
    $('unlikeCount').textContent = `${s.unlikes || 0} / ${s.foundLikes || 0}`;
  } else if (currentAction === 'unrepost') {
    $('unrepostCount').textContent = `${s.unreposts || 0} / ${s.foundReposts || 0}`;
  } else if (currentAction === 'deleteReplies') {
    $('repliesDeletedCount').textContent = `${s.repliesDeleted || 0} / ${s.repliesFound || 0}`;
  } else if (currentAction === 'followVerified' || currentAction === 'followAll') {
    $('followsCount').textContent = `${s.follows || 0} / ${s.foundFollowers || 0}`;
  } else if (currentAction === 'bulkUnfollow') {
    $('unfollowsCount').textContent = `${s.unfollows || 0} / ${s.foundFollowing || 0}`;
  } else {
    $('deletedCount').textContent = s.deleted || 0;
    $('foundCount').textContent = s.found || 0;
  }
}

function renderStatRows(action = currentAction) {
  document.querySelectorAll('#stats .stat-item').forEach((row) => {
    const actions = (row.dataset.actions || '').split(/\s+/);
    row.classList.toggle('visible', actions.includes('all') || actions.includes(action));
  });
}

function renderTimer() {
  if (!startTime) return;
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(elapsed / 60);
  const sec = elapsed % 60;
  $('timeElapsed').textContent = `${m}:${sec.toString().padStart(2, '0')}`;
}

function updateStats(status, action = currentAction) {
  $('stats').style.display = 'block';
  $('status').textContent = status || 'Ready';
  renderStatRows(action);
  renderProgress();
  renderTimer();
}

async function findRunningWorker() {
  const tabs = await chrome.tabs.query({ url: ['https://twitter.com/*', 'https://x.com/*'] });
  for (const tab of tabs) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: readWorkerState
      });
      const state = results?.[0]?.result;
      if (state?.running) return { tab, state };
    } catch (_) {}
  }
  return null;
}

async function endPreviewSession(session) {
  if (session?.tabId) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: session.tabId },
        func: () => {
          const preview = window.__xbcPreview;
          if (preview?.interval) clearInterval(preview.interval);
          preview?.style?.remove();
          document.getElementById('__xbcPreviewPerformance')?.remove();
          delete window.__xbcPreview;
          delete window.__xbcPreviewStop;
        }
      });
    } catch (_) {}
  }
  await chrome.storage.local.remove(['activePreviewSession']);
}

async function requestAction(action) {
  if (currentAction || isStarting || pendingAction) {
    updateStats(`${ACTION_LABELS[currentAction] || 'Another action is already running'}...`);
    return;
  }

  const stored = await chrome.storage.local.get(['activeAction', 'activePreviewSession']);
  if (stored.activeAction) {
    currentAction = stored.activeAction;
    disableActionButtons(true);
    updateStats(`${ACTION_LABELS[currentAction] || 'Processing'}...`);
    window.close();
    return;
  }
  if (action === 'deleteReplies') {
    await openPreviewPanel(stored.activePreviewSession ? null : 'replies');
    return;
  }
  pendingAction = action;
  previewSessionToEnd = stored.activePreviewSession || null;
  const account = await renderCurrentAccount();
  if (!account?.username) {
    pendingAction = null;
    previewSessionToEnd = null;
    updateStats('Open X and sign in before starting a cleanup.', action);
    return;
  }

  const config = ACTION_CONFIRMATIONS[action];
  if (!config) {
    pendingAction = null;
    previewSessionToEnd = null;
    return;
  }
  $('confirmTitle').textContent = config.title;
  $('confirmDescription').textContent = previewSessionToEnd
    ? `${config.description} Your current Preview & Select scan will end when this action starts.`
    : config.description;
  $('confirmAccount').textContent = `@${account.username}`;
  $('confirmStart').textContent = config.button;
  $('confirmStart').classList.toggle('danger', !!config.danger);
  $('confirmIconUse').setAttribute('href', `#${config.icon}`);
  $('confirmDialog').showModal();
}

async function startAction(action, previewSession = null) {
  if (!action || currentAction || isStarting) return;
  isStarting = true;

  if (previewSession) await endPreviewSession(previewSession);

  const existingWorker = await findRunningWorker();
  if (existingWorker) {
    currentAction = existingWorker.state.action;
    startTime = Date.now();
    isStarting = false;
    await chrome.storage.local.set({
      activeAction: currentAction,
      activeTabId: existingWorker.tab.id,
      startTime
    });
    disableActionButtons(true);
    updateStats(`${ACTION_LABELS[currentAction] || 'Processing'}...`);
    window.close();
    return;
  }

  updateStats('Preparing…', action);
  disableActionButtons(true);
  const tab = await ensureProfilePage(action);
  if (!tab) {
    isStarting = false;
    disableActionButtons(false);
    return;
  }

  try {
    const existing = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readWorkerState
    });
    const running = existing?.[0]?.result;
    if (running?.running) {
      currentAction = running.action;
      isStarting = false;
      disableActionButtons(true);
      updateStats(`${ACTION_LABELS[currentAction] || 'Processing'}...`);
      window.close();
      return;
    }
  } catch (_) {}

  currentAction = action;
  startTime = Date.now();
  actionStats = {};

  await chrome.storage.local.set({
    activeAction: action,
    activeTabId: tab.id,
    startTime,
    actionStats
  });

  updateStats(`${ACTION_LABELS[action]}...`);

  try {
    const performanceMode = $('performanceMode').checked;
    const { currentAccount } = await chrome.storage.local.get(['currentAccount']);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: runWorker,
      args: [action, performanceMode, currentAccount || null]
    });
    window.close();
  } catch (e) {
    updateStats(`Could not start: ${e.message}`);
    disableActionButtons(false);
    await chrome.storage.local.remove(['activeAction', 'activeTabId', 'startTime', 'actionStats']);
    currentAction = null;
    startTime = null;
  }
  isStarting = false;
}

async function stopAction() {
  const stoppedAction = currentAction;
  const tabs = await chrome.tabs.query({ url: ['https://twitter.com/*', 'https://x.com/*'] });
  for (const tab of tabs) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: stopWorker
      });
    } catch (_) {}
  }
  await chrome.storage.local.remove(['activeAction', 'activeTabId', 'startTime', 'actionStats']);
  currentAction = null;
  isStarting = false;
  startTime = null;
  disableActionButtons(false);
  updateStats('Stopped', stoppedAction);
  setTimeout(renderRecentJobs, 500);
}

async function pollOnce() {
  renderTimer();

  const tab = await findActionTab();
  if (!tab) return;

  let state;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: readWorkerState
    });
    state = results?.[0]?.result;
  } catch (_) {
    return;
  }

  if (!state) {
    if (currentAction) {
      currentAction = null;
      startTime = null;
      disableActionButtons(false);
      await chrome.storage.local.remove(['activeAction', 'activeTabId', 'startTime', 'actionStats']);
      updateStats('Stopped');
    }
    return;
  }

  if (state.running) {
    currentAction = state.action;
    actionStats = { ...actionStats, ...state.stats };
    disableActionButtons(true);
    if (!startTime) startTime = Date.now();
    updateStats(`${ACTION_LABELS[state.action] || 'Processing'}...`);
  } else if (currentAction) {
    if (!state.historyPersisted && !state.historySaveError) return;
    const label = state.issue || 'Done';
    const completedAction = currentAction;
    currentAction = null;
    startTime = null;
    disableActionButtons(false);
    await chrome.storage.local.remove(['activeAction', 'activeTabId', 'startTime', 'actionStats']);
    updateStats(label, completedAction);
    setTimeout(renderRecentJobs, 500);
  }
}

// === CSV export ===

function csvEscape(s) {
  const str = (s == null ? '' : String(s));
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function downloadCSV(content, filename) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportTweetCSV(rows, headers, filename) {
  if (!rows?.length) return;
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([r.date, r.text, r.author, r.url, r.action, r.actionAt].map(csvEscape).join(','));
  }
  downloadCSV(lines.join('\n'), filename);
}

function exportUserCSV(rows, filename) {
  if (!rows?.length) return;
  const headers = ['Username', 'Display Name', 'Profile URL', 'Action', 'Action Date'];
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([r.username, r.displayName, r.profileUrl, r.action, r.actionAt].map(csvEscape).join(','));
  }
  downloadCSV(lines.join('\n'), filename);
}

function exportAllToCSV(backup, filename) {
  const headers = ['Type', 'Date', 'Content', 'Author/Username', 'Display Name', 'URL', 'Action', 'Action Date'];
  const lines = [headers.join(',')];
  const push = (type, date, content, author, displayName, url, action, actionAt) => {
    lines.push([type, date, content, author, displayName, url, action, actionAt].map(csvEscape).join(','));
  };
  (backup.tweets || []).forEach(t => push('Deleted Tweet', t.date, t.text, t.author, '', t.url, t.action, t.actionAt));
  (backup.replies || []).forEach(t => push('Deleted Reply', t.date, t.text, t.author, '', t.url, t.action, t.actionAt));
  (backup.unliked || []).forEach(t => push('Unliked', t.date, t.text, t.author, '', t.url, t.action, t.actionAt));
  (backup.unreposted || []).forEach(t => push('Unreposted', t.date, t.text, t.author, '', t.url, t.action, t.actionAt));
  (backup.follows || []).forEach(u => push('Followed', '', '', u.username, u.displayName, u.profileUrl, u.action, u.actionAt));
  (backup.unfollows || []).forEach(u => push('Unfollowed', '', '', u.username, u.displayName, u.profileUrl, u.action, u.actionAt));
  downloadCSV(lines.join('\n'), filename);
}

const HISTORY_ACTION_LABELS = {
  delete: 'Deleted tweets',
  unlike: 'Cleared likes',
  unrepost: 'Removed reposts',
  deleteReplies: 'Deleted replies',
  followVerified: 'Followed verified accounts',
  followAll: 'Followed followers',
  bulkUnfollow: 'Bulk unfollowed'
};

function formatHistoryDate(timestamp) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  }).format(new Date(timestamp));
}

async function downloadHistoryJob(jobId) {
  const stored = await chrome.storage.local.get([`job_${jobId}`]);
  const job = stored[`job_${jobId}`];
  if (!job?.backup) return;
  const date = new Date(job.completedAt || Date.now()).toISOString().slice(0, 10);
  exportAllToCSV(job.backup, `x_bulk_clean_${job.action || 'job'}_${date}.csv`);
}

async function removeHistoryJob(jobId) {
  const stored = await chrome.storage.local.get(['jobHistory']);
  const history = Array.isArray(stored.jobHistory) ? stored.jobHistory : [];
  await chrome.storage.local.remove([`job_${jobId}`]);
  await chrome.storage.local.set({ jobHistory: history.filter(job => job?.id !== jobId) });
  await renderRecentJobs();
}

function confirmRemoveHistoryJob(jobId, button) {
  if (armedHistoryJob === jobId) {
    clearTimeout(armedHistoryTimer);
    armedHistoryJob = null;
    removeHistoryJob(jobId);
    return;
  }
  armedHistoryJob = jobId;
  document.querySelectorAll('.history-icon-button.remove.armed').forEach(item => item.classList.remove('armed'));
  button.classList.add('armed');
  button.title = 'Click again to remove';
  armedHistoryTimer = setTimeout(() => {
    armedHistoryJob = null;
    button.classList.remove('armed');
    button.title = 'Remove history entry';
  }, 3000);
}

async function clearAllHistory() {
  const stored = await chrome.storage.local.get(['jobHistory']);
  const history = Array.isArray(stored.jobHistory) ? stored.jobHistory : [];
  const keys = history.map(job => `job_${job.id}`);
  if (keys.length) await chrome.storage.local.remove(keys);
  await chrome.storage.local.set({ jobHistory: [] });
  await renderRecentJobs();
}

async function renderRecentJobs() {
  const stored = await chrome.storage.local.get(['jobHistory']);
  const history = Array.isArray(stored.jobHistory) ? stored.jobHistory : [];
  const section = $('historySection');
  const list = $('recentHistoryList');
  list.replaceChildren();
  section.style.display = history.length ? 'block' : 'none';

  for (const job of history.slice(0, 3)) {
    const row = document.createElement('div');
    row.className = 'history-row';

    const copy = document.createElement('div');
    copy.className = 'history-row-copy';
    const title = document.createElement('span');
    title.className = 'history-row-title';
    title.textContent = HISTORY_ACTION_LABELS[job.action] || 'Cleanup job';
    const meta = document.createElement('span');
    meta.className = 'history-row-meta';
    const handle = job.account?.username ? `@${job.account.username} · ` : '';
    meta.textContent = `${handle}${formatHistoryDate(job.completedAt || job.startedAt)}`;
    copy.append(title, meta);

    const count = document.createElement('span');
    count.className = 'history-row-count';
    count.textContent = `${job.total || 0}`;
    count.title = `${job.total || 0} affected records`;

    const download = document.createElement('button');
    download.type = 'button';
    download.className = 'history-icon-button download';
    download.title = 'Download job CSV';
    download.setAttribute('aria-label', `Download ${title.textContent} as CSV`);
    download.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-download"/></svg>';
    download.addEventListener('click', () => downloadHistoryJob(job.id));

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'history-icon-button remove';
    remove.title = 'Remove history entry';
    remove.setAttribute('aria-label', `Remove ${title.textContent} from history`);
    remove.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-trash"/></svg>';
    remove.addEventListener('click', () => confirmRemoveHistoryJob(job.id, remove));

    row.append(copy, count, download, remove);
    list.appendChild(row);
  }
}

// === Bootstrap ===

document.addEventListener('DOMContentLoaded', async () => {
  const settings = await chrome.storage.local.get(['performanceMode']);
  $('performanceMode').checked = settings.performanceMode ?? true;
  $('performanceMode').addEventListener('change', () => {
    chrome.storage.local.set({ performanceMode: $('performanceMode').checked });
  });

  $('startDelete').addEventListener('click', () => requestAction('delete'));
  $('startUnlike').addEventListener('click', () => requestAction('unlike'));
  $('startUnrepost').addEventListener('click', () => requestAction('unrepost'));
  $('startDeleteReplies').addEventListener('click', () => requestAction('deleteReplies'));
  $('followVerifiedFollowers').addEventListener('click', () => requestAction('followVerified'));
  $('followAllFollowers').addEventListener('click', () => requestAction('followAll'));
  $('bulkUnfollow').addEventListener('click', () => requestAction('bulkUnfollow'));
  $('stopAction').addEventListener('click', stopAction);
  $('openPreview').addEventListener('click', () => openPreviewPanel());

  $('confirmCancel').addEventListener('click', () => $('confirmDialog').close());
  $('confirmStart').addEventListener('click', () => {
    const action = pendingAction;
    const previewSession = previewSessionToEnd;
    pendingAction = null;
    previewSessionToEnd = null;
    $('confirmDialog').close();
    startAction(action, previewSession);
  });
  $('confirmDialog').addEventListener('close', () => { pendingAction = null; previewSessionToEnd = null; });

  $('viewAllHistory').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('clearRecentHistory').addEventListener('click', async () => {
    const button = $('clearRecentHistory');
    if (button.dataset.confirm === 'true') {
      clearTimeout(clearHistoryTimer);
      button.dataset.confirm = 'false';
      button.textContent = 'Clear all';
      await clearAllHistory();
      return;
    }
    button.dataset.confirm = 'true';
    button.textContent = 'Confirm clear';
    clearHistoryTimer = setTimeout(() => {
      button.dataset.confirm = 'false';
      button.textContent = 'Clear all';
    }, 3000);
  });

  await renderCurrentAccount();
  await renderRecentJobs();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.jobHistory) renderRecentJobs();
  });

  const stored = await chrome.storage.local.get(['activeAction', 'startTime', 'actionStats']);
  if (stored.activeAction) {
    currentAction = stored.activeAction;
    startTime = stored.startTime || Date.now();
    actionStats = stored.actionStats || {};
    disableActionButtons(true);
    updateStats(`${ACTION_LABELS[currentAction] || 'Processing'}...`);
  } else {
    $('stats').style.display = 'none';
  }

  await pollOnce();
  pollHandle = setInterval(pollOnce, 750);
});
