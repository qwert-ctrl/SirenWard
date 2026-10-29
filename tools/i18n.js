/*
 * Generates _locales/<lang>/messages.json from tools/messages.js.
 *   node tools/i18n.js          – write files
 *   node tools/i18n.js --check  – exit 1 if the files are out of date (used by the tests)
 * "$1" … "$9" in a text become named placeholders, as recommended for Chrome and Firefox.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const LANGS = ['en', 'de'];
const ROOT = path.resolve(__dirname, '..');

function build() {
  delete require.cache[require.resolve('./messages')];
  const src = require('./messages');
  const out = Object.fromEntries(LANGS.map((l) => [l, {}]));
  for (const key of Object.keys(src).sort()) {
    LANGS.forEach((lang, i) => {
      const text = src[key][i];
      const nums = [...new Set([...text.matchAll(/\$([1-9])/g)].map((m) => m[1]))].sort();
      const entry = { message: text.replace(/\$([1-9])/g, (_, n) => `$P${n}$`) };
      if (nums.length) entry.placeholders = Object.fromEntries(nums.map((n) => [`p${n}`, { content: `$${n}` }]));
      out[lang][key] = entry;
    });
  }
  return Object.fromEntries(LANGS.map((l) => [l, JSON.stringify(out[l], null, 2) + '\n']));
}

function file(lang) {
  return path.join(ROOT, '_locales', lang, 'messages.json');
}

module.exports = { build, LANGS, file };

if (require.main === module) {
  const files = build();
  if (process.argv.includes('--check')) {
    const stale = LANGS.filter((l) => !fs.existsSync(file(l)) || fs.readFileSync(file(l), 'utf8') !== files[l]);
    if (stale.length) {
      console.error('Out of date: ' + stale.join(', ') + ' – run: node tools/i18n.js');
      process.exit(1);
    }
    console.log('_locales up to date');
  } else {
    for (const l of LANGS) {
      fs.mkdirSync(path.dirname(file(l)), { recursive: true });
      fs.writeFileSync(file(l), files[l]);
    }
    console.log(`${Object.keys(require('./messages')).length} messages → _locales/{${LANGS.join(',')}}`);
  }
}
