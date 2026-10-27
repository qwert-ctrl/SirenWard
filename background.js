/*
 * FocusGuard – Hintergrund ("imperative shell").
 *
 * Einziger Schreiber der Einstellungen. Alle Änderungen kommen als Befehle von den eigenen
 * Erweiterungsseiten, laufen strikt nacheinander (keine verlorenen Änderungen), werden in core.js
 * validiert und gegen den Sperrmodus geprüft. Außerdem:
 *  - setzt die Website-Sperre per declarativeNetRequest (Browser blockiert selbst, kein Mitlesen)
 *  - gibt dem YouTube-Skript nur die Daten, die es braucht (lesend, per Nachricht)
 *  - sperrt den Speicher für Inhaltsskripte (nur vertrauenswürdige Kontexte)
 *  - repariert Manipulationen am Speicher und erkennt Uhr-Rücksprünge
 * Kein Netzwerkcode, keine Telemetrie, kein Verlauf.
 */
// ES-Modul: statischer Import statt importScripts() – Letzteres ist unter Trusted Types gesperrt.
import './core.js';
const FG = globalThis.FG;

const RULE_ID = 1;
const ALARM = 'fg-lock-watch';
const EXT_BASE = chrome.runtime.getURL(''); // "chrome-extension://<id>/" bzw. "moz-extension://<uuid>/"

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
  chain = run.catch((e) => console.error('[FocusGuard]', e));
  return run;
}

/* ---------- Lesen ---------- */
async function readStored() {
  const raw = await chrome.storage.local.get(['settings', '_lockSnapshot', '_clock']);
  return {
    rawSettings: raw.settings,
    settings: FG.withDefaults(raw.settings),
    rawSnap: raw._lockSnapshot,
    snap: raw._lockSnapshot ? FG.withDefaults(raw._lockSnapshot) : null,
    maxSeen: Number.isFinite(raw._clock) ? raw._clock : 0,
  };
}

/* ---------- Schreiben + Nebenwirkungen ---------- */
let lastBroadcast = null;

async function commit({ next, prev, stored, prevKnown = true }) {
  const now = Date.now();
  const { effective, snapshot, maxSeen } = FG.resolveState({ next, prev, snap: stored.snap, now, maxSeen: stored.maxSeen });

  const writes = {};
  if (!FG.sameJSON(effective, stored.rawSettings)) writes.settings = effective;
  if (snapshot && !FG.sameJSON(snapshot, stored.rawSnap)) writes._lockSnapshot = snapshot;
  if (snapshot && maxSeen > stored.maxSeen + 60 * 1000) writes._clock = maxSeen; // höchstens 1× pro Minute
  if (Object.keys(writes).length) await chrome.storage.local.set(writes);

  await syncRules(effective.blockedSites);
  await broadcast(effective, prev, prevKnown);
  await scheduleWatch(snapshot, effective, now);
  return effective;
}

async function syncRules(sites) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const current = existing.length === 1 && existing[0].id === RULE_ID ? existing[0].condition.requestDomains || [] : null;
  if (current && FG.sameJSON(current, sites)) return; // nichts zu tun
  if (!current && !existing.length && !sites.length) return;
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: sites.length
      ? [
          {
            id: RULE_ID,
            priority: 1,
            action: { type: 'block' },
            condition: { requestDomains: sites, resourceTypes: ['main_frame', 'sub_frame'] },
          },
        ]
      : [],
  });
}

/** Neue Leseansicht an offene YouTube-Tabs (nur dort lauscht das Inhaltsskript). */
async function broadcast(settings, prev, prevKnown) {
  const key = FG.stableStringify(FG.publicView(settings));
  // Nach einem Neustart des Service Workers ist lastBroadcast leer. Ohne bekannten Vorzustand
  // (Aufwachen/Wecker) wird nichts als "gesendet" vermerkt – sonst ginge die auslösende Änderung verloren.
  if (lastBroadcast === null && !prevKnown) return;
  const before = lastBroadcast !== null ? lastBroadcast : FG.stableStringify(FG.publicView(prev));
  lastBroadcast = key;
  if (key === before) return;
  const view = FG.publicView(settings);
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({}); // ohne "tabs"-Recht: nur IDs, keine Adressen/Titel
  } catch {
    return;
  }
  const msg = { type: 'fg:settings', settings: view };
  await Promise.all(tabs.map((t) => (t.id == null ? null : chrome.tabs.sendMessage(t.id, msg).catch(() => {}))));
}

/** Weckt den Hintergrund regelmäßig, solange eine Sperre läuft oder kürzlich lief. */
async function scheduleWatch(snapshot, effective, now) {
  const watching = snapshot && now < snapshot.lockUntil + 30 * 24 * 3600 * 1000;
  const period = FG.isLocked(effective, now) ? 1 : 5;
  const existing = await chrome.alarms.get(ALARM);
  if (!watching) {
    if (existing) await chrome.alarms.clear(ALARM);
  } else if (!existing || existing.periodInMinutes !== period) {
    await chrome.alarms.create(ALARM, { delayInMinutes: period, periodInMinutes: period });
  }
}

/* ---------- Abgleich (Start, Wecker, Speicheränderung von außen) ---------- */
async function reconcile(changes) {
  const stored = await readStored();
  const prevKnown = !!(changes && changes.settings);
  const prev = prevKnown ? FG.withDefaults(changes.settings.oldValue) : stored.settings;
  // Snapshot von außen gelöscht? Dann gilt der alte weiter.
  if (changes && changes._lockSnapshot && changes._lockSnapshot.oldValue && !stored.rawSnap) {
    stored.snap = FG.withDefaults(changes._lockSnapshot.oldValue);
  }
  return commit({ next: stored.settings, prev, stored, prevKnown });
}

/* ---------- Befehle ---------- */
async function execute(op) {
  const stored = await readStored();
  const now = Date.now();
  const res = FG.applyOp(stored.settings, op, now, stored.maxSeen);
  if (!res.ok) return { ok: false, error: res.error, invalid: res.invalid || [], settings: stored.settings };
  const effective = await commit({ next: res.state, prev: stored.settings, stored });
  const partial = !!res.partial || !FG.sameJSON(effective, Object.assign({}, res.state, { lockUntil: effective.lockUntil }));
  return { ok: true, partial, invalid: res.invalid || [], settings: effective };
}

/* ---------- Nachrichten ---------- */
// Vertrauenswürdig = eigene Erweiterungsseite (Popup/Einstellungen). Inhaltsskripte laufen in
// fremden Webseiten-Prozessen und dürfen nur lesen.
function isTrustedSender(sender) {
  return !!sender && sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(EXT_BASE);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id || !msg || typeof msg !== 'object') return false;
  const trusted = isTrustedSender(sender);
  if (msg.type === 'fg:get') {
    serial(readStored)
      .then((st) => sendResponse({ ok: true, settings: trusted ? st.settings : FG.publicView(st.settings) }))
      .catch(() => sendResponse({ ok: false, error: 'internal' }));
    return true;
  }
  if (msg.type === 'fg:op') {
    if (!trusted) {
      sendResponse({ ok: false, error: 'forbidden' });
      return false;
    }
    serial(() => execute(msg.op))
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false, error: 'internal' }));
    return true;
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (!('settings' in changes || '_lockSnapshot' in changes || '_clock' in changes)) return;
  serial(() => reconcile(changes));
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) serial(() => reconcile(null));
});

async function init() {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) await chrome.storage.local.set({ settings: FG.withDefaults(null) });
  return reconcile(null);
}
chrome.runtime.onInstalled.addListener(() => serial(init));
chrome.runtime.onStartup.addListener(() => serial(init));
serial(() => reconcile(null)); // bei jedem Aufwachen: Uhr/Sperre prüfen
