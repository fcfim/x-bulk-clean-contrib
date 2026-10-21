// Client for X's own web API, injected into the X tab (isolated world) before a worker runs.
// It sends the same requests x.com's web app sends when you click, so a job needs neither a
// rendered page nor scrolling: it keeps running in a background tab.
//
// Request shapes come from X's web bundle (main.js): GraphQL at /i/api/graphql/<queryId>/<Op>,
// mutations as POST {variables, queryId}, queries as GET with variables/features/fieldToggles,
// follow and unfollow through REST 1.1 friendships with a form body. Query ids and feature sets
// change with every X build, so they are discovered at runtime, freshest source first:
//   1. what X itself requested on this page load (recorded by inject/capture.js),
//   2. the operation definitions in the loaded main.js (parsed by the service worker),
//   3. what 1 or 2 gave on an earlier run (chrome.storage xbcApiCache, each entry with its
//      source). Entries are saved when found, before any request, so they are not proof that
//      an id still works; a stored list id that X answers with 404 is removed,
//   4. the values of the build this was written against, never saved.
// A list whose id comes from 3 or 4 first waits briefly for the page's own request (pageListOp).
(() => {
  if (globalThis.__xbcApi) return;

  const FALLBACK_BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
  const FALLBACK_QUERY_IDS = {
    DeleteTweet: 'nxpZCY2K-I6QoFHAHeojFQ',
    DeleteRetweet: 'ZyZigVsNiFO6v1dEks1eWg',
    UnfavoriteTweet: 'ZYKSe-w7KEslx3JhSIk5LA',
    UserTweets: '7_KBXBpG0zBPRN6UCIV0-w',
    UserTweetsAndReplies: 'bnsYxFljT6y98rFwiGr3fw',
    Likes: 'mu4us66Q6RRNOywVQhGtRg',
    Following: 'ath0FIohYC_c3Hj3SsxoCg',
    Followers: 'stpzFPAIZ2qv8s2lRzPOnQ',
    BlueVerifiedFollowers: '1fjk4lmK45a-giaZTubqbg'
  };
  // Variables and field toggles as X's web app builds them for each list (promoted entries are
  // skipped when parsing). User lists send no fieldToggles at all.
  const LIST_DEFAULT_VARIABLES = {
    UserTweets: { count: 20, includePromotedContent: true, withQuickPromoteEligibilityTweetFields: true, withVoice: true },
    UserTweetsAndReplies: { count: 20, includePromotedContent: true, withCommunity: true, withQuickPromoteEligibilityTweetFields: true, withVoice: true },
    Likes: { count: 20, includePromotedContent: false, withClientEventToken: false, withBirdwatchNotes: false, withVoice: true },
    Following: { count: 20, includePromotedContent: false, withGrokTranslatedBio: false },
    Followers: { count: 20, includePromotedContent: false, withGrokTranslatedBio: false },
    BlueVerifiedFollowers: { count: 20, includePromotedContent: false, withGrokTranslatedBio: false }
  };
  const LIST_FIELD_TOGGLES = {
    UserTweets: { withPayments: false, withArticlePlainText: false },
    UserTweetsAndReplies: { withPayments: false, withArticlePlainText: false },
    Likes: { withPayments: false, withArticlePlainText: false }
  };
  // Feature values of the build this was written against (its logged-out config), used only for
  // names the page did not report. X itself treats a name missing from its config as false.
  const FEATURE_DEFAULTS = {"articles_preview_enabled":true,"c9s_tweet_anatomy_moderator_badge_enabled":true,"communities_web_enable_tweet_community_results_fetch":true,"content_disclosure_ai_generated_indicator_enabled":true,"content_disclosure_indicator_enabled":true,"creator_subscriptions_tweet_preview_api_enabled":true,"freedom_of_speech_not_reach_fetch_enabled":true,"graphql_is_translatable_rweb_tweet_is_translatable_enabled":true,"longform_notetweets_consumption_enabled":true,"longform_notetweets_inline_media_enabled":false,"longform_notetweets_rich_text_read_enabled":true,"post_ctas_fetch_enabled":false,"premium_content_api_read_enabled":false,"profile_label_improvements_pcf_label_in_post_enabled":true,"responsive_web_edit_tweet_api_enabled":true,"responsive_web_enhance_cards_enabled":false,"responsive_web_graphql_timeline_navigation_enabled":true,"responsive_web_grok_analysis_button_from_backend":true,"responsive_web_grok_analyze_button_fetch_trends_enabled":false,"responsive_web_grok_analyze_post_followups_enabled":false,"responsive_web_grok_annotations_enabled":true,"responsive_web_grok_community_note_auto_translation_is_enabled":true,"responsive_web_grok_image_annotation_enabled":true,"responsive_web_grok_imagine_annotation_enabled":true,"responsive_web_grok_share_attachment_enabled":true,"responsive_web_grok_show_grok_translated_post":true,"responsive_web_jetfuel_frame":true,"responsive_web_nested_quote_preview_enabled":true,"responsive_web_profile_redirect_enabled":true,"responsive_web_twitter_article_tweet_consumption_enabled":true,"rweb_cashtags_composer_attachment_enabled":true,"rweb_cashtags_enabled":true,"rweb_conversational_replies_downvote_enabled":false,"rweb_sports_post_context_enabled":true,"rweb_tipjar_consumption_enabled":false,"rweb_video_screen_enabled":false,"standardized_nudges_misinfo":true,"tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled":true,"verified_phone_label_enabled":false,"view_counts_everywhere_api_enabled":true};
  // Parameters X's web app sends with friendships/create and friendships/destroy, in its order.
  const FRIENDSHIP_PARAMS = {
    include_profile_interstitial_type: '1', include_blocking: '1', include_blocked_by: '1',
    include_followed_by: '1', include_want_retweets: '1', include_mute_edge: '1', include_can_dm: '1',
    include_can_media_tag: '1', include_ext_is_blue_verified: '1', include_ext_verified_type: '1',
    include_ext_profile_image_shape: '1', skip_status: '1'
  };
  // Milliseconds between actions, before jitter. X publishes no limit for deleting, unliking or
  // unreposting and reports of locks come from fast automated activity, so this stays near the
  // speed of clicking (about 20 a minute). Following is slower: X limits it to ~400 a day.
  const PACE_MS = { delete: 2500, unrepost: 2200, unlike: 2000, unfollow: 4000, follow: 6000 };

  const sleepStep = (ms) => new Promise(resolve => {
    // Timed by the service worker: page timers are throttled in background tabs.
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    setTimeout(done, ms);
    try {
      chrome.runtime.sendMessage({ type: 'xbc:sleep', ms }, () => { if (!chrome.runtime.lastError) done(); });
    } catch (_) {}
  });
  // The service worker times at most 20 s per request (background.js), so a longer sleep is
  // taken in steps; otherwise a long pause, such as a slowed-down pace, would end after 20 s.
  const sleep = async (ms) => { do { const step = Math.min(ms, 20000); await sleepStep(step); ms -= step; } while (ms > 0); };

  // Sleeps up to `until`, in short steps so a stop request is honored quickly.
  async function waitUntil(until, isActive) {
    while (Date.now() < until) {
      if (isActive && !isActive()) return false;
      await sleep(Math.min(15000, Math.max(250, until - Date.now())));
    }
    return !isActive || isActive();
  }

  const cookie = (name) => {
    const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : '';
  };
  const viewerId = () => (cookie('twid').match(/u=(\d+)/) || [])[1] || null;

  function captured() {
    try { return JSON.parse(document.documentElement.dataset.xbcApi || '{}'); } catch (_) { return {}; }
  }

  function bundleUrl() {
    return [...document.scripts].map(s => s.src).find(src => /\/client-web\/main\.[\w-]+\.js(?:$|\?)/.test(src)) || null;
  }

  async function bundleOps() {
    const url = bundleUrl();
    if (!url) return {};
    try {
      const reply = await chrome.runtime.sendMessage({ type: 'xbc:bundleOps', url });
      return reply?.ok ? reply : {};
    } catch (_) { return {}; }
  }

  const MIN_RATE_WAIT = 15 * 60000;
  const MAX_JOB_WAIT = 30 * 60000;
  const MAX_RATE_RETRIES = 3;
  const state = { ready: false, bearer: FALLBACK_BEARER, ops: {}, me: null, sources: {}, job: null, bundle: {}, stored: {}, pageWait: {} };

  // Each response writes a unique, immutable claim. chrome.storage has no atomic
  // read/modify/write; a short wait must never overwrite another job's longer stop.
  // This also works across tabs/origins, where a page-scoped Web Lock would not.
  const cooldownKey = (job, operation) => `xbcApiCooldown:${job.me.id}:${operation}`;
  async function readCooldown(job, operation) {
    const prefix = cooldownKey(job, operation);
    const keys = typeof chrome.storage.local.getKeys === 'function'
      ? (await chrome.storage.local.getKeys()).filter(key => key === prefix || key.startsWith(prefix + ':claim:'))
      : null;
    const records = await chrome.storage.local.get(keys);
    const active = Object.entries(records).filter(([key, value]) =>
      (key === prefix || key.startsWith(prefix + ':claim:')) && value?.until > Date.now());
    const result = { until: 0, slowdown: 1, blocked: false };
    for (const [, value] of active) {
      if (value.until > result.until && !result.blocked) result.reason = value.reason;
      if (value.blocked) { result.reason = value.reason; result.blocked = true; }
      result.until = Math.max(result.until, value.until);
      result.slowdown = Math.max(result.slowdown, value.slowdown || 1);
    }
    return result;
  }
  async function rememberCooldown(job, operation, update) {
    const claim = `${cooldownKey(job, operation)}:claim:${crypto.randomUUID()}`;
    await chrome.storage.local.set({ [claim]: { ...update, slowdown: job.slowdown } });
    return readCooldown(job, operation);
  }
  async function pruneCooldowns() {
    const keys = typeof chrome.storage.local.getKeys === 'function'
      ? (await chrome.storage.local.getKeys()).filter(key => key.startsWith('xbcApiCooldown:') && key.includes(':claim:'))
      : null;
    const records = await chrome.storage.local.get(keys);
    const expired = Object.entries(records).filter(([key, value]) =>
      key.startsWith('xbcApiCooldown:') && key.includes(':claim:') && value?.until <= Date.now()).map(([key]) => key);
    // Claims are never reused or extended. Removing an expired claim cannot erase a
    // concurrent writer; legacy shared keys are read for compatibility, never removed.
    if (expired.length) await chrome.storage.local.remove(expired);
  }
  const suspension = (until, reason = 'X API cooldown') => ({
    kind: 'stop', retryAt: until,
    message: `${reason}. Job suspended; try again after ${new Date(until).toISOString()}.`
  });

  async function waitForCooldown(job, operation, { isActive, onWait }) {
    const saved = await readCooldown(job, operation);
    if (isActive && !isActive()) return { kind: 'stopped' };
    if (!(saved.until > Date.now())) return null;
    job.slowdown = Math.max(job.slowdown, saved.slowdown || 1);
    // Never shorten a server deadline to fit the job. Keep it for the next job instead.
    if (saved.blocked || saved.until - Date.now() > MAX_JOB_WAIT - job.waited) return suspension(saved.until, saved.reason);
    const started = Date.now();
    onWait?.(saved.until);
    try {
      if (!(await waitUntil(saved.until, isActive))) return { kind: 'stopped' };
    } finally {
      job.waited += Math.max(0, Date.now() - started);
      onWait?.(null);
    }
    // Another active job may have extended this bucket while we were waiting.
    return waitForCooldown(job, operation, { isActive, onWait });
  }

  // One operation from, in order: what the page itself requested (live), the loaded main.js
  // (bundle), what was stored before, and the build this was written against.
  function resolveOp(name, live, bundle, stored) {
    const fromLive = live.ops?.[name] || {};
    const fromBundle = bundle.ops?.[name] || {};
    const fromStore = stored.ops?.[name] || {};
    const queryId = fromLive.queryId || fromBundle.queryId || fromStore.queryId || FALLBACK_QUERY_IDS[name];
    if (!queryId) return null;
    // Feature names come from the current build; each value from the page's own feature config,
    // then from what X sent for this operation, then from storage, then the defaults above.
    const known = { ...FEATURE_DEFAULTS, ...(fromStore.features || {}), ...(fromLive.features || {}), ...(live.features || {}) };
    let names = fromBundle.featureSwitches || Object.keys({ ...(fromStore.features || {}), ...(fromLive.features || {}) });
    if (!fromBundle.featureSwitches && !names.length && LIST_DEFAULT_VARIABLES[name]) names = Object.keys(FEATURE_DEFAULTS);
    const features = names.length ? Object.fromEntries(names.map(f => [f, known[f] === true])) : null;
    // Field toggles: what X sent for this operation, else what X's web app sends for it, kept
    // to the names the current build defines, in its order.
    const toggles = fromLive.fieldToggles || fromStore.fieldToggles || LIST_FIELD_TOGGLES[name] || null;
    const fieldToggles = toggles && fromBundle.fieldToggles
      ? Object.fromEntries(fromBundle.fieldToggles.filter(f => f in toggles).map(f => [f, toggles[f]]))
      : toggles;
    return {
      op: {
        queryId,
        operationType: fromBundle.operationType || fromStore.operationType || (fromLive.method && fromLive.method !== 'GET' ? 'mutation' : null),
        features,
        fieldToggles,
        variables: fromLive.variables || fromStore.variables || null
      },
      source: fromLive.queryId ? 'page' : fromBundle.queryId ? 'bundle' : fromStore.queryId ? 'stored' : 'fallback'
    };
  }

  // Cache entries saved with their source. Older versions also saved built-in ids, without a
  // source; those are not trusted, so a built-in id is never reported as stored.
  const trustedOps = (cache) => Object.fromEntries(Object.entries(cache?.ops || {})
    .filter(([, op]) => op?.queryId && (op.source === 'page' || op.source === 'bundle')));

  // Saves the named operations that came from the page or the bundle, with their source, and
  // keeps the stored entries of every other operation. Best effort.
  async function saveCache(names) {
    try {
      const cache = (await chrome.storage.local.get(['xbcApiCache'])).xbcApiCache;
      const ops = trustedOps(cache);
      for (const name of names) {
        const source = state.sources[name];
        if (state.ops[name] && (source === 'page' || source === 'bundle')) ops[name] = { ...state.ops[name], source };
      }
      await chrome.storage.local.set({ xbcApiCache: { bearer: state.bearer, ops, savedAt: Date.now() } });
    } catch (_) {}
  }

  // A stored id that X answers with 404 belongs to an older build: removes it, unless another
  // run has saved a different id since. Best effort.
  async function forgetStored(name, queryId) {
    try {
      const cache = (await chrome.storage.local.get(['xbcApiCache'])).xbcApiCache;
      if (cache?.ops?.[name]?.queryId !== queryId) return;
      const ops = { ...cache.ops };
      delete ops[name];
      await chrome.storage.local.set({ xbcApiCache: { ...cache, ops } });
    } catch (_) {}
  }

  async function init(account) {
    const live = captured();
    const settings = await chrome.storage.local.get(['xbcApiCache', 'apiPace']);
    const cache = settings.xbcApiCache || {};
    const stored = { bearer: cache.bearer, ops: trustedOps(cache) };
    // Production never runs faster than click-like pacing. Tests control their clocks instead.
    const configuredPace = Number(settings.apiPace);
    const job = { paceFactor: Number.isFinite(configuredPace) ? Math.max(1, configuredPace) : 1, slowdown: 1, waited: 0, rateRetries: 0 };
    const bundle = await bundleOps();
    state.bearer = live.bearer || stored.bearer || bundle.bearer || FALLBACK_BEARER;

    const names = new Set([...Object.keys(FALLBACK_QUERY_IDS), ...Object.keys(live.ops || {}), ...Object.keys(stored.ops || {})]);
    const ops = {}, sources = {};
    for (const name of names) {
      const resolved = resolveOp(name, live, bundle, stored);
      if (!resolved) continue;
      ops[name] = resolved.op;
      sources[name] = resolved.source;
    }
    state.ops = ops;
    state.sources = sources;
    // Kept to resolve a list again from the page's own request (pageListOp), with no new request.
    state.bundle = bundle;
    state.stored = stored;
    state.pageWait = {};
    state.me = { id: live.viewerId || viewerId(), username: (account?.username || '').toLowerCase() };
    state.ready = !!cookie('ct0') && !!state.me.id;
    job.me = { ...state.me };
    state.job = job;
    // A late response keeps its original job/account context, even after another init.
    try { await pruneCooldowns(); } catch (_) { /* Gates below fail closed on storage errors. */ }
    await saveCache(Object.keys(ops));
    return {
      ok: state.ready,
      reason: state.ready ? null : !cookie('ct0') ? 'no CSRF cookie (ct0); is X signed in?' : 'could not read the signed-in account id (twid cookie)',
      me: state.me,
      sources: { ...state.sources }
    };
  }

  // X's web app asks for a list when its page loads, which can be after a job or scan started
  // (init reads the page's record once). A list id that came neither from this page load nor
  // from the loaded bundle may be out of date, so before the first request of that list, wait
  // up to PAGE_LIST_WAIT_MS for the page's own request and take the operation from it. Without
  // it, the list goes on with the id it has. The wait sends nothing; Stop ends it.
  const PAGE_LIST_WAIT_MS = 8000;
  const PAGE_LIST_POLL_MS = 250;
  async function pageListOp(name, isActive) {
    if (state.pageWait[name] || !['stored', 'fallback'].includes(state.sources[name])) return;
    state.pageWait[name] = true;
    const until = Date.now() + PAGE_LIST_WAIT_MS;
    for (;;) {
      if (isActive && !isActive()) throw paginationError('cancelled', 'API pagination cancelled', 'stopped');
      const live = captured();
      if (live.ops?.[name]?.queryId) {
        const resolved = resolveOp(name, live, state.bundle, state.stored);
        state.ops[name] = resolved.op;
        state.sources[name] = resolved.source;
        await saveCache([name]);
        return;
      }
      if (Date.now() >= until) return;
      await sleep(PAGE_LIST_POLL_MS);
    }
  }

  function headers(json) {
    const h = {
      authorization: `Bearer ${state.bearer}`,
      'x-csrf-token': cookie('ct0'),
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': (document.documentElement.lang || 'en').split('-')[0]
    };
    h['content-type'] = json ? 'application/json' : 'application/x-www-form-urlencoded';
    return h;
  }

  const headerNumber = (response, name) => {
    const raw = response.headers.get(name);
    const value = raw == null || raw.trim() === '' ? NaN : Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  const validDeadline = value => Number.isFinite(value) && value > Date.now() && value <= 8640000000000000 ? value : 0;
  function retryAfter(response) {
    const raw = response.headers.get('retry-after');
    if (!raw?.trim()) return 0;
    return validDeadline(/^\d+(?:\.\d+)?$/.test(raw.trim()) ? Date.now() + Number(raw) * 1000 : Date.parse(raw));
  }

  // One HTTP call. No credentials or response bodies enter the cooldown store.
  async function call(method, path, { params, body, form } = {}) {
    const url = new URL(path, location.origin);
    for (const [key, value] of Object.entries(params || {})) {
      if (value != null) url.searchParams.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
    let response;
    try {
      response = await fetch(url, {
        method,
        credentials: 'include',
        headers: headers(!form),
        body: form ? new URLSearchParams(form).toString() : body ? JSON.stringify(body) : undefined
      });
    } catch (error) {
      return { status: 0, json: null, codes: [], messages: [String(error?.message || error)], reset: null };
    }
    const backoff = Number((response.headers.get('backoff-policy') || '').match(/(?:^|;)\s*backoff=(\d+)/)?.[1]);
    let json = null;
    try { json = await response.json(); } catch (_) {}
    const errors = Array.isArray(json?.errors) ? json.errors : [];
    return {
      status: response.status,
      json,
      codes: errors.map(e => Number(e.code ?? e.extensions?.code)).filter(Number.isFinite),
      messages: errors.map(e => e.message).filter(Boolean),
      reset: headerNumber(response, 'x-rate-limit-reset'),
      limit: headerNumber(response, 'x-rate-limit-limit'),
      remaining: headerNumber(response, 'x-rate-limit-remaining'),
      retryAt: retryAfter(response),
      backoffAt: validDeadline(Date.now() + backoff),
      binding: response.headers.get('x-tfe-auth-result-code') === '3071'
    };
  }

  // Maps a response to what a job should do next. Codes and their meaning come from X's own
  // error enum and handlers in its web bundle.
  const STOP_CODES = {
    326: 'X locked the account. Open x.com to unlock it before continuing.',
    445: 'X restricted the session and wants a check on x.com before continuing.',
    64: 'X reports the account as suspended.', 141: 'X reports the account as suspended or inactive.', 159: 'X reports the account as suspended.',
    89: 'Your X session expired. Reload x.com and sign in again.', 220: 'Your X session expired. Reload x.com and sign in again.',
    344: 'X daily limit for this action reached. Try again tomorrow.',
    161: 'X follow limit reached for now.'
  };
  const AUTOMATION_CODES = [225, 226, 227, 228, 263, 283, 292, 315, 382];
  const GONE_CODES = [144, 34, 50, 63, 108];

  function classify(r, { okWhen } = {}) {
    const has = (...codes) => codes.some(c => r.codes.includes(c));
    const message = r.messages[0] || (r.status ? `HTTP ${r.status}` : 'network error');
    const stop = r.codes.find(c => STOP_CODES[c]);
    if (stop) return { kind: 'stop', message: STOP_CODES[stop] };
    if (has(...AUTOMATION_CODES)) return { kind: 'stop', message: `X says this looks automated (code ${r.codes.join(', ')}). Wait a few hours before trying again.` };
    if (r.status === 429 || has(88, 143)) return { kind: 'rate', message };
    if (has(353)) return { kind: 'csrf', message };
    if (r.binding) return { kind: 'refused', message: 'X requires a signed session for this action' };
    // Success is judged the way X's app judges each operation (some tolerate errors[] beside data).
    if (r.status >= 200 && r.status < 300 && r.json && (okWhen ? okWhen(r.json) : !r.codes.length)) return { kind: 'ok' };
    if (has(...GONE_CODES)) return { kind: 'gone', message };
    if (has(32, 37, 200) || r.status === 401 || r.status === 403 || r.status === 404 || r.status === 400) return { kind: 'refused', message };
    if (has(130, 131) || r.status >= 500 || r.status === 0) return { kind: 'retry', message };
    return { kind: 'error', message };
  }

  // All callers share the job's retry/wait budget. A restriction is never a refusal,
  // so callers stop rather than switching to the click path.
  async function perform(operation, send, { okWhen, isActive, onWait } = {}, job = state.job) {
    let transient = 0, csrf = 0;
    for (;;) {
      if (isActive && !isActive()) return { kind: 'stopped' };
      try {
        const gate = await waitForCooldown(job, operation, { isActive, onWait });
        if (gate) return gate;
      } catch (_) { return { kind: 'stop', message: 'Could not read the X API cooldown. Job stopped.' }; }
      if (isActive && !isActive()) return { kind: 'stopped' };
      const response = await send();
      const result = classify(response, { okWhen });
      const limited = result.kind === 'rate' || response.remaining === 0;
      if (result.kind === 'rate') job.slowdown = Math.min(job.slowdown * 2, 8);
      if (response.limit > 0 && response.remaining != null && response.remaining <= Math.max(1, response.limit * 0.1)) job.slowdown = Math.max(job.slowdown, 2);
      const resetAt = response.reset * 1000 > Date.now() ? validDeadline(response.reset * 1000 + 10000) : 0;
      let until = Math.max(response.retryAt || 0, response.backoffAt || 0, limited ? resetAt || Date.now() + MIN_RATE_WAIT : 0, result.kind === 'stop' ? resetAt : 0);
      // X gives no daily reset here: conservatively retain code 344 for 24 hours.
      // Other stops keep any server deadline, without inventing an unlock time.
      if (response.codes.includes(344)) until = Math.max(until, Date.now() + 24 * 60 * 60000);
      if (until) {
        try {
          const saved = await rememberCooldown(job, operation, { until, reason: result.kind === 'stop' ? result.message : 'X API cooldown', blocked: result.kind === 'stop', limit: response.limit ?? null, remaining: response.remaining ?? null });
          until = saved.until;
        } catch (_) { return { kind: 'stop', message: 'Could not save the X API cooldown. Job stopped.' }; }
      }
      if (isActive && !isActive()) return { kind: 'stopped' };
      if (result.kind === 'refused') {
        // A refusal with an active server wait is a stop in every caller, never
        // permission to switch to DOM. Recheck claims written during this request too.
        try {
          const saved = await readCooldown(job, operation);
          if (isActive && !isActive()) return { kind: 'stopped' };
          if (saved.until > Date.now()) return suspension(saved.until, saved.reason);
        } catch (_) { return { kind: 'stop', message: 'Could not read the X API cooldown. Job stopped.' }; }
      }
      if (result.kind === 'rate') {
        if (++job.rateRetries > MAX_RATE_RETRIES) return suspension(until, 'X API rate retry budget reached');
        continue;
      }
      if (result.kind === 'csrf' && csrf++ < 1) continue;
      if (result.kind === 'retry' && transient++ < 3) {
        try { await rememberCooldown(job, operation, { until: Date.now() + 5000 * 3 ** (transient - 1), reason: 'X API retry backoff' }); }
        catch (_) { return { kind: 'stop', message: 'Could not save the X API cooldown. Job stopped.' }; }
        continue;
      }
      return result;
    }
  }

  const graphql = (name) => {
    const op = state.ops[name];
    if (!op) throw new Error(`unknown X operation ${name}`);
    return op;
  };

  function mutate(name, variables, options) {
    const op = graphql(name);
    return perform(name, () => call('POST', `/i/api/graphql/${op.queryId}/${name}`, { body: { variables, queryId: op.queryId } }), options);
  }

  function friendship(kind, user, options) {
    const form = { ...FRIENDSHIP_PARAMS };
    if (user.id) form.user_id = String(user.id); else form.screen_name = user.username;
    return perform(`friendships/${kind}`, () => call('POST', `/i/api/1.1/friendships/${kind}.json`, { form }), {
      ...options,
      okWhen: json => !!json && (json.id_str || json.id || json.screen_name)
    });
  }

  // === Response parsing ===
  // Walks a GraphQL timeline payload and collects top-level tweets, users and the bottom cursor,
  // without descending into a tweet (so quoted and retweeted tweets are not counted twice).
  function unwrapTweet(result) {
    if (!result) return null;
    if (result.__typename === 'TweetWithVisibilityResults') result = result.tweet;
    if (!result || !result.rest_id || !result.legacy) return null;
    return result;
  }

  function userFrom(result) {
    if (!result || result.__typename === 'UserUnavailable' || !result.rest_id) return null;
    const legacy = result.legacy || {}, core = result.core || {}, rel = result.relationship_perspectives || {};
    const username = core.screen_name || legacy.screen_name || '';
    return {
      id: result.rest_id,
      username,
      displayName: core.name || legacy.name || username,
      bio: result.profile_bio?.description ?? legacy.description ?? '',
      avatarUrl: result.avatar?.image_url || legacy.profile_image_url_https || '',
      verified: !!(result.is_blue_verified || result.verification?.verified || legacy.verified),
      protected: !!(result.privacy?.protected ?? legacy.protected),
      following: !!(rel.following ?? legacy.following),
      followRequestSent: !!(result.follow_request_sent ?? rel.follow_request_sent ?? legacy.follow_request_sent),
      followedBy: !!(rel.followed_by ?? legacy.followed_by)
    };
  }

  function tweetFrom(result) {
    const tweet = unwrapTweet(result);
    if (!tweet) return null;
    const legacy = tweet.legacy;
    const author = userFrom(tweet.core?.user_results?.result);
    const screen = author?.username || '';
    // A repost carries the original post, or sometimes only a reference to its id.
    const refId = legacy.retweetRefResult?.result?.rest_id;
    const original = legacy.retweeted_status_result?.result
      ? tweetFrom(legacy.retweeted_status_result.result)
      : refId ? { id: refId, authorId: '', author: '', text: '', date: '', url: `/i/status/${refId}`, replyTo: null, hasMedia: false, retweetOf: null } : null;
    const created = legacy.created_at ? new Date(legacy.created_at) : null;
    return {
      id: tweet.rest_id,
      authorId: legacy.user_id_str || author?.id || '',
      author: screen.toLowerCase(),
      text: tweet.note_tweet?.note_tweet_results?.result?.text || legacy.full_text || '',
      date: created && !isNaN(created) ? created.toISOString() : '',
      url: screen ? `/${screen}/status/${tweet.rest_id}` : `/i/status/${tweet.rest_id}`,
      replyTo: legacy.in_reply_to_status_id_str || null,
      hasMedia: !!(legacy.extended_entities?.media?.length || legacy.entities?.media?.length),
      retweetOf: original
    };
  }

  function parsePage(json) {
    const tweets = [], users = [];
    let bottom = null, terminated = false, groups = 0, invalid = false;
    let partial = json?.errors != null && (!Array.isArray(json.errors) || json.errors.length > 0);
    const content = (node, depth = 0) => {
      if (!node || typeof node !== 'object') return;
      if (depth > 60) { partial = true; return; }
      if (Array.isArray(node)) { for (const item of node) content(item, depth + 1); return; }
      if (node.cursorType === 'Bottom' && typeof node.value === 'string') { bottom = node.value; return; }
      if (node.promotedMetadata) return;
      if (node.tweet_results) { const t = tweetFrom(node.tweet_results.result); if (t) tweets.push(t); return; }
      if (node.user_results && (node.itemType === 'TimelineUser' || node.__typename === 'TimelineUser')) {
        const u = userFrom(node.user_results.result); if (u) users.push(u); return;
      }
      for (const value of Object.values(node)) content(value, depth + 1);
    };
    const visit = (node, depth = 0) => {
      if (!node || typeof node !== 'object') return;
      if (depth > 60) { partial = true; return; }
      if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
      if ('instructions' in node) {
        if (!Array.isArray(node.instructions)) { invalid = true; return; }
        groups++;
        for (const instruction of node.instructions) {
          if (!instruction || typeof instruction !== 'object') { invalid = true; continue; }
          if (instruction.type === 'TimelineAddEntries') {
            if (!Array.isArray(instruction.entries) || instruction.entries.some(entry => !entry || typeof entry !== 'object')) invalid = true;
            else content(instruction.entries);
          } else if (instruction.type === 'TimelineReplaceEntry' || instruction.type === 'TimelinePinEntry') {
            if (!instruction.entry || typeof instruction.entry !== 'object') invalid = true;
            else content(instruction.entry);
          } else if (instruction.type === 'TimelineAddToModule') {
            if (!Array.isArray(instruction.moduleItems)) invalid = true;
            else content(instruction.moduleItems);
          } else if (instruction.type === 'TimelineTerminateTimeline') {
            if (instruction.direction === 'Bottom') terminated = true;
            else if (instruction.direction !== 'Top') invalid = true;
          } else if (instruction.type !== 'TimelineClearCache') partial = true;
        }
        return;
      }
      for (const value of Object.values(node)) visit(value, depth + 1);
    };
    visit(json?.data);
    return { tweets, users, bottom, terminated, recognized: groups > 0 && !invalid, partial: partial || groups > 1 };
  }

  const paginationError = (reason, message, kind = 'incomplete') => {
    const error = new Error(message);
    error.result = { kind, reason, message };
    return error;
  };

  // Heuristic, not proof of completion: ten empty pages allows more progress than
  // the old two-page cutoff (a typical page has about 20 items), without spending
  // up to 2,000 requests on empty continuations. Explicit termination still wins.
  const MAX_EMPTY_PAGE_STREAK = 10;

  // Normal return means an explicit bottom termination in a recognized timeline.
  // Every incomplete/cancelled path throws, so callers cannot mistake it for completion.
  async function* pages(name, { isActive, onWait, pause = 900 } = {}) {
    graphql(name);
    const job = state.job;
    await pageListOp(name, isActive);
    const op = graphql(name);
    const source = state.sources[name];
    const base = { ...(LIST_DEFAULT_VARIABLES[name] || {}), ...(op.variables || {}) };
    base.userId = job.me.id;
    delete base.cursor;
    const seen = new Set(), cursors = new Set();
    let cursor = null, emptyStreak = 0;
    for (let page = 0; page < 2000; page++) {
      const variables = cursor ? { ...base, cursor } : base;
      let parsed = null, status = null;
      const result = await perform(name, async () => {
        const nonEmpty = o => o && Object.keys(o).length ? o : undefined;
        const r = await call('GET', `/i/api/graphql/${op.queryId}/${name}`, { params: { variables, features: nonEmpty(op.features), fieldToggles: nonEmpty(op.fieldToggles) } });
        parsed = r.json ? parsePage(r.json) : null;
        status = r.status;
        return r;
      }, { isActive, onWait, okWhen: json => !!json?.data }, job);
      if (status === 404 && source === 'stored') await forgetStored(name, op.queryId);
      if (result.kind === 'stopped') throw paginationError('cancelled', 'API pagination cancelled', 'stopped');
      if (result.kind !== 'ok') {
        const error = new Error(result.message || result.kind);
        // What X refused, without secrets: the operation, the HTTP status (null when no request
        // was sent) and where its query id came from.
        error.result = { ...result, operation: name, status, source };
        throw error;
      }
      if (!parsed?.recognized) throw paginationError('invalid_timeline', 'X returned an unrecognized or malformed timeline');
      const fresh = {
        tweets: parsed.tweets.filter(t => !seen.has(`t${t.id}`) && seen.add(`t${t.id}`)),
        users: parsed.users.filter(u => !seen.has(`u${u.id}`) && seen.add(`u${u.id}`)),
        partial: parsed.partial
      };
      emptyStreak = fresh.tweets.length || fresh.users.length ? 0 : emptyStreak + 1;
      yield fresh;
      if (isActive && !isActive()) throw paginationError('cancelled', 'API pagination cancelled', 'stopped');
      if (parsed.partial) throw paginationError('partial_response', 'X returned a partial or unsupported timeline response');
      if (parsed.terminated) return { kind: 'complete', reason: 'explicit_end', pages: page + 1 };
      if (!parsed.bottom) throw paginationError('missing_cursor', 'Timeline has no bottom cursor or explicit end');
      if (parsed.bottom === cursor) throw paginationError('cursor_stalled', 'Timeline cursor stopped advancing');
      if (cursors.has(parsed.bottom)) throw paginationError('cursor_cycle', 'Timeline cursor entered a cycle');
      if (emptyStreak >= MAX_EMPTY_PAGE_STREAK) throw paginationError('empty_streak', `${MAX_EMPTY_PAGE_STREAK} consecutive pages without new items; API safety limit reached`);
      if (page === 1999) throw paginationError('page_budget', 'API page safety limit reached');
      cursors.add(parsed.bottom);
      cursor = parsed.bottom;
      if (!(await waitUntil(Date.now() + Math.max(900, Number(pause) || 900) * job.paceFactor * job.slowdown, isActive))) throw paginationError('cancelled', 'API pagination cancelled', 'stopped');
    }
  }

  const jitter = (ms) => ms + Math.floor(Math.random() * ms * 0.5);

  globalThis.__xbcApi = {
    version: 1,
    init,
    me: () => state.me,
    sources: () => ({ ...state.sources }),
    canList: (name) => !!state.ops[name]?.queryId,
    pages,
    parsePage,
    sleep,
    pace: (action) => jitter((PACE_MS[action] || 2500) * state.job.paceFactor * state.job.slowdown),
    // DeleteTweet fails on any error, as in X's app; the others succeed on their data check.
    deleteTweet: (id, options) => mutate('DeleteTweet', { tweet_id: String(id) }, { ...options, okWhen: json => !!json?.data && !json.errors?.length }),
    deleteRetweet: (sourceId, options) => mutate('DeleteRetweet', { source_tweet_id: String(sourceId) }, { ...options, okWhen: json => !!json?.data?.unretweet?.source_tweet_results?.result }),
    unfavorite: (id, options) => mutate('UnfavoriteTweet', { tweet_id: String(id) }, { ...options, okWhen: json => json?.data?.unfavorite_tweet === 'Done' }),
    follow: (user, options) => friendship('create', user, options),
    unfollow: (user, options) => friendship('destroy', user, options)
  };
})();
