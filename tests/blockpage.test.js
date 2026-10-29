/*
 * Eigene Sperrseite im echten Chromium.
 *   node tests/blockpage.test.js [erweiterungsordner]
 * Playwright kann Chromes Rechte-Dialog nicht bestätigen. Deshalb läuft der Test mit einer Kopie,
 * in der das Host-Recht für die Testdomain vorab erteilt ist (genau das, was der Dialog erteilen würde).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { startServers, launch, extensionId, sleep } = require('./lib/harness');

const SRC = path.resolve(process.argv[2] || path.join(__dirname, '..'));
let failed = 0;
const check = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '✔' : '✘'} ${name}${detail ? '  — ' + detail : ''}`);
};

(async () => {
  const srv = await startServers();
  const dir = path.join(srv.tmp, 'bp-ext');
  fs.cpSync(SRC, dir, { recursive: true, filter: (s) => !/^(tests|tools|node_modules|\.git|dist)([\\/]|$)/.test(path.relative(SRC, s)) });
  const mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  mf.host_permissions = ['*://*.blocked.test/*'];
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(mf));

  const ctx = await launch(srv.tmp, 'bp', dir);
  const { sw, id } = await extensionId(ctx);
  const errors = [];
  sw.on('console', (m) => m.type() === 'error' && errors.push('sw: ' + m.text()));
  const opt = await ctx.newPage();
  await opt.goto(`chrome-extension://${id}/options.html`);
  const op = (o) => opt.evaluate((x) => FGClient.op(x, { interactive: false }), o);
  await op({ op: 'add', list: 'blockedSites', values: ['blocked.test', 'other.test'] });
  await op({ op: 'setUnlock', waitSeconds: 10, minutes: 1 });
  await op({ op: 'setFeature', key: 'blockPage', value: true });
  await sleep(500);

  const rules = await sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
  check('Weiterleitung nur für die Domain mit Recht', rules.filter((r) => r.action.type === 'redirect').length === 1 && rules.find((r) => r.id === 1).condition.requestDomains.join() === 'other.test');

  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push('page: ' + e.message));
  p.on('console', (m) => m.type() === 'error' && !/ERR_BLOCKED_BY_CLIENT/.test(m.text()) && errors.push('page: ' + m.text()));
  await p.goto('https://blocked.test/irgendwas').catch(() => {});
  await p.waitForSelector('#unlock button', { timeout: 8000 }).catch(() => {});
  check('Aufruf landet auf der eigenen Sperrseite', p.url().startsWith(`chrome-extension://${id}/blocked.html?d=blocked.test`), p.url());
  check('Gesperrte Domain hat den Server nie erreicht', !srv.log.some((l) => /blocked\.test/.test(l.host)));
  check('Sperrseite verweigert Darstellung im Frame', await p.evaluate(() => typeof window.top === 'object'));

  await p.click('#unlock button');
  await p.waitForSelector('#unlock input');
  await p.type('#unlock input', (await p.textContent('#unlock .unlock-phrase')).toLowerCase());
  await p.waitForFunction(() => !document.querySelector('#unlock .row button').disabled, null, { timeout: 15000 });
  await Promise.all([p.waitForURL(/^https:\/\/blocked\.test\//, { timeout: 8000 }).catch(() => {}), p.click('#unlock .row button')]);
  check('Freigabe auf der Sperrseite öffnet die Seite', /^https:\/\/blocked\.test\//.test(p.url()), p.url());

  // Nach Ablauf (1 min) wird der offene Tab neu geladen und zeigt wieder die Sperrseite
  await p.waitForURL(/blocked\.html\?d=blocked\.test/, { timeout: 100000 }).catch(() => {});
  check('Nach Ablauf: offener Tab automatisch wieder gesperrt', p.url().includes('blocked.html?d=blocked.test'), p.url());

  const st = await opt.evaluate(() => chrome.storage.local.get('_state'));
  check('Kontingent gezählt', st._state.used['blocked.test'] === 1);
  check('Keine Fehler', errors.length === 0, errors.join(' | '));
  await ctx.close();
  srv.close();
  console.log(failed ? `\n${failed} Fehler` : '\nAlle Prüfungen bestanden');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
