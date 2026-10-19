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

const twitterDate = (i) => new Date(Date.UTC(2024, 0, 1 + i, 12)).toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, '$1 $3 $2 $5 +0000 $4');

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
    state.calls.push(call);
    if (!authOk(request, ct0)) return json(route, 403, { errors: [{ code: 353, message: 'This request requires a matching csrf cookie and header.' }] });

    const graphql = url.pathname.match(/^\/i\/api\/graphql\/([\w-]+)\/(\w+)$/);
    if (graphql) {
      const [, queryId, op] = graphql;
      call.op = op;
      if (QUERY_IDS[op] !== queryId) return json(route, 404, { errors: [{ message: 'Query not found' }] });
      // One-shot synthetic responses, including server deadlines. Tests can enqueue these
      // after the page's discovery request, so they target the extension worker alone.
      const forcedResponse = state.misbehave.responses[op]?.shift();
      if (forcedResponse) {
        await forcedResponse.waitFor; // optional test-only barrier for Stop while a page is in flight
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
    return json(route, 404, {});
  });

  await context.route(/^https:\/\/x\.com\/(?!i\/api\/|__fake\/).*/, route => {
    const path = new URL(route.request().url()).pathname.replace(/^\/|\/$/g, '');
    const [handle, tab = ''] = path.split('/');
    const op = handle === ME.screen ? PATH_OP[tab] : null;
    route.fulfill({ status: 200, contentType: 'text/html', body: pageHtml(op, state.dom) });
  });
}

function pageHtml(op, dom) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<script type="text/plain" src="https://abs.twimg.com/responsive-web/client-web/main.b09082b07a640734a.js"></script>
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
// Like X's web app, ask the API for this page's list on load.
const op = ${JSON.stringify(op)};
const ids = ${JSON.stringify(QUERY_IDS)};
if (op) {
  const variables = { userId: '${ME.id}', count: 20, includePromotedContent: true, withVoice: true };
  const features = { rweb_video_screen_enabled: false, responsive_web_graphql_timeline_navigation_enabled: true };
  const params = new URLSearchParams({ variables: JSON.stringify(variables), features: JSON.stringify(features) });
  fetch('/i/api/graphql/' + ids[op] + '/' + op + '?' + params, { credentials: 'include', headers: {
    authorization: 'Bearer ${BEARER}', 'x-csrf-token': (document.cookie.match(/ct0=([^;]+)/) || [])[1] || '',
    'x-twitter-auth-type': 'OAuth2Session', 'content-type': 'application/json' } }).catch(() => {});
}
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
    cell.innerHTML = '<article data-testid="tweet"><div data-testid="User-Name"><a role="link" href="/' + author + '">' + author + '</a> <a href="/' + author + '/status/' + id + '">t</a></div><div data-testid="tweetText">' + (mine ? t.text : t.retweetOf.text) + '</div><button data-testid="caret">…</button></article>';
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
  async function act(kind, user, where) {
    await realFetch('/__fake/' + kind + '?id=' + user.screen + '&where=' + where + '&path=' + encodeURIComponent(location.pathname));
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
  renderUsers();
  renderSidebar();
})();
<\/script>`;
}

export const fakeQueryIds = QUERY_IDS;
export { fs };
