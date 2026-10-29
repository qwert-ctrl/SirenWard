/*
 * Reproduzierbarer Build: node tools/build.js
 *
 * Erzeugt in dist/:
 *   chromium/ + sirenward-<version>-chromium.zip  – Chrome, Brave, Edge, Vivaldi, Opera
 *   firefox/  + sirenward-<version>-firefox.zip   – Firefox (manifest.json + tools/manifest.firefox.json)
 *   SHA256SUMS                                     – Prüfsummen aller Dateien
 * Nur Laufzeitdateien (tools/files.js). Gleicher Quellstand ⇒ bitgleiche ZIPs.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { runtimeFiles } = require('./files');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const FIXED = new Date('2026-01-01T00:00:00Z'); // feste Zeitstempel → reproduzierbar
const { manifest, files, missing } = runtimeFiles(ROOT);
if (missing.length) {
  console.error('Fehlende Dateien:', missing.join(', '));
  process.exit(1);
}

/** Overlay anwenden: Objekte zusammenführen, null entfernt einen Schlüssel, "_"-Schlüssel sind Kommentare. */
function merge(base, overlay) {
  const out = JSON.parse(JSON.stringify(base));
  for (const [k, v] of Object.entries(overlay)) {
    if (k.startsWith('_')) continue;
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

const targets = {
  chromium: manifest,
  firefox: merge(manifest, JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.firefox.json'), 'utf8'))),
};

fs.rmSync(DIST, { recursive: true, force: true });
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const sums = [];
for (const [name, mf] of Object.entries(targets)) {
  const out = path.join(DIST, name);
  for (const f of files) {
    const dest = path.join(out, f);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (f === 'manifest.json') fs.writeFileSync(dest, JSON.stringify(mf, null, 2) + '\n');
    else fs.copyFileSync(path.join(ROOT, f), dest);
    fs.utimesSync(dest, FIXED, FIXED);
  }
  for (const d of new Set(files.map((f) => path.dirname(path.join(out, f))))) fs.utimesSync(d, FIXED, FIXED);
  const zip = `sirenward-${manifest.version}-${name}.zip`;
  // -X: keine Zusatzattribute; -D: keine Verzeichniseinträge; Dateien sortiert
  execFileSync('zip', ['-q', '-X', '-D', path.join(DIST, zip), ...files], { cwd: out, env: { ...process.env, TZ: 'UTC' } });
  sums.push(`${sha(path.join(DIST, zip))}  ${zip}`);
  for (const f of files) sums.push(`${sha(path.join(out, f))}  ${name}/${f}`);
  console.log(`${name}: ${files.length} Dateien → dist/${name}/  ${sums[sums.length - files.length - 1]}`);
}
fs.writeFileSync(path.join(DIST, 'SHA256SUMS'), sums.join('\n') + '\n');
