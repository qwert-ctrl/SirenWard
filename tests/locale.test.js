/*
 * Sprachtest in echtem Chromium: Oberfläche auf Englisch und Deutsch.
 *   node tests/locale.test.js [erweiterungsordner]
 * Prüft je Sprache: richtige Sprache gewählt, keine unübersetzten Schlüssel sichtbar,
 * Abtipp-Satz der Neuinstallation in dieser Sprache, YouTube-Texte übersetzt, keine Fehler.
 */
'use strict';
const path = require('path');
const { startServers, launch, extensionId, sleep } = require('./lib/harness');
const catalog = require('../tools/messages.js');

const EXT = path.resolve(process.argv[2] || path.join(__dirname, '..'));
let failed = 0;
const check = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '✔' : '✘'} ${name}${detail ? '  — ' + detail : ''}`);
};
const KEYS = new Set(Object.keys(catalog));

(async () => {
  const srv = await startServers();
  for (const [lang, idx] of [['en', 0], ['de', 1]]) {
    const ctx = await launch(srv.tmp, 'loc-' + lang, EXT, { lang });
    const { id } = await extensionId(ctx);
    const errors = [];
    const watch = (p, l) => {
      p.on('pageerror', (e) => errors.push(l + ': ' + e.message));
      p.on('console', (m) => m.type() === 'error' && errors.push(l + ': ' + m.text()));
    };
    /** Sichtbarer Text + übersetzte Attribute; meldet rohe Schlüssel */
    const rawKeys = (p) =>
      p.evaluate((keys) => {
        const found = [];
        for (const el of document.querySelectorAll('[data-i18n], [data-i18n-placeholder], [data-i18n-aria-label], [data-i18n-title]')) {
          for (const [a, v] of [['data-i18n', el.textContent], ['data-i18n-placeholder', el.placeholder], ['data-i18n-aria-label', el.getAttribute('aria-label')], ['data-i18n-title', el.title]]) {
            if (el.hasAttribute(a) && (!v || keys.includes(v))) found.push(el.getAttribute(a));
          }
        }
        return found;
      }, [...KEYS]);

    const opt = await ctx.newPage();
    watch(opt, 'options');
    await opt.goto(`chrome-extension://${id}/options.html`);
    await opt.waitForSelector('#ytToggles .toggle', { state: 'attached' });
    check(`[${lang}] Seite in der richtigen Sprache`, (await opt.evaluate(() => document.documentElement.lang)) === lang);
    check(`[${lang}] Seitenleiste übersetzt`, (await opt.textContent('#nav a[href="#unlock"]')).trim() === catalog.unlockTitle[idx]);
    const missing = await rawKeys(opt);
    check(`[${lang}] Einstellungen: keine unübersetzten Texte`, missing.length === 0, missing.join(', '));
    const st = await opt.evaluate(() => chrome.storage.local.get('settings'));
    check(`[${lang}] Abtipp-Satz der Neuinstallation in dieser Sprache`, st.settings.unlock.phrase === catalog.defaultUnlockPhrase[idx], st.settings.unlock.phrase);
    const yt = await opt.textContent('#ytToggles .toggle .title');
    check(`[${lang}] Dynamisch erzeugte Zeilen übersetzt`, yt === catalog.yt_hideHome[idx], yt);

    const pop = await ctx.newPage();
    watch(pop, 'popup');
    await pop.goto(`chrome-extension://${id}/popup.html`);
    await sleep(400);
    const pm = await rawKeys(pop);
    check(`[${lang}] Popup: keine unübersetzten Texte`, pm.length === 0, pm.join(', '));

    await opt.evaluate(() => FGClient.op({ op: 'add', list: 'blockedSites', values: ['blocked.test'] }, { interactive: false }));
    const bp = await ctx.newPage();
    watch(bp, 'sperrseite');
    await bp.goto(`chrome-extension://${id}/blocked.html?d=blocked.test`);
    await bp.waitForSelector('#unlock button');
    const bm = await rawKeys(bp);
    check(`[${lang}] Sperrseite übersetzt`, bm.length === 0 && (await bp.textContent('#title')) === catalog.siteIsBlocked[idx].replace('$1', 'blocked.test'), await bp.textContent('#title'));

    // YouTube: Startseiten-Hinweis und Sperrgrund
    await opt.evaluate(() => FGClient.op({ op: 'add', list: 'blockedChannels', values: ['@bad'] }, { interactive: false }));
    const y = await ctx.newPage();
    watch(y, 'youtube');
    await y.goto('https://www.youtube.com/');
    await sleep(700);
    const home = await y.$eval('#primary', (e) => getComputedStyle(e, '::before').content);
    check(`[${lang}] YouTube-Hinweis übersetzt`, home === JSON.stringify(catalog.ytHomeHidden[idx]), home);
    await y.goto('https://www.youtube.com/watch?v=BAD');
    await sleep(1200);
    const ov = await y.$('#fg-overlay');
    const txt = ov ? await ov.innerText() : '';
    check(`[${lang}] YouTube-Sperrseite übersetzt`, txt.includes(catalog.yt_reason_channel[idx]) && txt.includes(catalog.ytBlockedBy[idx]), txt.replace(/\s+/g, ' '));

    const relevant = errors.filter((e) => !/ERR_BLOCKED_BY_CLIENT|favicon/.test(e));
    check(`[${lang}] keine Fehler`, relevant.length === 0, relevant.join(' | '));
    await ctx.close();
  }
  srv.close();
  console.log(failed ? `\n${failed} Fehler` : '\nAlle Sprachprüfungen bestanden');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
