/*
 * End-to-End- und Sicherheitstest in echtem Chromium (Playwright).
 *   node tests/e2e.test.js [erweiterungsordner]
 *
 * Voraussetzungen: npm-Paket "playwright" mit Chromium, openssl, Ports 80/443 frei.
 * Jeder Hostname wird auf lokale Server umgebogen, die JEDE Anfrage protokollieren; ein
 * Kontrolllauf ohne Erweiterung misst Chromiums eigenen Hintergrundverkehr.
 */
'use strict';
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';
const fs = require('fs');
const path = require('path');
const { startServers, launch, extensionId, sleep, XSS } = require('./lib/harness');

const EXT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const results = [];
let failed = 0;
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  if (!cond) failed++;
  console.log(`${cond ? '✔' : '✘'} ${name}${detail ? '  — ' + detail : ''}`);
}

(async () => {
  const srv = await startServers();

  /* ----- Kontrolllauf OHNE Erweiterung ----- */
  {
    const c = await launch(srv.tmp, 'control', null);
    const p = await c.newPage();
    for (const u of ['http://allowed.test/', 'https://www.youtube.com/', 'https://www.youtube.com/watch?v=GOOD']) {
      await p.goto(u).catch(() => {});
      await sleep(1500);
    }
    await sleep(8000);
    await c.close();
  }
  const controlHosts = new Set(srv.log.map((l) => (l.host || '').split(':')[0]));
  srv.log.length = 0;

  const ctx = await launch(srv.tmp, 'profile', EXT);
  const extRequests = [];
  const consoleErrors = [];
  ctx.on('request', (r) => {
    let from = '';
    try {
      from = r.frame() ? r.frame().url() : '';
    } catch {
      from = 'serviceworker';
    }
    const u = r.url();
    if (u.startsWith('chrome-extension://') || from.startsWith('chrome-extension://') || from === 'serviceworker') extRequests.push({ url: u, from });
  });
  const watchPage = (p, label) => {
    p.on('console', (m) => m.type() === 'error' && consoleErrors.push(`${label}: ${m.text()}`));
    p.on('pageerror', (e) => consoleErrors.push(`${label}: ${e.message}`));
  };

  const { sw, id: extId } = await extensionId(ctx);
  sw.on('console', (m) => m.type() === 'error' && consoleErrors.push(`sw: ${m.text()}`));
  check('Erweiterung lädt, Service Worker (ES-Modul) läuft', !!extId && (await sw.evaluate(() => typeof globalThis.FG)) === 'object');

  const opt = await ctx.newPage();
  watchPage(opt, 'options');
  await opt.goto(`chrome-extension://${extId}/options.html`);
  await opt.waitForSelector('#ytToggles .toggle');
  check('Einstellungsseite rendert', (await opt.locator('#ytToggles .toggle').count()) === 7);

  const store = () => opt.evaluate(() => chrome.storage.local.get(null));
  const op = (o) => opt.evaluate((x) => FGClient.op(x), o);
  const rules = () => sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());

  /* ----- Härtung ----- */
  const tt = await opt.evaluate(() => {
    try {
      document.createElement('div').innerHTML = '<img src=x>';
      return 'erlaubt';
    } catch (e) {
      return e.constructor.name;
    }
  });
  check('Trusted Types: innerHTML in Erweiterungsseiten blockiert', tt === 'TypeError', tt);
  // eval/new Function: siehe tests/csp-probe.test.js – DevTools-Ausführung umgeht diese CSP-Prüfung.

  /* ----- Websites über das Formular ----- */
  await opt.fill('#siteInput', 'https://www.blocked.test/irgendwas, sub2.example.test');
  await opt.click('#siteForm button');
  await sleep(500);
  let st = await store();
  check('Websites per Formular hinzugefügt & normalisiert', JSON.stringify(st.settings.blockedSites) === '["blocked.test","sub2.example.test"]', JSON.stringify(st.settings.blockedSites));
  await opt.fill('#siteInput', '<img src=x onerror=alert(1)>');
  await opt.click('#siteForm button');
  await sleep(300);
  st = await store();
  check('Ungültige/bösartige Domain wird abgelehnt', st.settings.blockedSites.length === 2 && !(await opt.$eval('#siteInput', (e) => e.validity.valid)));
  let r = await rules();
  check('Sperrregel aktiv (declarativeNetRequest, block)', r.length === 1 && r[0].action.type === 'block' && r[0].condition.requestDomains.includes('blocked.test'));

  /* ----- Nebenläufigkeit (v1.0: 20 → 1) ----- */
  const pop = await ctx.newPage();
  watchPage(pop, 'popup');
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  await pop.waitForFunction(() => typeof FGClient === 'object');
  const jobs = [];
  for (let i = 0; i < 10; i++) {
    jobs.push(op({ op: 'add', list: 'blockedSites', values: [`a${i}.race.test`] }));
    jobs.push(pop.evaluate((v) => FGClient.op({ op: 'add', list: 'blockedSites', values: [v] }), `b${i}.race.test`));
  }
  await Promise.all(jobs);
  st = await store();
  const raced = st.settings.blockedSites.filter((d) => d.endsWith('.race.test'));
  check('20 gleichzeitige Änderungen aus 2 Seiten → alle 20 gespeichert', raced.length === 20, String(raced.length));
  await op({ op: 'remove', list: 'blockedSites', values: raced });

  /* ----- Fokus bleibt erhalten ----- */
  const cb = opt.locator('#ytToggles input').nth(4);
  await cb.focus();
  await cb.press('Space');
  await sleep(500);
  check('Fokus bleibt nach Änderung erhalten (kein Neuaufbau)', await cb.evaluate((e) => document.activeElement === e && e.checked));
  await cb.press('Space');
  await sleep(300);

  /* ----- Website-Sperre ----- */
  const tryGo = async (url) => {
    const p = await ctx.newPage();
    watchPage(p, 'nav');
    try {
      const resp = await p.goto(url, { timeout: 8000 });
      return resp ? String(resp.status()) : 'none';
    } catch (e) {
      return (e.message.match(/net::[A-Z_]+/) || [e.message.split('\n')[0]])[0];
    } finally {
      await p.close();
    }
  };
  check('blocked.test wird blockiert', (await tryGo('http://blocked.test/')) === 'net::ERR_BLOCKED_BY_CLIENT');
  check('Subdomain www.blocked.test wird blockiert', (await tryGo('https://www.blocked.test/')) === 'net::ERR_BLOCKED_BY_CLIENT');
  const allowedRes = await tryGo('http://allowed.test/');
  check('Andere Seite (allowed.test) lädt normal', allowedRes === '200', allowedRes);
  check('Gesperrte Domain hat den Server nie erreicht', !srv.log.some((l) => /blocked\.test/.test(l.host)));

  /* ----- YouTube: Ansicht ----- */
  const yt = await ctx.newPage();
  watchPage(yt, 'youtube');
  const hidden = (sel) => yt.$eval(sel, (e) => getComputedStyle(e).display === 'none').catch(() => 'fehlt');
  await yt.goto('https://www.youtube.com/');
  await sleep(700);
  check('Startseiten-Feed ausgeblendet', (await hidden('#grid')) === true);
  check('Shorts-Regal ausgeblendet', (await hidden('#shorts-section')) === true);
  check('Hinweis statt Feed', (await yt.$eval('#primary', (e) => getComputedStyle(e, '::before').content)).includes('Startseite ausgeblendet'));
  check('Seite sichtbar (fg-ready gesetzt)', await yt.evaluate(() => document.documentElement.classList.contains('fg-ready')));

  /* ----- YouTube: Filter, Aufblitzen, XSS ----- */
  await op({ op: 'add', list: 'blockedChannels', values: ['@bad'] });
  await op({ op: 'add', list: 'blockedKeywords', values: ['prank'] });
  await yt.goto('https://www.youtube.com/results?search_query=test');
  await sleep(800);
  const visible = Object.fromEntries(await yt.$$eval('ytd-video-renderer', (els) => els.map((e) => [e.dataset.title, getComputedStyle(e).display !== 'none'])));
  check('Erlaubtes Video sichtbar', visible['Lineare Algebra – Folge 1'] === true);
  check('Stichwort-Filter ("prank") greift', visible['Krasser PRANK im Büro'] === false);
  check('Kanal-Filter (@bad) greift', visible['Normales Video'] === false);
  check('Shorts in Suchergebnissen ausgeblendet', (await hidden('#reel-shelf')) === true);
  for (let i = 0; i < 10; i++) {
    await yt.evaluate(() => window.addItems(40));
    await sleep(30);
  }
  await sleep(300);
  const flash = await yt.evaluate(() => [window.__flash, window.__checked]);
  check('Kein Aufblitzen: gesperrte Videos schon im ersten Bild unsichtbar', flash[0] === 0 && flash[1] > 100, `${flash[0]} von ${flash[1]} sichtbar`);
  const xss = await yt.evaluate(() => [window.__xss, document.querySelectorAll('img').length]);
  check('Kein XSS: präparierte Titel bleiben Text', xss[0] === undefined && xss[1] === 0);

  /* ----- Videoseite gesperrter Kanal ----- */
  await yt.goto('https://www.youtube.com/watch?v=BAD&autoplay=1');
  await sleep(1000);
  const ov = await yt.$('#fg-overlay');
  check('Sperrseite bei gesperrtem Kanal', !!ov, ov ? (await ov.innerText()).replace(/\s+/g, ' ') : '');
  await yt.evaluate(() => document.getElementById('player').play().catch(() => {}));
  await sleep(400);
  check('Video bleibt pausiert, auch bei erneutem Start', await yt.$eval('#player', (v) => v.paused));
  check('Barrierefreiheit: Seite dahinter inert, Fokus im Dialog', await yt.evaluate(() => document.querySelector('ytd-app').inert && !!document.activeElement && document.activeElement.closest('#fg-overlay') !== null));
  check('Endcards/Empfehlungen ausgeblendet', (await hidden('#endcard')) === true && (await hidden('#related')) === true);
  check('Autoplay wurde abgeschaltet', (await yt.$eval('#autonav', (e) => e.getAttribute('aria-checked'))) === 'false');
  check('Sperrseite enthält keine Seitendaten/Links', !/href|<img|<script/i.test(ov ? await ov.innerHTML() : ''));

  await yt.goto('https://www.youtube.com/watch?v=GOOD&autoplay=1');
  await sleep(1000);
  check('Erlaubter Kanal: keine Sperre, Video läuft', !(await yt.$('#fg-overlay')) && !(await yt.$eval('#player', (v) => v.paused)));

  await yt.goto('https://www.youtube.com/shorts/XYZ');
  await yt.waitForURL(/watch\?v=XYZ/, { timeout: 5000 }).catch(() => {});
  check('Shorts-Link wird zum normalen Video umgeleitet', /\/watch\?v=XYZ$/.test(yt.url()), yt.url());

  /* ----- Strikter Modus ----- */
  await op({ op: 'remove', list: 'blockedChannels', values: ['@bad'] });
  await op({ op: 'remove', list: 'blockedKeywords', values: ['prank'] });
  await op({ op: 'add', list: 'allowedChannels', values: ['@good'] });
  await op({ op: 'setMode', mode: 'whitelist' });
  await yt.goto('https://www.youtube.com/watch?v=OTHER&autoplay=1');
  await sleep(1000);
  const ov2 = await yt.$('#fg-overlay');
  check('Strikt: fremder Kanal gesperrt, Video pausiert', !!ov2 && /Erlaubt-Liste/.test(await ov2.innerText()) && (await yt.$eval('#player', (v) => v.paused)));
  await yt.goto('https://www.youtube.com/watch?v=GOOD&autoplay=1');
  await sleep(1000);
  check('Strikt: erlaubter Kanal – geprüft, dann läuft das Video weiter', !(await yt.$('#fg-overlay')) && !(await yt.$eval('#player', (v) => v.paused)));
  await yt.goto('https://www.youtube.com/@good');
  await sleep(700);
  check('Strikt: erlaubte Kanalseite frei', !(await yt.$('#fg-overlay')));
  await yt.goto('https://www.youtube.com/results?search_query=x');
  await sleep(800);
  const wl = Object.fromEntries(await yt.$$eval('ytd-video-renderer', (els) => els.map((e) => [e.dataset.title, getComputedStyle(e).display !== 'none'])));
  check('Strikt: nur erlaubte Kanäle in der Suche', wl['Lineare Algebra – Folge 1'] === true && wl['Normales Video'] === false && Object.values(wl).filter(Boolean).length === 2);

  /* ----- Sperrmodus ----- */
  opt.once('dialog', (d) => d.accept());
  await opt.selectOption('#lockDuration', '3600000');
  await opt.click('#lockBtn');
  await sleep(700);
  st = await store();
  check('Sperrmodus aktiviert', st.settings.lockUntil > Date.now() && !!st._lockSnapshot);
  check('UI: Entfernen während der Sperre deaktiviert', await opt.$$eval('#siteList button', (b) => b.length > 0 && b.every((x) => x.disabled)));
  const denied = await op({ op: 'remove', list: 'blockedSites', values: ['blocked.test'] });
  check('Befehl zum Lockern wird mit Begründung abgelehnt', denied.ok === false && denied.error === 'locked' && /Sperre/.test(denied.message));

  await opt.evaluate(() => chrome.storage.local.set({ settings: { blockedSites: [], yt: {}, filter: { mode: 'blacklist' }, lockUntil: 0 } }));
  await sleep(1000);
  st = await store();
  check('Manipulation 1 (Speicher überschreiben) repariert', st.settings.blockedSites.includes('blocked.test') && st.settings.lockUntil > Date.now() && st.settings.filter.mode === 'whitelist');
  await opt.evaluate(() => chrome.storage.local.clear());
  await sleep(1000);
  st = await store();
  check('Manipulation 2 (Speicher löschen) repariert', !!st.settings && st.settings.blockedSites.includes('blocked.test') && !!st._lockSnapshot);
  const evil = path.join(srv.tmp, 'evil.json');
  fs.writeFileSync(
    evil,
    '{"__proto__":{"polluted":1},"settings":' +
      JSON.stringify({
        blockedSites: [...Array.from({ length: 5000 }, (_, i) => `x${i}.test`), '<script>alert(1)</script>'],
        yt: { hideHome: false, constructor: { prototype: { polluted: 1 } } },
        filter: { mode: 'blacklist', blockedChannels: [XSS], allowedChannels: ['@evil'] },
        lockUntil: 0,
      }) +
      '}'
  );
  await opt.setInputFiles('#importInput', evil);
  await sleep(1200);
  st = await store();
  check('Bösartiger Import: keine Prototype Pollution', (await opt.evaluate(() => ({}).polluted)) === undefined);
  check('Bösartiger Import: begrenzt & bereinigt', st.settings.blockedSites.length <= 2000 && !st.settings.blockedSites.some((d) => /</.test(d)));
  check('Bösartiger Import: Sperre bleibt (strikt, kein @evil, hideHome an)', st.settings.filter.mode === 'whitelist' && !st.settings.filter.allowedChannels.includes('@evil') && st.settings.yt.hideHome === true);
  check('Bösartiger Import: Hinweis in der Oberfläche', /verschärfende/.test(await opt.$eval('#toast', (e) => e.textContent)));
  r = await rules();
  check('Sperrregel nach allen Angriffen aktiv', r.length === 1 && r[0].condition.requestDomains.includes('blocked.test'));
  check('blocked.test weiterhin blockiert', (await tryGo('http://blocked.test/')) === 'net::ERR_BLOCKED_BY_CLIENT');
  check('Kein XSS in der Einstellungsseite', (await opt.evaluate(() => [window.__xss, document.querySelectorAll('img').length])).join() === ',1');

  /* ----- Isolation ----- */
  check('Webseite hat keinen Kanal zur Erweiterung', (await yt.evaluate(() => typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function')) === true);
  check('Interne Logik für die Webseite unsichtbar (isolierte Welt)', (await yt.evaluate(() => typeof window.FG)) === 'undefined');

  /* ----- Netzwerk-Audit ----- */
  await sleep(1500);
  const outbound = extRequests.filter((x) => !x.url.startsWith(`chrome-extension://${extId}/`) && !x.url.startsWith('blob:chrome-extension://'));
  check('Erweiterung: 0 Anfragen nach außen', outbound.length === 0, outbound.map((x) => x.url).join(', '));
  check('Kein Server erhielt je eine Anfrage aus der Erweiterung', !srv.log.some((l) => /chrome-extension/.test(l.origin + l.referer)));
  const seen = [...new Set(srv.log.map((l) => (l.host || '').split(':')[0]))];
  const testHosts = ['www.youtube.com', 'allowed.test'];
  const unexplained = seen.filter((h) => !testHosts.includes(h) && !controlHosts.has(h));
  check('Mitschnitt: kein Host, den nicht auch Chromium ohne Erweiterung kontaktiert', unexplained.length === 0, unexplained.join(', ') || 'Chromium-Eigenverkehr: ' + seen.filter((h) => !testHosts.includes(h)).join(', '));
  const relevant = consoleErrors.filter((e) => !/ERR_BLOCKED_BY_CLIENT|favicon/.test(e) && !/TrustedHTML/.test(e));
  check('Keine JS-/CSP-Fehler in Erweiterung und Seiten', relevant.length === 0, relevant.join(' | '));

  await ctx.close();
  srv.close();
  console.log(`\n${results.length - failed}/${results.length} Prüfungen bestanden`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
