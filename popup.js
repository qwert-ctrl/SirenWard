/*
 * FocusGuard – Popup. Kennt nur den aktiven Tab (activeTab) und nur, solange das Popup offen ist.
 * Zeigt Status auf einen Blick und für die aktuelle Seite genau die passende Aktion.
 */
(async () => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const { h, fmtLeft, fmtTime, fmtDateTime } = FGClient;
  const EXT_BASE = chrome.runtime.getURL('');

  function say(msg, isError) {
    $('status').textContent = msg || '';
    $('status').classList.toggle('error', !!isError);
  }

  $('optionsBtn').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  let view = await FGClient.status();
  const now = () => Date.now();

  /* ----- Aktiver Tab ----- */
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
  // Eigene Sperrseite? Dann steht die Domain im Parameter.
  const onBlockPage = !!(url && tab.url.startsWith(EXT_BASE + 'blocked.html'));
  const host = onBlockPage ? url.searchParams.get('d') || '' : url && /^https?:$/.test(url.protocol) ? url.hostname : '';

  /* ----- Status-Pillen ----- */
  const timers = [];
  function pill(text, cls) {
    const p = h('span', 'pill ' + (cls || ''), text);
    $('pills').append(p);
    return p;
  }
  function renderPills() {
    $('pills').replaceChildren();
    const s = view.settings;
    const st = view.state;
    if (FG.isLocked(s, now())) pill('🔒 bis ' + fmtTime(s.lockUntil)).title = 'Sperrmodus bis ' + fmtDateTime(s.lockUntil);
    if (s.partner.enabled) pill('Partner').title = 'Lockern nur mit Partner-Code';
    if (st && st.blocking.focus) pill('Fokus', 'focus');
    else if (st && s.features.schedule && !st.blocking.listActive) pill('Plan: frei', 'free');
  }

  /* ----- Diese Website ----- */
  let stopUnlock = () => {};
  function renderSite() {
    stopUnlock();
    const s = view.settings;
    const domain = FG.normalizeDomain(host);
    if (!domain) {
      $('siteBox').hidden = true;
      return;
    }
    $('siteBox').hidden = false;
    const entry = FG.matchEntry(s.blockedSites, domain);
    $('siteName').textContent = entry || domain;
    const body = $('siteBody');
    const badge = $('siteBadge');

    if (!entry) {
      badge.hidden = true;
      body.replaceChildren();
      const btn = h('button', null, 'Diese Website sperren');
      btn.type = 'button';
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        if (s.features.blockPage && chrome.permissions) {
          // Für die eigene Sperrseite: Zugriff NUR auf diese Domain (muss direkt im Klick passieren)
          await chrome.permissions.request({ origins: [`*://*.${domain}/*`] }).catch(() => false);
        }
        const r = await FGClient.op({ op: 'add', list: 'blockedSites', values: [domain] });
        if (!r.ok) {
          btn.disabled = false;
          return say(r.message, true);
        }
        say(domain + ' ist ab jetzt gesperrt.');
        if (tab.id != null) chrome.tabs.reload(tab.id);
        await refresh(r);
      });
      body.append(btn);
      return;
    }

    const st = view.state;
    const unlocked = st && st.blocking.unlocked.includes(entry);
    const blocked = st && st.blocking.blocked.includes(entry);
    badge.hidden = false;
    badge.textContent = unlocked ? 'freigegeben' : blocked ? 'gesperrt' : 'gerade frei';
    badge.className = 'badge ' + (unlocked ? 'free' : blocked ? 'blocked' : 'free');
    stopUnlock = FGUnlock.renderUnlock(body, entry, view, {
      say,
      onChange: refresh,
      onUnlocked: () => {
        say('Freigegeben – viel Erfolg beim bewussten Surfen.');
        if (tab.id == null) return;
        if (onBlockPage) chrome.tabs.update(tab.id, { url: 'https://' + entry + '/' });
        else chrome.tabs.reload(tab.id);
      },
    });
  }

  /* ----- Fokus ----- */
  function renderFocus() {
    const s = view.settings;
    const st = view.state;
    $('focusBox').hidden = !s.features.focus;
    if (!s.features.focus || !st) return;
    const body = $('focusBody');
    body.replaceChildren();
    if (st.blocking.focus) {
      const line = h('p', 'unlock-line');
      body.append(line, h('p', 'muted small', 'Alle Seiten deiner Liste sind gesperrt, Freigaben pausiert.'));
      const upd = () => (line.textContent = 'Läuft noch ' + fmtLeft(st.focusUntil - now()));
      upd();
      timers.push(setInterval(upd, 1000));
      return;
    }
    const row = h('div', 'row');
    for (const m of FG.uniq([s.focus.minutes, 25, 50]).slice(0, 3)) {
      const b = h('button', m === s.focus.minutes ? null : 'secondary', m + ' min');
      b.type = 'button';
      b.addEventListener('click', async () => {
        const r = await FGClient.op({ op: 'focusStart', minutes: m });
        if (!r.ok) return say(r.message, true);
        say('Fokus läuft bis ' + fmtTime(r.info.focusUntil) + '.');
        await refresh(r);
      });
      row.append(b);
    }
    body.append(row);
    if (!view.settings.blockedSites.length) body.append(h('p', 'muted small', 'Tipp: Füge zuerst Websites zur Sperrliste hinzu.'));
  }

  /* ----- YouTube ----- */
  let ytEntries = [];
  let ytName = '';
  async function loadYouTubeContext() {
    if (!url || url.hostname !== 'www.youtube.com' || tab.id == null) return;
    let ctx = null;
    try {
      ctx = await chrome.tabs.sendMessage(tab.id, { type: 'fg:context' });
    } catch {
      ctx = null;
    }
    if (!ctx || typeof ctx !== 'object') return;
    // Daten stammen aus der Webseite → als nicht vertrauenswürdig behandeln (Typ/Länge, nur textContent).
    ytName = typeof ctx.name === 'string' ? ctx.name.slice(0, 200) : '';
    const id = typeof ctx.id === 'string' ? ctx.id.slice(0, 200) : '';
    ytEntries = FG.uniq([FG.normalizeChannel(id), FG.normalizeChannel(ytName)].filter(Boolean));
    if (!ytName) ytName = id;
  }
  function renderYt() {
    const s = view.settings;
    const st = view.state;
    const onYt = !!(url && url.hostname === 'www.youtube.com');
    const limited = st && st.yt && st.yt.limited;
    $('ytBox').hidden = !onYt || (!ytEntries.length && !limited);
    if ($('ytBox').hidden) return;
    $('ytLimit').hidden = !limited;
    if (limited) {
      $('ytLimit').textContent = st.yt.exhausted
        ? `Tageslimit erreicht (${s.ytLimit.minutes} min).`
        : `Heute noch ${Math.ceil(st.yt.remainingMs / 60000)} von ${s.ytLimit.minutes} min.`;
    }
    const show = ytEntries.length > 0;
    $('channelName').hidden = $('channelActions').hidden = !show;
    if (!show) return;
    $('channelName').textContent = ytName;
    const isBlocked = ytEntries.some((e) => s.filter.blockedChannels.includes(e));
    const isAllowed = ytEntries.some((e) => s.filter.allowedChannels.includes(e));
    const wl = s.filter.mode === 'whitelist';
    $('blockChannelBtn').disabled = isBlocked;
    $('blockChannelBtn').textContent = isBlocked ? 'Kanal gesperrt' : 'Kanal sperren';
    $('allowChannelBtn').hidden = !wl;
    $('allowChannelBtn').disabled = isAllowed;
    $('allowChannelBtn').textContent = isAllowed ? 'Erlaubt' : 'Kanal erlauben';
  }
  $('blockChannelBtn').addEventListener('click', async () => {
    let r = await FGClient.op({ op: 'add', list: 'blockedChannels', values: ytEntries });
    if (r.ok && ytEntries.some((e) => view.settings.filter.allowedChannels.includes(e))) r = await FGClient.op({ op: 'remove', list: 'allowedChannels', values: ytEntries });
    say(r.ok ? 'Kanal gesperrt.' : r.message, !r.ok);
    await refresh(r);
  });
  $('allowChannelBtn').addEventListener('click', async () => {
    const r = await FGClient.op({ op: 'add', list: 'allowedChannels', values: ytEntries });
    say(r.ok ? 'Kanal erlaubt.' : r.message, !r.ok);
    await refresh(r);
  });

  /* ----- Ablauf ----- */
  function render() {
    while (timers.length) clearInterval(timers.pop());
    renderPills();
    renderSite();
    renderFocus();
    renderYt();
  }
  // Nur neu zeichnen, wenn sich Relevantes geändert hat – sonst ginge z. B. der abgetippte Satz verloren.
  const keyOf = (v) =>
    FG.stableStringify({
      s: v.settings,
      b: v.state && v.state.blocking,
      u: v.state && [v.state.unlocks, v.state.pending, v.state.used, v.state.focusUntil, v.state.yt && v.state.yt.exhausted],
    });
  let shownKey = '';
  async function refresh(r) {
    view = r && r.settings && r.state ? { settings: r.settings, state: r.state } : await FGClient.status();
    const k = keyOf(view);
    if (k === shownKey) return;
    shownKey = k;
    render();
  }

  await loadYouTubeContext();
  shownKey = keyOf(view);
  render();
  // Freigabe/Fokus laufen ab, während das Popup offen ist → Zustand gelegentlich neu holen
  setInterval(() => refresh(), 15000);
})();
