/* FocusGuard – Popup. Kennt nur den aktiven Tab (activeTab) und nur, solange das Popup offen ist. */
(async () => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const fmt = (ms) => new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(ms));
  function say(msg, isError) {
    $('status').textContent = msg;
    $('status').classList.toggle('error', !!isError);
  }

  $('optionsBtn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  let s = await FGClient.get();
  const locked = () => FG.isLocked(s, Date.now());
  if (locked()) {
    $('lockPill').hidden = false;
    $('lockPill').textContent = '🔒 bis ' + fmt(s.lockUntil);
  }

  let tab = null;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    tab = null;
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
    const btn = $('blockSiteBtn');
    const covered = () => s.blockedSites.some((d) => domain === d || domain.endsWith('.' + d));
    const show = () => {
      btn.disabled = covered();
      btn.textContent = covered() ? 'Gesperrt' : 'Sperren';
    };
    $('siteBox').hidden = false;
    $('siteName').textContent = domain;
    show();
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      const r = await FGClient.op({ op: 'add', list: 'blockedSites', values: [domain] });
      if (r.settings) s = r.settings;
      show();
      if (!r.ok) return say(r.message, true);
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
  if (!ctx || typeof ctx !== 'object') return;
  // Daten stammen aus der Webseite → als nicht vertrauenswürdig behandeln (Typ/Länge, nur textContent).
  const name = typeof ctx.name === 'string' ? ctx.name.slice(0, 200) : '';
  const id = typeof ctx.id === 'string' ? ctx.id.slice(0, 200) : '';
  const entries = FG.uniq([FG.normalizeChannel(id), FG.normalizeChannel(name)].filter(Boolean));
  if (!entries.length) return;

  $('ytBox').hidden = false;
  $('channelName').textContent = name || id;

  const isBlocked = () => entries.some((e) => s.filter.blockedChannels.includes(e));
  const isAllowed = () => entries.some((e) => s.filter.allowedChannels.includes(e));
  function render() {
    $('blockChannelBtn').disabled = isBlocked();
    $('blockChannelBtn').textContent = isBlocked() ? 'Kanal gesperrt' : 'Kanal sperren';
    const wl = s.filter.mode === 'whitelist';
    $('allowChannelBtn').hidden = !wl;
    $('allowChannelBtn').disabled = isAllowed() || (wl && locked());
    $('allowChannelBtn').textContent = isAllowed() ? 'Erlaubt' : 'Kanal erlauben';
    $('allowChannelBtn').title = wl && locked() && !isAllowed() ? 'Während der Sperre nicht möglich' : '';
  }
  render();

  $('blockChannelBtn').addEventListener('click', async () => {
    let r = await FGClient.op({ op: 'add', list: 'blockedChannels', values: entries });
    if (r.ok && isAllowed()) r = await FGClient.op({ op: 'remove', list: 'allowedChannels', values: entries });
    if (r.settings) s = r.settings;
    render();
    say(r.ok ? 'Kanal gesperrt.' : r.message, !r.ok);
  });

  $('allowChannelBtn').addEventListener('click', async () => {
    const r = await FGClient.op({ op: 'add', list: 'allowedChannels', values: entries });
    if (r.settings) s = r.settings;
    render();
    say(r.ok ? 'Kanal erlaubt.' : r.message, !r.ok);
  });
})();
