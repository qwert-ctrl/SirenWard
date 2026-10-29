/*
 * Sirenward – Kernlogik ("functional core").
 *
 * Reine Funktionen ohne Ein-/Ausgabe: Normalisierung, Bereinigung, Filter, Sperrmodus, Partner-Code,
 * Zeitfreigaben, Zeitplan, Fokus, YouTube-Limit, Statistik und die daraus folgenden Sperrregeln.
 * Kein Browser-API-Zugriff, kein Netzwerkcode – dadurch vollständig in Node testbar.
 * Geladen als klassisches Skript (Seiten, Content-Script), als ES-Modul-Seiteneffekt (Service Worker)
 * und als CommonJS (Tests).
 */
(function (root) {
  'use strict';

  /* ======================================================================
   * Konstanten
   * ==================================================================== */

  const YT_KEYS = Object.freeze([
    'hideHome',
    'redirectHomeToSubs',
    'hideRecommendations',
    'hideShorts',
    'hideComments',
    'hideEndscreen',
    'disableAutoplay',
    'hideSearchSuggestions',
    'hideExplore',
    'grayThumbnails',
  ]);

  const FEATURE_KEYS = Object.freeze(['schedule', 'focus', 'blockPage', 'ytLimit', 'stats']);

  const MIN = 60 * 1000;
  const LIMITS = Object.freeze({
    MAX_ENTRIES: 2000, // pro Liste
    MAX_LEN: 200, // pro Eintrag (normalisiert)
    MAX_OP_VALUES: 500, // Werte pro Befehl
    MIN_LOCK_MS: MIN,
    MAX_LOCK_MS: 365 * 24 * 60 * MIN,
    ROLLBACK_TOLERANCE_MS: 5 * MIN, // Uhr-Rücksprung, ab dem eine abgelaufene Sperre wieder greift
    UNLOCK_PER_DAY_MAX: 20,
    UNLOCK_MINUTES_MAX: 120,
    WAIT_SECONDS_MAX: 600,
    PHRASE_MAX: 120,
    PHRASE_MIN_LETTERS: 3,
    FOCUS_MIN: 5,
    FOCUS_MAX: 240,
    YT_LIMIT_MAX: 600,
    YT_TICK_MAX_MS: 30 * 1000,
    PENDING_TTL_MS: 10 * MIN, // so lange gilt eine angefragte Freigabe nach Ablauf der Wartezeit
    STATS_DAYS: 30,
    CODE_MIN: 6,
    CODE_MAX: 128,
    PBKDF2_MIN: 100000,
    PBKDF2_MAX: 5000000,
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
      hideSearchSuggestions: false,
      hideExplore: false,
      grayThumbnails: false,
    },
    filter: {
      mode: 'blacklist', // 'blacklist' = alles außer Gesperrtem | 'whitelist' = nur erlaubte Kanäle
      blockedChannels: [],
      blockedKeywords: [],
      allowedChannels: [],
    },
    unlock: { perDay: 3, minutes: 15, waitSeconds: 30, phrase: 'I really need this right now' }, // bei Neuinstallation: Satz in der Sprache des Browsers
    features: { schedule: false, focus: false, blockPage: false, ytLimit: false, stats: false },
    schedule: { days: [1, 2, 3, 4, 5], start: 9 * 60, end: 17 * 60 }, // Minuten seit Mitternacht, Ortszeit
    focus: { minutes: 25 },
    ytLimit: { minutes: 30 },
    partner: { enabled: false, salt: '', hash: '', iter: 0 },
    lockUntil: 0,
  });

  const STATE_DEFAULTS = Object.freeze({
    day: '',
    used: {}, // Domain → genutzte Freigaben heute
    unlocks: {}, // Domain → Ende der aktiven Freigabe
    pending: {}, // Domain → Zeitpunkt, ab dem die angefragte Freigabe bestätigt werden kann
    focusUntil: 0,
    ytMs: 0, // YouTube-Wiedergabe heute
    stats: {}, // Tag → Zähler (nur wenn features.stats)
  });

  /* ======================================================================
   * Hilfen
   * ==================================================================== */

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const uniq = (arr) => [...new Set(arr)];
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isObj = (o) => !!o && typeof o === 'object' && !Array.isArray(o);
  const intIn = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const finitePos = (v) => (Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), 8.64e15) : 0);

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

  /** Lokales Datum "YYYY-MM-DD". */
  function dayKey(ts) {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /* ======================================================================
   * Normalisierung
   * ==================================================================== */

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

  /** Nur Buchstaben, ohne Groß-/Kleinschreibung: "Ich will's, WIRKLICH!" -> "ichwillswirklich" */
  function phraseLetters(s) {
    if (typeof s !== 'string' || s.length > 2048) return '';
    return s.normalize('NFC').toLowerCase().replace(/[^\p{L}]/gu, '');
  }
  const phraseMatches = (typed, phrase) => {
    const want = phraseLetters(phrase);
    return want.length >= LIMITS.PHRASE_MIN_LETTERS && phraseLetters(typed) === want;
  };

  /** Welcher Eintrag der Sperrliste deckt diesen Host ab? ("old.reddit.com" -> "reddit.com") */
  function matchEntry(list, host) {
    const h = normalizeDomain(host);
    if (!h) return '';
    let best = '';
    for (const d of list) if ((h === d || h.endsWith('.' + d)) && d.length > best.length) best = d;
    return best;
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

  const B64 = /^[A-Za-z0-9+/]{16,172}={0,2}$/;

  /* ======================================================================
   * Einstellungen bereinigen
   * ==================================================================== */

  function sanitizeSchedule(raw, fallback) {
    const r = isObj(raw) ? raw : {};
    const days = Array.isArray(r.days) ? uniq(r.days.filter((d) => intIn(d, 0, 6))).sort((a, b) => a - b) : null;
    const out = {
      days: days || fallback.days.slice(),
      start: intIn(r.start, 0, 1439) ? r.start : fallback.start,
      end: intIn(r.end, 0, 1439) ? r.end : fallback.end,
    };
    if (out.start === out.end) out.end = (out.start + 60) % 1440;
    return out;
  }

  /** Bringt beliebige (auch manipulierte/importierte) Daten in eine gültige, idempotente Form. */
  function withDefaults(raw) {
    const r = isObj(raw) ? raw : {};
    const yt = isObj(r.yt) ? r.yt : {};
    const f = isObj(r.filter) ? r.filter : {};
    const u = isObj(r.unlock) ? r.unlock : {};
    const fe = isObj(r.features) ? r.features : {};
    const p = isObj(r.partner) ? r.partner : {};
    const out = clone(DEFAULTS);

    out.blockedSites = strList(r.blockedSites, normalizeDomain);
    for (const k of YT_KEYS) if (typeof yt[k] === 'boolean') out.yt[k] = yt[k];
    out.filter.mode = f.mode === 'whitelist' ? 'whitelist' : 'blacklist';
    out.filter.blockedChannels = strList(f.blockedChannels, normalizeChannel);
    out.filter.blockedKeywords = strList(f.blockedKeywords, normalizeKeyword);
    out.filter.allowedChannels = strList(f.allowedChannels, normalizeChannel);

    if (intIn(u.perDay, 0, LIMITS.UNLOCK_PER_DAY_MAX)) out.unlock.perDay = u.perDay;
    if (intIn(u.minutes, 1, LIMITS.UNLOCK_MINUTES_MAX)) out.unlock.minutes = u.minutes;
    if (intIn(u.waitSeconds, 0, LIMITS.WAIT_SECONDS_MAX)) out.unlock.waitSeconds = u.waitSeconds;
    if (typeof u.phrase === 'string') {
      const ph = u.phrase.normalize('NFC').replace(/\s+/g, ' ').trim();
      if (ph.length <= LIMITS.PHRASE_MAX && phraseLetters(ph).length >= LIMITS.PHRASE_MIN_LETTERS) out.unlock.phrase = ph;
    }

    for (const k of FEATURE_KEYS) if (typeof fe[k] === 'boolean') out.features[k] = fe[k];
    out.schedule = sanitizeSchedule(r.schedule, DEFAULTS.schedule);
    if (isObj(r.focus) && intIn(r.focus.minutes, LIMITS.FOCUS_MIN, LIMITS.FOCUS_MAX)) out.focus.minutes = r.focus.minutes;
    if (isObj(r.ytLimit) && intIn(r.ytLimit.minutes, 1, LIMITS.YT_LIMIT_MAX)) out.ytLimit.minutes = r.ytLimit.minutes;

    if (p.enabled === true && typeof p.salt === 'string' && B64.test(p.salt) && typeof p.hash === 'string' && B64.test(p.hash) && intIn(p.iter, LIMITS.PBKDF2_MIN, LIMITS.PBKDF2_MAX)) {
      out.partner = { enabled: true, salt: p.salt, hash: p.hash, iter: p.iter };
    }

    out.lockUntil = finitePos(r.lockUntil);
    return out;
  }

  /** Was das YouTube-Skript braucht – und nicht mehr (Datensparsamkeit). */
  const publicView = (s) => ({
    yt: clone(s.yt),
    filter: clone(s.filter),
    ytLimit: s.features.ytLimit ? { minutes: s.ytLimit.minutes } : null,
  });

  /** Was Popup/Einstellungen sehen: alles außer dem Partner-Geheimnis. */
  const uiView = (s) => Object.assign(clone(s), { partner: { enabled: s.partner.enabled } });

  /* ======================================================================
   * Sperrmodus & Partner-Code
   * ==================================================================== */

  const isLocked = (s, now) => !!s && s.lockUntil > now;

  /**
   * Ist eine Sperre aktiv? Normal: solange now < lockUntil.
   * Schutz gegen Uhr-Manipulation: Wurde das Ende schon einmal "gesehen" (maxSeen >= lockUntil),
   * gilt sie als abgelaufen – AUSSER die Uhr steht jetzt deutlich (> 5 min) hinter dem bisher
   * gesehenen Maximum ("Uhr vordrehen → Regeln löschen → Uhr zurück").
   */
  function lockActive(s, now, maxSeen) {
    if (!s || !(now < s.lockUntil)) return false;
    return !(maxSeen >= s.lockUntil) || now < maxSeen - LIMITS.ROLLBACK_TOLERANCE_MS;
  }

  /** Verschärfen erlaubt, Lockern wird auf den Stand des Maßstabs (snap) zurückgesetzt. Monoton. */
  function enforceLock(snap, next) {
    const out = clone(next);
    const cap = (a) => uniq(a).slice(0, LIMITS.MAX_ENTRIES);
    out.lockUntil = Math.max(snap.lockUntil, next.lockUntil);
    out.blockedSites = cap([...snap.blockedSites, ...next.blockedSites]);
    for (const k of YT_KEYS) out.yt[k] = !!(next.yt[k] || snap.yt[k]);
    out.filter.blockedChannels = cap([...snap.filter.blockedChannels, ...next.filter.blockedChannels]);
    out.filter.blockedKeywords = cap([...snap.filter.blockedKeywords, ...next.filter.blockedKeywords]);
    if (snap.filter.mode === 'whitelist') {
      out.filter.mode = 'whitelist';
      const allowed = new Set(snap.filter.allowedChannels);
      out.filter.allowedChannels = next.filter.allowedChannels.filter((c) => allowed.has(c));
    }
    // Zeitfreigaben: weniger/kürzer/länger warten = strenger
    out.unlock.perDay = Math.min(snap.unlock.perDay, next.unlock.perDay);
    out.unlock.minutes = Math.min(snap.unlock.minutes, next.unlock.minutes);
    out.unlock.waitSeconds = Math.max(snap.unlock.waitSeconds, next.unlock.waitSeconds);
    out.unlock.phrase = snap.unlock.phrase;
    // Zeitplan: "immer sperren" (aus) ist am strengsten; ein aktiver Plan darf nicht verändert werden
    if (!snap.features.schedule) out.features.schedule = false;
    else if (next.features.schedule) out.schedule = clone(snap.schedule);
    // YouTube-Limit: an bleibt an, Minuten nur nach unten
    if (snap.features.ytLimit) {
      out.features.ytLimit = true;
      out.ytLimit.minutes = Math.min(snap.ytLimit.minutes, next.features.ytLimit ? next.ytLimit.minutes : snap.ytLimit.minutes);
    }
    // Partner-Code bleibt, wie er ist
    if (snap.partner.enabled) out.partner = clone(snap.partner);
    return out;
  }

  const partnerOn = (s) => !!s && s.partner.enabled;

  /**
   * Zentrale Richtlinie: aus gewünschtem Zustand (next), bisherigem Zustand (prev), Snapshot,
   * Uhr und Autorisierung (gültiger Partner-Code) den tatsächlich gültigen Zustand berechnen.
   * @returns { effective, snapshot, maxSeen }
   */
  function resolveState({ next, prev, snap, now, maxSeen, authorized = false }) {
    const seen = Math.max(Number.isFinite(maxSeen) ? maxSeen : 0, now);
    let base = null;
    if (lockActive(snap, now, seen)) base = snap;
    else if (!authorized && partnerOn(snap)) base = snap; // Partner-Schutz: maßgeblich ist allein der Snapshot
    else if (lockActive(prev, now, seen)) base = prev; // z. B. Snapshot manipulativ gelöscht
    const effective = base ? enforceLock(base, next) : clone(next);
    const timeActive = lockActive(effective, now, seen);
    if (!timeActive) effective.lockUntil = 0;

    let snapshot = null;
    if (timeActive) snapshot = effective;
    else if (partnerOn(effective)) snapshot = Object.assign(clone(effective), { lockUntil: snap ? snap.lockUntil : 0 });
    else if (snap) snapshot = Object.assign(clone(snap), { partner: clone(DEFAULTS.partner) }); // nur Uhr-Schutz
    return { effective, snapshot, maxSeen: seen };
  }

  /* ======================================================================
   * Befehle auf Einstellungen (nur der Hintergrund führt sie aus)
   * ==================================================================== */

  const LISTS = Object.freeze({
    blockedSites: { get: (s) => s.blockedSites, set: (s, v) => (s.blockedSites = v), norm: normalizeDomain },
    blockedChannels: { get: (s) => s.filter.blockedChannels, set: (s, v) => (s.filter.blockedChannels = v), norm: normalizeChannel },
    blockedKeywords: { get: (s) => s.filter.blockedKeywords, set: (s, v) => (s.filter.blockedKeywords = v), norm: normalizeKeyword },
    allowedChannels: { get: (s) => s.filter.allowedChannels, set: (s, v) => (s.filter.allowedChannels = v), norm: normalizeChannel },
  });

  const fail = (error, extra) => Object.assign({ ok: false, error }, extra);

  /**
   * Wendet einen validierten Befehl auf die Einstellungen an. Rein funktional.
   * ctx.authorized: gültiger Partner-Code wurde mitgeschickt (hebt nur den Partner-Schutz auf).
   * @returns {ok:true, state, invalid?} | {ok:false, error:'invalid'|'locked'|'partner'}
   */
  function applyOp(state, op, now, maxSeen, ctx) {
    if (!isObj(op) || typeof op.op !== 'string') return fail('invalid');
    const authorized = !!(ctx && ctx.authorized);
    const s = clone(state);
    const seen = Math.max(now, Number.isFinite(maxSeen) ? maxSeen : now);
    const timeLocked = lockActive(s, now, seen);
    const prot = timeLocked || (s.partner.enabled && !authorized);
    const deny = () => fail(timeLocked ? 'locked' : 'partner');

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
          if (prot && op.list === 'allowedChannels' && s.filter.mode === 'whitelist') return deny();
          const list = def.get(s);
          for (const v of good) if (!list.includes(v) && list.length < LIMITS.MAX_ENTRIES) list.push(v);
        } else {
          if (prot && op.list !== 'allowedChannels') return deny();
          def.set(s, def.get(s).filter((v) => !good.includes(v)));
        }
        return { ok: true, state: s, invalid };
      }

      case 'setYt': {
        if (!YT_KEYS.includes(op.key) || typeof op.value !== 'boolean') return fail('invalid');
        if (prot && s.yt[op.key] && !op.value) return deny();
        s.yt[op.key] = op.value;
        return { ok: true, state: s };
      }

      case 'setMode': {
        if (op.mode !== 'blacklist' && op.mode !== 'whitelist') return fail('invalid');
        if (prot && s.filter.mode === 'whitelist' && op.mode === 'blacklist') return deny();
        s.filter.mode = op.mode;
        return { ok: true, state: s };
      }

      case 'lock': {
        const ms = op.durationMs;
        if (!Number.isFinite(ms) || ms < LIMITS.MIN_LOCK_MS || ms > LIMITS.MAX_LOCK_MS) return fail('invalid');
        // Lief die Uhr kurz zuvor ein paar Minuten vor, ab dem höchsten gesehenen Zeitpunkt zählen.
        const start = seen - now < LIMITS.ROLLBACK_TOLERANCE_MS ? seen : now;
        s.lockUntil = Math.max(s.lockUntil, start + Math.floor(ms));
        return { ok: true, state: s };
      }

      case 'setUnlock': {
        const u = s.unlock;
        const next = Object.assign({}, u);
        if (has(op, 'perDay')) {
          if (!intIn(op.perDay, 0, LIMITS.UNLOCK_PER_DAY_MAX)) return fail('invalid');
          next.perDay = op.perDay;
        }
        if (has(op, 'minutes')) {
          if (!intIn(op.minutes, 1, LIMITS.UNLOCK_MINUTES_MAX)) return fail('invalid');
          next.minutes = op.minutes;
        }
        if (has(op, 'waitSeconds')) {
          if (!intIn(op.waitSeconds, 0, LIMITS.WAIT_SECONDS_MAX)) return fail('invalid');
          next.waitSeconds = op.waitSeconds;
        }
        if (has(op, 'phrase')) {
          if (typeof op.phrase !== 'string' || op.phrase.length > LIMITS.PHRASE_MAX) return fail('invalid');
          const ph = op.phrase.normalize('NFC').replace(/\s+/g, ' ').trim();
          if (phraseLetters(ph).length < LIMITS.PHRASE_MIN_LETTERS) return fail('invalid');
          next.phrase = ph;
        }
        if (prot && (next.perDay > u.perDay || next.minutes > u.minutes || next.waitSeconds < u.waitSeconds || next.phrase !== u.phrase)) return deny();
        s.unlock = next;
        return { ok: true, state: s };
      }

      case 'setFeature': {
        if (!FEATURE_KEYS.includes(op.key) || typeof op.value !== 'boolean') return fail('invalid');
        if (prot && op.key === 'schedule' && op.value && !s.features.schedule) return deny(); // Plan an = lockerer
        if (prot && op.key === 'ytLimit' && !op.value && s.features.ytLimit) return deny();
        s.features[op.key] = op.value;
        return { ok: true, state: s };
      }

      case 'setSchedule': {
        if (!Array.isArray(op.days) || !op.days.every((d) => intIn(d, 0, 6)) || !intIn(op.start, 0, 1439) || !intIn(op.end, 0, 1439) || op.start === op.end) {
          return fail('invalid');
        }
        if (prot && s.features.schedule) return deny();
        s.schedule = sanitizeSchedule({ days: op.days, start: op.start, end: op.end }, s.schedule);
        return { ok: true, state: s };
      }

      case 'setFocus': {
        if (!intIn(op.minutes, LIMITS.FOCUS_MIN, LIMITS.FOCUS_MAX)) return fail('invalid');
        s.focus.minutes = op.minutes;
        return { ok: true, state: s };
      }

      case 'setYtLimit': {
        if (!intIn(op.minutes, 1, LIMITS.YT_LIMIT_MAX)) return fail('invalid');
        if (prot && s.features.ytLimit && op.minutes > s.ytLimit.minutes) return deny();
        s.ytLimit.minutes = op.minutes;
        return { ok: true, state: s };
      }

      case 'partnerStore': {
        // Nur intern (der Hintergrund berechnet salt/hash aus dem eingegebenen Code).
        if (typeof op.salt !== 'string' || !B64.test(op.salt) || typeof op.hash !== 'string' || !B64.test(op.hash) || !intIn(op.iter, LIMITS.PBKDF2_MIN, LIMITS.PBKDF2_MAX)) {
          return fail('invalid');
        }
        if (s.partner.enabled && !authorized) return fail('partner');
        s.partner = { enabled: true, salt: op.salt, hash: op.hash, iter: op.iter };
        return { ok: true, state: s };
      }

      case 'partnerDisable': {
        if (!s.partner.enabled) return { ok: true, state: s };
        if (timeLocked) return fail('locked');
        if (!authorized) return fail('partner');
        s.partner = clone(DEFAULTS.partner);
        return { ok: true, state: s };
      }

      case 'import': {
        if (!isObj(op.settings)) return fail('invalid');
        const incoming = withDefaults(op.settings);
        incoming.lockUntil = s.lockUntil; // Import ändert nie die Sperre …
        incoming.partner = clone(s.partner); // … und nie den Partner-Code
        const out = prot ? enforceLock(s, incoming) : incoming;
        return { ok: true, state: out, partial: prot && !sameJSON(out, incoming) };
      }

      default:
        return fail('invalid');
    }
  }

  /* ======================================================================
   * Zeitplan
   * ==================================================================== */

  function scheduleActive(sch, ts) {
    const d = new Date(ts);
    const m = d.getHours() * 60 + d.getMinutes();
    const day = d.getDay();
    if (sch.start < sch.end) return sch.days.includes(day) && m >= sch.start && m < sch.end;
    // über Mitternacht (z. B. 22:00–06:00)
    return (sch.days.includes(day) && m >= sch.start) || (sch.days.includes((day + 6) % 7) && m < sch.end);
  }

  /** Nächster Zeitpunkt, an dem sich "aktiv" ändert (oder 0, wenn nie innerhalb von 8 Tagen). */
  function nextScheduleChange(sch, ts) {
    const cur = scheduleActive(sch, ts);
    const d = new Date(ts);
    const cands = [];
    for (let k = 0; k <= 8; k++) {
      for (const minute of [sch.start, sch.end]) {
        const t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + k, 0, minute).getTime();
        if (t > ts) cands.push(t);
      }
    }
    cands.sort((a, b) => a - b);
    for (const t of cands) if (scheduleActive(sch, t) !== cur) return t;
    return 0;
  }

  /* ======================================================================
   * Laufzeitzustand (Freigaben, Fokus, YouTube-Zeit, Statistik)
   * ==================================================================== */

  function sanitizeState(raw) {
    const r = isObj(raw) ? raw : {};
    const out = clone(STATE_DEFAULTS);
    if (typeof r.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.day)) out.day = r.day;
    const domainMap = (m, valid) => {
      const o = {};
      if (!isObj(m)) return o;
      let n = 0;
      for (const k of Object.keys(m)) {
        if (n >= LIMITS.MAX_ENTRIES) break;
        if (normalizeDomain(k) !== k || !valid(m[k])) continue;
        o[k] = m[k];
        n++;
      }
      return o;
    };
    out.used = domainMap(r.used, (v) => intIn(v, 0, 1000));
    out.unlocks = domainMap(r.unlocks, (v) => Number.isFinite(v) && v > 0);
    out.pending = domainMap(r.pending, (v) => Number.isFinite(v) && v > 0);
    out.focusUntil = finitePos(r.focusUntil);
    out.ytMs = Number.isFinite(r.ytMs) && r.ytMs > 0 ? Math.min(Math.floor(r.ytMs), 864e5) : 0;
    if (isObj(r.stats)) {
      const days = Object.keys(r.stats).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort().slice(-LIMITS.STATS_DAYS);
      for (const k of days) {
        const v = isObj(r.stats[k]) ? r.stats[k] : {};
        const n = (x) => (intIn(x, 0, 1e6) ? x : 0);
        out.stats[k] = { unlocks: n(v.unlocks), focus: n(v.focus), focusMin: n(v.focusMin), ytMin: n(v.ytMin), blocked: n(v.blocked) };
      }
    }
    return out;
  }

  /** Ist eine Freigabe gültig? Schutz gegen Uhr-Rückstellen: nie mehr Restzeit als ihre Dauer. */
  function unlockValid(until, now, seen, minutes) {
    if (!(now < until)) return false;
    if (until - now > minutes * MIN + MIN) return false;
    return !(now < seen - LIMITS.ROLLBACK_TOLERANCE_MS);
  }

  /** Tageswechsel, abgelaufene Freigaben/Anfragen, beendeter Fokus, Statistik-Aufräumen. */
  function prepareState(settings, rawState, now, maxSeen) {
    const st = sanitizeState(rawState);
    const seen = Math.max(now, Number.isFinite(maxSeen) ? maxSeen : 0);
    const today = dayKey(seen); // bei zurückgestellter Uhr zählt der späteste gesehene Tag
    if (st.day !== today) {
      st.day = today;
      st.used = {};
      st.ytMs = 0;
      st.pending = {};
    }
    const listed = new Set(settings.blockedSites);
    for (const d of Object.keys(st.unlocks)) {
      if (!listed.has(d) || !unlockValid(st.unlocks[d], now, seen, settings.unlock.minutes)) delete st.unlocks[d];
    }
    const maxWait = settings.unlock.waitSeconds * 1000;
    for (const d of Object.keys(st.pending)) {
      const t = st.pending[d];
      if (!listed.has(d) || t - now > maxWait + 1000 || now > t + LIMITS.PENDING_TTL_MS) delete st.pending[d];
    }
    if (st.focusUntil <= now) st.focusUntil = 0;
    else st.focusUntil = Math.min(st.focusUntil, now + LIMITS.FOCUS_MAX * MIN);
    if (!settings.features.stats) st.stats = {};
    else {
      const keep = Object.keys(st.stats).sort().slice(-LIMITS.STATS_DAYS);
      st.stats = Object.fromEntries(keep.map((k) => [k, st.stats[k]]));
    }
    return st;
  }

  function bump(settings, st, field, by) {
    if (!settings.features.stats) return;
    const day = st.day;
    const cur = st.stats[day] || { unlocks: 0, focus: 0, focusMin: 0, ytMin: 0, blocked: 0 };
    cur[field] = Math.min(cur[field] + by, 1e6);
    st.stats[day] = cur;
  }

  /** Was ist JETZT gesperrt? Rein aus Einstellungen + vorbereitetem Zustand. */
  function blockingNow(settings, st, now) {
    const focus = st.focusUntil > now;
    const listActive = focus || !settings.features.schedule || scheduleActive(settings.schedule, now);
    const unlocked = focus || !listActive ? [] : settings.blockedSites.filter((d) => has(st.unlocks, d));
    const blocked = listActive ? settings.blockedSites.filter((d) => !unlocked.includes(d)) : [];
    const events = [];
    if (focus) events.push(st.focusUntil);
    for (const d of unlocked) events.push(st.unlocks[d]);
    for (const d of Object.keys(st.pending)) events.push(st.pending[d]);
    if (settings.features.schedule) {
      const t = nextScheduleChange(settings.schedule, now);
      if (t) events.push(t);
    }
    if (settings.lockUntil > now) events.push(settings.lockUntil);
    const nextEvent = events.filter((t) => t > now).reduce((a, b) => Math.min(a, b), Infinity);
    return { focus, listActive, blocked, unlocked, nextEvent: Number.isFinite(nextEvent) ? nextEvent : 0 };
  }

  /**
   * Befehle auf den Laufzeitzustand. Rein funktional.
   * @returns {ok:true, state, info?} | {ok:false, error}
   */
  function applyStateOp(settings, rawState, op, now, maxSeen) {
    if (!isObj(op) || typeof op.op !== 'string') return fail('invalid');
    const st = prepareState(settings, rawState, now, maxSeen);
    const seen = Math.max(now, Number.isFinite(maxSeen) ? maxSeen : 0);
    const domainOp = () => {
      const d = normalizeDomain(op.domain);
      return d && settings.blockedSites.includes(d) ? d : '';
    };
    const left = (d) => Math.max(0, settings.unlock.perDay - (st.used[d] || 0));

    switch (op.op) {
      case 'unlockRequest': {
        const d = domainOp();
        if (!d) return fail('invalid');
        const b = blockingNow(settings, st, now);
        if (b.focus) return fail('focus');
        if (!b.blocked.includes(d)) return fail('notBlocked');
        if (left(d) <= 0) return fail('quota');
        if (!has(st.pending, d)) st.pending[d] = now + settings.unlock.waitSeconds * 1000;
        return { ok: true, state: st, info: { readyAt: st.pending[d], left: left(d) } };
      }
      case 'unlockConfirm': {
        const d = domainOp();
        if (!d || typeof op.phrase !== 'string') return fail('invalid');
        const b = blockingNow(settings, st, now);
        if (b.focus) return fail('focus');
        if (!b.blocked.includes(d)) return fail('notBlocked');
        if (!has(st.pending, d)) return fail('noRequest');
        if (now < st.pending[d]) return fail('wait', { readyAt: st.pending[d] });
        if (now < seen - LIMITS.ROLLBACK_TOLERANCE_MS) return fail('clock');
        if (left(d) <= 0) return fail('quota');
        if (!phraseMatches(op.phrase, settings.unlock.phrase)) return fail('phrase');
        delete st.pending[d];
        st.used[d] = (st.used[d] || 0) + 1;
        st.unlocks[d] = now + settings.unlock.minutes * MIN;
        bump(settings, st, 'unlocks', 1);
        return { ok: true, state: st, info: { until: st.unlocks[d], left: left(d) } };
      }
      case 'unlockCancel': {
        const d = normalizeDomain(op.domain);
        if (!d) return fail('invalid');
        delete st.pending[d];
        return { ok: true, state: st };
      }
      case 'unlockEnd': {
        const d = normalizeDomain(op.domain);
        if (!d) return fail('invalid');
        delete st.unlocks[d];
        delete st.pending[d];
        return { ok: true, state: st };
      }
      case 'focusStart': {
        if (!settings.features.focus) return fail('disabled');
        const m = has(op, 'minutes') ? op.minutes : settings.focus.minutes;
        if (!intIn(m, LIMITS.FOCUS_MIN, LIMITS.FOCUS_MAX)) return fail('invalid');
        st.focusUntil = Math.min(Math.max(st.focusUntil, now + m * MIN), now + LIMITS.FOCUS_MAX * MIN);
        st.unlocks = {}; // Fokus beendet laufende Freigaben
        st.pending = {};
        bump(settings, st, 'focus', 1);
        bump(settings, st, 'focusMin', m);
        return { ok: true, state: st, info: { focusUntil: st.focusUntil } };
      }
      case 'ytTick': {
        if (!Number.isFinite(op.ms) || op.ms <= 0) return fail('invalid');
        const ms = Math.min(Math.floor(op.ms), LIMITS.YT_TICK_MAX_MS);
        if (settings.features.ytLimit) st.ytMs = Math.min(st.ytMs + ms, 864e5);
        const before = Math.floor((st.ytMs - ms) / MIN);
        if (Math.floor(st.ytMs / MIN) > before) bump(settings, st, 'ytMin', Math.floor(st.ytMs / MIN) - before);
        return { ok: true, state: st, info: ytStatus(settings, st) };
      }
      case 'blockHit': {
        if (!domainOp()) return fail('invalid');
        bump(settings, st, 'blocked', 1);
        return { ok: true, state: st };
      }
      case 'statsClear': {
        st.stats = {};
        return { ok: true, state: st };
      }
      default:
        return fail('invalid');
    }
  }

  function ytStatus(settings, st) {
    if (!settings.features.ytLimit) return { limited: false };
    const remainingMs = Math.max(0, settings.ytLimit.minutes * MIN - st.ytMs);
    return { limited: true, remainingMs, exhausted: remainingMs <= 0 };
  }

  /**
   * Externe (nicht vom Hintergrund stammende) Änderung am Laufzeitzustand nur übernehmen,
   * soweit sie nicht lockert: Zähler nur hoch, Freigaben nur weg/kürzer, Fokus nur länger.
   */
  function mergeStateStrict(trusted, incoming) {
    const t = sanitizeState(trusted);
    const i = sanitizeState(incoming);
    const out = clone(t);
    if (i.day === t.day) {
      for (const d of Object.keys(i.used)) out.used[d] = Math.max(t.used[d] || 0, i.used[d]);
      out.ytMs = Math.max(t.ytMs, i.ytMs);
    }
    out.unlocks = {};
    for (const d of Object.keys(t.unlocks)) if (has(i.unlocks, d)) out.unlocks[d] = Math.min(t.unlocks[d], i.unlocks[d]);
    out.pending = {};
    for (const d of Object.keys(t.pending)) if (has(i.pending, d)) out.pending[d] = Math.max(t.pending[d], i.pending[d]);
    out.focusUntil = Math.max(t.focusUntil, i.focusUntil);
    out.stats = t.stats;
    return out;
  }

  /* ======================================================================
   * Sperrregeln für declarativeNetRequest
   * ==================================================================== */

  const RULES = Object.freeze({ BLOCK: 1, FRAMES: 2, INITIATOR: 3, REDIRECT_BASE: 1000 });

  /**
   * @param blocked  gerade gesperrte Domains
   * @param redirect Domains, für die eine eigene Sperrseite erlaubt ist (Host-Recht erteilt)
   */
  function buildRules(blocked, redirect) {
    const red = blocked.filter((d) => redirect.includes(d));
    const plain = blocked.filter((d) => !redirect.includes(d));
    const rules = [];
    if (plain.length) {
      rules.push({ id: RULES.BLOCK, priority: 1, action: { type: 'block' }, condition: { requestDomains: plain, resourceTypes: ['main_frame', 'sub_frame'] } });
    }
    if (red.length) {
      rules.push({ id: RULES.FRAMES, priority: 1, action: { type: 'block' }, condition: { requestDomains: red, resourceTypes: ['sub_frame'] } });
    }
    if (blocked.length) {
      // Offene Tabs einer (wieder) gesperrten Seite laden nichts mehr nach – andere Seiten bleiben unberührt.
      rules.push({ id: RULES.INITIATOR, priority: 1, action: { type: 'block' }, condition: { initiatorDomains: blocked, excludedResourceTypes: ['main_frame'] } });
    }
    red.forEach((d, i) => {
      rules.push({
        id: RULES.REDIRECT_BASE + i,
        priority: 2,
        action: { type: 'redirect', redirect: { extensionPath: '/blocked.html?d=' + encodeURIComponent(d) } },
        condition: { requestDomains: [d], resourceTypes: ['main_frame'] },
      });
    });
    return rules;
  }

  /* ======================================================================
   * YouTube-Filter
   * ==================================================================== */

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
    FEATURE_KEYS,
    LIMITS,
    DEFAULTS,
    STATE_DEFAULTS,
    RULES,
    clone,
    uniq,
    sameJSON,
    stableStringify,
    dayKey,
    normalizeDomain,
    normalizeChannel,
    normalizeKeyword,
    channelFromHref,
    phraseLetters,
    phraseMatches,
    matchEntry,
    withDefaults,
    publicView,
    uiView,
    isLocked,
    enforceLock,
    lockActive,
    resolveState,
    applyOp,
    scheduleActive,
    nextScheduleChange,
    sanitizeState,
    unlockValid,
    prepareState,
    blockingNow,
    applyStateOp,
    ytStatus,
    mergeStateStrict,
    buildRules,
    hasFilter,
    verdict,
  });

  root.FG = FG;
  if (typeof module !== 'undefined' && module.exports) module.exports = FG;
})(typeof globalThis !== 'undefined' ? globalThis : this);
