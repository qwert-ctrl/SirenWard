/*
 * End-to-End- und Sicherheitstest in echtem Chromium (Playwright).
 *
 *   node tests/e2e.test.js
 *
 * Voraussetzungen: npm-Paket "playwright" mit Chromium, openssl, Ports 80/443 frei (root/Container).
 *
 * Jeder Hostname wird per --host-resolver-rules auf lokale Server umgebogen, die JEDE Anfrage
 * protokollieren. Funkt die Erweiterung irgendwohin, steht es im Protokoll. YouTube ist eine
 * nachgebaute Seite (inkl. präparierter XSS-Titel), es wird kein echtes Netz benötigt.
 */
'use strict';
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { execSync } = require('child_process');
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require(execSync('npm root -g').toString().trim() + '/playwright'));
}

const EXT = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-e2e-'));
const results = [];
const serverLog = [];
let failed = 0;

function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  if (!cond) failed++;
  console.log(`${cond ? '✔' : '✘'} ${name}${detail ? '  — ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- Nachgebautes YouTube ---------------- */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const XSS = '<img src=x onerror="window.__xss=1">';

function item(tag, { title, handle, name }) {
  return `<${tag} class="test-item" data-title="${esc(title)}">
    <a id="thumbnail" href="/watch?v=${encodeURIComponent(title.slice(0, 5))}"></a>
    <a id="avatar" href="/${esc(handle)}"></a>
    <a id="video-title" href="/watch?v=x" title="${esc(title)}">${esc(title)}</a>
    <ytd-channel-name><div id="text-container"><yt-formatted-string id="text"><a href="/${esc(handle)}">${esc(name)}</a></yt-formatted-string></div></ytd-channel-name>
  </${tag}>`;
}
const VIDEOS = [
  { title: 'Lineare Algebra – Folge 1', handle: '@good', name: 'Good Channel' },
  { title: 'Krasser PRANK im Büro', handle: '@good', name: 'Good Channel' },
  { title: 'Normales Video', handle: '@bad', name: 'Bad Channel' },
  { title: XSS + ' Titel mit HTML', handle: '@other', name: XSS },
];
const layout = (body) => `<!doctype html><html><head><meta charset="utf-8"><title>YouTube (Test)</title></head><body><ytd-app>${body}</ytd-app></body></html>`;

function ytPage(url) {
  const u = new URL(url, 'https://www.youtube.com');
  if (u.pathname === '/') {
    return layout(`<ytd-browse page-subtype="home"><div id="primary">
      <ytd-rich-grid-renderer id="grid">${VIDEOS.map((v) => `<ytd-rich-item-renderer>${item('ytd-rich-grid-media', v)}</ytd-rich-item-renderer>`).join('')}
      <ytd-rich-section-renderer id="shorts-section"><ytd-rich-shelf-renderer is-shorts><a href="/shorts/ABC">Short</a></ytd-rich-shelf-renderer></ytd-rich-section-renderer>
      </ytd-rich-grid-renderer></div></ytd-browse>`);
  }
  if (u.pathname === '/results') {
    return layout(`<div id="results">${VIDEOS.map((v) => item('ytd-video-renderer', v)).join('')}
      <ytd-reel-shelf-renderer id="reel-shelf"><a href="/shorts/XYZ">Short</a></ytd-reel-shelf-renderer></div>`);
  }
  if (u.pathname === '/watch') {
    const v = u.searchParams.get('v') || '';
    const owner = { BAD: ['@bad', 'Bad Channel'], GOOD: ['@good', 'Good Channel'], OTHER: ['@other', 'Other Channel'] }[v] || ['@good', 'Good Channel'];
    return layout(`<ytd-watch-flexy video-id="${esc(v)}"><div id="primary">
      <video id="player" src="/silence.wav" loop muted></video>
      <ytd-watch-metadata><div id="title"><h1>Video ${esc(v)}</h1></div>
        <div id="owner"><a href="/${owner[0]}"></a><ytd-channel-name><a href="/${owner[0]}">${owner[1]}</a></ytd-channel-name></div>
      </ytd-watch-metadata>
      <ytd-comments id="comments">Kommentare</ytd-comments>
      <div class="ytp-ce-element" id="endcard">Endcard</div>
      <div class="ytp-autonav-toggle-button" aria-checked="true" id="autonav"></div>
    </div><div id="secondary"><div id="related">${item('ytd-compact-video-renderer', VIDEOS[0])}</div></div></ytd-watch-flexy>
    <script>document.getElementById('autonav').addEventListener('click', e => e.target.setAttribute('aria-checked','false'));</script>`);
  }
  const ch = u.pathname.match(/^\/(@[^/]+)/);
  if (ch) {
    return layout(`<yt-page-header-view-model><h1>${esc(ch[1])}</h1></yt-page-header-view-model>
      <div id="contents">${item('ytd-grid-video-renderer', { title: 'Kanalvideo', handle: ch[1], name: ch[1] })}</div>`);
  }
  if (u.pathname.startsWith('/shorts/')) return layout('<div id="shorts-player">Shorts</div>');
  return null;
}

function silenceWav() {
  const n = 8000;
  const b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(8000, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36);
  b.writeUInt32LE(n, 40); b.fill(128, 44);
  return b;
}
const WAV = silenceWav();

function handler(scheme) {
  return (req, res) => {
    serverLog.push({ scheme, host: req.headers.host, url: req.url, method: req.method, origin: req.headers.origin || '', referer: req.headers.referer || '', ua: req.headers['user-agent'] || '' });
    if (req.url === '/silence.wav') {
      res.writeHead(200, { 'content-type': 'audio/wav' });
      return res.end(WAV);
    }
    const host = (req.headers.host || '').split(':')[0];
    if (host === 'www.youtube.com') {
      const page = ytPage(req.url);
      if (page) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(page);
      }
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${esc(host)}</title><h1>Testseite ${esc(host)}</h1>`);
  };
}

/* ---------------- Ablauf ---------------- */
(async () => {
  execSync(`openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=www.youtube.com" -addext "subjectAltName=DNS:www.youtube.com,DNS:*.test" -keyout ${tmp}/key.pem -out ${tmp}/cert.pem 2>/dev/null`);
  const httpSrv = http.createServer(handler('http')).listen(80);
  const httpsSrv = https.createServer({ key: fs.readFileSync(`${tmp}/key.pem`), cert: fs.readFileSync(`${tmp}/cert.pem`) }, handler('https')).listen(443);

  const launch = (profile, withExt) =>
    chromium.launchPersistentContext(path.join(tmp, profile), {
      channel: 'chromium',
      headless: true,
      ignoreHTTPSErrors: true,
      args: [
        ...(withExt ? [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] : []),
        '--host-resolver-rules=MAP * 127.0.0.1',
        '--no-proxy-server',
        '--ignore-certificate-errors',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-background-networking',
        '--disable-component-update',
        '--disable-sync',
        '--disable-default-apps',
        '--no-first-run',
        '--metrics-recording-only',
      ],
    });

  /* ----- Kontrolllauf OHNE Erweiterung: misst Chromiums eigenen Hintergrundverkehr ----- */
  {
    const c = await launch('control', false);
    const p = await c.newPage();
    for (const u of ['http://allowed.test/', 'https://www.youtube.com/', 'https://www.youtube.com/watch?v=GOOD']) {
      await p.goto(u).catch(() => {});
      await sleep(1500);
    }
    await sleep(8000);
    await c.close();
  }
  const controlHosts = new Set(serverLog.map((l) => (l.host || '').split(':')[0]));
  serverLog.length = 0;

  const ctx = await launch('profile', true);

  const extRequests = [];
  const consoleErrors = [];
  ctx.on('request', (r) => {
    const u = r.url();
    const frameUrl = (() => {
      try { return r.frame() ? r.frame().url() : ''; } catch { return 'serviceworker'; }
    })();
    if (u.startsWith('chrome-extension://') || frameUrl.startsWith('chrome-extension://') || frameUrl === 'serviceworker') {
      extRequests.push({ url: u, from: frameUrl });
    }
  });
  const watchPage = (p, label) => {
    p.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`${label}: ${m.text()}`); });
    p.on('pageerror', (e) => consoleErrors.push(`${label}: ${e.message}`));
  };

  let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
  const extId = new URL(sw.url()).host;
  check('Erweiterung lädt, Service Worker läuft', !!extId, extId);

  const getStore = (page) => page.evaluate(() => chrome.storage.local.get(null));
  // Die CSP der Erweiterung verbietet eval/new Function – Änderungen werden deshalb in Node berechnet.
  const setSettings = async (page, mutate) => {
    const s = await page.evaluate(() => FG.load());
    mutate(s);
    await page.evaluate((v) => FG.save(v), s);
  };
  const rules = () => sw.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());

  /* ----- Einstellungsseite ----- */
  const opt = await ctx.newPage();
  watchPage(opt, 'options');
  await opt.goto(`chrome-extension://${extId}/options.html`);
  await opt.waitForSelector('#ytToggles .toggle');
  check('Einstellungsseite rendert', (await opt.locator('#ytToggles .toggle').count()) === 7);

  await opt.fill('#siteInput', 'https://www.blocked.test/irgendwas, sub2.example.test');
  await opt.click('#siteForm button');
  await sleep(600);
  let store = await getStore(opt);
  check('Websites per Formular hinzugefügt & normalisiert', JSON.stringify(store.settings.blockedSites) === '["blocked.test","sub2.example.test"]', JSON.stringify(store.settings.blockedSites));

  await opt.fill('#siteInput', '<img src=x onerror=alert(1)>');
  await opt.click('#siteForm button');
  await sleep(300);
  store = await getStore(opt);
  const valid = await opt.$eval('#siteInput', (e) => e.validity.valid);
  check('Ungültige/bösartige Domain wird abgelehnt', store.settings.blockedSites.length === 2 && !valid);

  let r = await rules();
  check('Sperrregel im Browser aktiv (declarativeNetRequest)', r.length === 1 && r[0].action.type === 'block' && r[0].condition.requestDomains.includes('blocked.test'));

  /* ----- Website-Sperre ----- */
  // Jede Prüfung in einem frischen Tab (Navigation weg von einer Chrome-Fehlerseite meldet Playwright sonst als "unterbrochen").
  const tryGo = async (url) => {
    const p = await ctx.newPage();
    watchPage(p, 'nav');
    try { const resp = await p.goto(url, { timeout: 8000 }); return resp ? String(resp.status()) : 'none'; }
    catch (e) { return (e.message.match(/net::[A-Z_]+/) || [e.message.split('\n')[0]])[0]; }
    finally { await p.close(); }
  };
  check('blocked.test wird blockiert', (await tryGo('http://blocked.test/')) === 'net::ERR_BLOCKED_BY_CLIENT');
  check('Subdomain www.blocked.test wird blockiert', (await tryGo('https://www.blocked.test/')) === 'net::ERR_BLOCKED_BY_CLIENT');
  const allowedRes = await tryGo('http://allowed.test/');
  check('Andere Seite (allowed.test) lädt normal', allowedRes === '200', allowedRes);
  check('Gesperrte Domain hat den Server nie erreicht', !serverLog.some((l) => /blocked\.test/.test(l.host)));

  /* ----- YouTube: Ansicht ----- */
  const yt = await ctx.newPage();
  watchPage(yt, 'youtube');
  await yt.goto('https://www.youtube.com/');
  await sleep(800);
  const hidden = (sel) => yt.$eval(sel, (e) => getComputedStyle(e).display === 'none').catch(() => 'fehlt');
  check('Startseiten-Feed ausgeblendet', (await hidden('#grid')) === true);
  check('Shorts-Regal ausgeblendet', (await hidden('#shorts-section')) === true);
  check('Hinweis statt Feed', (await yt.$eval('#primary', (e) => getComputedStyle(e, '::before').content)).includes('Startseite ausgeblendet'));

  /* ----- YouTube: Filter + XSS ----- */
  await setSettings(opt, (s) => { s.filter.blockedChannels.push('@bad'); s.filter.blockedKeywords.push('prank'); });
  await yt.goto('https://www.youtube.com/results?search_query=test');
  await sleep(900);
  const vis = await yt.$$eval('ytd-video-renderer', (els) => els.map((e) => [e.dataset.title, getComputedStyle(e).display !== 'none']));
  const visible = Object.fromEntries(vis);
  check('Erlaubtes Video sichtbar', visible['Lineare Algebra – Folge 1'] === true);
  check('Stichwort-Filter ("prank") greift', visible['Krasser PRANK im Büro'] === false);
  check('Kanal-Filter (@bad) greift', visible['Normales Video'] === false);
  check('Shorts in Suchergebnissen ausgeblendet', (await hidden('#reel-shelf')) === true);
  const xss = await yt.evaluate(() => [window.__xss, document.querySelectorAll('img').length]);
  check('Kein XSS: präparierte Titel bleiben Text', xss[0] === undefined && xss[1] === 0, `__xss=${xss[0]}, img=${xss[1]}`);

  /* ----- Videoseite gesperrter Kanal ----- */
  await yt.goto('https://www.youtube.com/watch?v=BAD');
  await sleep(1200);
  const ov = await yt.$('#fg-overlay');
  check('Sperrseite bei gesperrtem Kanal', !!ov, ov ? await ov.innerText() : '');
  await yt.evaluate(() => document.getElementById('player').play().catch(() => {}));
  await sleep(500);
  check('Video bleibt pausiert, auch wenn es neu startet', await yt.$eval('#player', (v) => v.paused));
  check('Kommentare/Endcards/Empfehlungen ausgeblendet', (await hidden('#endcard')) === true && (await hidden('#related')) === true);
  check('Autoplay wurde abgeschaltet', (await yt.$eval('#autonav', (e) => e.getAttribute('aria-checked'))) === 'false');
  const ovHtml = ov ? await ov.innerHTML() : '';
  check('Sperrseite enthält keine Seitendaten/Links', !/href|<img|<script/i.test(ovHtml));

  await yt.goto('https://www.youtube.com/watch?v=GOOD');
  await sleep(1000);
  check('Video eines erlaubten Kanals läuft ohne Sperre', !(await yt.$('#fg-overlay')));

  await yt.goto('https://www.youtube.com/shorts/XYZ');
  await yt.waitForURL(/watch\?v=XYZ/, { timeout: 5000 }).catch(() => {});
  check('Shorts-Link wird zum normalen Video umgeleitet', /\/watch\?v=XYZ$/.test(yt.url()), yt.url());

  /* ----- Strikter Modus (Whitelist) ----- */
  await setSettings(opt, (s) => { s.filter.mode = 'whitelist'; s.filter.allowedChannels = ['@good']; s.filter.blockedChannels = []; s.filter.blockedKeywords = []; });
  await yt.goto('https://www.youtube.com/watch?v=OTHER');
  await sleep(1200);
  const ov2 = await yt.$('#fg-overlay');
  check('Strikter Modus: fremder Kanal gesperrt', !!ov2 && /Erlaubt-Liste/.test(await ov2.innerText()));
  await yt.goto('https://www.youtube.com/@good');
  await sleep(900);
  check('Strikter Modus: erlaubte Kanalseite frei', !(await yt.$('#fg-overlay')));
  await yt.goto('https://www.youtube.com/results?search_query=x');
  await sleep(900);
  const wl = Object.fromEntries(await yt.$$eval('ytd-video-renderer', (els) => els.map((e) => [e.dataset.title, getComputedStyle(e).display !== 'none'])));
  check('Strikter Modus: nur erlaubte Kanäle in Suche', wl['Lineare Algebra – Folge 1'] === true && wl['Normales Video'] === false && Object.values(wl).filter(Boolean).length === 2);

  /* ----- Sperrmodus & Manipulationsversuche ----- */
  opt.once('dialog', (d) => d.accept());
  await opt.selectOption('#lockDuration', '3600000');
  await opt.click('#lockBtn');
  await sleep(800);
  store = await getStore(opt);
  check('Sperrmodus aktiviert', store.settings.lockUntil > Date.now() && !!store._lockSnapshot);
  const removeDisabled = await opt.$$eval('#siteList button', (b) => b.every((x) => x.disabled));
  check('UI: Entfernen während der Sperre deaktiviert', removeDisabled);

  // Angriff 1: Einstellungen direkt im Speicher lockern (wie per DevTools)
  await opt.evaluate(() => chrome.storage.local.set({ settings: { blockedSites: [], yt: {}, filter: { mode: 'blacklist' }, lockUntil: 0 } }));
  await sleep(1200);
  store = await getStore(opt);
  check('Manipulation 1 (Speicher überschreiben) wird zurückgedreht',
    store.settings.blockedSites.includes('blocked.test') && store.settings.lockUntil > Date.now() && store.settings.filter.mode === 'whitelist');

  // Angriff 2: kompletten Speicher löschen
  await opt.evaluate(() => chrome.storage.local.clear());
  await sleep(1200);
  store = await getStore(opt);
  check('Manipulation 2 (Speicher löschen) wird zurückgedreht', store.settings && store.settings.blockedSites.includes('blocked.test') && store.settings.lockUntil > Date.now());

  // Angriff 3: Sperre verkürzen
  await opt.evaluate(async () => { const s = await FG.load(); s.lockUntil = Date.now() + 1000; await FG.save(s); });
  await sleep(1000);
  store = await getStore(opt);
  check('Manipulation 3 (Sperre verkürzen) wird zurückgedreht', store.settings.lockUntil > Date.now() + 3000 * 1000);

  // Angriff 4: bösartiger Import (Prototype Pollution, XSS, Riesenliste)
  const evil = path.join(tmp, 'evil.json');
  fs.writeFileSync(evil, JSON.stringify({
    __proto__: { polluted: 1 },
    settings: {
      blockedSites: [...Array.from({ length: 5000 }, (_, i) => `x${i}.test`), '<script>alert(1)</script>'],
      yt: { hideHome: false, constructor: { prototype: { polluted: 1 } } },
      filter: { mode: 'blacklist', blockedChannels: [XSS], allowedChannels: ['@evil'] },
      lockUntil: 0,
    },
  }).replace('"settings"', '"__proto__":{"polluted":1},"settings"'));
  await opt.setInputFiles('#importInput', evil);
  await sleep(1500);
  store = await getStore(opt);
  const polluted = await opt.evaluate(() => ({}).polluted);
  check('Bösartiger Import: keine Prototype Pollution', polluted === undefined);
  check('Bösartiger Import: Listen begrenzt & bereinigt', store.settings.blockedSites.length <= 2000 && !store.settings.blockedSites.some((d) => /</.test(d)));
  check('Bösartiger Import: Sperre bleibt (Whitelist, kein @evil, hideHome an)',
    store.settings.filter.mode === 'whitelist' && !store.settings.filter.allowedChannels.includes('@evil') && store.settings.yt.hideHome === true);
  r = await rules();
  check('Sperrregel nach allen Angriffen weiterhin aktiv', r.length === 1 && r[0].condition.requestDomains.includes('blocked.test'));
  check('blocked.test weiterhin blockiert', (await tryGo('http://blocked.test/')) === 'net::ERR_BLOCKED_BY_CLIENT');
  const xssInOptions = await opt.evaluate(() => [window.__xss, document.querySelectorAll('img').length]);
  check('Kein XSS in der Einstellungsseite (Kanalname mit HTML)', xssInOptions[0] === undefined && xssInOptions[1] === 1, `img=${xssInOptions[1]} (nur Logo)`);

  /* ----- Popup ----- */
  const pop = await ctx.newPage();
  watchPage(pop, 'popup');
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  await sleep(500);
  check('Popup rendert ohne Fehler', (await pop.locator('#optionsBtn').count()) === 1);

  /* ----- Webseite kann nicht mit der Erweiterung sprechen ----- */
  const canTalk = await yt.evaluate((id) => {
    try { return typeof chrome !== 'undefined' && !!chrome.runtime && typeof chrome.runtime.sendMessage === 'function' && !!id; }
    catch { return false; }
  }, extId);
  check('Webseite hat keinen Kanal zur Erweiterung (kein externally_connectable)', canTalk === false);
  const fgLeak = await yt.evaluate(() => typeof window.FG);
  check('Interne Logik ist für die Webseite unsichtbar (isolierte Welt)', fgLeak === 'undefined');

  /* ----- Netzwerk-Audit ----- */
  await sleep(1500);
  const extLocal = extRequests.filter((x) => !x.url.startsWith(`chrome-extension://${extId}/`) && !x.url.startsWith('blob:chrome-extension://'));
  check('Erweiterungsseiten/Service Worker: 0 Anfragen nach außen', extLocal.length === 0, extLocal.map((x) => x.url).join(', '));
  const fromExt = serverLog.filter((l) => /chrome-extension/.test(l.origin + l.referer));
  check('Kein Server hat je eine Anfrage aus der Erweiterung erhalten', fromExt.length === 0);
  const seenHosts = [...new Set(serverLog.map((l) => (l.host || '').split(':')[0]))];
  const testHosts = ['www.youtube.com', 'allowed.test'];
  const browserNoise = seenHosts.filter((h) => !testHosts.includes(h) && controlHosts.has(h));
  const unexplained = seenHosts.filter((h) => !testHosts.includes(h) && !controlHosts.has(h));
  check('Mitschnitt: kein Host, den nicht auch Chromium ohne Erweiterung kontaktiert', unexplained.length === 0,
    unexplained.length ? 'unerklärt: ' + unexplained.join(', ') : 'Chromium-Eigenverkehr (auch ohne Erweiterung): ' + (browserNoise.join(', ') || '–'));
  const relevantErrors = consoleErrors.filter((e) => !/ERR_BLOCKED_BY_CLIENT|favicon/.test(e));
  check('Keine JS-/CSP-Fehler in Erweiterung und Seiten', relevantErrors.length === 0, relevantErrors.join(' | '));

  await ctx.close();
  httpSrv.close();
  httpsSrv.close();

  const hosts = {};
  for (const l of serverLog) hosts[l.host] = (hosts[l.host] || 0) + 1;
  console.log('\nNetzwerk-Mitschnitt (alle Anfragen, die irgendeinen Server erreicht haben):');
  for (const [h, n] of Object.entries(hosts)) console.log(`  ${h}: ${n}`);
  console.log(`\n${results.length - failed}/${results.length} Prüfungen bestanden`);
  fs.writeFileSync(path.join(tmp, 'results.json'), JSON.stringify({ results, serverLog, extRequests }, null, 2));
  console.log('Details:', path.join(tmp, 'results.json'));
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
