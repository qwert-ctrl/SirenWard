/*
 * Sirenward – Hintergrund ("imperative shell").
 *
 * Einziger Schreiber von Einstellungen und Laufzeitzustand. Alle Entscheidungen trifft core.js;
 * hier passiert nur Ein-/Ausgabe:
 *  - Befehle der eigenen Seiten strikt nacheinander ausführen (keine verlorenen Änderungen)
 *  - Partner-Code prüfen (PBKDF2, Ratenbegrenzung, Vergleich in konstanter Zeit)
 *  - Sperrregeln (declarativeNetRequest) setzen – nur bei Änderungen
 *  - einen einzigen Wecker auf das nächste Ereignis stellen (Freigabe-Ende, Zeitplan, Fokus, Sperre)
 *  - Manipulationen an Einstellungen und Zustand reparieren, Uhr-Rücksprünge erkennen
 *  - optionale Host-Rechte (eigene Sperrseite) auf die gesperrten Domains beschränken
 * Kein Netzwerkcode, keine Telemetrie, kein Verlauf.
 */
// ES-Modul: statischer Import statt importScripts() – Letzteres ist unter Trusted Types gesperrt.
import './core.js';
const FG = globalThis.FG;

const TICK = 'fg-tick';
const EXT_BASE = chrome.runtime.getURL(''); // "chrome-extension://<id>/" bzw. "moz-extension://<uuid>/"
const YT_ORIGIN = 'https://www.youtube.com/';
const PBKDF2_ITER = 600000;
const MIN = 60 * 1000;

/* ---------- Härtung: Speicher nur für Erweiterungsseiten/Service Worker ---------- */
// Inhaltsskripte (YouTube) erhalten keinen Speicherzugriff, sondern nur eine Leseansicht per Nachricht.
// Firefox kennt setAccessLevel nicht – dort greift trotzdem: das YouTube-Skript nutzt den Speicher nie.
try {
  const p = chrome.storage.local.setAccessLevel && chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  if (p && p.catch) p.catch(() => {});
} catch {
  /* nicht unterstützt */
}

/* ---------- Serielle Ausführung ---------- */
let chain = Promise.resolve();
function serial(fn) {
  const run = chain.then(fn);
  chain = run.catch((e) => console.error('[Sirenward]', e));
  return run;
}

/* ---------- Lesen ---------- */
async function readStored() {
  const raw = await chrome.storage.local.get(['settings', '_lockSnapshot', '_clock', '_state', '_pf']);
  return {
    rawSettings: raw.settings,
    settings: FG.withDefaults(raw.settings),
    rawSnap: raw._lockSnapshot,
    snap: raw._lockSnapshot ? FG.withDefaults(raw._lockSnapshot) : null,
    maxSeen: Number.isFinite(raw._clock) ? raw._clock : 0,
    rawState: raw._state,
    state: FG.sanitizeState(raw._state),
    pf: raw._pf && typeof raw._pf === 'object' ? raw._pf : { fails: 0, until: 0 },
  };
}

/* ---------- Schreiben + Nebenwirkungen ---------- */
let lastBroadcast = null;
let lastBlocked = null; // zuletzt gesperrte Domains (für das Neuladen wieder gesperrter Tabs)
const ownState = new Set(); // eigene _state-Schreibvorgänge (Echo von onChanged erkennen)
const ownSettings = new Set(); // eigene settings-Schreibvorgänge – sonst hielte das Echo eine
// autorisierte Lockerung (Partner-Code) für eine Manipulation und drehte sie zurück
function remember(set, value) {
  set.add(FG.stableStringify(value));
  if (set.size > 50) set.delete(set.values().next().value);
}

async function commit({ next, prev, stored, prevKnown = true, authorized = false, nextState = null }) {
  const now = Date.now();
  const { effective, snapshot, maxSeen } = FG.resolveState({ next, prev, snap: stored.snap, now, maxSeen: stored.maxSeen, authorized });
  const state = FG.prepareState(effective, nextState || stored.state, now, maxSeen);

  const writes = {};
  if (!FG.sameJSON(effective, stored.rawSettings)) {
    writes.settings = effective;
    remember(ownSettings, effective);
  }
  if (snapshot && !FG.sameJSON(snapshot, stored.rawSnap)) writes._lockSnapshot = snapshot;
  const timeSensitive = snapshot || Object.keys(state.unlocks).length || state.focusUntil;
  if (timeSensitive && maxSeen > stored.maxSeen + MIN) writes._clock = maxSeen; // höchstens 1× pro Minute
  if (!FG.sameJSON(state, stored.rawState)) {
    writes._state = state;
    remember(ownState, state);
  }
  if (Object.keys(writes).length) await chrome.storage.local.set(writes);

  const blocking = FG.blockingNow(effective, state, now);
  await syncRules(effective, blocking);
  await broadcast(effective, prev, prevKnown);
  await scheduleTick(blocking, snapshot, state, effective, now);
  prunePermissions(effective).catch(() => {});
  return { effective, state, blocking };
}

/* ----- Sperrregeln ----- */
async function grantedDomains(domains) {
  if (!domains.length || !chrome.permissions) return [];
  const { origins = [] } = await chrome.permissions.getAll();
  if (origins.includes('<all_urls>') || origins.includes('*://*/*')) return domains.slice();
  const set = new Set(origins);
  return domains.filter((d) => set.has(`*://*.${d}/*`));
}

async function syncRules(settings, blocking) {
  const redirect = settings.features.blockPage ? await grantedDomains(blocking.blocked) : [];
  const want = FG.buildRules(blocking.blocked, redirect);
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  if (!FG.sameJSON(existing, want)) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map((r) => r.id), addRules: want });
  }
  // Wieder gesperrt (Freigabe/Plan vorbei)? Offene Tabs neu laden – nur wo ein Host-Recht besteht.
  if (lastBlocked) {
    const newly = blocking.blocked.filter((d) => !lastBlocked.has(d));
    for (const d of await grantedDomains(newly)) {
      try {
        const tabs = await chrome.tabs.query({ url: [`*://*.${d}/*`] });
        for (const t of tabs) if (t.id != null) chrome.tabs.reload(t.id).catch(() => {});
      } catch {
        /* ohne Recht keine Tabs – dann stoppt die Initiator-Regel die Seite */
      }
    }
  }
  lastBlocked = new Set(blocking.blocked);
}

/** Least Privilege: Host-Rechte nur für aktuell gelistete Domains und nur bei eigener Sperrseite. */
async function prunePermissions(settings) {
  if (!chrome.permissions) return;
  const { origins = [] } = await chrome.permissions.getAll();
  const keep = settings.features.blockPage ? new Set(settings.blockedSites.map((d) => `*://*.${d}/*`)) : new Set();
  const drop = origins.filter((o) => /^\*:\/\/\*\.[^/]+\/\*$/.test(o) && !keep.has(o));
  if (drop.length) await chrome.permissions.remove({ origins: drop });
}

/** Neue Leseansicht an offene YouTube-Tabs (nur dort lauscht das Inhaltsskript). */
async function broadcast(settings, prev, prevKnown) {
  const key = FG.stableStringify(FG.publicView(settings));
  // Ohne bekannten Vorzustand (Aufwachen/Wecker) wird nichts als "gesendet" vermerkt –
  // sonst ginge die auslösende Änderung verloren.
  if (lastBroadcast === null && !prevKnown) return;
  const before = lastBroadcast !== null ? lastBroadcast : FG.stableStringify(FG.publicView(prev));
  lastBroadcast = key;
  if (key === before) return;
  await sendToTabs({ type: 'fg:settings', settings: FG.publicView(settings) });
}

async function sendToTabs(msg) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({}); // ohne "tabs"-Recht: nur IDs, keine Adressen/Titel
  } catch {
    return;
  }
  await Promise.all(tabs.map((t) => (t.id == null ? null : chrome.tabs.sendMessage(t.id, msg).catch(() => {}))));
}

/* ----- Ein Wecker für alles ----- */
let shortTimer = 0;
async function scheduleTick(blocking, snapshot, state, settings, now) {
  let period = Infinity;
  if (FG.isLocked(settings, now) || Object.keys(state.unlocks).length || state.focusUntil) period = MIN;
  else if (snapshot && now < snapshot.lockUntil + 30 * 24 * 60 * MIN) period = 5 * MIN; // Uhr-Rücksprung-Wache
  const when = Math.min(blocking.nextEvent || Infinity, now + period);
  const existing = await chrome.alarms.get(TICK);
  if (!Number.isFinite(when)) {
    if (existing) await chrome.alarms.clear(TICK);
  } else if (!existing || Math.abs(existing.scheduledTime - when) > 1000) {
    await chrome.alarms.create(TICK, { when: Math.max(when, now + 1000) });
  }
  // Wecker sind auf ~30 s genau; kurz bevorstehende Ereignisse zusätzlich per Timer (Service Worker lebt noch)
  clearTimeout(shortTimer);
  if (Number.isFinite(when) && when - now < 30 * 1000) shortTimer = setTimeout(() => serial(() => reconcile(null)), Math.max(0, when - now) + 50);
}

/* ---------- Abgleich (Start, Wecker, Speicheränderung von außen) ---------- */
async function reconcile(changes) {
  const stored = await readStored();
  const prevKnown = !!(changes && changes.settings);
  let prev = prevKnown ? FG.withDefaults(changes.settings.oldValue) : stored.settings;
  if (prevKnown && ownSettings.delete(FG.stableStringify(changes.settings.newValue))) prev = stored.settings; // eigenes Echo
  // Snapshot von außen gelöscht? Dann gilt der alte weiter.
  if (changes && changes._lockSnapshot && changes._lockSnapshot.oldValue && !stored.rawSnap) {
    stored.snap = FG.withDefaults(changes._lockSnapshot.oldValue);
  }
  // Zustand von außen verändert? Nur übernehmen, was nicht lockert.
  let nextState = null;
  if (changes && changes._state) {
    const key = FG.stableStringify(changes._state.newValue);
    if (ownState.has(key)) ownState.delete(key);
    else nextState = FG.mergeStateStrict(changes._state.oldValue, changes._state.newValue);
  }
  return commit({ next: stored.settings, prev, stored, prevKnown, nextState });
}

/* ---------- Partner-Code ---------- */
const enc = new TextEncoder();
const toB64 = (u8) => btoa(String.fromCharCode(...u8));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(code, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(code.normalize('NFC')), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256));
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a[i] ^ b[i];
  return x === 0;
}

/** @returns {ok:true} | {ok:false, error:'badcode'|'cooldown', retryAt?} */
async function verifyPartner(stored, code) {
  const p = stored.settings.partner;
  if (!p.enabled) return { ok: true };
  const now = Date.now();
  if (stored.pf.until > now) return { ok: false, error: 'cooldown', retryAt: stored.pf.until };
  const valid = typeof code === 'string' && code.length <= FG.LIMITS.CODE_MAX && constantTimeEqual(await derive(code, fromB64(p.salt), p.iter), fromB64(p.hash));
  if (valid) {
    if (stored.pf.fails) await chrome.storage.local.set({ _pf: { fails: 0, until: 0 } });
    return { ok: true };
  }
  const fails = (stored.pf.fails || 0) + 1;
  // ab dem 5. Fehlversuch Wartezeit: 5, 10, 20, 40, 60 min …
  const until = fails >= 5 ? now + Math.min(60, 5 * 2 ** (fails - 5)) * MIN : 0;
  await chrome.storage.local.set({ _pf: { fails, until } });
  return { ok: false, error: until ? 'cooldown' : 'badcode', retryAt: until || undefined };
}

/* ---------- Befehle ---------- */
const SETTINGS_OPS = new Set(['add', 'remove', 'setYt', 'setMode', 'lock', 'import', 'setUnlock', 'setFeature', 'setSchedule', 'setFocus', 'setYtLimit', 'partnerSet', 'partnerDisable']);
const STATE_OPS = new Set(['unlockRequest', 'unlockConfirm', 'unlockCancel', 'unlockEnd', 'focusStart', 'statsClear', 'blockHit']);

function uiState(settings, state, now, stored) {
  const blocking = FG.blockingNow(settings, state, now);
  return {
    now,
    used: state.used,
    unlocks: state.unlocks,
    pending: state.pending,
    focusUntil: state.focusUntil,
    stats: settings.features.stats ? state.stats : {},
    yt: FG.ytStatus(settings, state),
    blocking: { blocked: blocking.blocked, unlocked: blocking.unlocked, focus: blocking.focus, listActive: blocking.listActive },
    partnerRetryAt: stored.pf.until > now ? stored.pf.until : 0,
  };
}

async function snapshotForUi() {
  const stored = await readStored();
  const now = Date.now();
  const state = FG.prepareState(stored.settings, stored.state, now, stored.maxSeen);
  return { settings: FG.uiView(stored.settings), state: uiState(stored.settings, state, now, stored) };
}

async function execute(op, code) {
  if (!op || typeof op !== 'object' || typeof op.op !== 'string') return { ok: false, error: 'invalid' };
  const stored = await readStored();
  const now = Date.now();

  if (STATE_OPS.has(op.op)) {
    const res = FG.applyStateOp(stored.settings, stored.state, op, now, stored.maxSeen);
    if (!res.ok) return Object.assign({}, res, await snapshotForUi());
    await commit({ next: stored.settings, prev: stored.settings, stored, nextState: res.state });
    return Object.assign({ ok: true, info: res.info || null }, await snapshotForUi());
  }
  if (!SETTINGS_OPS.has(op.op)) return { ok: false, error: 'invalid' };

  // Partner-Code nur prüfen, wenn mitgeschickt (teuer, ratenbegrenzt)
  let authorized = false;
  if (code !== undefined && stored.settings.partner.enabled) {
    const v = await verifyPartner(stored, code);
    if (!v.ok) return Object.assign({ ok: false, error: v.error, retryAt: v.retryAt }, await snapshotForUi());
    authorized = true;
  }

  let core = op;
  if (op.op === 'partnerSet') {
    if (typeof op.code !== 'string' || op.code.length < FG.LIMITS.CODE_MIN || op.code.length > FG.LIMITS.CODE_MAX) return { ok: false, error: 'invalid' };
    if (stored.settings.partner.enabled && !authorized) return Object.assign({ ok: false, error: 'partner' }, await snapshotForUi());
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hash = await derive(op.code, salt, PBKDF2_ITER);
    core = { op: 'partnerStore', salt: toB64(salt), hash: toB64(hash), iter: PBKDF2_ITER };
  }

  const res = FG.applyOp(stored.settings, core, now, stored.maxSeen, { authorized });
  if (!res.ok) return Object.assign({ ok: false, error: res.error, invalid: res.invalid || [] }, await snapshotForUi());
  const { effective } = await commit({ next: res.state, prev: stored.settings, stored, authorized });
  const partial = !!res.partial || !FG.sameJSON(effective, Object.assign({}, res.state, { lockUntil: effective.lockUntil }));
  return Object.assign({ ok: true, partial, invalid: res.invalid || [] }, await snapshotForUi());
}

/* ----- YouTube-Wiedergabezeit (vom Inhaltsskript; nicht vertrauenswürdig → streng begrenzt) ----- */
const lastTick = new Map(); // Tab → Zeitpunkt des letzten Ticks
async function ytMessage(msg, tabId) {
  const stored = await readStored();
  const now = Date.now();
  if (msg.kind === 'tick' && Number.isFinite(msg.ms) && msg.ms > 0) {
    const since = lastTick.has(tabId) ? now - lastTick.get(tabId) + 2000 : FG.LIMITS.YT_TICK_MAX_MS;
    lastTick.set(tabId, now);
    const ms = Math.min(msg.ms, since, FG.LIMITS.YT_TICK_MAX_MS);
    if (lastTick.size > 200) lastTick.delete(lastTick.keys().next().value);
    const res = FG.applyStateOp(stored.settings, stored.state, { op: 'ytTick', ms }, now, stored.maxSeen);
    if (res.ok && (stored.settings.features.ytLimit || stored.settings.features.stats)) {
      await commit({ next: stored.settings, prev: stored.settings, stored, nextState: res.state });
    }
    return res.ok ? res.info : { limited: false };
  }
  const st = FG.prepareState(stored.settings, stored.state, now, stored.maxSeen);
  return FG.ytStatus(stored.settings, st);
}

/* ---------- Nachrichten ---------- */
// Vertrauenswürdig = eigene Erweiterungsseite (Popup/Einstellungen/Sperrseite). Inhaltsskripte laufen
// in fremden Webseiten-Prozessen: sie dürfen nur lesen und Wiedergabezeit melden.
function isTrustedSender(sender) {
  return !!sender && sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(EXT_BASE);
}
function isYouTubeContent(sender) {
  return !!sender && sender.id === chrome.runtime.id && !!sender.tab && typeof sender.url === 'string' && sender.url.startsWith(YT_ORIGIN);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id || !msg || typeof msg !== 'object') return false;
  const trusted = isTrustedSender(sender);
  const reply = (p) => {
    p.then(sendResponse).catch(() => sendResponse({ ok: false, error: 'internal' }));
    return true;
  };
  if (msg.type === 'fg:get') {
    if (trusted) return reply(serial(snapshotForUi).then((v) => Object.assign({ ok: true }, v)));
    return reply(
      serial(async () => {
        const stored = await readStored();
        const st = FG.prepareState(stored.settings, stored.state, Date.now(), stored.maxSeen);
        return { ok: true, settings: FG.publicView(stored.settings), yt: FG.ytStatus(stored.settings, st) };
      })
    );
  }
  if (msg.type === 'fg:op') {
    if (!trusted) {
      sendResponse({ ok: false, error: 'forbidden' });
      return false;
    }
    return reply(serial(() => execute(msg.op, msg.code)));
  }
  if (msg.type === 'fg:yt') {
    if (!isYouTubeContent(sender)) {
      sendResponse({ ok: false, error: 'forbidden' });
      return false;
    }
    return reply(serial(() => ytMessage(msg, sender.tab.id)));
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!('settings' in changes || '_lockSnapshot' in changes || '_clock' in changes || '_state' in changes)) return;
  serial(() => reconcile(changes));
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === TICK) serial(() => reconcile(null));
});

if (chrome.permissions && chrome.permissions.onAdded) {
  chrome.permissions.onAdded.addListener(() => serial(() => reconcile(null)));
  chrome.permissions.onRemoved.addListener(() => serial(() => reconcile(null)));
}

async function init() {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: FG.withDefaults(null) });
  await chrome.alarms.clear('fg-lock-watch'); // Wecker aus Version 1.1
  return reconcile(null);
}
chrome.runtime.onInstalled.addListener(() => serial(init));
chrome.runtime.onStartup.addListener(() => serial(init));
serial(() => reconcile(null)); // bei jedem Aufwachen: Uhr/Sperre/Freigaben prüfen
