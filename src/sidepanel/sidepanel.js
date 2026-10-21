const X_URL = /^https:\/\/(x\.com|twitter\.com)\//;
const PAGE_SIZE = 200;

let activeTab = null;
let activeAccount = null;
let previewItems = [];
let shownItems = PAGE_SIZE;
let pollTimer = null;
let cleanupRunning = false;
let previewSnapshot = null;
let pollGeneration = 0;
let pollBusy = false;
let pollPending = false;
let selectionQueue = Promise.resolve();

const $ = (id) => document.getElementById(id);
const selectedType = () => document.querySelector('input[name="previewType"]:checked')?.value || 'tweets';
const selectedReplyScope = () => document.querySelector('input[name="replyScope"]:checked')?.value || 'fast';

async function findActiveXTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url && X_URL.test(tab.url) ? tab : null;
}

function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      setTimeout(resolve, 1200);
    };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    const timer = setTimeout(finish, timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function detectAccount(tab) {
  if (!tab) return null;
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const link = document.querySelector('[data-testid="AppTabBar_Profile_Link"]') ||
          document.querySelector('a[aria-label="Profile"]');
        const switcher = document.querySelector('[data-testid="SideNav_AccountSwitcher_Button"]');
        const href = link?.getAttribute('href') || '';
        const hrefHandle = href.replace(/^\//, '').split('/')[0];
        const texts = Array.from(switcher?.querySelectorAll('span') || [])
          .filter(span => span.children.length === 0)
          .map(span => (span.textContent || '').trim()).filter(Boolean);
        const textHandle = texts.find(text => /^@[A-Za-z0-9_]{1,15}$/.test(text));
        const username = /^[A-Za-z0-9_]{1,15}$/.test(hrefHandle) ? hrefHandle : textHandle?.slice(1);
        if (!username) return null;
        const avatar = switcher?.querySelector('img[src]') || link?.querySelector('img[src]');
        const alt = (avatar?.alt || '').trim();
        const displayName = alt && !/^(image|profile photo)$/i.test(alt)
          ? alt : texts.find(text => text !== `@${username}` && !text.startsWith('@')) || username;
        return { username, displayName, avatarUrl: avatar?.currentSrc || avatar?.src || '' };
      }
    });
    return result?.[0]?.result || null;
  } catch (_) {
    return null;
  }
}

function renderAccount(account) {
  activeAccount = account;
  const avatar = $('accountAvatar');
  $('accountName').textContent = account?.displayName || 'Account not detected';
  $('accountHandle').textContent = account?.username ? `@${account.username}` : 'Open X and sign in';
  $('accountState').textContent = account?.username ? 'Detected' : 'Not found';
  $('accountState').classList.toggle('missing', !account?.username);
  $('accountInitials').textContent = (account?.displayName || account?.username || 'X').slice(0, 2);
  if (account?.avatarUrl) {
    avatar.onload = () => { avatar.classList.add('visible'); $('accountInitials').hidden = true; };
    avatar.onerror = () => { avatar.classList.remove('visible'); $('accountInitials').hidden = false; };
    avatar.src = account.avatarUrl;
  } else {
    avatar.classList.remove('visible');
    avatar.removeAttribute('src');
    $('accountInitials').hidden = false;
  }
  $('startScan').disabled = !account?.username;
}

function showError(message) {
  $('errorMessage').textContent = message || '';
  $('errorMessage').style.display = message ? 'block' : 'none';
}

function updateSetupOptions() {
  const type = selectedType();
  const replies = type === 'replies';
  const all = replies && selectedReplyScope() === 'all';
  $('replyScope').classList.toggle('visible', replies);
  $('replyScopeNote').classList.toggle('visible', all);
  document.querySelectorAll('.date-filter').forEach(filter => { filter.hidden = type === 'unfollow'; });
  const copy = type === 'tweets'
    ? { title: 'Post cleanup', body: 'Review posts from your profile before you delete them.', tone: 'danger', start: 'Scan posts' }
    : type === 'replies'
      ? { title: all ? 'Posts + replies' : 'Replies only', body: all ? 'One pass through your Replies page. Review every selected item carefully.' : 'Scan clearly identified replies from your Replies page.', tone: all ? 'danger' : 'blue', start: 'Scan replies' }
      : type === 'reposts'
        ? { title: 'Repost cleanup', body: 'Review reposts from your timeline before removing them.', tone: 'blue', start: 'Scan reposts' }
        : { title: 'Following cleanup', body: 'Review accounts from your Following page before you unfollow them.', tone: 'danger', start: 'Scan following' };
  $('modeSummary').dataset.tone = copy.tone;
  $('modeSummary').querySelector('strong').textContent = copy.title;
  $('modeSummary').querySelector('span').textContent = copy.body;
  $('startScan').textContent = copy.start;
}

function typeLabel(type = selectedType()) {
  return type === 'unfollow' ? 'following accounts' : type === 'reposts' ? 'reposts' : type === 'replies' ? 'replies' : 'posts';
}

async function ensurePreviewPage(type) {
  activeTab = await findActiveXTab();
  if (!activeTab || !activeAccount?.username) return null;
  const domain = activeTab.url.includes('twitter.com') ? 'twitter.com' : 'x.com';
  const path = type === 'replies' ? '/with_replies' : type === 'unfollow' ? '/following' : '';
  const target = `https://${domain}/${activeAccount.username}${path}`;
  const current = (activeTab.url || '').replace(/[?#].*$/, '').replace(/\/$/, '');
  if (current !== target) {
    const loaded = waitForTabLoad(activeTab.id);
    await chrome.tabs.update(activeTab.id, { url: target, active: true });
    await loaded;
  }
  return chrome.tabs.get(activeTab.id);
}

function startPreviewScanner(type, account, performanceMode, replyScope = 'fast', useApi = false) {
  if (window.__xCleaner?.interval) return { ok: false, error: 'A cleanup job is already running.' };
  const previous = window.__xbcPreview;
  if (previous) previous.interval = null;
  if (previous?.style) previous.style.remove();

  const P = window.__xbcPreview = {
    type, replyScope,
    account,
    items: [],
    seen: new Set(),
    running: true,
    paused: false,
    done: false,
    issue: null,
    interval: null,
    style: null,
    busy: false,
    emptyCycles: 0,
    startedAt: Date.now()
  };

  // Chrome throttles timers in hidden tabs; the service worker times sleeps instead.
  const sleep = ms => new Promise(resolve => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    setTimeout(done, ms);
    try { chrome.runtime.sendMessage({ type: 'xbc:sleep', ms }, () => { void chrome.runtime.lastError; done(); }); } catch (_) {}
  });
  const hidden = () => document.hidden || document.visibilityState === 'hidden';
  // X draws tweets and UserCells outside the list being scanned too ("Who to follow" in the
  // sidebar), so the scan only looks inside the main column. No column, no items.
  const scopeRoot = () => document.querySelector('[data-testid="primaryColumn"]');
  const inColumn = selector => Array.from(scopeRoot()?.querySelectorAll(selector) || []);
  // X is a single-page app: startDomScan records the page, and the scan stops on any other.
  const routeKey = () => location.pathname.replace(/\/+$/, '').toLowerCase();
  // Whose posts are whose: X's profile link names the signed-in account, and the account detected
  // for the scan covers a page drawn without that link. With neither, or with the two naming
  // different accounts, a click scan of posts or replies stops before listing (accountIssue).
  const ownHandle = () => {
    const link = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
    return link?.getAttribute('href')?.replace(/^\//, '').split('/')[0].toLowerCase() || null;
  };
  const pageHandle = ownHandle();
  const accountHandle = account?.username?.toLowerCase() || null;
  const me = pageHandle || accountHandle;
  const accountIssue = !me
    ? 'Could not tell which account is signed in — scan stopped'
    : pageHandle && accountHandle && pageHandle !== accountHandle
      ? `This tab is signed in to @${pageHandle}, not @${accountHandle} — scan stopped`
      : null;
  const tweetId = article => article.querySelector('a[href*="/status/"]')?.getAttribute('href')?.match(/\/status\/(\d+)/)?.[1] || null;
  const authorHandle = article => article.querySelector('[data-testid="User-Name"] a[role="link"][href^="/"]')?.getAttribute('href')?.replace(/^\//, '').split('/')[0].toLowerCase() || null;
  const userHandle = cell => {
    for (const link of cell.querySelectorAll('a[role="link"][href^="/"]')) {
      const handle = link.getAttribute('href')?.replace(/^\//, '').split('/')[0];
      if (/^[A-Za-z0-9_]{1,15}$/.test(handle || '')) return handle;
    }
    return null;
  };
  const isMine = article => !!me && authorHandle(article) === me;
  const hasConnector = cell => {
    if (!cell) return false;
    const divs = cell.querySelectorAll('div');
    for (let i = 0; i < Math.min(divs.length, 160); i++) {
      const el = divs[i], width = el.offsetWidth, height = el.offsetHeight;
      if (width >= 1 && width <= 3 && height >= 18) {
        const background = getComputedStyle(el).backgroundColor;
        if (background && background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') return true;
      }
    }
    return false;
  };
  const isReply = article => {
    if (/Replying to|Em resposta a|En respuesta a|En réponse à|Antwort an/i.test((article.textContent || '').slice(0, 300))) return true;
    const cell = article.closest('[data-testid="cellInnerDiv"]');
    let previousCell = cell?.previousElementSibling;
    for (let hops = 0; previousCell && hops < 4; hops++, previousCell = previousCell.previousElementSibling) {
      if (previousCell.querySelector?.('article[data-testid="tweet"]')) return hasConnector(previousCell);
    }
    return false;
  };
  const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 240;
  const finish = (reason, done = false) => {
    P.interval = null;
    P.running = false;
    P.paused = false;
    P.done = done;
    P.issue = reason || null;
    P.style?.remove();
    P.style = null;
  };
  window.__xbcPreviewStop = () => finish('Scan stopped by user', false);

  if (performanceMode) {
    const style = document.createElement('style');
    style.id = '__xbcPreviewPerformance';
    style.textContent = 'article[data-testid="tweet"] [data-testid="tweetPhoto"],article[data-testid="tweet"] [data-testid="videoPlayer"],article[data-testid="tweet"] video{display:none!important}';
    (document.head || document.documentElement).appendChild(style);
    P.style = style;
    document.querySelectorAll('article[data-testid="tweet"] video').forEach(video => { video.pause(); video.autoplay = false; video.preload = 'none'; });
  }

  const scanTick = () => {
    if (P.busy || P.paused || !P.interval) return;
    if (routeKey() !== P.route) {
      finish('The page changed — scan stopped', false);
      return;
    }
    P.busy = true;
    try {
      let added = 0;
      if (type === 'unfollow') {
        for (const cell of inColumn('[data-testid="UserCell"]')) {
          const username = userHandle(cell);
          const id = username?.toLowerCase();
          if (!id || P.seen.has(id)) continue;
          const leafTexts = Array.from(cell.querySelectorAll('span')).filter(span => span.children.length === 0).map(span => (span.textContent || '').trim()).filter(Boolean);
          const displayName = leafTexts.find(text => text !== `@${username}` && !text.startsWith('@') && !/^(following|unfollow)$/i.test(text)) || username;
          const bio = Array.from(cell.querySelectorAll('div[dir="auto"]'))
            .map(element => (element.textContent || '').trim())
            .filter(text => text && !/^click to unfollow/i.test(text))
            .at(-1) || '';
          const avatar = cell.querySelector('[data-testid^="UserAvatar-Container"] img[src], img[src*="profile_images"]');
          P.seen.add(id);
          P.items.push({ id, type: 'account', classification: 'unfollow', text: `${displayName} @${username}`, displayName, username, bio, avatarUrl: avatar?.currentSrc || avatar?.src || '', date: '', author: username, url: `/${username}`, hasMedia: false, selected: true });
          added++;
        }
      } else for (const article of inColumn('article[data-testid="tweet"]')) {
        const id = tweetId(article);
        if (!id || P.seen.has(id)) continue;
        const repost = !!article.querySelector('[data-testid="unretweet"]');
        const reply = type === 'reposts' ? false : isReply(article);
        if (type === 'reposts') {
          if (!repost) continue;
        } else {
          if (!isMine(article)) continue;
          if (type === 'replies' && repost) continue;
          if (type === 'tweets' && reply) continue;
          if (type === 'replies' && replyScope === 'fast' && !reply) continue;
        }
        const link = article.querySelector(`a[href*="/status/${id}"]`) || article.querySelector('a[href*="/status/"]');
        P.seen.add(id);
        P.items.push({
          id,
          type: type === 'reposts' ? 'repost' : reply ? 'reply' : type === 'replies' ? 'post or orphan reply' : 'tweet',
          classification: type === 'replies' ? (reply ? 'definite' : 'standalone') : type,
          text: article.querySelector('[data-testid="tweetText"]')?.textContent || '',
          date: article.querySelector('time')?.getAttribute('datetime') || '',
          author: authorHandle(article) || me || '',
          url: link?.getAttribute('href') || '',
          hasMedia: !!article.querySelector('[data-testid="tweetPhoto"], [data-testid="videoPlayer"], video'),
          selected: true
        });
        added++;
      }
      // A hidden tab is not rendered: X draws no more items until it is visible, so neither count
      // an empty cycle as the end of the list nor scroll blind past items it has yet to draw.
      if (hidden()) {
        if (!scopeRoot()?.querySelector('article[data-testid="tweet"], [data-testid="UserCell"]')) return;
      } else if (!added && atBottom()) P.emptyCycles++;
      else P.emptyCycles = 0;
      if (P.emptyCycles >= 6) {
        finish('Scan complete', true);
        return;
      }
      window.scrollBy(0, Math.max(520, window.innerHeight * .78));
      window.dispatchEvent(new Event('scroll'));
    } finally {
      P.busy = false;
    }
  };
  const startDomScan = () => {
    P.mode = 'dom';
    P.route = routeKey();
    if ((type === 'tweets' || type === 'replies') && accountIssue) {
      finish(accountIssue, false);
      return;
    }
    window.scrollTo({ top: 0, behavior: 'auto' });
    const token = P.interval = { loop: true };
    (async () => {
      while (P.interval === token) {
        try { scanTick(); } catch (_) {}
        await sleep(1500);
      }
    })();
  };

  // API scan: lists the account's items through X's web API (worker/xapi.js), which also tells
  // replies apart exactly instead of guessing from the thread line. Falls back to scrolling the
  // page when X refuses the API before the first page.
  const LIST_OP = { tweets: 'UserTweets', reposts: 'UserTweets', replies: 'UserTweetsAndReplies', unfollow: 'Following' };
  const tweetItem = (t, itemType, classification) => ({ id: t.id, type: itemType, classification, text: t.text, date: t.date, author: t.author, url: t.url, hasMedia: t.hasMedia, selected: true });
  const toItems = (page, myId) => {
    if (type === 'unfollow') {
      return (page.users || []).filter(u => u.id !== myId).map(u => ({
        id: u.username.toLowerCase(), userId: u.id, type: 'account', classification: 'unfollow',
        text: `${u.displayName} @${u.username}`, displayName: u.displayName, username: u.username, bio: u.bio,
        avatarUrl: u.avatarUrl, date: '', author: u.username, url: `/${u.username}`, hasMedia: false, selected: true
      }));
    }
    const out = [];
    for (const t of page.tweets || []) {
      if (t.authorId !== myId) continue;
      if (type === 'reposts') { if (t.retweetOf) out.push(tweetItem(t.retweetOf, 'repost', 'reposts')); continue; }
      if (t.retweetOf) continue;
      if (type === 'tweets') { if (!t.replyTo) out.push(tweetItem(t, 'tweet', 'tweets')); continue; }
      if (t.replyTo) out.push(tweetItem(t, 'reply', 'definite'));
      else if (replyScope === 'all') out.push(tweetItem(t, 'post or orphan reply', 'standalone'));
    }
    return out;
  };
  const startApiScan = async (api) => {
    const token = P.interval = { api: true };
    const active = () => P.interval === token;
    const fallback = async (reason) => {
      if (!active()) return;
      const cooldown = await domCooldown([LIST_OP[type]]);
      if (!active()) return;
      if (cooldown) return finish(`Scan stopped: ${cooldown}`, false);
      finish(`Scan interrupted after ${P.items.length} items: ${reason}. Try again with API, or turn off API mode and start a new scan.`, false);
    };
    P.mode = 'api';
    const ready = await api.init(account);
    if (!active()) return;
    if (!ready.ok || !api.canList(LIST_OP[type])) return fallback(ready.reason || `no ${LIST_OP[type]} operation`);

    try {
      for await (const page of api.pages(LIST_OP[type], { isActive: active, onWait: until => { P.waitUntil = until; } })) {
        for (const item of toItems(page, ready.me.id)) {
          if (!P.seen.has(item.id)) { P.seen.add(item.id); P.items.push(item); }
        }
        while (P.paused && active()) await sleep(400);
        if (!active()) return;
      }
    } catch (error) {
      if (!active()) return;
      if (['stop', 'stopped', 'rate'].includes(error.result?.kind)) {
        finish(`Scan stopped after ${P.items.length} items: ${error.message || error}`, false);
        return;
      }
      return fallback(error.message || 'API scan could not finish');
    }
    if (active()) {
      if (!P.items.length) return fallback('No matching items returned by API (0 items)');
      finish('Scan complete', true);
    }
  };

  // Kept inside this serialized worker: DOM mode may run without xapi injected.
  async function domCooldown(operations) {
    const raw = (document.cookie || '').match(/(?:^|;\s*)twid=([^;]*)/)?.[1] || '';
    const accountId = decodeURIComponent(raw).match(/u=(\d+)/)?.[1];
    if (!accountId) throw new Error('Cannot identify the signed-in account for cooldown checks');
    const prefixes = operations.filter(Boolean).map(op => `xbcApiCooldown:${accountId}:${op}`);
    const keys = typeof chrome.storage.local.getKeys === 'function'
      ? (await chrome.storage.local.getKeys()).filter(key => prefixes.some(prefix => key === prefix || key.startsWith(prefix + ':claim:')))
      : null;
    const records = await chrome.storage.local.get(keys);
    let until = 0;
    for (const [key, value] of Object.entries(records)) {
      if (prefixes.some(prefix => key === prefix || key.startsWith(prefix + ':claim:')) && Number.isFinite(value?.until) && value.until > Date.now()) {
        until = Math.max(until, value.until);
      }
    }
    return until ? `X API cooldown. Job suspended; try again after ${new Date(until).toISOString()}.` : null;
  }
  const api = useApi ? globalThis.__xbcApi : null;
  if (api) startApiScan(api).catch(error => { if (P.interval) finish(`Scan stopped: ${error?.message || error}`, false); });
  else {
    const token = P.interval = { cooldown: true };
    domCooldown([LIST_OP[type]]).then(reason => {
      if (P.interval !== token) return;
      if (reason) return finish(`Scan stopped: ${reason}`, false);
      startDomScan();
    }).catch(() => { if (P.interval === token) finish('Scan stopped: could not check X cooldown for the signed-in account. Reload X before trying again.', false); });
  }
  return { ok: true };
}

function readPreviewState(includeItems = false) {
  const P = window.__xbcPreview;
  if (!P) return null;
  return {
    startedAt: P.startedAt,
    type: P.type,
    replyScope: P.replyScope,
    account: P.account,
    running: !!P.interval,
    mode: P.mode || null,
    apiFallback: P.apiFallback || null,
    paused: !!P.paused,
    done: !!P.done,
    issue: P.issue,
    count: P.items.length,
    selectedCount: P.items.filter(item => item.selected).length,
    items: includeItems ? P.items : undefined
  };
}

function controlPreviewScanner(command) {
  const P = window.__xbcPreview;
  if (!P) return null;
  if (command === 'pause') P.paused = true;
  if (command === 'resume' && P.interval) P.paused = false;
  if (command === 'stop') window.__xbcPreviewStop?.();
  if (command === 'reset') {
    P.interval = null;
    P.style?.remove();
    delete window.__xbcPreview;
    return null;
  }
  return { paused: P.paused, running: !!P.interval, count: P.items.length };
}

function updatePreviewSelection(ids, selected, startedAt) {
  const P = window.__xbcPreview;
  if (!P || P.startedAt !== startedAt) return 0;
  const wanted = new Set(ids || []);
  P.items.forEach(item => { if (wanted.has(item.id)) item.selected = selected; });
  return P.items.filter(item => item.selected).length;
}

function readCleanupState() {
  const X = window.__xCleaner;
  if (!X) return null;
  return {
    action: X.action,
    stats: X.stats,
    running: !!X.interval,
    mode: X.mode || null,
    apiFallback: X.apiFallback || null,
    issue: X.issue,
    historyPersisted: !!X.historyPersisted,
    historySaveError: X.historySaveError || null
  };
}

function runSelectedDelete(type, selectedItems, account, performanceMode, useApi = false) {
  if (window.__xCleaner?.interval) return { ok: false, error: 'Another cleanup is already running.' };
  if (window.__xbcPreview) window.__xbcPreview.interval = null;
  window.__xbcPreview?.style?.remove();
  const action = type === 'replies' ? 'deleteReplies' : type === 'reposts' ? 'unrepost' : type === 'unfollow' ? 'bulkUnfollow' : 'delete';
  const selected = new Map((selectedItems || []).map(item => [item.id, item]));
  const X = window.__xCleaner = {
    action,
    stats: type === 'replies'
      ? { repliesDeleted: 0, repliesFound: selected.size }
      : type === 'reposts' ? { unreposts: 0, foundReposts: selected.size }
        : type === 'unfollow' ? { unfollows: 0, foundFollowing: selected.size } : { deleted: 0, found: selected.size },
    backup: { tweets: [], replies: [], unliked: [], unreposted: [], follows: [], unfollows: [] },
    processed: new Set(), interval: null, keepAlive: null, busy: false, issue: null,
    emptyCycles: 0, successCount: 0, startedAt: Date.now(), historySaved: false, historyPersisted: false,
    checkpointCount: 0, lastCheckpointAt: 0, checkpointing: null, checkpointPending: false,
    jobId: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    overlayHost: null, overlayTimer: null, performanceStyle: null
  };
  // Chrome throttles timers in hidden tabs; the service worker times sleeps instead.
  const sleep = ms => new Promise(resolve => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    setTimeout(done, ms);
    try { chrome.runtime.sendMessage({ type: 'xbc:sleep', ms }, () => { void chrome.runtime.lastError; done(); }); } catch (_) {}
  });
  const hidden = () => document.hidden || document.visibilityState === 'hidden';
  // X draws tweets and UserCells outside the list being cleaned too ("Who to follow" in the
  // sidebar), so click mode only looks inside the main column. No column, no candidates.
  const scopeRoot = () => document.querySelector('[data-testid="primaryColumn"]');
  const inColumn = selector => Array.from(scopeRoot()?.querySelectorAll(selector) || []);
  // X is a single-page app: startDomLoop records the page; on any other page the job stops.
  const routeKey = () => location.pathname.replace(/\/+$/, '').toLowerCase();
  const onPage = () => X.route == null || routeKey() === X.route;
  const leftPage = async () => {
    if (onPage()) return false;
    await stop('The page changed — job stopped');
    return true;
  };
  // Whose posts are whose: X's profile link names the signed-in account, and the account confirmed
  // for the job covers a page drawn without that link. With neither, or with the two naming
  // different accounts, deleting posts or replies by clicking stops before acting (accountIssue).
  const ownHandle = () => document.querySelector('[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href')?.replace(/^\//, '').split('/')[0].toLowerCase() || null;
  const pageHandle = ownHandle();
  const accountHandle = account?.username?.toLowerCase() || null;
  const me = pageHandle || accountHandle;
  const accountIssue = !me
    ? 'Could not tell which account is signed in — job stopped'
    : pageHandle && accountHandle && pageHandle !== accountHandle
      ? `This tab is signed in to @${pageHandle}, not @${accountHandle} — job stopped`
      : null;
  const tweetId = article => article.querySelector('a[href*="/status/"]')?.getAttribute('href')?.match(/\/status\/(\d+)/)?.[1] || null;
  const authorHandle = article => article.querySelector('[data-testid="User-Name"] a[role="link"][href^="/"]')?.getAttribute('href')?.replace(/^\//, '').split('/')[0].toLowerCase() || null;
  const userHandle = cell => {
    for (const link of cell.querySelectorAll('a[role="link"][href^="/"]')) {
      const handle = link.getAttribute('href')?.replace(/^\//, '').split('/')[0];
      if (/^[A-Za-z0-9_]{1,15}$/.test(handle || '')) return handle.toLowerCase();
    }
    return null;
  };
  const hasConnector = cell => {
    const divs = cell?.querySelectorAll('div') || [];
    for (let i = 0; i < Math.min(divs.length, 160); i++) {
      const el = divs[i];
      if (el.offsetWidth >= 1 && el.offsetWidth <= 3 && el.offsetHeight >= 18) {
        const bg = getComputedStyle(el).backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return true;
      }
    }
    return false;
  };
  const isReply = article => {
    if (/Replying to|Em resposta a|En respuesta a|En réponse à|Antwort an/i.test((article.textContent || '').slice(0, 300))) return true;
    const cell = article.closest('[data-testid="cellInnerDiv"]');
    let prev = cell?.previousElementSibling;
    for (let i = 0; prev && i < 4; i++, prev = prev.previousElementSibling) {
      if (prev.querySelector?.('article[data-testid="tweet"]')) return hasConnector(prev);
    }
    return false;
  };
  const atBottom = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 240;
  const clickConfirm = async testId => {
    for (let i = 0; i < 10; i++) {
      if (!onPage()) return false;
      const button = document.querySelector(`[data-testid="${testId}"]`);
      if (button && button.offsetParent !== null) { button.click(); return true; }
      await sleep(200);
    }
    return false;
  };
  // Matching only the English "Delete" label meant nothing was deleted when X used another
  // language. Known labels first, then the red first item X uses for Delete on own posts.
  const DELETE_LABELS = new Set([
    'delete', 'delete post', 'delete tweet', 'delete reply',
    'excluir', 'excluir post', 'excluir tweet', 'excluir resposta',
    'eliminar', 'eliminar post', 'eliminar tweet', 'eliminar respuesta',
    'supprimer', 'supprimer le post', 'löschen', 'post löschen', 'elimina', 'elimina post',
    'verwijderen', 'usuń', 'sil', 'удалить', 'видалити', '削除', '삭제', '删除', '刪除',
    'hapus', 'xóa', 'ลบ', 'حذف', 'מחק'
  ]);
  const isRedText = el => {
    const m = getComputedStyle(el).color.match(/\d+/g);
    return !!m && +m[0] >= 180 && +m[1] <= 90 && +m[2] <= 90;
  };
  const clickDeleteMenu = async () => {
    for (let i = 0; i < 9; i++) {
      if (!onPage()) return false;
      const items = Array.from(document.querySelectorAll('[role="menuitem"]')).filter(item => item.offsetParent !== null);
      let button = items.find(item => DELETE_LABELS.has((item.textContent || '').trim().toLowerCase()));
      if (!button && items[0] && isRedText(items[0].querySelector('span') || items[0])) button = items[0];
      if (button) { button.click(); return true; }
      if (items.length) break; // menu is open but has no Delete
      await sleep(160);
    }
    closeMenus();
    await sleep(250);
    return false;
  };
  // X dismisses popup menus on an outside click against the real hit-target.
  const closeMenus = () => {
    try {
      const el = document.elementFromPoint(8, Math.round(window.innerHeight / 2));
      if (el && !el.closest('a') && !el.closest('[role="menuitem"]') && !el.closest('[data-testid="caret"]')) el.click();
    } catch (_) {}
  };
  // Element references go stale once X re-renders after a deletion; re-find by id.
  const liveArticle = (article, id) => {
    if (article?.isConnected) return article;
    for (const a of inColumn('article[data-testid="tweet"]')) if (tweetId(a) === id) return a;
    return null;
  };
  // Mark an id processed only after it succeeds or fails three times.
  const attempts = new Map();
  const noteFailure = id => { const n = (attempts.get(id) || 0) + 1; attempts.set(id, n); if (n >= 3) X.processed.add(id); };
  const detectIssue = () => {
    const toast = document.querySelector('[data-testid="toast"]') || document.querySelector('[role="alert"]');
    const text = (toast?.textContent || '').trim();
    if (/rate.?limit|too many requests|please wait a few moments|muitas solicitações|aguarde alguns instantes/i.test(text)) return 'Rate limited by X — wait a few moments before starting another job';
    if (/try again|something went wrong|unable|locked|restrict|exceeded|tente novamente|algo deu errado/i.test(text)) return text.slice(0, 200);
    return null;
  };
  const stopIfIssue = async (waitMs = 0) => {
    const deadline = Date.now() + waitMs;
    do {
      const issue = detectIssue();
      if (issue) { await stop(issue); return true; }
      if (Date.now() >= deadline) break;
      await sleep(100);
    } while (X.interval);
    return false;
  };
  const counts = () => ({ tweets: X.backup.tweets.length, replies: X.backup.replies.length, unliked: 0, unreposted: X.backup.unreposted.length, follows: 0, unfollows: X.backup.unfollows.length });
  const jobSummary = (status, statusText, at) => {
    const jobCounts = counts();
    const total = jobCounts.tweets + jobCounts.replies + jobCounts.unreposted + jobCounts.unfollows;
    return { id: X.jobId, action, account, startedAt: X.startedAt, ...(status === 'running' ? { checkpointAt: at } : { completedAt: at }), durationMs: at-X.startedAt, status, statusText, total, counts: jobCounts, selectedTotal: selected.size, skipped: Math.max(0, selected.size-total) };
  };
  const writeJob = async summary => {
    const stored = await chrome.storage.local.get(['jobHistory']);
    const history = Array.isArray(stored.jobHistory) ? stored.jobHistory : [];
    await chrome.storage.local.set({ jobHistory: [summary, ...history.filter(job => job?.id !== X.jobId)], [`job_${X.jobId}`]: { ...summary, backup: X.backup } });
  };
  const persist = async reason => {
    if (X.historySaved) return;
    X.historySaved = true;
    // A checkpoint still being written must land before the final record, never after it.
    await X.checkpointing;
    const status = /rate.?limit/i.test(reason || '') ? 'rate_limited' : /^Finished/i.test(reason || '') ? 'completed' : /Stopped by user/i.test(reason || '') ? 'stopped' : 'interrupted';
    try {
      await writeJob(jobSummary(status, reason || 'Action finished', Date.now()));
      X.historyPersisted = true;
    } catch (error) { X.historySaveError = error?.message || 'History save failed'; }
  };
  // Saves the job as 'running' every 10 actions or 30 s, so a reload, a closed tab or a crash
  // keeps what was already done. One write at a time, never awaited by the job; a request made
  // while one is in flight is written when it finishes. The final record replaces it.
  const checkpoint = () => {
    if (X.historySaved) return;
    const now = Date.now();
    if (X.successCount - X.checkpointCount < 10 && now - (X.lastCheckpointAt || X.startedAt) < 30000) return;
    X.checkpointCount = X.successCount;
    X.lastCheckpointAt = now;
    if (X.checkpointing) { X.checkpointPending = true; return; }
    X.checkpointing = (async () => {
      do {
        X.checkpointPending = false;
        if (X.historySaved) break;
        try { await writeJob(jobSummary('running', 'Running', Date.now())); } catch (_) {}
      } while (X.checkpointPending);
      X.checkpointing = null;
    })();
  };
  const updateOverlay = () => {
    const shadow = X.overlayHost?.shadowRoot;
    if (!shadow) return;
    const completed = type === 'replies' ? X.stats.repliesDeleted : type === 'reposts' ? X.stats.unreposts : type === 'unfollow' ? X.stats.unfollows : X.stats.deleted;
    shadow.getElementById('count').textContent = `${completed} of ${selected.size} ${type === 'unfollow' ? 'unfollowed' : type === 'reposts' ? 'removed' : 'deleted'}`;
    const kicker = shadow.querySelector('.k');
    if (X.interval && kicker) {
      kicker.textContent = X.waitUntil
        ? `X rate limit · resuming at ${new Date(X.waitUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
        : X.mode === 'api' ? 'Postscrub running · API mode' : 'Postscrub running';
    }
  };
  const createOverlay = () => {
    document.getElementById('__xbcJobOverlay')?.remove();
    const host = document.createElement('div'); host.id='__xbcJobOverlay'; host.style.cssText='position:fixed;top:16px;right:16px;z-index:2147483647';
    const shadow=host.attachShadow({mode:'open'});
    const verb = type === 'unfollow' ? 'Unfollowing' : type === 'reposts' ? 'Removing' : 'Deleting';
    const progressVerb = type === 'unfollow' ? 'unfollowed' : type === 'reposts' ? 'removed' : 'deleted';
    const object = type === 'unfollow' ? 'accounts' : type;
    shadow.innerHTML=`<style>*{box-sizing:border-box}.c{width:290px;padding:14px;border-radius:14px;background:rgba(20,20,20,.96);color:#fff;box-shadow:0 18px 48px rgba(0,0,0,.35);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.k{color:#8fd5ae;font-size:10px;font-weight:750;letter-spacing:.09em;text-transform:uppercase}h2{margin:6px 0 4px;font-size:16px}.a,.m{color:#aaa;font-size:11px}.m{margin-top:10px;font-variant-numeric:tabular-nums}button{width:100%;height:38px;margin-top:11px;border:1px solid rgba(255,90,85,.28);border-radius:8px;background:rgba(255,90,85,.12);color:#ff8580;font-weight:750;cursor:pointer}</style><section class="c"><div class="k">Postscrub running</div><h2>${verb} selected ${object}</h2><div class="a"></div><div id="count" class="m">0 of ${selected.size} ${progressVerb}</div><button id="stop">Stop current action</button></section>`;
    shadow.querySelector('.a').textContent=account?.username?`@${account.username}`:'Active account';
    shadow.getElementById('stop').addEventListener('click',()=>/rate.?limit/i.test(X.issue||'')?X.overlayHost?.remove():stop('Stopped by user'));
    (document.body||document.documentElement).appendChild(host); X.overlayHost=host; updateOverlay(); X.overlayTimer=setInterval(updateOverlay,500);
  };
  const setJobRunning = running => {
    try { chrome.runtime.sendMessage({ type: 'xbc:job', running }, () => void chrome.runtime.lastError); } catch (_) {}
    // Holding a Web Lock keeps Chrome from freezing the tab while it is in the background.
    if (running && navigator.locks) navigator.locks.request(`xbc-job-${X.jobId}`, () => new Promise(release => { X.releaseLock = release; })).catch(() => {});
    else { X.releaseLock?.(); X.releaseLock = null; }
  };
  const stop = async reason => {
    setJobRunning(false);
    if (X.keepAlive) clearInterval(X.keepAlive); if (X.overlayTimer) clearInterval(X.overlayTimer);
    X.interval=null;X.keepAlive=null;X.issue=reason;X.performanceStyle?.remove();updateOverlay();
    const shadow=X.overlayHost?.shadowRoot;if(shadow){shadow.querySelector('.k').textContent=reason;const button=shadow.getElementById('stop');if(/rate.?limit/i.test(reason||'')){button.textContent='Dismiss';button.disabled=false}else{button.disabled=true;setTimeout(()=>X.overlayHost?.remove(),2200)}}
    await persist(reason);
  };
  window.__xCleanerStop=()=>stop('Stopped by user');
  if(performanceMode){const style=document.createElement('style');style.textContent='article[data-testid="tweet"] [data-testid="tweetPhoto"],article[data-testid="tweet"] [data-testid="videoPlayer"],article[data-testid="tweet"] video{display:none!important}';(document.head||document.documentElement).appendChild(style);X.performanceStyle=style}
  createOverlay(); X.keepAlive=setInterval(()=>document.body?.setAttribute('data-xbc-keepalive',String(Date.now())),25000);
  setJobRunning(true);
  const recordSuccess=(id,snap)=>{
    X.processed.add(id);
    const actionAt=new Date().toISOString();
    if(type==='unfollow'){
      X.stats.unfollows++;
      X.backup.unfollows.push({username:snap.username||id,displayName:snap.displayName||snap.text||id,profileUrl:snap.url?.startsWith('/')?`https://x.com${snap.url}`:snap.url||`https://x.com/${id}`,action:'unfollowed',actionAt});
    }else if(type==='reposts'){
      X.stats.unreposts++;
      X.backup.unreposted.push({id,date:snap.date||'',text:snap.text||'',author:snap.author||'',url:snap.url||'',action:'unreposted',actionAt});
    }else{
      const standalone=type==='replies'&&snap.classification==='standalone';
      const row={id,date:snap.date||'',text:snap.text||'',author:snap.author||me||'',url:snap.url||'',classification:snap.classification||'',action:type==='replies'&&!standalone?'deleted_reply':'deleted',actionAt};
      if(type==='replies'){X.stats.repliesDeleted++;if(standalone)X.backup.tweets.push(row);else X.backup.replies.push(row)}else{X.stats.deleted++;X.backup.tweets.push(row)}
    }
    X.successCount++;checkpoint();updateOverlay();
  };
  const tick=async()=>{
    if(X.busy||!X.interval)return;X.busy=true;
    try{
      if(await leftPage())return;
      const issue=detectIssue();if(issue){await stop(issue);return}
      const candidates=[];
      if(type==='unfollow'){
        for(const cell of inColumn('[data-testid="UserCell"]')){
          const id=userHandle(cell);if(!id||!selected.has(id)||X.processed.has(id))continue;
          const control=Array.from(cell.querySelectorAll('button')).find(button=>{
            const testId=button.getAttribute('data-testid')||'';
            return testId.endsWith('-unfollow')||/^following$/i.test((button.textContent||'').trim());
          });
          if(control&&control.offsetParent!==null)candidates.push({cell,id,control});
        }
      }else for(const article of inColumn('article[data-testid="tweet"]')){
        const id=tweetId(article);if(!id||!selected.has(id)||X.processed.has(id))continue;
        if(type==='reposts'){
          const control=article.querySelector('[data-testid="unretweet"]');
          if(control)candidates.push({article,id,control});
        }else{
          if(!me||authorHandle(article)!==me)continue;
          const selectedItem=selected.get(id);
          if(type==='replies' && !['orphan','standalone'].includes(selectedItem?.classification) && !isReply(article))continue;
          if(type==='tweets' && isReply(article))continue;
          const control=article.querySelector('[data-testid="caret"]');if(control)candidates.push({article,id,control});
        }
      }
      let handled=0;
      for(const {article:initial,cell,id,control:initialControl} of candidates){
        if(!X.interval||await leftPage())break;const snap=selected.get(id);
        let control=initialControl;
        if(type!=='unfollow'){const article=liveArticle(initial,id);control=article?.querySelector(type==='reposts'?'[data-testid="unretweet"]':'[data-testid="caret"]');}
        else if(!cell.isConnected)control=null;
        if(!control)continue; // virtualized away; picked up again next cycle
        control.click();await sleep(600);
        if(type==='unfollow'){
          const confirmed=await clickConfirm('confirmationSheetConfirm');
          if(await stopIfIssue(confirmed?900:0))break;
          if(!confirmed)noteFailure(id);
          if(confirmed)recordSuccess(id,snap);
          await sleep(850);
        }else if(type==='reposts'){
          if(!await clickConfirm('unretweetConfirm'))noteFailure(id);
          else recordSuccess(id,snap);
          await sleep(700);
        }else if(!await clickDeleteMenu()){
          noteFailure(id);
        }else{
          await sleep(550);
          if(!await clickConfirm('confirmationSheetConfirm'))noteFailure(id);
          else recordSuccess(id,snap);
          await sleep(800);
        }
        handled++;if(handled>=3)break;
      }
      const resultVerb=type==='unfollow'?'unfollowed':type==='reposts'?'removed':'deleted';
      if(X.successCount>=selected.size){stop(`Finished — ${X.successCount} selected items ${resultVerb}`);return}
      // A hidden tab is not rendered: X draws no more items until it is visible, so neither count
      // an empty cycle as the end nor scroll blind past items it has yet to draw.
      const blind=hidden()&&!scopeRoot()?.querySelector('article[data-testid="tweet"],[data-testid="UserCell"]');
      if(!hidden()){if(!candidates.length&&atBottom())X.emptyCycles++;else X.emptyCycles=0}
      if(X.emptyCycles>=6){stop(`Finished — ${X.successCount} ${resultVerb}, ${Math.max(0,selected.size-X.successCount)} not found`);return}
      if(candidates.length<=handled&&!blind){window.scrollBy(0,Math.max(520,window.innerHeight*.75));window.dispatchEvent(new Event('scroll'))}
    }finally{X.busy=false}
  };
  // Sequential loop paced by sleep() instead of setInterval, so it keeps running in a background tab.
  const startDomLoop=()=>{
    X.mode='dom';X.route=routeKey();
    if(type!=='reposts'&&type!=='unfollow'&&accountIssue){stop(accountIssue);return}
    window.scrollTo({top:0,behavior:'auto'});
    const token=X.interval={loop:true};
    (async()=>{
      while(X.interval===token){
        const started=Date.now();
        try{await tick()}catch(_){}
        if(X.interval!==token)break;
        await sleep(Math.max(250,2600-(Date.now()-started)));
      }
    })();
  };
  // API mode: acts on the selected ids directly through X's web API (worker/xapi.js), so nothing
  // has to be found on the page again. Falls back to clicking when X refuses the API before the
  // first success.
  const runApi=async api=>{
    const token=X.interval={api:true};
    const active=()=>X.interval===token;
    const options={isActive:active,onWait:until=>{X.waitUntil=until;updateOverlay()}};
    const fallback=async reason=>{
      if(!active())return;
      const cooldown=await domCooldown();
      if(!active())return;
      if(cooldown)return stop(cooldown);
      return stop(`API job interrupted after ${X.successCount} items: ${reason}. Try again with API, or turn off API mode and start a new job; review and confirm again.`);
    };
    X.mode='api';
    const ready=await api.init(account);
    if(!active())return;
    if(!ready.ok)return fallback(ready.reason);
    const pace=type==='unfollow'?'unfollow':type==='reposts'?'unrepost':'delete';
    let failures=0,gone=0;
    for(const [id,snap] of selected){
      if(!active())return;
      if(X.processed.has(id))continue;
      const result=type==='unfollow'?await api.unfollow({id:snap.userId,username:snap.username||id},options)
        :type==='reposts'?await api.deleteRetweet(id,options):await api.deleteTweet(id,options);
      if(!active()||result.kind==='stopped')return;
      if(result.kind==='ok'){failures=0;recordSuccess(id,snap)}
      else if(result.kind==='gone'){X.processed.add(id);gone++}
      else if(result.kind==='stop'){await stop(result.message);return}
      else if(result.kind==='refused')return fallback(result.message);
      else if(++failures>=5){await stop(`X API errors: ${result.message||result.kind}`);return}
      await api.sleep(api.pace(pace));
    }
    const verb=type==='unfollow'?'unfollowed':type==='reposts'?'removed':'deleted';
    if(active())await stop(`Finished — ${X.successCount} selected items ${verb}${gone?`, ${gone} already gone`:''}`);
  };
  // Kept inside this serialized worker: DOM mode may run without xapi injected.
  async function domCooldown() {
    const list = { tweets: 'UserTweets', replies: 'UserTweetsAndReplies', reposts: 'UserTweets', unfollow: 'Following' }[type];
    const operation = type === 'unfollow' ? 'friendships/destroy' : type === 'reposts' ? 'DeleteRetweet' : 'DeleteTweet';
    const operations = [list, operation];
    const raw = (document.cookie || '').match(/(?:^|;\s*)twid=([^;]*)/)?.[1] || '';
    const accountId = decodeURIComponent(raw).match(/u=(\d+)/)?.[1];
    if (!accountId) throw new Error('Cannot identify the signed-in account for cooldown checks');
    const prefixes = operations.filter(Boolean).map(op => `xbcApiCooldown:${accountId}:${op}`);
    const keys = typeof chrome.storage.local.getKeys === 'function'
      ? (await chrome.storage.local.getKeys()).filter(key => prefixes.some(prefix => key === prefix || key.startsWith(prefix + ':claim:')))
      : null;
    const records = await chrome.storage.local.get(keys);
    let until = 0;
    for (const [key, value] of Object.entries(records)) {
      if (prefixes.some(prefix => key === prefix || key.startsWith(prefix + ':claim:')) && Number.isFinite(value?.until) && value.until > Date.now()) {
        until = Math.max(until, value.until);
      }
    }
    return until ? `X API cooldown. Job suspended; try again after ${new Date(until).toISOString()}.` : null;
  }
  const api=useApi?globalThis.__xbcApi:null;
  if(api)runApi(api).catch(error=>{if(X.interval)stop(`Error: ${error?.message||error}`)});
  else {
    const token=X.interval={cooldown:true};
    domCooldown().then(reason=>{
      if(X.interval!==token)return;
      if(reason)return stop(reason);
      startDomLoop();
    }).catch(()=>{if(X.interval===token)stop('Could not check X cooldown for the signed-in account. Reload X before trying again.')});
  }
  return {ok:true};
}

async function executeInTab(func, args = []) {
  if (!activeTab) return null;
  const result = await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, func, args });
  return result?.[0]?.result;
}

function savePreviewSelection(ids, selected) {
  const tabId = activeTab.id, startedAt = previewSnapshot?.startedAt;
  // Preserve click order, including rapid toggles, and never write into a later scan.
  selectionQueue = selectionQueue.then(() => chrome.scripting.executeScript({
    target: { tabId }, func: updatePreviewSelection, args: [ids, selected, startedAt]
  })).catch(error => showError(`Could not save selection: ${error?.message || error}`));
  return selectionQueue;
}

async function startScan() {
  showError('');
  activeTab = await findActiveXTab();
  const stored = await chrome.storage.local.get(['activeAction', 'activePreviewSession']);
  if (stored.activeAction) { showError('A cleanup job is already running. Stop it before starting a preview scan.'); return; }
  if (stored.activePreviewSession) {
    const existing = stored.activePreviewSession.tabId === activeTab?.id ? await executeInTab(readPreviewState, [false]) : { running: true };
    if (existing) { showError('Another Preview & Select session is already active. Reopen or end that session first.'); return; }
    await chrome.storage.local.remove(['activePreviewSession']);
  }
  activeAccount = await detectAccount(activeTab);
  renderAccount(activeAccount);
  if (!activeTab || !activeAccount) { showError('Open X and sign in before scanning.'); return; }
  const type = selectedType();
  await ensurePreviewPage(type);
  activeTab = await findActiveXTab();
  const useApi = $('previewApi').checked;
  if (useApi) await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, files: ['worker/xapi.js'] });
  const result = await executeInTab(startPreviewScanner, [type, activeAccount, $('previewPerformance').checked, selectedReplyScope(), useApi]);
  if (!result?.ok) { showError(result?.error || 'Could not start the scan.'); return; }
  await chrome.storage.local.set({ activePreviewSession: { tabId: activeTab.id, type, replyScope: selectedReplyScope(), account: activeAccount, startedAt: Date.now() } });
  previewItems = []; shownItems = PAGE_SIZE; previewSnapshot = null;
  $('setupSection').style.display = 'none'; $('scanCard').style.display = 'block'; $('reviewSection').style.display = 'none'; $('stickyBar').style.display = 'none';
  $('pauseScan').style.display = 'block'; $('pauseScan').disabled = false; $('stopScan').textContent = 'Stop scan'; $('stopScan').disabled = false;
  startPolling();
}

async function pollPreview() {
  if (!activeTab) return;
  if (pollBusy) { pollPending = true; return; }
  const generation = pollGeneration;
  pollBusy = true;
  try {
    if (cleanupRunning) {
      const state = await executeInTab(readCleanupState);
      if (generation !== pollGeneration) return;
      if (!state) return;
      const count = state.action === 'deleteReplies' ? state.stats?.repliesDeleted || 0 : state.action === 'unrepost' ? state.stats?.unreposts || 0 : state.action === 'bulkUnfollow' ? state.stats?.unfollows || 0 : state.stats?.deleted || 0;
      $('scanCount').textContent = `${count}`; $('scanState').textContent = state.action === 'bulkUnfollow' ? 'Unfollowing selected' : state.action === 'unrepost' ? 'Removing selected' : 'Deleting selected';
      $('scanCard').classList.toggle('done', !state.running);
      if (!state.running && (state.historyPersisted || state.historySaveError)) {
        await chrome.storage.local.remove(['activeAction','activeTabId','startTime','actionStats']);
        if (generation !== pollGeneration) return;
        cleanupRunning = false;
        $('scanCard').classList.add('done'); $('scanState').textContent = state.issue || 'Finished';
        $('pauseScan').style.display = 'none'; $('stopScan').textContent = 'New scan'; $('stopScan').disabled = false;
        $('stickyBar').style.display = 'none';
        stopPolling();
      }
      return;
    }
    let state = await executeInTab(readPreviewState, [false]);
    if (generation !== pollGeneration) return;
    if (!state) { stopPolling(); return; }
    let refreshed = false;
    if ((state.paused || state.done || !state.running) && previewStateKey(state) !== previewSnapshot?.key) {
      const full = await executeInTab(readPreviewState, [true]);
      if (generation !== pollGeneration) return;
      if (!full) { stopPolling(); return; }
      // The scanner appends items. Existing local choices remain authoritative while
      // selection writes or this snapshot are in flight.
      const previous = new Map((previewSnapshot?.startedAt === full.startedAt ? previewItems : []).map(item => [item.id, item]));
      previewItems = (full.items || []).map(item => {
        const existing = previous.get(item.id);
        return existing ? Object.assign(existing, item, { selected: existing.selected }) : item;
      });
      state = full;
      previewSnapshot = { startedAt: full.startedAt, key: previewStateKey(full) };
      refreshed = true;
    }
    $('scanCount').textContent = `${state.count || 0}`;
    $('scanCard').classList.toggle('paused', !!state.paused);
    $('scanCard').classList.toggle('done', !state.running);
    $('scanState').textContent = state.done ? 'Scan complete' : state.paused ? 'Scan paused' : state.running ? `Scanning ${typeLabel(state.type)}` : state.issue || 'Scan stopped';
    $('pauseScan').textContent = state.done ? 'Scan complete' : state.paused ? 'Resume scan' : 'Pause & review';
    $('pauseScan').disabled = !!state.done || (!state.running && !state.paused);
    $('stopScan').textContent = state.running ? 'Stop scan' : 'New scan';
    if (state.paused || state.done || !state.running) {
      if (refreshed) renderReview();
      else {
        // Resuming hides these nodes without invalidating the cached items.
        $('reviewSection').style.display = 'block';
        $('stickyBar').style.display = 'block';
      }
    }
    if (!state.running) stopPolling();
  } catch (error) {
    if (generation === pollGeneration) showError(`Could not refresh preview: ${error?.message || error}`);
  } finally {
    pollBusy = false;
    if (pollPending) { pollPending = false; pollPreview(); }
  }
}

function previewStateKey(state) {
  return JSON.stringify([state.startedAt, state.type, state.replyScope, state.running, state.paused, state.done, state.count, state.issue]);
}

function stopPolling() {
  clearInterval(pollTimer);
  pollTimer = null;
  pollGeneration++;
  pollPending = false;
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(pollPreview, 800);
  pollPreview();
}

async function togglePause() {
  const state = await executeInTab(readPreviewState, [false]);
  if (!state) return;
  await executeInTab(controlPreviewScanner, [state.paused ? 'resume' : 'pause']);
  if (state.paused) { $('reviewSection').style.display = 'none'; $('stickyBar').style.display = 'none'; }
  await pollPreview();
}

async function stopScan() {
  if (cleanupRunning) { await executeInTab(() => window.__xCleanerStop?.()); return; }
  const state = await executeInTab(readPreviewState, [false]);
  if (state && !state.running) {
    stopPolling();
    await executeInTab(controlPreviewScanner, ['reset']);
    await chrome.storage.local.remove(['activePreviewSession']);
    previewItems = []; shownItems = PAGE_SIZE; previewSnapshot = null;
    $('setupSection').style.display = 'block'; $('scanCard').style.display = 'none'; $('reviewSection').style.display = 'none'; $('stickyBar').style.display = 'none';
    return;
  }
  await executeInTab(controlPreviewScanner, ['stop']);
  await pollPreview();
}

function filteredItems() {
  const query = $('resultSearch').value.trim().toLowerCase();
  const from = $('dateFrom').value ? new Date(`${$('dateFrom').value}T00:00:00`).getTime() : null;
  const to = $('dateTo').value ? new Date(`${$('dateTo').value}T23:59:59`).getTime() : null;
  return previewItems.filter(item => {
    const time = item.date ? new Date(item.date).getTime() : null;
    const searchable = [item.text, item.displayName, item.username, item.bio].filter(Boolean).join(' ').toLowerCase();
    return (!query || searchable.includes(query)) && (!from || !time || time >= from) && (!to || !time || time <= to);
  });
}

function formatItemDate(value) {
  if (!value) return 'Unknown date';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function createResult(item) {
  const label = document.createElement('label'); label.className = `result${item.type === 'account' ? ' account-result' : ''}`;
  label.dataset.id = item.id;
  const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = item.selected; checkbox.disabled = item.classification === 'unresolved';
  if (checkbox.disabled) { label.classList.add('unverified'); label.title = 'Could not safely compare this item with the main profile. It is excluded from deletion.'; }
  checkbox.addEventListener('change', async () => { item.selected = checkbox.checked; updateSelectionCounts(); await savePreviewSelection([item.id], item.selected); });
  const text = document.createElement('span'); text.className = 'result-text'; text.textContent = item.type === 'account' ? (item.displayName || item.username) : item.text || '(No text content)';
  const meta = document.createElement('span'); meta.className = 'result-meta';
  meta.append(document.createTextNode(item.type === 'account' ? `@${item.username || item.author} · Following` : `${formatItemDate(item.date)} · ${item.type}`));
  let avatar = null;
  if (item.type === 'account') {
    avatar = document.createElement('span'); avatar.className = 'result-avatar';
    const image = document.createElement('img'); image.alt = ''; image.src = item.avatarUrl || '';
    image.addEventListener('error', () => { image.remove(); avatar.textContent = (item.displayName || item.username || '?').slice(0, 2); });
    avatar.appendChild(image);
  }
  const bio = item.type === 'account' && item.bio ? document.createElement('span') : null;
  if (bio) { bio.className = 'result-bio'; bio.textContent = item.bio; }
  if (item.hasMedia) { const media = document.createElement('span'); media.className = 'media-pill'; media.textContent = 'Media'; meta.appendChild(media); }
  if (item.url) { const link = document.createElement('a'); link.className='result-link'; link.href=item.url.startsWith('/')?`https://x.com${item.url}`:item.url; link.target='_blank'; link.rel='noopener noreferrer'; link.textContent='↗'; link.title='Open on X'; link.addEventListener('click', event => event.stopPropagation()); meta.appendChild(link); }
  label.append(checkbox, ...(avatar ? [avatar] : []), text, meta, ...(bio ? [bio] : [])); return label;
}

function renderReview() {
  const focusedRow = document.activeElement?.closest('.result');
  const focusedId = focusedRow?.dataset.id;
  const focusedIndex = focusedRow ? Array.from(focusedRow.querySelectorAll('input, a')).indexOf(document.activeElement) : -1;
  $('reviewSection').style.display = 'block'; $('stickyBar').style.display = 'block';
  $('reviewTitle').textContent = `Review ${typeLabel()}`;
  const filtered = filteredItems(); const visible = filtered.slice(0, shownItems);
  $('resultsList').replaceChildren(...visible.map(createResult));
  if (focusedIndex >= 0) {
    const row = Array.from($('resultsList').children).find(item => item.dataset.id === focusedId);
    row?.querySelectorAll('input, a')[focusedIndex]?.focus({ preventScroll: true });
  }
  $('loadMore').hidden = visible.length >= filtered.length;
  $('loadMore').textContent = `Load more (${filtered.length-visible.length} remaining)`;
  $('noResults').hidden = filtered.length !== 0;
  updateSelectionCounts();
}

function updateSelectionCounts() {
  const selected = previewItems.filter(item => item.selected && item.classification !== 'unresolved').length;
  $('selectedCount').textContent = `${selected} selected`;
  $('stickySelected').textContent = `${selected}`; $('stickyScanned').textContent = `${previewItems.length} found`;
  $('deleteSelected').disabled = !selected || cleanupRunning;
  $('deleteSelected').textContent = selectedType() === 'reposts'
    ? 'Remove selected reposts'
    : selectedType() === 'unfollow' ? 'Unfollow selected accounts'
    : selectedType() === 'replies' && selectedReplyScope() === 'all'
      ? 'Delete selected posts & replies' : 'Delete selected items';
}

async function setFilteredSelection(mode) {
  const items = filteredItems().filter(item => item.classification !== 'unresolved');
  items.forEach(item => { item.selected = mode === 'invert' ? !item.selected : mode === 'all'; });
  const writes = [];
  if (mode === 'invert') {
    const yes = items.filter(item => item.selected).map(item => item.id), no = items.filter(item => !item.selected).map(item => item.id);
    if (yes.length) writes.push(savePreviewSelection(yes, true)); if (no.length) writes.push(savePreviewSelection(no, false));
  } else if (items.length) writes.push(savePreviewSelection(items.map(item => item.id), mode === 'all'));
  renderReview();
  await Promise.all(writes);
}

function openDeleteDialog() {
  const selected = previewItems.filter(item => item.selected && item.classification !== 'unresolved');
  if (!selected.length) return;
  const reposts = selectedType() === 'reposts';
  const unfollow = selectedType() === 'unfollow';
  $('deleteAccount').textContent = `@${activeAccount.username}`;
  $('deleteCount').textContent = `${selected.length} ${selected.length === 1 ? 'item' : 'items'}`;
  $('deleteTitle').textContent = unfollow ? `Unfollow ${selected.length} selected accounts?` : `${reposts ? 'Remove' : 'Delete'} ${selected.length} selected ${typeLabel()}?`;
  $('deleteDescription').textContent = unfollow
    ? 'Only the selected accounts will be unfollowed. A detailed job record will be saved locally.'
    : reposts
    ? 'Only the selected reposts will be undone. A detailed job backup will be saved locally.'
    : selectedType() === 'replies' && selectedReplyScope() === 'all'
      ? 'Selected entries may include normal posts and orphan replies. They will be permanently deleted and backed up locally.'
      : 'The selected items will be permanently deleted. A detailed job backup will be saved locally.';
  $('confirmDelete').textContent = unfollow ? 'Unfollow selected' : reposts ? 'Remove selected' : 'Delete selected';
  $('deleteDialog').showModal();
}

async function beginSelectedDelete() {
  $('deleteDialog').close(); showError('');
  const selected = previewItems.filter(item => item.selected && item.classification !== 'unresolved');
  const currentAccount = await detectAccount(activeTab);
  if (!currentAccount || currentAccount.username.toLowerCase() !== activeAccount.username.toLowerCase()) {
    showError('The active X account changed after scanning. Start a new scan for the current account.'); return;
  }
  await executeInTab(controlPreviewScanner, ['stop']);
  await chrome.storage.local.remove(['activePreviewSession']);
  await ensurePreviewPage(selectedType()); activeTab = await findActiveXTab();
  const action = selectedType() === 'replies' ? 'deleteReplies' : selectedType() === 'reposts' ? 'unrepost' : selectedType() === 'unfollow' ? 'bulkUnfollow' : 'delete';
  const startedAt = Date.now();
  await chrome.storage.local.set({ activeAction: action, activeTabId: activeTab.id, startTime: startedAt, actionStats: {} });
  const useApi = $('previewApi').checked;
  if (useApi) await chrome.scripting.executeScript({ target: { tabId: activeTab.id }, files: ['worker/xapi.js'] });
  const result = await executeInTab(runSelectedDelete, [selectedType(), selected, activeAccount, $('previewPerformance').checked, useApi]);
  if (!result?.ok) { await chrome.storage.local.remove(['activeAction','activeTabId','startTime','actionStats']); showError(result?.error || 'Could not start selected deletion.'); return; }
  cleanupRunning = true; $('reviewSection').style.display='none'; $('stickyBar').style.display='none'; $('scanCard').style.display='block'; $('scanCard').classList.remove('paused','done'); $('scanState').textContent=action==='bulkUnfollow'?'Unfollowing selected':action==='unrepost'?'Removing selected':'Deleting selected'; $('scanCount').textContent='0'; $('pauseScan').style.display='none'; $('stopScan').textContent=action==='bulkUnfollow'?'Stop unfollowing':action==='unrepost'?'Stop removal':'Stop deletion'; $('stopScan').disabled=false; startPolling();
}

async function initialize() {
  activeTab = await findActiveXTab();
  activeAccount = await detectAccount(activeTab);
  renderAccount(activeAccount);
  const settings = await chrome.storage.local.get(['performanceMode','apiMode','activeAction','previewRequestedType']);
  $('previewPerformance').checked = settings.performanceMode ?? true;
  $('previewApi').checked = settings.apiMode ?? true;
  if (settings.previewRequestedType) {
    const requested = document.querySelector(`input[name="previewType"][value="${settings.previewRequestedType}"]`);
    if (requested) requested.checked = true;
    await chrome.storage.local.remove(['previewRequestedType']);
  }
  updateSetupOptions();
  if (settings.activeAction && activeTab) {
    const cleanup = await executeInTab(readCleanupState);
    if (cleanup?.running || (!cleanup?.historyPersisted && cleanup?.issue)) {
      cleanupRunning = true; $('setupSection').style.display='none'; $('scanCard').style.display='block'; $('scanState').textContent='Cleanup running'; startPolling(); return;
    }
    await chrome.storage.local.remove(['activeAction','activeTabId','startTime','actionStats']);
  }
  if (activeTab) {
    const state = await executeInTab(readPreviewState, [true]);
    if (state) {
      previewSnapshot = { startedAt: state.startedAt, key: previewStateKey(state) };
      previewItems = state.items || []; document.querySelector(`input[name="previewType"][value="${state.type}"]`).checked=true;
      if (state.replyScope) document.querySelector(`input[name="replyScope"][value="${state.replyScope}"]`).checked=true;
      updateSetupOptions();
      $('setupSection').style.display='none'; $('scanCard').style.display='block'; startPolling(); if(state.paused||state.done||!state.running)renderReview();
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('startScan').addEventListener('click', startScan); $('pauseScan').addEventListener('click', togglePause); $('stopScan').addEventListener('click', stopScan);
  $('selectAll').addEventListener('click',()=>setFilteredSelection('all')); $('selectNone').addEventListener('click',()=>setFilteredSelection('none')); $('invertSelection').addEventListener('click',()=>setFilteredSelection('invert'));
  ['resultSearch','dateFrom','dateTo'].forEach(id=>$(id).addEventListener('input',()=>{shownItems=PAGE_SIZE;renderReview()}));
  $('loadMore').addEventListener('click',()=>{shownItems+=PAGE_SIZE;renderReview()}); $('deleteSelected').addEventListener('click',openDeleteDialog); $('cancelDelete').addEventListener('click',()=>$('deleteDialog').close()); $('confirmDelete').addEventListener('click',beginSelectedDelete);
  $('openHistory').addEventListener('click',()=>chrome.runtime.openOptionsPage());
  $('previewApi').addEventListener('change',()=>chrome.storage.local.set({ apiMode: $('previewApi').checked }));
  document.querySelectorAll('input[name="previewType"],input[name="replyScope"]').forEach(input => input.addEventListener('change', updateSetupOptions));
  updateSetupOptions();
  initialize();
});
