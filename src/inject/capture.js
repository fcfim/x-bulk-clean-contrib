// Runs in the page's own JavaScript world at document_start, before X's scripts.
// X's GraphQL operations need a query id and a feature set that change whenever X ships a new
// build. Rather than hard-coding them, this records the ones X itself uses on each page load:
// operation name, query id, variables, features and the web app's bearer token. Nothing is sent
// anywhere; the record is left on <html data-xbc-api> for the extension's workers to read.
//
// It also reads the replies list for a Preview & Select scan in API mode (VER-899, ADR 0002). X
// accepts UserTweetsAndReplies only with an x-client-transaction-id that its own page makes;
// Postscrub never sends that request, and never makes, copies or records the header. Only while a
// scan is armed in this tab (see armed() below) are the responses to the page's own
// UserTweetsAndReplies requests read, kept in this closure and handed to the scan when it asks.
// Unarmed, no response is read. Request headers are never recorded.
(() => {
  if (window.__xbcCapture) return;
  window.__xbcCapture = true;
  // Tells the scan this script runs in the tab (a tab loaded before the extension has none).
  const mark = () => { try { document.documentElement.dataset.xbcCapture = '2'; } catch (_) {} };
  mark();

  const state = { ops: {}, bearer: null };
  const save = () => {
    try { document.documentElement.dataset.xbcApi = JSON.stringify(state); } catch (_) {}
  };

  const note = (url, method, headers) => {
    try {
      const auth = headers?.authorization;
      if (auth && /^Bearer \S+$/.test(auth)) state.bearer = auth.slice(7);
      const parsed = new URL(url, location.href);
      const match = parsed.pathname.match(/\/i\/api\/graphql\/([\w-]+)\/(\w+)$/);
      if (!match) { if (auth) save(); return; }
      const entry = { queryId: match[1], method: (method || 'GET').toUpperCase(), path: location.pathname, at: Date.now() };
      for (const key of ['variables', 'features', 'fieldToggles']) {
        const value = parsed.searchParams.get(key);
        if (value) entry[key] = JSON.parse(value);
      }
      // A mutation records only its query id; never let it replace a query's feature set.
      const previous = state.ops[match[2]];
      state.ops[match[2]] = entry.method === 'GET' || !previous ? entry : { ...previous, queryId: entry.queryId };
      save();
    } catch (_) {}
  };

  // X sends each feature's value from its feature-switch config, which the page seeds from
  // window.__INITIAL_STATE__ and main.js deletes right after reading. Record the values when the
  // page assigns it (this script runs first), so API requests send exactly what X would.
  let initialState;
  try {
    Object.defineProperty(window, '__INITIAL_STATE__', {
      configurable: true,
      enumerable: true,
      get() { return initialState; },
      set(value) {
        initialState = value;
        try {
          const fs = value?.featureSwitch || {};
          const plain = (v) => (v && typeof v === 'object' && 'value' in v ? v.value : v);
          const features = {};
          for (const [key, v] of Object.entries({ ...(fs.defaultConfig || {}), ...(fs.user?.config || {}) })) features[key] = plain(v) === true;
          for (const [key, v] of Object.entries(fs.customOverrides || {})) features[key] = plain(v) === true;
          state.features = features;
          state.viewerId = value?.session?.user_id ? String(value.session.user_id) : null;
          save();
        } catch (_) {}
      }
    });
  } catch (_) {}

  const plainHeaders = (source) => {
    const out = {};
    try { if (source) new Headers(source).forEach((value, key) => { out[key] = value; }); } catch (_) {}
    return out;
  };

  // === Replies list by passive read ===
  // Armed iff the tab's sessionStorage (shared with the extension's isolated world, and kept
  // across a reload of the tab) holds { id, until } with `until` still ahead. The side panel arms
  // before it loads the Replies page; the running scan pushes `until` on every step and removes
  // the record when it ends, so a scan that died disarms by itself within about 30 s.
  const PASSIVE_KEY = 'xbcPassiveScan';
  const PASSIVE_LIMIT = 40;
  const passive = { queue: [], overflow: 0, seq: 0, timer: null };
  const armed = () => {
    try {
      const arm = JSON.parse(sessionStorage.getItem(PASSIVE_KEY) || 'null');
      return !!arm && typeof arm.id === 'string' && Number(arm.until) > Date.now();
    } catch (_) { return false; }
  };
  const dropQueue = () => { passive.queue.length = 0; passive.overflow = 0; };
  // Responses no scan takes (it stopped or died) are dropped once the arm lapses.
  const expireQueue = () => {
    if (passive.timer) return;
    passive.timer = setTimeout(function check() {
      passive.timer = null;
      if (!armed()) dropQueue();
      else if (passive.queue.length || passive.overflow) passive.timer = setTimeout(check, 5000);
    }, 5000);
  };
  // The page's own GET of UserTweetsAndReplies on this site: whose list it asked for and from
  // which cursor, from the request's variables. Null for any other request.
  const repliesRequest = (url, method) => {
    try {
      if (String(method || 'GET').toUpperCase() !== 'GET') return null;
      const parsed = new URL(url, location.href);
      if (parsed.origin !== location.origin || !/^\/i\/api\/graphql\/[\w-]+\/UserTweetsAndReplies$/.test(parsed.pathname)) return null;
      const variables = JSON.parse(parsed.searchParams.get('variables') || '{}') || {};
      return {
        userId: variables.userId != null ? String(variables.userId) : null,
        cursor: typeof variables.cursor === 'string' ? variables.cursor : null
      };
    } catch (_) { return null; }
  };
  // One response: its status, the rate limit headers when present, and the body as text. Kept
  // only in this closure until the scan takes it; never written to the DOM or any storage.
  const enqueue = (request, status, body, header) => {
    try {
      if (!armed()) { dropQueue(); return; }
      const number = (name) => {
        try {
          const raw = header(name);
          const value = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
          return Number.isFinite(value) ? value : null;
        } catch (_) { return null; }
      };
      const record = {
        seq: ++passive.seq, at: Date.now(), status: Number(status) || 0,
        userId: request.userId, cursor: request.cursor, body: typeof body === 'string' ? body : null,
        rateReset: number('x-rate-limit-reset'), rateRemaining: number('x-rate-limit-remaining')
      };
      if (typeof body !== 'string') record.unreadable = true;
      if (passive.queue.length >= PASSIVE_LIMIT) passive.overflow++;
      else passive.queue.push(record);
      expireQueue();
    } catch (_) {}
  };
  // Handoff to the scan in the extension's isolated world: it dispatches xbc:passive-drain on
  // the document, and this answers at once with one xbc:passive-record event per response, its
  // detail a JSON string (objects do not cross worlds), then one { overflow } if any were dropped.
  try {
    document.addEventListener('xbc:passive-drain', () => {
      try {
        mark();
        const queue = passive.queue.splice(0), overflow = passive.overflow;
        passive.overflow = 0;
        if (!armed()) return;
        for (const record of queue) document.dispatchEvent(new CustomEvent('xbc:passive-record', { detail: JSON.stringify(record) }));
        if (overflow) document.dispatchEvent(new CustomEvent('xbc:passive-record', { detail: JSON.stringify({ overflow }) }));
      } catch (_) {}
    });
  } catch (_) {}

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    let replies = null;
    try {
      const request = input instanceof Request ? input : null;
      const url = request ? request.url : String(input);
      const method = init?.method || request?.method;
      note(url, method, plainHeaders(init?.headers || request?.headers));
      replies = repliesRequest(url, method);
    } catch (_) {}
    const result = originalFetch.apply(this, arguments);
    if (!replies) return result;
    // The page gets the same Response, or the same rejection. Only while a scan is armed is a
    // copy of the body read, before the page can read its own.
    return result.then(response => {
      try {
        if (armed()) {
          const header = name => response.headers.get(name);
          response.clone().text().then(text => enqueue(replies, response.status, text, header), () => enqueue(replies, response.status, null, header));
        }
      } catch (_) {}
      return response;
    });
  };

  const proto = XMLHttpRequest.prototype;
  const open = proto.open, setRequestHeader = proto.setRequestHeader, send = proto.send;
  proto.open = function (method, url) {
    this.__xbcRequest = { method, url, headers: {} };
    return open.apply(this, arguments);
  };
  proto.setRequestHeader = function (name, value) {
    try { if (this.__xbcRequest) this.__xbcRequest.headers[String(name).toLowerCase()] = value; } catch (_) {}
    return setRequestHeader.apply(this, arguments);
  };
  proto.send = function () {
    try {
      const r = this.__xbcRequest;
      if (r) {
        note(r.url, r.method, r.headers);
        const replies = repliesRequest(r.url, r.method);
        if (replies && armed()) {
          const xhr = this;
          xhr.addEventListener('loadend', () => {
            try {
              // Checked again when X answers: a scan that ended meanwhile reads nothing. A
              // request the page aborted, or that failed, has no answer (status 0); like a
              // fetch that rejects, it is left out, so the page can simply ask again.
              if (!armed() || !xhr.status) return;
              const header = name => xhr.getResponseHeader(name);
              const type = xhr.responseType;
              const body = type === '' || type === 'text' ? xhr.responseText : type === 'json' ? JSON.stringify(xhr.response) : null;
              enqueue(replies, xhr.status, body, header);
            } catch (_) {}
          }, { once: true });
        }
      }
    } catch (_) {}
    return send.apply(this, arguments);
  };
})();
