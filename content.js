/*
 * SirenWard – YouTube-Inhaltsskript (nur www.youtube.com, isolierte Welt).
 *
 * Architektur:
 *  - Kein Speicherzugriff. Einstellungen kommen als Leseansicht vom Hintergrund (Nachricht).
 *  - Inkrementell: Der MutationObserver prüft nur Kacheln, die sich tatsächlich geändert haben,
 *    und das synchron vor dem nächsten Bild – gesperrte Videos blitzen nicht auf.
 *  - Player-interne Änderungen (Zeit, Fortschritt) werden ignoriert.
 *  - Videoseiten haben ein "Tor": offen | prüfend | gesperrt. Im strikten Modus bleibt ein Video
 *    pausiert, bis sein Kanal erkannt und erlaubt ist.
 * Sendet nichts, speichert nichts.
 */
(() => {
  'use strict';
  const FG = globalThis.FG;
  if (!FG || globalThis.__fgContentLoaded) return;
  globalThis.__fgContentLoaded = true;

  const html = document.documentElement;

  const CLASS_MAP = Object.freeze({
    hideHome: 'fg-hide-home',
    hideRecommendations: 'fg-hide-recs',
    hideShorts: 'fg-hide-shorts',
    hideComments: 'fg-hide-comments',
    hideEndscreen: 'fg-hide-endscreen',
    hideSearchSuggestions: 'fg-hide-suggest',
    hideExplore: 'fg-hide-explore',
    grayThumbnails: 'fg-gray',
  });

  const ITEM_TAGS = new Set([
    'ytd-rich-grid-media',
    'ytd-video-renderer',
    'ytd-compact-video-renderer',
    'ytd-grid-video-renderer',
    'ytd-playlist-renderer',
    'ytd-compact-playlist-renderer',
    'ytd-radio-renderer',
    'ytd-compact-radio-renderer',
    'ytd-channel-renderer',
    'ytd-reel-item-renderer',
    'yt-lockup-view-model',
    'ytm-shorts-lockup-view-model',
    'ytm-shorts-lockup-view-model-v2',
  ]);
  const ITEM_SEL = [...ITEM_TAGS].join(',');
  const PLAYER_SEL = '#movie_player';
  const CHANNEL_PATH = /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/;
  const UNKNOWN_GRACE_MS = 4000;

  // Texte aus _locales (EN/DE) – chrome.i18n ist auch in Inhaltsskripten verfügbar
  const t = (key) => {
    try {
      return chrome.i18n.getMessage(key) || key;
    } catch {
      return key;
    }
  };
  const REASONS = Object.freeze({
    keyword: t('yt_reason_keyword'),
    channel: t('yt_reason_channel'),
    notAllowed: t('yt_reason_notAllowed'),
    unknown: t('yt_reason_unknown'),
    limit: t('yt_reason_limit'),
  });
  // Hinweis statt Startseiten-Feed: als CSS-Variable (übersetzbar; CSSOM ist von der Seiten-CSP nicht betroffen)
  html.style.setProperty('--fg-home', '"' + t('ytHomeHidden').replace(/[\\"]/g, '\\$&') + '"');

  let settings = null;
  let filterOn = false;
  let gate = 'pending'; // 'open' | 'pending' | 'blocked' – zu, bis die Einstellungen da sind (fail-closed)
  let pausedByUs = false;
  let lastUrl = '';
  let urlChangedAt = 0;
  let autoplayHandled = false;
  let limitBlocked = false; // YouTube-Tageslimit erreicht

  const textOf = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');

  /* ---------- Erkennung ---------- */

  function channelCandidates(root) {
    const out = new Set();
    if (!root) return out;
    for (const a of root.querySelectorAll('a[href]')) {
      const id = FG.channelFromHref(a.getAttribute('href'));
      if (!id) continue;
      out.add(id);
      const name = textOf(a);
      if (name) out.add(FG.normalizeChannel(name));
    }
    for (const e of root.querySelectorAll('ytd-channel-name #text, ytd-channel-name yt-formatted-string, #channel-name #text')) {
      const t = textOf(e);
      if (t) out.add(FG.normalizeChannel(t));
    }
    const row = root.querySelector('[class*="metadata-row"]'); // neues Kachel-Layout: erste Zeile = Kanal
    if (row) {
      for (const part of textOf(row).split('•')) {
        const t = part.trim();
        if (t) out.add(FG.normalizeChannel(t));
      }
    }
    out.delete('');
    return out;
  }

  function titleOf(el) {
    for (const sel of ['#video-title', 'a#video-title-link', '.yt-lockup-metadata-view-model__title', 'h3', '#title']) {
      const e = el.querySelector(sel);
      const t = e && (e.getAttribute('title') || textOf(e));
      if (t) return t;
    }
    return '';
  }

  function pageChannel() {
    const m = location.pathname.match(CHANNEL_PATH);
    if (!m) return null;
    const set = new Set();
    const id = FG.channelFromHref('/' + m[1]);
    if (id) set.add(id);
    const name = textOf(document.querySelector('yt-page-header-view-model h1, #page-header h1, ytd-c4-tabbed-header-renderer #channel-name #text'));
    if (name) set.add(FG.normalizeChannel(name));
    return set;
  }

  /* ---------- Kacheln ---------- */

  function evaluateItem(el, pageCh) {
    let channels = channelCandidates(el);
    if (!channels.size && pageCh) channels = pageCh; // Kacheln auf einer Kanalseite
    const v = FG.verdict(settings, { title: titleOf(el), channels });
    (el.closest('ytd-rich-item-renderer') || el).classList.toggle('fg-hidden', v.status !== 'ok');
  }

  function fullScan() {
    if (!filterOn) {
      for (const e of document.querySelectorAll('.fg-hidden')) e.classList.remove('fg-hidden');
      return;
    }
    const pc = pageChannel();
    for (const el of document.querySelectorAll(ITEM_SEL)) evaluateItem(el, pc);
  }

  // Element → zugehörige Kachel (oder PLAYER / NONE). Pro Element nur einmal berechnet;
  // WeakMap gibt Einträge frei, sobald YouTube Elemente entfernt.
  const PLAYER = 1;
  const NONE = 0;
  const hostCache = new WeakMap();
  function hostOf(el) {
    let h = hostCache.get(el);
    // Selbstheilend: wurde das Element in eine andere Kachel verschoben, neu bestimmen.
    if (h === undefined || (typeof h === 'object' && !h.contains(el))) {
      h = el.closest(PLAYER_SEL) ? PLAYER : el.closest(ITEM_SEL) || NONE;
      hostCache.set(el, h);
    }
    return h;
  }

  function onMutations(records) {
    if (!settings) return;
    let outside = false;
    const pending = filterOn ? new Set() : null;
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      const t = r.target;
      let h = NONE;
      if (t.nodeType === 1) {
        h = hostOf(t);
        if (h === PLAYER) continue; // Player-Ticks: irrelevant und sehr häufig
      }
      outside = true;
      if (!pending) continue;
      if (h !== NONE) {
        pending.add(h); // Änderung innerhalb einer Kachel – darin steckt keine weitere Kachel
        continue;
      }
      if (r.type !== 'childList') continue;
      const added = r.addedNodes;
      for (let j = 0; j < added.length; j++) {
        const n = added[j];
        if (n.nodeType !== 1) continue;
        if (ITEM_TAGS.has(n.localName)) pending.add(n); // Set-Lookup statt Selektor-Abgleich
        else if (n.firstElementChild) for (const e of n.querySelectorAll(ITEM_SEL)) pending.add(e);
      }
    }
    if (pending && pending.size) {
      if (document.readyState === 'loading') {
        // Beim Parsen kommen Kacheln stückweise an: Bewertungen pro Frame bündeln.
        // requestAnimationFrame läuft VOR dem Zeichnen – es blitzt nichts auf.
        for (const el of pending) deferred.add(el);
        if (!deferQueued) {
          deferQueued = true;
          requestAnimationFrame(flushDeferred);
        }
      } else {
        evaluateAll(pending);
      }
    }
    if (outside || (!autoplayHandled && settings.yt.disableAutoplay) || gate === 'pending') schedulePageCheck();
  }

  const deferred = new Set();
  let deferQueued = false;
  function evaluateAll(items) {
    const pc = pageChannel();
    for (const el of items) if (el.isConnected) evaluateItem(el, pc);
  }
  function flushDeferred() {
    deferQueued = false;
    if (!deferred.size || !settings) return;
    evaluateAll(deferred);
    deferred.clear();
  }
  document.addEventListener('DOMContentLoaded', flushDeferred); // auch in Hintergrund-Tabs (dort ruht rAF)

  /* ---------- Videoseite / Kanalseite ---------- */

  function watchInfo() {
    const vid = new URLSearchParams(location.search).get('v');
    const flexy = document.querySelector('ytd-watch-flexy');
    if (!flexy) return null;
    const attr = flexy.getAttribute('video-id');
    if (attr && vid && attr !== vid) return null; // zeigt noch das vorige Video
    const meta = document.querySelector('ytd-watch-metadata');
    if (!meta) return null;
    return {
      title: textOf(meta.querySelector('#title h1, h1')),
      channels: channelCandidates(meta.querySelector('#owner') || meta),
    };
  }

  /** @returns string (Sperrgrund) | null (frei) | undefined (noch unklar) */
  function pageBlockReason() {
    if (limitBlocked && location.pathname === '/watch') return REASONS.limit;
    if (!filterOn) return null;
    let info;
    if (location.pathname === '/watch') {
      info = watchInfo();
      if (!info) return undefined;
    } else {
      const ch = pageChannel();
      if (!ch) return null;
      info = { title: '', channels: ch };
    }
    const v = FG.verdict(settings, info);
    if (v.status === 'ok') return null;
    if (v.status === 'unknown') return Date.now() - urlChangedAt < UNKNOWN_GRACE_MS ? undefined : REASONS.unknown;
    return REASONS[v.reason] || REASONS.channel;
  }

  function pauseAll() {
    let any = false;
    for (const v of document.querySelectorAll('video')) {
      if (!v.paused) {
        v.pause();
        any = true;
      }
    }
    return any;
  }

  // Solange das Tor nicht offen ist, wird jeder Startversuch sofort pausiert.
  document.addEventListener(
    'play',
    (e) => {
      if ((gate === 'open' && !limitBlocked) || !(e.target instanceof HTMLMediaElement)) return;
      e.target.pause();
      if (gate === 'pending') pausedByUs = true;
    },
    true
  );

  let overlay = null;
  function buildOverlay() {
    const el = document.createElement('div');
    el.id = 'fg-overlay';
    el.setAttribute('role', 'alertdialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'fg-overlay-title');
    el.setAttribute('aria-describedby', 'fg-overlay-reason');
    const box = document.createElement('div');
    box.className = 'fg-box';
    const mark = document.createElement('div');
    mark.className = 'fg-mark';
    const title = document.createElement('p');
    title.className = 'fg-title';
    title.id = 'fg-overlay-title';
    title.textContent = t('ytBlockedBy');
    const reason = document.createElement('p');
    reason.className = 'fg-reason';
    reason.id = 'fg-overlay-reason';
    const actions = document.createElement('div');
    actions.className = 'fg-actions';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'fg-primary';
    back.textContent = t('back');
    back.addEventListener('click', () => (history.length > 1 ? history.back() : location.assign('/')));
    const subs = document.createElement('button');
    subs.type = 'button';
    subs.textContent = t('ytToSubs');
    subs.addEventListener('click', () => location.assign('/feed/subscriptions'));
    actions.append(back, subs);
    box.append(mark, title, reason, actions);
    el.append(box);
    return el;
  }

  function setInert(on) {
    const app = document.querySelector('ytd-app');
    if (app) app.inert = on;
  }

  function showOverlay(reason) {
    if (!overlay) overlay = buildOverlay();
    overlay.querySelector('.fg-reason').textContent = reason;
    if (!overlay.isConnected && document.body) {
      document.body.append(overlay);
      setInert(true);
      overlay.querySelector('.fg-primary').focus({ preventScroll: true });
    }
  }

  function hideOverlay() {
    if (overlay && overlay.isConnected) {
      overlay.remove();
      setInert(false);
    }
  }

  /** Tor öffnen; ein Video, das wir nur zur Prüfung angehalten haben, läuft weiter. */
  function openGate() {
    const resume = gate !== 'open' && pausedByUs;
    gate = 'open';
    pausedByUs = false;
    hideOverlay();
    if (resume) {
      const v = document.querySelector(PLAYER_SEL + ' video') || document.querySelector('video');
      if (v && v.paused) v.play().catch(() => {});
    }
  }

  function checkPage() {
    const reason = pageBlockReason();
    if (reason === undefined) return; // noch unklar → Tor bleibt, wie es ist
    if (reason) {
      gate = 'blocked';
      pausedByUs = false;
      showOverlay(reason);
      pauseAll();
      return;
    }
    openGate();
  }

  /* ---------- Seitenweite Regeln ---------- */

  function applyClasses() {
    for (const k in CLASS_MAP) html.classList.toggle(CLASS_MAP[k], !!settings.yt[k]);
  }

  function handleRedirects() {
    const p = location.pathname;
    if (settings.yt.hideShorts && p.startsWith('/shorts/')) {
      const id = p.split('/')[2];
      if (id && /^[\w-]{1,64}$/.test(id)) {
        location.replace('/watch?v=' + encodeURIComponent(id));
        return true;
      }
    }
    if (settings.yt.hideExplore && /^\/feed\/(trending|explore)/.test(p)) {
      location.replace('/feed/subscriptions');
      return true;
    }
    if (settings.yt.redirectHomeToSubs && p === '/') {
      location.replace('/feed/subscriptions');
      return true;
    }
    return false;
  }

  function disableAutoplay() {
    if (!settings.yt.disableAutoplay || autoplayHandled) return;
    const btn = document.querySelector('.ytp-autonav-toggle-button[aria-checked]');
    if (!btn) return;
    autoplayHandled = true; // pro Seite einmal – wer es danach selbst einschaltet, wird nicht bevormundet
    if (btn.getAttribute('aria-checked') === 'true') btn.click();
  }

  function onNavigate(initial) {
    urlChangedAt = Date.now();
    autoplayHandled = false;
    hideOverlay();
    // Auf Videoseiten mit aktiven Filtern bleibt das Tor zu, bis der Kanal geprüft ist (kein kurzes Anspielen).
    if (limitBlocked) refreshLimit();
    if ((filterOn || limitBlocked) && location.pathname === '/watch') {
      if (gate !== 'pending') pausedByUs = false;
      gate = 'pending';
      if (pauseAll()) pausedByUs = true;
    } else {
      openGate();
    }
    if (filterOn && !initial) fullScan(); // kanalabhängige Kacheln neu bewerten (beim Start schon erledigt)
  }

  function pageCheck() {
    if (!settings) return;
    if (location.href !== lastUrl) {
      const initial = lastUrl === '';
      lastUrl = location.href;
      onNavigate(initial);
    }
    applyClasses();
    if (handleRedirects()) return;
    checkPage();
    disableAutoplay();
  }

  let pageTimer = 0;
  function schedulePageCheck() {
    if (pageTimer) return;
    pageTimer = setTimeout(() => {
      pageTimer = 0;
      pageCheck();
    }, 100);
  }

  /* ---------- YouTube-Tageslimit: Wiedergabezeit messen (nur während ein Video läuft) ---------- */

  let ytLimit = null; // { minutes } oder null
  let playingSince = 0;
  let accMs = 0;
  let flushTimer = 0;
  let lastStatusAt = 0;

  function setLimit(exhausted) {
    if (limitBlocked === exhausted) return;
    limitBlocked = exhausted;
    if (exhausted) {
      pauseAll();
      if (location.pathname === '/watch') {
        gate = 'blocked';
        showOverlay(REASONS.limit);
      }
    } else if (settings) {
      schedulePageCheck();
    }
  }

  async function sendYt(msg) {
    try {
      const r = await chrome.runtime.sendMessage(Object.assign({ type: 'fg:yt' }, msg));
      if (r && typeof r === 'object' && r.limited) setLimit(!!r.exhausted);
      else if (r && r.limited === false) setLimit(false);
    } catch {
      /* Erweiterung neu geladen o. Ä. */
    }
  }

  function refreshLimit() {
    if (!ytLimit || Date.now() - lastStatusAt < 30000) return;
    lastStatusAt = Date.now();
    sendYt({ kind: 'status' });
  }

  function flush() {
    let ms = accMs;
    accMs = 0;
    if (playingSince) {
      const t = performance.now();
      ms += t - playingSince;
      playingSince = t;
    }
    if (ytLimit && ms >= 1000) sendYt({ kind: 'tick', ms: Math.round(ms) });
  }

  const anyPlaying = () => [...document.querySelectorAll('video')].some((v) => !v.paused && !v.ended);
  function onPlayState() {
    if (!ytLimit) return;
    if (anyPlaying()) {
      if (!playingSince) playingSince = performance.now();
      if (!flushTimer) flushTimer = setInterval(flush, 15000); // Timer nur während der Wiedergabe
    } else {
      if (playingSince) accMs += performance.now() - playingSince;
      playingSince = 0;
      clearInterval(flushTimer);
      flushTimer = 0;
      flush();
    }
  }
  for (const ev of ['playing', 'pause', 'ended', 'emptied']) document.addEventListener(ev, onPlayState, true);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flush());

  /* ---------- Einstellungen (nur lesend, vom Hintergrund) ---------- */

  function applySettings(view) {
    settings = FG.withDefaults(view);
    ytLimit = view && view.ytLimit && typeof view.ytLimit === 'object' ? view.ytLimit : null;
    if (!ytLimit) setLimit(false);
    else if (settings) refreshLimit();
    filterOn = FG.hasFilter(settings);
    applyClasses();
    html.classList.add('fg-ready');
    fullScan();
    if (location.href === lastUrl) {
      // Einstellungen geändert, Seite gleich: Tor neu bestimmen
      if (filterOn && settings.filter.mode === 'whitelist' && location.pathname === '/watch' && gate === 'open') gate = 'pending';
    }
    pageCheck();
  }

  let haveBroadcast = false;
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !sender || sender.id !== chrome.runtime.id) return false;
    if (msg.type === 'fg:settings' && msg.settings && typeof msg.settings === 'object') {
      haveBroadcast = true;
      applySettings(msg.settings);
    } else if (msg.type === 'fg:context') {
      sendResponse(context());
    }
    return false;
  });

  (async function init(attempt) {
    try {
      const r = await chrome.runtime.sendMessage({ type: 'fg:get' });
      if (!r || !r.ok) throw new Error('keine Einstellungen');
      if (!haveBroadcast) applySettings(r.settings);
      if (r.yt && r.yt.exhausted) setLimit(true);
    } catch {
      if (attempt < 4) setTimeout(() => init(attempt + 1), 250 * 2 ** attempt);
      else {
        html.classList.add('fg-ready'); // nie die Seite dauerhaft verstecken/anhalten, falls etwas schiefgeht
        openGate();
      }
    }
  })(0);

  new MutationObserver(onMutations).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href'], // YouTube recycelt Kacheln: neuer Link = neues Video
  });
  for (const target of [window, document]) {
    target.addEventListener('yt-navigate-finish', schedulePageCheck);
  }
  window.addEventListener('popstate', schedulePageCheck);

  /* ---------- Kontext fürs Popup ("Kanal sperren/erlauben") ---------- */

  function context() {
    let name = '';
    let id = '';
    if (location.pathname === '/watch') {
      const a = document.querySelector('ytd-watch-metadata #owner ytd-channel-name a, #owner ytd-channel-name a');
      if (a) {
        name = textOf(a);
        id = FG.channelFromHref(a.getAttribute('href'));
      }
    } else {
      const m = location.pathname.match(CHANNEL_PATH);
      if (m) {
        id = FG.channelFromHref('/' + m[1]);
        name = textOf(document.querySelector('yt-page-header-view-model h1, #page-header h1')) || id;
      }
    }
    return { name: name.slice(0, 200), id: id.slice(0, 200) };
  }
})();
