/*
  attribution.js — campaign attribution for the download funnel.
  Docs: "Attribution | CT + referrer implementation" — W1, W2, W5, W7.

  Shared by /descargar, /ios and /android. It reads the UTMs off the URL, logs
  the click to our backend (the row the iOS probabilistic match reads later at
  /attribution/resolve), and builds the store URL that carries the campaign on:

    - Android → &referrer=<one url-encoded string, incl. click_id>  (deterministic,
                read by the Play Install Referrer API on first open)
    - iOS     → ?pt=&ct=&mt=8   (aggregate count in App Store Connect; the UTMs
                themselves are dropped by Apple — see W7)

  Only the 6 UTMs + 3 click-ids ever leave the browser. Nothing device-derived:
  the privacy line the whole plan is built on (Frente 5, P1).
*/
(function () {
  'use strict';

  var CLICKS_ENDPOINT = 'https://api.viaxi.app/api/v1/attribution/clicks';
  var IOS_STORE = 'https://apps.apple.com/mx/app/viaxi/id6792519546';
  var PLAY_ID = 'com.viaxi.app';
  var PLAY_STORE = 'https://play.google.com/store/apps/details?id=' + PLAY_ID;

  // iOS App Store provider token (docs P14 / W7): one value for the whole account,
  // from App Store Connect → App Analytics → Campaigns → "Generate Campaign Link".
  // With it set, the iOS redirect carries pt+ct so App Store Connect counts the
  // campaign; ct stays = utm_campaign (M7) so Apple's count crosses with ours.
  var APPLE_PROVIDER_TOKEN = '129182636';

  var STORE_KEY = 'viaxi_attribution';
  var UTM = ['utm_source', 'utm_medium', 'utm_id', 'utm_campaign', 'utm_content', 'utm_term'];
  var CLID = ['fbclid', 'gclid', 'ttclid'];
  // DTO field names (camelCase) keyed by URL param (snake_case).
  var DTO = {
    utm_source: 'utmSource', utm_medium: 'utmMedium', utm_id: 'utmId',
    utm_campaign: 'utmCampaign', utm_content: 'utmContent', utm_term: 'utmTerm',
    fbclid: 'fbclid', gclid: 'gclid', ttclid: 'ttclid'
  };

  function uuidv4() {
    var c = typeof crypto !== 'undefined' ? crypto : null;
    if (c && c.randomUUID) return c.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (ch) {
      var r = (Math.random() * 16) | 0;
      return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function storedId() {
    try { return (JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}).clickId; }
    catch (e) { return undefined; }
  }

  // Campaign params: prefer the current URL, fall back to the last-seen set (a
  // return visit, or /ios reached from a badge that didn't carry the query).
  function readParams() {
    var q = new URLSearchParams(location.search);
    var out = {};
    UTM.concat(CLID).forEach(function (k) { var v = q.get(k); if (v) out[k] = v; });
    if (Object.keys(out).length) return out;
    try { return (JSON.parse(localStorage.getItem(STORE_KEY) || '{}').params) || {}; }
    catch (e) { return {}; }
  }

  function persist(params, clickId) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ params: params, clickId: clickId, at: Date.now() }));
    } catch (e) {}
    // First-party cookie, 90 days, Lax (docs W1 step 5). First-party data — not
    // gated by a consent banner (W6); the GA event below is the part that is.
    try {
      document.cookie = STORE_KEY + '=' + encodeURIComponent(clickId) +
        ';path=/;max-age=' + (90 * 24 * 60 * 60) + ';SameSite=Lax';
    } catch (e) {}
  }

  function hasCampaign(params) {
    return UTM.concat(CLID).some(function (k) { return params[k]; });
  }

  // Play referrer: ONE url-encoded string, not loose params. The doc's #1 risk —
  // get this wrong and Android attribution is lost entirely. The inner %XX layer
  // is deliberate: Play decodes once, the app parses the result once.
  function androidUrl(params, clickId) {
    var inner = new URLSearchParams();
    UTM.concat(CLID).forEach(function (k) { if (params[k]) inner.append(k, params[k]); });
    inner.append('click_id', clickId);
    return PLAY_STORE + '&referrer=' + encodeURIComponent(inner.toString());
  }

  // iOS: pt + ct (=utm_campaign, kept identical per M7 so Apple's count crosses
  // with ours) + mt=8. Only when we hold the provider token AND have a campaign.
  function iosUrl(params) {
    if (!APPLE_PROVIDER_TOKEN || !params.utm_campaign) return IOS_STORE;
    var sep = IOS_STORE.indexOf('?') >= 0 ? '&' : '?';
    return IOS_STORE + sep + 'pt=' + encodeURIComponent(APPLE_PROVIDER_TOKEN) +
      '&ct=' + encodeURIComponent(params.utm_campaign) + '&mt=8';
  }

  function storeUrl(platform, params, clickId) {
    return platform === 'android' ? androidUrl(params, clickId) : iosUrl(params);
  }

  // Fire-and-forget: GA web event + the click log. sendBeacon posts
  // x-www-form-urlencoded, which is CORS-safelisted (no preflight — the landing's
  // origin isn't on the API allowlist and doesn't need to be) and lands straight
  // in Nest's urlencoded parser → CreateAttributionClickDto. Null fields omitted
  // so the DTO never sees the literal string "null".
  function logClick(platform, params, clickId) {
    if (window.gtag) {
      gtag('event', 'download_click', {
        platform: platform,
        campaign: params.utm_campaign || '(none)',
        source: params.utm_source || 'organic',
        transport_type: 'beacon' // flush before location.replace
      });
    }
    var form = new URLSearchParams();
    form.append('clickId', clickId);
    Object.keys(DTO).forEach(function (k) { if (params[k]) form.append(DTO[k], params[k]); });
    form.append('landingPath', location.pathname);
    form.append('platformHint', platform);
    try {
      if (navigator.sendBeacon) navigator.sendBeacon(CLICKS_ENDPOINT, form);
      else fetch(CLICKS_ENDPOINT, { method: 'POST', body: form, keepalive: true });
    } catch (e) {}
  }

  function platformFromUA() {
    var ua = navigator.userAgent || '';
    if (/android/i.test(ua)) return 'android';
    if (/iphone|ipad|ipod/i.test(ua) ||
      (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'ios';
    return 'web';
  }

  // Mint a click_id for THIS store visit, log it, return the store URL. One
  // platformHint per row: recordClick's orIgnore keys on clickId, so a fresh id
  // per platform choice keeps the ios/android hint the matcher needs (a shared id
  // reused across pages would pin whichever hint landed first). Desktop /descargar
  // deliberately does NOT call this on load — 'web' rows are useless to the
  // matcher; the real click is minted when the phone scans the QR or taps a badge.
  function prepare(platform, params) {
    var clickId = uuidv4();
    if (hasCampaign(params)) { persist(params, clickId); logClick(platform, params, clickId); }
    return storeUrl(platform, params, clickId);
  }

  function goStore(platform, params) { location.replace(prepare(platform, params)); }

  var api = {
    params: readParams,
    platform: platformFromUA,
    prepare: prepare,
    goStore: goStore,
    hasCampaign: hasCampaign,
    // exported for the golden encoding test (docs risk #1):
    androidUrl: androidUrl,
    iosUrl: iosUrl
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.ViaxiAttr = api;
})();
