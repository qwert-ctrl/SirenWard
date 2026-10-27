/*
 * FocusGuard – eigene Sperrseite (optional). Wird per declarativeNetRequest-Weiterleitung geöffnet.
 * Sicherheit: verweigert die Darstellung in Frames (Clickjacking) und nimmt nur Domains an,
 * die tatsächlich auf der Sperrliste stehen.
 */
(async () => {
  'use strict';
  // Nie in einem Frame darstellen (Clickjacking-Schutz)
  if (window.top !== window) return;

  const $ = (id) => document.getElementById(id);
  const { fmtTime, fmtLeft } = FGClient;
  const domain = FG.normalizeDomain(new URLSearchParams(location.search).get('d') || '');

  function say(msg, isError) {
    $('status').textContent = msg || '';
    $('status').classList.toggle('error', !!isError);
  }
  $('backBtn').addEventListener('click', () => (history.length > 1 ? history.back() : window.close()));
  $('optionsBtn').addEventListener('click', () => chrome.runtime.openOptionsPage());

  let view = await FGClient.status();
  if (!domain || !view.settings.blockedSites.includes(domain)) {
    $('title').textContent = 'Seite nicht gesperrt';
    $('reason').textContent = 'Diese Adresse steht nicht (mehr) auf deiner Sperrliste.';
    $('main').hidden = false;
    return;
  }
  document.title = domain + ' gesperrt – FocusGuard';
  $('title').textContent = domain + ' ist gesperrt';
  $('main').hidden = false;
  if (view.settings.features.stats) FGClient.op({ op: 'blockHit', domain }, { interactive: false });

  let stop = () => {};
  let timer = 0;
  function render() {
    stop();
    clearInterval(timer);
    const st = view.state;
    const s = view.settings;
    const reason = $('reason');
    if (st && st.blocking.focus) {
      const upd = () => (reason.textContent = 'Fokus-Sitzung läuft noch ' + fmtLeft(st.focusUntil - Date.now()) + '.');
      upd();
      timer = setInterval(upd, 1000);
    } else if (FG.isLocked(s, Date.now())) {
      reason.textContent = 'Sperrmodus aktiv bis ' + fmtTime(s.lockUntil) + '. Du hast dir das selbst vorgenommen.';
    } else {
      reason.textContent = 'Du hast diese Seite auf deine Sperrliste gesetzt.';
    }
    stop = FGUnlock.renderUnlock($('unlock'), domain, view, {
      say,
      onChange: async (r) => {
        view = r && r.settings && r.state ? { settings: r.settings, state: r.state } : await FGClient.status();
        render();
      },
      onUnlocked: () => location.replace('https://' + domain + '/'),
    });
  }
  render();
})();
