/*
 * Statischer Sicherheits- und Architektur-Scan (AST-basiert, TypeScript-Parser).
 *   node tests/static-scan.js [ordner]     (Standard: Repo; z. B. dist/sirenward für das Paket)
 *
 * Ermittelt die Laufzeitdateien aus dem Manifest (inkl. HTML-Verweisen und ES-Imports) und prüft:
 *  Sicherheit:   Netzwerk-APIs · Codeausführung · HTML-Senken · riskante Erweiterungs-APIs ·
 *                externe Ressourcen / Inline-Code in HTML und CSS · Manifest (Rechte, CSP, Host-Zugriff)
 *  Architektur:  nur background.js schreibt in den Speicher · content.js nutzt keinen Speicher ·
 *                kein importScripts (Trusted Types) · Paket enthält nur referenzierte Dateien
 */
'use strict';
const fs = require('fs');
const path = require('path');
let ts;
try {
  ts = require('typescript');
} catch {
  ts = require(require('child_process').execSync('npm root -g').toString().trim() + '/typescript');
}

const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const IS_PACKAGE = !fs.existsSync(path.join(ROOT, 'tests'));
const findings = [];
const add = (severity, file, line, rule, detail = '') => findings.push({ severity, file, line, rule, detail });

/* ---------- Laufzeitdateien (gemeinsame Quelle mit dem Build: tools/files.js) ---------- */
const filesLib = fs.existsSync(path.join(ROOT, 'tools', 'files.js')) ? path.join(ROOT, 'tools', 'files.js') : path.join(__dirname, '..', 'tools', 'files.js');
const { manifest: mf, files: runtimeList, missing } = require(filesLib).runtimeFiles(ROOT);
const runtime = new Set(runtimeList);
for (const f of missing) add('HOCH', f, 0, 'Referenzierte Datei fehlt');

/* ---------- JavaScript ---------- */
const NETWORK = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'RTCPeerConnection', 'WebTransport', 'Worker', 'SharedWorker']);
const CODE_EXEC = new Set(['eval', 'Function']);
const HTML_SINK_PROPS = new Set(['innerHTML', 'outerHTML', 'srcdoc']);
const HTML_SINK_CALLS = new Set(['insertAdjacentHTML', 'createContextualFragment', 'write', 'writeln', 'parseFromString']);
const RISKY_MEMBERS = new Set(['postMessage', 'open', 'executeScript', 'registerContentScripts', 'onMessageExternal', 'onConnectExternal', 'connect', 'connectNative', 'sendNativeMessage', 'cookies', 'history', 'webRequest', 'downloads', 'identity']);
const STORAGE_WRITERS = new Set(['background.js']);

const jsFiles = [...runtime].filter((f) => f.endsWith('.js'));
for (const file of jsFiles) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const text = (n) => n.getText(sf);

  (function walk(n) {
    if (ts.isIdentifier(n)) {
      const parent = n.parent;
      const isPropName = parent && ts.isPropertyAccessExpression(parent) && parent.name === n;
      const isDecl = parent && (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) && parent.name === n;
      if (!isPropName && !isDecl) {
        if (NETWORK.has(n.text)) add('HOCH', file, lineOf(n), 'Netzwerk-API', n.text);
        if (CODE_EXEC.has(n.text)) add('HOCH', file, lineOf(n), 'Codeausführung', n.text);
      }
    }
    if (n.kind === ts.SyntaxKind.ImportKeyword && n.parent && ts.isCallExpression(n.parent)) {
      add('HOCH', file, lineOf(n), 'Dynamischer Import', text(n.parent));
    }
    if (ts.isImportDeclaration(n)) {
      const spec = n.moduleSpecifier.text;
      add(/^\.\/[\w.-]+\.js$/.test(spec) ? 'INFO' : 'HOCH', file, lineOf(n), 'Statischer Import', spec);
    }
    if (ts.isPropertyAccessExpression(n)) {
      const prop = n.name.text;
      const full = text(n);
      if (HTML_SINK_PROPS.has(prop)) add('HOCH', file, lineOf(n), 'HTML-Senke', full);
      if (prop === 'sendBeacon') add('HOCH', file, lineOf(n), 'Netzwerk-API', full);
      if (RISKY_MEMBERS.has(prop) && !/^location\.|^history\.(back|length)$/.test(full)) add('PRÜFEN', file, lineOf(n), 'Riskante API', full);
      // Architekturregeln
      if (file === 'content.js' && /^chrome\.storage\b/.test(full) && !ts.isPropertyAccessExpression(n.parent)) {
        add('HOCH', file, lineOf(n), 'Architektur: YouTube-Skript greift auf Speicher zu', full);
      }
      if (/^chrome\.storage\.(local|sync|session)\.(set|remove|clear)$/.test(full) && !STORAGE_WRITERS.has(file)) {
        add('HOCH', file, lineOf(n), 'Architektur: Schreibzugriff außerhalb des Hintergrunds', full);
      }
      if (/^chrome\.storage\.sync\b/.test(full)) add('HOCH', file, lineOf(n), 'Datenschutz: storage.sync synchronisiert über Konto', full);
    }
    if (ts.isCallExpression(n)) {
      const callee = text(n.expression);
      const last = callee.split('.').pop();
      if (HTML_SINK_CALLS.has(last)) add('HOCH', file, lineOf(n), 'HTML-Senke', callee);
      if (/^(setTimeout|setInterval)$/.test(callee) && n.arguments[0] && !ts.isArrowFunction(n.arguments[0]) && !ts.isFunctionExpression(n.arguments[0]) && !ts.isIdentifier(n.arguments[0])) {
        add('HOCH', file, lineOf(n), 'String-Timer', callee);
      }
      if (callee === 'importScripts') add('HOCH', file, lineOf(n), 'importScripts (unter Trusted Types gesperrt)', n.arguments.map(text).join(', '));
      if (callee === 'require') add('HOCH', file, lineOf(n), 'require im Laufzeitcode', text(n));
      if (last === 'setAttribute' && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && /^(on|src|href|style)/i.test(n.arguments[0].text)) {
        add('PRÜFEN', file, lineOf(n), 'setAttribute', text(n));
      }
      if (/(^|\.)location\.(assign|replace)$/.test(callee)) {
        const a = n.arguments[0];
        const relative = a && ((ts.isStringLiteral(a) && a.text.startsWith('/')) || (ts.isBinaryExpression(a) && ts.isStringLiteral(a.left) && a.left.text.startsWith('/') && /encodeURIComponent/.test(text(a.right))));
        // fest "https://" + geprüfte Domain: kein javascript:/data:-Ziel möglich
        let leftmost = a;
        while (leftmost && ts.isBinaryExpression(leftmost)) leftmost = leftmost.left;
        const httpsOnly = leftmost && ts.isStringLiteral(leftmost) && leftmost.text === 'https://';
        add(relative || httpsOnly ? 'INFO' : 'HOCH', file, lineOf(n), 'Navigation', text(n));
      }
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const lhs = text(n.left);
      if (/\.(src|href)$|^location$|\.location$/.test(lhs)) {
        add(/createObjectURL/.test(text(n.right)) ? 'INFO' : 'PRÜFEN', file, lineOf(n), 'URL-Zuweisung', `${lhs} = ${text(n.right)}`);
      }
    }
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && /\b(https?|wss?|ftp):\/\//i.test(n.text)) {
      add('PRÜFEN', file, lineOf(n), 'URL im Code', n.text);
    }
    ts.forEachChild(n, walk);
  })(sf);
}

/* ---------- HTML / CSS ---------- */
for (const file of [...runtime].filter((f) => f.endsWith('.html'))) {
  fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').forEach((l, i) => {
    if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(l)) add('HOCH', file, i + 1, 'Inline-Skript', l.trim());
    if (/\son[a-z]+\s*=/i.test(l)) add('HOCH', file, i + 1, 'Inline-Eventhandler', l.trim());
    if (/\sstyle\s*=/i.test(l)) add('MITTEL', file, i + 1, 'Inline-Style (verletzt CSP)', l.trim());
    if (/<style[\s>]/i.test(l)) add('MITTEL', file, i + 1, 'Style-Block (verletzt CSP)', l.trim());
    if (/\s(?:src|href|action)\s*=\s*["']?\s*(?:https?:|\/\/|data:|javascript:)/i.test(l)) add('HOCH', file, i + 1, 'Externe Ressource', l.trim());
    if (/<input\b(?![^>]*type="(?:checkbox|radio|file|time|password)")[^>]*>/i.test(l) && !/spellcheck="false"/.test(l)) add('MITTEL', file, i + 1, 'Rechtschreibprüfung lädt Wörterbuch nach', l.trim());
  });
}
for (const file of [...runtime].filter((f) => f.endsWith('.css'))) {
  fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').forEach((l, i) => {
    if (/@import|url\s*\(/i.test(l)) add('HOCH', file, i + 1, 'CSS lädt Ressource', l.trim());
  });
}

/* ---------- Manifest ---------- */
const ALLOWED_PERMS = new Set(['storage', 'declarativeNetRequest', 'activeTab', 'alarms']);
for (const p of mf.permissions || []) if (!ALLOWED_PERMS.has(p)) add('HOCH', 'manifest.json', 0, 'Unerwartete Berechtigung', p);
if (mf.host_permissions && mf.host_permissions.length) add('HOCH', 'manifest.json', 0, 'host_permissions', mf.host_permissions.join(', '));
if (mf.optional_permissions) add('HOCH', 'manifest.json', 0, 'optionale API-Rechte', JSON.stringify(mf.optional_permissions));
if (mf.optional_host_permissions) {
  const ok = JSON.stringify(mf.optional_host_permissions) === '["*://*/*"]';
  // Nur als Obergrenze für die pro Domain erteilten Rechte (eigene Sperrseite); nie automatisch gewährt.
  add(ok ? 'INFO' : 'HOCH', 'manifest.json', 0, 'optional_host_permissions', JSON.stringify(mf.optional_host_permissions));
}
if (mf.externally_connectable) add('HOCH', 'manifest.json', 0, 'externally_connectable', JSON.stringify(mf.externally_connectable));
if (mf.web_accessible_resources) add('MITTEL', 'manifest.json', 0, 'web_accessible_resources (Fingerprinting)', JSON.stringify(mf.web_accessible_resources));
if (mf.update_url) add('PRÜFEN', 'manifest.json', 0, 'update_url', mf.update_url);
if (!mf.background || mf.background.type !== 'module') add('MITTEL', 'manifest.json', 0, 'Service Worker nicht als ES-Modul');
if (mf.background && mf.background.service_worker && mf.background.scripts) {
  add('HOCH', 'manifest.json', 0, 'background.scripts neben service_worker', 'Chrome/Brave melden: "background.scripts requires manifest version 2 or lower" – Firefox-Variante per tools/manifest.firefox.json bauen');
}
if (mf.background && mf.background.scripts && mf.minimum_chrome_version) add('MITTEL', 'manifest.json', 0, 'Firefox-Manifest mit minimum_chrome_version');
for (const cs of mf.content_scripts || []) {
  for (const m of cs.matches) if (m !== 'https://www.youtube.com/*') add('HOCH', 'manifest.json', 0, 'Content-Script-Match', m);
  if (cs.all_frames) add('PRÜFEN', 'manifest.json', 0, 'all_frames');
  if (cs.world === 'MAIN') add('HOCH', 'manifest.json', 0, 'MAIN-World-Skript');
}
const csp = (mf.content_security_policy && mf.content_security_policy.extension_pages) || '';
const dir = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).filter((p) => p[0]).map((p) => [p[0], p.slice(1)]));
const expect = {
  'default-src': "'none'",
  'script-src': "'self'",
  'connect-src': "'none'",
  'object-src': "'none'",
  'require-trusted-types-for': "'script'",
  'trusted-types': "'none'",
};
for (const [k, v] of Object.entries(expect)) {
  if (!dir[k] || dir[k].join(' ') !== v) add('HOCH', 'manifest.json', 0, 'CSP', `${k} sollte ${v} sein, ist ${dir[k] ? dir[k].join(' ') : '(fehlt)'}`);
}
if (/unsafe-(eval|inline|hashes)|wasm-unsafe|\*|https?:/.test(csp)) add('HOCH', 'manifest.json', 0, 'CSP zu offen', csp);

/* ---------- Paketinhalt ---------- */
(function list(d) {
  for (const f of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, f.name);
    const rel = path.relative(ROOT, p);
    if (f.isDirectory()) {
      if (['node_modules', '.git'].includes(f.name)) continue;
      list(p);
    } else if (!runtime.has(rel)) {
      if (IS_PACKAGE) add('MITTEL', rel, 0, 'Nicht referenzierte Datei im Erweiterungspaket');
    } else if (/\.(wasm|exe|so|dll|sh|bat|node)$/.test(f.name)) add('HOCH', rel, 0, 'Binär/ausführbar im Laufzeitcode');
  }
})(ROOT);

/* ---------- Bericht ---------- */
const order = { HOCH: 0, MITTEL: 1, PRÜFEN: 2, INFO: 3 };
findings.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
for (const f of findings) console.log(`[${f.severity}] ${f.file}:${f.line}  ${f.rule}  ${f.detail}`);
const crit = findings.filter((f) => f.severity === 'HOCH' || f.severity === 'MITTEL').length;
console.log(`\n${IS_PACKAGE ? 'Paket' : 'Repo'}: ${runtime.size} Laufzeitdateien, ${jsFiles.length} JS gescannt · ${findings.length} Fundstellen · ${crit} kritisch`);
process.exitCode = crit ? 1 : 0;
