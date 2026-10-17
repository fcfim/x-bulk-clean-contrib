// Runs in the page's own JavaScript world at document_start, before X's scripts.
// X's GraphQL operations need a query id and a feature set that change whenever X ships a new
// build. Rather than hard-coding them, this records the ones X itself uses on each page load:
// operation name, query id, variables, features and the web app's bearer token. Nothing is sent
// anywhere; the record is left on <html data-xbc-api> for the extension's workers to read.
(() => {
  if (window.__xbcCapture) return;
  window.__xbcCapture = true;

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

  const plainHeaders = (source) => {
    const out = {};
    try { if (source) new Headers(source).forEach((value, key) => { out[key] = value; }); } catch (_) {}
    return out;
  };

  const originalFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const request = input instanceof Request ? input : null;
      note(request ? request.url : String(input), init?.method || request?.method,
        plainHeaders(init?.headers || request?.headers));
    } catch (_) {}
    return originalFetch.apply(this, arguments);
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
    try { const r = this.__xbcRequest; if (r) note(r.url, r.method, r.headers); } catch (_) {}
    return send.apply(this, arguments);
  };
})();
