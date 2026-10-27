/*
 * Minimaler, verhaltenstreuer Ersatz für die chrome.*-APIs, die background.js nutzt.
 * Bildet u. a. nach: sortierte Schlüssel beim Speichern (wie Chrome), asynchrones onChanged,
 * Nachrichten mit Absender, DNR-Regeln, Alarme. Mehrere Instanzen von background.js können
 * denselben Speicher teilen (= Neustart des Service Workers).
 */
'use strict';
const fs = require('fs');
const path = require('path');

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const sortKeys = (v) =>
  Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v;

const live = new Set();

/** Alle simulierten Browser stilllegen (nach jedem Test), damit hängende Schleifen den Prozess nicht blockieren. */
function disposeAll() {
  for (const f of live) f.dispose();
  live.clear();
}

function createFakeChrome({ extId = 'abcdefghijklmnop', store = {} } = {}) {
  const L = { changed: [], message: [], alarm: [], installed: [], startup: [], permAdded: [], permRemoved: [] };
  const origins = new Set(['https://www.youtube.com/*']); // Pflichtrecht des Inhaltsskripts
  const openTabs = [{ id: 1, url: 'https://www.youtube.com/watch?v=x' }, { id: 2, url: 'https://example.org/' }];
  let disposed = false;
  const stats = { writes: 0, dnrUpdates: 0, sent: [], reloaded: [], accessLevel: null };
  let rules = [];
  const alarms = new Map();

  function emit(changes) {
    if (disposed || !Object.keys(changes).length) return;
    setImmediate(() => L.changed.forEach((l) => l(clone(changes), 'local')));
  }

  const chrome = {
    runtime: {
      id: extId,
      getURL: (p) => `chrome-extension://${extId}/${p}`,
      onMessage: { addListener: (l) => L.message.push(l) },
      onInstalled: { addListener: (l) => L.installed.push(l) },
      onStartup: { addListener: (l) => L.startup.push(l) },
    },
    storage: {
      local: {
        async get(keys) {
          if (keys == null) return clone(store);
          const list = Array.isArray(keys) ? keys : [keys];
          const out = {};
          for (const k of list) if (k in store) out[k] = clone(store[k]);
          return out;
        },
        async set(obj) {
          stats.writes++;
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            const nv = sortKeys(clone(v));
            changes[k] = { oldValue: clone(store[k]), newValue: clone(nv) };
            store[k] = nv;
          }
          emit(changes);
        },
        async remove(keys) {
          const changes = {};
          for (const k of Array.isArray(keys) ? keys : [keys]) {
            if (k in store) {
              changes[k] = { oldValue: clone(store[k]) };
              delete store[k];
            }
          }
          emit(changes);
        },
        async clear() {
          const changes = {};
          for (const k of Object.keys(store)) {
            changes[k] = { oldValue: clone(store[k]) };
            delete store[k];
          }
          emit(changes);
        },
        async setAccessLevel({ accessLevel }) {
          stats.accessLevel = accessLevel;
        },
      },
      onChanged: { addListener: (l) => L.changed.push(l) },
    },
    declarativeNetRequest: {
      async getDynamicRules() {
        return clone(rules);
      },
      async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
        stats.dnrUpdates++;
        rules = rules.filter((r) => !removeRuleIds.includes(r.id)).concat(clone(addRules));
      },
    },
    alarms: {
      async get(n) {
        return clone(alarms.get(n));
      },
      async create(n, o) {
        alarms.set(n, { name: n, scheduledTime: o.when != null ? o.when : Date.now() + (o.delayInMinutes || 0) * 60e3, periodInMinutes: o.periodInMinutes });
      },
      async clear(n) {
        return alarms.delete(n);
      },
      onAlarm: { addListener: (l) => L.alarm.push(l) },
    },
    tabs: {
      async query(q = {}) {
        // Ohne "tabs"-Recht liefert Chrome nur IDs; URL-Filter funktionieren nur mit Host-Recht.
        if (q.url) {
          const pats = Array.isArray(q.url) ? q.url : [q.url];
          if (!pats.every((p) => origins.has(p))) throw new Error('kein Host-Recht');
          return openTabs.filter((t) => pats.some((p) => matchPattern(p, t.url))).map((t) => ({ id: t.id }));
        }
        return openTabs.map((t) => ({ id: t.id }));
      },
      async sendMessage(id, msg) {
        stats.sent.push({ id, msg: clone(msg) });
      },
      async reload(id) {
        stats.reloaded.push(id);
      },
    },
    permissions: {
      async getAll() {
        return { origins: [...origins], permissions: [] };
      },
      async remove({ origins: o = [] }) {
        for (const x of o) origins.delete(x);
        return true;
      },
      onAdded: { addListener: (l) => L.permAdded.push(l) },
      onRemoved: { addListener: (l) => L.permRemoved.push(l) },
    },
  };
  function matchPattern(p, url) {
    const m = p.match(/^\*:\/\/\*\.([^/]+)\/\*$/);
    if (!m) return false;
    const host = new URL(url).hostname;
    return host === m[1] || host.endsWith('.' + m[1]);
  }

  /** Nachricht wie chrome.runtime.sendMessage zustellen (mit frei wählbarem Absender). */
  function send(msg, sender) {
    return new Promise((resolve) => {
      let async = false;
      for (const l of L.message) if (l(clone(msg), sender, (v) => resolve(clone(v))) === true) async = true;
      if (!async) setImmediate(() => resolve(undefined));
    });
  }

  const senders = {
    options: { id: extId, url: `chrome-extension://${extId}/options.html`, tab: { id: 9 } },
    popup: { id: extId, url: `chrome-extension://${extId}/popup.html` },
    contentScript: { id: extId, url: 'https://www.youtube.com/watch?v=x', tab: { id: 1 } },
    otherExtension: { id: 'zzzzzzzzzzzzzzzz', url: 'chrome-extension://zzzzzzzzzzzzzzzz/x.html' },
    spoofedUrl: { id: extId, url: 'https://evil.example/chrome-extension://' + extId + '/options.html', tab: { id: 3 } },
  };

  const api = {
    dispose() {
      disposed = true;
      for (const k of Object.keys(L)) L[k].length = 0;
    },
    chrome,
    store,
    stats,
    rules: () => clone(rules),
    alarms: () => clone([...alarms.values()]),
    send,
    senders,
    fireAlarm: () => L.alarm.forEach((l) => l({ name: 'fg-tick' })),
    /** Host-Recht erteilen (wie nach chrome.permissions.request im Browser) */
    grant(domains) {
      for (const d of domains) origins.add(`*://*.${d}/*`);
      L.permAdded.forEach((l) => l({ origins: domains.map((d) => `*://*.${d}/*`) }));
    },
    origins: () => [...origins],
    openTab(id, url) {
      openTabs.push({ id, url });
    },
    settle: (ms = 40) => new Promise((r) => setTimeout(r, ms)),
  };
  live.add(api);
  return api;
}

/** Lädt background.js in einer frischen Instanz (= Service-Worker-Start) gegen den Fake. */
function loadBackground(fake, FG) {
  globalThis.FG = FG;
  const src = fs
    .readFileSync(path.join(__dirname, '..', '..', 'background.js'), 'utf8')
    .replace("import './core.js';", '');
  new Function('chrome', src)(fake.chrome);
}

module.exports = { createFakeChrome, loadBackground, disposeAll };
