/*
 * Reproduzierbarer Build: node tools/build.js
 *
 * Erzeugt in dist/:
 *   focusguard/                         – nur die Laufzeitdateien (zum Laden im Browser)
 *   focusguard-<version>-extension.zip  – dasselbe als ZIP (auch für Firefox/AMO)
 *   SHA256SUMS                          – Prüfsummen
 * Gleicher Quellstand ⇒ bitgleiches ZIP (feste Zeitstempel, sortierte Einträge, keine Metadaten).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { runtimeFiles } = require('./files');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const { manifest, files, missing } = runtimeFiles(ROOT);
if (missing.length) {
  console.error('Fehlende Dateien:', missing.join(', '));
  process.exit(1);
}

const name = `focusguard-${manifest.version}-extension.zip`;
const out = path.join(DIST, 'focusguard');
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const FIXED = new Date('2026-01-01T00:00:00Z'); // feste Zeitstempel → reproduzierbar
for (const f of files) {
  const dest = path.join(out, f);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(ROOT, f), dest);
  fs.utimesSync(dest, FIXED, FIXED);
}
for (const d of new Set(files.map((f) => path.dirname(path.join(out, f))))) fs.utimesSync(d, FIXED, FIXED);

// -X: keine Zusatzattribute; -D: keine Verzeichniseinträge; Dateien sortiert
execFileSync('zip', ['-q', '-X', '-D', path.join(DIST, name), ...files], { cwd: out, env: { ...process.env, TZ: 'UTC' } });

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sums = [`${sha(path.join(DIST, name))}  ${name}`, ...files.map((f) => `${sha(path.join(out, f))}  focusguard/${f}`)];
fs.writeFileSync(path.join(DIST, 'SHA256SUMS'), sums.join('\n') + '\n');

console.log(`${files.length} Laufzeitdateien → dist/focusguard/`);
console.log(sums[0]);
