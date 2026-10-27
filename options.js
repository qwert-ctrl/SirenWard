/*
 * FocusGuard – Einstellungsseite.
 * Baut die Oberfläche EINMAL auf und aktualisiert danach nur, was sich geändert hat (kein Fokusverlust).
 * Ausschließlich textContent (zusätzlich per Trusted Types erzwungen). Änderungen gehen als Befehle
 * an den Hintergrund; verlangt eine Änderung den Partner-Code, fragt FGClient ihn ab.
 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const { h, fmtDateTime } = FGClient;
  const MAX_IMPORT_BYTES = 512 * 1024;
  const MAX_TIMER_MS = 2 ** 30; // setTimeout läuft bei > 2^31-1 ms sofort ab
  const DAY_NAMES = [['Mo', 1], ['Di', 2], ['Mi', 3], ['Do', 4], ['Fr', 5], ['Sa', 6], ['So', 0]];

  const YT_OPTIONS = [
    ['hideHome', 'Startseiten-Feed ausblenden', 'Keine Vorschläge, sobald du YouTube öffnest.'],
    ['redirectHomeToSubs', 'Startseite → Abos weiterleiten', 'Statt der Startseite direkt deine Abos.'],
    ['hideRecommendations', 'Empfehlungen neben/unter Videos ausblenden', ''],
    ['hideShorts', 'Shorts ausblenden', 'Shorts-Links öffnen als normales Video mit Spulleiste.'],
    ['hideComments', 'Kommentare ausblenden', ''],
    ['hideEndscreen', 'Endcards & Vorschläge im Player ausblenden', ''],
    ['disableAutoplay', 'Autoplay ausschalten', 'Nach dem Video läuft nicht automatisch das nächste.'],
    ['hideSearchSuggestions', 'Suchvorschläge ausblenden', 'Kein Vorschlags-Sog beim Tippen in die Suche.'],
    ['hideExplore', '„Erkunden“ & Trends ausblenden', 'Trends, Erkunden und Themenkanäle verschwinden aus dem Menü.'],
    ['grayThumbnails', 'Vorschaubilder in Graustufen', 'Weniger visueller Reiz – Titel lesen statt Bilder klicken.'],
  ];

  const LISTS = [
    // [Liste, ul-ID, Leertext, Entfernen auch während Zeitsperre erlaubt?]
    ['blockedSites', 'siteList', 'Noch keine Websites gesperrt.', false],
    ['allowedChannels', 'allowedList', 'Noch keine Kanäle erlaubt – im strikten Modus ist damit alles gesperrt.', true],
    ['blockedChannels', 'channelList', 'Keine Kanäle gesperrt.', false],
    ['blockedKeywords', 'keywordList', 'Keine Stichwörter gesperrt.', false],
  ];
  const listOf = (s, name) => (name === 'blockedSites' ? s.blockedSites : s.filter[name]);

  let s = FG.withDefaults(null);
  let st = null;
  const now = () => Date.now();
  const locked = () => FG.isLocked(s, now());

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
    if (r.settings) update(r.settings, r.state);
    if (!r.ok) toast(r.message, true);
    else if (r.partial) toast('Wegen aktiver Sperre bzw. Partner-Code wurden nur verschärfende Änderungen übernommen.', true);
    else if (r.invalid && r.invalid.length) toast('Nicht übernommen (ungültig): ' + r.invalid.slice(0, 5).join(', '), true);
    else if (okMsg) toast(okMsg);
    return r;
  }

  /** Für die eigene Sperrseite: Host-Recht NUR für diese Domains anfragen (muss im Klick passieren). */
  async function requestHosts(domains) {
    if (!chrome.permissions || !domains.length) return true;
    try {
      return await chrome.permissions.request({ origins: domains.map((d) => `*://*.${d}/*`) });
    } catch {
      return false;
    }
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
      if (list === 'blockedSites' && s.features.blockPage) await requestHosts(parts.map(normalize));
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
    const ok = confirm('Sperrmodus bis ' + fmtDateTime(until) + ' aktivieren?\n\nBis dahin kannst du Regeln nur verschärfen, nicht lockern.');
    if (ok) run({ op: 'lock', durationMs: ms }, 'Sperrmodus aktiv.');
  });

  /* ----- Zeitfreigabe ----- */
  $('unlockForm').addEventListener('submit', (e) => {
    e.preventDefault();
    run(
      {
        op: 'setUnlock',
        perDay: Number($('unlockPerDay').value),
        minutes: Number($('unlockMinutes').value),
        waitSeconds: Number($('unlockWait').value),
        phrase: $('unlockPhrase').value,
      },
      'Zeitfreigabe gespeichert.'
    );
  });

  /* ----- Partner-Code ----- */
  $('partnerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const a = $('partnerCode');
    const b = $('partnerCode2');
    b.setCustomValidity(a.value === b.value ? '' : 'Die Codes stimmen nicht überein.');
    if (!b.reportValidity()) return;
    const r = await run({ op: 'partnerSet', code: a.value }, 'Partner-Code aktiv.');
    if (r.ok) a.value = b.value = '';
  });
  $('partnerCode2').addEventListener('input', () => $('partnerCode2').setCustomValidity(''));
  $('partnerChange').addEventListener('click', async () => {
    const code = await FGClient.askCode('Neuen Code eingeben (mind. 6 Zeichen). Danach wird der bisherige Code abgefragt.');
    if (code) run({ op: 'partnerSet', code }, 'Partner-Code geändert.');
  });
  $('partnerDisable').addEventListener('click', () => run({ op: 'partnerDisable' }, 'Partner-Code deaktiviert.'));

  /* ----- Zusatzfunktionen ----- */
  for (const cb of document.querySelectorAll('input[data-feature]')) {
    cb.addEventListener('change', async () => {
      const key = cb.dataset.feature;
      if (key === 'blockPage' && cb.checked) {
        const granted = await requestHosts(s.blockedSites);
        if (!granted && s.blockedSites.length) toast('Ohne Zugriff zeigt der Browser für diese Seiten weiter seine Fehlerseite.', true);
      }
      const r = await run({ op: 'setFeature', key, value: cb.checked });
      if (!r.ok) cb.checked = s.features[key];
    });
  }

  for (const [name, day] of DAY_NAMES) {
    const l = h('label', 'day');
    const cb = h('input');
    cb.type = 'checkbox';
    cb.value = String(day);
    l.append(cb, h('span', null, name));
    $('scheduleDays').append(l);
  }
  const toTime = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  const fromTime = (v) => {
    const m = /^(\d{2}):(\d{2})$/.exec(v);
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  };
  $('scheduleForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const days = [...$('scheduleDays').querySelectorAll('input:checked')].map((c) => Number(c.value));
    const start = fromTime($('scheduleStart').value);
    const end = fromTime($('scheduleEnd').value);
    if (!days.length) return toast('Bitte mindestens einen Tag wählen.', true);
    if (start === end) return toast('Start und Ende dürfen nicht gleich sein.', true);
    run({ op: 'setSchedule', days, start, end }, 'Zeitplan gespeichert.');
  });
  $('focusMinutes').addEventListener('change', () => run({ op: 'setFocus', minutes: Number($('focusMinutes').value) }));
  $('ytLimitMinutes').addEventListener('change', async () => {
    const r = await run({ op: 'setYtLimit', minutes: Number($('ytLimitMinutes').value) });
    if (!r.ok) $('ytLimitMinutes').value = String(s.ytLimit.minutes);
  });
  $('statsClear').addEventListener('click', () => {
    if (confirm('Statistik wirklich löschen?')) run({ op: 'statsClear' }, 'Statistik gelöscht.');
  });

  /* ----- Export / Import: rein lokal ----- */
  $('exportBtn').addEventListener('click', () => {
    const exp = FG.clone(s);
    exp.lockUntil = 0;
    delete exp.partner; // der Partner-Code verlässt das Gerät nie
    const blob = new Blob([JSON.stringify({ app: 'FocusGuard', format: 2, settings: exp }, null, 2)], { type: 'application/json' });
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
  function once(key, value, fn) {
    const k = FG.stableStringify(value);
    if (shown[key] === k) return;
    shown[key] = k;
    fn();
  }

  function renderList(name, ulId, emptyText, removableWhileLocked) {
    const items = listOf(s, name);
    const canRemove = !locked() || removableWhileLocked;
    once('list:' + name, [canRemove, items], () => {
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
        btn.title = canRemove ? (s.partner.enabled ? 'Entfernen (Partner-Code nötig)' : 'Entfernen') : 'Während der Sperre nicht möglich';
        btn.setAttribute('aria-label', item + ' entfernen');
        li.append(label, btn);
        frag.append(li);
      }
      $(ulId).replaceChildren(frag);
    });
  }

  function setIfIdle(el, value) {
    if (document.activeElement !== el) el.value = value; // nicht beim Tippen überschreiben
  }

  function renderStats() {
    const days = st && st.stats ? Object.keys(st.stats).sort().slice(-7).reverse() : [];
    once('stats', st ? st.stats : null, () => {
      const frag = document.createDocumentFragment();
      if (!days.length) {
        const tr = h('tr');
        const td = h('td', 'muted', 'Noch keine Daten.');
        td.colSpan = 5;
        tr.append(td);
        frag.append(tr);
      }
      for (const d of days) {
        const v = st.stats[d];
        const tr = h('tr');
        const [y, m, dd] = d.split('-');
        tr.append(h('td', null, `${dd}.${m}.${y}`), h('td', null, String(v.unlocks)), h('td', null, `${v.focus}× / ${v.focusMin} min`), h('td', null, `${v.ytMin} min`), h('td', null, String(v.blocked)));
        frag.append(tr);
      }
      $('statsRows').replaceChildren(frag);
    });
  }

  let lockTimer = 0;
  function render() {
    const isLocked = locked();
    const wl = s.filter.mode === 'whitelist';

    $('lockBanner').hidden = !isLocked;
    $('lockBanner').textContent = isLocked ? '🔒 Sperrmodus aktiv bis ' + fmtDateTime(s.lockUntil) + ' – Regeln können nur verschärft werden.' : '';

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

    $('lockStatus').textContent = isLocked ? 'Aktiv bis ' + fmtDateTime(s.lockUntil) + '.' : 'Nicht aktiv.';
    $('lockBtn').textContent = isLocked ? 'Sperre verlängern' : 'Sperre starten';

    // Zeitfreigabe
    once('unlock', s.unlock, () => {
      $('unlockPerDay').value = String(s.unlock.perDay);
      $('unlockMinutes').value = String(s.unlock.minutes);
      $('unlockWait').value = String(s.unlock.waitSeconds);
      setIfIdle($('unlockPhrase'), s.unlock.phrase);
    });

    // Partner
    $('partnerOff').hidden = s.partner.enabled;
    $('partnerOn').hidden = !s.partner.enabled;

    // Zusatzfunktionen
    for (const cb of document.querySelectorAll('input[data-feature]')) cb.checked = s.features[cb.dataset.feature];
    $('scheduleForm').hidden = !s.features.schedule;
    $('focusBody').hidden = !s.features.focus;
    $('blockPageInfo').hidden = !s.features.blockPage;
    $('ytLimitBody').hidden = !s.features.ytLimit;
    $('statsBody').hidden = !s.features.stats;
    once('schedule', s.schedule, () => {
      for (const cb of $('scheduleDays').querySelectorAll('input')) cb.checked = s.schedule.days.includes(Number(cb.value));
      setIfIdle($('scheduleStart'), toTime(s.schedule.start));
      setIfIdle($('scheduleEnd'), toTime(s.schedule.end));
    });
    $('focusMinutes').value = String(s.focus.minutes);
    $('ytLimitMinutes').value = String(s.ytLimit.minutes);
    if (st && st.yt && st.yt.limited) {
      $('ytUsage').textContent = st.yt.exhausted ? 'Heute aufgebraucht.' : `Heute noch ${Math.ceil(st.yt.remainingMs / 60000)} min.`;
    }
    $('blockPageInfo').textContent =
      'Zugriff wird nur für deine gesperrten Domains angefragt und beim Entfernen einer Domain automatisch wieder entzogen.';
    renderStats();

    clearTimeout(lockTimer);
    if (isLocked) lockTimer = setTimeout(render, Math.min(s.lockUntil - now() + 250, MAX_TIMER_MS));
  }

  function update(next, nextState) {
    const changed = !FG.sameJSON(next, s) || (nextState && !FG.sameJSON(nextState, st));
    s = next;
    if (nextState) st = nextState;
    if (changed) render();
  }

  // Zustand (Zähler, Statistik) kann sich auch ohne Einstellungsänderung ändern
  let pending = 0;
  FGClient.onStateChange(() => {
    clearTimeout(pending);
    pending = setTimeout(async () => {
      const v = await FGClient.status();
      update(v.settings, v.state);
    }, 250);
  });
  FGClient.status().then((v) => {
    s = v.settings;
    st = v.state;
    render();
  });
})();
