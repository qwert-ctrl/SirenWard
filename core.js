/*
 * FocusGuard – Kernlogik ("functional core").
 *
 * Reine Funktionen ohne Ein-/Ausgabe: Normalisierung, Bereinigung, Filter, Sperrmodus,
 * Befehle. Kein Browser-API-Zugriff, kein Netzwerkcode – dadurch vollständig in Node testbar.
 * Geladen als klassisches Skript (Service Worker, Seiten, Content-Script) und als CommonJS (Tests).
 */
(function (root) {
  'use strict';

  /* ---------- Konstanten ---------- */

  const YT_KEYS = Object.freeze([
    'hideHome',
    'redirectHomeToSubs',
    'hideRecommendations',
    'hideShorts',
    'hideComments',
    'hideEndscreen',
    'disableAutoplay',
  ]);

  const LIMITS = Object.freeze({
    MAX_ENTRIES: 2000, // pro Liste
    MAX_LEN: 200, // pro Eintrag (normalisiert)
    MAX_OP_VALUES: 500, // Werte pro Befehl
    MIN_LOCK_MS: 60 * 1000,
    MAX_LOCK_MS: 365 * 24 * 3600 * 1000,
    ROLLBACK_TOLERANCE_MS: 5 * 60 * 1000, // Uhr-Rücksprung, ab dem eine abgelaufene Sperre wieder greift
  });

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
      mode: 'blacklist', // 'blacklist' = alles außer Gesperrtem | 'whitelist' = nur erlaubte Kanäle
      blockedChannels: [],
      blockedKeywords: [],
      allowedChannels: [],
    },
    lockUntil: 0,
  });

  /* ---------- Hilfen ---------- */

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const uniq = (arr) => [...new Set(arr)];

  // Reihenfolge-unabhängiger Vergleich: Chrome speichert Objekte mit sortierten Schlüsseln.
  const canonical = (v) =>
    Array.isArray(v)
      ? v.map(canonical)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canonical(v[k])])
          )
        : v;
  const stableStringify = (v) => JSON.stringify(canonical(v));
  const sameJSON = (a, b) => stableStringify(a) === stableStringify(b);

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
    if (typeof input !== 'string' || input.length > 2048) return '';
    let s = input.trim().toLowerCase();
    if (!s) return '';
    s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    s = s.split(/[/?#]/)[0];
    s = s.replace(/^.*@/, '');
    s = s.replace(/:\d+$/, '');
    s = s.replace(/^\*\./, '').replace(/^www\./, '').replace(/\.$/, '');
    if (/[^\x00-\x7f]/.test(s)) {
      try {
        s = new URL('http://' + s).hostname; // nur lokales Parsen (IDN -> Punycode), keine Anfrage
      } catch {
        return '';
      }
    }
    return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/.test(s) ? s : '';
  }

  /** "/@MrBeast" -> "@mrbeast", "/channel/UC…" -> "uc…" */
  function channelFromHref(href) {
    if (typeof href !== 'string' || !href || href.length > 2048) return '';
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

  function normalizeChannel(input) {
    if (typeof input !== 'string' || input.length > 2048) return '';
    const s = input.normalize('NFC').trim();
    if (!s) return '';
    if (/youtube\.com/i.test(s) || s.startsWith('/')) return channelFromHref(s);
    if (/^@\S+$/.test(s)) return s.toLowerCase();
    if (/^UC[\w-]{22}$/.test(s)) return s.toLowerCase();
    return s.replace(/\s+/g, ' ').toLowerCase();
  }

  function normalizeKeyword(input) {
    if (typeof input !== 'string' || input.length > 2048) return '';
    return input.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  const strList = (v, norm) =>
    Array.isArray(v)
      ? uniq(
          v
            .slice(0, LIMITS.MAX_ENTRIES * 2)
            .filter((x) => typeof x === 'string')
            .map(norm)
            .filter((x) => x && x.length <= LIMITS.MAX_LEN)
        ).slice(0, LIMITS.MAX_ENTRIES)
      : [];

  /** Bringt beliebige (auch manipulierte/importierte) Daten in eine gültige, idempotente Form. */
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
    out.lockUntil =
      Number.isFinite(r.lockUntil) && r.lockUntil > 0 ? Math.min(Math.floor(r.lockUntil), 8.64e15) : 0;
    return out;
  }

  /** Was das YouTube-Skript braucht – und nicht mehr (Datensparsamkeit). */
  const publicView = (s) => ({ yt: clone(s.yt), filter: clone(s.filter) });

  /* ---------- Sperrmodus ---------- */

  const isLocked = (s, now) => !!s && s.lockUntil > now;

  /** Verschärfen erlaubt, Lockern wird auf den Stand bei Sperrbeginn zurückgesetzt. */
  function enforceLock(snap, next) {
    const out = clone(next);
    out.lockUntil = Math.max(snap.lockUntil, next.lockUntil);
    out.blockedSites = uniq([...snap.blockedSites, ...next.blockedSites]).slice(0, LIMITS.MAX_ENTRIES);
    for (const k of YT_KEYS) out.yt[k] = !!(next.yt[k] || snap.yt[k]);
    out.filter.blockedChannels = uniq([...snap.filter.blockedChannels, ...next.filter.blockedChannels]).slice(0, LIMITS.MAX_ENTRIES);
    out.filter.blockedKeywords = uniq([...snap.filter.blockedKeywords, ...next.filter.blockedKeywords]).slice(0, LIMITS.MAX_ENTRIES);
    if (snap.filter.mode === 'whitelist') {
      out.filter.mode = 'whitelist';
      const allowed = new Set(snap.filter.allowedChannels);
      out.filter.allowedChannels = next.filter.allowedChannels.filter((c) => allowed.has(c));
    }
    return out;
  }

  /**
   * Ist eine Sperre aktiv? Normal: solange now < lockUntil.
   * Schutz gegen Uhr-Manipulation: Wurde das Ende schon einmal "gesehen" (maxSeen >= lockUntil),
   * gilt sie als abgelaufen – AUSSER die Uhr steht jetzt deutlich (> 5 min) hinter dem bisher
   * gesehenen Maximum. Muster "Uhr vordrehen → Regeln löschen → Uhr zurück" schaltet die Sperre
   * damit automatisch wieder scharf; ein kleiner NTP-Abgleich nach regulärem Ablauf dagegen nicht.
   */
  function lockActive(s, now, maxSeen) {
    if (!s || !(now < s.lockUntil)) return false;
    return !(maxSeen >= s.lockUntil) || now < maxSeen - LIMITS.ROLLBACK_TOLERANCE_MS;
  }

  /**
   * Zentrale Richtlinie: aus gewünschtem Zustand (next), bisherigem Zustand (prev),
   * Sperr-Snapshot und Uhr den tatsächlich gültigen Zustand berechnen. Rein funktional.
   * @returns { effective, snapshot, maxSeen }
   */
  function resolveState({ next, prev, snap, now, maxSeen }) {
    const seen = Math.max(Number.isFinite(maxSeen) ? maxSeen : 0, now);
    let base = null;
    if (lockActive(snap, now, seen)) base = snap;
    else if (lockActive(prev, now, seen)) base = prev; // z. B. Snapshot manipulativ gelöscht
    const effective = base ? enforceLock(base, next) : clone(next);
    const active = lockActive(effective, now, seen);
    if (!active) effective.lockUntil = 0; // abgelaufen → sauber zurücksetzen
    // Eine abgelaufene Sperre bleibt als Snapshot erhalten (Schutz gegen Uhr-Rücksprung).
    return { effective, snapshot: active ? effective : snap || null, maxSeen: seen };
  }

  /* ---------- Befehle (nur der Hintergrund führt sie aus) ---------- */

  const LISTS = Object.freeze({
    blockedSites: { get: (s) => s.blockedSites, set: (s, v) => (s.blockedSites = v), norm: normalizeDomain },
    blockedChannels: { get: (s) => s.filter.blockedChannels, set: (s, v) => (s.filter.blockedChannels = v), norm: normalizeChannel },
    blockedKeywords: { get: (s) => s.filter.blockedKeywords, set: (s, v) => (s.filter.blockedKeywords = v), norm: normalizeKeyword },
    allowedChannels: { get: (s) => s.filter.allowedChannels, set: (s, v) => (s.filter.allowedChannels = v), norm: normalizeChannel },
  });

  const fail = (error, extra) => Object.assign({ ok: false, error }, extra);
  const isPlainObject = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  /**
   * Wendet einen validierten Befehl auf einen Zustand an. Rein funktional.
   * @returns {ok:true, state, invalid?:string[]} | {ok:false, error:'invalid'|'locked', invalid?}
   */
  function applyOp(state, op, now, maxSeen) {
    if (!isPlainObject(op) || typeof op.op !== 'string') return fail('invalid');
    const s = clone(state);
    const seen = Math.max(now, Number.isFinite(maxSeen) ? maxSeen : now);
    const locked = lockActive(s, now, seen);

    switch (op.op) {
      case 'add':
      case 'remove': {
        if (!has(LISTS, op.list) || !Array.isArray(op.values) || op.values.length === 0 || op.values.length > LIMITS.MAX_OP_VALUES) {
          return fail('invalid');
        }
        if (!op.values.every((v) => typeof v === 'string' && v.length <= 2048)) return fail('invalid');
        const def = LISTS[op.list];
        const normed = op.values.map(def.norm);
        const invalid = op.values.filter((_, i) => !normed[i] || normed[i].length > LIMITS.MAX_LEN);
        const good = uniq(normed.filter((v) => v && v.length <= LIMITS.MAX_LEN));
        if (op.op === 'add') {
          if (locked && op.list === 'allowedChannels' && s.filter.mode === 'whitelist') return fail('locked');
          const list = def.get(s);
          for (const v of good) if (!list.includes(v) && list.length < LIMITS.MAX_ENTRIES) list.push(v);
        } else {
          if (locked && op.list !== 'allowedChannels') return fail('locked');
          def.set(s, def.get(s).filter((v) => !good.includes(v)));
        }
        return { ok: true, state: s, invalid };
      }

      case 'setYt': {
        if (!YT_KEYS.includes(op.key) || typeof op.value !== 'boolean') return fail('invalid');
        if (locked && s.yt[op.key] && !op.value) return fail('locked');
        s.yt[op.key] = op.value;
        return { ok: true, state: s };
      }

      case 'setMode': {
        if (op.mode !== 'blacklist' && op.mode !== 'whitelist') return fail('invalid');
        if (locked && s.filter.mode === 'whitelist' && op.mode === 'blacklist') return fail('locked');
        s.filter.mode = op.mode;
        return { ok: true, state: s };
      }

      case 'lock': {
        const ms = op.durationMs;
        if (!Number.isFinite(ms) || ms < LIMITS.MIN_LOCK_MS || ms > LIMITS.MAX_LOCK_MS) return fail('invalid');
        // Lief die Uhr kurz zuvor ein paar Minuten vor, ab dem höchsten gesehenen Zeitpunkt zählen –
        // sonst gälte eine kurze neue Sperre sofort als "abgelaufen".
        const start = seen - now < LIMITS.ROLLBACK_TOLERANCE_MS ? seen : now;
        s.lockUntil = Math.max(s.lockUntil, start + Math.floor(ms));
        return { ok: true, state: s };
      }

      case 'import': {
        if (!isPlainObject(op.settings)) return fail('invalid');
        const incoming = withDefaults(op.settings);
        incoming.lockUntil = s.lockUntil; // Import ändert nie die Sperre
        const out = locked ? enforceLock(s, incoming) : incoming;
        return { ok: true, state: out, partial: locked && !sameJSON(out, incoming) };
      }

      default:
        return fail('invalid');
    }
  }

  /* ---------- YouTube-Filter ---------- */

  const hasFilter = (s) =>
    s.filter.mode === 'whitelist' || s.filter.blockedChannels.length > 0 || s.filter.blockedKeywords.length > 0;

  /**
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

  const FG = Object.freeze({
    YT_KEYS,
    LIMITS,
    DEFAULTS,
    clone,
    uniq,
    sameJSON,
    stableStringify,
    normalizeDomain,
    normalizeChannel,
    normalizeKeyword,
    channelFromHref,
    withDefaults,
    publicView,
    isLocked,
    enforceLock,
    lockActive,
    resolveState,
    applyOp,
    hasFilter,
    verdict,
  });

  root.FG = FG;
  if (typeof module !== 'undefined' && module.exports) module.exports = FG;
})(typeof globalThis !== 'undefined' ? globalThis : this);
