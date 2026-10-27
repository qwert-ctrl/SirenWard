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
    if (u.startsWith('chrome-extension://') || from.startsWith('chrome-extension://') || from === 'serviceworker') extRequests.push({ url: u, from, nav: r.isNavigationRequest() });
  });
  const watchPage = (p, label) => {
    p.on('console', (m) => m.type() === 'error' && consoleErrors.push(`${label}: ${m.text()}`));
    p.on('pageerror', (e) => consoleErrors.push(`${label}: ${e.message}`));
  };

  let { sw, id: extId } = await extensionId(ctx);
  // Wie chrome://extensions im Entwicklermodus: Fehler/Warnungen der Erweiterung mitschreiben
  const extPage = await ctx.newPage();
  await extPage.goto('chrome://extensions/');
  await extPage.evaluate(() => new Promise((r) => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, r)));
  const reloaded = ctx.waitForEvent('serviceworker', { timeout: 15000 });
  await extPage.evaluate((id) => new Promise((r) => chrome.developerPrivate.reload(id, { failQuietly: true }, r)), extId);
  sw = await reloaded;
  sw.on('console', (m) => m.type() === 'error' && consoleErrors.push(`sw: ${m.text()}`));
  check('Erweiterung lädt, Service Worker (ES-Modul) läuft', !!extId && (await sw.evaluate(() => typeof globalThis.FG)) === 'object');

  const opt = await ctx.newPage();
  watchPage(opt, 'options');
  await opt.goto(`chrome-extension://${extId}/options.html`);
  await opt.waitForSelector('#ytToggles .toggle');
  check('Einstellungsseite rendert', (await opt.locator('#ytToggles .toggle').count()) === 10);

  const store = () => opt.evaluate(() => chrome.storage.local.get(null));
  const op = (o) => opt.evaluate((x) => FGClient.op(x, { interactive: false }), o);
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
  const rule1 = () => r.find((x) => x.id === 1);
  check('Sperrregel aktiv (declarativeNetRequest, block)', !!rule1() && rule1().action.type === 'block' && rule1().condition.requestDomains.includes('blocked.test'));

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

  /* ===================== 1.2: Zeitfreigabe, Fokus, Zeitplan, Partner, YouTube-Limit ===================== */
  await op({ op: 'setFeature', key: 'stats', value: true });
  await op({ op: 'setUnlock', waitSeconds: 10 });

  /* ----- Zeitfreigabe über die Sperrseite ----- */
  const bp = await ctx.newPage();
  watchPage(bp, 'sperrseite');
  await bp.goto(`chrome-extension://${extId}/blocked.html?d=blocked.test`);
  await bp.waitForSelector('#unlock button');
  check('Sperrseite zeigt Freigabe mit Kontingent', /3 von 3/.test(await bp.textContent('#unlock')));
  await bp.click('#unlock button');
  await bp.waitForSelector('#unlock input');
  const pastePrevented = await bp.$eval('#unlock input', (el) => {
    const ev = new Event('paste', { cancelable: true });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  check('Einfügen ist gesperrt (bewusst tippen)', pastePrevented);
  await bp.type('#unlock input', 'ICH brauche, das jetzt WIRKLICH!');
  check('Satz stimmt (nur Buchstaben), Knopf trotzdem gesperrt bis Wartezeit vorbei', await bp.$eval('#unlock input', (e) => e.classList.contains('ok')) && (await bp.$eval('#unlock .row button', (b) => b.disabled)));
  const early = await op({ op: 'unlockConfirm', domain: 'blocked.test', phrase: 'ich brauche das jetzt wirklich' });
  check('Hintergrund erzwingt die Wartezeit (auch am UI vorbei)', early.error === 'wait');
  await bp.waitForFunction(() => !document.querySelector('#unlock .row button').disabled, null, { timeout: 15000 });
  await Promise.all([bp.waitForURL(/blocked\.test/, { timeout: 8000 }).catch(() => {}), bp.click('#unlock .row button')]);
  await sleep(500);
  check('Nach Freigabe öffnet sich die Seite', /^https:\/\/blocked\.test\//.test(bp.url()) && srv.log.some((l) => /blocked\.test/.test(l.host)), bp.url());
  r = await rules();
  check('Freigegebene Domain fehlt in der Sperrregel', !r.some((x) => (x.condition.requestDomains || []).includes('blocked.test')));
  st = await store();
  check('Kontingent gezählt (1 von 3)', st._state.used['blocked.test'] === 1);
  await op({ op: 'unlockEnd', domain: 'blocked.test' });
  await sleep(400);
  const stalled = await bp.evaluate(() => fetch('/neu').then(() => 'geladen', () => 'blockiert'));
  check('Wieder gesperrt: offener Tab lädt nichts mehr nach', stalled === 'blockiert');
  check('Wieder gesperrt: Navigation blockiert', (await tryGo('https://blocked.test/')) === 'net::ERR_BLOCKED_BY_CLIENT');
  await bp.close();

  /* ----- Zeitplan ----- */
  const nowD = new Date();
  const mins = nowD.getHours() * 60 + nowD.getMinutes();
  await op({ op: 'setSchedule', days: [0, 1, 2, 3, 4, 5, 6], start: (mins + 60) % 1440, end: (mins + 120) % 1440 });
  await op({ op: 'setFeature', key: 'schedule', value: true });
  await sleep(300);
  check('Zeitplan: außerhalb des Zeitfensters frei', (await tryGo('https://blocked.test/')) === '200');
  await op({ op: 'setFeature', key: 'schedule', value: false });
  await sleep(300);
  check('Zeitplan aus: wieder dauerhaft gesperrt', (await tryGo('https://blocked.test/')) === 'net::ERR_BLOCKED_BY_CLIENT');

  /* ----- Partner-Code über die Oberfläche ----- */
  await opt.fill('#partnerCode', 'Partner-Test-1');
  await opt.fill('#partnerCode2', 'Partner-Test-1');
  await opt.click('#partnerForm button');
  await opt.waitForSelector('#partnerOn:not([hidden])', { timeout: 10000 });
  st = await store();
  check('Partner-Code aktiv, nur als Hash gespeichert', st.settings.partner.enabled && st.settings.partner.iter === 600000 && !JSON.stringify(st).includes('Partner-Test'));
  await opt.click('#siteList button[data-value="sub2.example.test"]');
  await opt.waitForSelector('dialog.fg-dialog[open]');
  await opt.fill('dialog.fg-dialog input', 'falscher-code');
  await opt.click('dialog.fg-dialog button[type="submit"]');
  await opt.waitForFunction(() => /stimmt nicht/.test((document.querySelector('dialog.fg-dialog[open] p') || {}).textContent || ''), null, { timeout: 15000 });
  check('Falscher Code wird abgelehnt, Dialog fragt erneut', true);
  await opt.fill('dialog.fg-dialog input', 'Partner-Test-1');
  await opt.click('dialog.fg-dialog button[type="submit"]');
  await opt.waitForFunction(() => !document.querySelector('#siteList button[data-value="sub2.example.test"]'), null, { timeout: 15000 }).catch(() => {});
  st = await store();
  check('Mit richtigem Code: Lockern erlaubt', !st.settings.blockedSites.includes('sub2.example.test'));
  await opt.evaluate(() => chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: Object.assign({}, settings, { blockedSites: [], partner: { enabled: false } }) })));
  await sleep(1000);
  st = await store();
  check('Partner-Schutz repariert Speicher-Manipulation', st.settings.partner.enabled && st.settings.blockedSites.includes('blocked.test'));
  await opt.click('#partnerDisable');
  await opt.waitForSelector('dialog.fg-dialog[open]');
  await opt.fill('dialog.fg-dialog input', 'Partner-Test-1');
  await opt.click('dialog.fg-dialog button[type="submit"]');
  await opt.waitForSelector('#partnerOff:not([hidden])', { timeout: 15000 }).catch(() => {});
  check('Partner-Code mit Code deaktiviert', !(await store()).settings.partner.enabled);

  /* ----- Fokus-Sitzung ----- */
  check('Fokus nur, wenn eingeschaltet', (await op({ op: 'focusStart', minutes: 5 })).error === 'disabled');
  await op({ op: 'setFeature', key: 'focus', value: true });
  const fr = await op({ op: 'focusStart', minutes: 5 });
  check('Fokus gestartet, Freigaben pausiert', fr.ok && (await op({ op: 'unlockRequest', domain: 'blocked.test' })).error === 'focus');

  /* ----- YouTube: neue Optionen ----- */
  await op({ op: 'setYt', key: 'grayThumbnails', value: true });
  await op({ op: 'setYt', key: 'hideExplore', value: true });
  await yt.goto('https://www.youtube.com/feed/trending');
  await yt.waitForURL(/feed\/subscriptions/, { timeout: 5000 }).catch(() => {});
  check('„Erkunden/Trends“ wird zu den Abos umgeleitet', /\/feed\/subscriptions$/.test(yt.url()), yt.url());
  check('Vorschaubilder in Graustufen (Klasse gesetzt)', await yt.evaluate(() => document.documentElement.classList.contains('fg-gray')));

  /* ----- YouTube-Tageslimit ----- */
  await op({ op: 'setFeature', key: 'ytLimit', value: true });
  await op({ op: 'setYtLimit', minutes: 10 });
  await yt.goto('https://www.youtube.com/watch?v=GOOD&autoplay=1');
  await sleep(17000); // ein Messintervall (15 s)
  st = await store();
  check('Wiedergabezeit wird gemessen', st._state.ytMs >= 10000 && st._state.ytMs <= 20000, `${st._state.ytMs} ms`);
  await opt.evaluate(() => chrome.storage.local.get('_state').then(({ _state }) => chrome.storage.local.set({ _state: Object.assign({}, _state, { ytMs: 11 * 60000 }) })));
  await sleep(800);
  await yt.goto('https://www.youtube.com/watch?v=GOOD&autoplay=1');
  await sleep(1200);
  const lim = await yt.$('#fg-overlay');
  check('Tageslimit erreicht: Sperrseite, Video pausiert', !!lim && /Tageslimit/.test(await lim.innerText()) && (await yt.$eval('#player', (v) => v.paused)));
  await op({ op: 'setFeature', key: 'ytLimit', value: false });
  await yt.goto('https://www.youtube.com/watch?v=GOOD&autoplay=1');
  await sleep(1200);
  check('Limit aus: Video läuft wieder', !(await yt.$('#fg-overlay')) && !(await yt.$eval('#player', (v) => v.paused)));

  /* ----- Statistik ----- */
  st = await store();
  const today = Object.keys(st._state.stats).sort().pop();
  const sv = st._state.stats[today] || {};
  check('Statistik zählt Freigaben, Fokus, YouTube-Minuten – ohne Adressen', sv.unlocks === 1 && sv.focus === 1 && sv.ytMin >= 0 && !JSON.stringify(st._state.stats).includes('blocked.test'), JSON.stringify(sv));

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
  check('Sperrregel nach allen Angriffen aktiv', !!rule1() && rule1().condition.requestDomains.includes('blocked.test'));
  check('blocked.test weiterhin blockiert', (await tryGo('http://blocked.test/')) === 'net::ERR_BLOCKED_BY_CLIENT');
  check('Kein XSS in der Einstellungsseite', (await opt.evaluate(() => [window.__xss, document.querySelectorAll('img').length])).join() === ',1');

  /* ----- Isolation ----- */
  check('Webseite hat keinen Kanal zur Erweiterung', (await yt.evaluate(() => typeof chrome === 'undefined' || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function')) === true);
  check('Interne Logik für die Webseite unsichtbar (isolierte Welt)', (await yt.evaluate(() => typeof window.FG)) === 'undefined');

  /* ----- Netzwerk-Audit ----- */
  await sleep(1500);
  // Ausgenommen: die vom Nutzer ausgelöste Navigation "Freigeben → Seite öffnen" (keine Hintergrundanfrage)
  const outbound = extRequests.filter((x) => !x.url.startsWith(`chrome-extension://${extId}/`) && !x.url.startsWith('blob:chrome-extension://') && !(x.nav && x.url === 'https://blocked.test/'));
  check('Erweiterung: 0 Anfragen nach außen', outbound.length === 0, outbound.map((x) => x.url).join(', '));
  check('Kein Server erhielt je eine Anfrage aus der Erweiterung', !srv.log.some((l) => /chrome-extension/.test(l.origin + l.referer)));
  const seen = [...new Set(srv.log.map((l) => (l.host || '').split(':')[0]))];
  const testHosts = ['www.youtube.com', 'allowed.test', 'blocked.test']; // blocked.test: nur während Freigabe/Zeitplan
  const unexplained = seen.filter((h) => !testHosts.includes(h) && !controlHosts.has(h));
  check('Mitschnitt: kein Host, den nicht auch Chromium ohne Erweiterung kontaktiert', unexplained.length === 0, unexplained.join(', ') || 'Chromium-Eigenverkehr: ' + seen.filter((h) => !testHosts.includes(h)).join(', '));
  const relevant = consoleErrors.filter((e) => !/ERR_BLOCKED_BY_CLIENT|favicon/.test(e) && !/TrustedHTML/.test(e));
  check('Keine JS-/CSP-Fehler in Erweiterung und Seiten', relevant.length === 0, relevant.join(' | '));

  const info = await extPage.evaluate(
    (id) => new Promise((r) => chrome.developerPrivate.getExtensionInfo(id, (i) => r({ manifest: i.manifestErrors.map((e) => e.message), runtime: i.runtimeErrors.map((e) => e.message), warnings: i.installWarnings }))),
    extId
  );
  // Ausgenommen: die vom Test selbst absichtlich ausgelöste Trusted-Types-Verletzung
  info.runtime = info.runtime.filter((m) => !/TrustedHTML/.test(m));
  check('chrome://extensions: keine Manifest-Fehler, Warnungen oder Laufzeitfehler', !info.manifest.length && !info.runtime.length && !info.warnings.length, JSON.stringify(info));

  await ctx.close();
  srv.close();
  console.log(`\n${results.length - failed}/${results.length} Prüfungen bestanden`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
