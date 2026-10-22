// A stand-in for x.com and its web API, served through Playwright routing. Pages carry the bits
// of X's DOM the extension reads (profile link, timeline articles with the post menu) and, like
// X's web app, request their timeline from the GraphQL API on load. The API answers in the shape
// of X's responses and can misbehave on demand: rate limits, refused requests, session binding.
import fs from 'node:fs';

const BEARER = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const QUERY_IDS = {
  DeleteTweet: 'nxpZCY2K-I6QoFHAHeojFQ', DeleteRetweet: 'ZyZigVsNiFO6v1dEks1eWg', UnfavoriteTweet: 'ZYKSe-w7KEslx3JhSIk5LA',
  UserTweets: '7_KBXBpG0zBPRN6UCIV0-w', UserTweetsAndReplies: 'bnsYxFljT6y98rFwiGr3fw', Likes: 'mu4us66Q6RRNOywVQhGtRg',
  Following: 'ath0FIohYC_c3Hj3SsxoCg', Followers: 'stpzFPAIZ2qv8s2lRzPOnQ', BlueVerifiedFollowers: '1fjk4lmK45a-giaZTubqbg'
};
const PATH_OP = { '': 'UserTweets', with_replies: 'UserTweetsAndReplies', likes: 'Likes', following: 'Following', followers: 'Followers', verified_followers: 'BlueVerifiedFollowers' };
export const ME = { id: '42', screen: 'me', name: 'Test Account' };
// The web bundle the fake page names. The extension's service worker reads its operations from
// the xbcBundleOps cache when the URL matches, so a test can seed it instead of fetching it.
export const BUNDLE_URL = 'https://abs.twimg.com/responsive-web/client-web/main.b09082b07a640734a.js';

// A date as X's API writes created_at ("Mon Jan 01 12:00:00 +0000 2024").
export const xCreatedAt = (date) => new Date(date).toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, '$1 $3 $2 $5 +0000 $4');
const twitterDate = (i) => xCreatedAt(Date.UTC(2024, 0, 1 + i, 12));

export function createState({ own = 12, replies = 0, retweets = 0, likes = 0, following = 0, followers = 0, followedBack = 0, pageSize = 7 } = {}) {
  const users = (n, prefix, extra = () => ({})) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${100 + i}`, screen: `${prefix}${i}`, name: `${prefix.toUpperCase()} ${i}`, ...extra(i) }));
  const tweets = [];
  for (let i = 0; i < own; i++) tweets.push({ id: `9${1000 + i}`, authorId: ME.id, text: `my post ${i}`, created: twitterDate(i) });
  for (let i = 0; i < replies; i++) tweets.push({ id: `8${1000 + i}`, authorId: ME.id, text: `my reply ${i}`, created: twitterDate(i), replyTo: `7${1000 + i}`, parent: { id: `7${1000 + i}`, authorId: '500', screen: 'someone', text: `their post ${i}` } });
  for (let i = 0; i < retweets; i++) tweets.push({ id: `6${1000 + i}`, authorId: ME.id, text: `RT`, created: twitterDate(i), retweetOf: { id: `5${1000 + i}`, authorId: '501', screen: 'author', text: `original ${i}` } });
  // Every item gets a fixed sort position, so cursors survive deletions like X's do.
  let seq = 0;
  const stamp = (list) => list.map(item => ({ ...item, seq: ++seq }));
  return {
    tweets: stamp(tweets),
    likes: stamp(Array.from({ length: likes }, (_, i) => ({ id: `4${1000 + i}`, authorId: '502', screen: 'liked', text: `liked ${i}`, created: twitterDate(i) }))),
    following: stamp(users(following, 'f')),
    followers: stamp(users(followers, 'r', i => ({ following: i < followedBack, verified: i % 2 === 0 }))),
    pageSize,
    calls: [],
    misbehave: { rateLimitAfter: null, rateLimitSeconds: 3, refuse: {}, binding: {}, errorCode: null, responses: {} },
    mutations: 0
  };
}

// Opt-in X behaviours, set by a scenario's setup; without them X is unchanged:
//  state.queryIds:              { Operation: queryId } X's current ids where they differ from the
//                               defaults (which equal the extension's built-in ones), as after a
//                               new X build; the page uses them and any other id gets a 404
//  state.pageRequest:           { delay } the page asks for its list that many ms after load
//                               instead of inline, or { skip: true } it never asks (on the
//                               Replies page it then never asks for more either)
//  misbehave.responses[op]:     an entry { pass: true } lets that request through unchanged, so a
//                               later forced response can target a later page
//  state.misbehave.emptyNotFound: an unknown query id gets a 404 with an empty body, as X answers
//  post.created:                a date X cannot parse is sent as is, in the API's created_at and in
//                               the page's time[datetime]
//  post.timeless:               the page draws the post without its time element
// Always on, as on x.com: the page's own API requests carry an x-client-transaction-id (a stand-in
// value here; X's page makes a new one for each request) and are recorded with fromPage: true.
// X answers UserTweetsAndReplies without that header with a 404 and an empty body.
const currentIds = (state) => ({ ...QUERY_IDS, ...(state.queryIds || {}) });

// The xbcBundleOps cache entry for the fake page's bundle: X's current operations, without the
// ones named in `omit`. Seeding it keeps the service worker from fetching the bundle.
export function seededBundle(state, { omit = [] } = {}) {
  const ops = {};
  for (const [name, queryId] of Object.entries(currentIds(state))) {
    if (omit.includes(name)) continue;
    const query = !/^(Delete|Unfavorite)/.test(name);
    ops[name] = {
      queryId,
      operationType: query ? 'query' : 'mutation',
      featureSwitches: query ? ['rweb_video_screen_enabled', 'responsive_web_graphql_timeline_navigation_enabled'] : [],
      fieldToggles: query && !/Follow/.test(name) ? ['withPayments', 'withArticlePlainText'] : []
    };
  }
  return { url: BUNDLE_URL, ops, bearer: BEARER, at: Date.now() };
}

const userResult = (u, extra = {}) => ({
  __typename: 'User', rest_id: u.id, is_blue_verified: !!u.verified,
  core: { screen_name: u.screen, name: u.name || u.screen },
  legacy: { description: `bio of ${u.screen}`, profile_image_url_https: 'https://pbs.twimg.com/profile_images/1/a.jpg' },
  relationship_perspectives: { following: !!u.following, ...extra }
});
const tweetResult = (t) => {
  const author = t.authorId === ME.id ? { id: ME.id, screen: ME.screen, name: ME.name } : { id: t.authorId, screen: t.screen, name: t.screen };
  const legacy = { full_text: t.text, created_at: t.created || twitterDate(0), user_id_str: t.authorId, in_reply_to_status_id_str: t.replyTo || undefined };
  if (t.retweetOf) legacy.retweeted_status_result = { result: tweetResult({ ...t.retweetOf, created: twitterDate(1) }) };
  return { __typename: 'Tweet', rest_id: t.id, core: { user_results: { result: userResult(author) } }, legacy };
};
const tweetEntry = (t) => ({ entryId: `tweet-${t.id}`, content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineTweet', tweet_results: { result: tweetResult(t) } } } });
const userEntry = (u) => ({ entryId: `user-${u.id}`, content: { entryType: 'TimelineTimelineItem', itemContent: { itemType: 'TimelineUser', user_results: { result: userResult(u) } } } });
const cursorEntry = (value) => ({ entryId: `cursor-bottom-${value}`, content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value } });

function listFor(state, op) {
  if (op === 'UserTweets') return state.tweets.filter(t => !t.replyTo);
  if (op === 'UserTweetsAndReplies') return state.tweets;
  if (op === 'Likes') return state.likes;
  if (op === 'Following') return state.following;
  if (op === 'Followers') return state.followers;
  if (op === 'BlueVerifiedFollowers') return state.followers.filter(u => u.verified);
  return [];
}

function page(state, op, variables) {
  const all = listFor(state, op);
  // The cursor is the sort position of the last item served, so deleting items does not shift it.
  const after = variables.cursor ? Number(variables.cursor.split(':')[1]) : 0;
  const slice = all.filter(item => item.seq > after).slice(0, state.pageSize);
  const isUsers = ['Following', 'Followers', 'BlueVerifiedFollowers'].includes(op);
  const entries = [];
  for (const item of slice) {
    if (isUsers) entries.push(userEntry(item));
    else if (item.parent) {
      // Replies come as a conversation module: the other person's post, then yours.
      entries.push({ entryId: `profile-conversation-${item.id}`, content: { entryType: 'TimelineTimelineModule', items: [
        { entryId: `x-${item.parent.id}`, item: { itemContent: { itemType: 'TimelineTweet', tweet_results: { result: tweetResult(item.parent) } } } },
        { entryId: `x-${item.id}`, item: { itemContent: { itemType: 'TimelineTweet', tweet_results: { result: tweetResult(item) } } } }
      ] } });
    } else entries.push(tweetEntry(item));
  }
  entries.push(cursorEntry(`c:${slice.length ? slice[slice.length - 1].seq : after}`));
  const hasMore = all.some(item => item.seq > (slice.at(-1)?.seq ?? after));
  const timeline = { timeline: { instructions: [{ type: 'TimelineClearCache' }, { type: 'TimelineAddEntries', entries }, ...(!hasMore ? [{ type: 'TimelineTerminateTimeline', direction: 'Bottom' }] : [])] } };
  return { data: { user: { result: { __typename: 'User', timeline } } } };
}

// Scripted scan sequences for deterministic termination/cursor fixtures.
export function scriptedTimeline(state, { indices = [], cursor = null, end = false, errors } = {}) {
  const entries = indices.map(index => tweetEntry(state.tweets[index]));
  if (cursor !== null) entries.push(cursorEntry(cursor));
  const instructions = [{ type: 'TimelineAddEntries', entries }, ...(end ? [{ type: 'TimelineTerminateTimeline', direction: 'Bottom' }] : [])];
  return { ...(errors ? { errors } : {}), data: { user: { result: { __typename: 'User', timeline: { timeline: { instructions } } } } } };
}

const json = (route, status, body, headers = {}) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });

function authOk(request, ct0) {
  const h = request.headers();
  return h.authorization === `Bearer ${BEARER}` && h['x-csrf-token'] === ct0 && h['x-twitter-auth-type'] === 'OAuth2Session';
}

export async function installFakeX(context, state, { ct0 = 'csrf-test-token' } = {}) {
  await context.addCookies([
    { name: 'ct0', value: ct0, domain: '.x.com', path: '/', secure: true },
    { name: 'twid', value: `u%3D${ME.id}`, domain: '.x.com', path: '/', secure: true },
    { name: 'auth_token', value: 'secret', domain: '.x.com', path: '/', secure: true, httpOnly: true }
  ]);

  // X's real bundle is only read by the extension's service worker (the page's tag is inert);
  // anything else from the CDN is served empty so the fake page stays fake.
  await context.route('https://abs.twimg.com/**', route => /\/client-web\/main\./.test(route.request().url())
    ? route.continue()
    : route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));

  await context.route('https://x.com/i/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const call = { method: request.method(), path: url.pathname, at: Date.now() };
    const transactionId = !!request.headers()['x-client-transaction-id'];
    if (transactionId || request.headers()['x-fake-page-request']) call.fromPage = true;
    // Its value, so a test can check that nothing the extension keeps carries it.
    if (transactionId) call.transaction = request.headers()['x-client-transaction-id'];
    state.calls.push(call);
    if (!authOk(request, ct0)) return json(route, 403, { errors: [{ code: 353, message: 'This request requires a matching csrf cookie and header.' }] });

    const graphql = url.pathname.match(/^\/i\/api\/graphql\/([\w-]+)\/(\w+)$/);
    if (graphql) {
      const [, queryId, op] = graphql;
      call.op = op;
      // X refuses its replies list without the page's transaction id, before anything else.
      if (op === 'UserTweetsAndReplies' && !transactionId) {
        call.refused = true;
        return route.fulfill({ status: 404, body: '' });
      }
      if (currentIds(state)[op] !== queryId) {
        if (state.misbehave.emptyNotFound) return route.fulfill({ status: 404, body: '' });
        return json(route, 404, { errors: [{ message: 'Query not found' }] });
      }
      // One-shot synthetic responses, including server deadlines. Tests can enqueue these
      // after the page's discovery request, so they target the extension worker alone.
      const forcedResponse = state.misbehave.responses[op]?.shift();
      // Optional test-only barrier: the answer (forced, or the normal one with pass) waits for it.
      await forcedResponse?.waitFor;
      if (forcedResponse && !forcedResponse.pass) {
        const headers = { ...(forcedResponse.headers || {}) };
        if (forcedResponse.resetSeconds != null) headers['x-rate-limit-reset'] = String(Math.ceil(Date.now() / 1000) + forcedResponse.resetSeconds);
        return json(route, forcedResponse.status ?? 429, forcedResponse.body || { errors: [{ code: forcedResponse.code ?? 88, message: 'synthetic restriction' }] }, headers);
      }
      if (request.method() === 'GET') {
        const variables = JSON.parse(url.searchParams.get('variables') || '{}');
        call.variables = variables;
        call.features = url.searchParams.get('features') ? JSON.parse(url.searchParams.get('features')) : null;
        call.fieldToggles = url.searchParams.get('fieldToggles') ? JSON.parse(url.searchParams.get('fieldToggles')) : null;
        if (state.misbehave.refuse[op]) return json(route, state.misbehave.refuse[op], { errors: [{ message: 'refused' }] });
        if (variables.userId !== ME.id) return json(route, 400, { errors: [{ message: 'wrong user' }] });
        return json(route, 200, page(state, op, variables));
      }
      const body = request.postDataJSON();
      call.body = body;
      if (state.misbehave.binding[op]) return json(route, 401, { errors: [{ code: 32, message: 'Could not authenticate you.' }] }, { 'x-tfe-auth-result-code': '3071' });
      if (state.misbehave.refuse[op]) return json(route, state.misbehave.refuse[op], {});
      state.mutations++;
      // Opt-in: misbehave.hold = { after, released } holds every GraphQL mutation past `after`
      // until the `released` promise settles, so a test can act while a job is mid-run.
      if (state.misbehave.hold && state.mutations > state.misbehave.hold.after) await state.misbehave.hold.released;
      if (state.misbehave.rateLimitAfter != null && state.mutations === state.misbehave.rateLimitAfter + 1) {
        const reset = Math.ceil(Date.now() / 1000) + state.misbehave.rateLimitSeconds;
        return json(route, 429, { errors: [{ code: 88, message: 'Rate limit exceeded.' }] }, { 'x-rate-limit-reset': String(reset), 'x-rate-limit-remaining': '0' });
      }
      const v = body?.variables || {};
      const forced = state.misbehave.errorCode;
      if (forced && forced.op === op && state.mutations > forced.after) return json(route, 200, { errors: [{ message: 'forced', extensions: { code: forced.code } }], data: {} });
      if (body?.queryId !== queryId) return json(route, 400, { errors: [{ message: 'queryId mismatch' }] });
      if (op === 'DeleteTweet') {
        const i = state.tweets.findIndex(t => t.id === v.tweet_id && !t.retweetOf && t.authorId === ME.id);
        if (i < 0) return json(route, 200, { errors: [{ code: 144, message: 'No status found with that ID.' }], data: {} });
        state.tweets.splice(i, 1);
        return json(route, 200, { data: { delete_tweet: { tweet_results: {} } } });
      }
      if (op === 'DeleteRetweet') {
        const i = state.tweets.findIndex(t => t.retweetOf?.id === v.source_tweet_id);
        if (i < 0) return json(route, 200, { errors: [{ code: 144, message: 'No status found with that ID.' }], data: {} });
        state.tweets.splice(i, 1);
        return json(route, 200, { data: { unretweet: { source_tweet_results: { result: { rest_id: v.source_tweet_id } } } } });
      }
      if (op === 'UnfavoriteTweet') {
        const i = state.likes.findIndex(t => t.id === v.tweet_id);
        if (i >= 0) state.likes.splice(i, 1);
        return json(route, 200, { data: { unfavorite_tweet: 'Done' } });
      }
      return json(route, 400, { errors: [{ message: `unsupported op ${op}` }] });
    }

    const friendship = url.pathname.match(/^\/i\/api\/1\.1\/friendships\/(create|destroy)\.json$/);
    if (friendship) {
      const form = Object.fromEntries(new URLSearchParams(request.postData() || ''));
      call.form = form;
      call.op = `friendships/${friendship[1]}`;
      if (state.misbehave.refuse[call.op]) return json(route, state.misbehave.refuse[call.op], {});
      state.mutations++;
      if (friendship[1] === 'destroy') {
        const i = state.following.findIndex(u => u.id === form.user_id);
        const [user] = i >= 0 ? state.following.splice(i, 1) : [];
        return user ? json(route, 200, { id_str: user.id, screen_name: user.screen }) : json(route, 403, { errors: [{ code: 34, message: 'not found' }] });
      }
      const user = state.followers.find(u => u.id === form.user_id);
      if (!user) return json(route, 403, { errors: [{ code: 34, message: 'not found' }] });
      user.following = true;
      return json(route, 200, { id_str: user.id, screen_name: user.screen });
    }
    return json(route, 404, { errors: [{ message: 'not found' }] });
  });

  // DOM-mode hooks the fake page uses when the extension clicks Delete.
  await context.route('https://x.com/__fake/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/__fake/timeline') return json(route, 200, state.tweets.filter(t => !t.replyTo));
    if (url.pathname === '/__fake/delete') {
      const id = url.searchParams.get('id');
      const i = state.tweets.findIndex(t => t.id === id && !t.retweetOf);
      if (i >= 0) state.tweets.splice(i, 1);
      state.calls.push({ method: 'DOM', op: 'dom-delete', id, ...(url.searchParams.has('path') ? { path: url.searchParams.get('path') } : {}) });
      return json(route, 200, { ok: i >= 0 });
    }
    // Account lists and their buttons, only for pages built with state.dom (see domScript).
    if (url.pathname === '/__fake/users') {
      const op = url.searchParams.get('op');
      const list = op === 'Following' ? state.following.map(u => ({ ...u, following: true })) : listFor(state, op);
      return json(route, 200, list.map(({ id, screen, name, following }) => ({ id, screen, name, following: !!following })));
    }
    // state.dom.reject: X refuses the action without saying so; the page draws the list unchanged.
    const refused = url.pathname.match(/^\/__fake\/(follow|unfollow|unlike)$/);
    if (refused && state.dom?.reject?.[refused[1]]) {
      state.calls.push({ method: 'DOM', op: `dom-${refused[1]}-rejected`, id: url.searchParams.get('id') });
      return json(route, 200, { ok: false });
    }
    // The Likes tab and its unlike buttons, only for pages built with state.dom.likes.
    if (url.pathname === '/__fake/likes') return json(route, 200, state.likes.map(({ id, screen, text }) => ({ id, screen, text })));
    if (url.pathname === '/__fake/unlike') {
      const id = url.searchParams.get('id');
      const i = state.likes.findIndex(like => like.id === id);
      if (i >= 0) state.likes.splice(i, 1);
      state.calls.push({ method: 'DOM', op: 'dom-unlike', id });
      return json(route, 200, { ok: i >= 0 });
    }
    const friendship = url.pathname.match(/^\/__fake\/(follow|unfollow)$/);
    if (friendship) {
      const screen = url.searchParams.get('id');
      state.calls.push({ method: 'DOM', op: `dom-${friendship[1]}`, id: screen, where: url.searchParams.get('where'), path: url.searchParams.get('path') });
      if (friendship[1] === 'follow') {
        const user = state.followers.find(u => u.screen === screen);
        if (user) user.following = true;
      } else {
        const i = state.following.findIndex(u => u.screen === screen);
        if (i >= 0) state.following.splice(i, 1);
      }
      return json(route, 200, { ok: true });
    }
    // Scrolls recorded by state.dom.recordScroll, with the pathname they happened on.
    if (url.pathname === '/__fake/scroll') {
      state.calls.push({ method: 'DOM', op: 'scroll', path: url.searchParams.get('path') });
      return json(route, 200, { ok: true });
    }
    // Post menus drawn by state.dom.deleteMenu: each menu opened, other item clicked and list redrawn.
    if (url.pathname === '/__fake/menu') {
      state.calls.push({ method: 'DOM', op: `menu-${url.searchParams.get('event')}`, id: url.searchParams.get('id') });
      return json(route, 200, { ok: true });
    }
    return json(route, 404, {});
  });

  await context.route(/^https:\/\/x\.com\/(?!i\/api\/|__fake\/).*/, route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/|\/$/g, '');
    const [handle, tab = ''] = path.split('/');
    const op = handle === ME.screen ? PATH_OP[tab] : null;
    route.fulfill({ status: 200, contentType: 'text/html', body: pageHtml(op, state.dom, state) });
  });
}

function pageHtml(op, dom, state) {
  const { pageRequest } = state;
  // Without state.pageRequest the page asks for its list inline, as it always did.
  const ask = !pageRequest ? 'if (op) askList();'
    : pageRequest.skip ? '// state.pageRequest.skip: this page never asks for its list.'
      : `// state.pageRequest.delay: ask for the list ${Number(pageRequest.delay) || 0} ms after load.\nif (op) window.addEventListener('load', () => setTimeout(askList, ${Number(pageRequest.delay) || 0}));`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<script type="text/plain" src="${BUNDLE_URL}"></script>
<script>
// Like x.com: the page seeds its state, feature switches included; main.js deletes it later.
window.__INITIAL_STATE__ = { session: { user_id: '${ME.id}' }, featureSwitch: { defaultConfig: { rweb_video_screen_enabled: { value: false } }, user: { config: { rweb_video_screen_enabled: { value: true } } }, customOverrides: {} } };
delete window.__INITIAL_STATE__;
</script>
<style>body{margin:0;font:14px system-ui}article{height:180px;border-bottom:1px solid #ddd;padding:8px}#layers{position:fixed;top:40px;right:40px;background:#fff}</style></head>
<body>
<nav><a data-testid="AppTabBar_Profile_Link" href="/${ME.screen}">Profile</a>
<div data-testid="SideNav_AccountSwitcher_Button"><span>${ME.name}</span><span>@${ME.screen}</span></div></nav>
<main data-testid="primaryColumn"><div id="list"></div></main><div id="layers"></div>
<script>
// Like X's web app, ask the API for this page's list on load. Each request carries a new
// x-client-transaction-id, as X's page makes one per request (a stand-in value here).
const op = ${JSON.stringify(op)};
const ids = ${JSON.stringify(currentIds(state))};
const variables = { userId: '${ME.id}', count: 20, includePromotedContent: true, withVoice: true };
const features = { rweb_video_screen_enabled: false, responsive_web_graphql_timeline_navigation_enabled: true };
let transactions = 0;
function askApi(extra) {
  const params = new URLSearchParams({ variables: JSON.stringify({ ...variables, ...extra }), features: JSON.stringify(features) });
  return fetch('/i/api/graphql/' + ids[op] + '/' + op + '?' + params, { credentials: 'include', headers: {
    authorization: 'Bearer ${BEARER}', 'x-csrf-token': (document.cookie.match(/ct0=([^;]+)/) || [])[1] || '',
    'x-twitter-auth-type': 'OAuth2Session', 'content-type': 'application/json', 'x-client-transaction-id': 'fake-transaction-' + (++transactions) } });
}
// state.dom.xhr ('text' or 'json'): the Replies page asks by XMLHttpRequest with that response
// type instead of fetch, as X's page may. It resolves like fetch's response.json().
const xhr = ${JSON.stringify(dom?.xhr || null)};
function askRepliesXhr(extra) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ variables: JSON.stringify({ ...variables, ...extra }), features: JSON.stringify(features) });
    const request = new XMLHttpRequest();
    request.open('GET', '/i/api/graphql/' + ids[op] + '/' + op + '?' + params);
    request.setRequestHeader('authorization', 'Bearer ${BEARER}');
    request.setRequestHeader('x-csrf-token', (document.cookie.match(/ct0=([^;]+)/) || [])[1] || '');
    request.setRequestHeader('x-twitter-auth-type', 'OAuth2Session');
    request.setRequestHeader('x-client-transaction-id', 'fake-transaction-' + (++transactions));
    request.responseType = xhr === 'json' ? 'json' : '';
    request.onload = () => {
      // The page's own read, flagged so a test can tell it from anyone else's.
      window.__fakeXReading = true;
      let body = null;
      try { body = xhr === 'json' ? request.response : JSON.parse(request.responseText); } catch (_) {}
      window.__fakeXReading = false;
      resolve({ ok: request.status >= 200 && request.status < 300, json: () => Promise.resolve(body) });
    };
    request.onerror = request.onabort = () => reject(new Error('xhr failed'));
    request.send();
  });
}
function askList() {
  if (op === 'UserTweetsAndReplies') loadReplies();
  else askApi({}).catch(() => {});
}
// The Replies page reads its own responses: it draws each post (a reply after the post it
// answers) and, when scrolled near the bottom, asks for the next page with the response's
// cursor, until X ends the timeline or refuses a request.
const replies = { cursor: null, loading: false, ended: false, started: false };
async function loadReplies() {
  if (replies.loading || replies.ended) return;
  replies.loading = true;
  replies.started = true;
  try {
    const extra = replies.cursor ? { cursor: replies.cursor } : {};
    const response = await (xhr ? askRepliesXhr(extra) : askApi(extra));
    // The page's own read, flagged so a test can tell it from anyone else's.
    window.__fakeXReading = true;
    const reading = response.json();
    window.__fakeXReading = false;
    const body = await reading.catch(() => null);
    const instructions = body?.data?.user?.result?.timeline?.timeline?.instructions;
    if (!response.ok || !Array.isArray(instructions)) { replies.ended = true; return; }
    let next = null;
    for (const instruction of instructions) {
      if (instruction.type === 'TimelineTerminateTimeline' && instruction.direction === 'Bottom') replies.ended = true;
      for (const entry of instruction.entries || []) {
        const content = entry.content || {};
        if (content.cursorType === 'Bottom') next = content.value;
        const items = content.itemContent ? [content.itemContent] : (content.items || []).map(item => item.item?.itemContent);
        for (const item of items) if (item?.tweet_results?.result) drawPost(item.tweet_results.result);
      }
    }
    if (!next || next === replies.cursor) replies.ended = true;
    else replies.cursor = next;
  } catch (_) {
    replies.ended = true;
  } finally {
    replies.loading = false;
  }
}
function drawPost(t) {
  const screen = t.core.user_results.result.core.screen_name;
  const when = new Date(t.legacy.created_at);
  const cell = document.createElement('div'); cell.dataset.testid = 'cellInnerDiv';
  cell.innerHTML = '<article data-testid="tweet"><div data-testid="User-Name"><a role="link" href="/' + screen + '">' + screen + '</a> <a href="/' + screen + '/status/' + t.rest_id + '"><time datetime="' + (isNaN(when) ? '' : when.toISOString()) + '">t</time></a></div>' +
    (t.legacy.in_reply_to_status_id_str ? '<div>Replying to @someone</div>' : '') + '<div data-testid="tweetText">' + t.legacy.full_text + '</div></article>';
  document.getElementById('list').appendChild(cell);
}
window.addEventListener('scroll', () => {
  if (op === 'UserTweetsAndReplies' && replies.started && innerHeight + scrollY >= document.documentElement.scrollHeight - 300) loadReplies();
});
${ask}
// Minimal clickable timeline for click mode: caret, red "Delete" item, confirmation.
async function render() {
  if (op !== 'UserTweets') return;
  const tweets = await (await fetch('/__fake/timeline')).json();
  const list = document.getElementById('list');
  list.replaceChildren();
  for (const t of tweets) {
    const cell = document.createElement('div'); cell.dataset.testid = 'cellInnerDiv';
    const mine = !t.retweetOf;
    const author = mine ? '${ME.screen}' : t.retweetOf.screen;
    const id = mine ? t.id : t.retweetOf.id;
    // Like X, the post's time sits in the link to its own status, as an ISO datetime.
    const created = mine ? t.created : t.retweetOf.created;
    const when = new Date(created);
    const stamp = t.timeless || !created ? 't' : '<time datetime="' + (isNaN(when) ? created : when.toISOString()) + '">t</time>';
    cell.innerHTML = '<article data-testid="tweet"><div data-testid="User-Name"><a role="link" href="/' + author + '">' + author + '</a> <a href="/' + author + '/status/' + id + '">' + stamp + '</a></div><div data-testid="tweetText">' + (mine ? t.text : t.retweetOf.text) + '</div><button data-testid="caret">…</button></article>';
    cell.querySelector('[data-testid="caret"]').onclick = () => openMenu(id, mine);
    list.appendChild(cell);
  }
}
function openMenu(id, mine) {
  const layers = document.getElementById('layers');
  layers.innerHTML = mine
    ? '<div role="menuitem"><span style="color:rgb(244,33,46)">Delete</span></div><div role="menuitem"><span>Pin to your profile</span></div>'
    : '<div role="menuitem"><span>Not interested in this post</span></div>';
  if (!mine) return;
  layers.firstChild.onclick = () => {
    layers.innerHTML = '<button data-testid="confirmationSheetConfirm">Delete</button>';
    layers.firstChild.onclick = async () => { layers.innerHTML = ''; await fetch('/__fake/delete?id=' + id); render(); };
  };
}
render();
</script>${dom ? domScript(dom) : ''}</body></html>`;
}

// Opt-in page behaviors, set as state.dom by a scenario; without it the page is unchanged.
//  users:           list followers/following as clickable UserCells in the main column
//  sidebar:         accounts drawn as UserCells in a sidebar outside the main column
//                   ({ id, screen, name, following }), like X's "Who to follow"
//  noPrimaryColumn: the main column carries no data-testid
//  navigateAfter:   after that many actions, move to /explore with pushState, as X's SPA does,
//                   keeping the same content on screen
//  lang:            the page language, as <html lang>
//  deleteMenu:      the menu of your own posts as X draws it in another language: the first item
//                   ({ label, red, confirm }) deletes, red or not; recorded as menu-open, menu-other
//                   (any other item clicked) and menu-render (the list redrawn after a deletion)
//  noProfileLink:   the nav has no profile link; the account switcher still shows @me
//  likes:           draw the Likes tab as posts with an unlike button in the main column
//  reject:          { unlike, follow, unfollow }: X refuses that action without a word and the
//                   list stays as it was; recorded as dom-<action>-rejected
//  slow:            { unlike, follow, unfollow }: milliseconds X takes to show that action done
//  navigateOnCaret: clicking a post's menu caret moves to /explore first, as a stray link would
//  recordScroll:    every scroll is recorded as scroll with the pathname it happened on
//  renameAfter:     after that many deletions the address keeps the page but changes its spelling
//                   (capitals, trailing slash, query and hash), as X's redirects do
//  loginAfter:      after that many deletions X shows its login form, without changing the address
//  switchedAccount: on your profile pages the profile link names this other account, as if the
//                   tab switched accounts after the extension read it elsewhere
//  repliesMovedTo:  your Replies page moves its address to this path once loaded (as a redirect
//                   to another profile would), keeping what it drew and asked for
//  xhr:             'text' or 'json': the Replies page asks for its list by XMLHttpRequest with
//                   that response type, not fetch
// Every action is recorded with the pathname it happened on and where its button was.
function domScript(dom) {
  return `<script>
(() => {
  const dom = ${JSON.stringify(dom)};
  const main = document.querySelector('[data-testid="primaryColumn"]');
  if (dom.noPrimaryColumn) main.removeAttribute('data-testid');
  const layers = document.getElementById('layers');
  let acted = 0;
  const counted = () => { if (++acted === dom.navigateAfter) history.pushState({}, '', '/explore'); };
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    if (!String(input).startsWith('/__fake/delete')) return realFetch(input, init);
    const response = await realFetch(String(input) + '&path=' + encodeURIComponent(location.pathname), init);
    counted();
    return response;
  };
  if (dom.renameAfter || dom.loginAfter) {
    let deleted = 0;
    const deleteFetch = window.fetch;
    window.fetch = async (input, init) => {
      const response = await deleteFetch(input, init);
      if (!String(input).startsWith('/__fake/delete')) return response;
      deleted++;
      if (deleted === dom.renameAfter) history.replaceState({}, '', location.pathname.toUpperCase() + '/?ref=1#top');
      if (deleted === dom.loginAfter) document.body.insertAdjacentHTML('beforeend', '<div data-testid="LoginForm">Log in to X</div>');
      return response;
    };
  }
  if (dom.navigateOnCaret) {
    document.addEventListener('click', event => {
      if (event.target.closest?.('[data-testid="caret"]')) history.pushState({}, '', '/explore');
    }, true);
  }
  if (dom.recordScroll) window.addEventListener('scroll', () => realFetch('/__fake/scroll?path=' + encodeURIComponent(location.pathname)));
  async function act(kind, user, where) {
    await realFetch('/__fake/' + kind + '?id=' + user.screen + '&where=' + where + '&path=' + encodeURIComponent(location.pathname));
    if (dom.slow?.[kind]) await new Promise(resolve => setTimeout(resolve, dom.slow[kind]));
    if (where === 'sidebar') user.following = kind === 'follow';
    counted();
    if (where === 'sidebar') renderSidebar();
    else renderUsers();
  }
  function userCell(user, where) {
    const cell = document.createElement('div');
    cell.dataset.testid = 'UserCell';
    cell.innerHTML = '<a role="link" href="/' + user.screen + '"><span>' + user.name + '</span></a><span>@' + user.screen + '</span>' +
      '<button data-testid="' + user.id + (user.following ? '-unfollow' : '-follow') + '">' + (user.following ? 'Following' : 'Follow') + '</button>';
    cell.querySelector('button').onclick = () => {
      if (!user.following) return act('follow', user, where);
      layers.innerHTML = '<button data-testid="confirmationSheetConfirm">Unfollow</button>';
      layers.firstChild.onclick = () => { layers.innerHTML = ''; act('unfollow', user, where); };
    };
    return cell;
  }
  async function renderUsers() {
    if (!dom.users || !['Followers', 'Following', 'BlueVerifiedFollowers'].includes(op)) return;
    const users = await (await realFetch('/__fake/users?op=' + op)).json();
    document.getElementById('list').replaceChildren(...users.map(user => userCell(user, 'column')));
  }
  let aside = null;
  function renderSidebar() {
    if (!dom.sidebar) return;
    if (!aside) {
      aside = document.createElement('aside');
      aside.dataset.testid = 'sidebarColumn';
      document.body.insertBefore(aside, layers);
    }
    aside.replaceChildren(Object.assign(document.createElement('h2'), { textContent: 'Who to follow' }), ...dom.sidebar.map(user => userCell(user, 'sidebar')));
  }
  const profileLink = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
  if (dom.noProfileLink) profileLink.remove();
  if (dom.switchedAccount && location.pathname.split('/')[1] === '${ME.screen}') profileLink.setAttribute('href', '/' + dom.switchedAccount);
  if (dom.lang) document.documentElement.lang = dom.lang;
  if (dom.repliesMovedTo && location.pathname === '/${ME.screen}/with_replies') history.replaceState({}, '', dom.repliesMovedTo);
  if (dom.deleteMenu) {
    const { label, red, confirm } = dom.deleteMenu;
    const record = (event, id) => realFetch('/__fake/menu?event=' + event + '&id=' + id);
    const item = (text, style) => '<div role="menuitem"><span' + (style ? ' style="' + style + '"' : '') + '>' + text + '</span></div>';
    // Replaces the page's openMenu, which the carets call by name.
    window.openMenu = (id, mine) => {
      record('open', id);
      layers.innerHTML = mine
        ? item(label, red ? 'color:rgb(244,33,46)' : '') + item('Fixar no seu perfil')
        : item('Não tenho interesse neste post');
      Array.from(layers.children).forEach((menuItem, i) => {
        menuItem.onclick = () => {
          if (!mine || i > 0) return record('other', id);
          layers.innerHTML = '<button data-testid="confirmationSheetConfirm">' + confirm + '</button>';
          layers.firstChild.onclick = async () => { layers.innerHTML = ''; await fetch('/__fake/delete?id=' + id); await render(); record('render', id); };
        };
      });
    };
  }
  async function renderLikes() {
    if (!dom.likes || op !== 'Likes') return;
    const likes = await (await realFetch('/__fake/likes')).json();
    document.getElementById('list').replaceChildren(...likes.map(like => {
      const cell = document.createElement('div');
      cell.dataset.testid = 'cellInnerDiv';
      cell.innerHTML = '<article data-testid="tweet"><div data-testid="User-Name"><a role="link" href="/' + like.screen + '">' + like.screen + '</a> <a href="/' + like.screen + '/status/' + like.id + '">t</a></div><div data-testid="tweetText">' + like.text + '</div><button data-testid="unlike">Liked</button></article>';
      cell.querySelector('[data-testid="unlike"]').onclick = async () => {
        await realFetch('/__fake/unlike?id=' + like.id);
        if (dom.slow?.unlike) await new Promise(resolve => setTimeout(resolve, dom.slow.unlike));
        counted();
        renderLikes();
      };
      return cell;
    }));
  }
  renderUsers();
  renderSidebar();
  renderLikes();
})();
<\/script>`;
}

export const fakeQueryIds = QUERY_IDS;
export { fs };
