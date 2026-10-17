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
//   3. the last values that worked (chrome.storage),
//   4. the values of the build this was written against.
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
  // Seconds between actions, before jitter. Slow on purpose: one person clicking fast, not a script.
  const PACE_MS = { delete: 1500, unrepost: 1300, unlike: 1100, unfollow: 2200, follow: 3200 };

  const sleep = (ms) => new Promise(resolve => {
    // Timed by the service worker: page timers are throttled in background tabs.
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    setTimeout(done, ms);
    try {
      chrome.runtime.sendMessage({ type: 'xbc:sleep', ms }, () => { if (!chrome.runtime.lastError) done(); });
    } catch (_) {}
  });

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

  const state = { ready: false, bearer: FALLBACK_BEARER, ops: {}, me: null, sources: {} };

  async function init(account) {
    const live = captured();
    const stored = (await chrome.storage.local.get(['xbcApiCache'])).xbcApiCache || {};
    const bundle = await bundleOps();
    state.bearer = live.bearer || stored.bearer || bundle.bearer || FALLBACK_BEARER;

    const names = new Set([...Object.keys(FALLBACK_QUERY_IDS), ...Object.keys(live.ops || {}), ...Object.keys(stored.ops || {})]);
    const ops = {};
    for (const name of names) {
      const fromLive = live.ops?.[name] || {};
      const fromBundle = bundle.ops?.[name] || {};
      const fromStore = stored.ops?.[name] || {};
      const queryId = fromLive.queryId || fromBundle.queryId || fromStore.queryId || FALLBACK_QUERY_IDS[name];
      if (!queryId) continue;
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
      ops[name] = {
        queryId,
        operationType: fromBundle.operationType || fromStore.operationType || (fromLive.method && fromLive.method !== 'GET' ? 'mutation' : null),
        features,
        fieldToggles,
        variables: fromLive.variables || fromStore.variables || null
      };
      state.sources[name] = fromLive.queryId ? 'page' : fromBundle.queryId ? 'bundle' : fromStore.queryId ? 'stored' : 'fallback';
    }
    state.ops = ops;
    state.me = { id: live.viewerId || viewerId(), username: (account?.username || '').toLowerCase() };
    state.ready = !!cookie('ct0') && !!state.me.id;
    try {
      await chrome.storage.local.set({ xbcApiCache: { bearer: state.bearer, ops, savedAt: Date.now() } });
    } catch (_) {}
    return {
      ok: state.ready,
      reason: state.ready ? null : !cookie('ct0') ? 'no CSRF cookie (ct0); is X signed in?' : 'could not read the signed-in account id (twid cookie)',
      me: state.me,
      sources: { ...state.sources }
    };
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

  // One HTTP call. Returns { status, json, codes, messages, reset, binding } and never throws.
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
    let json = null;
    try { json = await response.json(); } catch (_) {}
    const errors = Array.isArray(json?.errors) ? json.errors : [];
    return {
      status: response.status,
      json,
      codes: errors.map(e => Number(e.code ?? e.extensions?.code)).filter(Number.isFinite),
      messages: errors.map(e => e.message).filter(Boolean),
      reset: Number(response.headers.get('x-rate-limit-reset')) || null,
      binding: response.headers.get('x-tfe-auth-result-code') === '3071'
    };
  }

  // Maps a response to what a job should do next (codes from X's own error enum).
  function classify(r, { okWhen } = {}) {
    const has = (...codes) => codes.some(c => r.codes.includes(c));
    const message = r.messages[0] || (r.status ? `HTTP ${r.status}` : 'network error');
    if (r.status === 429 || has(88)) return { kind: 'rate', resetAt: r.reset ? r.reset * 1000 : Date.now() + 5 * 60000, message };
    if (has(353)) return { kind: 'csrf', message };
    if (has(326)) return { kind: 'stop', message: 'X locked the account (verify it on x.com before continuing)' };
    if (has(64)) return { kind: 'stop', message: 'X reports the account as suspended' };
    if (has(161)) return { kind: 'stop', message: 'X follow limit reached for now' };
    if (has(205, 225, 226, 283, 143)) return { kind: 'stop', message: `X flagged the activity as automated (code ${r.codes.join(',')}); wait before trying again` };
    if (has(32, 89, 239) || r.binding || (r.status === 401)) return { kind: 'refused', message: r.binding ? 'X requires a signed session for this action' : 'X refused the credentials' };
    if (has(144, 34, 50, 63, 108)) return { kind: 'gone', message };
    if (r.status >= 200 && r.status < 300 && !r.codes.length && r.json && (!okWhen || okWhen(r.json))) return { kind: 'ok' };
    if (r.status === 403 || r.status === 404 || r.status === 400) return { kind: 'refused', message };
    if (r.status >= 500 || r.status === 0) return { kind: 'retry', message };
    return { kind: 'error', message };
  }

  // Runs a request, waiting out rate limits and retrying CSRF and transient failures.
  async function perform(send, { okWhen, isActive, onWait } = {}) {
    let transient = 0, csrf = 0;
    for (;;) {
      if (isActive && !isActive()) return { kind: 'stopped' };
      const result = classify(await send(), { okWhen });
      if (result.kind === 'rate') {
        const until = Math.min(result.resetAt, Date.now() + 20 * 60000) + 3000;
        onWait?.(until);
        const resumed = await waitUntil(until, isActive);
        onWait?.(null);
        if (!resumed) return { kind: 'stopped' };
        continue;
      }
      if (result.kind === 'csrf' && csrf++ < 1) continue;
      if (result.kind === 'retry' && transient++ < 2) { await sleep(3000 * transient); continue; }
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
    return perform(() => call('POST', `/i/api/graphql/${op.queryId}/${name}`, { body: { variables, queryId: op.queryId } }), options);
  }

  function friendship(kind, user, options) {
    const form = { ...FRIENDSHIP_PARAMS };
    if (user.id) form.user_id = String(user.id); else form.screen_name = user.username;
    return perform(() => call('POST', `/i/api/1.1/friendships/${kind}.json`, { form }), {
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
    let bottom = null, terminated = false;
    const visit = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 60) return;
      if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
      if (node.type === 'TimelineTerminateTimeline' && /Bottom/.test(node.direction || '')) { terminated = true; return; }
      if (node.cursorType === 'Bottom' && typeof node.value === 'string') { bottom = node.value; return; }
      if (node.promotedMetadata) return;
      if (node.tweet_results) { const t = tweetFrom(node.tweet_results.result); if (t) tweets.push(t); return; }
      if (node.user_results && (node.itemType === 'TimelineUser' || node.__typename === 'TimelineUser')) {
        const u = userFrom(node.user_results.result); if (u) users.push(u); return;
      }
      for (const key in node) visit(node[key], depth + 1);
    };
    visit(json?.data, 0);
    return { tweets, users, bottom: terminated ? null : bottom };
  }

  // Pages through a list operation. Yields { tweets, users } until the list ends.
  async function* pages(name, { isActive, onWait, pause = 900 } = {}) {
    const op = graphql(name);
    const base = { ...(LIST_DEFAULT_VARIABLES[name] || {}), ...(op.variables || {}) };
    base.userId = state.me.id; // always the signed-in account, whatever page the template came from
    delete base.cursor;
    const seen = new Set();
    let cursor = null, empty = 0;
    for (let page = 0; page < 2000; page++) {
      const variables = cursor ? { ...base, cursor } : base;
      let parsed = null;
      const result = await perform(async () => {
        // X sends features and fieldToggles only when the operation defines some.
        const nonEmpty = (o) => (o && Object.keys(o).length ? o : undefined);
        const r = await call('GET', `/i/api/graphql/${op.queryId}/${name}`, { params: { variables, features: nonEmpty(op.features), fieldToggles: nonEmpty(op.fieldToggles) } });
        parsed = r.json ? parsePage(r.json) : null;
        return r;
      }, { isActive, onWait, okWhen: json => !!json?.data });
      if (result.kind === 'stopped') return;
      if (result.kind !== 'ok') { const error = new Error(result.message || result.kind); error.result = result; throw error; }
      const fresh = {
        tweets: parsed.tweets.filter(t => !seen.has(`t${t.id}`) && seen.add(`t${t.id}`)),
        users: parsed.users.filter(u => !seen.has(`u${u.id}`) && seen.add(`u${u.id}`))
      };
      empty = fresh.tweets.length + fresh.users.length ? 0 : empty + 1;
      yield fresh;
      if (!parsed.bottom || parsed.bottom === cursor || empty >= 2) return;
      cursor = parsed.bottom;
      await sleep(pause);
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
    pace: (action) => jitter(PACE_MS[action] || 1500),
    deleteTweet: (id, options) => mutate('DeleteTweet', { tweet_id: String(id) }, { ...options, okWhen: json => !!json?.data }),
    deleteRetweet: (sourceId, options) => mutate('DeleteRetweet', { source_tweet_id: String(sourceId) }, { ...options, okWhen: json => !!json?.data?.unretweet }),
    unfavorite: (id, options) => mutate('UnfavoriteTweet', { tweet_id: String(id) }, { ...options, okWhen: json => json?.data?.unfavorite_tweet === 'Done' }),
    follow: (user, options) => friendship('create', user, options),
    unfollow: (user, options) => friendship('destroy', user, options)
  };
})();
