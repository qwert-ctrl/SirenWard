/* FocusGuard – Popup. Kennt nur den aktiven Tab (activeTab), und nur solange das Popup offen ist. */
(async () => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const say = (msg) => ($('status').textContent = msg);
  const fmt = (ms) =>
    new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(ms));

  let s = await FG.load();

  if (FG.isLocked(s)) {
    $('lockPill').hidden = false;
    $('lockPill').textContent = '🔒 bis ' + fmt(s.lockUntil);
  }

  $('optionsBtn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    /* kein Zugriff */
  }
  let url = null;
  try {
    url = tab && tab.url ? new URL(tab.url) : null;
  } catch {
    url = null;
  }
  if (!url || !/^https?:$/.test(url.protocol)) return;

  /* ----- Website sperren ----- */
  const domain = FG.normalizeDomain(url.hostname);
  if (domain) {
    $('siteBox').hidden = false;
    $('siteName').textContent = domain;
    const covered = () => s.blockedSites.some((d) => domain === d || domain.endsWith('.' + d));
    if (covered()) {
      $('blockSiteBtn').disabled = true;
      $('blockSiteBtn').textContent = 'Gesperrt';
    }
    $('blockSiteBtn').addEventListener('click', async () => {
      s = await FG.load();
      if (!covered()) s.blockedSites.push(domain);
      await FG.save(s);
      $('blockSiteBtn').disabled = true;
      $('blockSiteBtn').textContent = 'Gesperrt';
      say(domain + ' ist ab jetzt gesperrt.');
      if (tab.id != null) chrome.tabs.reload(tab.id);
    });
  }

  /* ----- YouTube-Kanal sperren/erlauben ----- */
  if (url.hostname !== 'www.youtube.com' || tab.id == null) return;
  let ctx = null;
  try {
    ctx = await chrome.tabs.sendMessage(tab.id, { type: 'fg:context' });
  } catch {
    ctx = null; // Seite noch nicht bereit
  }
  if (!ctx || !(ctx.id || ctx.name)) return;

  const entries = FG.uniq([ctx.id, FG.normalizeChannel(ctx.name)].filter(Boolean));
  $('ytBox').hidden = false;
  $('channelName').textContent = ctx.name || ctx.id;

  const isBlocked = () => entries.some((e) => s.filter.blockedChannels.includes(e));
  const isAllowed = () => entries.some((e) => s.filter.allowedChannels.includes(e));

  function render() {
    $('blockChannelBtn').disabled = isBlocked();
    $('blockChannelBtn').textContent = isBlocked() ? 'Kanal gesperrt' : 'Kanal sperren';
    const wl = s.filter.mode === 'whitelist';
    $('allowChannelBtn').hidden = !wl;
    $('allowChannelBtn').disabled = isAllowed() || FG.isLocked(s);
    $('allowChannelBtn').textContent = isAllowed() ? 'Erlaubt' : 'Kanal erlauben';
    if (wl && FG.isLocked(s) && !isAllowed()) $('allowChannelBtn').title = 'Während der Sperre nicht möglich';
  }
  render();

  $('blockChannelBtn').addEventListener('click', async () => {
    s = await FG.load();
    s.filter.blockedChannels.push(...entries);
    s.filter.allowedChannels = s.filter.allowedChannels.filter((c) => !entries.includes(c));
    await FG.save(s);
    s = await FG.load();
    render();
    say('Kanal gesperrt.');
  });

  $('allowChannelBtn').addEventListener('click', async () => {
    s = await FG.load();
    s.filter.allowedChannels.push(...entries);
    await FG.save(s);
    s = await FG.load();
    render();
    say('Kanal erlaubt.');
  });
})();
