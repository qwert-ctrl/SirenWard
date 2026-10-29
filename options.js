/*
 * SirenWard – Einstellungsseite (Aufbau wie die macOS-Systemeinstellungen).
 * Baut die Oberfläche EINMAL auf und aktualisiert danach nur, was sich geändert hat (kein Fokusverlust).
 * Ausschließlich textContent (zusätzlich per Trusted Types erzwungen). Texte über FGi18n (EN/DE).
 * Änderungen gehen als Befehle an den Hintergrund; verlangt eine Änderung den Partner-Code,
 * fragt FGClient ihn ab.
 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const { h, fmtDateTime } = FGClient;
  const { t, locale } = FGi18n;
  const MAX_IMPORT_BYTES = 512 * 1024;
  const MAX_TIMER_MS = 2 ** 30; // setTimeout läuft bei > 2^31-1 ms sofort ab
  const WEEK = [1, 2, 3, 4, 5, 6, 0]; // Mo … So
  const PANES = ['sites', 'unlock', 'youtube', 'lock', 'partner', 'extras', 'privacy'];

  // [Liste, ul-ID, Leertext-Schlüssel, Entfernen auch während Zeitsperre erlaubt?]
  const LISTS = [
    ['blockedSites', 'siteList', 'sitesEmpty', false],
    ['allowedChannels', 'allowedList', 'allowedEmpty', true],
    ['blockedChannels', 'channelList', 'channelsEmpty', false],
    ['blockedKeywords', 'keywordList', 'keywordsEmpty', false],
  ];
  const listOf = (s, name) => (name === 'blockedSites' ? s.blockedSites : s.filter[name]);

  let s = FG.withDefaults(null);
  let st = null;
  const now = () => Date.now();
  const locked = () => FG.isLocked(s, now());

  $('version').textContent = t('versionLabel', chrome.runtime.getManifest().version);

  /* ---------- Navigation (ein Bereich zur Zeit, per #hash) ---------- */
  function showPane() {
    const want = location.hash.slice(1);
    const name = PANES.includes(want) ? want : 'sites';
    for (const p of document.querySelectorAll('[data-pane]')) p.hidden = p.dataset.pane !== name;
    for (const a of document.querySelectorAll('#nav a')) {
      if (a.getAttribute('href') === '#' + name) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }
  window.addEventListener('hashchange', showPane);
  showPane();

  /* ---------- Rückmeldung ---------- */
  let toastTimer = 0;
  function toast(msg, isError) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), isError ? 6000 : 2500);
  }

  async function run(op, okMsg) {
    const r = await FGClient.op(op);
    if (r.settings) update(r.settings, r.state);
    if (!r.ok) toast(r.message, true);
    else if (r.partial) toast(t('partialApplied'), true);
    else if (r.invalid && r.invalid.length) toast(t('notApplied', r.invalid.slice(0, 5).join(', ')), true);
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
  for (const key of FG.YT_KEYS) {
    const row = h('label', 'cell toggle');
    const txt = h('span', 'text');
    txt.append(h('span', 'title', t('yt_' + key)));
    const hintKey = 'yt_' + key + '_hint';
    const hint = t(hintKey);
    if (hint !== hintKey) txt.append(h('span', 'hint', hint));
    const cb = h('input', 'switch');
    cb.type = 'checkbox';
    cb.addEventListener('change', async () => {
      const r = await run({ op: 'setYt', key, value: cb.checked });
      if (!r.ok) cb.checked = s.yt[key];
    });
    row.append(txt, cb);
    $('ytToggles').append(row);
    toggles[key] = { cb, row };
  }

  for (const [name, ulId] of LISTS) {
    $(ulId).addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-value]');
      if (btn && !btn.disabled) run({ op: 'remove', list: name, values: [btn.dataset.value] });
    });
  }

  function bindForm(formId, inputId, splitter, normalize, list, invalidKey) {
    const input = $(inputId);
    input.addEventListener('input', () => input.setCustomValidity(''));
    $(formId).addEventListener('submit', async (e) => {
      e.preventDefault();
      const parts = input.value.split(splitter).map((x) => x.trim()).filter(Boolean);
      if (!parts.length) return;
      const bad = parts.filter((p) => !normalize(p));
      if (bad.length) {
        input.setCustomValidity(t(invalidKey) + ': ' + bad.join(', '));
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
  bindForm('siteForm', 'siteInput', /[\s,;]+/, FG.normalizeDomain, 'blockedSites', 'invalidDomain');
  bindForm('allowedForm', 'allowedInput', /[\n,;]+/, FG.normalizeChannel, 'allowedChannels', 'invalidChannel');
  bindForm('channelForm', 'channelInput', /[\n,;]+/, FG.normalizeChannel, 'blockedChannels', 'invalidChannel');
  bindForm('keywordForm', 'keywordInput', /[\n,;]+/, FG.normalizeKeyword, 'blockedKeywords', 'invalidKeyword');

  for (const r of document.querySelectorAll('input[name="mode"]')) {
    r.addEventListener('change', async () => {
      if (r.value === 'whitelist' && !s.filter.allowedChannels.length) {
        if (!confirm(t('confirmStrict'))) return render(true);
      }
      const res = await run({ op: 'setMode', mode: r.value });
      if (!res.ok) render(true);
    });
  }

  $('lockBtn').addEventListener('click', async () => {
    const ms = Number($('lockDuration').value);
    const until = Math.max(s.lockUntil, now() + ms);
    if (confirm(t('lockConfirm', fmtDateTime(until)))) run({ op: 'lock', durationMs: ms }, t('lockActiveToast'));
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
      t('unlockSaved')
    );
  });

  /* ----- Partner-Code ----- */
  $('partnerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const a = $('partnerCode');
    const b = $('partnerCode2');
    b.setCustomValidity(a.value === b.value ? '' : t('partnerMismatch'));
    if (!b.reportValidity()) return;
    const r = await run({ op: 'partnerSet', code: a.value }, t('partnerActivated'));
    if (r.ok) a.value = b.value = '';
  });
  $('partnerCode2').addEventListener('input', () => $('partnerCode2').setCustomValidity(''));
  $('partnerChange').addEventListener('click', async () => {
    const code = await FGClient.askCode(t('partnerNewPrompt'));
    if (code) run({ op: 'partnerSet', code }, t('partnerChanged'));
  });
  $('partnerDisable').addEventListener('click', () => run({ op: 'partnerDisable' }, t('partnerDisabled')));

  /* ----- Zusatzfunktionen ----- */
  for (const cb of document.querySelectorAll('input[data-feature]')) {
    cb.addEventListener('change', async () => {
      const key = cb.dataset.feature;
      if (key === 'blockPage' && cb.checked) {
        const granted = await requestHosts(s.blockedSites);
        if (!granted && s.blockedSites.length) toast(t('blockPageNoAccess'), true);
      }
      const r = await run({ op: 'setFeature', key, value: cb.checked });
      if (!r.ok) cb.checked = s.features[key];
    });
  }

  // Wochentage in der Sprache der Oberfläche (Intl), Montag zuerst
  const dayFmt = new Intl.DateTimeFormat(locale, { weekday: 'short' });
  for (const day of WEEK) {
    const l = h('label');
    const cb = h('input');
    cb.type = 'checkbox';
    cb.value = String(day);
    const name = dayFmt.format(new Date(2024, 0, 7 + day)); // 7.1.2024 war ein Sonntag
    cb.setAttribute('aria-label', new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(new Date(2024, 0, 7 + day)));
    l.append(cb, h('span', null, name.replace(/\.$/, '')));
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
    if (!days.length) return toast(t('scheduleNoDay'), true);
    if (start === end) return toast(t('scheduleSame'), true);
    run({ op: 'setSchedule', days, start, end }, t('scheduleSaved'));
  });
  $('focusMinutes').addEventListener('change', () => run({ op: 'setFocus', minutes: Number($('focusMinutes').value) }));
  $('ytLimitMinutes').addEventListener('change', async () => {
    const r = await run({ op: 'setYtLimit', minutes: Number($('ytLimitMinutes').value) });
    if (!r.ok) $('ytLimitMinutes').value = String(s.ytLimit.minutes);
  });
  $('statsClear').addEventListener('click', () => {
    if (confirm(t('statsClearConfirm'))) run({ op: 'statsClear' }, t('statsCleared'));
  });

  /* ----- Export / Import: rein lokal ----- */
  $('exportBtn').addEventListener('click', () => {
    const exp = FG.clone(s);
    exp.lockUntil = 0;
    delete exp.partner; // der Partner-Code verlässt das Gerät nie
    const blob = new Blob([JSON.stringify({ app: 'SirenWard', format: 2, settings: exp }, null, 2)], { type: 'application/json' });
    const a = h('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sirenward-settings.json';
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast(t('exported'));
  });

  $('importInput').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) return toast(t('fileTooBig'), true);
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch {
      return toast(t('fileUnreadable'), true);
    }
    const settings = data && typeof data === 'object' && data.settings && typeof data.settings === 'object' ? data.settings : data;
    run({ op: 'import', settings }, t('imported'));
  });

  /* ---------- Gezielte Aktualisierung ---------- */
  const shown = {};
  function once(key, value, fn, force) {
    const k = FG.stableStringify(value);
    if (!force && shown[key] === k) return;
    shown[key] = k;
    fn();
  }

  function renderList(name, ulId, emptyKey, removableWhileLocked) {
    const items = listOf(s, name);
    const canRemove = !locked() || removableWhileLocked;
    once('list:' + name, [canRemove, s.partner.enabled, items], () => {
      const frag = document.createDocumentFragment();
      if (!items.length) frag.append(h('li', 'list-empty', t(emptyKey)));
      for (const item of items) {
        const li = h('li', 'list-row');
        const label = h('span', null, item);
        label.title = item;
        const btn = h('button', null, '−');
        btn.type = 'button';
        btn.dataset.value = item;
        btn.disabled = !canRemove;
        btn.title = canRemove ? (s.partner.enabled ? t('removeNeedsCode') : t('remove')) : t('lockedNoRemove');
        btn.setAttribute('aria-label', t('removeItemAria', item));
        li.append(label, btn);
        frag.append(li);
      }
      $(ulId).replaceChildren(frag);
    });
  }

  function setIfIdle(el, value) {
    if (document.activeElement !== el) el.value = value; // nicht beim Tippen überschreiben
  }

  const dateFmt = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' });
  function renderStats() {
    const days = st && st.stats ? Object.keys(st.stats).sort().slice(-7).reverse() : [];
    once('stats', st ? st.stats : null, () => {
      const frag = document.createDocumentFragment();
      if (!days.length) {
        const tr = h('tr');
        const td = h('td', 'muted', t('statsEmpty'));
        td.colSpan = 5;
        tr.append(td);
        frag.append(tr);
      }
      for (const d of days) {
        const v = st.stats[d];
        const [y, m, dd] = d.split('-').map(Number);
        const tr = h('tr');
        tr.append(
          h('td', null, dateFmt.format(new Date(y, m - 1, dd))),
          h('td', null, String(v.unlocks)),
          h('td', null, `${v.focus}× · ${t('focusMinutes', v.focusMin)}`),
          h('td', null, t('focusMinutes', v.ytMin)),
          h('td', null, String(v.blocked))
        );
        frag.append(tr);
      }
      $('statsRows').replaceChildren(frag);
    });
  }

  let lockTimer = 0;
  function render(force) {
    const isLocked = locked();
    const wl = s.filter.mode === 'whitelist';

    $('lockBanner').hidden = !isLocked;
    $('lockBanner').textContent = isLocked ? t('lockBanner', fmtDateTime(s.lockUntil)) : '';
    $('lockDot').hidden = !isLocked;

    for (const [key, { cb, row }] of Object.entries(toggles)) {
      cb.checked = s.yt[key];
      cb.disabled = isLocked && s.yt[key];
      row.title = cb.disabled ? t('lockedNoToggle') : '';
    }
    for (const r of document.querySelectorAll('input[name="mode"]')) {
      r.checked = r.value === s.filter.mode;
      r.disabled = isLocked && wl && r.value === 'blacklist';
    }
    $('modeHint').textContent = t(wl ? 'modeWhitelistHint' : 'modeBlacklistHint');
    $('allowedBox').hidden = !wl;
    $('allowedInput').disabled = $('allowedAdd').disabled = isLocked && wl;
    for (const l of LISTS) renderList(...l);

    $('lockStatus').textContent = isLocked ? t('lockStatusOn', fmtDateTime(s.lockUntil)) : t('lockStatusOff');
    $('lockBtn').textContent = isLocked ? t('lockExtend') : t('lockStart');

    once(
      'unlock',
      s.unlock,
      () => {
        $('unlockPerDay').value = String(s.unlock.perDay);
        $('unlockMinutes').value = String(s.unlock.minutes);
        $('unlockWait').value = String(s.unlock.waitSeconds);
        setIfIdle($('unlockPhrase'), s.unlock.phrase);
      },
      force
    );

    $('partnerOff').hidden = s.partner.enabled;
    $('partnerOn').hidden = !s.partner.enabled;

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
    $('ytUsage').textContent = st && st.yt && st.yt.limited ? (st.yt.exhausted ? t('ytUsedUp') : t('ytLeftMin', Math.ceil(st.yt.remainingMs / 60000))) : '';
    renderStats();

    clearTimeout(lockTimer);
    if (isLocked) lockTimer = setTimeout(() => render(), Math.min(s.lockUntil - now() + 250, MAX_TIMER_MS));
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
    render(true);
  });
})();
