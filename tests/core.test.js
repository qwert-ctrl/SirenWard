/* Unit- und Sicherheitstests für core.js (reine Logik). Ausführen: node --test tests/ */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const FG = require('../core.js');

test('normalizeDomain: gültige Eingaben', () => {
  assert.equal(FG.normalizeDomain('instagram.com'), 'instagram.com');
  assert.equal(FG.normalizeDomain('https://www.Instagram.com/explore?x=1#y'), 'instagram.com');
  assert.equal(FG.normalizeDomain('  WWW.REDDIT.COM  '), 'reddit.com');
  assert.equal(FG.normalizeDomain('*.tiktok.com'), 'tiktok.com');
  assert.equal(FG.normalizeDomain('user:pw@x.com:8080/p'), 'x.com');
  assert.equal(FG.normalizeDomain('müller.de'), 'xn--mller-kva.de');
});

test('normalizeDomain: ungültige / bösartige Eingaben werden verworfen', () => {
  for (const bad of [
    '', ' ', 'localhost', 'com', '<script>alert(1)</script>', 'javascript:alert(1)', 'a..b.com',
    '-a.com', 'a-.com', '..', '1', '"><img src=x onerror=alert(1)>.com', 'x.c', 'a b.com',
    null, undefined, 42, {}, [], 'x'.repeat(300) + '.com',
  ]) {
    assert.equal(FG.normalizeDomain(bad), '', 'sollte abgelehnt werden: ' + String(bad).slice(0, 40));
  }
});

test('channelFromHref / normalizeChannel', () => {
  assert.equal(FG.channelFromHref('/@MrBeast'), '@mrbeast');
  assert.equal(FG.channelFromHref('/@MrBeast/videos'), '@mrbeast');
  assert.equal(FG.channelFromHref('https://www.youtube.com/@Kurzgesagt_DE'), '@kurzgesagt_de');
  assert.equal(FG.channelFromHref('/channel/UCX6OQ3DkcsbYNE6H8uQQuVA'), 'ucx6oq3dkcsbyne6h8uqquva');
  assert.equal(FG.channelFromHref('/watch?v=abc'), '');
  assert.equal(FG.channelFromHref('https://evil.com/@x'), '');
  assert.equal(FG.channelFromHref('/@%E2%82%AC'), '@€');
  assert.equal(FG.channelFromHref('/@%E0%A4%A'), '@%e0%a4%a'); // kaputtes Encoding wirft nicht
  assert.equal(FG.normalizeChannel('  Linus   Tech Tips '), 'linus tech tips');
  assert.equal(FG.normalizeChannel('@LinusTechTips'), '@linustechtips');
  assert.equal(FG.normalizeChannel('https://youtube.com/@LinusTechTips/featured'), '@linustechtips');
});

test('withDefaults: Datenmüll und falsche Typen', () => {
  const s = FG.withDefaults({
    blockedSites: ['ok.com', 5, null, '<b>', 'ok.com'],
    yt: { hideHome: 'yes', hideShorts: false, evil: true },
    filter: { mode: 'admin', blockedChannels: 'x', blockedKeywords: [' Gaming '] },
    lockUntil: 'morgen',
  });
  assert.deepEqual(s.blockedSites, ['ok.com']);
  assert.equal(s.yt.hideHome, true); // Default bleibt
  assert.equal(s.yt.hideShorts, false);
  assert.equal('evil' in s.yt, false);
  assert.equal(s.filter.mode, 'blacklist');
  assert.deepEqual(s.filter.blockedChannels, []);
  assert.deepEqual(s.filter.blockedKeywords, ['gaming']);
  assert.equal(s.lockUntil, 0);
  for (const x of [undefined, null, 'str', 42, [], true]) assert.deepEqual(FG.withDefaults(x), FG.withDefaults(null));
});

test('Prototype Pollution über Import ist wirkungslos', () => {
  const evil = JSON.parse(
    '{"__proto__":{"polluted":1},"yt":{"__proto__":{"polluted":2}},"filter":{"constructor":{"prototype":{"polluted":3}}}}'
  );
  const s = FG.withDefaults(evil);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.getPrototypeOf(s.yt), Object.prototype);
  assert.equal(Object.keys(s).sort().join(), Object.keys(FG.DEFAULTS).sort().join());
});

test('Größenbegrenzung gegen aufgeblähte Importe', () => {
  const many = Array.from({ length: 10000 }, (_, i) => `site${i}.com`);
  const s = FG.withDefaults({ blockedSites: many, filter: { blockedKeywords: ['x'.repeat(10000)] } });
  assert.equal(s.blockedSites.length, 2000);
  assert.deepEqual(s.filter.blockedKeywords, []);
});

test('withDefaults ist idempotent (kein Endlos-Schreibzyklus im Hintergrund)', () => {
  const rnd = mulberry32(7);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const junk = ['a.com', 'WWW.B.COM', ' c.de/x', '@Foo', 'Foo  Bar', 'https://www.youtube.com/@Z', 'ÄÖÜ', '', '  ', 'x'.repeat(250), '@a b', '/channel/UCabc', 'müller.de'];
  for (let i = 0; i < 2000; i++) {
    const raw = {
      blockedSites: Array.from({ length: 5 }, () => pick(junk)),
      yt: Object.fromEntries(FG.YT_KEYS.map((k) => [k, pick([true, false, 'x', undefined])])),
      filter: {
        mode: pick(['blacklist', 'whitelist', 'x']),
        blockedChannels: Array.from({ length: 4 }, () => pick(junk)),
        blockedKeywords: Array.from({ length: 4 }, () => pick(junk)),
        allowedChannels: Array.from({ length: 4 }, () => pick(junk)),
      },
      lockUntil: pick([0, -1, 1e15, NaN, 'x']),
    };
    const once = FG.withDefaults(raw);
    assert.ok(FG.sameJSON(once, FG.withDefaults(once)), 'nicht idempotent bei Lauf ' + i);
  }
});

test('Regression: Vergleich ignoriert Schlüssel-Reihenfolge (Chrome sortiert gespeicherte Objekte)', () => {
  const s = FG.withDefaults({ blockedSites: ['a.com'], filter: { blockedChannels: ['@x'] } });
  const sortDeep = (v) =>
    Array.isArray(v) ? v.map(sortDeep) : v && typeof v === 'object'
      ? Object.fromEntries(Object.keys(v).sort().reverse().map((k) => [k, sortDeep(v[k])])) : v;
  const reordered = sortDeep(s);
  assert.notEqual(JSON.stringify(s), JSON.stringify(reordered));
  assert.ok(FG.sameJSON(s, reordered));
  assert.ok(!FG.sameJSON(s, { ...reordered, lockUntil: 1 }));
  assert.ok(!FG.sameJSON(['a', 'b'], ['b', 'a'])); // Listen-Reihenfolge zählt weiterhin
});

test('Sperrmodus: Lockerungen werden zurückgedreht', () => {
  const now = Date.now();
  const snap = FG.withDefaults({
    blockedSites: ['a.com', 'b.com'],
    yt: { hideShorts: true, hideComments: true },
    filter: { mode: 'whitelist', blockedChannels: ['@x'], blockedKeywords: ['game'], allowedChannels: ['@ok', '@ok2'] },
    lockUntil: now + 3600e3,
  });
  const tampered = FG.withDefaults({
    blockedSites: ['c.com'],
    yt: { hideShorts: false, hideComments: false },
    filter: { mode: 'blacklist', blockedChannels: [], blockedKeywords: [], allowedChannels: ['@ok', '@new'] },
    lockUntil: 0,
  });
  const out = FG.enforceLock(snap, tampered);
  assert.deepEqual(out.blockedSites.sort(), ['a.com', 'b.com', 'c.com']);
  assert.equal(out.yt.hideShorts, true);
  assert.equal(out.yt.hideComments, true);
  assert.equal(out.filter.mode, 'whitelist');
  assert.deepEqual(out.filter.blockedChannels, ['@x']);
  assert.deepEqual(out.filter.blockedKeywords, ['game']);
  assert.deepEqual(out.filter.allowedChannels, ['@ok']); // @new nicht erlaubt, @ok2 entfernen ok
  assert.equal(out.lockUntil, snap.lockUntil);
});

test('Sperrmodus: Zufallstest – Ergebnis ist nie lockerer als der Stand bei Sperrbeginn', () => {
  const rnd = mulberry32(42);
  const sub = (arr) => arr.filter(() => rnd() < 0.5);
  const pool = ['a.com', 'b.com', 'c.com', 'd.com'];
  const ch = ['@a', '@b', '@c', '@d'];
  const rand = () =>
    FG.withDefaults({
      blockedSites: sub(pool),
      yt: Object.fromEntries(FG.YT_KEYS.map((k) => [k, rnd() < 0.5])),
      filter: { mode: rnd() < 0.5 ? 'whitelist' : 'blacklist', blockedChannels: sub(ch), blockedKeywords: sub(ch), allowedChannels: sub(ch) },
      lockUntil: rnd() < 0.5 ? Date.now() + 1e6 : 0,
    });
  for (let i = 0; i < 5000; i++) {
    const snap = rand();
    snap.lockUntil = Date.now() + 1e6;
    const out = FG.enforceLock(snap, rand());
    for (const d of snap.blockedSites) assert.ok(out.blockedSites.includes(d));
    for (const k of FG.YT_KEYS) if (snap.yt[k]) assert.equal(out.yt[k], true);
    for (const c of snap.filter.blockedChannels) assert.ok(out.filter.blockedChannels.includes(c));
    for (const c of snap.filter.blockedKeywords) assert.ok(out.filter.blockedKeywords.includes(c));
    if (snap.filter.mode === 'whitelist') {
      assert.equal(out.filter.mode, 'whitelist');
      for (const c of out.filter.allowedChannels) assert.ok(snap.filter.allowedChannels.includes(c));
    }
    assert.ok(out.lockUntil >= snap.lockUntil);
    // Wiederholtes Anwenden ändert nichts mehr (Fixpunkt -> keine Schreibschleife)
    assert.ok(FG.sameJSON(out, FG.enforceLock(out, out)));
  }
});

test('verdict: Filterlogik', () => {
  const s = FG.withDefaults({ filter: { blockedChannels: ['@bad'], blockedKeywords: ['prank'] } });
  assert.equal(FG.verdict(s, { title: 'Huge PRANK gone wrong', channels: new Set(['@ok']) }).reason, 'keyword');
  assert.equal(FG.verdict(s, { title: 'Doku', channels: new Set(['@bad']) }).reason, 'channel');
  assert.equal(FG.verdict(s, { title: 'Doku', channels: new Set(['@ok']) }).status, 'ok');
  assert.equal(FG.verdict(s, { title: 'Doku', channels: new Set() }).status, 'ok');
  const w = FG.withDefaults({ filter: { mode: 'whitelist', allowedChannels: ['@learn'] } });
  assert.equal(FG.verdict(w, { title: 'x', channels: new Set(['@learn']) }).status, 'ok');
  assert.equal(FG.verdict(w, { title: 'x', channels: new Set(['@other']) }).reason, 'notAllowed');
  assert.equal(FG.verdict(w, { title: 'x', channels: new Set() }).status, 'unknown');
});

test('ReDoS: alle Normalisierer bleiben bei riesigen Eingaben schnell', () => {
  const inputs = [
    'a'.repeat(200000),
    'a.'.repeat(100000) + '!',
    '-'.repeat(200000) + '.com',
    'https://' + 'a'.repeat(200000),
    '/@' + '%'.repeat(100000),
    '/channel/UC' + '_'.repeat(200000) + '!',
    ' '.repeat(200000) + 'x',
    'x'.repeat(63) + '.' + 'a-'.repeat(50000),
  ];
  for (const inp of inputs) {
    for (const fn of [FG.normalizeDomain, FG.normalizeChannel, FG.normalizeKeyword, FG.channelFromHref]) {
      const t = process.hrtime.bigint();
      fn(inp);
      const ms = Number(process.hrtime.bigint() - t) / 1e6;
      assert.ok(ms < 250, `${fn.name} brauchte ${ms.toFixed(1)} ms`);
    }
  }
});

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------- Neu in 1.1: Befehle, Uhr-Schutz, Datensparsamkeit ---------------- */

const NOW = 1_800_000_000_000;

test('applyOp: ungültige und bösartige Befehle werden abgelehnt', () => {
  const s = FG.withDefaults(null);
  const bad = [
    null, 'add', 42, [], {}, { op: 'nope' }, { op: 'add' },
    { op: 'add', list: '__proto__', values: ['x.com'] },
    { op: 'add', list: 'constructor', values: ['x.com'] },
    { op: 'add', list: 'blockedSites', values: 'x.com' },
    { op: 'add', list: 'blockedSites', values: [] },
    { op: 'add', list: 'blockedSites', values: [42] },
    { op: 'add', list: 'blockedSites', values: ['x'.repeat(3000)] },
    { op: 'add', list: 'blockedSites', values: Array.from({ length: 501 }, (_, i) => `s${i}.com`) },
    { op: 'setYt', key: 'evil', value: true },
    { op: 'setYt', key: 'hideHome', value: 'yes' },
    { op: 'setMode', mode: 'admin' },
    { op: 'lock', durationMs: 10 },
    { op: 'lock', durationMs: 2 * 365 * 864e5 },
    { op: 'lock', durationMs: Infinity },
    { op: 'lock', durationMs: '3600000' },
    { op: 'import', settings: 'x' },
    { op: 'import', settings: [1, 2] },
  ];
  for (const op of bad) {
    const r = FG.applyOp(s, op, NOW);
    assert.equal(r.ok, false, 'sollte abgelehnt werden: ' + JSON.stringify(op).slice(0, 60));
    assert.equal(r.error, 'invalid');
  }
  assert.equal({}.polluted, undefined);
});

test('applyOp: gültige Befehle, ungültige Einzelwerte werden gemeldet', () => {
  let s = FG.withDefaults(null);
  let r = FG.applyOp(s, { op: 'add', list: 'blockedSites', values: ['WWW.Reddit.com/r/x', '<b>', 'reddit.com'] }, NOW);
  assert.ok(r.ok);
  assert.deepEqual(r.state.blockedSites, ['reddit.com']);
  assert.deepEqual(r.invalid, ['<b>']);
  s = r.state;
  r = FG.applyOp(s, { op: 'remove', list: 'blockedSites', values: ['https://reddit.com'] }, NOW);
  assert.deepEqual(r.state.blockedSites, []);
  r = FG.applyOp(s, { op: 'setYt', key: 'hideComments', value: true }, NOW);
  assert.equal(r.state.yt.hideComments, true);
  r = FG.applyOp(s, { op: 'lock', durationMs: 3600e3 }, NOW);
  assert.equal(r.state.lockUntil, NOW + 3600e3);
  assert.equal(s.lockUntil, 0, 'Eingabezustand bleibt unverändert (rein funktional)');
});

test('applyOp: Sperrmodus – Lockern verboten, Verschärfen erlaubt', () => {
  const s = FG.withDefaults({ blockedSites: ['a.com'], filter: { mode: 'whitelist', allowedChannels: ['@ok'] }, lockUntil: NOW + 3600e3 });
  const no = (op) => assert.equal(FG.applyOp(s, op, NOW).error, 'locked', JSON.stringify(op));
  const yes = (op) => assert.ok(FG.applyOp(s, op, NOW).ok, JSON.stringify(op));
  no({ op: 'remove', list: 'blockedSites', values: ['a.com'] });
  no({ op: 'remove', list: 'blockedKeywords', values: ['x'] });
  no({ op: 'setYt', key: 'hideShorts', value: false });
  no({ op: 'setMode', mode: 'blacklist' });
  no({ op: 'add', list: 'allowedChannels', values: ['@new'] });
  yes({ op: 'add', list: 'blockedSites', values: ['b.com'] });
  yes({ op: 'remove', list: 'allowedChannels', values: ['@ok'] });
  yes({ op: 'setYt', key: 'hideComments', value: true });
  const longer = FG.applyOp(s, { op: 'lock', durationMs: 7200e3 }, NOW);
  assert.equal(longer.state.lockUntil, NOW + 7200e3);
  const shorter = FG.applyOp(s, { op: 'lock', durationMs: 60e3 }, NOW);
  assert.equal(shorter.state.lockUntil, NOW + 3600e3, 'Sperre wird nie verkürzt');
  const imp = FG.applyOp(s, { op: 'import', settings: { blockedSites: [], filter: { mode: 'blacklist' }, lockUntil: 0 } }, NOW);
  assert.ok(imp.ok && imp.partial);
  assert.deepEqual(imp.state.blockedSites, ['a.com']);
  assert.equal(imp.state.filter.mode, 'whitelist');
  assert.equal(imp.state.lockUntil, s.lockUntil);
});

test('Uhr-Manipulation: vordrehen → lockern → zurückdrehen schaltet die Sperre wieder scharf', () => {
  const locked = FG.withDefaults({ blockedSites: ['a.com'], lockUntil: NOW + 3600e3 });
  // 1) Uhr 2 Tage vor: Sperre wirkt abgelaufen, Lockern geht durch
  const fake = NOW + 2 * 864e5;
  let r = FG.resolveState({ next: locked, prev: locked, snap: locked, now: fake, maxSeen: NOW });
  assert.equal(r.effective.lockUntil, 0);
  const loosened = FG.withDefaults({ blockedSites: [] });
  r = FG.resolveState({ next: loosened, prev: r.effective, snap: r.snapshot, now: fake, maxSeen: r.maxSeen });
  assert.deepEqual(r.effective.blockedSites, []);
  assert.ok(r.snapshot, 'Snapshot bleibt erhalten');
  // 2) Uhr zurück auf echt: Sperre greift wieder, gelöschte Seite kommt zurück
  const back = NOW + 10 * 60e3;
  r = FG.resolveState({ next: r.effective, prev: r.effective, snap: r.snapshot, now: back, maxSeen: r.maxSeen });
  assert.deepEqual(r.effective.blockedSites, ['a.com']);
  assert.equal(r.effective.lockUntil, NOW + 3600e3);
});

test('Uhr: kleiner NTP-Abgleich nach regulärem Ablauf schaltet NICHT wieder scharf', () => {
  const until = NOW + 3600e3;
  const locked = FG.withDefaults({ blockedSites: ['a.com'], lockUntil: until });
  // regulär abgelaufen und gesehen
  let r = FG.resolveState({ next: FG.withDefaults({ blockedSites: [] }), prev: locked, snap: locked, now: until + 10e3, maxSeen: until });
  assert.deepEqual(r.effective.blockedSites, []);
  // Uhr springt 20 s zurück (vor das Sperrende)
  r = FG.resolveState({ next: r.effective, prev: r.effective, snap: r.snapshot, now: until - 10e3, maxSeen: r.maxSeen });
  assert.deepEqual(r.effective.blockedSites, [], 'keine Wiederbelebung durch NTP');
  assert.equal(r.effective.lockUntil, 0);
});

test('Uhr: neue kurze Sperre gilt nicht sofort als abgelaufen, wenn die Uhr kurz vorging', () => {
  const s = FG.withDefaults(null);
  const maxSeen = NOW + 3 * 60e3; // Uhr lief 3 min vor und wurde korrigiert
  const r = FG.applyOp(s, { op: 'lock', durationMs: 60e3 }, NOW, maxSeen);
  const res = FG.resolveState({ next: r.state, prev: s, snap: null, now: NOW, maxSeen });
  assert.ok(FG.lockActive(res.effective, NOW, res.maxSeen));
});

test('Zufallstest: resolveState ist ein Fixpunkt und nie lockerer als eine aktive Sperre', () => {
  const rnd = mulberry32(99);
  const sub = (a) => a.filter(() => rnd() < 0.5);
  const mk = () => FG.withDefaults({
    blockedSites: sub(['a.com', 'b.com', 'c.com']),
    yt: Object.fromEntries(FG.YT_KEYS.map((k) => [k, rnd() < 0.5])),
    filter: { mode: rnd() < 0.5 ? 'whitelist' : 'blacklist', blockedChannels: sub(['@a', '@b']), blockedKeywords: sub(['x', 'y']), allowedChannels: sub(['@a', '@c']) },
    lockUntil: rnd() < 0.5 ? NOW + Math.floor(rnd() * 1e7) : 0,
  });
  for (let i = 0; i < 3000; i++) {
    const snap = rnd() < 0.7 ? mk() : null;
    const prev = mk();
    const now = NOW + Math.floor((rnd() - 0.3) * 2e7);
    const maxSeen = now + Math.floor((rnd() - 0.5) * 2e7);
    const r1 = FG.resolveState({ next: mk(), prev, snap, now, maxSeen });
    const r2 = FG.resolveState({ next: r1.effective, prev: r1.effective, snap: r1.snapshot, now, maxSeen: r1.maxSeen });
    assert.ok(FG.sameJSON(r1.effective, r2.effective), 'kein Fixpunkt bei Lauf ' + i);
    const base = FG.lockActive(snap, now, r1.maxSeen) ? snap : FG.lockActive(prev, now, r1.maxSeen) ? prev : null;
    if (base) for (const d of base.blockedSites) assert.ok(r1.effective.blockedSites.includes(d));
  }
});

test('publicView gibt dem YouTube-Skript nur das Nötigste', () => {
  const s = FG.withDefaults({ blockedSites: ['privat.com'], lockUntil: NOW + 1 });
  const v = FG.publicView(s);
  assert.deepEqual(Object.keys(v).sort(), ['filter', 'yt', 'ytLimit']);
  assert.ok(!JSON.stringify(v).includes('privat.com'));
});
