/* Unit- und Sicherheitstests für shared.js. Ausführen: node --test tests/ */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const FG = require('../shared.js');

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
  assert.equal(Object.keys(s).sort().join(), 'blockedSites,filter,lockUntil,yt');
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

test('Hintergrund-Abgleich terminiert bei Chrome-Speicherverhalten (simuliert)', async () => {
  // Minimaler chrome.*-Ersatz, der wie Chrome Schlüssel sortiert und onChanged feuert.
  const store = {};
  const listeners = [];
  const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
  let writes = 0;
  const rules = [];
  globalThis.chrome = {
    storage: {
      local: {
        async get(k) { return k == null ? { ...store } : { [k]: store[k] }; },
        async set(obj) {
          writes++;
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            const nv = sortKeys(JSON.parse(JSON.stringify(v)));
            changes[k] = { oldValue: store[k], newValue: nv };
            store[k] = nv;
          }
          setImmediate(() => listeners.forEach((l) => l(changes, 'local')));
        },
        async remove(k) { delete store[k]; },
      },
      onChanged: { addListener: (l) => listeners.push(l) },
    },
    declarativeNetRequest: {
      async getDynamicRules() { return [...rules]; },
      async updateDynamicRules({ removeRuleIds, addRules }) {
        for (const id of removeRuleIds) rules.splice(rules.findIndex((r) => r.id === id), 1);
        rules.push(...addRules);
      },
    },
    runtime: { onInstalled: { addListener() {} }, onStartup: { addListener() {} } },
  };
  globalThis.FG = FG;
  try {
    require('../background.js');
    await chrome.storage.local.set({ settings: FG.withDefaults({ blockedSites: ['blocked.test'] }) });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(writes <= 3, 'Endlos-Schreibschleife: ' + writes + ' Schreibvorgänge');
    assert.equal(rules.length, 1);
    assert.deepEqual(rules[0].condition.requestDomains, ['blocked.test']);
  } finally {
    listeners.length = 0;
    delete globalThis.chrome;
  }
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
