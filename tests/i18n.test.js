/* Translation checks: catalog ↔ _locales in sync, every used key exists, no dead keys,
 * same placeholders in both languages, no hard-coded UI text left in the code. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const FG = require('../core.js');
const catalog = require('../tools/messages.js');
const { build, LANGS, file } = require('../tools/i18n.js');
const { runtimeFiles } = require('../tools/files.js');

let ts;
try {
  ts = require('typescript');
} catch {
  ts = require(execSync('npm root -g').toString().trim() + '/typescript');
}

const ROOT = path.resolve(__dirname, '..');
const { files } = runtimeFiles(ROOT);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('_locales sind aktuell (node tools/i18n.js)', () => {
  const built = build();
  for (const l of LANGS) assert.equal(fs.readFileSync(file(l), 'utf8'), built[l], `_locales/${l} veraltet`);
});

test('Jeder Eintrag hat beide Sprachen und dieselben Platzhalter', () => {
  for (const [key, val] of Object.entries(catalog)) {
    assert.ok(/^[A-Za-z0-9_]+$/.test(key), 'ungültiger Schlüssel ' + key);
    assert.equal(val.length, LANGS.length, key);
    for (const v of val) assert.ok(typeof v === 'string' && v.trim(), key + ' leer');
    const ph = (v) => [...v.matchAll(/\$([1-9])/g)].map((m) => m[1]).sort().join();
    assert.equal(ph(val[0]), ph(val[1]), 'Platzhalter unterschiedlich: ' + key);
    assert.ok(!/[äöüÄÖÜß]/.test(val[0]), 'Deutsch im englischen Text: ' + key);
    assert.ok(!val.includes(key), 'Text gleich Schlüssel (nicht von fehlender Übersetzung unterscheidbar): ' + key);
  }
  assert.equal(catalog.localeCode[0], 'en');
  assert.equal(catalog.localeCode[1], 'de');
  for (const v of catalog.extDescription) assert.ok(v.length <= 132, 'Store-Beschreibung zu lang');
  for (const v of catalog.defaultUnlockPhrase) assert.ok(FG.phraseLetters(v).length >= FG.LIMITS.PHRASE_MIN_LETTERS && v.length <= FG.LIMITS.PHRASE_MAX);
});

/* ---------- verwendete Schlüssel einsammeln ---------- */
const used = new Set(['localeCode', 'defaultUnlockPhrase']);
const dynamic = [];
for (const f of files) {
  const src = /\.(html|js|json)$/.test(f) && !f.startsWith('_locales/') ? read(f) : '';
  for (const m of src.matchAll(/data-i18n(?:-[a-z-]+)?="([A-Za-z0-9_]+)"/g)) used.add(m[1]);
  for (const m of src.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) used.add(m[1]);
  for (const m of src.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'(?!\s*\+)/g)) used.add(m[1]);
  for (const m of src.matchAll(/\bt\(\s*([a-z]+Key)\b/g)) dynamic.push(f + ':' + m[1]);
}
// Dynamisch zusammengesetzte Familien
for (const k of FG.YT_KEYS) {
  used.add('yt_' + k);
  if (catalog['yt_' + k + '_hint']) used.add('yt_' + k + '_hint');
}
for (const k of FG.FEATURE_KEYS) {
  used.add('feat_' + k);
  used.add('feat_' + k + '_hint');
}
for (const c of ['locked', 'partner', 'badcode', 'cooldown', 'invalid', 'forbidden', 'quota', 'wait', 'phrase', 'focus', 'notBlocked', 'noRequest', 'clock', 'disabled', 'internal', 'unreachable']) used.add('err_' + c);
// Leertexte/Validierungsschlüssel, die als Argument übergeben werden ('sitesEmpty', 'invalidDomain' …)
for (const f of files.filter((x) => x.endsWith('.js'))) {
  for (const m of read(f).matchAll(/'((?:sites|allowed|channels|keywords)Empty|invalid(?:Domain|Channel|Keyword)|modeWhitelistHint|modeBlacklistHint)'/g)) used.add(m[1]);
}

test('Jeder verwendete Schlüssel existiert', () => {
  const missing = [...used].filter((k) => !(k in catalog));
  assert.deepEqual(missing, []);
});

test('Keine toten Schlüssel im Katalog', () => {
  const dead = Object.keys(catalog).filter((k) => !used.has(k));
  assert.deepEqual(dead, []);
});

test('Code enthält keine hart codierten deutschen UI-Texte mehr', () => {
  const hits = [];
  for (const f of files.filter((x) => x.endsWith('.js'))) {
    const sf = ts.createSourceFile(f, read(f), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    (function walk(n) {
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) && /[äöüÄÖÜß]/.test(n.text)) {
        hits.push(`${f}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${n.text.slice(0, 50)}`);
      }
      ts.forEachChild(n, walk);
    })(sf);
  }
  for (const f of files.filter((x) => x.endsWith('.html'))) {
    // Text zwischen Tags (ohne Skript/Stil) muss über data-i18n kommen
    const text = read(f).replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '\n');
    for (const line of text.split('\n')) if (/[äöüÄÖÜß]/.test(line)) hits.push(`${f}: ${line.trim().slice(0, 50)}`);
  }
  assert.deepEqual(hits, []);
});
