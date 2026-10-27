/*
 * FocusGuard – gemeinsame Logik für Hintergrund, Popup, Einstellungen und YouTube-Skript.
 *
 * Diese Datei enthält bewusst KEINEN Netzwerkcode (kein fetch, kein XHR, kein WebSocket).
 * Gespeichert wird ausschließlich in chrome.storage.local, also nur auf diesem Gerät.
 */
(function (root) {
  'use strict';

  const YT_KEYS = [
    'hideHome',
    'redirectHomeToSubs',
    'hideRecommendations',
    'hideShorts',
    'hideComments',
    'hideEndscreen',
    'disableAutoplay',
  ];

  const DEFAULTS = Object.freeze({
    blockedSites: [],
    yt: {
      hideHome: true,
      redirectHomeToSubs: false,
      hideRecommendations: true,
      hideShorts: true,
      hideComments: false,
      hideEndscreen: true,
      disableAutoplay: true,
    },
    filter: {
      mode: 'blacklist', // 'blacklist' = alles außer gesperrten Kanälen | 'whitelist' = nur erlaubte Kanäle
      blockedChannels: [],
      blockedKeywords: [],
      allowedChannels: [],
    },
    lockUntil: 0, // Zeitstempel (ms); solange in der Zukunft, dürfen Regeln nur verschärft werden
  });

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const uniq = (arr) => [...new Set(arr)];
  // Reihenfolge-unabhängig: Chrome speichert Objekte mit alphabetisch sortierten Schlüsseln.
  const canonical = (v) =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))
        : v;
  const sameJSON = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

  function safeDecode(s) {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  }

  /* ---------- Normalisierung ---------- */

  /** "https://www.Instagram.com/explore" -> "instagram.com"; ungültig -> "" */
  function normalizeDomain(input) {
    if (typeof input !== 'string') return '';
    let s = input.trim().toLowerCase();
    if (!s) return '';
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ''); // Schema
    s = s.split(/[/?#]/)[0]; // Pfad, Query, Fragment
    s = s.replace(/^.*@/, ''); // user@
    s = s.replace(/:\d+$/, ''); // Port
    s = s.replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');
    if (/[^\x00-\x7f]/.test(s)) {
      try {
        s = new URL('http://' + s).hostname; // Umlaut-Domains -> Punycode
      } catch {
        return '';
      }
    }
    return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(s) ? s : '';
  }

  /** Kanal aus einem YouTube-Link: "/@MrBeast" -> "@mrbeast", "/channel/UC…" -> "uc…" */
  function channelFromHref(href) {
    if (typeof href !== 'string' || !href) return '';
    let path = href.trim();
    const abs = path.match(/^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com(\/.*)?$/i);
    if (abs) path = abs[1] || '/';
    if (!path.startsWith('/')) return '';
    let m = path.match(/^\/(@[^/?#]+)/);
    if (m) return safeDecode(m[1]).normalize('NFC').toLowerCase();
    m = path.match(/^\/channel\/(UC[\w-]+)/i);
    if (m) return m[1].toLowerCase();
    m = path.match(/^\/(?:c|user)\/([^/?#]+)/);
    if (m) return safeDecode(m[1]).normalize('NFC').toLowerCase();
    return '';
  }

  /** Eingabe eines Kanals: Name, @Handle, Kanal-ID oder Link */
  function normalizeChannel(input) {
    if (typeof input !== 'string') return '';
    const s = input.normalize('NFC').trim();
    if (!s) return '';
    if (/youtube\.com/i.test(s) || s.startsWith('/')) return channelFromHref(s);
    if (/^@\S+$/.test(s)) return s.toLowerCase();
    if (/^UC[\w-]{22}$/.test(s)) return s.toLowerCase();
    return s.replace(/\s+/g, ' ').toLowerCase();
  }

  function normalizeKeyword(input) {
    if (typeof input !== 'string') return '';
    return input.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  // Obergrenzen schützen vor aufgeblähten/manipulierten Importen.
  const MAX_ENTRIES = 2000;
  const MAX_LEN = 200;
  const strList = (v, norm) =>
    Array.isArray(v)
      ? uniq(
          v
            .slice(0, MAX_ENTRIES * 2)
            .filter((x) => typeof x === 'string' && x.length <= MAX_LEN * 2)
            .map(norm)
            .filter((x) => x && x.length <= MAX_LEN)
        ).slice(0, MAX_ENTRIES)
      : [];

  /** Bringt beliebige (auch manipulierte/importierte) Daten in eine gültige Form. */
  function withDefaults(raw) {
    const r = raw && typeof raw === 'object' ? raw : {};
    const yt = r.yt && typeof r.yt === 'object' ? r.yt : {};
    const f = r.filter && typeof r.filter === 'object' ? r.filter : {};
    const out = clone(DEFAULTS);
    out.blockedSites = strList(r.blockedSites, normalizeDomain);
    for (const k of YT_KEYS) if (typeof yt[k] === 'boolean') out.yt[k] = yt[k];
    out.filter.mode = f.mode === 'whitelist' ? 'whitelist' : 'blacklist';
    out.filter.blockedChannels = strList(f.blockedChannels, normalizeChannel);
    out.filter.blockedKeywords = strList(f.blockedKeywords, normalizeKeyword);
    out.filter.allowedChannels = strList(f.allowedChannels, normalizeChannel);
    out.lockUntil = Number.isFinite(r.lockUntil) && r.lockUntil > 0 ? Math.floor(r.lockUntil) : 0;
    return out;
  }

  /* ---------- Sperrmodus ---------- */

  const isLocked = (s, now = Date.now()) => !!s && s.lockUntil > now;

  /**
   * Während der Sperre: alles, was lockert, wird zurückgedreht.
   * Erlaubt bleibt nur, was verschärft (Seiten/Kanäle/Stichwörter hinzufügen,
   * Optionen einschalten, erlaubte Kanäle entfernen, Sperre verlängern).
   */
  function enforceLock(snap, next) {
    const out = clone(next);
    out.lockUntil = Math.max(snap.lockUntil, next.lockUntil);
    out.blockedSites = uniq([...snap.blockedSites, ...next.blockedSites]);
    for (const k of YT_KEYS) out.yt[k] = !!(next.yt[k] || snap.yt[k]);
    out.filter.blockedChannels = uniq([...snap.filter.blockedChannels, ...next.filter.blockedChannels]);
    out.filter.blockedKeywords = uniq([...snap.filter.blockedKeywords, ...next.filter.blockedKeywords]);
    if (snap.filter.mode === 'whitelist') {
      out.filter.mode = 'whitelist';
      const allowed = new Set(snap.filter.allowedChannels);
      out.filter.allowedChannels = next.filter.allowedChannels.filter((c) => allowed.has(c));
    }
    return out;
  }

  /* ---------- YouTube-Filter ---------- */

  const hasFilter = (s) =>
    s.filter.mode === 'whitelist' || s.filter.blockedChannels.length > 0 || s.filter.blockedKeywords.length > 0;

  /**
   * @param s Einstellungen
   * @param info { title: string, channels: Set<string> (normalisiert) }
   * @returns { status: 'ok' | 'blocked' | 'unknown', reason?: 'keyword' | 'channel' | 'notAllowed' }
   */
  function verdict(s, info) {
    const f = s.filter;
    const title = normalizeKeyword(String((info && info.title) || ''));
    const channels = (info && info.channels) || new Set();
    if (title && f.blockedKeywords.some((k) => title.includes(k))) return { status: 'blocked', reason: 'keyword' };
    if (!channels.size) return { status: f.mode === 'whitelist' ? 'unknown' : 'ok' };
    if (f.blockedChannels.some((c) => channels.has(c))) return { status: 'blocked', reason: 'channel' };
    if (f.mode === 'whitelist' && !f.allowedChannels.some((c) => channels.has(c))) {
      return { status: 'blocked', reason: 'notAllowed' };
    }
    return { status: 'ok' };
  }

  /* ---------- Speicher (nur lokal) ---------- */

  async function load() {
    const { settings } = await chrome.storage.local.get('settings');
    return withDefaults(settings);
  }

  function save(s) {
    return chrome.storage.local.set({ settings: withDefaults(s) });
  }

  const FG = Object.freeze({
    YT_KEYS,
    DEFAULTS,
    clone,
    uniq,
    sameJSON,
    normalizeDomain,
    normalizeChannel,
    normalizeKeyword,
    channelFromHref,
    withDefaults,
    isLocked,
    enforceLock,
    hasFilter,
    verdict,
    load,
    save,
  });

  root.FG = FG;
  if (typeof module !== 'undefined' && module.exports) module.exports = FG;
})(typeof globalThis !== 'undefined' ? globalThis : this);
