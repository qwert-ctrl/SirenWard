/*
 * FocusGuard – Hintergrund.
 *  1. Setzt die Website-Sperre per declarativeNetRequest (der Browser blockiert selbst,
 *     die Erweiterung sieht dabei keine einzelnen Aufrufe).
 *  2. Erzwingt den Sperrmodus: Lockerungen während der Sperre werden zurückgedreht.
 * Kein Netzwerkcode, keine Telemetrie, kein Verlauf.
 */
if (typeof FG === 'undefined' && typeof importScripts === 'function') {
  importScripts('shared.js'); // Chrome (Service Worker); Firefox lädt shared.js über das Manifest
}

const RULE_ID = 1;

let queue = Promise.resolve();
const enqueue = (fn) => {
  queue = queue.then(fn).catch((e) => console.error('[FocusGuard]', e));
  return queue;
};

async function syncRules(s) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const addRules = s.blockedSites.length
    ? [
        {
          id: RULE_ID,
          priority: 1,
          action: { type: 'block' },
          condition: {
            requestDomains: s.blockedSites, // gilt auch für alle Subdomains
            resourceTypes: ['main_frame', 'sub_frame'],
          },
        },
      ]
    : [];
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules,
  });
}

async function reconcile(rawNext, rawPrev) {
  const now = Date.now();
  const next = FG.withDefaults(rawNext);
  const prev = FG.withDefaults(rawPrev);
  const { _lockSnapshot } = await chrome.storage.local.get('_lockSnapshot');
  const snap = _lockSnapshot ? FG.withDefaults(_lockSnapshot) : null;

  // Maßstab für die Sperre: der zuletzt gesicherte Stand oder – falls der fehlt – der vorherige.
  let base = null;
  if (snap && FG.isLocked(snap, now)) base = snap;
  else if (FG.isLocked(prev, now)) base = prev;

  const effective = base ? FG.enforceLock(base, next) : next;

  if (FG.isLocked(effective, now)) {
    if (!FG.sameJSON(snap, effective)) await chrome.storage.local.set({ _lockSnapshot: effective });
  } else if (_lockSnapshot) {
    await chrome.storage.local.remove('_lockSnapshot');
  }

  if (!FG.sameJSON(effective, rawNext)) {
    // Korrigierten Stand speichern; das löst erneut onChanged aus und synchronisiert dann die Regeln.
    await chrome.storage.local.set({ settings: effective });
    return;
  }
  await syncRules(effective);
}

async function init() {
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) {
    await chrome.storage.local.set({ settings: FG.withDefaults(null) });
    return;
  }
  await reconcile(settings, settings);
}

chrome.runtime.onInstalled.addListener(() => enqueue(init));
chrome.runtime.onStartup.addListener(() => enqueue(init));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !('settings' in changes)) return;
  enqueue(() => reconcile(changes.settings.newValue, changes.settings.oldValue));
});
