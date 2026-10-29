/* Hintergrund-Tests für Zeitfreigabe, Partner-Code, Fokus, Zeitplan, eigene Sperrseite, YouTube-Limit. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const FG = require('../core.js');
const { createFakeChrome, loadBackground, disposeAll } = require('./lib/fake-chrome');

const MIN = 60e3;
const realNow = Date.now;
const T0 = new Date(2026, 9, 27, 10, 0, 0).getTime(); // Dienstag 10:00
let clock = T0;
Date.now = () => clock;
test.afterEach(() => {
  disposeAll();
  clock = T0;
});
test.after(() => {
  Date.now = realNow;
});

async function boot(store = {}) {
  const fake = createFakeChrome({ store });
  loadBackground(fake, FG);
  await fake.settle();
  return fake;
}
const op = (fake, o, extra = {}, sender = fake.senders.options) => fake.send(Object.assign({ type: 'fg:op', op: o }, extra), sender);
const S = (fake) => FG.withDefaults(fake.store.settings);
const domainsInRules = (fake, id) => {
  const r = fake.rules().find((x) => x.id === id);
  return r ? r.condition.requestDomains || r.condition.initiatorDomains : [];
};

async function setupSites(fake, sites = ['reddit.com', 'x.com']) {
  await op(fake, { op: 'add', list: 'blockedSites', values: sites });
  await fake.settle();
}

test('Zeitfreigabe end-to-end: Wartezeit, Abtippen, Ablauf, Neusperre', async () => {
  const fake = await boot();
  await setupSites(fake);
  let r = await op(fake, { op: 'unlockRequest', domain: 'reddit.com' });
  assert.ok(r.ok);
  assert.equal(r.info.readyAt, clock + 30e3);
  r = await op(fake, { op: 'unlockConfirm', domain: 'reddit.com', phrase: FG.DEFAULTS.unlock.phrase });
  assert.equal(r.error, 'wait', 'vor Ablauf der Wartezeit');
  clock += 31e3;
  r = await op(fake, { op: 'unlockConfirm', domain: 'reddit.com', phrase: FG.DEFAULTS.unlock.phrase.toUpperCase() + '!!' });
  assert.ok(r.ok, JSON.stringify(r.error));
  await fake.settle();
  assert.deepEqual(domainsInRules(fake, 1), ['x.com'], 'reddit.com frei');
  assert.deepEqual(r.state.blocking.unlocked, ['reddit.com']);
  const alarm = fake.alarms()[0];
  assert.ok(alarm.scheduledTime <= clock + 15 * MIN, 'Wecker spätestens zum Ende der Freigabe');
  clock += 15 * MIN + 1000;
  fake.fireAlarm();
  await fake.settle();
  assert.deepEqual(domainsInRules(fake, 1), ['reddit.com', 'x.com'], 'nach 15 min wieder gesperrt');
  assert.deepEqual(domainsInRules(fake, 3), ['reddit.com', 'x.com'], 'offene Tabs laden nichts mehr nach');
  assert.equal(S(fake).blockedSites.length, 2);
  assert.equal(FG.sanitizeState(fake.store._state).used['reddit.com'], 1);
});

test('Zeitfreigabe: vorzeitig wieder sperren ist immer erlaubt', async () => {
  const fake = await boot();
  await setupSites(fake);
  await op(fake, { op: 'setUnlock', waitSeconds: 0 });
  await op(fake, { op: 'unlockRequest', domain: 'x.com' });
  assert.ok((await op(fake, { op: 'unlockConfirm', domain: 'x.com', phrase: FG.DEFAULTS.unlock.phrase })).ok);
  await op(fake, { op: 'lock', durationMs: 60 * MIN });
  assert.ok((await op(fake, { op: 'unlockEnd', domain: 'x.com' })).ok, 'auch während der Sperre');
  await fake.settle();
  assert.deepEqual(domainsInRules(fake, 1), ['reddit.com', 'x.com']);
});

test('Manipulation am Zustand: Kontingent/Freigaben/Fokus lassen sich nicht zurücksetzen', async () => {
  const fake = await boot();
  await setupSites(fake);
  await op(fake, { op: 'setFeature', key: 'focus', value: true });
  await op(fake, { op: 'setUnlock', waitSeconds: 0, perDay: 1 });
  await op(fake, { op: 'unlockRequest', domain: 'reddit.com' });
  await op(fake, { op: 'unlockConfirm', domain: 'reddit.com', phrase: FG.DEFAULTS.unlock.phrase });
  await fake.settle();
  const st = FG.sanitizeState(fake.store._state);
  await fake.chrome.storage.local.set({ _state: Object.assign({}, st, { used: {}, unlocks: { 'reddit.com': clock + 15 * MIN, 'x.com': clock + 999 * MIN } }) });
  await fake.settle(80);
  const after = FG.sanitizeState(fake.store._state);
  assert.equal(after.used['reddit.com'], 1, 'Zähler zurückgeholt');
  assert.ok(!('x.com' in after.unlocks), 'erfundene Freigabe entfernt');
  await op(fake, { op: 'focusStart', minutes: 25 });
  await fake.chrome.storage.local.remove('_state');
  await fake.settle(80);
  assert.equal(FG.sanitizeState(fake.store._state).focusUntil, clock + 25 * MIN, 'Fokus übersteht Löschen');
  assert.equal(FG.sanitizeState(fake.store._state).used['reddit.com'], 1);
});

test('Fokus: sperrt alles inkl. Freigaben, Wecker zum Ende', async () => {
  const fake = await boot();
  await setupSites(fake);
  await op(fake, { op: 'setUnlock', waitSeconds: 0 });
  await op(fake, { op: 'unlockRequest', domain: 'reddit.com' });
  await op(fake, { op: 'unlockConfirm', domain: 'reddit.com', phrase: FG.DEFAULTS.unlock.phrase });
  assert.equal((await op(fake, { op: 'focusStart' })).error, 'disabled');
  await op(fake, { op: 'setFeature', key: 'focus', value: true });
  const r = await op(fake, { op: 'focusStart', minutes: 25 });
  assert.ok(r.ok);
  await fake.settle();
  assert.deepEqual(domainsInRules(fake, 1), ['reddit.com', 'x.com']);
  assert.ok(fake.alarms()[0].scheduledTime <= clock + 25 * MIN);
  assert.equal((await op(fake, { op: 'unlockRequest', domain: 'x.com' })).error, 'focus');
});

test('Zeitplan: außerhalb frei, innerhalb gesperrt, Wecker auf die Grenze', async () => {
  const fake = await boot();
  await setupSites(fake);
  await op(fake, { op: 'setSchedule', days: [1, 2, 3, 4, 5], start: 9 * 60, end: 17 * 60 });
  await op(fake, { op: 'setFeature', key: 'schedule', value: true });
  await fake.settle();
  assert.deepEqual(domainsInRules(fake, 1), ['reddit.com', 'x.com'], '10:00 = gesperrt');
  assert.equal(fake.alarms()[0].scheduledTime, new Date(2026, 9, 27, 17, 0).getTime());
  clock = new Date(2026, 9, 27, 17, 0, 1).getTime();
  fake.fireAlarm();
  await fake.settle();
  assert.deepEqual(fake.rules(), [], '17:00 = frei');
  assert.equal(fake.alarms()[0].scheduledTime, new Date(2026, 9, 28, 9, 0).getTime(), 'nächster Morgen');
});

test('Partner-Code: Hash statt Klartext, Lockern nur mit Code, Ratenbegrenzung', async () => {
  const fake = await boot();
  await setupSites(fake);
  assert.equal((await op(fake, { op: 'partnerSet', code: '123' })).error, 'invalid', 'zu kurz');
  assert.ok((await op(fake, { op: 'partnerSet', code: 'Geheim-2026!' })).ok);
  await fake.settle();
  const raw = JSON.stringify(fake.store);
  assert.ok(!raw.includes('Geheim'), 'Code nie im Klartext gespeichert');
  assert.equal(S(fake).partner.iter, 600000);
  const view = await fake.send({ type: 'fg:get' }, fake.senders.options);
  assert.deepEqual(view.settings.partner, { enabled: true }, 'Hash erreicht die Oberfläche nicht');

  assert.equal((await op(fake, { op: 'remove', list: 'blockedSites', values: ['x.com'] })).error, 'partner');
  assert.equal((await op(fake, { op: 'remove', list: 'blockedSites', values: ['x.com'] }, { code: 'falsch!!' })).error, 'badcode');
  assert.ok((await op(fake, { op: 'add', list: 'blockedSites', values: ['tiktok.com'] })).ok, 'Verschärfen ohne Code');
  assert.ok((await op(fake, { op: 'remove', list: 'blockedSites', values: ['x.com'] }, { code: 'Geheim-2026!' })).ok);
  await fake.settle(80); // Regression: das Speicher-Echo darf die autorisierte Änderung nicht zurückdrehen
  assert.ok(!S(fake).blockedSites.includes('x.com'), 'autorisierte Lockerung bleibt nach dem Echo bestehen');
  assert.ok((await op(fake, { op: 'partnerSet', code: 'Neu-Neu-Neu' })).error === 'partner', 'Code ändern nur mit altem Code');

  // Manipulation: Partner im Speicher abschalten → wird repariert
  await fake.chrome.storage.local.set({ settings: Object.assign(S(fake), { partner: { enabled: false } }) });
  await fake.settle(80);
  assert.equal(S(fake).partner.enabled, true);

  // 5 Fehlversuche → Wartezeit, auch der richtige Code hilft dann nicht
  for (let i = 0; i < 4; i++) await op(fake, { op: 'partnerDisable' }, { code: 'nein-nein' + i });
  const fifth = await op(fake, { op: 'partnerDisable' }, { code: 'nein-nein-5' });
  assert.equal(fifth.error, 'cooldown');
  assert.equal(fifth.retryAt, clock + 5 * MIN);
  assert.equal((await op(fake, { op: 'partnerDisable' }, { code: 'Geheim-2026!' })).error, 'cooldown');
  clock += 5 * MIN + 1;
  assert.ok((await op(fake, { op: 'partnerDisable' }, { code: 'Geheim-2026!' })).ok);
  await fake.settle(80);
  assert.equal(S(fake).partner.enabled, false, 'Deaktivierung bleibt nach dem Echo bestehen');
  await fake.chrome.storage.local.set({ settings: Object.assign(S(fake), { blockedSites: [] }) });
  await fake.settle(80);
  assert.deepEqual(S(fake).blockedSites, [], 'danach frei änderbar (kein Rest-Schutz)');
});

test('Interne Befehle sind von außen nicht aufrufbar', async () => {
  const fake = await boot();
  const r = await op(fake, { op: 'partnerStore', salt: 'A'.repeat(24), hash: 'B'.repeat(44), iter: 600000 });
  assert.equal(r.error, 'invalid');
  assert.equal(S(fake).partner.enabled, false);
  assert.equal((await op(fake, { op: 'unlockRequest', domain: 'x.com' }, {}, fake.senders.contentScript)).error, 'forbidden');
});

test('Eigene Sperrseite: Weiterleitung nur mit Host-Recht, Rechte werden aufgeräumt', async () => {
  const fake = await boot();
  await setupSites(fake);
  await op(fake, { op: 'setFeature', key: 'blockPage', value: true });
  await fake.settle();
  assert.ok(!fake.rules().some((r) => r.action.type === 'redirect'), 'ohne Recht: normale Sperre');
  fake.grant(['reddit.com', 'evil-extra.com']);
  await fake.settle(80);
  const red = fake.rules().filter((r) => r.action.type === 'redirect');
  assert.equal(red.length, 1);
  assert.equal(red[0].action.redirect.extensionPath, '/blocked.html?d=reddit.com');
  assert.deepEqual(domainsInRules(fake, 1), ['x.com']);
  assert.ok(!fake.origins().includes('*://*.evil-extra.com/*'), 'Recht für nicht gelistete Domain entzogen');
  await op(fake, { op: 'remove', list: 'blockedSites', values: ['reddit.com'] });
  await fake.settle(80);
  assert.ok(!fake.origins().includes('*://*.reddit.com/*'), 'Recht mit Domain entfernt');
  fake.grant(['x.com']);
  await fake.settle(40);
  await op(fake, { op: 'setFeature', key: 'blockPage', value: false });
  await fake.settle(80);
  assert.deepEqual(fake.origins(), ['https://www.youtube.com/*'], 'nur das Pflichtrecht bleibt');
});

test('Eigene Sperrseite: offene Tabs werden nach Ablauf der Freigabe neu geladen', async () => {
  const fake = await boot();
  await setupSites(fake);
  await op(fake, { op: 'setFeature', key: 'blockPage', value: true });
  fake.grant(['reddit.com']);
  fake.openTab(7, 'https://old.reddit.com/r/x');
  await op(fake, { op: 'setUnlock', waitSeconds: 0 });
  await op(fake, { op: 'unlockRequest', domain: 'reddit.com' });
  await op(fake, { op: 'unlockConfirm', domain: 'reddit.com', phrase: FG.DEFAULTS.unlock.phrase });
  await fake.settle();
  fake.stats.reloaded.length = 0;
  clock += 16 * MIN;
  fake.fireAlarm();
  await fake.settle(80);
  assert.deepEqual(fake.stats.reloaded, [7]);
});

test('YouTube-Limit: Ticks nur vom YouTube-Skript, pro Tab zeitlich begrenzt', async () => {
  const fake = await boot();
  await op(fake, { op: 'setFeature', key: 'ytLimit', value: true });
  await op(fake, { op: 'setYtLimit', minutes: 1 });
  const yt = (msg, sender = fake.senders.contentScript) => fake.send(Object.assign({ type: 'fg:yt' }, msg), sender);
  assert.equal((await yt({ kind: 'tick', ms: 1000 }, fake.senders.options)).error, 'forbidden');
  let r = await yt({ kind: 'tick', ms: 30000 });
  assert.equal(r.remainingMs, 30000);
  r = await yt({ kind: 'tick', ms: 30000 }); // keine Zeit vergangen → höchstens ~2 s zählen
  assert.ok(r.remainingMs >= 28000, 'gefälschte Ticks zählen nicht voll');
  clock += 30e3;
  r = await yt({ kind: 'tick', ms: 30000 });
  assert.ok(r.exhausted);
  assert.ok((await yt({ kind: 'status' })).exhausted);
  const view = await fake.send({ type: 'fg:get' }, fake.senders.contentScript);
  assert.deepEqual(view.settings.ytLimit, { minutes: 1 });
  assert.ok(view.yt.exhausted);
});

test('Neuinstallation: Abtipp-Satz in der Sprache des Browsers (EN/DE)', async () => {
  for (const [lang, want] of [['de', 'Ich brauche das jetzt wirklich'], ['en', 'I really need this right now']]) {
    const fake = createFakeChrome({ lang });
    loadBackground(fake, FG);
    await fake.settle(60);
    assert.equal(S(fake).unlock.phrase, want, lang + ': beim Aufwachen angelegt');
    const view = await fake.send({ type: 'fg:get' }, fake.senders.options);
    assert.equal(view.settings.unlock.phrase, want);
    fake.dispose();
  }
  // Bestehende Einstellungen werden nie überschrieben
  const keep = createFakeChrome({ lang: 'de', store: { settings: FG.withDefaults({ unlock: { phrase: 'mein eigener Satz' } }) } });
  loadBackground(keep, FG);
  await keep.settle(60);
  assert.equal(S(keep).unlock.phrase, 'mein eigener Satz');
});
