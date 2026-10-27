/*
 * Einzige Quelle der Wahrheit: Welche Dateien braucht die Erweiterung zur Laufzeit?
 * Ermittelt aus manifest.json, HTML-Verweisen (src/href) und statischen ES-Imports.
 * Genutzt von tools/build.js (Paketinhalt) und tests/static-scan.js (Scanumfang).
 */
'use strict';
const fs = require('fs');
const path = require('path');

function runtimeFiles(root) {
  const mf = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const files = new Set(['manifest.json']);
  const missing = [];
  const queue = [];
  const ref = (f) => {
    if (!f || /^[a-z]+:/i.test(f)) return;
    const n = path.normalize(f).replace(/^\.\//, '').split(path.sep).join('/');
    if (!files.has(n)) {
      files.add(n);
      queue.push(n);
    }
  };
  ref(mf.background && mf.background.service_worker);
  ((mf.background && mf.background.scripts) || []).forEach(ref);
  for (const cs of mf.content_scripts || []) [...(cs.js || []), ...(cs.css || [])].forEach(ref);
  ref(mf.action && mf.action.default_popup);
  ref(mf.options_ui && mf.options_ui.page);
  Object.values(mf.icons || {}).forEach(ref);
  Object.values((mf.action && mf.action.default_icon) || {}).forEach(ref);
  while (queue.length) {
    const f = queue.shift();
    const p = path.join(root, f);
    if (!fs.existsSync(p)) {
      missing.push(f);
      continue;
    }
    const dir = path.posix.dirname(f);
    const src = /\.(html|js)$/.test(f) ? fs.readFileSync(p, 'utf8') : '';
    if (f.endsWith('.html')) for (const m of src.matchAll(/\s(?:src|href)\s*=\s*"([^"]+)"/g)) ref(path.posix.join(dir, m[1]));
    if (f.endsWith('.js')) for (const m of src.matchAll(/^\s*import\s+(?:[^'"]+from\s+)?['"]([^'"]+)['"]/gm)) ref(path.posix.join(dir, m[1]));
    // Seiten, die nur per Sperrregel (declarativeNetRequest-Weiterleitung) geöffnet werden
    if (f.endsWith('.js')) for (const m of src.matchAll(/extensionPath:\s*'\/([\w./-]+?)(?:\?|')/g)) ref(m[1]);
  }
  return { manifest: mf, files: [...files].sort(), missing };
}

module.exports = { runtimeFiles };
