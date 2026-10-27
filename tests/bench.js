/*
 * Performance-Benchmark in echtem Chromium.
 *   node tests/bench.js [ordnerA] [ordnerB] ...   (Standard: dieser Ordner)
 *
 * Misst für jede Version die ZUSÄTZLICHE Skriptzeit gegenüber Chromium ohne Erweiterung:
 *   1. Seitenaufbau: Suchseite mit 1.500 Videos
 *   2. Endlos-Scroll: 30 × 40 neue Videos
 *   3. Videowiedergabe: 8 s Player-Updates (Zeit/Fortschritt) bei 300 Empfehlungen
 * und zählt, wie oft ein gesperrtes Video beim ersten Bild sichtbar war ("Aufblitzen").
 */
'use strict';
const path = require('path');
const { startServers, launch, extensionId, sleep } = require('./lib/harness');

const RUNS = Number(process.env.BENCH_RUNS || 3);
const SETTINGS = {
  blockedSites: [],
  yt: { hideHome: true, redirectHomeToSubs: false, hideRecommendations: true, hideShorts: true, hideComments: false, hideEndscreen: true, disableAutoplay: true },
  filter: { mode: 'blacklist', blockedChannels: ['@bad'], blockedKeywords: ['prank'], allowedChannels: [] },
  lockUntil: 0,
};

async function metric(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  return m.ScriptDuration * 1000;
}

async function runOnce(srv, extDir, label) {
  const ctx = await launch(srv.tmp, `bench-${label}-${Date.now()}`, extDir);
  if (extDir) {
    const { id } = await extensionId(ctx);
    const opt = await ctx.newPage();
    await opt.goto(`chrome-extension://${id}/options.html`);
    await opt.evaluate((s) => chrome.storage.local.set({ settings: s }), SETTINGS);
    await sleep(800);
    await opt.close();
  }
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Performance.enable');
  const out = {};

  // Aufwärmen: gleiche Origin, damit die Messung im selben Renderer-Prozess bleibt
  await page.goto('https://www.youtube.com/@warmup');
  await sleep(800);

  // 1. Seitenaufbau
  let t0 = await metric(cdp);
  await page.goto('https://www.youtube.com/results?search_query=x&n=1500');
  await sleep(1500);
  out.load = (await metric(cdp)) - t0;

  // 2. Endlos-Scroll
  t0 = await metric(cdp);
  for (let i = 0; i < 30; i++) {
    await page.evaluate(() => window.addItems(40));
    await sleep(60);
  }
  await sleep(500);
  out.scroll = (await metric(cdp)) - t0;
  out.flash = await page.evaluate(() => window.__flash);
  out.checked = await page.evaluate(() => window.__checked);

  // 3. Wiedergabe
  await page.goto('https://www.youtube.com/watch?v=GOOD&n=300');
  await sleep(1200);
  t0 = await metric(cdp);
  await page.evaluate(() => window.playFor(8000));
  out.play = (await metric(cdp)) - t0;

  await ctx.close();
  return out;
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

(async () => {
  const dirs = process.argv.slice(2).length ? process.argv.slice(2) : [path.resolve(__dirname, '..')];
  const srv = await startServers();
  const variants = [['ohne Erweiterung', null], ...dirs.map((d) => [path.basename(path.resolve(d, '..')) + '/' + path.basename(d), path.resolve(d)])];
  const res = {};
  for (let r = 0; r < RUNS; r++) {
    for (const [label, dir] of variants) {
      const o = await runOnce(srv, dir, label.replace(/\W/g, '_'));
      (res[label] ||= []).push(o);
    }
  }
  srv.close();
  const base = res['ohne Erweiterung'];
  const med = (arr, k) => median(arr.map((x) => x[k]));
  console.log(`\nZusätzliche Skriptzeit gegenüber Chromium ohne Erweiterung (Median aus ${RUNS} Läufen, ms):\n`);
  console.log('Version'.padEnd(34), 'Seitenaufbau'.padStart(13), 'Endlos-Scroll'.padStart(14), 'Wiedergabe 8s'.padStart(14), 'Aufblitzen'.padStart(12));
  const summary = {};
  for (const [label] of variants.slice(1)) {
    const row = { load: med(res[label], 'load') - med(base, 'load'), scroll: med(res[label], 'scroll') - med(base, 'scroll'), play: med(res[label], 'play') - med(base, 'play'), flash: med(res[label], 'flash'), checked: med(res[label], 'checked') };
    summary[label] = row;
    console.log(label.padEnd(34), row.load.toFixed(1).padStart(13), row.scroll.toFixed(1).padStart(14), row.play.toFixed(1).padStart(14), `${row.flash}/${row.checked}`.padStart(12));
  }
  console.log('\n(Basis ohne Erweiterung: Seitenaufbau', med(base, 'load').toFixed(1), 'ms · Scroll', med(base, 'scroll').toFixed(1), 'ms · Wiedergabe', med(base, 'play').toFixed(1), 'ms)');
  console.log(JSON.stringify(summary));
})().catch((e) => { console.error(e); process.exit(2); });
