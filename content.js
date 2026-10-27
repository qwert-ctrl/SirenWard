/*
 * FocusGuard – YouTube-Inhaltsskript (nur www.youtube.com).
 * Blendet Elemente aus, filtert Videos nach Kanal/Stichwort und sperrt Videoseiten.
 * Liest nur die lokalen Einstellungen. Sendet nichts, speichert keinen Verlauf.
 */
(() => {
  'use strict';
  const FG = globalThis.FG;
  if (!FG) return;

  const html = document.documentElement;
  let settings = FG.withDefaults(null);
  let version = 0;
  let ready = false;

  const CLASS_MAP = {
    hideHome: 'fg-hide-home',
    hideRecommendations: 'fg-hide-recs',
    hideShorts: 'fg-hide-shorts',
    hideComments: 'fg-hide-comments',
    hideEndscreen: 'fg-hide-endscreen',
  };

  // Einzelne Video-/Kanal-Kacheln in Feeds, Suche, Seitenleiste und auf Kanalseiten.
  const ITEM_SEL = [
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
  ].join(',');

  const REASONS = {
    keyword: 'Der Titel enthält ein gesperrtes Stichwort.',
    channel: 'Dieser Kanal ist gesperrt.',
    notAllowed: 'Dieser Kanal steht nicht auf deiner Erlaubt-Liste.',
    unknown: 'Der Kanal konnte nicht erkannt werden – im strikten Modus wird gesperrt.',
  };

  const textOf = (el) => (el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '');

  /* ---------- Erkennung ---------- */

  function channelCandidates(root) {
    const out = new Set();
    if (!root) return out;
    root.querySelectorAll('a[href]').forEach((a) => {
      const id = FG.channelFromHref(a.getAttribute('href'));
      if (!id) return;
      out.add(id);
      const name = textOf(a);
      if (name) out.add(FG.normalizeChannel(name));
    });
    root
      .querySelectorAll('ytd-channel-name #text, ytd-channel-name yt-formatted-string, #channel-name #text')
      .forEach((e) => {
        const t = textOf(e);
        if (t) out.add(FG.normalizeChannel(t));
      });
    // Neues Kachel-Layout: erste Metadatenzeile = Kanalname
    const row = root.querySelector('[class*="metadata-row"]');
    if (row) {
      textOf(row)
        .split('•')
        .forEach((part) => {
          const t = part.trim();
          if (t) out.add(FG.normalizeChannel(t));
        });
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

  const CHANNEL_PATH = /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)/;

  function pageChannel() {
    const m = location.pathname.match(CHANNEL_PATH);
    if (!m) return null;
    const set = new Set();
    const id = FG.channelFromHref('/' + m[1]);
    if (id) set.add(id);
    const name = textOf(
      document.querySelector(
        'yt-page-header-view-model h1, #page-header h1, ytd-c4-tabbed-header-renderer #channel-name #text'
      )
    );
    if (name) set.add(FG.normalizeChannel(name));
    return set;
  }

  /* ---------- Kacheln filtern ---------- */

  function processItems() {
    const filterOn = FG.hasFilter(settings);
    const pageCh = filterOn ? pageChannel() : null;
    document.querySelectorAll(ITEM_SEL).forEach((el) => {
      const target = el.closest('ytd-rich-item-renderer') || el;
      if (!filterOn) {
        target.classList.remove('fg-hidden');
        return;
      }
      const title = titleOf(el);
      const key = version + '|' + title + '|' + el.querySelectorAll('a[href]').length;
      if (el.__fgKey === key) return; // unverändert seit letzter Prüfung
      let channels = channelCandidates(el);
      if (!channels.size && pageCh) channels = pageCh; // Kacheln auf einer Kanalseite
      const v = FG.verdict(settings, { title, channels });
      target.classList.toggle('fg-hidden', v.status !== 'ok');
      el.__fgKey = v.status === 'unknown' ? null : key; // Unbekanntes später erneut prüfen
    });
  }

  /* ---------- Ganze Seite (Video / Kanal) prüfen ---------- */

  let lastUrl = location.href;
  let urlChangedAt = Date.now();

  function watchInfo() {
    const vid = new URLSearchParams(location.search).get('v');
    const flexy = document.querySelector('ytd-watch-flexy');
    if (!flexy) return null;
    const attr = flexy.getAttribute('video-id');
    if (attr && vid && attr !== vid) return null; // Seite zeigt noch das vorige Video
    const meta = document.querySelector('ytd-watch-metadata');
    if (!meta) return null;
    return {
      title: textOf(meta.querySelector('#title h1, h1')),
      channels: channelCandidates(meta.querySelector('#owner') || meta),
    };
  }

  /** @returns string (Sperrgrund) | null (frei) | undefined (noch unklar, Zustand beibehalten) */
  function pageBlockReason() {
    if (!FG.hasFilter(settings)) return null;
    let info = null;
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
    if (v.status === 'unknown') return Date.now() - urlChangedAt < 4000 ? undefined : REASONS.unknown;
    return REASONS[v.reason] || REASONS.channel;
  }

  let overlay = null;

  function buildOverlay() {
    const box = document.createElement('div');
    box.className = 'fg-box';
    const mark = document.createElement('div');
    mark.className = 'fg-mark';
    const title = document.createElement('p');
    title.className = 'fg-title';
    title.textContent = 'Gesperrt von FocusGuard';
    const reason = document.createElement('p');
    reason.className = 'fg-reason';
    const actions = document.createElement('div');
    actions.className = 'fg-actions';
    const back = document.createElement('button');
    back.className = 'fg-primary';
    back.textContent = 'Zurück';
    back.addEventListener('click', () => (history.length > 1 ? history.back() : location.assign('/')));
    const subs = document.createElement('button');
    subs.textContent = 'Zu meinen Abos';
    subs.addEventListener('click', () => location.assign('/feed/subscriptions'));
    actions.append(back, subs);
    box.append(mark, title, reason, actions);
    const el = document.createElement('div');
    el.id = 'fg-overlay';
    el.setAttribute('role', 'alertdialog');
    el.append(box);
    return el;
  }

  function pauseVideos() {
    document.querySelectorAll('video').forEach((v) => {
      if (!v.paused) v.pause();
    });
  }

  function showOverlay(reason) {
    if (!overlay) overlay = buildOverlay();
    overlay.querySelector('.fg-reason').textContent = reason;
    if (!overlay.isConnected && document.body) document.body.append(overlay);
    pauseVideos();
  }

  function hideOverlay() {
    if (overlay && overlay.isConnected) overlay.remove();
  }

  // Gesperrtes Video bleibt pausiert, auch wenn YouTube es neu startet.
  document.addEventListener(
    'play',
    (e) => {
      if (overlay && overlay.isConnected && e.target instanceof HTMLVideoElement) e.target.pause();
    },
    true
  );

  function checkPage() {
    const reason = pageBlockReason();
    if (reason === undefined) return;
    if (reason) showOverlay(reason);
    else hideOverlay();
  }

  /* ---------- Weiterleitungen & Player ---------- */

  function handleRedirects() {
    const p = location.pathname;
    if (settings.yt.hideShorts && p.startsWith('/shorts/')) {
      const id = p.split('/')[2];
      if (id) {
        location.replace('/watch?v=' + encodeURIComponent(id));
        return true;
      }
    }
    if (settings.yt.redirectHomeToSubs && p === '/') {
      location.replace('/feed/subscriptions');
      return true;
    }
    return false;
  }

  function disableAutoplay() {
    if (!settings.yt.disableAutoplay) return;
    const btn = document.querySelector('.ytp-autonav-toggle-button[aria-checked="true"]');
    if (btn && !btn.dataset.fgDone) {
      btn.dataset.fgDone = '1'; // nur einmal – wer es danach selbst einschaltet, wird nicht bevormundet
      btn.click();
    }
  }

  function applyClasses() {
    for (const [key, cls] of Object.entries(CLASS_MAP)) html.classList.toggle(cls, !!settings.yt[key]);
  }

  /* ---------- Ablauf ---------- */

  function run() {
    if (!ready) return;
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      urlChangedAt = Date.now();
      hideOverlay();
    }
    applyClasses();
    if (handleRedirects()) return;
    processItems();
    checkPage();
    disableAutoplay();
  }

  let scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      run();
    }, 200);
  }

  new MutationObserver(schedule).observe(document, { childList: true, subtree: true });
  window.addEventListener('yt-navigate-finish', schedule);
  window.addEventListener('popstate', schedule);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    settings = FG.withDefaults(changes.settings.newValue);
    version++;
    run();
  });

  chrome.storage.local.get('settings').then(({ settings: s }) => {
    settings = FG.withDefaults(s);
    version++;
    ready = true;
    run();
  });

  /* ---------- Kontext fürs Popup ("Kanal sperren/erlauben") ---------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'fg:context') return;
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
    sendResponse({ name, id });
  });
})();
