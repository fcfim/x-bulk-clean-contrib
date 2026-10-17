// Read-only diagnostic for API mode. Paste it into the DevTools console of a logged-in x.com tab,
// with the console context left on "top" (the page itself, not the extension).
// It does not delete, like, follow or change anything by itself:
//  1. reads the feature switches X's request layer depends on, if the page still exposes them;
//  2. for 60 seconds, records which x-* headers X's own requests carry, per operation
//     (like and then unlike one of your posts in that window to see the signed mutations);
//  3. sends one read-only GET (UserByScreenName for your own handle) without
//     x-client-transaction-id, to see whether X refuses requests that lack it.
// When it finishes, run copy(JSON.stringify(__xbcProbe, null, 1)) and paste the result.
(async () => {
  const out = {};
  const switches = ['rweb_session_binding_enabled', 'rweb_client_transaction_id_enabled', 'responsive_web_api_transition_enabled'];
  const find = (obj, name, depth = 0) => {
    if (!obj || typeof obj !== 'object' || depth > 6) return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, name)) {
      const v = obj[name];
      return v && typeof v === 'object' && 'value' in v ? v.value : v;
    }
    for (const key of Object.keys(obj)) {
      const found = find(obj[key], name, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const featureSwitch = window.__INITIAL_STATE__?.featureSwitch;
  for (const name of switches) out[name] = featureSwitch ? (find(featureSwitch, name) ?? 'absent') : 'no __INITIAL_STATE__';
  out.sessionHashMeta = !!document.querySelector('meta[name="session-hash"]');
  out.webpackRuntime = Array.isArray(window.webpackChunk_twitter_responsive_web);

  // 2. Headers on X's own requests (XHR is what X's API client uses).
  const seen = {};
  const proto = XMLHttpRequest.prototype;
  const open = proto.open, setRequestHeader = proto.setRequestHeader;
  proto.open = function (method, url) {
    this.__xbcProbe = `${method} ${String(url).split('?')[0].replace(/^https:\/\/[^/]+/, '')}`;
    return open.apply(this, arguments);
  };
  proto.setRequestHeader = function (name, value) {
    const key = String(name).toLowerCase();
    if (this.__xbcProbe && (key.startsWith('x-') || key === 'authorization')) (seen[this.__xbcProbe] ||= new Set()).add(key);
    return setRequestHeader.apply(this, arguments);
  };

  // 3. One read-only GET without x-client-transaction-id.
  try {
    const me = document.querySelector('[data-testid="AppTabBar_Profile_Link"]')?.getAttribute('href')?.slice(1) || 'X';
    const ct0 = document.cookie.match(/(?:^|; )ct0=([^;]+)/)?.[1] || '';
    const queryId = 'AMIBMjtxEEATh4z8V9GtRg';
    const features = Object.fromEntries(['hidden_profile_subscriptions_enabled', 'profile_label_improvements_pcf_label_in_post_enabled', 'responsive_web_profile_redirect_enabled', 'rweb_tipjar_consumption_enabled', 'verified_phone_label_enabled', 'subscriptions_verification_info_is_identity_verified_enabled', 'subscriptions_verification_info_verified_since_enabled', 'highlights_tweets_tab_ui_enabled', 'responsive_web_twitter_article_notes_tab_enabled', 'subscriptions_feature_can_gift_premium', 'creator_subscriptions_tweet_preview_api_enabled', 'responsive_web_graphql_timeline_navigation_enabled'].map(f => [f, true]));
    const params = new URLSearchParams({
      variables: JSON.stringify({ screen_name: me }),
      features: JSON.stringify(features),
      fieldToggles: JSON.stringify({ withPayments: false, withDmBlocks: false, withAuxiliaryUserLabels: false })
    });
    const response = await fetch(`/i/api/graphql/${queryId}/UserByScreenName?${params}`, {
      credentials: 'include',
      headers: {
        authorization: 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
        'x-csrf-token': ct0,
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
        'content-type': 'application/json'
      }
    });
    const body = await response.text();
    out.probeWithoutTransactionId = {
      status: response.status,
      rateLimitRemaining: response.headers.get('x-rate-limit-remaining'),
      gotUser: /"rest_id"/.test(body),
      body: body.slice(0, 240)
    };
  } catch (error) {
    out.probeWithoutTransactionId = { error: String(error) };
  }

  console.log('Recording X\'s own request headers for 60 s. Like and then unlike one of your posts now.');
  await new Promise(resolve => setTimeout(resolve, 60000));
  proto.open = open;
  proto.setRequestHeader = setRequestHeader;
  out.headersByRequest = Object.fromEntries(Object.entries(seen).map(([request, keys]) => [request, [...keys].sort()]));
  window.__xbcProbe = out;
  console.log(JSON.stringify(out, null, 1));
  console.log('Done. Run: copy(JSON.stringify(__xbcProbe, null, 1))');
})();
