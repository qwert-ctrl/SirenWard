/*
 * Gemeinsame Test-Infrastruktur für e2e.test.js und bench.js:
 *  - lokale HTTP/HTTPS-Server, die JEDE Anfrage protokollieren
 *  - nachgebautes YouTube (inkl. präparierter XSS-Titel, Endlos-Scroll und "Wiedergabe")
 *  - Chromium-Start, bei dem jeder Hostname auf die lokalen Server zeigt
 */
'use strict';
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

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const XSS = '<img src=x onerror="window.__xss=1">';

const VIDEOS = [
  { title: 'Lineare Algebra – Folge 1', handle: '@good', name: 'Good Channel' },
  { title: 'Krasser PRANK im Büro', handle: '@good', name: 'Good Channel' },
  { title: 'Normales Video', handle: '@bad', name: 'Bad Channel' },
  { title: XSS + ' Titel mit HTML', handle: '@other', name: XSS },
];

function item(tag, { title, handle, name }) {
  const blocked = handle === '@bad' || /prank/i.test(title) ? ' data-blocked="1"' : '';
  return `<${tag} class="test-item" data-title="${esc(title)}"${blocked}>
    <a id="thumbnail" href="/watch?v=${encodeURIComponent(title.slice(0, 5))}"></a>
    <a id="avatar" href="/${esc(handle)}"></a>
    <a id="video-title" href="/watch?v=x" title="${esc(title)}">${esc(title)}</a>
    <ytd-channel-name><div id="text-container"><yt-formatted-string id="text"><a href="/${esc(handle)}">${esc(name)}</a></yt-formatted-string></div></ytd-channel-name>
  </${tag}>`;
}

// Hauptwelt-Skript der Testseite: Endlos-Scroll, Wiedergabe-Simulation, Aufblitz-Zähler.
const PAGE_SCRIPT = `<script>
(() => {
  const esc = ${esc.toString()};
  const item = ${item.toString()};
  const pool = [
    { title: 'Mathe Grundlagen', handle: '@good', name: 'Good Channel' },
    { title: 'Normales Video', handle: '@bad', name: 'Bad Channel' },
    { title: 'Der große Prank', handle: '@other', name: 'Other' },
    { title: 'Physik Doku', handle: '@other', name: 'Other' },
  ];
  window.__flash = 0;
  window.__checked = 0;
  window.addItems = (n, tag = 'ytd-video-renderer') => {
    const host = document.getElementById('results') || document.getElementById('contents') || document.body;
    const tpl = document.createElement('template');
    let html = '';
    for (let i = 0; i < n; i++) html += item(tag, { ...pool[i % pool.length], title: pool[i % pool.length].title + ' #' + Math.random().toString(36).slice(2, 7) });
    tpl.innerHTML = html;
    host.append(tpl.content);
    requestAnimationFrame(() => {
      document.querySelectorAll('[data-blocked]:not([data-seen])').forEach((el) => {
        el.setAttribute('data-seen', '1');
        window.__checked++;
        const box = el.closest('ytd-rich-item-renderer') || el;
        if (getComputedStyle(box).display !== 'none') window.__flash++;
      });
    });
  };
  window.playFor = (ms) => new Promise((done) => {
    const t = document.querySelector('#movie_player .ytp-time-current');
    const bar = document.querySelector('#movie_player .ytp-progress');
    if (!t) return done();
    const start = performance.now();
    (function tick() {
      const el = performance.now() - start;
      t.textContent = (el / 1000).toFixed(2);
      const chip = document.createElement('span');
      chip.className = 'ytp-tick';
      bar.replaceChildren(chip);
      if (el < ms) requestAnimationFrame(tick); else done();
    })();
  });
})();
</script>`;

const layout = (body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>YouTube (Test)</title></head><body><ytd-app>${body}</ytd-app>${PAGE_SCRIPT}</body></html>`;

function ytPage(url) {
  const u = new URL(url, 'https://www.youtube.com');
  const n = Math.min(Number(u.searchParams.get('n')) || 0, 5000);
  if (u.pathname === '/') {
    return layout(`<ytd-browse page-subtype="home"><div id="primary">
      <ytd-rich-grid-renderer id="grid">${VIDEOS.map((v) => `<ytd-rich-item-renderer>${item('ytd-rich-grid-media', v)}</ytd-rich-item-renderer>`).join('')}
      <ytd-rich-section-renderer id="shorts-section"><ytd-rich-shelf-renderer is-shorts><a href="/shorts/ABC">Short</a></ytd-rich-shelf-renderer></ytd-rich-section-renderer>
      </ytd-rich-grid-renderer></div></ytd-browse>`);
  }
  if (u.pathname === '/results') {
    let extra = '';
    for (let i = 0; i < n; i++) extra += item('ytd-video-renderer', { ...VIDEOS[i % 3], title: VIDEOS[i % 3].title + ' ' + i });
    return layout(`<div id="results">${VIDEOS.map((v) => item('ytd-video-renderer', v)).join('')}${extra}
      <ytd-reel-shelf-renderer id="reel-shelf"><a href="/shorts/XYZ">Short</a></ytd-reel-shelf-renderer></div>`);
  }
  if (u.pathname === '/watch') {
    const v = u.searchParams.get('v') || '';
    const owner = { BAD: ['@bad', 'Bad Channel'], GOOD: ['@good', 'Good Channel'], OTHER: ['@other', 'Other Channel'] }[v] || ['@good', 'Good Channel'];
    let related = '';
    for (let i = 0; i < Math.max(1, n); i++) related += item('ytd-compact-video-renderer', VIDEOS[i % VIDEOS.length]);
    return layout(`<ytd-watch-flexy video-id="${esc(v)}"><div id="primary">
      <div id="movie_player" class="html5-video-player">
        <video id="player" src="/silence.wav" loop muted></video>
        <span class="ytp-time-current">0</span><div class="ytp-progress"></div>
        <div class="ytp-ce-element" id="endcard">Endcard</div>
        <div class="ytp-autonav-toggle-button" aria-checked="true" id="autonav"></div>
      </div>
      <ytd-watch-metadata><div id="title"><h1>Video ${esc(v)}</h1></div>
        <div id="owner"><a href="/${owner[0]}"></a><ytd-channel-name><a href="/${owner[0]}">${owner[1]}</a></ytd-channel-name></div>
      </ytd-watch-metadata>
      <ytd-comments id="comments">Kommentare</ytd-comments>
    </div><div id="secondary"><div id="related">${related}</div></div></ytd-watch-flexy>
    <script>document.getElementById('autonav').addEventListener('click', e => e.target.setAttribute('aria-checked','false'));</script>
    ${u.searchParams.get('autoplay') ? '<script>document.getElementById("player").play().catch(() => {});</script>' : ''}`);
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

async function startServers() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-test-'));
  execSync(`openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=www.youtube.com" -addext "subjectAltName=DNS:www.youtube.com,DNS:*.test" -keyout ${tmp}/key.pem -out ${tmp}/cert.pem 2>/dev/null`);
  const log = [];
  const WAV = silenceWav();
  const handler = (scheme) => (req, res) => {
    log.push({ scheme, host: req.headers.host, url: req.url, method: req.method, origin: req.headers.origin || '', referer: req.headers.referer || '' });
    if (req.url === '/silence.wav') {
      res.writeHead(200, { 'content-type': 'audio/wav' });
      return res.end(WAV);
    }
    const host = (req.headers.host || '').split(':')[0];
    const page = host === 'www.youtube.com' ? ytPage(req.url) : null;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page || `<!doctype html><title>${esc(host)}</title><h1>Testseite ${esc(host)}</h1>`);
  };
  const a = http.createServer(handler('http')).listen(80);
  const b = https.createServer({ key: fs.readFileSync(`${tmp}/key.pem`), cert: fs.readFileSync(`${tmp}/cert.pem`) }, handler('https')).listen(443);
  await Promise.all([new Promise((r) => a.once('listening', r)), new Promise((r) => b.once('listening', r))]);
  return { tmp, log, close: () => { a.close(); b.close(); } };
}

/** @param opts { lang?: 'en'|'de', colorScheme?: 'light'|'dark' } */
function launch(tmp, profile, extDir, opts = {}) {
  const lang = opts.lang || 'en';
  return chromium.launchPersistentContext(path.join(tmp, profile), {
    channel: 'chromium',
    headless: true,
    ignoreHTTPSErrors: true,
    locale: lang === 'de' ? 'de-DE' : 'en-US',
    colorScheme: opts.colorScheme || 'light',
    // Chromium unter Linux wählt die Oberflächensprache (und damit _locales) über LANGUAGE
    env: Object.assign({}, process.env, { LANGUAGE: lang, LANG: lang === 'de' ? 'de_DE.UTF-8' : 'en_US.UTF-8' }),
    args: [
      `--lang=${lang === 'de' ? 'de' : 'en-US'}`,
      ...(extDir ? [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`] : []),
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
}

async function extensionId(ctx) {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
  return { sw, id: new URL(sw.url()).host };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { chromium, startServers, launch, extensionId, sleep, esc, XSS, VIDEOS };
