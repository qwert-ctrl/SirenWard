/*
 * FocusGuard – Einstellungsseite.
 * Baut die Oberfläche EINMAL auf und aktualisiert danach nur, was sich geändert hat
 * (kein Fokusverlust). Ausschließlich textContent – kein innerHTML (zusätzlich per Trusted Types erzwungen).
 * Änderungen gehen als Befehle an den Hintergrund; der entscheidet und speichert.
 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const fmt = (ms) => new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
  const MAX_IMPORT_BYTES = 512 * 1024;
  const MAX_TIMER_MS = 2 ** 30; // setTimeout läuft bei > 2^31-1 ms sofort ab

  const YT_OPTIONS = [
    ['hideHome', 'Startseiten-Feed ausblenden', 'Keine Vorschläge, sobald du YouTube öffnest.'],
    ['redirectHomeToSubs', 'Startseite → Abos weiterleiten', 'Statt der Startseite direkt deine Abos.'],
    ['hideRecommendations', 'Empfehlungen neben/unter Videos ausblenden', ''],
    ['hideShorts', 'Shorts ausblenden', 'Shorts-Links öffnen als normales Video mit Spulleiste.'],
    ['hideComments', 'Kommentare ausblenden', ''],
    ['hideEndscreen', 'Endcards & Vorschläge im Player ausblenden', ''],
    ['disableAutoplay', 'Autoplay ausschalten', 'Nach dem Video läuft nicht automatisch das nächste.'],
  ];

  const LISTS = [
    // [Liste, ul-ID, Leertext, Entfernen auch während Sperre erlaubt?]
    ['blockedSites', 'siteList', 'Noch keine Websites gesperrt.', false],
    ['allowedChannels', 'allowedList', 'Noch keine Kanäle erlaubt – im strikten Modus ist damit alles gesperrt.', true],
    ['blockedChannels', 'channelList', 'Keine Kanäle gesperrt.', false],
    ['blockedKeywords', 'keywordList', 'Keine Stichwörter gesperrt.', false],
  ];
  const listOf = (s, name) => (name === 'blockedSites' ? s.blockedSites : s.filter[name]);

  let s = FG.withDefaults(null);
  const now = () => Date.now();
  const locked = () => FG.isLocked(s, now());

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /* ---------- Rückmeldung ---------- */
  let toastTimer = 0;
  function toast(msg, isError) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('error', !!isError);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), isError ? 6000 : 2500);
  }

  async function run(op, okMsg) {
    const r = await FGClient.op(op);
    if (r.settings) update(r.settings);
    if (!r.ok) toast(r.message, true);
    else if (r.partial) toast('Wegen der aktiven Sperre wurden nur verschärfende Änderungen übernommen.', true);
    else if (r.invalid && r.invalid.length) toast('Nicht übernommen (ungültig): ' + r.invalid.slice(0, 5).join(', '), true);
    else if (okMsg) toast(okMsg);
    return r;
  }

  /* ---------- Einmaliger Aufbau ---------- */
  const toggles = {};
  for (const [key, label, hint] of YT_OPTIONS) {
    const row = h('label', 'toggle');
    const cb = h('input');
    cb.type = 'checkbox';
    cb.addEventListener('change', async () => {
      const r = await run({ op: 'setYt', key, value: cb.checked });
      if (!r.ok) cb.checked = s.yt[key];
    });
    const txt = h('span', 'toggle-text');
    txt.append(h('span', 'toggle-label', label));
    if (hint) txt.append(h('span', 'muted small', hint));
    row.append(cb, txt);
    $('ytToggles').append(row);
    toggles[key] = { cb, row };
  }

  // Event-Delegation: ein Listener pro Liste statt einer pro Eintrag
  for (const [name, ulId] of LISTS) {
    $(ulId).addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-value]');
      if (btn && !btn.disabled) run({ op: 'remove', list: name, values: [btn.dataset.value] });
    });
  }

  function bindForm(formId, inputId, splitter, normalize, list, invalidMsg) {
    const input = $(inputId);
    input.addEventListener('input', () => input.setCustomValidity(''));
    $(formId).addEventListener('submit', async (e) => {
      e.preventDefault();
      const parts = input.value.split(splitter).map((x) => x.trim()).filter(Boolean);
      if (!parts.length) return;
      const bad = parts.filter((p) => !normalize(p));
      if (bad.length) {
        input.setCustomValidity(invalidMsg + ': ' + bad.join(', '));
        input.reportValidity();
        return;
      }
      for (let i = 0; i < parts.length; i += FG.LIMITS.MAX_OP_VALUES) {
        const r = await run({ op: 'add', list, values: parts.slice(i, i + FG.LIMITS.MAX_OP_VALUES) });
        if (!r.ok) return;
      }
      input.value = '';
    });
  }
  bindForm('siteForm', 'siteInput', /[\s,;]+/, FG.normalizeDomain, 'blockedSites', 'Keine gültige Domain');
  bindForm('allowedForm', 'allowedInput', /[\n,;]+/, FG.normalizeChannel, 'allowedChannels', 'Ungültiger Kanal');
  bindForm('channelForm', 'channelInput', /[\n,;]+/, FG.normalizeChannel, 'blockedChannels', 'Ungültiger Kanal');
  bindForm('keywordForm', 'keywordInput', /[\n,;]+/, FG.normalizeKeyword, 'blockedKeywords', 'Ungültiges Stichwort');

  for (const r of document.querySelectorAll('input[name="mode"]')) {
    r.addEventListener('change', async () => {
      if (r.value === 'whitelist' && !s.filter.allowedChannels.length) {
        if (!confirm('Im strikten Modus ist jedes Video gesperrt, bis du Kanäle erlaubst. Trotzdem umschalten?')) return render();
      }
      const res = await run({ op: 'setMode', mode: r.value });
      if (!res.ok) render();
    });
  }

  $('lockBtn').addEventListener('click', async () => {
    const ms = Number($('lockDuration').value);
    const until = Math.max(s.lockUntil, now() + ms);
    const ok = confirm(
      'Sperrmodus bis ' + fmt(until) + ' aktivieren?\n\nBis dahin kannst du Websites, Kanäle und Stichwörter nur hinzufügen, aber nicht entfernen.'
    );
    if (ok) run({ op: 'lock', durationMs: ms }, 'Sperrmodus aktiv.');
  });

  /* ----- Export / Import: rein lokal ----- */
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
    toast('Exportiert.');
  });

  $('importInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) return toast('Datei ist zu groß.', true);
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      return toast('Die Datei konnte nicht gelesen werden.', true);
    }
    const settings = data && typeof data === 'object' && data.settings && typeof data.settings === 'object' ? data.settings : data;
    run({ op: 'import', settings }, 'Importiert.');
  });

  /* ---------- Gezielte Aktualisierung ---------- */
  const shown = {};
  function renderList(name, ulId, emptyText, removableWhileLocked) {
    const items = listOf(s, name);
    const canRemove = !locked() || removableWhileLocked;
    const key = canRemove + '|' + FG.stableStringify(items);
    if (shown[name] === key) return; // unverändert → DOM nicht anfassen
    shown[name] = key;
    const ul = $(ulId);
    const frag = document.createDocumentFragment();
    if (!items.length) frag.append(h('li', 'empty', emptyText));
    for (const item of items) {
      const li = h('li', 'chip');
      const label = h('span', null, item);
      label.title = item;
      const btn = h('button', null, '×');
      btn.type = 'button';
      btn.dataset.value = item;
      btn.disabled = !canRemove;
      btn.title = canRemove ? 'Entfernen' : 'Während der Sperre nicht möglich';
      btn.setAttribute('aria-label', item + ' entfernen');
      li.append(label, btn);
      frag.append(li);
    }
    ul.replaceChildren(frag);
  }

  let lockTimer = 0;
  function render() {
    const isLocked = locked();
    const wl = s.filter.mode === 'whitelist';

    $('lockBanner').hidden = !isLocked;
    $('lockBanner').textContent = isLocked ? '🔒 Sperrmodus aktiv bis ' + fmt(s.lockUntil) + ' – Regeln können nur verschärft werden.' : '';

    for (const [key, { cb, row }] of Object.entries(toggles)) {
      cb.checked = s.yt[key];
      cb.disabled = isLocked && s.yt[key];
      row.title = cb.disabled ? 'Während der Sperre nicht abschaltbar' : '';
    }
    for (const r of document.querySelectorAll('input[name="mode"]')) {
      r.checked = r.value === s.filter.mode;
      r.disabled = isLocked && wl && r.value === 'blacklist';
    }
    $('allowedBox').hidden = !wl;
    $('allowedInput').disabled = $('allowedAdd').disabled = isLocked && wl;
    for (const l of LISTS) renderList(...l);

    $('lockStatus').textContent = isLocked ? 'Aktiv bis ' + fmt(s.lockUntil) + '.' : 'Nicht aktiv.';
    $('lockBtn').textContent = isLocked ? 'Sperre verlängern' : 'Sperre starten';

    // Genau einmal neu zeichnen, wenn die Sperre endet (statt Dauer-Intervall)
    clearTimeout(lockTimer);
    if (isLocked) lockTimer = setTimeout(render, Math.min(s.lockUntil - now() + 250, MAX_TIMER_MS));
  }

  function update(next) {
    if (FG.sameJSON(next, s)) return;
    s = next;
    render();
  }

  FGClient.onChange(update);
  FGClient.get().then((v) => {
    s = v;
    render();
  });
})();
