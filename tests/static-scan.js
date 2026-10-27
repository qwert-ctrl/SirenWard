/*
 * Statischer Sicherheits-Scan (AST-basiert, nutzt den TypeScript-Parser).
 * Ausführen: node tests/static-scan.js   (benötigt das npm-Paket "typescript")
 *
 * Prüft:  Netzwerk-APIs · dynamische Code-Ausführung · HTML-Injektions-Senken ·
 *         riskante Erweiterungs-APIs · externe Ressourcen in HTML/CSS · Inline-Code in HTML ·
 *         Manifest (Rechte, CSP, Host-Zugriff).
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

const ROOT = path.resolve(__dirname, '..');
const findings = [];
const add = (severity, file, line, rule, detail) => findings.push({ severity, file, line, rule, detail });

/* ---------- JavaScript ---------- */
const NETWORK = new Set(['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'RTCPeerConnection', 'WebTransport', 'Worker', 'SharedWorker']);
const CODE_EXEC = new Set(['eval', 'Function']);
const HTML_SINK_PROPS = new Set(['innerHTML', 'outerHTML', 'srcdoc']);
const HTML_SINK_CALLS = new Set(['insertAdjacentHTML', 'createContextualFragment', 'write', 'writeln', 'parseFromString']);
const RISKY_MEMBERS = new Set(['sendBeacon', 'postMessage', 'open', 'executeScript', 'registerContentScripts', 'onMessageExternal', 'onConnectExternal', 'connect', 'connectNative', 'sendNativeMessage', 'cookies', 'history', 'webRequest', 'downloads', 'identity']);

const jsFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith('.js'));
for (const file of jsFiles) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const lineOf = (n) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const text = (n) => n.getText(sf);

  (function walk(n) {
    // Bezeichner, die Netzwerkzugriff oder Codeausführung ermöglichen
    if (ts.isIdentifier(n)) {
      const name = n.text;
      const parent = n.parent;
      const isPropName = parent && ts.isPropertyAccessExpression(parent) && parent.name === n;
      const isDecl = parent && (ts.isPropertyAssignment(parent) || ts.isShorthandPropertyAssignment(parent)) && parent.name === n;
      if (!isPropName && !isDecl) {
        if (NETWORK.has(name)) add('HOCH', file, lineOf(n), 'Netzwerk-API', name);
        if (CODE_EXEC.has(name)) add('HOCH', file, lineOf(n), 'Codeausführung', name);
      }
    }
    if (n.kind === ts.SyntaxKind.ImportKeyword && n.parent && ts.isCallExpression(n.parent)) {
      add('HOCH', file, lineOf(n), 'Dynamischer Import', text(n.parent));
    }
    if (ts.isPropertyAccessExpression(n)) {
      const prop = n.name.text;
      if (HTML_SINK_PROPS.has(prop)) add('HOCH', file, lineOf(n), 'HTML-Senke', text(n));
      if (prop === 'sendBeacon') add('HOCH', file, lineOf(n), 'Netzwerk-API', text(n));
      if (RISKY_MEMBERS.has(prop) && !/^location\.|^history\.(back|length)$/.test(text(n))) {
        add('PRÜFEN', file, lineOf(n), 'Riskante API', text(n));
      }
    }
    if (ts.isCallExpression(n)) {
      const callee = text(n.expression);
      const last = callee.split('.').pop();
      if (HTML_SINK_CALLS.has(last)) add('HOCH', file, lineOf(n), 'HTML-Senke', callee);
      if (/^(setTimeout|setInterval)$/.test(callee) && n.arguments[0] && !ts.isArrowFunction(n.arguments[0]) && !ts.isFunctionExpression(n.arguments[0])) {
        add('HOCH', file, lineOf(n), 'String-Timer', callee);
      }
      if (callee === 'importScripts') {
        const ok = n.arguments.every((a) => ts.isStringLiteral(a) && /^[\w.-]+\.js$/.test(a.text));
        add(ok ? 'INFO' : 'HOCH', file, lineOf(n), 'importScripts', n.arguments.map(text).join(', '));
      }
      if (callee === 'require') add('PRÜFEN', file, lineOf(n), 'require', text(n));
      if (last === 'setAttribute' && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && /^(on|src|href|style)/i.test(n.arguments[0].text)) {
        add('PRÜFEN', file, lineOf(n), 'setAttribute', text(n));
      }
      if (/(^|\.)location\.(assign|replace)$/.test(callee)) {
        const a = n.arguments[0];
        const relative = a && ((ts.isStringLiteral(a) && a.text.startsWith('/')) || (ts.isBinaryExpression(a) && ts.isStringLiteral(a.left) && a.left.text.startsWith('/') && /encodeURIComponent/.test(text(a.right))));
        add(relative ? 'INFO' : 'HOCH', file, lineOf(n), 'Navigation', text(n));
      }
    }
    // Zuweisungen an src/href/location
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const lhs = text(n.left);
      if (/\.(src|href)$|^location$|\.location$/.test(lhs)) {
        const safe = /createObjectURL/.test(text(n.right));
        add(safe ? 'INFO' : 'PRÜFEN', file, lineOf(n), 'URL-Zuweisung', `${lhs} = ${text(n.right)}`);
      }
    }
    // URL-Literale
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && /\b(https?|wss?|ftp):\/\//i.test(n.text)) {
      add('PRÜFEN', file, lineOf(n), 'URL im Code', n.text);
    }
    ts.forEachChild(n, walk);
  })(sf);
}

/* ---------- HTML ---------- */
for (const file of fs.readdirSync(ROOT).filter((f) => f.endsWith('.html'))) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const lines = src.split('\n');
  lines.forEach((l, i) => {
    if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(l)) add('HOCH', file, i + 1, 'Inline-Skript', l.trim());
    if (/\son[a-z]+\s*=/i.test(l)) add('HOCH', file, i + 1, 'Inline-Eventhandler', l.trim());
    if (/\sstyle\s*=/i.test(l)) add('MITTEL', file, i + 1, 'Inline-Style (verletzt CSP)', l.trim());
    if (/<style[\s>]/i.test(l)) add('MITTEL', file, i + 1, 'Style-Block (verletzt CSP)', l.trim());
    const ext = l.match(/\s(?:src|href|action)\s*=\s*["']?\s*(?:https?:|\/\/|data:|javascript:)/i);
    if (ext) add('HOCH', file, i + 1, 'Externe Ressource', l.trim());
  });
}

/* ---------- CSS ---------- */
for (const file of fs.readdirSync(ROOT).filter((f) => f.endsWith('.css'))) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  src.split('\n').forEach((l, i) => {
    if (/@import|url\s*\(/i.test(l)) add('HOCH', file, i + 1, 'CSS lädt Ressource', l.trim());
  });
}

/* ---------- Manifest ---------- */
const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const ALLOWED_PERMS = new Set(['storage', 'declarativeNetRequest', 'activeTab']);
for (const p of mf.permissions || []) if (!ALLOWED_PERMS.has(p)) add('HOCH', 'manifest.json', 0, 'Unerwartete Berechtigung', p);
if (mf.host_permissions && mf.host_permissions.length) add('HOCH', 'manifest.json', 0, 'host_permissions', mf.host_permissions.join(', '));
if (mf.optional_permissions || mf.optional_host_permissions) add('PRÜFEN', 'manifest.json', 0, 'optionale Rechte', '');
if (mf.externally_connectable) add('HOCH', 'manifest.json', 0, 'externally_connectable', JSON.stringify(mf.externally_connectable));
if (mf.web_accessible_resources) add('MITTEL', 'manifest.json', 0, 'web_accessible_resources', JSON.stringify(mf.web_accessible_resources));
if (mf.update_url) add('PRÜFEN', 'manifest.json', 0, 'update_url', mf.update_url);
for (const cs of mf.content_scripts || []) {
  for (const m of cs.matches) if (!/^https:\/\/www\.youtube\.com\/\*$/.test(m)) add('HOCH', 'manifest.json', 0, 'Content-Script-Match', m);
  if (cs.all_frames) add('PRÜFEN', 'manifest.json', 0, 'all_frames', '');
  if (cs.world === 'MAIN') add('HOCH', 'manifest.json', 0, 'MAIN-World-Skript', '');
}
const csp = (mf.content_security_policy && mf.content_security_policy.extension_pages) || '';
const dir = Object.fromEntries(csp.split(';').map((d) => d.trim().split(/\s+/)).filter((p) => p[0]).map((p) => [p[0], p.slice(1)]));
const expect = { 'default-src': "'none'", 'script-src': "'self'", 'connect-src': "'none'", 'object-src': "'none'" };
for (const [k, v] of Object.entries(expect)) {
  if (!dir[k] || dir[k].join(' ') !== v) add('HOCH', 'manifest.json', 0, 'CSP', `${k} sollte ${v} sein, ist ${dir[k] ? dir[k].join(' ') : '(fehlt)'}`);
}
if (/unsafe-(eval|inline)|wasm-unsafe|\*|https?:/.test(csp)) add('HOCH', 'manifest.json', 0, 'CSP zu offen', csp);

/* ---------- Dateien im Paket ---------- */
const ALLOWED_EXT = /\.(js|json|html|css|png|md)$|^LICENSE$/;
(function list(dir) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    const rel = path.relative(ROOT, p);
    if (f.isDirectory()) {
      if (['node_modules', '.git'].includes(f.name)) add('MITTEL', rel, 0, 'Ordner gehört nicht ins Paket', rel);
      else list(p);
    } else if (!ALLOWED_EXT.test(f.name)) add('PRÜFEN', rel, 0, 'Unerwarteter Dateityp', rel);
    else if (/\.(wasm|exe|so|dll|sh|bat)$/.test(f.name)) add('HOCH', rel, 0, 'Binär/ausführbar', rel);
  }
})(ROOT);

/* ---------- Bericht ---------- */
const order = { HOCH: 0, MITTEL: 1, PRÜFEN: 2, INFO: 3 };
findings.sort((a, b) => order[a.severity] - order[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
for (const f of findings) console.log(`[${f.severity}] ${f.file}:${f.line}  ${f.rule}  ${f.detail}`);
const high = findings.filter((f) => f.severity === 'HOCH' || f.severity === 'MITTEL').length;
console.log(`\n${jsFiles.length} JS-Dateien gescannt · ${findings.length} Fundstellen · ${high} kritisch`);
process.exitCode = high ? 1 : 0;
