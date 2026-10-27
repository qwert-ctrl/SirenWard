/* FocusGuard – Einstellungsseite. Baut die Oberfläche nur mit textContent (kein innerHTML). */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const fmt = (ms) =>
    new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
  const MAX_IMPORT_BYTES = 512 * 1024;

  let s = FG.withDefaults(null);

  const YT_OPTIONS = [
    ['hideHome', 'Startseiten-Feed ausblenden', 'Keine Vorschläge, sobald du YouTube öffnest.'],
    ['redirectHomeToSubs', 'Startseite → Abos weiterleiten', 'Statt der Startseite direkt deine Abos.'],
    ['hideRecommendations', 'Empfehlungen neben/unter Videos ausblenden', ''],
    ['hideShorts', 'Shorts ausblenden', 'Shorts-Links öffnen als normales Video mit Spulleiste.'],
    ['hideComments', 'Kommentare ausblenden', ''],
    ['hideEndscreen', 'Endcards & Vorschläge im Player ausblenden', ''],
    ['disableAutoplay', 'Autoplay ausschalten', 'Nach dem Video läuft nicht automatisch das nächste.'],
  ];

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  async function update(mutate) {
    const cur = await FG.load();
    mutate(cur);
    await FG.save(cur);
  }

  function renderChips(ul, items, canRemove, onRemove, emptyText) {
    ul.replaceChildren();
    if (!items.length) {
      ul.append(h('li', 'empty', emptyText));
      return;
    }
    for (const item of items) {
      const li = h('li', 'chip');
      const label = h('span', null, item);
      label.title = item;
      const btn = h('button', null, '×');
      btn.type = 'button';
      btn.disabled = !canRemove;
      btn.title = canRemove ? 'Entfernen' : 'Während der Sperre nicht möglich';
      btn.setAttribute('aria-label', item + ' entfernen');
      btn.addEventListener('click', () => onRemove(item));
      li.append(label, btn);
      ul.append(li);
    }
  }

  const without = (list, item) => list.filter((x) => x !== item);

  function render() {
    const locked = FG.isLocked(s);

    const banner = $('lockBanner');
    banner.hidden = !locked;
    banner.textContent = locked
      ? '🔒 Sperrmodus aktiv bis ' + fmt(s.lockUntil) + ' – Regeln können nur verschärft werden.'
      : '';

    renderChips(
      $('siteList'),
      s.blockedSites,
      !locked,
      (d) => update((c) => (c.blockedSites = without(c.blockedSites, d))),
      'Noch keine Websites gesperrt.'
    );

    const box = $('ytToggles');
    box.replaceChildren();
    for (const [key, label, hint] of YT_OPTIONS) {
      const row = h('label', 'toggle');
      const cb = h('input');
      cb.type = 'checkbox';
      cb.checked = s.yt[key];
      cb.disabled = locked && s.yt[key];
      if (cb.disabled) row.title = 'Während der Sperre nicht abschaltbar';
      cb.addEventListener('change', () => update((c) => (c.yt[key] = cb.checked)));
      const txt = h('span', 'toggle-text');
      txt.append(h('span', 'toggle-label', label));
      if (hint) txt.append(h('span', 'muted small', hint));
      row.append(cb, txt);
      box.append(row);
    }

    const wl = s.filter.mode === 'whitelist';
    document.querySelectorAll('input[name="mode"]').forEach((r) => {
      r.checked = r.value === s.filter.mode;
      r.disabled = locked && wl && r.value === 'blacklist';
    });
    $('allowedBox').hidden = !wl;
    $('allowedInput').disabled = $('allowedAdd').disabled = locked && wl;
    renderChips(
      $('allowedList'),
      s.filter.allowedChannels,
      true, // Entfernen verschärft – immer erlaubt
      (c) => update((x) => (x.filter.allowedChannels = without(x.filter.allowedChannels, c))),
      'Noch keine Kanäle erlaubt – im strikten Modus ist damit alles gesperrt.'
    );
    renderChips(
      $('channelList'),
      s.filter.blockedChannels,
      !locked,
      (c) => update((x) => (x.filter.blockedChannels = without(x.filter.blockedChannels, c))),
      'Keine Kanäle gesperrt.'
    );
    renderChips(
      $('keywordList'),
      s.filter.blockedKeywords,
      !locked,
      (k) => update((x) => (x.filter.blockedKeywords = without(x.filter.blockedKeywords, k))),
      'Keine Stichwörter gesperrt.'
    );

    $('lockStatus').textContent = locked ? 'Aktiv bis ' + fmt(s.lockUntil) + '.' : 'Nicht aktiv.';
    $('lockBtn').textContent = locked ? 'Sperre verlängern' : 'Sperre starten';
  }

  function bindForm(formId, inputId, splitter, normalize, getList, invalidMsg) {
    const input = $(inputId);
    input.addEventListener('input', () => input.setCustomValidity(''));
    $(formId).addEventListener('submit', async (e) => {
      e.preventDefault();
      const parts = input.value.split(splitter).map((x) => x.trim()).filter(Boolean);
      const bad = parts.filter((p) => !normalize(p));
      const good = parts.map(normalize).filter(Boolean);
      if (bad.length) {
        input.setCustomValidity(invalidMsg + ': ' + bad.join(', '));
        input.reportValidity();
        return;
      }
      if (!good.length) return;
      await update((c) => {
        const list = getList(c);
        for (const g of good) if (!list.includes(g)) list.push(g);
      });
      input.value = '';
    });
  }

  bindForm('siteForm', 'siteInput', /[\s,;]+/, FG.normalizeDomain, (c) => c.blockedSites, 'Keine gültige Domain');
  bindForm('allowedForm', 'allowedInput', /[\n,;]+/, FG.normalizeChannel, (c) => c.filter.allowedChannels, 'Ungültiger Kanal');
  bindForm('channelForm', 'channelInput', /[\n,;]+/, FG.normalizeChannel, (c) => c.filter.blockedChannels, 'Ungültiger Kanal');
  bindForm('keywordForm', 'keywordInput', /[\n,;]+/, FG.normalizeKeyword, (c) => c.filter.blockedKeywords, 'Ungültiges Stichwort');

  document.querySelectorAll('input[name="mode"]').forEach((r) =>
    r.addEventListener('change', async () => {
      if (r.value === 'whitelist' && !s.filter.allowedChannels.length) {
        const ok = confirm(
          'Im strikten Modus ist jedes Video gesperrt, bis du Kanäle erlaubst. Trotzdem umschalten?'
        );
        if (!ok) return render();
      }
      await update((c) => (c.filter.mode = r.value));
    })
  );

  $('lockBtn').addEventListener('click', async () => {
    const ms = Number($('lockDuration').value);
    if (!Number.isFinite(ms) || ms <= 0) return;
    const until = Math.max(s.lockUntil, Date.now() + ms);
    const ok = confirm(
      'Sperrmodus bis ' +
        fmt(until) +
        ' aktivieren?\n\nBis dahin kannst du Websites, Kanäle und Stichwörter nur hinzufügen, aber nicht entfernen.'
    );
    if (!ok) return;
    await update((c) => (c.lockUntil = Math.max(c.lockUntil, until)));
  });

  /* ----- Export / Import: rein lokal, über den Download-/Datei-Dialog des Browsers ----- */
  $('exportBtn').addEventListener('click', () => {
    const data = { app: 'FocusGuard', format: 1, settings: { ...s, lockUntil: 0 } };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = h('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'focusguard-einstellungen.json';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    $('ioStatus').textContent = 'Exportiert.';
  });

  $('importInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      $('ioStatus').textContent = 'Datei ist zu groß.';
      return;
    }
    try {
      const data = JSON.parse(await file.text());
      const incoming = FG.withDefaults(data && typeof data === 'object' && data.settings ? data.settings : data);
      const wasLocked = FG.isLocked(s);
      await update((c) => {
        const keep = c.lockUntil;
        c.blockedSites = incoming.blockedSites;
        c.yt = incoming.yt;
        c.filter = incoming.filter;
        c.lockUntil = keep;
      });
      $('ioStatus').textContent = wasLocked
        ? 'Importiert. Wegen der aktiven Sperre wurden nur verschärfende Änderungen übernommen.'
        : 'Importiert.';
    } catch {
      $('ioStatus').textContent = 'Die Datei konnte nicht gelesen werden.';
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    s = FG.withDefaults(changes.settings.newValue);
    render();
  });

  setInterval(() => {
    if (s.lockUntil && s.lockUntil <= Date.now()) render();
  }, 15000);

  FG.load().then((v) => {
    s = v;
    render();
  });
})();
