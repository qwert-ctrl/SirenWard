/* Tests für Zeitfreigaben, Zeitplan, Fokus, Partner-Code, YouTube-Limit, Statistik, Sperrregeln (core.js). */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const FG = require('../core.js');

const MIN = 60e3;
// Fester Dienstag, 10:00 Ortszeit
const T = new Date(2026, 9, 27, 10, 0, 0).getTime();
const at = (h, m = 0, dayOffset = 0) => new Date(2026, 9, 27 + dayOffset, h, m, 0).getTime();

const base = (over = {}) => FG.withDefaults(Object.assign({ blockedSites: ['reddit.com', 'x.com'] }, over));

/* ---------- Abtippen ---------- */

test('Abtippen: nur Buchstaben zählen, Groß/klein egal', () => {
  const p = 'Ich brauche das jetzt wirklich';
  for (const ok of ['ich brauche das jetzt wirklich', 'ICH BRAUCHE DAS JETZT WIRKLICH', 'Ichbrauchedasjetztwirklich', ' ich, brauche – das: jetzt wirklich!!! ', 'ich brauche das jetzt wirklich 123']) {
    assert.ok(FG.phraseMatches(ok, p), ok);
  }
  for (const bad of ['ich brauche das jetzt', 'ich brauche das jetzt wirklich bitte', '', 'xich brauche das jetzt wirklich']) {
    assert.ok(!FG.phraseMatches(bad, p), bad);
  }
  assert.ok(FG.phraseMatches('ÄRGER über Öl', 'ärger ÜBER öl'), 'Umlaute');
  assert.ok(!FG.phraseMatches('ab', 'ab'), 'zu kurze Sätze gelten nie');
  assert.ok(!FG.phraseMatches(null, p));
});

/* ---------- Einstellungen bereinigen ---------- */

test('withDefaults: neue Felder werden streng bereinigt', () => {
  const s = FG.withDefaults({
    unlock: { perDay: 99, minutes: 0, waitSeconds: -5, phrase: '!!' },
    features: { schedule: 'ja', stats: true, evil: true },
    schedule: { days: [1, 1, 9, -1, 3], start: 600, end: 600 },
    focus: { minutes: 1000 },
    ytLimit: { minutes: 0 },
    partner: { enabled: true, salt: 'x', hash: 'y', iter: 5 },
  });
  assert.deepEqual(s.unlock, FG.DEFAULTS.unlock);
  assert.equal(s.features.schedule, false);
  assert.equal(s.features.stats, true);
  assert.ok(!('evil' in s.features));
  assert.deepEqual(s.schedule.days, [1, 3]);
  assert.notEqual(s.schedule.start, s.schedule.end);
  assert.equal(s.focus.minutes, 25);
  assert.equal(s.ytLimit.minutes, 30);
  assert.equal(s.partner.enabled, false, 'Partner ohne gültigen Hash ist aus');
  assert.ok(FG.sameJSON(s, FG.withDefaults(s)), 'idempotent');
});

test('uiView/publicView verraten das Partner-Geheimnis nicht', () => {
  const s = FG.withDefaults({ partner: { enabled: true, salt: 'A'.repeat(24), hash: 'B'.repeat(44), iter: 600000 } });
  assert.equal(s.partner.enabled, true);
  assert.deepEqual(FG.uiView(s).partner, { enabled: true });
  assert.ok(!JSON.stringify(FG.publicView(s)).includes('BBBB'));
});

/* ---------- Befehle & Schutz ---------- */

const partnered = (over = {}) => base(Object.assign({ partner: { enabled: true, salt: 'A'.repeat(24), hash: 'B'.repeat(44), iter: 600000 } }, over));

test('Partner-Code: Lockern nur mit Code, Verschärfen immer', () => {
  const s = partnered();
  const no = (op) => assert.equal(FG.applyOp(s, op, T).error, 'partner', JSON.stringify(op));
  const yes = (op, ctx) => assert.ok(FG.applyOp(s, op, T, T, ctx).ok, JSON.stringify(op));
  no({ op: 'remove', list: 'blockedSites', values: ['reddit.com'] });
  no({ op: 'setUnlock', perDay: 5 });
  no({ op: 'setUnlock', waitSeconds: 5 });
  no({ op: 'setUnlock', phrase: 'ok ok ok' });
  no({ op: 'setFeature', key: 'schedule', value: true });
  no({ op: 'partnerDisable' });
  no({ op: 'partnerStore', salt: 'C'.repeat(24), hash: 'D'.repeat(44), iter: 600000 });
  yes({ op: 'add', list: 'blockedSites', values: ['tiktok.com'] });
  yes({ op: 'setUnlock', perDay: 1 });
  yes({ op: 'setUnlock', waitSeconds: 120 });
  yes({ op: 'remove', list: 'blockedSites', values: ['reddit.com'] }, { authorized: true });
  yes({ op: 'partnerDisable' }, { authorized: true });
});

test('Zeitsperre schlägt Partner-Code: auch mit Code kein Lockern', () => {
  const s = partnered({ lockUntil: T + 60 * MIN });
  const r = FG.applyOp(s, { op: 'remove', list: 'blockedSites', values: ['reddit.com'] }, T, T, { authorized: true });
  assert.equal(r.error, 'locked');
  assert.equal(FG.applyOp(s, { op: 'partnerDisable' }, T, T, { authorized: true }).error, 'locked');
});

test('Zeitplan & YouTube-Limit unter Sperre nur verschärfbar', () => {
  const s = base({ lockUntil: T + MIN * 60, features: { schedule: true, ytLimit: true }, ytLimit: { minutes: 30 } });
  assert.equal(FG.applyOp(s, { op: 'setSchedule', days: [0, 1, 2, 3, 4, 5, 6], start: 0, end: 60 }, T).error, 'locked');
  assert.ok(FG.applyOp(s, { op: 'setFeature', key: 'schedule', value: false }, T).ok, 'Plan aus = immer sperren = strenger');
  assert.equal(FG.applyOp(s, { op: 'setFeature', key: 'ytLimit', value: false }, T).error, 'locked');
  assert.equal(FG.applyOp(s, { op: 'setYtLimit', minutes: 60 }, T).error, 'locked');
  assert.ok(FG.applyOp(s, { op: 'setYtLimit', minutes: 10 }, T).ok);
  const off = base({ lockUntil: T + MIN * 60 });
  assert.equal(FG.applyOp(off, { op: 'setFeature', key: 'schedule', value: true }, T).error, 'locked');
});

test('Import setzt nie Partner-Code oder Sperre', () => {
  const s = partnered();
  const r = FG.applyOp(s, { op: 'import', settings: { partner: { enabled: false }, lockUntil: 0, blockedSites: [] } }, T, T, { authorized: true });
  assert.ok(r.ok);
  assert.equal(r.state.partner.enabled, true);
  const plain = base();
  const evil = FG.applyOp(plain, { op: 'import', settings: { partner: { enabled: true, salt: 'C'.repeat(24), hash: 'D'.repeat(44), iter: 600000 } } }, T);
  assert.equal(evil.state.partner.enabled, false, 'Import kann keinen fremden Code einschleusen');
});

test('resolveState: Partner-Schutz repariert Manipulation, Freigabe mit Code wirkt', () => {
  const s = partnered();
  const tampered = FG.withDefaults({ blockedSites: [] });
  let r = FG.resolveState({ next: tampered, prev: s, snap: s, now: T, maxSeen: T });
  assert.deepEqual(r.effective.blockedSites, ['reddit.com', 'x.com']);
  assert.equal(r.effective.partner.enabled, true);
  // Mit Code deaktiviert: bleibt deaktiviert, Snapshot reaktiviert ihn nie
  const disabled = FG.applyOp(s, { op: 'partnerDisable' }, T, T, { authorized: true }).state;
  r = FG.resolveState({ next: disabled, prev: s, snap: s, now: T, maxSeen: T, authorized: true });
  assert.equal(r.effective.partner.enabled, false);
  assert.equal(r.snapshot.partner.enabled, false);
  const later = FG.resolveState({ next: FG.withDefaults({ blockedSites: [] }), prev: r.effective, snap: r.snapshot, now: T + MIN, maxSeen: T });
  assert.deepEqual(later.effective.blockedSites, [], 'nach Deaktivierung frei änderbar');
});

test('enforceLock ist für alle neuen Felder monoton (Zufallstest)', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const mk = () => FG.withDefaults({
    unlock: { perDay: pick([0, 1, 3, 10]), minutes: pick([5, 15, 60]), waitSeconds: pick([0, 30, 300]), phrase: pick(['abc def', 'xyz uvw']) },
    features: { schedule: rnd() < 0.5, ytLimit: rnd() < 0.5 },
    schedule: { days: [pick([0, 1, 2])], start: pick([60, 600]), end: pick([120, 900]) },
    ytLimit: { minutes: pick([10, 30, 90]) },
  });
  for (let i = 0; i < 2000; i++) {
    const snap = mk();
    const out = FG.enforceLock(snap, mk());
    assert.ok(out.unlock.perDay <= snap.unlock.perDay);
    assert.ok(out.unlock.minutes <= snap.unlock.minutes);
    assert.ok(out.unlock.waitSeconds >= snap.unlock.waitSeconds);
    assert.equal(out.unlock.phrase, snap.unlock.phrase);
    if (!snap.features.schedule) assert.equal(out.features.schedule, false);
    if (out.features.schedule) assert.deepEqual(out.schedule, snap.schedule);
    if (snap.features.ytLimit) assert.ok(out.features.ytLimit && out.ytLimit.minutes <= snap.ytLimit.minutes);
    assert.ok(FG.sameJSON(FG.enforceLock(out, out), out), 'Fixpunkt');
  }
});

/* ---------- Zeitplan ---------- */

test('Zeitplan: Arbeitszeit, Wochenende, über Mitternacht', () => {
  const work = { days: [1, 2, 3, 4, 5], start: 9 * 60, end: 17 * 60 };
  assert.ok(FG.scheduleActive(work, at(10)));
  assert.ok(!FG.scheduleActive(work, at(8, 59)));
  assert.ok(!FG.scheduleActive(work, at(17)));
  assert.ok(!FG.scheduleActive(work, at(10, 0, 4)), 'Samstag');
  const night = { days: [2], start: 22 * 60, end: 6 * 60 }; // Di 22:00 – Mi 06:00
  assert.ok(FG.scheduleActive(night, at(23)));
  assert.ok(FG.scheduleActive(night, at(5, 59, 1)), 'Mittwoch früh gehört zu Dienstag');
  assert.ok(!FG.scheduleActive(night, at(6, 0, 1)));
  assert.ok(!FG.scheduleActive(night, at(23, 0, 1)), 'Mittwochabend nicht');
  assert.equal(FG.nextScheduleChange(work, at(10)), at(17));
  assert.equal(FG.nextScheduleChange(work, at(18)), at(9, 0, 1));
  assert.equal(FG.nextScheduleChange(work, at(18, 0, 3)), at(9, 0, 6), 'Freitagabend → Montag');
});

test('blockingNow: außerhalb des Zeitplans frei, Fokus sperrt trotzdem', () => {
  const s = base({ features: { schedule: true, focus: true }, schedule: { days: [1, 2, 3, 4, 5], start: 540, end: 1020 } });
  let st = FG.prepareState(s, {}, at(20), at(20));
  assert.deepEqual(FG.blockingNow(s, st, at(20)).blocked, []);
  assert.deepEqual(FG.blockingNow(s, st, at(10)).blocked, ['reddit.com', 'x.com']);
  st = FG.applyStateOp(s, st, { op: 'focusStart', minutes: 25 }, at(20), at(20)).state;
  const b = FG.blockingNow(s, st, at(20));
  assert.ok(b.focus);
  assert.deepEqual(b.blocked, ['reddit.com', 'x.com']);
  assert.equal(b.nextEvent, at(20, 25));
});

/* ---------- Zeitfreigabe ---------- */

function unlockFlow(s, st, d, now, phrase = s.unlock.phrase) {
  const r1 = FG.applyStateOp(s, st, { op: 'unlockRequest', domain: d }, now, now);
  if (!r1.ok) return r1;
  const later = r1.info.readyAt;
  return FG.applyStateOp(s, r1.state, { op: 'unlockConfirm', domain: d, phrase }, later, later);
}

test('Freigabe: Wartezeit, Abtippen, Ablauf', () => {
  const s = base();
  let st = FG.prepareState(s, {}, T, T);
  const req = FG.applyStateOp(s, st, { op: 'unlockRequest', domain: 'https://old.reddit.com/r/x' }, T, T);
  assert.equal(req.ok, false, 'Subdomain-Eingabe muss exakt dem Listeneintrag entsprechen');
  const r1 = FG.applyStateOp(s, st, { op: 'unlockRequest', domain: 'reddit.com' }, T, T);
  assert.ok(r1.ok);
  assert.equal(r1.info.readyAt, T + 30e3);
  assert.equal(r1.info.left, 3);
  st = r1.state;
  assert.equal(FG.applyStateOp(s, st, { op: 'unlockConfirm', domain: 'reddit.com', phrase: s.unlock.phrase }, T + 10e3, T + 10e3).error, 'wait');
  assert.equal(FG.applyStateOp(s, st, { op: 'unlockConfirm', domain: 'reddit.com', phrase: 'falsch falsch' }, T + 31e3, T + 31e3).error, 'phrase');
  const ok = FG.applyStateOp(s, st, { op: 'unlockConfirm', domain: 'reddit.com', phrase: 'I REALLY need this, right NOW!' }, T + 31e3, T + 31e3);
  assert.ok(ok.ok);
  st = ok.state;
  assert.equal(st.unlocks['reddit.com'], T + 31e3 + 15 * MIN);
  let b = FG.blockingNow(s, FG.prepareState(s, st, T + 5 * MIN, T + 5 * MIN), T + 5 * MIN);
  assert.deepEqual(b.blocked, ['x.com']);
  assert.equal(b.nextEvent, T + 31e3 + 15 * MIN);
  const after = T + 31e3 + 15 * MIN + 1;
  b = FG.blockingNow(s, FG.prepareState(s, st, after, after), after);
  assert.deepEqual(b.blocked, ['reddit.com', 'x.com'], 'nach Ablauf wieder gesperrt');
});

test('Freigabe: Tageslimit und Tageswechsel', () => {
  const s = base({ unlock: { perDay: 2, minutes: 15, waitSeconds: 0, phrase: 'los los los' } });
  let st = {};
  let now = T;
  for (let i = 0; i < 2; i++) {
    const r = unlockFlow(s, st, 'reddit.com', now, 'los los los');
    assert.ok(r.ok, 'Freigabe ' + (i + 1));
    st = r.state;
    now += 20 * MIN;
  }
  assert.equal(unlockFlow(s, st, 'reddit.com', now, 'los los los').error, 'quota');
  assert.ok(unlockFlow(s, st, 'x.com', now, 'los los los').ok, 'Limit gilt pro Seite');
  const tomorrow = at(10, 0, 1);
  assert.ok(unlockFlow(s, st, 'reddit.com', tomorrow, 'los los los').ok, 'neuer Tag, neues Kontingent');
  const off = base({ unlock: { perDay: 0 } });
  assert.equal(unlockFlow(off, {}, 'reddit.com', T).error, 'quota', 'perDay 0 = keine Freigaben');
});

test('Freigabe: Uhr zurückstellen verlängert nichts und bringt kein neues Kontingent', () => {
  const s = base({ unlock: { perDay: 1, minutes: 15, waitSeconds: 0, phrase: 'los los los' } });
  const r = unlockFlow(s, {}, 'reddit.com', T, 'los los los');
  const st = r.state;
  // Uhr 2 Stunden zurück: Freigabe hätte jetzt 2h15 Restzeit → ungültig
  const back = T - 2 * 60 * MIN;
  const prepared = FG.prepareState(s, st, back, T);
  assert.ok(!('reddit.com' in prepared.unlocks), 'Rückstellen verlängert die Freigabe nicht');
  assert.deepEqual(FG.blockingNow(s, prepared, back).blocked, ['reddit.com', 'x.com']);
  // Uhr auf gestern: Kontingent bleibt beim spätesten gesehenen Tag
  const yesterday = at(10, 0, -1);
  // maxSeen kommt im Hintergrund aus dem Speicher (= T), nicht von der verstellten Uhr
  assert.equal(FG.applyStateOp(s, st, { op: 'unlockRequest', domain: 'reddit.com' }, yesterday, T).error, 'quota');
  const pr = FG.prepareState(s, st, yesterday, T);
  assert.equal(pr.used['reddit.com'], 1, 'Zähler bleibt');
});

test('Freigabe: Fokus verhindert und beendet Freigaben', () => {
  const s = base({ features: { focus: true }, unlock: { perDay: 3, minutes: 15, waitSeconds: 0, phrase: 'los los los' } });
  let st = unlockFlow(s, {}, 'reddit.com', T, 'los los los').state;
  st = FG.applyStateOp(s, st, { op: 'focusStart' }, T + MIN, T + MIN).state;
  assert.deepEqual(st.unlocks, {});
  assert.equal(st.focusUntil, T + MIN + 25 * MIN);
  assert.equal(FG.applyStateOp(s, st, { op: 'unlockRequest', domain: 'x.com' }, T + 2 * MIN, T + 2 * MIN).error, 'focus');
  assert.equal(FG.applyStateOp(base(), {}, { op: 'focusStart' }, T, T).error, 'disabled', 'nur wenn Funktion an');
});

test('Freigabe: nicht gesperrte Seite, unbekannte Domain, kaputte Eingaben', () => {
  const s = base({ features: { schedule: true }, schedule: { days: [1, 2, 3, 4, 5], start: 540, end: 1020 } });
  assert.equal(FG.applyStateOp(s, {}, { op: 'unlockRequest', domain: 'reddit.com' }, at(20), at(20)).error, 'notBlocked');
  for (const op of [null, {}, { op: 'unlockRequest' }, { op: 'unlockRequest', domain: 'nicht-gelistet.com' }, { op: 'unlockConfirm', domain: 'reddit.com' }, { op: 'ytTick', ms: -1 }, { op: '__proto__' }]) {
    assert.equal(FG.applyStateOp(s, {}, op, T, T).ok, false, JSON.stringify(op));
  }
});

/* ---------- YouTube-Limit & Statistik ---------- */

test('YouTube-Limit: Ticks zählen, Begrenzung pro Tick, Erschöpfung', () => {
  const s = base({ features: { ytLimit: true }, ytLimit: { minutes: 1 } });
  let st = {};
  let r = FG.applyStateOp(s, st, { op: 'ytTick', ms: 999999 }, T, T);
  assert.equal(r.state.ytMs, 30e3, 'ein Tick zählt höchstens 30 s');
  r = FG.applyStateOp(s, r.state, { op: 'ytTick', ms: 30e3 }, T, T);
  assert.ok(r.info.exhausted);
  assert.equal(r.info.remainingMs, 0);
  const off = FG.applyStateOp(base(), {}, { op: 'ytTick', ms: 1000 }, T, T);
  assert.equal(off.state.ytMs, 0, 'ohne Funktion wird nichts gezählt');
  assert.deepEqual(off.info, { limited: false });
});

test('Statistik: nur Zähler, nur wenn eingeschaltet, max. 30 Tage', () => {
  const s = base({ features: { stats: true }, unlock: { perDay: 3, minutes: 15, waitSeconds: 0, phrase: 'los los los' } });
  let st = unlockFlow(s, {}, 'reddit.com', T, 'los los los').state;
  st = FG.applyStateOp(s, st, { op: 'blockHit', domain: 'x.com' }, T, T).state;
  const today = FG.dayKey(T);
  assert.deepEqual(st.stats[today], { unlocks: 1, focus: 0, focusMin: 0, ytMin: 0, blocked: 1 });
  assert.ok(!JSON.stringify(st.stats).includes('reddit'), 'keine Domains in der Statistik');
  const many = {};
  for (let i = 0; i < 40; i++) many[FG.dayKey(T - i * 864e5)] = { unlocks: 1 };
  assert.equal(Object.keys(FG.prepareState(s, { stats: many }, T, T).stats).length, 30);
  assert.deepEqual(FG.prepareState(base(), { stats: many }, T, T).stats, {}, 'ausgeschaltet → gelöscht');
});

test('mergeStateStrict: Manipulation am Zustand lockert nie', () => {
  const trusted = { day: '2026-10-27', used: { 'reddit.com': 2 }, unlocks: { 'x.com': T + 5 * MIN }, pending: {}, focusUntil: T + 10 * MIN, ytMs: 600000 };
  const evil = { day: '2026-10-27', used: {}, unlocks: { 'x.com': T + 999 * MIN, 'reddit.com': T + 60 * MIN }, focusUntil: 0, ytMs: 0 };
  const m = FG.mergeStateStrict(trusted, evil);
  assert.equal(m.used['reddit.com'], 2);
  assert.deepEqual(m.unlocks, { 'x.com': T + 5 * MIN });
  assert.equal(m.focusUntil, T + 10 * MIN);
  assert.equal(m.ytMs, 600000);
  const stricter = FG.mergeStateStrict(trusted, { ...trusted, unlocks: {} });
  assert.deepEqual(stricter.unlocks, {}, 'Freigabe beenden ist erlaubt');
});

/* ---------- Sperrregeln ---------- */

test('buildRules: Sperre, offene Tabs, eigene Sperrseite', () => {
  assert.deepEqual(FG.buildRules([], []), []);
  const r = FG.buildRules(['a.com', 'b.com'], ['b.com']);
  const byId = Object.fromEntries(r.map((x) => [x.id, x]));
  assert.deepEqual(byId[1].condition.requestDomains, ['a.com']);
  assert.deepEqual(byId[2].condition, { requestDomains: ['b.com'], resourceTypes: ['sub_frame'] });
  assert.deepEqual(byId[3].condition, { initiatorDomains: ['a.com', 'b.com'], excludedResourceTypes: ['main_frame'] });
  assert.equal(byId[1000].action.redirect.extensionPath, '/blocked.html?d=b.com');
  assert.equal(new Set(r.map((x) => x.id)).size, r.length, 'eindeutige IDs');
  assert.ok(!r.some((x) => x.condition.requestDomains && x.condition.requestDomains.length === 0), 'keine leeren Listen (wäre ungültig)');
});

test('Freigabe: Kontingent wird auch bei der Bestätigung geprüft (gesenkt zwischen Anfrage und Bestätigung)', () => {
  const s = base({ unlock: { perDay: 2, minutes: 15, waitSeconds: 0, phrase: 'los los los' } });
  const st = FG.applyStateOp(s, {}, { op: 'unlockRequest', domain: 'reddit.com' }, T, T).state;
  const stricter = FG.withDefaults(Object.assign(FG.clone(s), { unlock: { perDay: 0, minutes: 15, waitSeconds: 0, phrase: 'los los los' } }));
  assert.equal(FG.applyStateOp(stricter, st, { op: 'unlockConfirm', domain: 'reddit.com', phrase: 'los los los' }, T, T).error, 'quota');
});

test('Freigabe: Uhr zurück UND gespeicherter Uhrwert gelöscht → Restzeit trotzdem gedeckelt', () => {
  const s = base({ unlock: { perDay: 3, minutes: 15, waitSeconds: 0, phrase: 'los los los' } });
  const st = unlockFlow(s, {}, 'reddit.com', T, 'los los los').state;
  const back = T - 2 * 60 * MIN;
  // maxSeen unbekannt (manipulativ gelöscht) → Rücksprung nicht erkennbar; der Deckel muss greifen
  const prepared = FG.prepareState(s, st, back, back);
  assert.ok(!('reddit.com' in prepared.unlocks), 'Freigabe mit 2h15 Restzeit ist ungültig');
});
