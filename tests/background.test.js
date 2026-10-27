/* Tests für background.js gegen einen verhaltenstreuen chrome.*-Ersatz. Ausführen: node --test tests/ */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const FG = require('../core.js');
const { createFakeChrome, loadBackground, disposeAll } = require('./lib/fake-chrome');

const realNow = Date.now;
let clock = 1_800_000_000_000;
function useClock() {
  Date.now = () => clock;
}
test.afterEach(() => disposeAll());
test.after(() => {
  Date.now = realNow;
});

async function boot(store = {}) {
  useClock();
  const fake = createFakeChrome({ store });
  loadBackground(fake, FG);
  await fake.settle();
  return fake;
}
const op = (fake, o, sender = fake.senders.options) => fake.send({ type: 'fg:op', op: o }, sender);
const settings = (fake) => FG.withDefaults(fake.store.settings);

test('Härtung: Speicher wird für Inhaltsskripte gesperrt', async () => {
  const fake = await boot();
  assert.equal(fake.stats.accessLevel, 'TRUSTED_CONTEXTS');
});

test('Start: Standardwerte werden einmalig geschrieben, keine Schreibschleife', async () => {
  const fake = await boot();
  await fake.settle(100);
  assert.ok(fake.store.settings);
  assert.ok(fake.stats.writes <= 2, 'Schreibvorgänge: ' + fake.stats.writes);
});

test('Absenderprüfung: nur eigene Erweiterungsseiten dürfen ändern', async () => {
  const fake = await boot();
  const add = { op: 'add', list: 'blockedSites', values: ['x.com'] };
  assert.equal((await op(fake, add, fake.senders.contentScript)).error, 'forbidden');
  assert.equal(await op(fake, add, fake.senders.otherExtension), undefined, 'fremde Erweiterung: keine Antwort');
  assert.equal((await op(fake, add, fake.senders.spoofedUrl)).error, 'forbidden');
  assert.equal(await fake.send({ type: 'fg:op', op: add }, null), undefined);
  assert.deepEqual(settings(fake).blockedSites, []);
  assert.ok((await op(fake, add, fake.senders.popup)).ok);
  assert.ok((await op(fake, { ...add, values: ['y.com'] }, fake.senders.options)).ok);
  assert.deepEqual(settings(fake).blockedSites, ['x.com', 'y.com']);
});

test('Datensparsamkeit: YouTube-Skript bekommt nur yt + filter', async () => {
  const fake = await boot();
  await op(fake, { op: 'add', list: 'blockedSites', values: ['privat.example'] });
  const r = await fake.send({ type: 'fg:get' }, fake.senders.contentScript);
  assert.ok(r.ok);
  assert.deepEqual(Object.keys(r.settings).sort(), ['filter', 'yt']);
  assert.ok(!JSON.stringify(r).includes('privat.example'));
  const full = await fake.send({ type: 'fg:get' }, fake.senders.options);
  assert.deepEqual(full.settings.blockedSites, ['privat.example']);
});

test('Nebenläufigkeit: 50 gleichzeitige Befehle → keine verlorene Änderung', async () => {
  const fake = await boot();
  const jobs = [];
  for (let i = 0; i < 50; i++) {
    const sender = i % 2 ? fake.senders.popup : fake.senders.options;
    jobs.push(op(fake, { op: 'add', list: 'blockedSites', values: [`site${i}.test`] }, sender));
  }
  const res = await Promise.all(jobs);
  assert.ok(res.every((r) => r.ok));
  await fake.settle();
  assert.equal(settings(fake).blockedSites.length, 50);
});

test('Website-Sperre: Regel folgt der Liste, identische Zustände schreiben nichts neu', async () => {
  const fake = await boot();
  await op(fake, { op: 'add', list: 'blockedSites', values: ['a.test', 'b.test'] });
  await fake.settle();
  assert.deepEqual(fake.rules()[0].condition.requestDomains, ['a.test', 'b.test']);
  assert.deepEqual(fake.rules()[0].action, { type: 'block' });
  const before = fake.stats.dnrUpdates;
  await op(fake, { op: 'setYt', key: 'hideComments', value: true }); // ändert keine Website
  await op(fake, { op: 'add', list: 'blockedSites', values: ['a.test'] }); // Duplikat
  await fake.settle();
  assert.equal(fake.stats.dnrUpdates, before, 'DNR-Regeln unnötig neu geschrieben');
  await op(fake, { op: 'remove', list: 'blockedSites', values: ['a.test', 'b.test'] });
  await fake.settle();
  assert.deepEqual(fake.rules(), []);
});

test('Broadcast: nur bei Änderungen, die YouTube betreffen – auch nach Neustart des Service Workers', async () => {
  const fake = await boot();
  fake.stats.sent.length = 0;
  await op(fake, { op: 'add', list: 'blockedSites', values: ['nur-website.test'] });
  await fake.settle();
  assert.equal(fake.stats.sent.length, 0, 'Website-Änderung muss nicht an YouTube');
  await op(fake, { op: 'add', list: 'blockedChannels', values: ['@x'] });
  await fake.settle();
  assert.equal(fake.stats.sent.length, 2, 'an beide Tabs');
  assert.deepEqual(Object.keys(fake.stats.sent[0].msg.settings).sort(), ['filter', 'yt']);
  // Neustart: neue Instanz, gleicher Speicher. Erste echte Änderung muss trotzdem ankommen.
  const restarted = createFakeChrome({ store: fake.store });
  loadBackground(restarted, FG);
  await restarted.settle();
  await op(restarted, { op: 'add', list: 'blockedKeywords', values: ['prank'] });
  await restarted.settle();
  assert.equal(restarted.stats.sent.length, 2, 'Änderung nach Neustart verschluckt');
});

test('Sperrmodus: Befehle zum Lockern werden abgelehnt', async () => {
  const fake = await boot();
  await op(fake, { op: 'add', list: 'blockedSites', values: ['a.test'] });
  const r = await op(fake, { op: 'lock', durationMs: 3600e3 });
  assert.ok(r.ok);
  assert.equal(settings(fake).lockUntil, clock + 3600e3);
  const rem = await op(fake, { op: 'remove', list: 'blockedSites', values: ['a.test'] });
  assert.equal(rem.ok, false);
  assert.equal(rem.error, 'locked');
  await fake.settle();
  assert.equal(fake.alarms()[0].periodInMinutes, 1, 'Überwachung läuft');
});

test('Sperrmodus: Manipulation am Speicher wird repariert (überschreiben, löschen, Snapshot weg)', async () => {
  const fake = await boot();
  await op(fake, { op: 'add', list: 'blockedSites', values: ['a.test'] });
  await op(fake, { op: 'lock', durationMs: 3600e3 });
  await fake.settle();

  await fake.chrome.storage.local.set({ settings: { blockedSites: [], lockUntil: 0 } });
  await fake.settle(80);
  assert.deepEqual(settings(fake).blockedSites, ['a.test'], 'überschreiben');

  await fake.chrome.storage.local.clear();
  await fake.settle(80);
  assert.deepEqual(settings(fake).blockedSites, ['a.test'], 'Speicher löschen');
  assert.ok(fake.store._lockSnapshot, 'Snapshot wiederhergestellt');

  await fake.chrome.storage.local.remove('_lockSnapshot');
  await fake.settle(80);
  assert.ok(fake.store._lockSnapshot, 'Snapshot löschen');
  assert.deepEqual(fake.rules()[0].condition.requestDomains, ['a.test']);
});

test('Uhr-Angriff end-to-end: vordrehen → Regeln löschen → zurückdrehen → Regeln kommen zurück', async () => {
  const fake = await boot();
  const t0 = clock;
  await op(fake, { op: 'add', list: 'blockedSites', values: ['a.test'] });
  await op(fake, { op: 'lock', durationMs: 3600e3 });

  clock = t0 + 3 * 864e5; // Systemuhr 3 Tage vor
  fake.fireAlarm();
  await fake.settle();
  assert.equal(settings(fake).lockUntil, 0, 'Sperre wirkt abgelaufen');
  assert.ok((await op(fake, { op: 'remove', list: 'blockedSites', values: ['a.test'] })).ok);
  await fake.settle();
  assert.deepEqual(fake.rules(), []);

  clock = t0 + 15 * 60e3; // Uhr zurück auf echt
  fake.fireAlarm();
  await fake.settle(80);
  assert.deepEqual(settings(fake).blockedSites, ['a.test'], 'Seite wieder gesperrt');
  assert.equal(settings(fake).lockUntil, t0 + 3600e3, 'Sperre wieder aktiv');
  assert.deepEqual(fake.rules()[0].condition.requestDomains, ['a.test']);
  clock = t0;
});

test('Regulärer Ablauf: danach ist Lockern erlaubt, Überwachung wird langsamer', async () => {
  const fake = await boot();
  const t0 = clock;
  await op(fake, { op: 'add', list: 'blockedSites', values: ['a.test'] });
  await op(fake, { op: 'lock', durationMs: 60e3 });
  clock = t0 + 2 * 60e3;
  fake.fireAlarm();
  await fake.settle();
  assert.equal(settings(fake).lockUntil, 0);
  assert.ok((await op(fake, { op: 'remove', list: 'blockedSites', values: ['a.test'] })).ok);
  await fake.settle();
  assert.equal(fake.alarms()[0].periodInMinutes, 5);
  clock = t0;
});

test('Robustheit: kaputte Nachrichten werden ignoriert oder sauber abgelehnt', async () => {
  const fake = await boot();
  for (const msg of [null, 'fg:op', 42, [], {}, { type: 'unknown' }, { type: 'fg:op' }, { type: 'fg:op', op: 'x' }, { type: 'fg:op', op: { op: 'add', list: '__proto__', values: ['a'] } }]) {
    const r = await fake.send(msg, fake.senders.options);
    assert.ok(r === undefined || r.ok === false, JSON.stringify(msg));
  }
  assert.equal({}.polluted, undefined);
  assert.deepEqual(settings(fake).blockedSites, []);
});

test('Uhr-Angriff mit gelöschtem Snapshot: Snapshot wird wiederhergestellt, Sperre greift nach Rücksprung', async () => {
  const fake = await boot();
  const t0 = clock;
  await op(fake, { op: 'add', list: 'blockedSites', values: ['a.test'] });
  await op(fake, { op: 'lock', durationMs: 3600e3 });
  clock = t0 + 3 * 864e5; // Uhr vor → Sperre wirkt abgelaufen
  fake.fireAlarm();
  await fake.settle();
  await op(fake, { op: 'remove', list: 'blockedSites', values: ['a.test'] });
  await fake.chrome.storage.local.remove('_lockSnapshot'); // Spuren verwischen
  await fake.settle(80);
  assert.ok(fake.store._lockSnapshot, 'gelöschter Snapshot muss zurückkommen');
  clock = t0 + 10 * 60e3; // Uhr zurück
  fake.fireAlarm();
  await fake.settle(80);
  assert.deepEqual(settings(fake).blockedSites, ['a.test']);
  clock = t0;
});

test('Broadcast: Änderung, die den schlafenden Service Worker weckt, geht nicht verloren', async () => {
  const fake = await boot();
  await fake.settle();
  // Service Worker "stirbt"; danach ändert jemand den Speicher direkt → das weckt eine neue Instanz.
  fake.dispose();
  const woken = createFakeChrome({ store: fake.store });
  loadBackground(woken, FG); // Aufwach-Abgleich startet sofort …
  const next = FG.withDefaults(fake.store.settings);
  next.filter.blockedChannels.push('@neu');
  await woken.chrome.storage.local.set({ settings: next }); // … und die Änderung kommt hinterher an
  await woken.settle(80);
  assert.equal(woken.stats.sent.length, 2, 'YouTube-Tabs müssen die Änderung erhalten');
  assert.deepEqual(woken.stats.sent[0].msg.settings.filter.blockedChannels, ['@neu']);
});
